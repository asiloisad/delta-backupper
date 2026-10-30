import assert from "node:assert/strict";
import { test, after } from "node:test";
import { build } from "esbuild";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp as nativeMkdtemp, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import nativePath from "node:path";
import { fileURLToPath } from "node:url";
import { runtimeDirectory } from "../../src/platform/application-paths.mjs";
import { resolveTaskSources, portablePath } from "../../src/domain/source-identity.mjs";

const path = { ...nativePath, join: (...parts) => portablePath(nativePath.join(...parts)), resolve: (...parts) => portablePath(nativePath.resolve(...parts)) };
const mkdtemp = async prefix => portablePath(await nativeMkdtemp(prefix));

const root = fileURLToPath(new URL("../../", import.meta.url));
const workspace = await mkdtemp(path.join(tmpdir(), "delta-cli-coord-")); after(() => rm(workspace, { recursive: true, force: true }));
process.env.LOCALAPPDATA = path.join(workspace, "state"); process.env.XDG_STATE_HOME = path.join(workspace, "state");
const bundle = path.join(workspace, "service.cjs"), cliEntry = path.join(workspace, "cli.cjs");
await Promise.all([
  build({ stdin: { contents: 'export { ApplicationService } from "./src/service/api.ts"; export { startCoordinator } from "./src/service/coordinator.ts";', resolveDir: root, loader: "ts" }, outfile: bundle, bundle: true, platform: "node", target: "node24", format: "cjs", logLevel: "silent" }),
  build({ entryPoints: [path.join(root, "src/cli/main.ts")], outfile: cliEntry, bundle: true, platform: "node", target: "node24", format: "cjs", logLevel: "silent" }),
]);
const { ApplicationService, startCoordinator } = createRequire(import.meta.url)(bundle);
async function fixture(t, options = {}) {
  const directory = await mkdtemp(path.join(workspace, "case-")), configDirectory = path.join(directory, "profile"), source = path.join(directory, "source"), destination = path.join(directory, "backup");
  await mkdir(source); await mkdir(destination); const service = new ApplicationService({ configDirectory, ...options }); await service.ready;
  const task = await service.request({ action: "create", directory: destination, name: "Remote task", sources: [{ path: source }], settings: { detection: "hash", archive: { level: 6 } } });
  const requests = [], coordinator = await startCoordinator(configDirectory, request => { requests.push(request); return service.request(request); });
  t.after(async () => { await coordinator.close(); await service.shutdown(); });
  return { directory, configDirectory, source, destination, service, task, requests, coordinator };
}
function launch(configDirectory, args, options = {}) {
  const child = spawn(process.execPath, [...(options.nodeArguments ?? []), cliEntry, ...args, "--config-dir", configDirectory, "--json"], { cwd: root, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = ""; child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8"); child.stdout.on("data", bytes => { stdout += bytes; }); child.stderr.on("data", bytes => { stderr += bytes; }); child.stdin.end(options.input);
  const timer = setTimeout(() => child.kill(), 15000);
  const completion = new Promise((resolve, reject) => {
    child.once("error", reject); child.once("close", exitCode => { let value; try { value = stdout.trim() ? JSON.parse(stdout) : undefined; } catch (error) { reject(new Error(`CLI produced invalid JSON: ${error.message}`)); return; } resolve({ exitCode, stdout, stderr, value }); });
  }).finally(() => clearTimeout(timer));
  return { child, completion };
}
async function cli(configDirectory, args, options) { return launch(configDirectory, args, options).completion; }
async function until(predicate) { const limit = Date.now() + 5000; while (!predicate()) { if (Date.now() > limit) throw new Error("Timed out waiting for remote CLI state"); await new Promise(resolve => setTimeout(resolve, 10)); } }

test("CLI joins a live ApplicationService for real backup, verify and restore and waits for final results", { timeout: 30000 }, async t => {
  const { directory, configDirectory, source, service, task, requests } = await fixture(t);
  const bootstrap = await service.request({ action: "bootstrap" }); assert.equal(bootstrap.app.value.language, "en"); assert.equal(bootstrap.tasks[0].name, task.value.name);
  await writeFile(path.join(source, "żółć.txt"), "Remote backup 🌍 exact bytes\n");
  const backup = await cli(configDirectory, ["task", "run", task.id]); assert.equal(backup.exitCode, 0, backup.stderr); assert.equal(backup.value.status, "complete"); assert.equal(service.operations.get(backup.value.id)?.status, "complete", "CLI must use the existing service rather than a standalone executor");
  const verified = await cli(configDirectory, ["verify", task.id]); assert.equal(verified.exitCode, 0, verified.stderr); assert.equal(verified.value.status, "complete"); assert(service.operations.has(verified.value.id));
  const output = path.join(directory, "restored"); const restored = await cli(configDirectory, ["restore", task.id, "--to", output]); assert.equal(restored.exitCode, 0, restored.stderr); assert.equal(restored.value.status, "complete"); assert(service.operations.has(restored.value.id));
  assert.equal(await readFile(path.join(output, "żółć.txt"), "utf8"), "Remote backup 🌍 exact bytes\n");
  assert(requests.some(request => request.action === "run" && request.operationId === backup.value.id)); assert(requests.some(request => request.action === "operations"));
});

test("CLI cancels remote queued and running tasks without starting a duplicate executor", { timeout: 30000 }, async t => {
  const started = [];
  const executor = async (request, _progress, signal) => { started.push(path.join(request.directory, ".delta.json")); return new Promise((_resolve, reject) => { signal.addEventListener("abort", () => reject(signal.reason), { once: true }); }); };
  const { directory, configDirectory, source, service, task } = await fixture(t, { executor });
  const secondDirectory = path.join(directory, "second-backup"); await mkdir(secondDirectory);
  const second = await service.request({ action: "create", directory: secondDirectory, name: "Queued target", sources: [{ path: source }] });
  const firstCli = launch(configDirectory, ["task", "run", task.id]);
  await until(() => [...service.operations.values()].some(operation => operation.taskId === task.id && operation.status === "running"));
  const secondCli = launch(configDirectory, ["task", "run", second.id]);
  await until(() => [...service.operations.values()].some(operation => operation.taskId === second.id && operation.status === "queued"));
  const cancelQueued = await cli(configDirectory, ["task", "cancel", second.id]); assert.equal(cancelQueued.exitCode, 0, cancelQueued.stderr); assert.equal(cancelQueued.value.cancellationRequested.length, 1);
  const queued = await secondCli.completion; assert.equal(queued.exitCode, 130, queued.stderr); assert.equal(queued.value.status, "cancelled"); assert.deepEqual(started, [task.id]);
  const cancelRunning = await cli(configDirectory, ["task", "cancel", task.id]); assert.equal(cancelRunning.exitCode, 0, cancelRunning.stderr);
  const running = await firstCli.completion; assert.equal(running.exitCode, 130, running.stderr); assert.equal(running.value.status, "cancelled"); assert.deepEqual(started, [task.id]);
});

test("CLI pauses and resumes the same real coordinator operation and can cancel it while paused", { timeout: 30000 }, async t => {
  let files = 0, starts = 0;
  const executor = async (_request, progress, signal, _provider, control) => { starts++; for (;;) { await control.waitIfPaused(); signal.throwIfAborted(); progress({ phase: "backup", files: ++files, bytes: files * 65536 }); await new Promise(resolve => setTimeout(resolve, 5)); } };
  const { configDirectory, service, task, requests } = await fixture(t, { executor });
  const running = launch(configDirectory, ["task", "run", task.id]); await until(() => files >= 3);
  const paused = await cli(configDirectory, ["task", "pause", task.id]); assert.equal(paused.exitCode, 0, paused.stderr); assert.equal(paused.value.pauseRequested.length, 1);
  const operationId = paused.value.pauseRequested[0]; assert.equal(service.operations.get(operationId).paused, true); const stoppedAt = files; await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(files, stoppedAt);
  const resumed = await cli(configDirectory, ["task", "resume-operation", task.id]); assert.equal(resumed.exitCode, 0, resumed.stderr); assert.deepEqual(resumed.value.resumeRequested, [operationId]); await until(() => files > stoppedAt); assert.equal(starts, 1);
  await cli(configDirectory, ["task", "pause", task.id]); const cancelled = await cli(configDirectory, ["task", "cancel", task.id]); assert.equal(cancelled.exitCode, 0, cancelled.stderr); assert.equal((await running.completion).exitCode, 130);
  assert(requests.some(request => request.action === "pause" && request.operationId === operationId)); assert(requests.some(request => request.action === "resume-operation" && request.operationId === operationId));
});

test("CLI deletion requires an explicit snapshot ID and never infers the latest backup", async t => {
  let executions = 0; const { configDirectory, service, task, requests } = await fixture(t, { executor: async request => { executions++; assert.equal(request.action, "delete"); assert.equal(request.runId, "20261029120000"); return { runId: request.runId, deleted: [`${request.runId}.zip`], bytes: 100 }; } });
  const missing = await cli(configDirectory, ["delete", task.id]); assert.equal(missing.exitCode, 2); assert.match(missing.stderr, /Missing --run/); assert.equal(executions, 0); assert(!requests.some(request => request.action === "history"));
  const deleted = await cli(configDirectory, ["delete", task.id, "--run", "20261029120000"]); assert.equal(deleted.exitCode, 0, deleted.stderr); assert.equal(deleted.value.status, "complete"); assert.equal(executions, 1); assert(service.operations.has(deleted.value.id));
});

test("a live but broken coordinator produces unavailable exit and never falls back to local backup", { timeout: 15000 }, async t => {
  const { configDirectory, destination, service, task, coordinator } = await fixture(t);
  const infoPath = path.join(runtimeDirectory(configDirectory), "coordinator.json"), original = JSON.parse(await readFile(infoPath, "utf8"));
  await coordinator.close();
  await writeFile(infoPath, JSON.stringify(original), { mode: 0o600 });
  const result = await cli(configDirectory, ["task", "run", task.id]); assert.equal(result.exitCode, 3, result.stderr); assert.equal(result.stdout, ""); assert.match(result.stderr, /no local fallback|channel is unavailable/);
  assert.equal(service.operations.size, 0); assert.deepEqual((await readdir(destination)).sort(), [".delta.json"]);
});

test("an injected CLI SIGINT event during delayed task preparation withdraws its future remote operation", { timeout: 30000 }, async t => {
  let releasePreparation, enteredPreparation, starts = 0;
  const preparationEntered = new Promise(resolve => { enteredPreparation = resolve; }), gate = new Promise(resolve => { releasePreparation = resolve; });
  const { directory, configDirectory, destination, service, task, requests } = await fixture(t, { executor: async () => { starts++; return { status: "complete" }; } });
  const resolveTask = service.resolveTask.bind(service); service.resolveTask = async reference => { enteredPreparation(); await gate; return resolveTask(reference); };
  const trigger = path.join(directory, "inject-sigint"), preload = path.join(directory, "inject-sigint.cjs");
  await writeFile(preload, `const fs=require('node:fs');const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(trigger)})){clearInterval(timer);process.emit('SIGINT');}},10);timer.unref();`);
  const running = launch(configDirectory, ["task", "run", task.id], { nodeArguments: ["--require", preload] });
  await Promise.race([preparationEntered, running.completion.then(result => { throw new Error(`CLI exited (${result.exitCode}) before reaching the coordinator task preparation; rebuild the CLI before running this test.`); })]);
  await writeFile(trigger, "trigger");
  await until(() => requests.some(request => request.action === "cancel"));
  const requested = requests.find(request => request.action === "run"), cancellation = requests.find(request => request.action === "cancel"); assert.equal(cancellation.operationId, requested.operationId);
  releasePreparation(); const result = await running.completion;
  assert.equal(result.exitCode, 130, result.stderr); assert.equal(result.value.status, "cancelled"); assert.equal(starts, 0);
  assert.deepEqual((await readdir(destination)).sort(), [".delta.json"]);
});
