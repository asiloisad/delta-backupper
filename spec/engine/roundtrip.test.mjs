import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, utimes, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { runBackup, retryRun, restoreRun, verifyRun, listRuns } from '../../src/engine/index.mjs';
import { acquireTaskLock } from '../../src/engine/storage.mjs';
import { saveTaskDocument } from '../../src/config/task-document.mjs';
import { createBoundedReader } from '../../src/archive/bounded-reader.mjs';
import { resolveTaskSources, archiveSourcePath, sourcePathKey } from '../../src/domain/source-identity.mjs';

async function fixture(t, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'delta-behavior-')); t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source'), destination = join(root, 'backup'), output = join(root, 'restored');
  await mkdir(source); await mkdir(destination);
  const task = { name: 'Żółć 日本語 🌍', wdir: root, proj: destination, srcs: ['source'], mode: 0, sources: [{ path: 'source', filters: { include: [], exclude: [] } }], schedulesPaused: false, schedules: [], sequence: { types: ['full', 'incremental', 'incremental'] }, retention: { when: 'after', keepCycles: 0, maxAgeDays: 0, protectPinned: true }, archive: { level: 1 }, detection: 'fast', symlinks: 'follow', snapshot: { mode: 'off', fallback: 'fail' }, behavior: { continueOnFileError: true, retryCount: 0, resume: true }, ...overrides };
  await saveTaskDocument(join(destination, '.delta.json'), task, null);
  return { root, source, destination, output, task };
}

test('FII rotation, forced full and plain UTF-8 control files follow the Python catalogue', async t => {
  const f = await fixture(t); await writeFile(join(f.source, 'żółć-🌍.txt'), '日本語');
  const runs = []; for (let i = 0; i < 4; i++) runs.push(await runBackup(f.task, f.destination));
  assert.deepEqual(runs.map(run => run.type), ['full', 'incremental', 'incremental', 'full']);
  const full = await runBackup(f.task, f.destination, { type: 'full' }); assert.equal(full.type, 'full');
  const text = await readFile(join(f.destination, '.delta.json'), 'utf8'), document = JSON.parse(text);
  assert(text.includes('Żółć 日本語 🌍')); assert(text.includes('żółć-🌍.txt')); assert(!/\\u[0-9a-f]{4}/i.test(text));
  assert.deepEqual(document.history, [...runs, full].map(run => `${run.id}.zip`));
  for (const name of document.history) assert.match(name, /^\d{20}\.zip$/);
  for (const field of ['id', 'schemaVersion', 'destination', 'hist', 'data', 'srcs']) assert(!Object.hasOwn(document, field));
  assert.equal((await restoreRun(f.destination, full.id, f.output)).status, 'complete');
  assert.equal(await readFile(join(f.output, 'żółć-🌍.txt'), 'utf8'), '日本語');
});

test('source modes use original paths without persisted source namespaces', () => {
  const task = { wdir: process.cwd(), sources: [{ path: 'folder', filters: { include: [], exclude: [] } }] }, [source] = resolveTaskSources(task);
  assert.equal(archiveSourcePath({ ...task, mode: 0 }, source, 'a.txt'), 'a.txt');
  assert.equal(archiveSourcePath({ ...task, mode: 1 }, source, 'a.txt'), 'folder/a.txt');
  const absolute = archiveSourcePath({ ...task, mode: 2 }, source, 'a.txt'); assert(absolute.endsWith('/folder/a.txt')); assert(!/^[A-Za-z]:/.test(absolute));
  assert.equal(sourcePathKey('./folder'), sourcePathKey('x/../folder/'));
});

test('colliding source names report an error; path mode 1 keeps both files with individual filters', async t => {
  const f = await fixture(t), second = join(f.root, 'other'); await mkdir(second);
  await writeFile(join(f.source, 'a.txt'), 'first'); await writeFile(join(second, 'a.txt'), 'last'); await writeFile(join(second, 'skip.tmp'), 'ignored');
  f.task.srcs = ['source', 'other']; f.task.sources.push({ path: 'other', filters: { include: ['*.txt'], exclude: [] } });
  await assert.rejects(runBackup(f.task, f.destination), /same archive path/);
  f.task.mode = 1; const run = await runBackup(f.task, f.destination); assert.equal(run.files, 2);
  assert.equal((await restoreRun(f.destination, run.id, f.output)).status, 'complete');
  assert.deepEqual(await readdir(f.output), ['other', 'source']); assert.equal(await readFile(join(f.output, 'source', 'a.txt'), 'utf8'), 'first'); assert.equal(await readFile(join(f.output, 'other', 'a.txt'), 'utf8'), 'last');
});

test('hash comparison catches equal-size changes at an unchanged timestamp', async t => {
  const f = await fixture(t, { detection: 'hash' }), filename = join(f.source, 'a');
  await writeFile(filename, 'first'); const at = new Date('2026-01-01T00:00:00Z'); await utimes(filename, at, at);
  await runBackup(f.task, f.destination); await writeFile(filename, 'other'); await utimes(filename, at, at);
  const run = await runBackup(f.task, f.destination); assert.equal(run.type, 'incremental');
  await restoreRun(f.destination, run.id, f.output); assert.equal(await readFile(join(f.output, 'a'), 'utf8'), 'other');
});

test('destination within source is excluded, and inaccessible sources leave the checkpoint intact', async t => {
  const f = await fixture(t); await writeFile(join(f.source, 'a'), 'data');
  const run = await runBackup(f.task, f.destination), before = await readFile(join(f.destination, '.delta.json'));
  f.task.srcs = ['missing']; await assert.rejects(runBackup(f.task, f.destination), /ENOENT/);
  assert.deepEqual(await readFile(join(f.destination, '.delta.json')), before); assert.equal((await verifyRun(f.destination, run.id)).status, 'complete');
  const inside = join(f.source, 'backup'); await mkdir(inside); f.task.srcs = ['source']; await saveTaskDocument(join(inside, '.delta.json'), f.task, null);
  const nested = await runBackup(f.task, inside); await restoreRun(inside, nested.id, f.output); assert.deepEqual(await readdir(f.output), ['a']);
});

test('task locks prevent overlapping runs and invalid sequences do not write archives', async t => {
  const f = await fixture(t), lock = await acquireTaskLock(f.destination);
  try { await assert.rejects(runBackup(f.task, f.destination), /lock|busy/i); } finally { await lock.release(); }
  for (const types of [[], ['incremental'], ['full', 'unknown']]) await assert.rejects(runBackup({ ...f.task, sequence: { types } }, f.destination), /sequence/);
  assert.deepEqual(await listRuns(f.destination), []);
});

test('per-file read errors keep readable files, record original paths and retry creates a usable new ZIP', async t => {
  const f = await fixture(t); await writeFile(join(f.source, 'a'), 'alpha'); await writeFile(join(f.source, 'b'), 'bravo');
  const run = await runBackup(f.task, f.destination, { fault(stage, { entry }) { if (stage === 'before-file' && entry.path === 'b') throw new Error('Controlled read failure'); } });
  assert.equal(run.status, 'incomplete'); assert.equal(run.errors, 1);
  const result = await restoreRun(f.destination, run.id, f.output); assert.equal(result.status, 'incomplete'); assert.equal(await readFile(join(f.output, 'a'), 'utf8'), 'alpha');
  const retry = await retryRun(f.task, f.destination, run.id); assert.notEqual(retry.id, run.id); assert.equal((await verifyRun(f.destination, retry.id)).status, 'complete');
});

test('retryCount handles a transient read failure before reporting success', async t => {
  const f = await fixture(t); f.task.behavior.retryCount = 1; await writeFile(join(f.source, 'a'), 'alpha'); let attempts = 0;
  const run = await runBackup(f.task, f.destination, { fault(stage) { if (stage === 'before-file' && attempts++ === 0) throw new Error('Transient read failure'); } });
  assert.equal(attempts, 2); assert.equal(run.status, 'complete'); assert.equal((await verifyRun(f.destination, run.id)).status, 'complete');
});

test('cancellation before publication removes partial output and never advances history', async t => {
  const f = await fixture(t); await writeFile(join(f.source, 'a'), 'alpha'); const before = await readFile(join(f.destination, '.delta.json')), controller = new AbortController();
  await assert.rejects(runBackup(f.task, f.destination, { signal: controller.signal, fault(stage) { if (stage === 'before-commit') controller.abort(); } }), { name: 'AbortError' });
  assert.deepEqual(await readFile(join(f.destination, '.delta.json')), before); assert.deepEqual(await readdir(f.destination), ['.delta.json']);
});

test('pause blocks the current execution and resumes to a verified archive', { timeout: 10000 }, async t => {
  const f = await fixture(t); await writeFile(join(f.source, 'a'), 'alpha'); let paused = false, enter, release;
  const waiting = new Promise(resolve => { enter = resolve; }), gate = new Promise(resolve => { release = resolve; }); t.after(release);
  const pending = runBackup(f.task, f.destination, { onProgress(event) { if (event.phase === 'backup') paused = true; }, async waitIfPaused() { if (paused) { enter(); await gate; } } });
  await waiting; assert.deepEqual(await listRuns(f.destination), []); await delay(25); paused = false; release();
  const run = await pending; assert.equal((await verifyRun(f.destination, run.id)).status, 'complete');
});

test('snapshot verification and cleanup failures prevent publication', async t => {
  for (const failure of ['verify', 'release']) {
    const f = await fixture(t); await writeFile(join(f.source, 'a'), 'alpha'); const before = await readFile(join(f.destination, '.delta.json'));
    const provider = { async prepare(_task, options) { return { sources: options.sources, consistentSnapshot: true, async verify() { if (failure === 'verify') throw new Error('Snapshot health failed'); }, async release() { if (failure === 'release') throw new Error('Snapshot cleanup failed'); } }; } };
    await assert.rejects(runBackup(f.task, f.destination, { sourceProvider: provider }), /Snapshot|cleanup/);
    assert.deepEqual(await readFile(join(f.destination, '.delta.json')), before); assert.deepEqual(await readdir(f.destination), ['.delta.json']);
  }
});

test('hundreds of Unicode members share one ordinary ZIP64 archive without a custom comment', async t => {
  const f = await fixture(t); for (let i = 0; i < 128; i++) await writeFile(join(f.source, `${i}-żółć-🌍`), String(i));
  const run = await runBackup(f.task, f.destination); assert.equal(run.parts.length, 1); assert.equal(run.files, 128);
  const archive = await createBoundedReader(join(f.destination, run.parts[0].name));
  try { let count = 0; for await (const entry of archive.iterateEntries({})) { count++; assert(entry.filename === '.snapshot.json' || entry.filename.includes('żółć-🌍')); } assert.equal(count, 129); } finally { await archive.close(); }
  assert.equal((await verifyRun(f.destination, run.id)).status, 'complete');
});
