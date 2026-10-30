import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { mkdtemp as nativeMkdtemp, mkdir, writeFile, readFile, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join as nativeJoin, dirname, basename } from 'node:path';
import { portablePath } from '../../src/domain/source-identity.mjs';

const join = (...parts) => portablePath(nativeJoin(...parts));
const mkdtemp = async prefix => portablePath(await nativeMkdtemp(prefix));

const temporary = await mkdtemp(join(tmpdir(), 'delta-dashboard-')); after(() => rm(temporary, { recursive: true, force: true }));
const filename = join(temporary, 'dashboard.cjs'); await build({ stdin: { contents: 'export * from "./src/service/dashboard.ts"; export { ApplicationService } from "./src/service/api.ts"; export { ConfigurationStore } from "./src/config/index.ts"; export { runBackup } from "./src/engine/index.mjs";', resolveDir: process.cwd(), loader: 'ts' }, outfile: filename, bundle: true, platform: 'node', target: 'node24', format: 'cjs', logLevel: 'silent' });
const { Dashboard, summarizeBackupOperation, validateActivity, readLatestBackup, ApplicationService, ConfigurationStore, runBackup } = createRequire(import.meta.url)(filename);
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const deferred = () => { let resolve; const promise = new Promise(value => { resolve = value; }); return { promise, resolve }; };
const instant = '2026-10-29T12:00:00.000Z';
const operation = (index, overrides = {}) => ({ id: `op_${String(index).padStart(5, '0')}`, taskId: 'task_1', action: 'run', status: 'complete', startedAt: instant, finishedAt: instant, result: { id: `run_${String(index).padStart(5, '0')}`, status: 'complete', type: 'full', files: 2, bytes: 100, startedAt: instant }, ...overrides });
const entry = (index, directory = join(temporary, `destination-${index}`)) => join(directory, '.delta.json');
const numberOf = filename => Number(/destination-(\d+)/.exec(filename)?.[1] ?? 1);
const inspection = (filename, run) => ({ taskId: `task_${numberOf(filename)}`, name: `Task ${numberOf(filename)}`, ...(run ? { run } : {}) });
const registry = (...tasks) => tasks.map(filename => dirname(filename));
async function directory() { return mkdtemp(join(temporary, 'case-')); }

test('terminal backup summaries contain actual counters and errors without credentials, task settings or archives', () => {
  const summary = summarizeBackupOperation(operation(1, { result: { id: 'run_1', type: 'incremental', startedAt: instant, files: 5, bytes: 1024, encryptionKeyCheck: 'SECRET', password: 'SECRET', parts: ['PRIVATE'] }, error: 'Follow-up warning' }));
  assert.deepEqual(summary, { id: 'run_1', taskId: 'task_1', operationId: 'op_00001', startedAt: instant, finishedAt: instant, status: 'complete', type: 'incremental', files: 5, bytes: 1024, error: 'Follow-up warning' });
  assert.equal(summarizeBackupOperation(operation(1, { status: 'running' })), undefined); assert.equal(summarizeBackupOperation(operation(1, { action: 'restore-plan' })), undefined);
  const failed = summarizeBackupOperation(operation(1, { status: 'failed', result: undefined, progress: { files: 1, bytes: 12 }, error: 'Unreadable source' })); assert.equal(failed.id, 'op_00001'); assert.equal(failed.files, 1); assert.equal(failed.error, 'Unreadable source');
});

test('saved activity uses only the strict current format and rejects invalid or duplicate entries', () => {
  const row = summarizeBackupOperation(operation(1)); assert.deepEqual(validateActivity({ schemaVersion: 1, entries: [row] }).entries, [row]);
  for (const document of [{ schemaVersion: 0, entries: [] }, { schemaVersion: 2, entries: [] }, { schemaVersion: 1, entries: [], extra: true }, { schemaVersion: 1, entries: [row, row] }, ...[{ status: ['complete'] }, { type: ['full'] }, { files: -1 }, { bytes: Infinity }, { password: 'SECRET' }, { id: '../escape' }, { startedAt: 'yesterday' }].map(patch => ({ schemaVersion: 1, entries: [{ ...row, ...patch }] }))]) assert.throws(() => validateActivity(document));
});

test('flat snapshot summaries read embedded metadata without source scans or archive payload verification', async () => {
  const destination = await directory(), source = await directory(), profile = await directory(), taskPath = entry(1, destination), contents = 'Dashboard metadata fixture payload 123456789';
  await writeFile(join(source, 'file.txt'), contents); const store = new ConfigurationStore({ configDirectory: profile });
  const task = await store.createTask({ directory: destination, name: 'Task 1', sources: [{ path: source }], settings: { archive: { level: 0 } } });
  const created = await runBackup(task.value, destination); assert.equal(created.status, 'complete', created.error);
  await rm(source, { recursive: true }); await writeFile(join(destination, 'unrelated.zip'), 'This is not a Delta snapshot.');
  const part = join(destination, created.parts[0].name), bytes = await readFile(part), payload = bytes.indexOf(Buffer.from(contents)); assert(payload >= 0); bytes[payload] ^= 1; await writeFile(part, bytes);
  const summary = (await readLatestBackup(taskPath)).run; assert.equal(summary.bytes, Buffer.byteLength(contents)); assert.equal(summary.files, 1); assert.equal(summary.id, created.id); assert(!Object.hasOwn(summary, 'parts'));
  const originalTask = await readFile(taskPath); const renamed = JSON.parse(originalTask); renamed.name = "Renamed"; await writeFile(taskPath, JSON.stringify(renamed)); assert.equal((await readLatestBackup(taskPath)).name, "Renamed"); await writeFile(taskPath, originalTask);
  for (const archive of created.parts) await unlink(join(destination, archive.name)); assert.deepEqual(await readLatestBackup(taskPath), { taskId: task.id, name: 'Task 1' });
});

test('activity survives restart with failed and incomplete backups, and read-only dashboard does not rewrite the journal', async () => {
  const root = await directory(), tasks = registry(entry(1)), first = new Dashboard({ directory: root, registry: async () => tasks, inspect: async filename => inspection(filename) });
  first.record(operation(1)); first.record(operation(2, { status: 'failed', result: { error: 'Disk full' } })); first.record(operation(3, { status: 'incomplete', result: { type: 'incremental', files: 1, bytes: 50, error: 'Missing file' } })); await first.close();
  const journal = join(root, 'activity.json'), before = await readFile(journal), second = new Dashboard({ directory: root, registry: async () => tasks, inspect: async filename => inspection(filename) });
  const snapshot = await second.snapshot(); assert.deepEqual(snapshot.recent.map(run => run.status).sort(), ['complete', 'failed', 'incomplete']); assert(snapshot.recent.every(run => run.taskName === 'Task 1')); assert(snapshot.recent.some(run => run.error === 'Disk full')); assert.deepEqual(await readFile(journal), before); await second.close();
});

test('two concurrent profile writers merge their summaries and failure storms stay bounded to 100 entries', async () => {
  const root = await directory(), ports = { directory: root, registry: async () => registry(entry(1)), inspect: async filename => inspection(filename) }, left = new Dashboard(ports), right = new Dashboard(ports);
  left.record(operation(1)); right.record(operation(2)); await Promise.all([left.close(), right.close()]); assert.equal(validateActivity(JSON.parse(await readFile(join(root, 'activity.json'), 'utf8'))).entries.length, 2);
  const storm = new Dashboard(ports); for (let index = 3; index < 1004; index++) storm.record(operation(index, { status: 'failed', result: undefined, error: `Failure ${index}` })); await storm.close();
  const document = validateActivity(JSON.parse(await readFile(join(root, 'activity.json'), 'utf8'))); assert.equal(document.entries.length, 100); assert(document.entries.some(row => row.error === 'Failure 1003')); assert(!document.entries.some(row => row.error === 'Failure 3'));
});

test('an invalid activity file is reported and preserved instead of migrated, replaced or blocking other destination summaries', async () => {
  const root = await directory(), journal = join(root, 'activity.json'), bytes = '{"schemaVersion":0,"entries":[]}'; await writeFile(journal, bytes);
  const dashboard = new Dashboard({ directory: root, registry: async () => registry(entry(1)), inspect: async filename => inspection(filename, summarizeBackupOperation(operation(1))) });
  const snapshot = await dashboard.snapshot(); assert.equal(snapshot.recent.length, 1); assert(snapshot.errors.some(row => row.taskId === '' && row.message.includes('activity'))); dashboard.record(operation(2)); await dashboard.close(); assert.equal(await readFile(journal, 'utf8'), bytes);
});

test('one hung destination cannot delay ready local summaries and repeated requests reuse the same pending probe', async () => {
  const root = await directory(), gate = deferred(), calls = new Map(); let active = 0, peak = 0;
  const dashboard = new Dashboard({ directory: root, timeoutMs: 20, registry: async () => registry(entry(1), entry(2), entry(3)), inspect: async filename => { const id = `task_${numberOf(filename)}`; calls.set(id, (calls.get(id) ?? 0) + 1); active++; peak = Math.max(peak, active); try { if (id === 'task_1') await gate.promise; return inspection(filename, { ...summarizeBackupOperation(operation(numberOf(filename))), taskId: id }); } finally { active--; } } });
  const started = Date.now(), first = await dashboard.snapshot(); assert(Date.now() - started < 300); assert.deepEqual(first.recent.map(row => row.taskId).sort(), ['task_2', 'task_3']); assert(first.errors.some(row => row.taskId === entry(1)));
  for (let index = 0; index < 10; index++) await dashboard.snapshot(); assert.equal(calls.get('task_1'), 1); assert.equal(peak, 2); await dashboard.close(); gate.resolve(); await pause(0);
});

test('two stalled OS reads retain their actual slots while the local activity cache and bounded dashboard still respond', async () => {
  const root = await directory(), gates = [deferred(), deferred()], calls = [];
  const dashboard = new Dashboard({ directory: root, timeoutMs: 15, registry: async () => registry(entry(1), entry(2), entry(3)), inspect: async filename => { calls.push(`task_${numberOf(filename)}`); await gates[numberOf(filename) - 1].promise; return inspection(filename); } });
  dashboard.record(operation(1, { status: 'failed', error: 'Previous failure' }));
  for (let index = 0; index < 8; index++) { const snapshot = await dashboard.snapshot(); assert(snapshot.recent.some(row => row.error === 'Previous failure')); assert.equal(snapshot.errors.length, 3); }
  assert.deepEqual(calls, ['task_1', 'task_2']); const closed = dashboard.close(); await Promise.race([closed, pause(100).then(() => assert.fail('Closing must not await a stalled OS read'))]); gates.forEach(gate => gate.resolve()); await pause(0);
});

test('ApplicationService records real backup completion and failure for a new service instance', async () => {
  const root = await directory(), configDirectory = join(root, '.delta'), destination = join(root, 'backup'), source = join(root, 'source'); await mkdir(destination); await mkdir(source);
  let calls = 0; const service = new ApplicationService({ configDirectory, executor: async () => ++calls === 1 ? { id: 'completed_run', type: 'full', status: 'complete', startedAt: instant, files: 10, bytes: 500 } : { status: 'failed', error: 'Controlled destination failure' } }); await service.ready;
  const task = await service.request({ action: 'create', directory: destination, name: 'Documents', sources: [{ path: source }] });
  for (let index = 0; index < 2; index++) { const queued = await service.request({ action: 'run', reference: task.id }); await service.wait(queued.id); } await service.shutdown();
  const restarted = new ApplicationService({ configDirectory }); await restarted.ready; const snapshot = await restarted.request({ action: 'dashboard' }); assert.equal(snapshot.recent.length, 2); assert(snapshot.recent.every(row => row.taskName === 'Documents')); assert(snapshot.recent.some(row => row.files === 10 && row.bytes === 500)); assert(snapshot.recent.some(row => row.status === 'failed' && row.error === 'Controlled destination failure')); await restarted.shutdown();
});
