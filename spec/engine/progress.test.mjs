import { resolveTaskSources } from '../../src/domain/source-identity.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { runBackup, listRuns } from '../../src/engine/backup.mjs';
import { restoreRun, verifyRun } from '../../src/engine/restore.mjs';
import { iterateRunEntries } from '../../src/engine/repository.mjs';
import { scanSources } from '../../src/engine/scanner.mjs';
import { saveTaskDocument } from '../../src/config/task-document.mjs';

async function fixture(t, changes = {}) {
  const root = await mkdtemp(join(tmpdir(), 'delta-progress-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source'), destination = join(root, 'backup');
  await mkdir(source); await mkdir(destination);
  const task = {
    name: 'Progress', schedulesPaused: false, wdir: root, proj: destination, srcs: [source], mode: 0,
    sources: [{ path: source, filters: { include: [], exclude: [] } }],
    sequence: { types: ['full', 'incremental', 'incremental'] },
    retention: { when: 'after', keepCycles: 0, maxAgeDays: 0, protectPinned: true },
    archive: { level: 0 },
    detection: 'fast', symlinks: 'follow', snapshot: { mode: 'off', fallback: 'fail' },
    behavior: { continueOnFileError: true, retryCount: 0, resume: true },
    ...changes,
  };
  await saveTaskDocument(join(destination, '.delta.json'), task, null);
  return { root, source, destination, task, get sourceId() { return resolveTaskSources(task)[0].id; }, output: join(root, 'restore') };
}

function hasTotals(event) { return Object.hasOwn(event, 'totalFiles') || Object.hasOwn(event, 'totalBytes'); }
function assertProgress(events, phase, totalFiles, totalBytes) {
  const progress = events.filter(event => event.phase === phase);
  assert(progress.length > 0, `Expected ${phase} progress`);
  let previousFiles = 0, previousBytes = 0;
  for (const event of progress) {
    assert.equal(event.totalFiles, totalFiles);
    assert.equal(event.totalBytes, totalBytes);
    assert(Number.isSafeInteger(event.completedFiles));
    assert(Number.isSafeInteger(event.completedBytes));
    assert(event.completedFiles >= previousFiles && event.completedFiles <= totalFiles);
    assert(event.completedBytes >= previousBytes && event.completedBytes <= totalBytes);
    assert.equal(event.completedFiles, event.files);
    assert(event.completedBytes >= event.bytes);
    previousFiles = event.completedFiles; previousBytes = event.completedBytes;
  }
  assert.equal(previousFiles, totalFiles);
  assert.equal(previousBytes, totalBytes);
  return progress;
}

function providerFor(f, scan) {
  return { async prepare() { return { sources: resolveTaskSources(f.task), consistentSnapshot: true, scan, async release() {} }; } };
}

test('backup discovers totals before writing and reports bounded in-flight bytes before finalization', async t => {
  const f = await fixture(t), large = Buffer.alloc(4 * 64 * 1024, 17), small = 'second';
  await writeFile(join(f.source, 'large.bin'), large);
  await writeFile(join(f.source, 'żółć.txt'), small);
  await mkdir(join(f.source, 'empty-directory'));
  const events = [], run = await runBackup(f.task, f.destination, { onProgress(event) { events.push(event); } });
  assert.equal(run.status, 'complete', run.error);
  const scans = events.filter(event => event.phase === 'scan');
  assert(scans.length > 0);
  for (const event of scans) {
    assert(!hasTotals(event));
    assert.equal(event.files, undefined, 'Discovery must not trigger legacy completed-file callbacks');
    assert.equal(event.bytes, undefined);
  }
  const progress = assertProgress(events, 'backup', 2, large.length + Buffer.byteLength(small));
  assert(events.findIndex(event => event.phase === 'backup') > events.findLastIndex(event => event.phase === 'scan'));
  assert(progress.some(event => event.completedBytes > event.bytes), 'Large-file reads must advance before the whole file finishes');
  const finalizing = events.filter(event => event.phase === 'finalizing');
  assert(finalizing.length > 0);
  assert(events.findIndex(event => event.phase === 'finalizing') > events.findLastIndex(event => event.phase === 'backup'));
  for (const event of finalizing) assert(!hasTotals(event), 'Metadata finalization has no byte denominator');
  assert.equal(run.files, 2); assert.equal(run.bytes, large.length + Buffer.byteLength(small));
  assert.equal((await verifyRun(f.destination, run.id)).status, 'complete');
});

test('hash-mode incremental progress counts unchanged files once and keeps their original archives', async t => {
  const f = await fixture(t, { detection: 'hash' });
  await writeFile(join(f.source, 'a'), 'alpha'); await writeFile(join(f.source, 'b'), 'bravo');
  const first = await runBackup(f.task, f.destination), events = [];
  assert.equal(first.status, 'complete', first.error);
  let filesArchived = 0;
  const run = await runBackup(f.task, f.destination, {
    onProgress(event) { events.push(event); },
    fault(stage, { entry }) { if (stage === 'before-file' && entry.kind === 'file') filesArchived++; },
  });
  assert.equal(run.status, 'complete', run.error); assert.equal(run.type, 'incremental');
  assertProgress(events, 'backup', 2, 10); assert.equal(filesArchived, 2, 'Hash comparison reads both unchanged files');
  assert.equal(run.storedSize ?? 0, 0); assert.equal((await verifyRun(f.destination, run.id)).status, 'complete');
});

test('discovery retains provider-only file identities for later archive reads', async t => {
  const f = await fixture(t), content = Buffer.from('snapshot-backed content');
  await writeFile(join(f.source, 'a'), content); let opened = 0;
  const sourceProvider = { async prepare() { return {
    sources: resolveTaskSources(f.task), consistentSnapshot: true, async release() {},
    async *scan(task, destination, options) {
      for await (const row of scanSources(task, destination, resolveTaskSources(f.task), options)) {
        if (row.kind === 'file') { delete row.absolute; row.providerEntryId = 'snapshot-entry-7'; }
        yield row;
      }
    },
    async openFile(entry) {
      assert.equal(entry.providerEntryId, 'snapshot-entry-7'); assert.equal(entry.absolute, undefined); opened++;
      const bytes = await readFile(join(f.source, 'a'));
      return { reader: { size: bytes.length, readable: new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }) }, digest() { return createHash('sha256').update(bytes).digest('hex'); }, async close() {} };
    },
  }; } };
  const events = [], run = await runBackup(f.task, f.destination, { sourceProvider, onProgress(event) { events.push(event); } });
  assert.equal(run.status, 'complete', run.error); assert.equal(opened, 1);
  assertProgress(events, 'backup', 1, content.length);
  const restored = await restoreRun(f.destination, run.id, f.output);
  assert.equal(restored.status, 'complete'); assert.deepEqual(await readFile(join(f.output, 'a')), content);
});

test('empty regular files expose a file denominator when there are no content bytes', async t => {
  const f = await fixture(t);
  await writeFile(join(f.source, 'a'), ''); await writeFile(join(f.source, 'b'), '');
  const events = [], run = await runBackup(f.task, f.destination, { onProgress(event) { events.push(event); } });
  assert.equal(run.status, 'complete', run.error);
  const progress = assertProgress(events, 'backup', 2, 0);
  assert(progress.some(event => event.completedFiles === 1));
  const restoredEvents = [], restored = await restoreRun(f.destination, run.id, f.output, { onProgress(event) { restoredEvents.push(event); } });
  assert.equal(restored.status, 'complete'); assert.equal(restored.files, 2); assert.equal(restored.bytes, 0);
  assertProgress(restoredEvents, 'restore', 2, 0);
});

test('restore and verification totals describe the selected regular files, excluding other files and directories', async t => {
  const f = await fixture(t);
  await mkdir(join(f.source, 'nested')); await mkdir(join(f.source, 'nested', 'directory'));
  await writeFile(join(f.source, 'nested', 'a'), 'alpha'); await writeFile(join(f.source, 'nested', 'empty'), '');
  await writeFile(join(f.source, 'outside'), 'not selected');
  const run = await runBackup(f.task, f.destination); assert.equal(run.status, 'complete', run.error);
  for (const phase of ['restore', 'verify']) {
    const events = [], options = { paths: ['nested'], onProgress(event) { events.push(event); } };
    const result = phase === 'restore' ? await restoreRun(f.destination, run.id, f.output, options) : await verifyRun(f.destination, run.id, options);
    assert.equal(result.status, 'complete'); assert.equal(result.files, 2); assert.equal(result.bytes, 5);
    assertProgress(events, phase, 2, 5);
  }
  assert.equal(await readFile(join(f.output, 'nested', 'a'), 'utf8'), 'alpha');
  assert(!(await readdir(f.output)).includes('outside'));
});

for (const failure of ['missing', 'unsafe-size']) test(`${failure} scan rows leave backup totals unknown without losing readable files`, async t => {
  const f = await fixture(t); await writeFile(join(f.source, 'good'), 'readable'); await writeFile(join(f.source, 'bad'), 'unavailable');
  const sourceProvider = providerFor(f, async function* (task, destination, options) {
    for await (const row of scanSources(task, destination, resolveTaskSources(f.task), options)) {
      if (row.path === 'bad') {
        if (failure === 'missing') Object.assign(row, { kind: 'missing', expectedKind: 'file', error: 'Controlled scan error', code: 'EACCES' });
        else row.size = Number.MAX_SAFE_INTEGER + 1;
      }
      yield row;
    }
  });
  const events = [], run = await runBackup(f.task, f.destination, { sourceProvider, onProgress(event) { events.push(event); } });
  assert.equal(run.status, 'incomplete', run.error); assert.equal(run.files, 1); assert.equal(run.bytes, 8); assert.equal(run.errors, 1);
  assert(events.some(event => event.phase === 'backup'));
  for (const event of events) assert(!hasTotals(event), 'An incomplete or unsafe scan must not publish a guessed denominator');
  const restored = await restoreRun(f.destination, run.id, f.output);
  assert.equal(restored.status, 'incomplete'); assert.equal(await readFile(join(f.output, 'good'), 'utf8'), 'readable');
});

test('source changes after discovery still become explicit unavailable versions', async t => {
  const f = await fixture(t); await writeFile(join(f.source, 'changed'), 'old'); await writeFile(join(f.source, 'good'), 'safe');
  let changed = false; const events = [];
  const run = await runBackup(f.task, f.destination, {
    onProgress(event) { events.push(event); },
    async fault(stage, { entry }) {
      if (stage === 'before-file' && entry.path === 'changed' && !changed) { changed = true; await writeFile(join(f.source, 'changed'), 'a different size'); }
    },
  });
  assert(changed); assert.equal(run.status, 'incomplete', run.error); assert.equal(run.files, 1); assert.equal(run.bytes, 4);
  const afterError = events.filter(event => event.phase === 'backup' && event.errors > 0);
  assert(afterError.length > 0);
  for (const event of afterError) assert(!hasTotals(event), 'A source read error must withdraw the now-unreliable denominator');
  const entries = await Array.fromAsync(iterateRunEntries(f.destination, run.id));
  assert.equal(entries.find(entry => entry.path === 'changed').kind, 'missing');
  assert.equal(entries.find(entry => entry.path === 'good').kind, 'file');
  const restored = await restoreRun(f.destination, run.id, f.output);
  assert.equal(restored.status, 'incomplete'); assert.equal(await readFile(join(f.output, 'good'), 'utf8'), 'safe');
});

test('scanning pauses before further discovery or archive work and resumes the same backup', { timeout: 10000 }, async t => {
  const f = await fixture(t); await writeFile(join(f.source, 'a'), 'alpha'); await writeFile(join(f.source, 'b'), 'bravo');
  let release, entered, paused = false, pausedOnce = false, scans = 0, archiveCalls = 0;
  const gate = new Promise(resolve => { release = resolve; }), waiting = new Promise(resolve => { entered = resolve; });
  t.after(() => release());
  const operation = runBackup(f.task, f.destination, {
    async waitIfPaused() { if (paused) { entered(); await gate; } },
    onProgress(event) { if (event.phase === 'scan') { scans++; if (event.path !== undefined && !pausedOnce) { pausedOnce = true; paused = true; } } },
    fault(stage) { if (stage === 'before-file') archiveCalls++; },
  });
  await waiting;
  const stoppedAt = scans; await delay(20); assert.equal(scans, stoppedAt); assert.equal(archiveCalls, 0);
  paused = false; release(); const run = await operation;
  assert.equal(run.status, 'complete', run.error); assert.equal(run.files, 2); assert(archiveCalls > 0);
});

test('cancelling discovery stops before archive writes and never advertises totals', async t => {
  const f = await fixture(t); await writeFile(join(f.source, 'a'), 'alpha'); await writeFile(join(f.source, 'b'), 'bravo');
  const controller = new AbortController(), events = []; let archiveCalls = 0;
  await assert.rejects(runBackup(f.task, f.destination, {
    signal: controller.signal,
    onProgress(event) { events.push(event); if (event.phase === 'scan' && event.path !== undefined) controller.abort(new Error('Cancelled while discovering sources')); },
    fault(stage) { if (stage === 'before-file') archiveCalls++; },
  }), /Cancelled while discovering/);
  assert.equal(archiveCalls, 0);
  assert(events.some(event => event.phase === 'scan'));
  for (const event of events) assert(!hasTotals(event));
  assert.deepEqual(await listRuns(f.destination), []);
  assert(!(await readdir(f.destination)).some(name => name.endsWith('.zip') || name.endsWith('.partial')));
});
