import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { mkdtemp as nativeMkdtemp, mkdir, rm, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join as nativeJoin } from 'node:path';
import { portablePath } from '../../src/domain/source-identity.mjs';

const join = (...parts) => portablePath(nativeJoin(...parts));
const mkdtemp = async prefix => portablePath(await nativeMkdtemp(prefix));

const temporary = await mkdtemp(join(tmpdir(), 'delta-pause-')); after(() => rm(temporary, { recursive: true, force: true }));
const filename = join(temporary, 'service.cjs'); await build({ stdin: { contents: 'export { ApplicationService } from "./src/service/api.ts"; export { PauseController } from "./src/service/pause.ts"; export { executeEngine } from "./src/service/engine-executor.ts";', resolveDir: process.cwd(), loader: 'ts' }, outfile: filename, bundle: true, platform: 'node', target: 'node24', format: 'cjs', logLevel: 'silent' });
const { ApplicationService, PauseController, executeEngine } = createRequire(import.meta.url)(filename);
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const deferred = () => { let resolve, reject; const promise = new Promise((accept, decline) => { resolve = accept; reject = decline; }); return { promise, resolve, reject }; };
async function until(predicate) { const deadline = Date.now() + 4000; while (!predicate()) { if (Date.now() > deadline) throw new Error('Timed out waiting for pause transition'); await delay(5); } }
async function fixture(t, executor) {
  const root = await mkdtemp(join(temporary, 'case-')), source = join(root, 'source'); await mkdir(source);
  const service = new ApplicationService({ configDirectory: join(root, 'config'), executor }); await service.ready; t.after(() => service.shutdown());
  const create = async name => { const directory = join(root, name); await mkdir(directory); return service.request({ action: 'create', directory, name, sources: [{ path: source }] }); };
  return { root, service, create, task: await create('backup') };
}

test('pause waits do not block timers, resume releases all waiters and cancellation wakes them immediately', async () => {
  const abort = new AbortController(), pause = new PauseController(abort.signal), changes = []; pause.onChange(value => changes.push(value));
  pause.setPaused(true); let completed = 0; const first = pause.waitIfPaused().then(() => completed++), second = pause.waitIfPaused().then(() => completed++);
  await delay(15); assert.equal(completed, 0); pause.setPaused(true); assert.deepEqual(changes, [true]); pause.setPaused(false); await Promise.all([first, second]); assert.equal(completed, 2);
  pause.setPaused(true); const waiting = pause.waitIfPaused(), reason = new Error('Cancelled while paused'); abort.abort(reason); await assert.rejects(waiting, error => error === reason); await assert.rejects(pause.waitIfPaused(), error => error === reason); pause.dispose();
});

test('an immediate second pause keeps a released waiter blocked until the final resume', async () => {
  const abort = new AbortController(), pause = new PauseController(abort.signal); pause.setPaused(true); let completed = false;
  const waiting = pause.waitIfPaused().then(() => { completed = true; }); pause.setPaused(false); pause.setPaused(true); await delay(10); assert.equal(completed, false); pause.setPaused(false); await waiting; assert.equal(completed, true); pause.dispose();
});

test('an active backup pauses actual executor work and resumes the same operation, while cancellation also works paused', async t => {
  let files = 0, starts = 0, heartbeats = 0;
  const f = await fixture(t, async (_request, progress, signal, _provider, control) => {
    starts++; const heartbeat = setInterval(() => heartbeats++, 3);
    try { for (;;) { await control.waitIfPaused(); signal.throwIfAborted(); progress({ phase: 'backup', files: ++files, bytes: files * 64 * 1024 }); await delay(3); } }
    finally { clearInterval(heartbeat); }
  });
  const running = await f.service.request({ action: 'run', reference: f.task.id }); await until(() => files >= 3);
  const paused = await f.service.request({ action: 'pause', operationId: running.id }); assert.equal(paused.status, 'running'); assert.equal(paused.paused, true);
  const stoppedAt = files, heartbeatAt = heartbeats; await delay(30); assert.equal(files, stoppedAt); assert(heartbeats > heartbeatAt, 'Snapshot lease and heartbeat work must keep receiving event-loop time');
  const resumed = await f.service.request({ action: 'resume-operation', operationId: running.id }); assert.equal(resumed.id, running.id); assert.equal(resumed.paused, false); await until(() => files > stoppedAt); assert.equal(starts, 1);
  await f.service.request({ action: 'pause', operationId: running.id }); await f.service.request({ action: 'cancel', operationId: running.id }); const cancelled = await f.service.wait(running.id); assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.paused, false);
  await assert.rejects(f.service.request({ action: 'resume-operation', operationId: running.id }), /no longer active/);
});

test('the real ZIP engine stops archive writes while paused, resumes to a valid snapshot and cancels a paused backup', { timeout: 30000 }, async t => {
  let pausedOnce = false;
  const f = await fixture(t, (request, progress, signal, provider, control) => executeEngine(request, value => {
    progress(value);
    if (!pausedOnce && request.action === 'run' && value.files >= 1) { pausedOnce = true; const operation = [...f.service.operations.values()].find(item => item.taskId === join(request.directory, '.delta.json') && item.status === 'running'); f.service.setPaused(operation.id, true); }
  }, signal, provider, control)), source = f.task.value.sources[0].path, destination = f.task.directory;
  f.task = await f.service.request({ action: 'save', reference: f.task.id, revision: f.task.revision, patch: { archive: { level: 0 } } });
  for (let index = 0; index < 3; index++) await writeFile(join(source, `file-${index}.bin`), Buffer.alloc(2 * 1024 ** 2, index + 1));
  const bytesOnDisk = async () => { let bytes = 0; for (const file of await readdir(destination)) if (file.endsWith('.zip') || file.endsWith('.partial')) bytes += (await stat(join(destination, file))).size; return bytes; };
  const first = await f.service.request({ action: 'run', reference: f.task.id }); await until(() => f.service.operations.get(first.id)?.paused === true); await delay(15);
  const bytes = await bytesOnDisk(), files = f.service.operations.get(first.id).progress.files; await delay(40); assert.equal(await bytesOnDisk(), bytes); assert.equal(f.service.operations.get(first.id).progress.files, files);
  await f.service.request({ action: 'resume-operation', operationId: first.id }); const complete = await f.service.wait(first.id); assert.equal(complete.status, 'complete', complete.error ?? complete.result?.error); assert.equal(complete.result.files, 3);
  const verification = await f.service.request({ action: 'verify', reference: f.task.id, runId: complete.result.id }); assert.equal((await f.service.wait(verification.id)).status, 'complete');
  pausedOnce = false; const second = await f.service.request({ action: 'run', reference: f.task.id }); await until(() => f.service.operations.get(second.id)?.paused === true); await f.service.request({ action: 'cancel', operationId: second.id }); const cancelled = await f.service.wait(second.id); assert.equal(cancelled.status, 'cancelled', cancelled.error); assert.equal(cancelled.paused, false);
});

test('a paused queued backup stays queued while other runnable tasks proceed and resumes without duplication', async t => {
  const gates = new Map(), starts = [];
  const f = await fixture(t, async (request, _progress, signal) => { starts.push(join(request.directory, '.delta.json')); const gate = deferred(); gates.set(join(request.directory, '.delta.json'), gate); signal.addEventListener('abort', () => gate.reject(signal.reason), { once: true }); return gate.promise; });
  const second = await f.create('second'), third = await f.create('third'), firstRun = await f.service.request({ action: 'run', reference: f.task.id });
  const secondRun = await f.service.request({ action: 'run', reference: second.id }); await f.service.request({ action: 'pause', operationId: secondRun.id }); const thirdRun = await f.service.request({ action: 'run', reference: third.id });
  gates.get(f.task.id).resolve({ status: 'complete' }); await f.service.wait(firstRun.id); await until(() => starts.includes(third.id)); assert(!starts.includes(second.id));
  assert.equal((await f.service.request({ action: 'operations', operationId: secondRun.id }))[0].status, 'queued');
  await f.service.request({ action: 'resume-operation', operationId: secondRun.id }); assert(!starts.includes(second.id)); gates.get(third.id).resolve({ status: 'complete' }); await f.service.wait(thirdRun.id); await until(() => starts.includes(second.id));
  gates.get(second.id).resolve({ status: 'complete' }); await f.service.wait(secondRun.id); assert.deepEqual(starts, [f.task.id, third.id, second.id]);
});

test('pause rejects non-backup and unknown operations, and cancelling a paused queued task never starts it', async t => {
  const gates = new Map(); let starts = 0;
  const f = await fixture(t, async (request, _progress, signal) => { starts++; const gate = deferred(); gates.set(join(request.directory, '.delta.json'), gate); signal.addEventListener('abort', () => gate.reject(signal.reason), { once: true }); return gate.promise; });
  const active = await f.service.request({ action: 'restore-plan', reference: f.task.id, runId: '20261029120000', outputDirectory: join(f.root, 'restore') });
  await assert.rejects(f.service.request({ action: 'pause', operationId: active.id }), /Only backup/); await assert.rejects(f.service.request({ action: 'pause', operationId: 'unknown' }), /no longer active/);
  const second = await f.create('second'), queued = await f.service.request({ action: 'run', reference: second.id }); await f.service.request({ action: 'pause', operationId: queued.id }); await f.service.request({ action: 'cancel', operationId: queued.id });
  assert.equal((await f.service.wait(queued.id)).status, 'cancelled'); assert.equal((await f.service.wait(queued.id)).paused, false); assert.equal(starts, 1); await f.service.request({ action: 'cancel', operationId: active.id }); await f.service.wait(active.id);
});

test('delete is a tracked, mutually exclusive task operation and preserves engine blocker failures', async t => {
  const f = await fixture(t, async request => { assert.equal(request.action, 'delete'); assert.equal(request.runId, '20261029120000'); throw new Error('The backup is pinned or required by another snapshot'); });
  const queued = await f.service.request({ action: 'delete', reference: f.task.id, runId: '20261029120000' }); const result = await f.service.wait(queued.id); assert.equal(result.status, 'failed'); assert.match(result.error, /pinned|another snapshot/);
});
