import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { restoreRun, verifyRun } from '../../src/engine/restore.mjs';
import { openRunMetadata } from '../../src/engine/repository.mjs';
import { readSnapshotDocument } from '../../src/archive/snapshot-document.mjs';
import { scanSources, validateSources, makeSourceFilter } from '../../src/engine/scanner.mjs';
import { resolveTaskSources } from '../../src/domain/source-identity.mjs';
import { sequenceToString } from '../../src/config/sequence.mjs';

const execute = promisify(execFile);
const reference = process.env.DELTA_PYTHON_REFERENCE;
const python = process.env.DELTA_PYTHON ?? 'python';
const snapshotKeys = ['startedAt', 'finishedAt', 'compressionLevel', 'full', 'totalBytes', 'storedBytes', 'files', 'archivedFiles', 'errors'].sort();
const runner = String.raw`
import ast, os, sys, json, zipfile, hashlib, re, datetime, inspect, glob, concurrent.futures, tempfile
class Reporter:
    @staticmethod
    def print(message, code): raise RuntimeError(f'{code}: {message}')
source = open(sys.argv[1], encoding='utf-8-sig').read()
tree = ast.parse(source, filename=sys.argv[1])
nodes = [node for node in tree.body if isinstance(node, (ast.ClassDef, ast.FunctionDef)) and node.name in {'Task', 'Snapshot', 'snap'}]
assert {node.name for node in nodes} == {'Task', 'Snapshot', 'snap'}
namespace = dict(os=os, json=json, zipfile=zipfile, hashlib=hashlib, re=re, datetime=datetime, inspect=inspect, glob=glob, concurrent=concurrent, VERRS=Reporter)
exec(compile(ast.Module(body=nodes, type_ignores=[]), sys.argv[1], 'exec'), namespace)
Task, Snapshot = namespace['Task'], namespace['Snapshot']
namespace['_snap'] = namespace['snap']
action, directory, source_path, output = sys.argv[2:6]
# Test-only translation of keys and filenames; the Task/Snapshot algorithms are unchanged.
python_task_name, current_task_name = 'delta.json', '.delta.json'
python_snapshot_name, current_snapshot_name = 'snapshot.json', '.snapshot.json'
task_keys = {'wdir': 'workingDirectory', 'proj': 'backupDirectory', 'srcs': 'sources', 'mode': 'pathMode', 'hist': 'history', 'data': 'files'}
snapshot_keys = {'time': 'startedAt', 'ends': 'finishedAt', 'comp': 'compressionLevel', 'full': 'full', 'size': 'totalBytes', 'sizx': 'storedBytes', 'data': 'files', 'lock': 'archivedFiles', 'errs': 'errors'}
def rename_keys(value, keys): return {keys.get(key, key): item for key, item in value.items()}
def translate_archive(source, target, keys, source_metadata, target_metadata):
    temporary = target + '.translated'
    with zipfile.ZipFile(source, 'r') as original, zipfile.ZipFile(temporary, 'w') as translated:
        for info in original.infolist():
            data = original.read(info.filename)
            if info.filename == source_metadata:
                data = json.dumps(rename_keys(json.loads(data), keys), ensure_ascii=False).encode('utf-8')
                info.filename = info.orig_filename = target_metadata
            translated.writestr(info, data)
    os.replace(temporary, target)
if action == 'backup':
    task = Task(directory, [source_path], mode=0)
    task.backup_full(comp=0)
    with open(os.path.join(source_path, 'a.txt'), 'w', encoding='utf-8') as file: file.write('second generation')
    os.remove(os.path.join(source_path, 'gone.txt'))
    with open(os.path.join(source_path, 'added.txt'), 'w', encoding='utf-8') as file: file.write('added')
    task.backup_incr(comp=0)
    checkpoint = task.data.copy()
    with open(os.path.join(source_path, 'a.txt'), 'w', encoding='utf-8') as file: file.write('third generation')
    task.backup_diff(comp=0)
    assert task.data == checkpoint
    for name in task.hist: translate_archive(os.path.join(directory, name), os.path.join(directory, name), snapshot_keys, python_snapshot_name, current_snapshot_name)
    with open(os.path.join(directory, current_task_name), 'w', encoding='utf-8') as file: json.dump(rename_keys(task.__dict__, task_keys), file, ensure_ascii=False)
    os.remove(os.path.join(directory, python_task_name))
    print(json.dumps({'hist': task.hist, 'checkpoint': checkpoint}))
elif action == 'scan':
    parameters = json.loads(sys.argv[6])
    task = Task(directory, [[source_path, parameters['pattern'], parameters.get('expression')]], mode=0)
    print(json.dumps({'paths': sorted(name for source, name in task.get_data())}))
else:
    with tempfile.TemporaryDirectory(prefix='delta-python-reader-') as compatible:
        task = object.__new__(Task)
        with open(os.path.join(directory, current_task_name), encoding='utf-8') as file: task.__dict__ = rename_keys(json.load(file), {value: key for key, value in task_keys.items()})
        for name in task.hist: translate_archive(os.path.join(directory, name), os.path.join(compatible, name), {value: key for key, value in snapshot_keys.items()}, current_snapshot_name, python_snapshot_name)
        task.proj = compatible
        remaining = task.recover(output)
        assert not remaining, remaining
        print(json.dumps({'remaining': remaining, 'hist': task.hist}))
`;
async function fixture(t) {
  if (!reference) { t.skip('Set DELTA_PYTHON_REFERENCE to the original delta.py to run the interoperability oracle'); return null; }
  assert.ok(existsSync(reference), 'DELTA_PYTHON_REFERENCE must point to an existing delta.py');
  try { await execute(python, ['--version']); } catch { t.skip('Python is not installed'); return null; }
  const root = await mkdtemp(join(tmpdir(), 'delta-python-oracle-')); t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source'), destination = join(root, 'backup'), output = join(root, 'restored'), script = join(root, 'oracle.py');
  await mkdir(source); await mkdir(destination); await mkdir(join(source, 'empty-directory')); await writeFile(join(source, 'a.txt'), 'first generation'); await writeFile(join(source, 'gone.txt'), 'remove me'); await writeFile(join(source, 'żółć.txt'), 'actual Unicode content 🌍'); await writeFile(script, runner);
  const callPython = async (action, parameters) => { const result = await execute(python, [script, reference, action, destination, source, output, ...(parameters ? [JSON.stringify(parameters)] : [])], { maxBuffer: 1024 * 1024 }); return JSON.parse(result.stdout); };
  return { root, source, destination, output, callPython };
}

test('the actual Python delta.py full/incremental/differential archives restore in Node', async t => {
  const f = await fixture(t); if (!f) return;
  const oracle = await f.callPython('backup'), selected = oracle.hist.at(-1).slice(0, -4);
  const result = await restoreRun(f.destination, selected, f.output); assert.equal(result.status, 'complete', JSON.stringify(result));
  assert.equal(await readFile(join(f.output, 'a.txt'), 'utf8'), 'third generation'); assert.equal(await readFile(join(f.output, 'added.txt'), 'utf8'), 'added'); assert.equal(await readFile(join(f.output, 'żółć.txt'), 'utf8'), 'actual Unicode content 🌍'); assert(!(await readdir(f.output)).includes('gone.txt')); assert((await readdir(f.output)).includes('empty-directory'));
  assert.equal((await verifyRun(f.destination, selected)).status, 'complete');
  const root = JSON.parse(await readFile(join(f.destination, '.delta.json'), 'utf8')); assert.deepEqual(Object.keys(root).sort(), ['workingDirectory', 'backupDirectory', 'sources', 'pathMode', 'history', 'files'].sort()); assert.deepEqual(root.files, oracle.checkpoint);
});

test('Node snapshots keep the exact Python wire shape and the actual Python Task.recover reads them', async t => {
  const f = await fixture(t); if (!f) return;
  const { runBackup } = await import('../../src/engine/backup.mjs');
  const task = { wdir: f.root, proj: f.destination, srcs: [f.source], mode: 0, sequence: { types: ['full', 'incremental', 'differential'] } };
  await writeFile(join(f.destination, '.delta.json'), JSON.stringify({ workingDirectory: task.wdir, backupDirectory: task.proj, sources: task.srcs, pathMode: task.mode, sequence: sequenceToString(task.sequence), history: [], files: {} }));
  const full = await runBackup(task, f.destination, { type: 'full' }); assert.equal(full.status, 'complete', full.error);
  await writeFile(join(f.source, 'a.txt'), 'second generation'); await unlink(join(f.source, 'gone.txt')); await writeFile(join(f.source, 'added.txt'), 'added');
  const incremental = await runBackup(task, f.destination, { type: 'incremental' }); assert.equal(incremental.status, 'complete', incremental.error);
  const checkpoint = JSON.parse(await readFile(join(f.destination, '.delta.json'), 'utf8')).files;
  await writeFile(join(f.source, 'a.txt'), 'third generation');
  const differential = await runBackup(task, f.destination, { type: 'differential' }); assert.equal(differential.status, 'complete', differential.error);
  assert.deepEqual(JSON.parse(await readFile(join(f.destination, '.delta.json'), 'utf8')).files, checkpoint, 'Differential backups must leave the root checkpoint unchanged');
  assert.equal(JSON.parse(await readFile(join(f.destination, '.delta.json'), 'utf8')).sequence, 'FID', 'The Python reader ignores the compact GUI sequence extension');
  for (const run of [full, incremental, differential]) {
    assert.match(run.parts[0].name, /^\d{20}\.zip$/);
    const metadata = await openRunMetadata(f.destination, run.id);
    try { const data = {}, header = await readSnapshotDocument(join(metadata.path, '.snapshot.json'), { onData: (name, value) => { data[name] = value; } }); assert.deepEqual(Object.keys(JSON.parse(await readFile(join(metadata.path, '.snapshot.json'), 'utf8'))).sort(), snapshotKeys); assert(!Object.keys(data).some(path => /source_[a-f0-9]|src_/.test(path))); assert.equal(header.full, run.id === full.id); } finally { await metadata.cleanup(); }
  }
  const recovered = await f.callPython('restore'); assert.deepEqual(recovered.remaining, {}); assert.equal(await readFile(join(f.output, 'a.txt'), 'utf8'), 'third generation'); assert.equal(await readFile(join(f.output, 'added.txt'), 'utf8'), 'added'); assert.equal(await readFile(join(f.output, 'żółć.txt'), 'utf8'), 'actual Unicode content 🌍'); assert(!(await readdir(f.output)).includes('gone.txt'));
});

test('scanner and the shared native filter match actual Python glob and fullmatch selection', async t => {
  const f = await fixture(t); if (!f) return;
  const names = [{ path: 'empty-directory', directory: true }, { path: 'a.txt' }, { path: 'gone.txt' }, { path: 'żółć.txt' }, { path: 'b.txt' }, { path: 'c.txt' }, { path: 'no-extension' }, { path: '.hidden.txt' }, { path: '.hidden-directory', directory: true }, { path: '.hidden-directory/inside.txt' }, { path: 'nested', directory: true }, { path: 'nested/deep.txt' }, { path: 'nested/.hidden.txt' }, { path: 'nested/b.log' }, { path: 'cache', directory: true }, { path: 'cache/kept.txt' }, { path: 'cached.txt' }, { path: 'directory.txt', directory: true }, { path: 'directory.txt/child.log' }];
  for (const entry of names) { const path = join(f.source, ...entry.path.split('/')); if (entry.directory) await mkdir(path, { recursive: true }); else { await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, `real ${entry.path}`); } }
  const cases = [{ pattern: '**' }, { pattern: '*.txt' }, { pattern: '**/*.txt' }, { pattern: '[ab].txt' }, { pattern: '.hidden.txt' }, { pattern: '.hidden-directory/*.txt' }, { pattern: '**/.hidden.txt' }, { pattern: '**', expression: 'cache' }];
  for (const parameters of cases) {
    const oracle = await f.callPython('scan', parameters), task = { wdir: f.root, proj: f.destination, srcs: [[f.source, parameters.pattern, parameters.expression ?? null]], mode: 0, symlinks: 'follow' };
    const sources = await validateSources(task, f.destination, resolveTaskSources(task)), scanned = [];
    for await (const row of scanSources(task, f.destination, sources)) { assert.notEqual(row.kind, 'missing', row.error); scanned.push(row.path); }
    assert.deepEqual(scanned.sort(), oracle.paths.sort(), JSON.stringify(parameters));
    const filter = makeSourceFilter(sources[0]), selected = names.filter(entry => filter(entry.path, entry.directory)).map(entry => entry.path).sort();
    assert.deepEqual(selected, oracle.paths.sort(), `Shared native filter: ${JSON.stringify(parameters)}`);
    if (parameters.expression === 'cache') { assert(!scanned.includes('cache')); assert(scanned.includes('cache/kept.txt')); assert.equal(filter.traverse('cache'), true, 'Regex exclusion must not prune descendants'); }
  }
});
