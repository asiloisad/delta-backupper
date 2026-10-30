import assert from "node:assert/strict";
import { test, after } from "node:test";
import { build } from "esbuild";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, writeFile, rename, unlink, readdir, rm, rmdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const workspace = await mkdtemp(path.join(tmpdir(), "delta-user-styles-")); after(() => rm(workspace, { recursive: true, force: true }));
const bundle = path.join(workspace, "user-styles.cjs"); await build({ entryPoints: ["src/platform/user-styles.ts"], outfile: bundle, bundle: true, platform: "node", target: "node24", format: "cjs", logLevel: "silent" });
const { startUserStyles } = createRequire(import.meta.url)(bundle);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) { const end = Date.now() + 4000; while (!predicate()) { if (Date.now() > end) throw new Error("Timed out waiting for live user CSS"); await delay(15); } }
async function fixture(t, initial) {
  const directory = await mkdtemp(path.join(workspace, "profile-")), filename = path.join(directory, "styles.css"), updates = [], errors = [];
  if (initial !== undefined) await writeFile(filename, initial);
  const watcher = await startUserStyles({ directory, onStyles: css => { updates.push(css); }, onError: error => { errors.push(error); } }); t.after(() => watcher.close());
  return { directory, filename, updates, errors, watcher };
}

test("first launch creates only a commented styles.css template without executable startup files", async t => {
  const { directory, filename, updates, errors } = await fixture(t);
  assert.deepEqual(await readdir(directory), ["styles.css"]); const css = await readFile(filename, "utf8");
  assert(css.startsWith("/* Delta Backupper")); assert.equal(updates.at(-1), css); assert.equal(errors.length, 0);
});

test("existing Unicode CSS is preserved and normal saves apply without reload", async t => {
  const initial = '/* żółć 密碼 🌍 */\n:root { --accent: #abcdef; }'; const { filename, updates, errors } = await fixture(t, initial);
  assert.equal(await readFile(filename, "utf8"), initial); assert.deepEqual(updates, [initial]);
  const updated = ':root { --accent: #123456; }'; await writeFile(filename, updated); await until(() => updates.at(-1) === updated); assert.equal(errors.length, 0);
});

test("atomic replacement and subsequent replacement stay attached to the configured filename", async t => {
  const { directory, filename, updates } = await fixture(t, "body { color: red; }");
  for (const color of ["green", "blue"]) { const temporary = path.join(directory, "styles.css.atomic-save"), css = `body { color: ${color}; }`; await writeFile(temporary, css); await rename(temporary, filename); await until(() => updates.at(-1) === css); }
});

test("deletion removes user overrides and recreation is observed", async t => {
  const { filename, updates } = await fixture(t, "body { color: red; }");
  await unlink(filename); await until(() => updates.at(-1) === "");
  const recreated = "body { color: green; }"; await writeFile(filename, recreated); await until(() => updates.at(-1) === recreated);
});

test("malformed UTF-8 and oversized files retain the last good CSS and recover after correction", async t => {
  const valid = "body { background: #abcdef; }", { filename, updates, errors } = await fixture(t, valid);
  await writeFile(filename, Buffer.from([0xc3, 0x28])); await until(() => errors.some(error => /UTF-8/.test(error.message))); assert.equal(updates.at(-1), valid);
  await writeFile(filename, Buffer.alloc(1024 ** 2 + 1, 65)); await until(() => errors.some(error => /1 MiB/.test(error.message))); assert.equal(updates.at(-1), valid);
  const fixed = "body { background: #123456; }"; await writeFile(filename, fixed); await until(() => updates.at(-1) === fixed);
});

test("a non-regular replacement preserves the last good CSS without opening a directory", async t => {
  const valid = "body { color: red; }", { directory, filename, updates, errors } = await fixture(t, valid);
  const original = path.join(directory, "old-styles.css"); await rename(filename, original); await mkdir(filename);
  await until(() => errors.some(error => /ordinary file/.test(error.message))); assert.equal(updates.at(-1), valid);
  await rmdir(filename); await rename(original, filename); await writeFile(filename, "body { color: blue; }"); await until(() => updates.at(-1) === "body { color: blue; }");
});

test("symlink and junction replacements are rejected without following their targets", async t => {
  const valid = "body { color: red; }", { directory, filename, updates, errors } = await fixture(t, valid);
  await rename(filename, path.join(directory, "original.css")); const target = path.join(directory, "link-target"); await mkdir(target);
  try { await symlink(target, filename, process.platform === "win32" ? "junction" : "dir"); }
  catch (error) { if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) { t.skip("Host does not permit a controlled test link"); return; } throw error; }
  await until(() => errors.some(error => /ordinary file/.test(error.message))); assert.equal(updates.at(-1), valid);
});

test("explicit reload deduplicates unchanged CSS and closing stops watch and poll callbacks", async t => {
  const { filename, updates, watcher } = await fixture(t, "body { color: red; }"); await watcher.reload(); assert.equal(updates.length, 1);
  watcher.close(); watcher.close(); const count = updates.length; await writeFile(filename, "body { color: green; }"); await watcher.reload(); await delay(900); assert.equal(updates.length, count);
});

test("a rejected consumer callback can recover without changing the same saved file", async t => {
  const directory = await mkdtemp(path.join(workspace, "consumer-")), filename = path.join(directory, "styles.css"), errors = [], applied = [];
  await writeFile(filename, "body { color: red; }"); let rejectNext = false;
  const watcher = await startUserStyles({ directory, onError: error => errors.push(error), async onStyles(css) { if (rejectNext) { rejectNext = false; throw new Error("Controlled insertCSS failure"); } applied.push(css); } }); t.after(() => watcher.close());
  rejectNext = true; await writeFile(filename, "body { color: blue; }"); await until(() => errors.length > 0); assert.equal(applied.at(-1), "body { color: red; }");
  await until(() => applied.at(-1) === "body { color: blue; }");
});
