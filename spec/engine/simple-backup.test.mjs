import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, lstat, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { createBoundedReader } from '../../src/archive/bounded-reader.mjs';
import { runBackup, resumeRun } from '../../src/engine/backup.mjs';
import { restoreRun, verifyRun } from '../../src/engine/restore.mjs';
import { openRunMetadata, listFlatRuns } from '../../src/engine/repository.mjs';
import { sequenceToString } from '../../src/config/sequence.mjs';

const portable = value => value.replaceAll('\\', '/');
async function fixture(t, changes = {}) {
  const root = await mkdtemp(join(tmpdir(), 'delta-simple-backup-')); t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source'), destination = join(root, 'backup'), output = join(root, 'restore'); await mkdir(source); await mkdir(destination);
  const task = { wdir: root, proj: destination, srcs: ['source'], mode: 0, sequence: { types: ['full', 'incremental', 'differential'] }, archive: { level: 0 }, behavior: { continueOnFileError: true, retryCount: 0, resume: true }, ...changes };
  const save = async () => { const { wdir, proj, srcs, mode, ...settings } = task; await writeFile(join(destination, '.delta.json'), JSON.stringify({ ...settings, sequence: sequenceToString(task.sequence), workingDirectory: wdir, backupDirectory: proj, sources: srcs, pathMode: mode, history: [], files: {} })); }; await save();
  return { root, source, destination, output, task, save };
}
async function snapshot(f, run) { const metadata = await openRunMetadata(f.destination, run.id); try { return JSON.parse(await readFile(join(metadata.path, '.snapshot.json'), 'utf8')); } finally { await metadata.cleanup(); } }

for (const level of [0, 6]) test(`compression level ${level} selects the ZIP method and is recorded in snapshot metadata`, async t => {
  const f = await fixture(t, { archive: { level } }), content = 'repeated compression payload '.repeat(4096);
  await writeFile(join(f.source, 'contents.txt'), content);
  const run = await runBackup(f.task, f.destination), point = await snapshot(f, run);
  assert.equal(run.status, 'complete'); assert.equal(point.compressionLevel, level);
  const archive = await createBoundedReader(join(f.destination, run.parts[0].name));
  try {
    let found = false;
    for await (const entry of archive.getEntriesGenerator()) if (entry.filename === 'contents.txt') {
      found = true; assert.equal(entry.compressionMethod, level === 0 ? 0 : 8);
      if (level === 0) assert.equal(entry.compressedSize, entry.uncompressedSize);
      else assert(entry.compressedSize < entry.uncompressedSize / 2);
    }
    assert(found);
  } finally { await archive.close(); }
  assert.equal((await restoreRun(f.destination, run.id, f.output)).status, 'complete');
  assert.equal(await readFile(join(f.output, 'contents.txt'), 'utf8'), content);
});

test('a file read error records its actual source path and keeps other readable contents', async t => {
  const f = await fixture(t); await writeFile(join(f.source, 'bad'), 'unreadable'); await writeFile(join(f.source, 'good'), 'readable');
  const run = await runBackup(f.task, f.destination, { fault(stage, { entry }) { if (stage === 'before-file' && entry.path === 'bad') throw new Error('Controlled sharing violation'); } });
  assert.equal(run.status, 'incomplete', run.error); assert.equal(run.errors, 1);
  const point = await snapshot(f, run); assert.equal(point.errors.bad, portable(join(f.source, 'bad'))); assert.equal(point.archivedFiles.bad, undefined); assert.equal(typeof point.files.bad, 'string'); assert.equal(point.archivedFiles.good, point.files.good);
  const restored = await restoreRun(f.destination, run.id, f.output); assert.equal(restored.status, 'incomplete'); assert.equal(restored.files, 1); assert.equal(await readFile(join(f.output, 'good'), 'utf8'), 'readable'); await assert.rejects(lstat(join(f.output, 'bad')), { code: 'ENOENT' });
});

test('a configured retry reads the source again after a transient read error', async t => {
  const f = await fixture(t, { behavior: { continueOnFileError: true, retryCount: 1, resume: true } }); await writeFile(join(f.source, 'a'), 'read after retry'); let attempts = 0;
  const run = await runBackup(f.task, f.destination, { fault(stage) { if (stage === 'before-file' && attempts++ === 0) throw new Error('Transient read error'); } });
  assert.equal(run.status, 'complete', run.error); assert.equal(attempts, 2); const point = await snapshot(f, run); assert.deepEqual(point.errors, {}); assert.equal(point.archivedFiles.a, point.files.a); assert.equal((await restoreRun(f.destination, run.id, f.output)).status, 'complete');
  assert.equal(await readFile(join(f.output, 'a'), 'utf8'), 'read after retry');
});

test('stop-on-error does not publish a snapshot and a later retry scans current sources', async t => {
  const f = await fixture(t, { behavior: { continueOnFileError: false, retryCount: 0, resume: true } }); await writeFile(join(f.source, 'a'), 'original');
  await assert.rejects(runBackup(f.task, f.destination, { fault(stage) { if (stage === 'before-file') throw new Error('Stop on read error'); } }), /Stop on read error/);
  assert.deepEqual((await listFlatRuns(f.destination)), []); await assert.rejects(lstat(join(f.destination, '.delta-lock')), { code: 'ENOENT' });
  await writeFile(join(f.source, 'a'), 'current source after interruption'); const retried = await resumeRun(f.task, f.destination, 'interrupted-operation'); assert.equal(retried.status, 'complete', retried.error); assert.equal((await restoreRun(f.destination, retried.id, f.output)).status, 'complete'); assert.equal(await readFile(join(f.output, 'a'), 'utf8'), 'current source after interruption');
});

test('archive work waits while paused and resumes the same backup', { timeout: 10000 }, async t => {
  const f = await fixture(t); await writeFile(join(f.source, 'a'), Buffer.alloc(256 * 1024, 1));
  let paused = false, pausedOnce = false, entered, release, reads = 0;
  const waiting = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; }); t.after(() => release());
  const operation = runBackup(f.task, f.destination, { async waitIfPaused() { if (paused) { entered(); await gate; } }, onProgress(event) { if (event.phase === 'backup' && !pausedOnce) { pausedOnce = true; paused = true; } }, fault(stage) { if (stage === 'before-file') reads++; } });
  await waiting; await delay(20); assert.equal(reads, 0); paused = false; release(); const run = await operation; assert.equal(run.status, 'complete', run.error); assert.equal(reads, 1); assert.equal((await restoreRun(f.destination, run.id, f.output)).status, 'complete');
});

test('cancelling source discovery publishes no snapshot and releases the task lock', async t => {
  const f = await fixture(t); await writeFile(join(f.source, 'a'), 'cancel before writing'); const controller = new AbortController(); let reads = 0;
  await assert.rejects(runBackup(f.task, f.destination, { signal: controller.signal, onProgress(event) { if (event.phase === 'scan' && event.path) controller.abort(new Error('Cancelled scan')); }, fault(stage) { if (stage === 'before-file') reads++; } }), /Cancelled scan/);
  assert.equal(reads, 0); assert.deepEqual(await listFlatRuns(f.destination), []); assert(!(await readdir(f.destination)).some(name => name.endsWith('.zip'))); await assert.rejects(lstat(join(f.destination, '.delta-lock')), { code: 'ENOENT' });
  assert.equal((await runBackup(f.task, f.destination)).status, 'complete');
});

for (const mode of [0, 1, 2]) test(`path mode ${mode} writes Python-style human paths without artificial source folders`, async t => {
  const f = await fixture(t, { mode }); await mkdir(join(f.source, 'nested')); await writeFile(join(f.source, 'nested', 'a'), 'actual');
  const run = await runBackup(f.task, f.destination), point = await snapshot(f, run);
  const prefix = mode === 0 ? '' : mode === 1 ? 'source/' : `${f.source.replaceAll('\\', '/').replace(/^[a-z]:/i, '').replace(/^\/+/, '')}/`;
  const path = `${prefix}nested/a`; assert.equal(run.status, 'complete', run.error); assert.equal(typeof point.files[path], 'string'); assert.equal(point.archivedFiles[path], point.files[path]); assert(!Object.keys(point.files).some(name => /source_[a-f0-9]|src_/.test(name)));
  assert.equal((await restoreRun(f.destination, run.id, f.output)).status, 'complete'); assert.equal(await readFile(join(f.output, ...path.split('/')), 'utf8'), 'actual');
});

test('hash detection catches changed bytes with the same size and preserved modification time', async t => {
  const f = await fixture(t, { detection: 'hash' }), path = join(f.source, 'a'); await writeFile(path, '111'); await utimes(path, 1700000000, 1700000000);
  const first = await runBackup(f.task, f.destination), before = await snapshot(f, first); await writeFile(path, '222'); await utimes(path, 1700000000, 1700000000);
  const second = await runBackup(f.task, f.destination), after = await snapshot(f, second); assert.equal(second.status, 'complete', second.error); assert.match(after.files.a, /^[a-f0-9]{64}$/); assert.notEqual(after.files.a, before.files.a); assert.equal(after.archivedFiles.a, after.files.a);
  assert.equal((await restoreRun(f.destination, second.id, f.output)).status, 'complete'); assert.equal(await readFile(join(f.output, 'a'), 'utf8'), '222');
});

test('an individual source file uses its real basename', async t => {
  const f = await fixture(t, { srcs: ['source/a.txt'] }); await writeFile(join(f.source, 'a.txt'), 'individual file');
  const run = await runBackup(f.task, f.destination), point = await snapshot(f, run); assert.deepEqual(Object.keys(point.files), ['a.txt']); assert.equal((await restoreRun(f.destination, run.id, f.output)).status, 'complete'); assert.equal(await readFile(join(f.output, 'a.txt'), 'utf8'), 'individual file');
});

for (const mode of [1, 2]) test(`an individual file in path mode ${mode} includes its parent path only once`, async t => {
  const f = await fixture(t, { srcs: ['source/a.txt'], mode }); await writeFile(join(f.source, 'a.txt'), 'single-file source');
  const run = await runBackup(f.task, f.destination), point = await snapshot(f, run);
  const expected = mode === 1 ? 'source/a.txt' : join(f.source, 'a.txt').replaceAll('\\', '/').replace(/^[a-z]:/i, '').replace(/^\/+/, '');
  assert.equal(run.status, 'complete', run.error); assert.deepEqual(Object.keys(point.files), [expected]); assert.equal(point.archivedFiles[expected], point.files[expected]); assert.equal((await restoreRun(f.destination, run.id, f.output)).status, 'complete'); assert.equal(await readFile(join(f.output, ...expected.split('/')), 'utf8'), 'single-file source');
});

test('an unreadable individual file records the actual source path rather than a duplicated basename', async t => {
  const f = await fixture(t, { srcs: ['source/a.txt'], mode: 1 }); await writeFile(join(f.source, 'a.txt'), 'controlled unreadable source');
  const run = await runBackup(f.task, f.destination, { fault(stage) { if (stage === 'before-file') throw new Error('Controlled single-file access error'); } });
  const point = await snapshot(f, run); assert.equal(run.status, 'incomplete'); assert.equal(point.errors['source/a.txt'], portable(join(f.source, 'a.txt'))); assert.deepEqual(Object.keys(point.errors), ['source/a.txt']); assert.equal(point.archivedFiles['source/a.txt'], undefined);
});

test('an unavailable provider source root fails before an empty archive name can be skipped', async t => {
  const f = await fixture(t); let released;
  await assert.rejects(runBackup(f.task, f.destination, { sourceProvider: { async prepare(_task, context) { return {
    sources: context.sources, consistentSnapshot: true,
    async *scan() { yield { sourceId: context.sources[0].id, path: '', kind: 'missing', absolute: f.source, error: 'Controlled unavailable source root', code: 'EACCES' }; },
    async release(outcome) { released = outcome; },
  }; } } }), error => { assert.match(error.message, /Source is unavailable/); assert(error.message.includes(f.source)); assert.match(error.message, /Controlled unavailable source root/); return true; });
  assert.deepEqual(released, { success: false }); assert.deepEqual(await listFlatRuns(f.destination), []); assert(!(await readdir(f.destination)).some(name => name.endsWith('.zip'))); await assert.rejects(lstat(join(f.destination, '.delta-lock')), { code: 'ENOENT' });
});

test('colliding mode-zero source paths require an explicit path mode rather than artificial source folders', async t => {
  const f = await fixture(t, { srcs: ['source', 'other'] }); await mkdir(join(f.root, 'other')); await writeFile(join(f.source, 'a.txt'), 'first source'); await writeFile(join(f.root, 'other', 'a.txt'), 'second source');
  await assert.rejects(runBackup(f.task, f.destination), error => { assert.match(error.message, /same archive path: a\.txt/); assert.match(error.message, /configured.*absolute/i); assert(!/UUID|source_[a-f0-9]|src_/i.test(error.message)); return true; });
  assert.deepEqual(await listFlatRuns(f.destination), []); assert(!(await readdir(f.destination)).some(name => name.endsWith('.zip')));
  f.task.mode = 1; await f.save(); const run = await runBackup(f.task, f.destination), point = await snapshot(f, run); assert.equal(run.status, 'complete', run.error); assert.deepEqual(Object.keys(point.files).sort(), ['other/a.txt', 'source/a.txt']);
  assert.equal((await restoreRun(f.destination, run.id, f.output)).status, 'complete'); assert.equal(await readFile(join(f.output, 'source', 'a.txt'), 'utf8'), 'first source'); assert.equal(await readFile(join(f.output, 'other', 'a.txt'), 'utf8'), 'second source');
});

test('a repeating FFI sequence allows multiple full backups and advances only by history length', async t => {
  const f = await fixture(t, { sequence: { types: ['full', 'full', 'incremental'] }, schedulesPaused: false }), runs = [];
  for (let index = 0; index < 6; index++) { await writeFile(join(f.source, 'a.txt'), `generation ${index}${'!'.repeat(index + 1)}`); const run = await runBackup(f.task, f.destination); assert.equal(run.status, 'complete', run.error); runs.push(run); }
  assert.deepEqual(runs.map(run => run.type), ['full', 'full', 'incremental', 'full', 'full', 'incremental']);
  assert.equal(JSON.parse(await readFile(join(f.destination, '.delta.json'), 'utf8')).history.length, 6);
  assert.equal((await restoreRun(f.destination, runs.at(-1).id, f.output)).status, 'complete'); assert.equal(await readFile(join(f.output, 'a.txt'), 'utf8'), 'generation 5!!!!!!');
});

async function streamedProvider(f, failedAttempts) {
  const first = Buffer.from('direct-source-payload-'.repeat(16384)), second = Buffer.from('next file remains valid'), marker = Buffer.from('direct-source-payload-');
  await writeFile(join(f.source, 'a-source'), first); await writeFile(join(f.source, 'b-next'), second);
  const cache = join(f.root, 'cache'); await mkdir(cache);
  const attempts = new Map(), releases = [], interruptedArchiveSizes = [];
  async function inspectCache(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await inspectCache(path);
      else if (entry.isFile()) assert(!(await readFile(path)).includes(marker), 'Source payload must stream to its ZIP rather than a cache staging file');
    }
  }
  const sourceProvider = { async prepare(_task, context) { return {
    sources: context.sources, consistentSnapshot: true,
    async openFile(entry) {
      const attempt = (attempts.get(entry.path) ?? 0) + 1; attempts.set(entry.path, attempt);
      const bytes = entry.path === 'a-source' ? first : second, fail = entry.path === 'a-source' && attempt <= failedAttempts; let position = 0;
      return { reader: { size: bytes.length, readable: new ReadableStream({ async pull(controller) {
        if (fail && position >= 64 * 1024) {
          await delay(20);
          const partials = (await readdir(f.destination)).filter(name => name.endsWith('.partial')); assert.equal(partials.length, 1);
          interruptedArchiveSizes.push((await lstat(join(f.destination, partials[0]))).size); await inspectCache(cache);
          controller.error(Object.assign(new Error('Synthetic source failure after its first chunk'), { sourceReadError: true })); return;
        }
        if (position === bytes.length) { controller.close(); return; }
        const end = Math.min(position + 64 * 1024, bytes.length); controller.enqueue(bytes.subarray(position, end)); position = end;
      } }, { highWaterMark: 0 }) }, digest() { return createHash('sha256').update(bytes).digest('hex'); }, async close() {} };
    },
    async release(outcome) { releases.push(outcome); },
  }; } };
  return { first, second, cache, attempts, releases, interruptedArchiveSizes, sourceProvider };
}
async function archiveNames(f, run) {
  const reader = await createBoundedReader(join(f.destination, run.parts[0].name));
  try { const names = []; for await (const entry of reader.getEntriesGenerator()) names.push(entry.filename); return names; } finally { await reader.close(); }
}

test('a tagged mid-stream source error discards its unfinished entry and preserves the next file', async t => {
  const f = await fixture(t), provider = await streamedProvider(f, Infinity);
  const run = await runBackup(f.task, f.destination, { cacheDirectory: provider.cache, sourceProvider: provider.sourceProvider });
  assert.equal(run.status, 'incomplete', run.error); assert.equal(run.errors, 1); assert.equal(provider.attempts.get('a-source'), 1); assert.equal(provider.attempts.get('b-next'), 1);
  assert.equal(provider.interruptedArchiveSizes.length, 1); assert(provider.interruptedArchiveSizes[0] > 0, 'The first source chunk must already have reached the ZIP before the read fails');
  const point = await snapshot(f, run); assert.equal(point.errors['a-source'], portable(join(f.source, 'a-source'))); assert.equal(point.archivedFiles['a-source'], undefined); assert.equal(point.archivedFiles['b-next'], point.files['b-next']);
  assert.deepEqual(await archiveNames(f, run), ['b-next', '.snapshot.json']); assert.deepEqual(provider.releases, [{ success: false }]);
  const checked = await verifyRun(f.destination, run.id); assert.equal(checked.status, 'incomplete'); assert.equal(checked.files, 1); assert.equal(checked.bytes, provider.second.length);
  assert.equal((await restoreRun(f.destination, run.id, f.output, { paths: ['b-next'] })).status, 'complete'); assert.deepEqual(await readFile(join(f.output, 'b-next')), provider.second); assert.deepEqual(await readdir(provider.cache), []);
});

test('a mid-stream source retry can reuse the same archive filename exactly once', async t => {
  const f = await fixture(t, { behavior: { continueOnFileError: true, retryCount: 1, resume: true } }), provider = await streamedProvider(f, 1);
  const run = await runBackup(f.task, f.destination, { cacheDirectory: provider.cache, sourceProvider: provider.sourceProvider });
  assert.equal(run.status, 'complete', run.error); assert.equal(run.errors, 0); assert.equal(provider.attempts.get('a-source'), 2); assert.equal(provider.attempts.get('b-next'), 1);
  assert.equal(provider.interruptedArchiveSizes.length, 1); assert(provider.interruptedArchiveSizes[0] > 0);
  const point = await snapshot(f, run); assert.deepEqual(point.errors, {}); assert.equal(point.archivedFiles['a-source'], point.files['a-source']); assert.deepEqual(await archiveNames(f, run), ['a-source', 'b-next', '.snapshot.json']); assert.deepEqual(provider.releases, [{ success: true }]);
  assert.equal((await verifyRun(f.destination, run.id)).status, 'complete'); assert.equal((await restoreRun(f.destination, run.id, f.output)).status, 'complete'); assert.deepEqual(await readFile(join(f.output, 'a-source')), provider.first); assert.deepEqual(await readFile(join(f.output, 'b-next')), provider.second); assert.deepEqual(await readdir(provider.cache), []);
});

test('only the canonical root .snapshot.json path is reserved for archive metadata', async t => {
  const f = await fixture(t, { srcs: [['source', '.snapshot.json']] }); await writeFile(join(f.source, '.snapshot.json'), 'real source document');
  await assert.rejects(runBackup(f.task, f.destination), /Source path \.snapshot\.json conflicts with snapshot metadata/); assert.deepEqual(await listFlatRuns(f.destination), []);
  f.task.mode = 1; await f.save(); const run = await runBackup(f.task, f.destination), point = await snapshot(f, run); assert.equal(point.archivedFiles['source/.snapshot.json'], point.files['source/.snapshot.json']); assert.deepEqual(await archiveNames(f, run), ['source/.snapshot.json', '.snapshot.json']);
  assert.equal((await restoreRun(f.destination, run.id, f.output)).status, 'complete'); assert.equal(await readFile(join(f.output, 'source', '.snapshot.json'), 'utf8'), 'real source document');
});
