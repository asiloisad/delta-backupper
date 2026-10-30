import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveTaskSources } from '../../src/domain/source-identity.mjs';

const workspace = await mkdtemp(path.join(tmpdir(), 'delta-preview-lifecycle-'));
after(() => rm(workspace, { recursive: true, force: true }));
const bundle = path.join(workspace, 'service.cjs');
await build({ entryPoints: [path.resolve('src/service/api.ts')], outfile: bundle, bundle: true, platform: 'node', target: 'node24', format: 'cjs', logLevel: 'silent' });
const { ApplicationService } = createRequire(import.meta.url)(bundle);
function deferred() { let resolve, reject; const promise = new Promise((accept, decline) => { resolve = accept; reject = decline; }); return { promise, resolve, reject }; }
async function within(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Timed out waiting for preview lifecycle transition')), 3000); })]); }
  finally { clearTimeout(timer); }
}
async function fixture(t, options = {}, settings = {}) {
  const root = await mkdtemp(path.join(workspace, 'case-')), source = path.join(root, 'source'), directory = path.join(root, 'backup');
  await mkdir(source); await mkdir(directory);
  const service = new ApplicationService({ configDirectory: path.join(root, 'profile'), ...options }); await service.ready; t.after(() => service.shutdown());
  const task = await service.request({ action: 'create', directory, name: 'Restore preview fixture', sources: [{ path: source }], settings });
  const request = { action: 'restore-plan', reference: task.id, runId: 'run_fixture', outputDirectory: path.join(root, 'output'), paths: ["document.txt"], overwrite: 'error' };
  return { root, directory, service, task, request };
}
function blockedExecutor() {
  const entered = deferred(), result = deferred(); let signal, captured;
  return {
    entered: entered.promise,
    get signal() { return signal; }, get request() { return captured; },
    executor(request, _progress, cancellation) {
      captured = request; signal = cancellation; entered.resolve();
      cancellation.addEventListener('abort', () => result.reject(cancellation.reason), { once: true });
      return result.promise;
    },
    complete(value) { result.resolve(value); },
  };
}

test('Restore preview returns a tracked operation while its executor remains blocked and prevents overlapping backup work', async t => {
  const gate = blockedExecutor(); const { service, task, request } = await fixture(t, { executor: gate.executor });
  const operation = await within(service.request(request)); await within(gate.entered);
  assert.equal(operation.action, 'restore-plan'); assert.equal(operation.taskId, task.id); assert.ok(['queued', 'running'].includes(operation.status));
  assert.equal(gate.signal.aborted, false); assert.equal(gate.request.action, 'restore-plan'); assert.equal(gate.request.runId, request.runId); assert.deepEqual(gate.request.paths, request.paths); assert.equal(gate.request.outputDirectory, request.outputDirectory);
  assert.equal((await service.request({ action: 'operations' })).find(value => value.id === operation.id).status, 'running');
  await assert.rejects(service.request({ action: 'run', reference: task.id }), /already active/);
  gate.complete({ status: 'ready', files: 1 }); assert.equal((await within(service.wait(operation.id))).status, 'complete');
});

test('Cancelling a running restore preview aborts the executor and settles the tracked operation', async t => {
  const gate = blockedExecutor(); const { service, request } = await fixture(t, { executor: gate.executor });
  const operation = await within(service.request(request)); await within(gate.entered);
  await service.request({ action: 'cancel', operationId: operation.id });
  assert.equal(gate.signal.aborted, true); const settled = await within(service.wait(operation.id));
  assert.equal(settled.status, 'cancelled'); assert.ok(settled.finishedAt); assert.match(settled.error, /Cancelled/);
  assert.equal((await service.request({ action: 'operations' })).find(value => value.id === operation.id).status, 'cancelled');
});

test('Shutdown aborts a restore preview and waits until the executor has completed its cleanup', async t => {
  const entered = deferred(), aborted = deferred(), cleanup = deferred(); let observedSignal;
  t.after(() => cleanup.resolve());
  const executor = (_request, _progress, signal) => {
    observedSignal = signal; entered.resolve();
    return new Promise((_, reject) => { signal.addEventListener('abort', () => { aborted.resolve(); void cleanup.promise.then(() => reject(signal.reason)); }, { once: true }); });
  };
  const { service, request } = await fixture(t, { executor });
  const operation = await within(service.request(request)); await within(entered.promise);
  let stopped = false; const shutdown = service.shutdown().then(() => { stopped = true; });
  await within(aborted.promise); await new Promise(resolve => setImmediate(resolve));
  assert.equal(observedSignal.aborted, true); assert.equal(stopped, false); assert.equal(service.operations.get(operation.id).status, 'running');
  cleanup.resolve(); await within(shutdown); assert.equal(stopped, true); assert.equal((await service.wait(operation.id)).status, 'cancelled');
  await assert.rejects(service.request(request), /shutting down/);
});

test('A restore preview withdrawn before preparation never reaches the executor or creates backup output', async t => {
  let executions = 0;
  const { service, directory, request } = await fixture(t, { executor: async () => { executions++; return { status: 'ready' }; } });
  const operationId = randomUUID(); await service.request({ action: 'cancel', operationId });
  const operation = await within(service.request({ ...request, operationId }));
  assert.equal(operation.id, operationId); assert.equal(operation.status, 'cancelled'); assert.equal(executions, 0); assert.equal((await service.wait(operationId)).status, 'cancelled');
  assert.deepEqual((await readdir(directory)).sort(), ['.delta.json']);
});

test('A blocked restore plan retains its structured result while the tracked operation is incomplete', async t => {
  const plan = { status: 'blocked', conflicts: 1, missing: 0, issues: [{ path: 'source/document.txt', kind: 'conflict', error: 'Restore collision' }] };
  const { service, request } = await fixture(t, { executor: async () => plan });
  const operation = await within(service.request(request)); const settled = await within(service.wait(operation.id));
  assert.equal(settled.action, 'restore-plan'); assert.equal(settled.status, 'incomplete'); assert.deepEqual(settled.result, plan); assert.equal(settled.result.status, 'blocked');
});



test('A ready restore plan settles successfully and publishes its counts in the operation result', async t => {
  const plan = { status: 'ready', files: 2, bytes: 200, directories: 1, conflicts: 0, missing: 0, issues: [] };
  const { service, request } = await fixture(t, { executor: async () => plan }); const events = [];
  service.on('operation', value => { events.push(value); });
  const operation = await within(service.request(request)); const settled = await within(service.wait(operation.id));
  assert.equal(settled.status, 'complete'); assert.deepEqual(settled.result, plan); assert.ok(settled.finishedAt);
  assert.ok(events.some(event => event.id === operation.id && event.status === 'running'));
  assert.ok(events.some(event => event.id === operation.id && event.status === 'complete' && event.result.files === 2));
});
