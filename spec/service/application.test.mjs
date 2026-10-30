import assert from "node:assert/strict";
import { test, after } from "node:test";
import { build } from "esbuild";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { mkdtemp as nativeMkdtemp, mkdir, writeFile, readFile, rename, rm, readdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import nativePath from "node:path";
import { resolveTaskSources, portablePath } from "../../src/domain/source-identity.mjs";

const path = { ...nativePath, join: (...parts) => portablePath(nativePath.join(...parts)), resolve: (...parts) => portablePath(nativePath.resolve(...parts)) };
const mkdtemp = async prefix => portablePath(await nativeMkdtemp(prefix));

const workspace = await mkdtemp(path.join(tmpdir(), "delta-service-"));
after(async () => { await rm(workspace, { recursive: true, force: true }); });
const bundle = path.join(workspace, "service.cjs");
await build({ stdin: { contents: 'export { ApplicationService } from "./src/service/api.ts";', resolveDir: process.cwd(), loader: "ts" }, outfile: bundle, bundle: true, platform: "node", target: "node24", format: "cjs", logLevel: "silent" });
const { ApplicationService } = createRequire(import.meta.url)(bundle);
async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(workspace, "case-")), source = path.join(root, "źródło"), directory = path.join(root, "backup");
  await mkdir(source); await mkdir(directory);
  const service = new ApplicationService({ configDirectory: path.join(root, ".delta"), ...options }); await service.ready; t.after(() => service.shutdown());
  const task = await service.request({ action: "create", directory, name: "Test dokumentów", sources: [{ path: source }], settings: { detection: "hash", archive: { level: 6 }, sequence: { types: ["full", "incremental"] } } });
  return { root, source, directory, service, task };
}
async function operation(service, action, reference, options = {}) { const queued = await service.request({ action, reference, ...options }); return service.wait(queued.id); }
async function until(predicate) { const limit = Date.now() + 4000; while (!predicate()) { if (Date.now() > limit) throw new Error("Timed out waiting for expected queue transition"); await new Promise(resolve => setTimeout(resolve, 10)); } }


test("real API creates full/incremental backups, history, selected restore and complete restore", { timeout: 30000 }, async t => {
  const { root, source, directory, service, task } = await fixture(t);
  const bootstrap = await service.request({ action: "bootstrap" }); assert.equal(bootstrap.app.value.language, "en"); assert.equal(bootstrap.tasks[0].name, "Test dokumentów"); assert.equal(bootstrap.tasks[0].task.value.sources[0].path, source); assert(!Object.hasOwn(bootstrap.tasks[0].task.value.sources[0], "label"));
  await writeFile(path.join(source, "a.txt"), "alpha"); await writeFile(path.join(source, "żółć.txt"), "Unicode 🌍"); await mkdir(path.join(source, "empty"));
  const full = await operation(service, "run", task.id); assert.equal(full.status, "complete", full.error); assert.equal(full.result.type, "full");
  await writeFile(path.join(source, "a.txt"), "changed alpha"); await unlink(path.join(source, "żółć.txt")); await writeFile(path.join(source, "new.txt"), "new");
  const incremental = await operation(service, "run", task.id); assert.equal(incremental.status, "complete", incremental.error); assert.equal(incremental.result.type, "incremental");
  const history = await service.request({ action: "history", reference: directory }); assert.equal(history.length, 2);
  const files = await service.request({ action: "files", reference: task.id, runId: incremental.result.id, limit: 200 });
  assert(files.entries.some(entry => entry.path === "new.txt")); assert(!files.entries.some(entry => entry.path === "żółć.txt"));
  const verified = await operation(service, "verify", task.id, { runId: incremental.result.id }); assert.equal(verified.status, "complete", JSON.stringify(verified));
  const selectedOutput = path.join(root, "selected"); const selected = await operation(service, "restore", task.id, { runId: incremental.result.id, outputDirectory: selectedOutput, paths: ["a.txt"], overwrite: "error" });
  assert.equal(selected.status, "complete", JSON.stringify(selected)); assert.equal(await readFile(path.join(selectedOutput, "a.txt"), "utf8"), "changed alpha");
  assert.deepEqual(await readdir(selectedOutput), ["a.txt"]);
  const output = path.join(root, "restored"); const restored = await operation(service, "restore", task.id, { runId: full.result.id, outputDirectory: output, overwrite: "error" });
  assert.equal(restored.status, "complete", JSON.stringify(restored)); assert.equal(await readFile(path.join(output, "żółć.txt"), "utf8"), "Unicode 🌍");
  assert.equal(await readFile(path.join(output, "a.txt"), "utf8"), "alpha");
  const collision = await operation(service, "restore", task.id, { runId: full.result.id, outputDirectory: output, overwrite: "error" }); assert.equal(collision.status, "incomplete");
  const skipped = await operation(service, "restore", task.id, { runId: full.result.id, outputDirectory: output, overwrite: "skip" }); assert.equal(skipped.status, "complete"); assert(skipped.result.skipped >= 2);
});

test("API preserves independent per-source filters through create, edit, execution and duplication", async t => {
  let executed;
  const { root, source, directory, service, task } = await fixture(t, { executor: async request => { executed = structuredClone(request.task); return { status: "complete", files: 0, bytes: 0 }; } });
  assert.deepEqual(task.value.sources[0].filters, { include: [], exclude: [] }); assert.deepEqual(Object.keys(task.value.sources[0]).sort(), ["filters", "path"]); assert(!Object.hasOwn(task.value, "filters"));
  const photos = path.join(root, "photos"); await mkdir(photos);
  const saved = await service.request({ action: "save", reference: task.id, revision: task.revision, patch: { sources: [{ ...task.value.sources[0], filters: { include: ["*.txt"], exclude: ["private/**"] } }, { path: photos, filters: { include: ["*.jpg"] } }] } });
  assert.deepEqual(saved.value.sources.map(item => item.filters), [{ include: ["*.txt"], exclude: ["private/**"] }, { include: ["*.jpg"], exclude: [] }]); assert.equal(resolveTaskSources(saved.value)[0].id, resolveTaskSources(task.value)[0].id);
  const running = await service.request({ action: "run", reference: task.id }); assert.equal((await service.wait(running.id)).status, "complete"); assert.deepEqual(executed.sources, saved.value.sources); assert(!Object.hasOwn(executed, "filters"));
  const copyDirectory = path.join(root, "copy-target"); await mkdir(copyDirectory);
  const copied = await service.request({ action: "duplicate", reference: task.id, directory: copyDirectory }); assert.deepEqual(copied.value.sources.map(item => item.filters), saved.value.sources.map(item => item.filters));
  const disk = JSON.parse(await readFile(path.join(directory, ".delta.json"), "utf8")); assert.deepEqual(disk.sources, saved.value.srcs); assert.equal(typeof disk.sources[0], "string"); assert(disk.sources.every(item => typeof item === "string" || !Object.hasOwn(item, "id")));
});

test("API create preserves the draft ZIP path mode in saved settings and engine requests", async t => {
  const executed = [];
  const { root, source, service } = await fixture(t, { executor: async request => { executed.push(request.task.mode); return { status: "complete" }; } });
  for (const mode of [0, 1, 2]) {
    const directory = path.join(root, `path-mode-${mode}`); await mkdir(directory);
    const created = await service.request({ action: "create", directory, name: `Mode ${mode}`, sources: [{ path: source }], settings: { mode } });
    assert.equal(created.value.mode, mode); assert.equal(JSON.parse(await readFile(path.join(directory, ".delta.json"), "utf8")).pathMode, mode);
    const loaded = await service.request({ action: "load", reference: created.id }); assert.equal(loaded.value.mode, mode);
    const running = await service.request({ action: "run", reference: created.id }); assert.equal((await service.wait(running.id)).status, "complete");
  }
  assert.deepEqual(executed, [0, 1, 2]);
  const rejected = path.join(root, "invalid-path-mode"); await mkdir(rejected);
  await assert.rejects(service.request({ action: "create", directory: rejected, name: "Invalid", sources: [{ path: source }], settings: { mode: 3 } }), /task\.mode: expected one of 0, 1, 2/);
  assert.deepEqual(await readdir(rejected), []);
});

test("API task defaults provide working directory and archive paths to new drafts, saved tasks and actual backups", async t => {
  const { root, source, service } = await fixture(t), { defaults } = await service.request({ action: "bootstrap" });
  await writeFile(path.join(source, "document.txt"), "from the inherited working directory");
  const saved = await service.request({ action: "defaults-save", revision: defaults.revision, value: { ...defaults.value, settings: { ...defaults.value.settings, wdir: root, mode: 1 } } });
  assert.equal(saved.value.settings.wdir, root); assert.equal(saved.value.settings.mode, 1);
  const bootstrapped = await service.request({ action: "bootstrap" }); assert.equal(bootstrapped.defaults.value.settings.wdir, root); assert.equal(bootstrapped.defaults.value.settings.mode, 1);
  const directory = path.join(root, "inherited-paths"); await mkdir(directory);
  const created = await service.request({ action: "create", directory, name: "Inherited paths", sources: [{ path: path.basename(source) }] });
  assert.equal(created.value.wdir, root); assert.equal(created.value.mode, 1);
  const run = await operation(service, "run", created.id); assert.equal(run.status, "complete", run.error);
  const files = await service.request({ action: "files", reference: created.id, runId: run.result.id, limit: 100 });
  assert(files.entries.some(entry => entry.path === `${path.basename(source)}/document.txt`));
  const disk = JSON.parse(await readFile(path.join(directory, ".delta.json"), "utf8")); assert.equal(disk.workingDirectory, root); assert.equal(disk.pathMode, 1);
});

test("API duplicate draft preserves all settings and source patterns without saving or remembering a copy", async t => {
  const { root, service } = await fixture(t), directory = path.join(root, "pattern-backup"); await mkdir(directory);
  const created = await service.request({ action: "create", directory, name: "Pattern task", sources: [{ path: "documents", filters: { include: ["*.txt"], exclude: ["cache/**"] } }], settings: { wdir: root, srcs: [["documents", "**/*.txt", "private/.*"]], mode: 2, detection: "hash", schedulesPaused: true, archive: { level: 0 } } });
  const filename = path.join(directory, ".delta.json"), withHistory = { ...JSON.parse(await readFile(filename, "utf8")), history: ["20261030120000000000.zip"], files: { "documents/żółć.txt": "10:20" } }; await writeFile(filename, JSON.stringify(withHistory));
  const before = await readFile(filename), registry = await readFile(path.join(service.store.directory, "tasks.json")), rootNames = await readdir(root), loaded = await service.request({ action: "load", reference: created.id });
  const draft = await service.request({ action: "duplicate-draft", reference: created.id }), { name, proj: _proj, ...settings } = loaded.value;
  assert.equal(draft.name, `${name} (copy)`); assert.deepEqual(draft.settings, settings); assert.equal(draft.settings.wdir, root); assert.deepEqual(draft.settings.srcs, [["documents", "**/*.txt", "private/.*"]]); assert.equal(draft.settings.mode, 2); assert.equal(draft.settings.detection, "hash");
  for (const key of ["name", "proj", "id", "history", "hist", "files", "data"]) assert(!Object.hasOwn(draft.settings, key));
  assert.deepEqual(await readFile(filename), before); assert.deepEqual(await readFile(path.join(service.store.directory, "tasks.json")), registry); assert.deepEqual(await readdir(root), rootNames); assert.deepEqual(await readdir(directory), [".delta.json"]);
});

test("API rejects source IDs before changing tasks or creating destination configuration", async t => {
  const { root, source, directory, service, task } = await fixture(t), id = randomUUID();
  const before = await readFile(path.join(directory, ".delta.json"));
  await assert.rejects(service.request({ action: "save", reference: task.id, revision: task.revision, patch: { sources: [{ ...task.value.sources[0], id }] } }), /id: unknown field|Unsupported source field/);
  assert.deepEqual(await readFile(path.join(directory, ".delta.json")), before);
  const rejected = path.join(root, "rejected-source-id"); await mkdir(rejected);
  await assert.rejects(service.request({ action: "create", directory: rejected, name: "Rejected source ID", sources: [{ id, path: source }] }), /id: unknown field|Unsupported source field/);
  assert.deepEqual(await readdir(rejected), []);
});

test("removed password and encryption API fields reject before creating tasks or enqueuing ordinary ZIP backups", async t => {
  let starts = 0; const { root, source, directory, service, task } = await fixture(t, { executor: async request => { starts++; assert(!Object.hasOwn(request, "password")); assert(!Object.hasOwn(request.task, "encryption")); return { status: "complete" }; } });
  const before = await readFile(path.join(directory, ".delta.json"));
  for (const values of [{ password: "" }, { password: "unsupported" }, { rawPassword: new Uint8Array([1]) }, { rememberPassword: false }, { credentialRef: "removed" }, { encryption: { enabled: false } }]) await assert.rejects(service.request({ action: "run", reference: task.id, ...values }), /Unsupported request field/);
  await assert.rejects(service.request({ action: "credential-clear", reference: task.id }), /Unknown action/);
  const invalidDirectory = path.join(root, "invalid-target"); await mkdir(invalidDirectory);
  await assert.rejects(service.request({ action: "create", directory: invalidDirectory, name: "Invalid", sources: [{ path: source }], password: "unsupported" }), /Unsupported request field/);
  assert.deepEqual(await readdir(invalidDirectory), []); assert.deepEqual(await readFile(path.join(directory, ".delta.json")), before); assert.equal(starts, 0); assert.equal(service.operations.size, 0);
  const queued = await service.request({ action: "run", reference: task.id }); assert.equal((await service.wait(queued.id)).status, "complete"); assert.equal(starts, 1);
});

test("API rejects stale revisions and relinks offline task paths without deleting backups", async t => {
  const { root, source, directory, service, task } = await fixture(t);
  const external = { ...JSON.parse(await readFile(path.join(directory, ".delta.json"), "utf8")), name: "edited externally" }; await writeFile(path.join(directory, ".delta.json"), JSON.stringify(external));
  await assert.rejects(service.request({ action: "save", reference: task.id, revision: task.revision, patch: { name: "stale" } }), /changed externally|conflict/i);
  assert.equal(JSON.parse(await readFile(path.join(directory, ".delta.json"), "utf8")).name, external.name);
  const moved = path.join(root, "new mount"); await rename(directory, moved);
  const offline = await service.request({ action: "bootstrap" }); assert.equal(offline.tasks[0].available, false); assert.equal(offline.tasks[0].id, path.join(directory, ".delta.json")); assert(!Object.hasOwn(offline.tasks[0], "task"));
  const relinked = await service.request({ action: "relink", reference: path.join(directory, ".delta.json"), directory: moved }); assert.equal(relinked.id, path.join(moved, ".delta.json"));
  assert.equal((await service.request({ action: "bootstrap" })).tasks[0].available, true);
  await rename(moved, directory); await service.request({ action: "forget", reference: path.join(moved, ".delta.json") });
  assert.equal((await service.request({ action: "bootstrap" })).tasks.length, 0); assert(!Object.hasOwn(JSON.parse(await readFile(path.join(directory, ".delta.json"), "utf8")), "id"));
  assert.equal((await readdir(source)).length, 0);
});

test("queue prevents duplicate task execution, respects concurrency and cancels queued/running work", { timeout: 10000 }, async t => {
  const pending = new Map(), started = []; let active = 0, peak = 0;
  const executor = async (request, progress, signal) => {
    started.push(path.join(request.directory, ".delta.json")); active++; peak = Math.max(peak, active); progress({ phase: "test", files: 1, bytes: 4 });
    try { return await new Promise((resolve, reject) => { pending.set(path.join(request.directory, ".delta.json"), resolve); signal.addEventListener("abort", () => reject(signal.reason), { once: true }); }); } finally { active--; }
  };
  const { root, source, service, task } = await fixture(t, { executor });
  const create = async name => { const directory = path.join(root, name); await mkdir(directory); return service.request({ action: "create", directory, name, sources: [{ path: source }] }); };
  const second = await create("second"), third = await create("third");
  const firstOp = await service.request({ action: "run", reference: task.id });
  await assert.rejects(service.request({ action: "run", reference: task.id }), /already active/);
  const secondOp = await service.request({ action: "run", reference: second.id }), thirdOp = await service.request({ action: "run", reference: third.id });
  assert.equal(secondOp.status, "queued"); assert.equal(thirdOp.status, "queued"); assert.equal(peak, 1);
  await service.request({ action: "cancel", operationId: secondOp.id }); assert.equal((await service.wait(secondOp.id)).status, "cancelled");
  pending.get(task.id)({ status: "complete" }); assert.equal((await service.wait(firstOp.id)).status, "complete");
  await until(() => started.includes(third.id)); assert(!started.includes(second.id));
  await service.request({ action: "cancel", operationId: thirdOp.id }); assert.equal((await service.wait(thirdOp.id)).status, "cancelled"); assert.equal(active, 0);
  const app = await service.store.readApp(); await service.request({ action: "app-save", revision: app.revision, value: { ...app.value, maxConcurrentTasks: 2 } });
  const one = await service.request({ action: "run", reference: task.id }), two = await service.request({ action: "run", reference: second.id });
  assert.equal(one.status, "running"); assert.equal(two.status, "running"); assert.equal(peak, 2);
  pending.get(task.id)({ status: "incomplete" }); pending.get(second.id)({ status: "complete" }); assert.equal((await service.wait(one.id)).status, "incomplete"); assert.equal((await service.wait(two.id)).status, "complete");
});







test("repeated scheduler failures keep bounded operation history and retain active work", async t => {
  const executor = async (_request, _progress, signal) => new Promise((_resolve, reject) => { signal.addEventListener("abort", () => reject(signal.reason), { once: true }); });
  const { service, task } = await fixture(t, { executor });
  const running = await service.request({ action: "run", reference: task.id });
  for (let index = 0; index < 1001; index++) service.reportFailure(task.id, "scheduled-run", new Error(`Failure ${index}`));
  const history = await service.request({ action: "operations" });
  assert(history.length <= 100, `history grew to ${history.length} records`);
  assert(service.operations.size <= 100); assert(history.some(operation => operation.id === running.id && operation.status === "running"));
  assert(history.some(operation => operation.error === "Failure 1000"));
  assert(!history.some(operation => operation.error === "Failure 0"));
  await service.request({ action: "cancel", operationId: running.id });
  assert.equal((await service.wait(running.id)).status, "cancelled");
});

test("an operation withdrawn before task preparation never starts an executor or creates an archive", async t => {
  let starts = 0; const { service, task, directory } = await fixture(t, { executor: async () => { starts++; return { status: "complete" }; } });
  const operationId = randomUUID(); await service.request({ action: "cancel", operationId });
  const cancelled = await service.request({ action: "run", reference: task.id, operationId });
  assert.equal(cancelled.id, operationId); assert.equal(cancelled.status, "cancelled"); assert.equal(starts, 0);
  assert.equal((await service.wait(operationId)).status, "cancelled");
  assert.deepEqual((await readdir(directory)).sort(), [".delta.json"]);
});

test("cancellation during slow task preparation withdraws the not-yet-enqueued operation", async t => {
  let starts = 0, releasePreparation, reachedPreparation;
  const entered = new Promise(resolve => { reachedPreparation = resolve; }), gate = new Promise(resolve => { releasePreparation = resolve; });
  const { service, task, directory } = await fixture(t, { executor: async () => { starts++; return { status: "complete" }; } });
  const resolveTask = service.resolveTask.bind(service); service.resolveTask = async reference => { reachedPreparation(); await gate; return resolveTask(reference); };
  const operationId = randomUUID(), pending = service.request({ action: "run", reference: task.id, operationId });
  await entered; await service.request({ action: "cancel", operationId }); releasePreparation();
  const cancelled = await pending; assert.equal(cancelled.status, "cancelled"); assert.equal(cancelled.id, operationId); assert.equal(starts, 0);
  assert.deepEqual((await readdir(directory)).sort(), [".delta.json"]);
});







test("an offline task requires its remembered file path and forgetting never opens or recreates the destination", async t => {
  const { root, directory, service, task } = await fixture(t), disconnected = path.join(root, "disconnected-usb");
  const originalTask = await readFile(path.join(directory, ".delta.json")); await rename(directory, disconnected);
  assert.equal((await service.request({ action: "bootstrap" })).tasks[0].available, false);
  await assert.rejects(service.request({ action: "forget", reference: task.value.name }), /offline|not remembered/i);
  await service.request({ action: "forget", reference: path.join(directory, ".delta.json") });
  assert.deepEqual((await service.store.readRegistry()).value, []);
  await assert.rejects(readFile(path.join(directory, ".delta.json")), { code: "ENOENT" });
  assert.deepEqual(await readFile(path.join(disconnected, ".delta.json")), originalTask);
  assert(!(await readdir(root)).includes(path.basename(directory)));
});

test("an offline task can be forgotten by normalized directory, including Windows case differences", async t => {
  const { root, directory, service, task } = await fixture(t), disconnected = path.join(root, "disconnected-nas");
  await rename(directory, disconnected);
  let reference = `${directory}${path.sep}..${path.sep}${path.basename(directory)}${path.sep}`;
  if (process.platform === "win32") reference = reference.toUpperCase();
  await service.request({ action: "forget", reference });
  assert.deepEqual((await service.store.readRegistry()).value, []);
  assert(!Object.hasOwn(JSON.parse(await readFile(path.join(disconnected, ".delta.json"), "utf8")), "id"));
  assert(!(await readdir(root)).includes(path.basename(directory)));
});

test("ambiguous online names preserve all remembered paths and an exact task ID takes priority", async t => {
  const { root, source, directory, service, task } = await fixture(t), otherDirectory = path.join(root, "other-target"); await mkdir(otherDirectory);
  const other = await service.request({ action: "create", directory: otherDirectory, name: task.value.name, sources: [{ path: source }] });
  const registryPath = path.join(service.store.directory, "tasks.json"), before = await readFile(registryPath);
  await assert.rejects(service.request({ action: "forget", reference: task.value.name }), /Several remembered tasks/); assert.deepEqual(await readFile(registryPath), before);
  await service.store.saveTask(other, { name: task.id }); await service.request({ action: "forget", reference: task.id });
  assert.deepEqual((await service.store.readRegistry()).value, [otherDirectory]); assert.equal((await service.store.loadTask(directory)).id, task.id);
});

test("bootstrap lists independent tasks and the removed group API cannot change the catalogue", async t => {
  const { service, task } = await fixture(t);
  const bootstrap = await service.request({ action: "bootstrap" });
  assert(!Object.hasOwn(bootstrap, "groups")); assert.deepEqual(bootstrap.tasks.map(entry => entry.id), [task.id]);
  const filename = path.join(service.store.directory, "tasks.json"), before = await readFile(filename);
  await assert.rejects(service.request({ action: "group", name: "Linked view", taskIds: [task.id] }), /Unknown action: group/);
  assert.deepEqual(await readFile(filename), before);
});


test("pausing task schedules or a rule never disables a manual backup", async t => {
  let calls = 0; const { service, task, directory } = await fixture(t, { executor: async () => { calls++; return { status: "complete" }; } });
  const schedule = { name: "Daily", paused: true, kind: "daily", intervalMinutes: 1440, time: "20:00", weekdays: [1, 2, 3, 4, 5, 6, 7], timeZone: "UTC", missed: "run-once", onDestinationAvailable: false };
  const saved = await service.request({ action: "save", reference: task.id, revision: task.revision, patch: { schedulesPaused: true, schedules: [schedule] } });
  assert.equal(saved.value.schedulesPaused, true); assert.equal(saved.value.schedules[0].paused, true); assert(!Object.hasOwn(saved.value, "enabled")); assert(!Object.hasOwn(saved.value.schedules[0], "enabled"));
  const result = await operation(service, "run", saved.id); assert.equal(result.status, "complete"); assert.equal(calls, 1);
  const disk = JSON.parse(await readFile(path.join(directory, ".delta.json"), "utf8")); assert.equal(disk.schedulesPaused, true); assert.equal(disk.schedules[0].paused, true); assert(!Object.hasOwn(disk, "enabled"));
});
