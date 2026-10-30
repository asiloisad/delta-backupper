import assert from "node:assert/strict";
import { test, after } from "node:test";
import { build } from "esbuild";
import { mkdtemp, mkdir, readFile, writeFile, rename, rm, symlink, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = await mkdtemp(path.join(tmpdir(), "delta-task-location-"));
after(() => rm(root, { recursive: true, force: true }));
const bundle = path.join(root, "locations.mjs");
await build({ stdin: { contents: 'export { ConfigurationStore } from "./src/config/index.ts"; export { openTaskLocation } from "./src/platform/task-locations.ts"; export { openExternalTextFile } from "./src/platform/external-text-editor.ts";', resolveDir: process.cwd() }, outfile: bundle, bundle: true, platform: "node", target: "node24", format: "esm", logLevel: "silent" });
const { ConfigurationStore, openTaskLocation, openExternalTextFile } = await import(pathToFileURL(bundle).href);
async function fixture() {
  const directory = await mkdtemp(path.join(root, "backup żółć & ")), store = new ConfigurationStore({ configDirectory: path.join(directory, "profile") }); await store.initialize();
  const destination = path.join(directory, "task"); await mkdir(destination);
  const task = await store.createTask({ directory: destination, name: "Files", sources: [{ path: "../source" }] });
  const calls = [], launchers = { async textFile(filename) { calls.push(["file", filename]); }, async folder(filename) { calls.push(["folder", filename]); return ""; } };
  return { store, destination, task, calls, launchers };
}

test("shortcuts use the original remembered task paths without changing configuration", async () => {
  const f = await fixture(), filename = path.join(f.destination, ".delta.json"), before = await readFile(filename);
  await openTaskLocation(f.store, f.task.id, "file", f.launchers); await openTaskLocation(f.store, f.task.id, "folder", f.launchers);
  const canonical = await realpath(f.destination); assert.deepEqual(f.calls, [["file", path.join(canonical, ".delta.json")], ["folder", canonical]]); assert.deepEqual(await readFile(filename), before);
});
test("malformed task JSON can be opened for repair; folder does not require the task file", async () => {
  const f = await fixture(), filename = path.join(f.destination, ".delta.json"); await writeFile(filename, "{ unfinished");
  assert.equal((await f.store.listTasks())[0].available, false);
  await openTaskLocation(f.store, filename, "file", f.launchers); assert.equal(await readFile(filename, "utf8"), "{ unfinished");
  await rm(filename); await openTaskLocation(f.store, filename, "folder", f.launchers); await assert.rejects(openTaskLocation(f.store, filename, "file", f.launchers), /unavailable/);
  assert.equal(f.calls.length, 2);
});
test("offline destinations never launch a program or recreate missing folders", async () => {
  const f = await fixture(), offline = `${f.destination}-offline`; await rename(f.destination, offline);
  await assert.rejects(openTaskLocation(f.store, path.join(f.destination, ".delta.json"), "folder", f.launchers), /unavailable/); await assert.rejects(readFile(path.join(f.destination, ".delta.json")), { code: "ENOENT" });
  assert.deepEqual(f.calls, []);
});
test("unremembered paths, symlink task files and system launch failures are rejected", async () => {
  const f = await fixture();
  for (const reference of [`${f.destination}-unremembered`, "../.delta", null, "99999999-9999-4999-8999-999999999999"]) await assert.rejects(openTaskLocation(f.store, reference, "file", f.launchers));
  const filename = path.join(f.destination, ".delta.json"); await rename(filename, `${filename}.original`); await symlink(`${filename}.original`, filename);
  await assert.rejects(openTaskLocation(f.store, filename, "file", f.launchers), /ordinary file/); assert.deepEqual(f.calls, []);
  await assert.rejects(openTaskLocation(f.store, filename, "folder", { ...f.launchers, async folder() { return "No file manager available"; } }), /No file manager available/);
});
test("external file launch uses the OS association for the unchanged original task JSON", async () => {
  const filename = path.join(root, 'space żółć & quote\u0027 .delta'), before = '{ "original": true }\n', calls = [];
  await writeFile(filename, before);
  await openExternalTextFile(filename, async original => { calls.push(original); return ""; });
  assert.deepEqual(calls, [filename]);
  assert.equal(await readFile(filename, "utf8"), before);
});
test("external file launch surfaces OS failures and rejects invalid paths before calling the OS", async () => {
  const filename = path.join(root, ".delta.json");
  await assert.rejects(openExternalTextFile(filename, async () => "No application is associated with this file type"), /No application is associated/);
  await assert.rejects(openExternalTextFile(filename, async () => { throw new Error("OS launcher unavailable"); }), /OS launcher unavailable/);
  const calls = [];
  for (const invalid of [".delta.json", `${filename}\0`]) await assert.rejects(openExternalTextFile(invalid, async value => { calls.push(value); return ""; }), /must be absolute/);
  assert.deepEqual(calls, []);
});
