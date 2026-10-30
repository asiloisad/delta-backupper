import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, lstat, readlink, opendir, symlink, realpath } from 'node:fs/promises';
import { win32 as windows, join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { createVssPathResolver, createVssSnapshotScanner } from '../../src/platform/vss-paths.mjs';
import { runBackup, verifyRun, restoreRun, getRunDetails } from '../../src/engine/index.mjs';
import { resolveTaskSources } from '../../src/domain/source-identity.mjs';
import { saveTaskDocument } from '../../src/config/task-document.mjs';

const device = '\\\\?\\GLOBALROOT\\Device\\HarddiskVolumeShadowCopy42';
const secondDevice = '\\\\?\\GLOBALROOT\\Device\\HarddiskVolumeShadowCopy43';
const guid = '\\\\?\\Volume{01234567-89ab-cdef-0123-456789abcdef}\\';
const secondGuid = '\\\\?\\Volume{11234567-89ab-cdef-0123-456789abcdef}\\';
const mapping = { root: 'C:\\', guid, device, snapshotId: '{12345678-90ab-cdef-0123-456789abcdef}' };
const info = kind => ({ isSymbolicLink: () => kind === 'link', isDirectory: () => kind === 'directory', isFile: () => kind === 'file', size: 8n, mtimeNs: 1700000000000000000n, mode: 0o100644n });
function virtual(entries) {
  const calls = [];
  return { calls, async lstat(path) { calls.push(['lstat', path]); assert.ok(path.startsWith(device) || path.startsWith(secondDevice), `Live filesystem access: ${path}`); if (!entries[path]) throw Object.assign(new Error('missing snapshot path'), { code: 'ENOENT' }); return info(entries[path].kind); }, async readlink(path) { calls.push(['readlink', path]); return entries[path].target; } };
}
const base = () => ({ [`${device}\\`]: { kind: 'directory' }, [`${device}\\Data`]: { kind: 'directory' }, [`${device}\\Pinned`]: { kind: 'directory' }, [`${device}\\Pinned\\a`]: { kind: 'file' } });

test('VSS mapped source scanners keep per-source filters isolated and relative to each source', async () => {
  const entries = base(), sources = [{ id: 'first', path: 'C:\\Data\\first', filters: { include: ['**/*.txt'], exclude: ['**/denied.txt', 'nested/private/**'] } }, { id: 'second', path: 'C:\\Data\\second', filters: { include: ['**/*.log', 'nested/shared.txt'], exclude: ['**/denied.*'] } }];
  for (const root of ['first', 'second']) { for (const name of ['', '\\nested', '\\nested\\private']) entries[`${device}\\Data\\${root}${name}`] = { kind: 'directory' }; for (const name of ['shared.txt', 'shared.log', 'denied.txt', 'denied.log', 'nested\\shared.txt', 'nested\\shared.log', 'nested\\private\\hidden.txt']) entries[`${device}\\Data\\${root}\\${name}`] = { kind: 'file' }; }
  const io = { ...virtual(entries), async realpath(value) { return value; }, async* opendir(value) { const prefix = `${value.replace(/\\$/, '')}\\`; for (const key of Object.keys(entries)) if (key.startsWith(prefix) && key.length > prefix.length && !key.slice(prefix.length).includes('\\')) yield { name: key.slice(prefix.length) }; } };
  const original = structuredClone(sources), rows = await Array.fromAsync(createVssSnapshotScanner(sources, [mapping], io)({ symlinks: 'follow' }, 'Z:\\backup')); assert.deepEqual(sources, original); assert.deepEqual(rows.filter(row => row.kind === 'file').map(row => `${row.sourceId}/${row.path}`).sort(), ['first/nested/shared.txt', 'first/shared.txt', 'second/nested/shared.log', 'second/nested/shared.txt', 'second/shared.log']);
});

for (const target of ['C:\\Pinned', '..\\Pinned', '\\Pinned', '\\\\?\\C:\\Pinned', '\\??\\C:\\Pinned', `${guid}Pinned`]) test(`VSS resolver remaps ${JSON.stringify(target)} into the snapshot`, async () => {
  const entries = base(); entries[`${device}\\Data\\link`] = { kind: 'link', target }; const io = virtual(entries);
  const resolved = await createVssPathResolver([mapping], io).resolve('C:\\Data\\link\\a');
  assert.equal(resolved.absolute, `${device}\\Pinned\\a`); assert.ok(io.calls.length <= 8);
  assert.ok(!io.calls.some(([, path]) => path === `${device}\\Data\\link\\a`));
});
test('VSS resolver crosses only the volumes in the attested snapshot set', async () => {
  const entries = base(); entries[`${device}\\Data\\link`] = { kind: 'link', target: 'D:\\Pinned' }; entries[`${secondDevice}\\`] = { kind: 'directory' }; entries[`${secondDevice}\\Pinned`] = { kind: 'directory' }; entries[`${secondDevice}\\Pinned\\a`] = { kind: 'file' };
  const io = virtual(entries); await assert.rejects(createVssPathResolver([mapping], io).resolve('C:\\Data\\link\\a'), /outside the snapshot lease/);
  const resolved = await createVssPathResolver([mapping, { ...mapping, root: 'D:\\', guid: secondGuid, device: secondDevice }], io).resolve('C:\\Data\\link\\a'); assert.equal(resolved.absolute, `${secondDevice}\\Pinned\\a`);
});
for (const target of ['\\\\server\\share', 'C:relative', 'C:\\Pinned\\a:secret', '\\\\?\\GLOBALROOT\\Device\\HarddiskVolumeShadowCopy999\\secret', '\\??\\UNC\\server\\share']) test(`VSS rejects an unsafe target ${JSON.stringify(target)}`, async () => {
  const entries = base(); entries[`${device}\\Data\\link`] = { kind: 'link', target }; const io = virtual(entries);
  await assert.rejects(createVssPathResolver([mapping], io).resolve('C:\\Data\\link\\a')); assert.ok(io.calls.length <= 4);
});
test('VSS resolver bounds cyclic and excessively long link chains', async () => {
  const entries = base(); entries[`${device}\\Data\\link`] = { kind: 'link', target: 'C:\\Data\\link' }; const io = virtual(entries);
  await assert.rejects(createVssPathResolver([mapping], io).resolve('C:\\Data\\link\\a'), /loop/); assert.ok(io.calls.length <= 8);
  for (let n = 0; n < 70; n++) entries[`${device}\\Data\\link${n}`] = { kind: 'link', target: `C:\\Data\\link${n + 1}` };
  const bounded = virtual(entries); await assert.rejects(createVssPathResolver([mapping], bounded).resolve('C:\\Data\\link0'), /loop/); assert.ok(bounded.calls.length < 150);
});
test('VSS resolver preserves a final link while still remapping junction parents', async () => {
  const entries = base(); entries[`${device}\\Data\\link`] = { kind: 'link', target: 'C:\\Pinned' }; entries[`${device}\\Pinned\\last`] = { kind: 'link', target: 'Z:\\unavailable' };
  const result = await createVssPathResolver([mapping], virtual(entries)).resolve('C:\\Data\\link\\last', undefined, { followFinal: false }); assert.equal(result.absolute, `${device}\\Pinned\\last`); assert.equal(result.info.isSymbolicLink(), true);
});
test('VSS directory cache never hides a differently cased junction in a case-sensitive directory', async () => {
  const entries = base(); entries[`${device}\\Data\\folder`] = { kind: 'directory' }; entries[`${device}\\Data\\folder\\a`] = { kind: 'file' }; entries[`${device}\\Data\\Folder`] = { kind: 'link', target: 'Z:\\outside-the-lease' };
  const io = virtual(entries); const resolver = createVssPathResolver([mapping], io); await resolver.resolve('C:\\Data\\folder\\a'); await assert.rejects(resolver.resolve('C:\\Data\\Folder\\a'), /outside the snapshot lease/);
  assert.ok(!io.calls.some(([, path]) => path === `${device}\\Data\\Folder\\a`));
});
test('VSS selects nested mount roots by exact components while allowing drive-letter aliases', async () => {
  const nested = { ...mapping, root: 'C:\\Mount\\', guid: secondGuid, device: secondDevice };
  const entries = base(); entries[`${device}\\mount`] = { kind: 'directory' }; entries[`${device}\\mount\\a`] = { kind: 'file' };
  entries[`${secondDevice}\\`] = { kind: 'directory' }; entries[`${secondDevice}\\a`] = { kind: 'file' };
  const io = virtual(entries); const resolver = createVssPathResolver([mapping, nested], io);
  assert.equal((await resolver.resolve('C:\\mount\\a')).absolute, `${device}\\mount\\a`);
  assert.ok(!io.calls.some(([, path]) => path.startsWith(secondDevice)));
  assert.equal((await resolver.resolve('c:\\Mount\\a')).absolute, `${secondDevice}\\a`);
  await assert.rejects(createVssPathResolver([nested], io).resolve('C:\\mount\\a'), /outside the snapshot lease/);
});
test('Snapshot exclusion preserves a case-distinct directory, including filesystems without inode IDs', async () => {
  const entries = {
    [`${device}\\`]: { kind: 'directory' }, [`${device}\\Data`]: { kind: 'directory' },
    [`${device}\\Data\\Backup`]: { kind: 'directory' }, [`${device}\\Data\\Backup\\old`]: { kind: 'file' },
    [`${device}\\Data\\backup`]: { kind: 'directory' }, [`${device}\\Data\\backup\\keep`]: { kind: 'file' },
  };
  for (const inodeMode of ['absent', 'zero', 'observed']) {
    const observed = virtual(entries);
    const io = {
      ...observed,
      async lstat(value) { const result = await observed.lstat(value); return inodeMode === 'absent' ? result : { ...result, ino: inodeMode === 'zero' ? 0n : BigInt(Object.keys(entries).indexOf(value) + 1) }; },
      async realpath(value) { assert.equal(value, 'C:\\Data\\Backup'); return value; },
      async* opendir(value) {
        assert.ok(value.startsWith(device)); const prefix = `${value.replace(/\\$/, '')}\\`;
        for (const key of Object.keys(entries)) if (key.startsWith(prefix) && key.length > prefix.length && !key.slice(prefix.length).includes('\\')) yield { name: key.slice(prefix.length) };
      },
    };
    const rows = await Array.fromAsync(createVssSnapshotScanner([{ id: 'source', path: 'C:\\Data' }], [mapping], io)({ symlinks: 'follow' }, 'C:\\Data\\Backup'));
    assert.ok(rows.some(entry => entry.path === 'backup/keep'), inodeMode);
    assert.ok(!rows.some(entry => entry.path === 'Backup' || entry.path.startsWith('Backup/')), inodeMode);
  }
});
test('Snapshot exclusion uses observed inode identity for legitimate differently cased aliases', async () => {
  const entries = { [`${device}\\`]: { kind: 'directory' }, [`${device}\\Data`]: { kind: 'directory' }, [`${device}\\Data\\Backup`]: { kind: 'directory' }, [`${device}\\Data\\backup`]: { kind: 'directory' }, [`${device}\\Data\\backup\\old`]: { kind: 'file' } };
  const observed = virtual(entries); const io = {
    ...observed,
    async lstat(value) { return { ...await observed.lstat(value), ino: value === `${device}\\Data\\Backup` || value === `${device}\\Data\\backup` ? 42n : BigInt(Object.keys(entries).indexOf(value) + 100) }; },
    async realpath(value) { return value; },
    async* opendir(value) { if (value === `${device}\\Data`) yield { name: 'backup' }; else throw new Error('The repository alias must not be enumerated'); },
  };
  const rows = await Array.fromAsync(createVssSnapshotScanner([{ id: 'source', path: 'C:\\Data' }], [mapping], io)({ symlinks: 'follow' }, 'C:\\Data\\Backup'));
  assert.deepEqual(rows.map(entry => entry.path), ['']);
});
test('Snapshot scanner does not inherit a false case-insensitive live-source exclusion', async () => {
  const entries = { [`${device}\\`]: { kind: 'directory' }, [`${device}\\Data`]: { kind: 'directory' }, [`${device}\\Data\\Backup`]: { kind: 'directory' }, [`${device}\\Data\\Backup\\keep`]: { kind: 'file' }, [`${device}\\data`]: { kind: 'directory' }, [`${device}\\data\\Backup`]: { kind: 'directory' } };
  const observed = virtual(entries); const io = {
    ...observed,
    async lstat(value) { return { ...await observed.lstat(value), ino: BigInt(Object.keys(entries).indexOf(value) + 1) }; },
    async realpath(value) { return value; },
    async* opendir(value) { if (value === `${device}\\Data`) yield { name: 'Backup' }; else if (value === `${device}\\Data\\Backup`) yield { name: 'keep' }; else throw new Error('Unexpected snapshot directory'); },
  };
  const rows = await Array.fromAsync(createVssSnapshotScanner([{ id: 'source', path: 'C:\\Data' }], [mapping], io)({ symlinks: 'follow' }, 'C:\\data\\Backup', { excludedSourcePaths: [{ sourceId: 'source', path: 'Backup' }] }));
  assert.ok(rows.some(entry => entry.path === 'Backup/keep'));
});

async function filesystem(t) {
  const root = await mkdtemp(join(tmpdir(), 'delta-vss-paths-')); t.after(() => rm(root, { recursive: true, force: true }));
  const snapshots = join(root, 'snapshots'); await mkdir(snapshots); const live = join(root, 'live'), target = join(root, 'target'), destination = join(root, 'backup');
  await mkdir(live); await mkdir(target); await mkdir(destination);
  const drive = windows.parse(live).root;
  const snapshotPath = value => join(snapshots, relative(drive, value));
  const translate = value => { assert.ok(value.toLowerCase().startsWith(`${device}\\`.toLowerCase()), `Unexpected non-snapshot read: ${value}`); return join(snapshots, windows.relative(`${device}\\`, value)); };
  await mkdir(snapshotPath(live), { recursive: true }); await mkdir(snapshotPath(target), { recursive: true });
  await writeFile(join(target, 'a'), 'LIVE changed value'); await writeFile(join(snapshotPath(target), 'a'), 'PINNED snapshot value');
  await symlink(target, join(live, 'link'), 'junction'); await symlink(target, join(snapshotPath(live), 'link'), 'junction');
  const io = { lstat: (value, options) => lstat(translate(value), options), readlink: value => readlink(translate(value)), opendir: value => opendir(translate(value)), realpath };
  return { root, live, target, destination, snapshots, snapshotPath, translate, io, mapping: { ...mapping, root: drive } };
}
test('Real junctions in a synthetic snapshot copy pinned bytes and never the modified live target', { skip: process.platform !== 'win32' }, async t => {
  const f = await filesystem(t);
  const task = { name: 'Snapshot links', schedulesPaused: false, wdir: f.root, proj: f.destination, srcs: [f.live], mode: 0, sources: [{ path: f.live, filters: { include: [], exclude: [] } }], sequence: { types: ['full'] }, retention: { when: 'after', keepCycles: 0, maxAgeDays: 0, protectPinned: true }, archive: { level: 0 }, detection: 'fast', symlinks: 'follow', snapshot: { mode: 'snapshot-only', fallback: 'fail' }, behavior: { continueOnFileError: true, retryCount: 0, resume: true } };
  const [source] = resolveTaskSources(task);
  await saveTaskDocument(join(f.destination, '.delta.json'), task, null);
  const scan = createVssSnapshotScanner([source], [f.mapping], f.io); let released;
  const run = await runBackup(task, f.destination, { sourceProvider: { async prepare() { return { sources: [source], consistentSnapshot: true, followsLinksInSnapshot: true, release: async outcome => { released = outcome; }, async* scan(task, destination, options) { for await (const entry of scan(task, destination, options)) yield { ...entry, ...(entry.absolute ? { absolute: f.translate(entry.absolute) } : {}) }; } }; } } });
  assert.equal(run.status, 'complete', run.error); assert.equal(run.consistentSnapshot, true); assert.equal(run.files, 1); assert.deepEqual(released, { success: true });
  assert.equal((await verifyRun(f.destination, run.id)).status, 'complete'); const output = join(f.root, 'restored'); assert.equal((await restoreRun(f.destination, run.id, output)).status, 'complete'); assert.equal(await readFile(join(output, 'link', 'a'), 'utf8'), 'PINNED snapshot value'); assert.equal(await readFile(join(f.target, 'a'), 'utf8'), 'LIVE changed value');
});
test('Snapshot scanner preserves/skips final junctions and records unavailable followed volumes', { skip: process.platform !== 'win32' }, async t => {
  const f = await filesystem(t); const source = { id: 'src_test', path: f.live }; const scan = createVssSnapshotScanner([source], [f.mapping], f.io);
  const baseTask = {};
  const preserved = await Array.fromAsync(scan({ ...baseTask, symlinks: 'preserve' }, f.destination)); assert.equal(preserved.find(entry => entry.path === 'link').kind, 'symlink'); assert.ok(!preserved.some(entry => entry.path === 'link/a'));
  const skipped = await Array.fromAsync(scan({ ...baseTask, symlinks: 'skip' }, f.destination)); assert.ok(!skipped.some(entry => entry.path === 'link'));
  await symlink('Z:\\outside-the-lease', join(f.snapshotPath(f.live), 'outside'), 'junction');
  const followed = await Array.fromAsync(scan({ ...baseTask, symlinks: 'follow' }, f.destination)); assert.equal(followed.find(entry => entry.path === 'outside').kind, 'missing'); assert.equal(followed.find(entry => entry.path === 'outside').code, 'VSS_LINK_UNAVAILABLE'); assert.equal(followed.find(entry => entry.path === 'link/a').kind, 'file');
});
test('Snapshot scanner detects directory cycles, excludes repository aliases and observes cancellation', { skip: process.platform !== 'win32' }, async t => {
  const f = await filesystem(t); const source = { id: 'src_test', path: f.live }; await mkdir(f.snapshotPath(f.destination), { recursive: true }); await writeFile(join(f.snapshotPath(f.destination), 'should-not-copy'), 'repository');
  await symlink(f.live, join(f.snapshotPath(f.live), 'loop'), 'junction'); await symlink(f.destination, join(f.snapshotPath(f.live), 'repository'), 'junction');
  const scan = createVssSnapshotScanner([source], [f.mapping], f.io); const task = { symlinks: 'follow' };
  const rows = await Array.fromAsync(scan(task, f.destination)); assert.equal(rows.find(entry => entry.path === 'loop').code, 'VSS_LINK_LOOP'); assert.ok(!rows.some(entry => entry.path.startsWith('repository')), JSON.stringify(rows)); assert.ok(rows.length < 8);
  const cancellation = new AbortController(); cancellation.abort(); await assert.rejects(Array.fromAsync(scan(task, f.destination, { signal: cancellation.signal })), { name: 'AbortError' });
});
