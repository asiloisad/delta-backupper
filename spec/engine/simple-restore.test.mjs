import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, lstat, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createBoundedArchive } from '../../src/archive/bounded-writer.mjs';
import { restoreRun, verifyRun } from '../../src/engine/restore.mjs';
import { planRestore } from '../../src/engine/restore-plan.mjs';
import { planDeleteRun, deleteRun, applyRetention, pinRun } from '../../src/engine/retention.mjs';
import { listFlatRuns } from '../../src/engine/repository.mjs';
import { sequenceToString } from '../../src/config/sequence.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const input = value => { const data = Buffer.from(value); return { size: data.length, readable: new ReadableStream({ start(controller) { if (data.length) controller.enqueue(data); controller.close(); } }) }; };
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'delta-simple-restore-')); t.after(() => rm(root, { recursive: true, force: true }));
  const destination = join(root, 'backup'), output = join(root, 'output'); await mkdir(destination);
  const task = { wdir: root, proj: destination, srcs: ['../source'], mode: 0, name: 'Simple snapshots', schedulesPaused: false, schedules: [], sequence: { types: ['full', 'incremental', 'differential'] }, retention: { when: 'after', keepCycles: 0, maxAgeDays: 0, protectPinned: true }, archive: { level: 0 }, detection: 'hash', symlinks: 'follow', snapshot: { mode: 'off', fallback: 'fail', lvmCowSizeBytes: 8589934592 }, behavior: { continueOnFileError: true, retryCount: 0, resume: true } };
  const history = [];
  const save = async data => { const { wdir, proj, srcs, mode, ...settings } = task; await writeFile(join(destination, '.delta.json'), JSON.stringify({ ...settings, sequence: sequenceToString(task.sequence), workingDirectory: wdir, backupDirectory: proj, sources: srcs, pathMode: mode, history, files: data })); }; await save({});
  async function point(id, type, data, stored = {}, payloads = {}, extra = {}) {
    const filename = join(destination, `${id}.zip`), archive = await createBoundedArchive(filename, { zip64: true, level: 0 });
    const snapshot = { startedAt: '2026-10-30 00:00:00.000000', finishedAt: '2026-10-30 00:00:01.000000', compressionLevel: 0, full: type === 'full', totalBytes: Object.values(payloads).reduce((sum, value) => sum + Buffer.byteLength(value), 0), storedBytes: Object.values(payloads).reduce((sum, value) => sum + Buffer.byteLength(value), 0), files: data, archivedFiles: stored, errors: extra.errors ?? {} };
    assert.deepEqual(Object.keys(snapshot).sort(), ['startedAt', 'finishedAt', 'compressionLevel', 'full', 'totalBytes', 'storedBytes', 'files', 'archivedFiles', 'errors'].sort());
    try { for (const [path, value] of Object.entries(stored)) if (value === null) await archive.writer.add(`${path}/`, undefined, { directory: true }); for (const [path, value] of Object.entries(payloads)) await archive.writer.add(path, input(value), { level: 0 }); await archive.writer.add('.snapshot.json', input(JSON.stringify(snapshot)), { level: 0 }); await archive.writer.close(); } catch (error) { await archive.abort(error); throw error; }
    history.push(`${id}.zip`); await save(data); return { id, filename, snapshot };
  }
  return { root, destination, output, task, history, point, save };
}

test('restore resolves desired fingerprints backwards without reviving removed paths', async t => {
  const f = await fixture(t), old = hash('old'), latest = hash('new'), added = hash('added'), removed = hash('removed');
  await f.point('20261030000000', 'full', { a: old, gone: removed, empty: null }, { a: old, gone: removed, empty: null }, { a: 'old', gone: 'removed' });
  await f.point('20261030000001', 'incremental', { a: latest, b: added, gone: removed, empty: null }, { a: latest, b: added }, { a: 'new', b: 'added' });
  const selected = await f.point('20261030000002', 'differential', { a: latest, b: added, empty: null });
  const plan = await planRestore(f.destination, selected.id, f.output); assert.equal(plan.status, 'ready', JSON.stringify(plan)); assert.equal(plan.files, 2); assert.equal(plan.bytes, 8); assert.equal(plan.parts, 1);
  await assert.rejects(lstat(f.output), { code: 'ENOENT' });
  const result = await restoreRun(f.destination, selected.id, f.output); assert.equal(result.status, 'complete', JSON.stringify(result)); assert.equal(result.files, 2); assert.equal(result.bytes, 8);
  assert.equal(await readFile(join(f.output, 'a'), 'utf8'), 'new'); assert.equal(await readFile(join(f.output, 'b'), 'utf8'), 'added'); assert((await lstat(join(f.output, 'empty'))).isDirectory());
  assert(!(await readdir(f.output)).includes('gone')); assert.equal((await verifyRun(f.destination, selected.id)).status, 'complete');
  const subset = await restoreRun(f.destination, selected.id, join(f.root, 'subset'), { paths: ['b'] }); assert.equal(subset.files, 1); assert.deepEqual(await readdir(join(f.root, 'subset')), ['b']);
});

test('fast fingerprints enforce sizes and ordinary overwrite policies preserve existing content', async t => {
  const f = await fixture(t), point = await f.point('20261030000000', 'full', { nested: null, 'nested/a': '1700000000000000000:5', empty: '1700000000000000000:0' }, { nested: null, 'nested/a': '1700000000000000000:5', empty: '1700000000000000000:0' }, { 'nested/a': 'alpha', empty: '' });
  await mkdir(join(f.output, 'nested'), { recursive: true }); await writeFile(join(f.output, 'nested', 'a'), 'keep');
  const plan = await planRestore(f.destination, point.id, f.output); assert.equal(plan.status, 'blocked'); assert.equal(plan.conflicts, 1);
  const first = await restoreRun(f.destination, point.id, f.output); assert.equal(first.status, 'incomplete'); assert.equal(await readFile(join(f.output, 'nested', 'a'), 'utf8'), 'keep');
  const skipped = await restoreRun(f.destination, point.id, f.output, { overwrite: 'skip' }); assert.equal(skipped.status, 'complete'); assert.equal(skipped.skipped, 2); assert.equal(await readFile(join(f.output, 'nested', 'a'), 'utf8'), 'keep');
  assert.equal((await restoreRun(f.destination, point.id, f.output, { overwrite: 'replace' })).status, 'complete'); assert.equal(await readFile(join(f.output, 'nested', 'a'), 'utf8'), 'alpha');
});

test('SHA fingerprints and ZIP CRC failures prevent publishing corrupted files', async t => {
  const f = await fixture(t), expected = hash('correct'), forged = await f.point('20261030000000', 'full', { a: expected }, { a: expected }, { a: 'wrong' });
  const result = await restoreRun(f.destination, forged.id, f.output); assert.equal(result.status, 'incomplete'); assert.equal(result.files, 0); assert.deepEqual(await readdir(f.output), []);
  const crc = await f.point('20261030000001', 'full', { a: '1700000000000000000:25' }, { a: '1700000000000000000:25' }, { a: 'unique-payload-crc-marker' });
  const bytes = await readFile(crc.filename), index = bytes.indexOf(Buffer.from('unique-payload-crc-marker')); assert(index >= 0); bytes[index] ^= 1; await writeFile(crc.filename, bytes);
  const verified = await verifyRun(f.destination, crc.id); assert.equal(verified.status, 'incomplete'); assert(verified.errors.some(error => /CRC|signature|integrity/i.test(error.error)), JSON.stringify(verified));
});

test('missing desired versions and explicit scan errors remain unavailable', async t => {
  const f = await fixture(t), old = hash('old'), absent = hash('absent');
  await f.point('20261030000000', 'full', { a: old }, { a: old }, { a: 'old' });
  const selected = await f.point('20261030000001', 'incremental', { a: absent, broken: old }, {}, {}, { status: 'incomplete', errors: { broken: 'Access denied during scan' } });
  const plan = await planRestore(f.destination, selected.id, f.output); assert.equal(plan.status, 'blocked'); assert.equal(plan.missing, 2);
  const result = await restoreRun(f.destination, selected.id, f.output); assert.equal(result.status, 'incomplete'); assert.equal(result.files, 0); assert.equal(result.errors.length, 2); assert.deepEqual(await readdir(f.output), []);
});

test('unsafe snapshot paths are rejected before an output directory is created', async t => {
  const f = await fixture(t), value = hash('escape'), point = await f.point('20261030000000', 'full', { '../escape': value }, { '../escape': value }, { '../escape': 'escape' });
  await assert.rejects(restoreRun(f.destination, point.id, f.output), /Unsafe|path/i); assert.equal((await planRestore(f.destination, point.id, f.output)).status, 'blocked'); await assert.rejects(lstat(f.output), { code: 'ENOENT' }); await assert.rejects(lstat(join(f.root, 'escape')), { code: 'ENOENT' });
});

test('existing symlink parents never redirect restoration outside the output', async t => {
  const f = await fixture(t), value = hash('safe'), point = await f.point('20261030000000', 'full', { nested: null, 'nested/a': value }, { nested: null, 'nested/a': value }, { 'nested/a': 'safe' });
  const outside = join(f.root, 'outside'); await mkdir(outside); await mkdir(f.output);
  try { await symlink(outside, join(f.output, 'nested'), process.platform === 'win32' ? 'junction' : 'dir'); } catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('Filesystem does not allow test symlinks'); return; } throw error; }
  assert.equal((await planRestore(f.destination, point.id, f.output)).status, 'blocked'); assert.equal((await restoreRun(f.destination, point.id, f.output)).status, 'incomplete'); assert.deepEqual(await readdir(outside), []);
});


test('deletion protects needed versions rather than archive identities', async t => {
  const f = await fixture(t), value = hash('same'), first = await f.point('20261030000000', 'full', { a: value }, { a: value }, { a: 'same' });
  const second = await f.point('20261030000001', 'incremental', { a: value });
  assert.equal((await planDeleteRun(f.task, f.destination, first.id)).status, 'blocked'); await assert.rejects(deleteRun(f.task, f.destination, first.id), error => error.code === 'DELETE_BLOCKED');
  await deleteRun(f.task, f.destination, second.id);
  assert.equal((await planDeleteRun(f.task, f.destination, first.id)).status, 'ready'); await deleteRun(f.task, f.destination, first.id); assert.deepEqual(await listFlatRuns(f.destination), []);
});

test('another stored copy of an identical version permits deletion and remains restorable', async t => {
  const f = await fixture(t), value = hash('same'), first = await f.point('20261030000000', 'full', { a: value }, { a: value }, { a: 'same' });
  const second = await f.point('20261030000001', 'incremental', { a: value }, { a: value }, { a: 'same' });
  assert.equal((await planDeleteRun(f.task, f.destination, first.id)).status, 'ready'); await deleteRun(f.task, f.destination, first.id);
  assert.equal((await restoreRun(f.destination, second.id, f.output)).status, 'complete'); assert.equal(await readFile(join(f.output, 'a'), 'utf8'), 'same');
});

test('retention removes an old cycle and preserves a pinned snapshot using the simple catalogue', async t => {
  const f = await fixture(t), old = hash('old'), latest = hash('new');
  const first = await f.point('20261030000000', 'full', { a: old }, { a: old }, { a: 'old' });
  const second = await f.point('20261030000001', 'incremental', { a: old });
  const third = await f.point('20261030000002', 'full', { a: latest }, { a: latest }, { a: 'new' });
  f.task.retention.keepCycles = 1;
  await pinRun(f.destination, first.id); assert.deepEqual((await applyRetention(f.task, f.destination)).removed, []);
  await pinRun(f.destination, first.id, false); const removed = await applyRetention(f.task, f.destination); assert.deepEqual(new Set(removed.removed), new Set([first.id, second.id])); assert.deepEqual((await listFlatRuns(f.destination)).map(run => run.id), [third.id]);
  assert.equal((await restoreRun(f.destination, third.id, f.output)).status, 'complete');
  const root = JSON.parse(await readFile(join(f.destination, '.delta.json'), 'utf8')); assert.deepEqual(root.history, [`${third.id}.zip`]); assert.equal(root.id, undefined); assert.equal(root.schemaVersion, undefined);
});


test('hist order controls restore independently of archive filename ordering', async t => {
  const f = await fixture(t), value = hash('chosen');
  await f.point('z-older', 'full', { a: value }, { a: value }, { a: 'chosen' });
  const selected = await f.point('a-selected', 'incremental', { a: value });
  await f.point('0-future', 'incremental', { a: value }, { a: value }, { a: 'future' });
  const result = await restoreRun(f.destination, selected.id, f.output); assert.equal(result.status, 'complete', JSON.stringify(result)); assert.equal(await readFile(join(f.output, 'a'), 'utf8'), 'chosen');
  assert.equal((await planDeleteRun(f.task, f.destination, 'z-older')).status, 'blocked', 'A future copy cannot satisfy an earlier restore point');
});

test('Windows filename collisions preserve the first restored file with replace enabled', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t), first = hash('first'), second = hash('second'), point = await f.point('20261030000000', 'full', { 'A.txt': first, 'a.txt': second }, { 'A.txt': first, 'a.txt': second }, { 'A.txt': 'first', 'a.txt': 'second' });
  const result = await restoreRun(f.destination, point.id, f.output, { overwrite: 'replace' }); assert.equal(result.status, 'incomplete'); assert.equal(result.files, 1); assert.equal(await readFile(join(f.output, 'A.txt'), 'utf8'), 'first'); assert(result.errors.some(error => /Ambiguous/.test(error.error)));
});

test('Python null directories need no archived directory entry and known versions can survive a later write error', async t => {
  const f = await fixture(t), value = hash('known'), first = await f.point('earlier', 'full', { a: value }, { a: value }, { a: 'known' });
  const selected = await f.point('selected', 'incremental', { a: value, empty: null }, {}, {}, { errors: { a: 'C:/unavailable/source/a' } });
  const result = await restoreRun(f.destination, selected.id, f.output); assert.equal(result.status, 'complete', JSON.stringify(result)); assert.equal(await readFile(join(f.output, 'a'), 'utf8'), 'known'); assert((await lstat(join(f.output, 'empty'))).isDirectory());
  assert.equal((await planDeleteRun(f.task, f.destination, first.id)).status, 'blocked', 'The known desired fingerprint still needs its earlier stored copy');
});
