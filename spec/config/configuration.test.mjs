import assert from "node:assert/strict";
import { test, after } from "node:test";
import { build } from "esbuild";
import { mkdtemp as nativeMkdtemp, mkdir, readFile, writeFile, rename, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import nativePath from "node:path";
import { pathToFileURL } from "node:url";
import { portablePath } from "../../src/domain/source-identity.mjs";
import { sequenceToString } from "../../src/config/sequence.mjs";

const path = { ...nativePath, join: (...parts) => portablePath(nativePath.join(...parts)), resolve: (...parts) => portablePath(nativePath.resolve(...parts)) };
const mkdtemp = async prefix => portablePath(await nativeMkdtemp(prefix));


function onDisk(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  value = { ...value, ...(value.sequence && typeof value.sequence === 'object' ? { sequence: sequenceToString(value.sequence) } : {}), ...(value.task ? { task: onDisk(value.task) } : {}) };
  if (!['wdir','proj','srcs'].some(key=>Object.hasOwn(value,key))) return value;
  const {sources,...result}=value;
  if(sources) {
    result.srcs=sources.map(source=>value.srcs?.find(item=>(typeof item==='string'?item:item[0])===source.path)??source.path);
    const filters=Object.fromEntries(sources.filter(source=>source.filters?.include?.length||source.filters?.exclude?.length).map(source=>[source.path,source.filters]));
    if(Object.keys(filters).length)result.filters=filters;else delete result.filters;
  }
  const names={wdir:'workingDirectory',proj:'backupDirectory',srcs:'sources',mode:'pathMode',filters:'sourceFilters',hist:'history',data:'files'};
  return Object.fromEntries(Object.entries(result).map(([key,child])=>[names[key]??key,child]));
}
const json=value=>JSON.stringify(onDisk(value));

const workspace = await mkdtemp(path.join(tmpdir(), "delta-config-"));
after(async () => { await rm(workspace, { recursive: true, force: true }); });
const bundle = path.join(workspace, "configuration.mjs");
await build({ entryPoints: ["src/config/index.ts"], outfile: bundle, bundle: true, platform: "node", target: "node24", format: "esm", logLevel: "silent" });
const { ConfigurationStore, ConfigurationConflictError, DestinationUnavailableError, ConfigurationError, materializeSettings, materializeTask, materializeRegistry, materializeDefaults, builtInTaskDefaults } = await import(pathToFileURL(bundle).href);
async function fixture() {
  const root = await mkdtemp(path.join(workspace, "case-"));
  const store = new ConfigurationStore({ homeDirectory: root });
  const directory = path.join(root, "backup żółć"); await mkdir(directory);
  return { root, store, directory, create: (options = {}) => store.createTask({ directory, name: "Dokumenty", sources: [{ path: "../źródło" }], ...options }) };
}

test("global directory is ~/.delta and reads do not materialize files", async () => {
  const { root, store } = await fixture();
  assert.equal(store.directory, path.join(root, ".delta"));
  assert.equal((await store.readApp()).revision, null);
  assert.equal((await store.readDefaults()).value.settings.detection, "fast");
  assert(!Object.hasOwn((await store.readDefaults()).value.settings, "sources"));
  assert(!Object.hasOwn((await store.readDefaults()).value.settings, "filters"));
  assert.equal((await readdir(root)).includes(".delta"), false);
  await store.initialize();
  assert.deepEqual((await readdir(store.directory)).sort(), ["config.json", "tasks.json"]);
  assert.deepEqual(JSON.parse(await readFile(path.join(store.directory, "tasks.json"), "utf8")), []);
  assert(!Object.hasOwn(JSON.parse(await readFile(path.join(store.directory, "config.json"), "utf8")).task, "sources"));
  assert(!Object.hasOwn(JSON.parse(await readFile(path.join(store.directory, "config.json"), "utf8")).task, "filters"));
  const initial = await readFile(path.join(store.directory, "config.json"), "utf8");
  await store.initialize(); assert.equal(await readFile(path.join(store.directory, "config.json"), "utf8"), initial);
});

test("compression is configured by a single integer level from zero through nine", () => {
  assert.deepEqual(materializeSettings().archive, { level: 6 });
  for (let level = 0; level <= 9; level++) assert.deepEqual(materializeSettings({ archive: { level } }).archive, { level });
  for (const level of [-1, 10, 1.5, "6", null]) assert.throws(() => materializeSettings({ archive: { level } }), /archive.level: expected an integer in 0..9/);
  assert.throws(() => materializeSettings({ archive: { compression: "store" } }), /archive.compression: unknown field/);
});

test("English-only preferences fill current defaults without rewriting a partial configuration on read", async () => {
  const { store } = await fixture(); assert.equal((await store.readApp()).value.language, "en");
  await store.initialize(); const filename = path.join(store.directory, "config.json");
  const partial = json({ schemaVersion: 1, application: { theme: "dark", closeToTray: false, notifications: false, maxConcurrentTasks: 3 } });
  await writeFile(filename, partial);
  const loaded = await store.readApp(); assert.equal(loaded.value.language, "en"); assert.equal(loaded.value.theme, "dark"); assert.equal(loaded.value.closeToTray, false); assert.equal(loaded.value.notifications, false); assert.equal(loaded.value.maxConcurrentTasks, 3);
  assert.equal(await readFile(filename, "utf8"), partial, "reading partial preferences must not overwrite the user's file");
  await store.saveApp(loaded.value, loaded.revision); const saved = JSON.parse(await readFile(filename, "utf8")).application; assert.equal(saved.language, "en"); assert.equal(saved.closeToTray, false);
});

test("unknown language values are rejected and never replace the current preferences", async () => {
  const { store } = await fixture(); await store.initialize(); const filename = path.join(store.directory, "config.json"), before = await readFile(filename, "utf8"), document = await store.readApp();
  for (const language of ["pl", "de", "en-US", "EN", "", null, true]) {
    await assert.rejects(store.saveApp({ ...document.value, language }, document.revision), ConfigurationError);
    assert.equal(await readFile(filename, "utf8"), before);
  }
  const invalid = json({ schemaVersion: 1, application: { language: "pl" } }); await writeFile(filename, invalid);
  await assert.rejects(store.readApp(), ConfigurationError); await assert.rejects(store.initialize(), ConfigurationError); assert.equal(await readFile(filename, "utf8"), invalid);
});

test("One is the default theme family and family selection is independent of system color mode", async () => {
  const { store } = await fixture();
  assert.equal((await store.readApp()).value.themeFamily, "one"); assert.equal((await store.readApp()).value.theme, "system");
  await store.initialize(); const filename = path.join(store.directory, "config.json");
  const partial = json({ application: { themeFamily: "aura", theme: "system", notifications: false } }); await writeFile(filename, partial);
  let document = await store.readApp(); assert.equal(document.value.themeFamily, "aura"); assert.equal(document.value.theme, "system"); assert.equal(await readFile(filename, "utf8"), partial);
  for (const themeFamily of ["one", "aura"]) for (const theme of ["light", "dark", "system"]) {
    document = await store.saveApp({ ...document.value, themeFamily, theme }, document.revision);
    const loaded = await store.readApp(); assert.equal(loaded.value.themeFamily, themeFamily); assert.equal(loaded.value.theme, theme); assert.equal(loaded.value.notifications, false);
  }
  const before = await readFile(filename, "utf8");
  for (const themeFamily of ["One", "aura-night", "light", "", null, true, { family: "aura" }]) {
    await assert.rejects(store.saveApp({ ...document.value, themeFamily }, document.revision), ConfigurationError); assert.equal(await readFile(filename, "utf8"), before);
  }
});

test("release checking is opt-in and partial update settings preserve explicit choices", async () => {
  const { store } = await fixture();
  assert.deepEqual((await store.readApp()).value.updates, { repository: "", checkOnStartup: false, includePrereleases: false });
  await store.initialize(); const filename = path.join(store.directory, "config.json");
  const partial = json({ schemaVersion: 1, application: { updates: { repository: "example/delta", includePrereleases: true } } });
  await writeFile(filename, partial);
  const loaded = await store.readApp();
  assert.deepEqual(loaded.value.updates, { repository: "example/delta", checkOnStartup: false, includePrereleases: true });
  assert.equal(await readFile(filename, "utf8"), partial, "reading defaults must not rewrite the profile");
  const saved = await store.saveApp({ ...loaded.value, updates: { ...loaded.value.updates, checkOnStartup: true } }, loaded.revision);
  assert.deepEqual(JSON.parse(await readFile(filename, "utf8")).application.updates, saved.value.updates);
  const before = await readFile(filename, "utf8");
  for (const updates of [{ repository: "https://github.com/example/delta" }, { repository: "example/delta/extra" }, { repository: "../delta" }, { repository: " example/delta" }, { repository: "example/delta?token=secret" }, { checkOnStartup: "yes" }, { includePrereleases: null }, { token: "SECRET" }]) {
    await assert.rejects(store.saveApp({ ...saved.value, updates }, saved.revision), ConfigurationError);
    assert.equal(await readFile(filename, "utf8"), before, "invalid update preferences must not replace the current file");
  }
});

test("task creation writes complete settings and a simple hist/data catalog without identity fields", async () => {
  const { store, directory, create } = await fixture();
  const task = await create();
  const disk = JSON.parse(await readFile(path.join(directory, ".delta.json"), "utf8"));
  assert.deepEqual(onDisk(task.value), Object.fromEntries(Object.entries(disk).filter(([key])=>!["history","files"].includes(key)))); assert.deepEqual(disk.history, []); assert.deepEqual(disk.files, {});
  for (const field of ["schemaVersion", "id", "destination", "hist", "data", "srcs", "wdir", "proj", "mode"]) assert(!Object.hasOwn(disk,field)); assert.deepEqual(disk.sources, ["../źródło"]); assert.equal(disk.workingDirectory,directory); assert.equal(disk.backupDirectory,directory); assert.equal(disk.pathMode,0);
  assert(!Object.hasOwn(disk, "filters"));
  assert.deepEqual(disk.schedules, []); assert.equal(disk.sequence, "F");
  assert(!Object.hasOwn(disk, "createdAt")); assert(!Object.hasOwn(disk, "updatedAt")); assert.deepEqual(disk.behavior, { continueOnFileError: true, retryCount: 0, resume: true });
  assert.deepEqual(disk.retention, { when: "after", keepCycles: 0, maxAgeDays: 0, protectPinned: true });
  assert.deepEqual(disk.archive, { level: 6 });
  assert.deepEqual(disk.snapshot, { mode: "off", fallback: "fail", lvmCowSizeBytes: 8 * 1024 ** 3 });
  assert.equal(disk.symlinks, "follow"); assert(!Object.hasOwn(disk, "encryption"));
  const registry = (await store.readRegistry()).value;
  assert.deepEqual(registry, [directory]);
});

test("task creation preserves each ZIP path mode through persistence and reload", async () => {
  for (const mode of [0, 1, 2]) {
    const { store, directory, create } = await fixture();
    const created = await create({ settings: { mode } });
    assert.equal(created.value.mode, mode);
    const filename = path.join(directory, ".delta.json"), disk = JSON.parse(await readFile(filename, "utf8"));
    assert.equal(disk.pathMode, mode); assert(!Object.hasOwn(disk, "mode"));
    const reloaded = await store.loadTask(directory); assert.equal(reloaded.value.mode, mode); assert.deepEqual(reloaded.value, created.value);
  }
});

test("task defaults share working directory and ZIP path mode with new and saved task settings", async () => {
  const { root, store, directory, create } = await fixture();
  await store.initialize();
  const defaults = await store.readDefaults(); assert.equal(defaults.value.settings.wdir, ""); assert.equal(defaults.value.settings.mode, 0);
  const saved = await store.saveDefaults({ ...defaults.value, settings: { ...defaults.value.settings, wdir: root, mode: 2 } }, defaults.revision);
  assert.equal(saved.value.settings.wdir, root); assert.equal(saved.value.settings.mode, 2);
  const global = JSON.parse(await readFile(path.join(store.directory, "config.json"), "utf8"));
  assert.equal(global.task.workingDirectory, root); assert.equal(global.task.pathMode, 2);
  for (const field of ["wdir", "mode", "sources", "sourceFilters", "filters"]) assert(!Object.hasOwn(global.task, field));
  assert.deepEqual((await store.readDefaults()).value, saved.value);
  const task = await create(); assert.equal(task.value.wdir, root); assert.equal(task.value.mode, 2);
  const disk = JSON.parse(await readFile(path.join(directory, ".delta.json"), "utf8"));
  assert.equal(disk.workingDirectory, root); assert.equal(disk.pathMode, 2);
  const changed = await store.saveTask(task, { wdir: directory, mode: 1 });
  assert.equal(changed.value.wdir, directory); assert.equal(changed.value.mode, 1); assert.deepEqual((await store.readDefaults()).value, saved.value);
  const overrideDirectory = path.join(root, "overridden"); await mkdir(overrideDirectory);
  const override = await store.createTask({ directory: overrideDirectory, name: "Override", settings: { wdir: "", mode: 0 } });
  assert.equal(override.value.wdir, overrideDirectory); assert.equal(override.value.mode, 0);
  const reloaded = await store.loadTask(overrideDirectory); assert.equal(reloaded.value.wdir, overrideDirectory); assert.equal(reloaded.value.mode, 0);
});

test("missing local path settings inherit current defaults while explicit empty working directories use the task directory", async () => {
  const { root, store, directory } = await fixture(); await store.initialize();
  const defaults = await store.readDefaults(); await store.saveDefaults({ ...defaults.value, settings: { ...defaults.value.settings, wdir: root, mode: 1 } }, defaults.revision);
  const filename = path.join(directory, ".delta.json"), partial = { name: "Partial", sources: ["relative-source"], history: [], files: {} };
  const original = JSON.stringify(partial); await writeFile(filename, original);
  const loaded = await store.loadTask(directory); assert.equal(loaded.value.wdir, root); assert.equal(loaded.value.mode, 1); assert.equal(await readFile(filename, "utf8"), original);
  await writeFile(filename, JSON.stringify({ ...partial, workingDirectory: "", pathMode: 0 }));
  const empty = await store.loadTask(directory); assert.equal(empty.value.wdir, directory); assert.equal(empty.value.mode, 0);
  const saved = await store.saveTask(empty, { name: "Materialized" });
  assert.equal(saved.value.wdir, directory); assert.equal(JSON.parse(await readFile(filename, "utf8")).workingDirectory, directory);
});

test("global path defaults reject invalid values and abbreviated on-disk aliases without rewriting", async () => {
  const { root, store } = await fixture(); await store.initialize(); const defaults = await store.readDefaults(), filename = path.join(store.directory, "config.json"), original = await readFile(filename, "utf8");
  for (const settings of [{ wdir: null }, { wdir: 12 }, { mode: 3 }, { mode: "1" }]) {
    await assert.rejects(store.saveDefaults({ schemaVersion: 1, settings }, defaults.revision), ConfigurationError); assert.equal(await readFile(filename, "utf8"), original);
  }
  for (const task of [{ wdir: root }, { mode: 1 }]) {
    const bytes = JSON.stringify({ schemaVersion: 1, task }); await writeFile(filename, bytes);
    await assert.rejects(store.readDefaults(), /config.task.(?:wdir|mode): unknown field/); assert.equal(await readFile(filename, "utf8"), bytes);
  }
});

test("invalid ZIP path modes reject task creation without writing configuration", async () => {
  for (const mode of [-1, 3, "0", null, true]) {
    const { store, directory, create } = await fixture();
    await assert.rejects(create({ settings: { mode } }), /task\.mode: expected one of 0, 1, 2/);
    assert.deepEqual(await readdir(directory), []); assert.deepEqual((await store.readRegistry()).value, []);
  }
});

test("saved task settings can change sources, ZIP path mode, detection and working directory", async () => {
  const { root, store, directory, create } = await fixture();
  const task = await create(), next = await store.saveTask(task, { sources: [{ path: "documents", filters: { include: ["*.txt"] } }, { path: "photos" }], mode: 2, detection: "hash", wdir: root, srcs: [["documents", "**/*.txt", "private/.*"], "photos"] });
  assert.equal(next.value.mode, 2); assert.equal(next.value.detection, "hash"); assert.equal(next.value.wdir, root); assert.deepEqual(next.value.srcs, [["documents", "**/*.txt", "private/.*"], "photos"]);
  assert.deepEqual(next.value.sources.map(source => source.path), ["documents", "photos"]); assert.deepEqual(next.value.sources[0].filters, { include: ["*.txt"], exclude: [] });
  assert.deepEqual((await store.loadTask(directory)).value, next.value);
});

test("portable paths normalize Windows separators without changing POSIX filename characters", () => {
  const input = String.raw`folder\żółć😀`;
  assert.equal(portablePath(input), process.platform === "win32" ? "folder/żółć😀" : input);
  const task = materializeTask({ srcs: [[input, String.raw`**\*.txt`, String.raw`private/\d+\.txt`]], filters: { [input]: { include: [String.raw`**\*.txt`], exclude: [String.raw`cache\**`] } } });
  assert.deepEqual(task.srcs, [[portablePath(input), "**/*.txt", String.raw`private/\d+\.txt`]]); assert.deepEqual(task.sources[0].filters, { include: ["**/*.txt"], exclude: ["cache/**"] });
});

test("Windows task paths and filters use forward slashes while regex escapes remain exact", { skip: process.platform !== "win32" }, async () => {
  const { root, directory, store } = await fixture(), native = value => value.replaceAll("/", "\\");
  const source = String.raw`folder\żółć😀`, glob = String.raw`**\*.txt`, regex = String.raw`private/\d+\.txt`, filters = { include: [String.raw`**\*.txt`], exclude: [String.raw`cache\**`] }, expectedFilters = { include: ["**/*.txt"], exclude: ["cache/**"] };
  const task = await store.createTask({ directory: native(directory), name: "Zażółć 😀", sources: [{ path: source, filters }], settings: { wdir: native(root), srcs: [[source, glob, regex]], mode: 1 } });
  assert.equal(task.directory, directory); assert.equal(task.id, path.join(directory, ".delta.json")); assert.equal(task.value.wdir, root); assert.equal(task.value.proj, directory); assert.deepEqual(task.value.srcs, [["folder/żółć😀", "**/*.txt", regex]]); assert.deepEqual(task.value.sources, [{ path: "folder/żółć😀", filters: expectedFilters }]);
  const filename = path.join(directory, ".delta.json"), disk = JSON.parse(await readFile(filename, "utf8"));
  assert.equal(disk.workingDirectory, root); assert.equal(disk.backupDirectory, directory); assert.deepEqual(disk.sources, [["folder/żółć😀", "**/*.txt", regex]]); assert.deepEqual(disk.sourceFilters, { "folder/żółć😀": expectedFilters });
  assert.deepEqual((await store.loadTask(native(directory))).value, task.value); assert.deepEqual(JSON.parse(await readFile(path.join(store.directory, "tasks.json"), "utf8")), [directory]);
  await store.rememberTask(await store.loadTask(native(directory))); assert.deepEqual((await store.readRegistry()).value, [directory]);
  assert.throws(() => materializeRegistry([directory, native(directory).toUpperCase()]), /duplicate task directory/);
  assert.throws(() => materializeSettings({ sources: [{ path: source }, { path: "folder/żółć😀" }] }), /duplicate source path/);
});

test("global task defaults reject sources and filters while local tasks retain both independently", async () => {
  const { root, store, directory, create } = await fixture(); await store.initialize(); const task = await create(), defaults = await store.readDefaults();
  const filename = path.join(store.directory, "config.json"), original = await readFile(filename);
  for (const sources of [[], [{ path: "../global-source" }]]) {
    assert.throws(() => materializeDefaults({ settings: { sources } }), /task-defaults\.settings\.sources: unknown field/);
    assert.throws(() => materializeSettings({}, { sources }), /defaults\.sources: unknown field/);
    await assert.rejects(store.saveDefaults({ ...defaults.value, settings: { ...defaults.value.settings, sources } }, defaults.revision), /sources: unknown field/);
    assert.deepEqual(await readFile(filename), original);
  }
  for (const filters of [{}, { include: [], exclude: [] }, { exclude: ["node_modules/**"] }]) {
    assert.throws(() => materializeDefaults({ settings: { filters } }), /task-defaults\.settings\.filters: unknown field/);
    assert.throws(() => materializeSettings({}, { filters }), /defaults\.filters: unknown field/);
    await assert.rejects(store.saveDefaults({ ...defaults.value, settings: { ...defaults.value.settings, filters } }, defaults.revision), /filters: unknown field/);
    assert.deepEqual(await readFile(filename), original);
  }
  const updated = await store.saveDefaults({ schemaVersion: 1, settings: { archive: { level: 0 }, behavior: { retryCount: 3 } } }, defaults.revision);
  assert(!Object.hasOwn(updated.value.settings, "sources")); assert(!Object.hasOwn(updated.value.settings, "filters")); assert.deepEqual((await store.loadTask(directory)).value.sources, task.value.sources);
  const secondDirectory = path.join(root, "own-sources"); await mkdir(secondDirectory);
  const second = await store.createTask({ directory: secondDirectory, name: "Local", sources: [{ path: "../local-documents", filters: { include: ["*.txt"], exclude: ["node_modules/**"] } }, { path: "../local-photos", filters: { include: ["*.jpg"] } }] });
  assert.deepEqual(second.value.sources.map(source => source.path), ["../local-documents", "../local-photos"]); assert.deepEqual(second.value.sources.map(source => source.filters), [{ include: ["*.txt"], exclude: ["node_modules/**"] }, { include: ["*.jpg"], exclude: [] }]); assert.equal(second.value.archive.level, 0); assert.equal(second.value.behavior.retryCount, 3);
  assert.deepEqual((await store.loadTask(secondDirectory)).value.sources, second.value.sources); assert.deepEqual((await store.loadTask(directory)).value.sources, task.value.sources);
  assert(!Object.hasOwn(builtInTaskDefaults().settings, "sources")); assert(!Object.hasOwn(builtInTaskDefaults().settings, "filters")); assert.deepEqual(materializeSettings().sources, []); assert(!Object.hasOwn(materializeSettings(), "filters"));
  const partial = { ...second.value }; delete partial.sources; delete partial.srcs; const bytes = json(partial); await writeFile(path.join(secondDirectory, ".delta.json"), bytes);
  const loaded = await store.loadTask(secondDirectory); assert.deepEqual(loaded.value.sources, []); assert(!Object.hasOwn(loaded.value, "filters")); assert.equal(await readFile(path.join(secondDirectory, ".delta.json"), "utf8"), bytes);
});

test("source filters materialize independently and editing or duplicating a task preserves each source rule", async () => {
  const { root, store, create, directory } = await fixture(); let task = await create({ sources: [{ path: "../documents", filters: { include: ["*.txt"], exclude: ["temp/**"] } }, { path: "../photos", filters: { include: ["*.jpg"] } }] });
  const saved = structuredClone(task.value.sources);
  task = await store.saveTask(task, { sources: task.value.sources.map((source, index) => index === 0 ? { ...source, filters: { include: [], exclude: ["private/**"] } } : source) });
  assert.deepEqual(task.value.sources.map(source => source.path), saved.map(source => source.path)); assert.deepEqual(task.value.sources[0].filters, { include: [], exclude: ["private/**"] }); assert.deepEqual(task.value.sources[1].filters, saved[1].filters);
  const copyDirectory = path.join(root, "duplicate"); await mkdir(copyDirectory); const copy = await store.duplicateTask(task, { directory: copyDirectory });
  assert.deepEqual(copy.value.sources, task.value.sources); assert.notEqual(copy.directory, task.directory); assert(copy.value.sources.every(source => !Object.hasOwn(source, "id")));
  const partial = { ...task.value, sources: task.value.sources.map((source, index) => { const { filters, ...rest } = source; return index === 0 ? { ...rest, filters: { exclude: [] } } : rest; }) };
  const bytes = json(partial); await writeFile(path.join(directory, ".delta.json"), bytes); const loaded = await store.loadTask(directory);
  assert.deepEqual(loaded.value.sources.map(source => source.filters), [{ include: [], exclude: [] }, { include: [], exclude: [] }]); assert.equal(await readFile(path.join(directory, ".delta.json"), "utf8"), bytes);
  loaded.value.sources[0].filters.include.push("*.md"); assert.deepEqual(loaded.value.sources[1].filters.include, [], "default filter arrays must not be shared between sources");
});

test("invalid source filter values reject without changing task files", async () => {
  const { store, create, directory } = await fixture(); const task = await create(), filename = path.join(directory, ".delta.json"), before = await readFile(filename);
  for (const filters of [null, [], { include: null }, { exclude: 0 }, { unknown: true }, { include: ["bad\0pattern"] }]) await assert.rejects(store.saveTask(task, { sources: [{ ...task.value.sources[0], filters }] }), ConfigurationError);
  for (const filters of [null, [], { include: [] }, { "../source": { include: null } }]) assert.throws(() => materializeTask({ ...task.value, filters }), ConfigurationError);
  assert.deepEqual(await readFile(filename), before);
});

test("obsolete sources and filters in task defaults are rejected on read without rewriting or migration", async () => {
  const { store } = await fixture(); await store.initialize(); const filename = path.join(store.directory, "config.json");
  for (const settings of [{ sources: [] }, { filters: { include: [], exclude: [] } }]) {
    const bytes = json({ schemaVersion: 1, task: settings }); await writeFile(filename, bytes);
    await assert.rejects(store.readDefaults(), /(?:sources|filters): unknown field/); await assert.rejects(store.initialize(), /(?:sources|filters): unknown field/); assert.equal(await readFile(filename, "utf8"), bytes);
  }
});
test("source snapshot settings are complete per task and reject obsolete or unknown fields", async () => {
  const { store, create, directory } = await fixture(); const defaults = await store.readDefaults();
  await store.saveDefaults({ schemaVersion: 1, settings: { snapshot: { mode: "snapshot-only", fallback: "live" } } }, defaults.revision);
  let task = await create(); assert.deepEqual(task.value.snapshot, { mode: "snapshot-only", fallback: "live", lvmCowSizeBytes: 8 * 1024 ** 3 });
  task = await store.saveTask(task, { snapshot: { mode: "writers", fallback: "fail" } });
  assert.deepEqual(JSON.parse(await readFile(path.join(directory, ".delta.json"), "utf8")).snapshot, { mode: "writers", fallback: "fail", lvmCowSizeBytes: 8 * 1024 ** 3 });
  const before = await readFile(path.join(directory, ".delta.json"), "utf8");
  for (const snapshot of [{ mode: "lvm" }, { mode: "apfs" }, { fallback: "automatic" }, { workspace: "/tmp/snapshots" }, { backend: "btrfs" }, { lvmCowSizeBytes: 0 }, { lvmCowSizeBytes: 1024 ** 4 + 1 }, { lvmCowSizeBytes: 256 * 1024 ** 2 - 1 }, { lvmCowSizeBytes: Number.MAX_SAFE_INTEGER + 1 }, { lvmCowSizeBytes: 1.1 }]) await assert.rejects(store.saveTask(task, { snapshot }), ConfigurationError);
  await assert.rejects(store.saveTask(task, { vss: { mode: "snapshot-only", fallback: "fail" } }), ConfigurationError);
  assert.throws(() => materializeSettings({ vss: { mode: "off", fallback: "fail", lvmCowSizeBytes: 8 * 1024 ** 3 } }), ConfigurationError);
  assert.equal(await readFile(path.join(directory, ".delta.json"), "utf8"), before);
});

test("removed encryption settings reject in every configuration scope without changing existing files", async () => {
  const { store, create, directory } = await fixture(); await store.initialize(); const task = await create(), defaults = await store.readDefaults();
  const taskFile = path.join(directory, ".delta.json"), defaultsFile = path.join(store.directory, "config.json"), taskBefore = await readFile(taskFile), defaultsBefore = await readFile(defaultsFile);
  assert(!Object.hasOwn(defaults.value.settings, "encryption")); assert(!Object.hasOwn(materializeSettings(), "encryption"));
  for (const encryption of [{}, { enabled: false }, { enabled: true, credentialRef: "removed" }]) {
    assert.throws(() => materializeSettings({ encryption }), /encryption: unknown field/); assert.throws(() => materializeDefaults({ settings: { encryption } }), /encryption: unknown field/);
    await assert.rejects(store.saveTask(task, { encryption }), /encryption/); await assert.rejects(store.saveDefaults({ ...defaults.value, settings: { ...defaults.value.settings, encryption } }, defaults.revision), /encryption/);
    assert.deepEqual(await readFile(taskFile), taskBefore); assert.deepEqual(await readFile(defaultsFile), defaultsBefore);
  }
  const obsolete = json({ ...task.value, encryption: { enabled: false } }); await writeFile(taskFile, obsolete); await assert.rejects(store.loadTask(directory), /encryption: unknown field/); assert.equal(await readFile(taskFile, "utf8"), obsolete);
});

test("missing settings inherit by field; false, zero, empty arrays survive; read never rewrites", async () => {
  const { store, directory, create } = await fixture(); const original = await create();
  let defaults = await store.readDefaults();
  await store.saveDefaults({ schemaVersion: 1, settings: { schedulesPaused: false, archive: { level: 9 }, behavior: { retryCount: 7 } } }, defaults.revision);
  const partial = { wdir:directory,proj:directory,srcs:[],mode:0,name: "Niepełny", schedulesPaused: true, sources: [], retention: { keepCycles: 0 }, archive: { level: 0 } };
  const text = json(partial); await writeFile(path.join(directory, ".delta.json"), text);
  const loaded = await store.loadTask(directory);
  assert.equal(loaded.value.schedulesPaused, true); assert.deepEqual(loaded.value.sources, []);
  assert(!Object.hasOwn(loaded.value, "filters"));
  assert.equal(loaded.value.archive.level, 0); assert.equal(loaded.value.behavior.retryCount, 7);
  assert.equal(await readFile(path.join(directory, ".delta.json"), "utf8"), text);
  await store.saveTask(loaded, {});
  const { history, files, ...savedSettings } = JSON.parse(await readFile(path.join(directory, ".delta.json"), "utf8")); assert.deepEqual(savedSettings,onDisk((await store.loadTask(directory)).value)); assert.deepEqual(history, []); assert.deepEqual(files, {});
});

test("complete tasks remain independent of changed global defaults", async () => {
  const { store, directory, create } = await fixture(); const original = await create();
  const defaults = await store.readDefaults();
  await store.saveDefaults({ schemaVersion: 1, settings: { detection: "hash", archive: { level: 0 }, symlinks: "skip" } }, defaults.revision);
  assert.deepEqual((await store.loadTask(directory)).value, original.value);
  const secondDir = path.join(path.dirname(directory), "second"); await mkdir(secondDir);
  const second = await store.createTask({ directory: secondDir, name: "Nowy" });
  assert.equal(second.value.detection, "hash"); assert.equal(second.value.archive.level, 0);
});

test("invalid explicit values and unknown fields reject rather than silently default", () => {
  for (const value of [{ enabled: null }, { enabled: 0 }, { filters: { exclude: null } }, { archive: { mode: "split" } }, { archive: { compression: "gzip" } }, { archive: { level: 10 } }, { schedules: [{ time: "25:00" }] }, { schedules: [{ timeZone: "invalid/not-a-zone" }] }, { behavior: { concurrency: 0 } }, { password: "SECRET" }, { encryption: { password: "SECRET" } }, { sources: [{ path: "x", password: "SECRET" }] }]) {
    assert.throws(() => materializeSettings(value), ConfigurationError, json(value));
  }
  assert.throws(() => materializeSettings({ schedules: [{ paused: false, kind: "weekly", weekdays: [] }] }), ConfigurationError);
});

test("one snapshot uses one ZIP and obsolete splitting settings reject in every configuration scope", async () => {
  const { root, store, create, directory } = await fixture(); await store.initialize(); const task = await create(), defaults = await store.readDefaults(), filename = path.join(directory, ".delta.json"), defaultsFile = path.join(store.directory, "config.json");
  const original = await readFile(filename), originalDefaults = await readFile(defaultsFile), rejected = path.join(root, "obsolete-archive"); await mkdir(rejected);
  for (const archive of [{ mode: "single" }, { mode: "parts" }, { partSizeBytes: 1024 }, { mode: "parts", partSizeBytes: 1024 }]) {
    assert.throws(() => materializeSettings({ archive }), /(?:mode|partSizeBytes): unknown field/); assert.throws(() => materializeDefaults({ settings: { archive } }), /(?:mode|partSizeBytes): unknown field/);
    await assert.rejects(store.saveTask(task, { archive }), /(?:mode|partSizeBytes): unknown field/); await assert.rejects(store.saveDefaults({ ...defaults.value, settings: { ...defaults.value.settings, archive: { ...defaults.value.settings.archive, ...archive } } }, defaults.revision), /(?:mode|partSizeBytes): unknown field/);
    await assert.rejects(store.createTask({ directory: rejected, name: "Rejected", sources: [{ path: "../source" }], settings: { archive } }), /(?:mode|partSizeBytes): unknown field/); assert.deepEqual(await readdir(rejected), []);
    assert.deepEqual(await readFile(filename), original); assert.deepEqual(await readFile(defaultsFile), originalDefaults);
    const bytes = json({ ...task.value, archive: { ...task.value.archive, ...archive }, hist: [], data: {} }); await writeFile(filename, bytes); await assert.rejects(store.loadTask(directory), /(?:mode|partSizeBytes): unknown field/); assert.equal(await readFile(filename, "utf8"), bytes); await writeFile(filename, original);
  }
  assert.deepEqual((await store.loadTask(directory)).value.archive, { level: 6 });
});

test("multiple schedules inherit by position and persist useful settings without IDs", async () => {
  const { store, create, directory } = await fixture(); const defaults = await store.readDefaults();
  await store.saveDefaults({ schemaVersion: 1, settings: { schedules: [{ name: "Office", paused: false, kind: "daily", time: "18:00", timeZone: "Europe/Warsaw" }, { name: "Weekend", paused: false, kind: "weekly", weekdays: [7], time: "09:00", timeZone: "America/New_York" }] } }, defaults.revision);
  let task = await create({ settings: { schedules: [{ time: "18:00" }, {}] } });
  assert.deepEqual(task.value.schedules.map(row => row.name), ["Office", "Weekend"]);
  assert.equal(task.value.schedules[0].time, "18:00"); assert.equal(task.value.schedules[1].timeZone, "America/New_York");
  assert.equal(task.value.schedules[0].paused, false); assert.equal(task.value.schedules[0].kind, "daily"); assert.equal(task.value.schedules[0].timeZone, "Europe/Warsaw");
  for (const row of task.value.schedules) assert.deepEqual(Object.keys(row).sort(), ["name", "paused", "kind", "intervalMinutes", "time", "weekdays", "timeZone", "missed", "onDestinationAvailable"].sort());
  const partial = { ...task.value, schedules: [{ paused: true, weekdays: [] }, { time: "20:00" }] };
  const bytes = json(partial); await writeFile(path.join(directory, ".delta.json"), bytes);
  task = await store.loadTask(directory); assert.equal(task.value.schedules[0].name, "Office"); assert.equal(task.value.schedules[0].paused, true); assert.deepEqual(task.value.schedules[0].weekdays, []); assert.equal(task.value.schedules[0].timeZone, "Europe/Warsaw"); assert.equal(task.value.schedules[1].time, "20:00");
  assert.equal(await readFile(path.join(directory, ".delta.json"), "utf8"), bytes);
  task = await store.saveTask(task, { schedules: [] }); assert.deepEqual(task.value.schedules, []); assert.deepEqual(JSON.parse(await readFile(path.join(directory, ".delta.json"), "utf8")).schedules, []);
});

test("invalid schedules and obsolete singular schedule are rejected without modifying a task", async () => {
  const { store, create, directory } = await fixture(); const task = await create(), before = await readFile(path.join(directory, ".delta.json"));
  for (const schedules of [null, {}, [null], [{ id: "" }], [{ id: "invalid/id" }], [{ id: "same" }, { id: "same" }], [{ name: "" }], [{ weekdays: [1, 1] }], [{ schedulesPaused: false, kind: "weekly", weekdays: [] }], [{ timeZone: "bad/time-zone" }], [{ intervalMinutes: 0 }], [{ unknown: true }]]) await assert.rejects(store.saveTask(task, { schedules }), ConfigurationError);
  await assert.rejects(store.saveTask(task, { schedule: { schedulesPaused: true } }), ConfigurationError);
  assert.throws(() => materializeSettings({ schedule: { schedulesPaused: true } }), /schedule: unknown field/);
  assert.deepEqual(await readFile(path.join(directory, ".delta.json")), before);
  assert.deepEqual(materializeSettings({ schedules: [{ kind: "daily" }, { kind: "weekly" }] }).schedules.map(row => row.name), ["Schedule 1", "Schedule 2"]);
});

test("backup sequences start with full and allow further full, incremental or differential positions", async () => {
  const { store, create, directory } = await fixture(); let task = await create();
  task = await store.saveTask(task, { sequence: { types: ["full", "incremental", "incremental"] } });
  assert.deepEqual(task.value.sequence, { types: ["full", "incremental", "incremental"] });
  for (const types of [["full", "full", "incremental"], ["full", "incremental", "incremental", "full", "incremental", "incremental"], ["full", "differential", "full", "differential"]]) {
    task = await store.saveTask(task, { sequence: { types } });
    assert.deepEqual(task.value.sequence.types, types);
    assert.equal(JSON.parse(await readFile(path.join(directory, ".delta.json"), "utf8")).sequence, sequenceToString({ types }));
    assert.deepEqual(materializeDefaults({ settings: { sequence: { types } } }).settings.sequence.types, types);
  }
  const before = await readFile(path.join(directory, ".delta.json"));
  for (const types of [[], ["incremental"], ["incremental", "full"], ["differential", "full"], ["full", "unknown"]]) await assert.rejects(store.saveTask(task, { sequence: { types } }), ConfigurationError);
  await assert.rejects(store.saveTask(task, { sequence: { fullEvery: 3 } }), /fullEvery: unknown field/);
  assert.deepEqual(await readFile(path.join(directory, ".delta.json")), before);
  assert.deepEqual(materializeSettings({ sequence: { types: ["full"] } }).sequence, { types: ["full"] });
});

test("task and global JSON store compact sequences while application and task edits preserve them", async () => {
  const { store, directory, create } = await fixture(); await store.initialize(); const filename = path.join(store.directory, "config.json");
  assert.equal(JSON.parse(await readFile(filename, "utf8")).task.sequence, "F");
  const defaults = await store.readDefaults(); await store.saveDefaults({ ...defaults.value, settings: { ...defaults.value.settings, sequence: "FIIFII" } }, defaults.revision);
  assert.equal(JSON.parse(await readFile(filename, "utf8")).task.sequence, "FIIFII");
  let task = await create(); assert.equal(JSON.parse(await readFile(path.join(directory, ".delta.json"), "utf8")).sequence, "FIIFII"); assert.deepEqual(task.value.sequence.types, ["full", "incremental", "incremental", "full", "incremental", "incremental"]);
  const app = await store.readApp(); await store.saveApp({ ...app.value, notifications: false }, app.revision); assert.equal(JSON.parse(await readFile(filename, "utf8")).task.sequence, "FIIFII");
  task = await store.saveTask(task, { sequence: "FFI" }); assert.deepEqual(task.value.sequence.types, ["full", "full", "incremental"]); assert.equal(JSON.parse(await readFile(path.join(directory, ".delta.json"), "utf8")).sequence, "FFI"); assert.deepEqual((await store.loadTask(directory)).value.sequence, task.value.sequence);
});

test("disk sequence strings reject invalid letters, invalid first positions and object aliases without rewriting", async () => {
  const { store, directory, create } = await fixture(); await store.initialize(); await create();
  const taskFile = path.join(directory, ".delta.json"), globalFile = path.join(store.directory, "config.json"), taskBefore = await readFile(taskFile, "utf8"), globalBefore = await readFile(globalFile, "utf8");
  for (const sequence of ["", "I", "IF", "DFF", "FX", "Fi", "F I", "FULL", { types: ["full", "incremental"] }, ["F"], null, 1]) {
    const taskText = JSON.stringify({ ...JSON.parse(taskBefore), sequence }); await writeFile(taskFile, taskText); await assert.rejects(store.loadTask(directory), /sequence/); assert.equal(await readFile(taskFile, "utf8"), taskText); await writeFile(taskFile, taskBefore);
    const global = JSON.parse(globalBefore); global.task.sequence = sequence; const globalText = JSON.stringify(global); await writeFile(globalFile, globalText); await assert.rejects(store.readDefaults(), /sequence/); assert.equal(await readFile(globalFile, "utf8"), globalText); await writeFile(globalFile, globalBefore);
  }
});

test("new tasks start with no schedules and a full-only sequence while explicit partial rules use their own defaults", async () => {
  const { store, create, directory } = await fixture(); const task = await create();
  assert.deepEqual((await store.readDefaults()).value.settings.schedules, []); assert.deepEqual((await store.readDefaults()).value.settings.sequence, { types: ["full"] });
  const defaults = await store.readDefaults(); await store.saveDefaults({ schemaVersion: 1, settings: { schedules: [], sequence: { types: ["full"] } } }, defaults.revision);
  const partial = materializeSettings({ schedules: [{ name: "Daily", paused: false, kind: "daily" }] }); assert.equal(partial.schedules.length, 1); assert.equal(partial.schedules[0].name, "Daily"); assert(!Object.hasOwn(partial.schedules[0],"id")); assert.equal(partial.schedules[0].time, "20:00"); assert.deepEqual(partial.schedules[0].weekdays, [1, 2, 3, 4, 5, 6, 7]);
  const explicit = await store.saveTask(task, { schedules: partial.schedules, sequence: { types: ["full", "incremental", "incremental"] } });
  const current = await store.readDefaults(); await store.saveDefaults({ schemaVersion: 1, settings: { schedules: [], sequence: { types: ["full"] } } }, current.revision);
  assert.deepEqual((await store.loadTask(directory)).value.schedules, explicit.value.schedules); assert.deepEqual((await store.loadTask(directory)).value.sequence, explicit.value.sequence);
});

test("explicit old or future schema versions and invalid JSON are rejected without rewriting or resetting", async () => {
  const { store } = await fixture(); await store.initialize();
  const filename = path.join(store.directory, "config.json");
  for (const bytes of ['{"schemaVersion":0,"theme":"dark"}', '{"schemaVersion":2,"theme":"dark"}', '{"schemaVersion":null}', '{"theme":']) {
    await writeFile(filename, bytes); await assert.rejects(store.readApp());
    await assert.rejects(store.initialize()); assert.equal(await readFile(filename, "utf8"), bytes);
  }
});

test("every configuration scope rejects schema zero without compatibility conversion", async () => {
  const { store, directory, create } = await fixture(); await store.initialize(); const task = await create();
  const cases = [
    [path.join(store.directory, "config.json"), () => store.readApp()],
    [path.join(store.directory, "config.json"), () => store.readDefaults()],
    [path.join(store.directory, "tasks.json"), () => store.readRegistry()],
    [path.join(directory, ".delta.json"), () => store.loadTask(directory)],
  ];
  for (const [filename, read] of cases) {
    const original = await readFile(filename, "utf8"), rejected = json({ ...JSON.parse(original), schemaVersion: 0 }); await writeFile(filename, rejected);
    await assert.rejects(read(), ConfigurationError); assert.equal(await readFile(filename, "utf8"), rejected); await writeFile(filename, original);
  }
  assert.deepEqual((await store.loadTask(directory)).value, task.value);
});

test("global and task saves reject external edits and preserve the last disk contents", async () => {
  const { store, directory, create } = await fixture(); const task = await create();
  const app = await store.readApp(); const newer = await store.saveApp({ theme: "dark" }, app.revision);
  await assert.rejects(store.saveApp({ theme: "light" }, app.revision), ConfigurationConflictError);
  assert.deepEqual(await store.readApp(), newer);
  const filename = path.join(directory, ".delta.json"); const edited = json({ ...task.value, name: "external edit" }); await writeFile(filename, edited);
  await assert.rejects(store.saveTask(task, { name: "stale UI" }), ConfigurationConflictError);
  assert.equal(await readFile(filename, "utf8"), edited);
  assert.deepEqual((await readdir(directory)).sort(), [".delta.json"]);
});

test("concurrent cooperating saves permit exactly one writer at a shared revision", async () => {
  const { store } = await fixture(); await store.initialize(); const app = await store.readApp();
  const results = await Promise.allSettled(Array.from({ length: 8 }, (_, index) => store.saveApp({ ...app.value, maxConcurrentTasks: index + 2 }, app.revision)));
  assert.equal(results.filter(x => x.status === "fulfilled").length, 1);
  assert.equal(results.filter(x => x.status === "rejected" && x.reason instanceof ConfigurationConflictError).length, 7);
  assert.match(await readFile(path.join(store.directory, "config.json"), "utf8"), /"schemaVersion": 1/);
});

test("missing target is not created and existing task cannot be bootstrapped over", async () => {
  const { root, store, create } = await fixture(); const missing = path.join(root, "unmounted", "usb");
  await assert.rejects(store.createTask({ directory: missing, name: "USB" }), DestinationUnavailableError);
  assert.equal((await readdir(root)).includes("unmounted"), false);
  const task = await create(); await assert.rejects(create(), ConfigurationConflictError);
  assert.deepEqual((await store.loadTask(task.directory)).value, task.value);
});

test("offline registry stays visible; fresh discovery and explicit relink preserve hist identity", async () => {
  const { root, store, directory, create } = await fixture(); const task = await create();
  const moved = path.join(root, "USB now mounted elsewhere"); await rename(directory, moved);
  const offline = await store.listTasks(); assert.equal(offline[0].available, false); assert.equal(offline[0].id, path.join(directory, ".delta.json")); assert.equal(offline[0].name, path.basename(directory)); assert(!Object.hasOwn(offline[0], "cachedTask")); assert(!Object.hasOwn(offline[0], "task"));
  assert.equal((await readdir(root)).includes(path.basename(directory)), false);
  const relinked = await store.relinkTask(path.join(directory, ".delta.json"), moved);
  assert.deepEqual(relinked.value, task.value); assert.equal((await store.listTasks())[0].available, true);
  const recovered = new ConfigurationStore({ configDirectory: path.join(root, "fresh-profile") });
  assert.deepEqual((await recovered.discoverTask(moved)).value, task.value);
});

test("replaced mounted directory cannot be saved using an operation opened on the previous directory", async () => {
  const { root, store, directory, create } = await fixture(); const task = await create();
  const bytes = await readFile(path.join(directory, ".delta.json"));
  await rename(directory, path.join(root, "old-device")); await mkdir(directory);
  await writeFile(path.join(directory, ".delta.json"), bytes);
  await assert.rejects(store.saveTask(task, { name: "must reject" }), DestinationUnavailableError);
  assert.deepEqual(await readFile(path.join(directory, ".delta.json")), bytes);
});

test("ordinary configuration edits do not create a second ownership identity", async () => {
  const { store, directory, create } = await fixture(); const task = await create(), filename = path.join(directory, ".delta.json");
  const renamed = { ...task.value, name: "Changed during a running operation" }; await writeFile(filename, json(renamed)); await store.assertTaskDestination(task);
  await assert.rejects(store.saveTask(task, { name: "stale editor" }), ConfigurationConflictError);
  assert.equal((await store.listTasks())[0].id, filename);
});

test("duplication copies settings to an independent destination without persisted identities", async () => {
  const { root, store, create } = await fixture(); const task = await create({ sources: [{ path: "documents" }, { path: "photos" }], settings: { wdir: root, mode: 2, detection: "hash", srcs: [["documents", "**/*.txt", "private/.*"], "photos"] } });
  const directory = path.join(root, "other destination"); await mkdir(directory);
  const duplicate = await store.duplicateTask(task, { directory });
  assert.notEqual(duplicate.directory, task.directory); for (const key of ["id", "schemaVersion", "destination"]) assert(!Object.hasOwn(duplicate.value,key));
  assert.equal(duplicate.value.sources.length, 2);
  assert.equal(duplicate.value.wdir, task.value.wdir); assert.equal(duplicate.value.mode, 2); assert.equal(duplicate.value.detection, "hash"); assert.deepEqual(duplicate.value.srcs, task.value.srcs); assert.equal(duplicate.value.proj, directory);
  for (const [index, source] of duplicate.value.sources.entries()) { assert.deepEqual(source, task.value.sources[index]); assert(!Object.hasOwn(source, "id")); assert(!Object.hasOwn(source, "label")); assert.notEqual(source.filters, task.value.sources[index].filters); }
  assert(!Object.hasOwn(duplicate.value, "encryption"));
  await store.saveTask(duplicate, { archive: { level: 0 } }); assert.equal((await store.loadTask(task.directory)).value.archive.level, 6);
  await store.forgetTask(path.join(duplicate.directory,".delta.json")); assert.deepEqual((await store.readRegistry()).value, [task.directory]);
  assert.deepEqual((await store.loadTask(directory)).value, { ...duplicate.value, archive: { level: 0 } });
});

test("preparing a duplicate draft keeps working directory and raw source patterns without creating a task", async () => {
  const { root, store, create } = await fixture(), task = await create({ sources: [{ path: "documents", filters: { include: ["*.txt"], exclude: ["cache/**"] } }, { path: "photos" }], settings: { wdir: root, mode: 1, detection: "hash", srcs: [["documents", "**/*.txt", "private/.*"], "photos"], schedulesPaused: true } });
  const registry = await readFile(path.join(store.directory, "tasks.json")), before = await readFile(path.join(task.directory, ".delta.json")), rootNames = await readdir(root);
  const draft = store.prepareDuplicateTask(task), { name, proj: _proj, ...expected } = task.value;
  assert.equal(draft.name, `${name} (copy)`); assert.deepEqual(draft.settings, expected); assert.equal(draft.settings.wdir, root); assert.deepEqual(draft.settings.srcs, [["documents", "**/*.txt", "private/.*"], "photos"]);
  for (const key of ["name", "proj", "id", "history", "hist", "files", "data"]) assert(!Object.hasOwn(draft.settings, key));
  assert.deepEqual(await readFile(path.join(store.directory, "tasks.json")), registry); assert.deepEqual(await readFile(path.join(task.directory, ".delta.json")), before); assert.deepEqual(await readdir(root), rootNames);
  draft.settings.sources[0].filters.exclude.push("other/**"); assert.deepEqual(task.value.sources[0].filters.exclude, ["cache/**"]);
});

test("removed linked-view configuration is rejected without changing the registry", async () => {
  const { store, create } = await fixture(); await create(); const registry = await store.readRegistry();
  const filename = path.join(store.directory, "tasks.json"), before = await readFile(filename);
  assert.throws(() => materializeRegistry({ groups: [] }), /registry: expected an array/);
  await assert.rejects(store.saveRegistry({ ...registry.value, groups: [] }, registry.revision), /registry: expected an array/);
  assert.deepEqual(await readFile(filename), before);
  const obsolete = json({ ...registry.value, groups: [] }); await writeFile(filename, obsolete);
  await assert.rejects(store.readRegistry(), /registry: expected an array/);
  assert.equal(await readFile(filename, "utf8"), obsolete);
});

test("the task registry is a plain array of absolute directories and reads names and settings from each task", async () => {
  const { store, create, directory } = await fixture(); const task = await create(), filename = path.join(store.directory, "tasks.json"), before = await readFile(filename);
  assert.deepEqual(JSON.parse(before), [directory]);
  for (const value of [{ schemaVersion: 1, tasks: [directory] }, {}, null, ["relative/directory"], [path.join(directory, ".delta.json")], [{ directory, cachedTask: task.value }], [directory, directory]]) assert.throws(() => materializeRegistry(value), ConfigurationError);
  assert.deepEqual(materializeRegistry([path.join(directory, ".")]), [directory]);
  const registry = await store.readRegistry(); for (const value of [{ schemaVersion: 1, tasks: [] }, [path.join(directory, ".delta.json")]]) { await assert.rejects(store.saveRegistry(value, registry.revision), ConfigurationError); assert.deepEqual(await readFile(filename), before); }
  const changed = { ...task.value, name: "Current file name", schedulesPaused: true }; await writeFile(path.join(directory, ".delta.json"), json(changed));
  const listing = (await store.listTasks())[0]; assert.equal(listing.name, changed.name); assert.equal(listing.schedulesPaused, true); assert.equal(listing.task.value.name, changed.name); assert(!Object.hasOwn(listing, "cachedTask")); assert.deepEqual(await readFile(filename), before);
});

test("a task requires .delta.json without a legacy or extensionless filename alias", async () => {
  const { store, create, directory } = await fixture(), task = await create(), current = path.join(directory, ".delta.json"), bytes = await readFile(current);
  for (const name of ["delta.json", ".delta"]) {
    const old = path.join(directory, name); await rename(current, old); await assert.rejects(store.loadTask(directory), { code: "ENOENT" });
    assert.deepEqual(await readFile(old), bytes); assert.deepEqual(await readdir(directory), [name]);
    const unavailable = (await store.listTasks())[0]; assert.equal(unavailable.available, false); assert.equal(unavailable.id, current); assert.equal(unavailable.directory, directory);
    await rename(old, current); assert.equal((await store.loadTask(directory)).id, task.id); assert.deepEqual(await readFile(current), bytes);
  }
});

test("a stopped task read has a bounded listing deadline and keeps its actual I/O slot across repeated refreshes", { timeout: 10000 }, async t => {
  const { root, store, create } = await fixture(); await create();
  for (const name of ["second", "third"]) { const directory = path.join(root, name); await mkdir(directory); await store.createTask({ directory, name }); }
  let release; const gate = new Promise(resolve => { release = resolve; }); t.after(() => release());
  const load = store.loadTask.bind(store); let calls = 0, active = 0, peak = 0;
  store.loadTask = async reference => { const index = ++calls; active++; peak = Math.max(peak, active); try { if (index <= 2) await gate; return await load(reference); } finally { active--; } };
  const started = Date.now(), listing = await store.listTasks(); assert(Date.now() - started < 2500); assert.equal(calls, 2); assert.equal(peak, 2); assert(listing.every(item => !item.available && !item.task && !Object.hasOwn(item, "cachedTask")));
  for (let index = 0; index < 3; index++) await store.listTasks(); assert.equal(calls, 2, "Refresh must not launch new reads while the old OS calls still hold both slots");
  assert.equal((await store.readApp()).value.language, "en"); release();
  const until = Date.now() + 3000; while (active || calls < 3) { if (Date.now() > until) throw new Error("Task reads did not settle after release"); await new Promise(resolve => setTimeout(resolve, 10)); }
  assert((await store.listTasks()).every(item => item.available && item.task));
});

test("source configuration contains only paths and filters; technical IDs and labels reject everywhere", async () => {
  const { root, store, create } = await fixture(); const task = await create();
  const input = { ...task.value, sources: [{ path: "relative" }] };
  const one = materializeTask(input), two = materializeTask(input); assert.deepEqual(one.sources, [{ path: "relative", filters: { include: [], exclude: [] } }]); assert.deepEqual(two.sources, one.sources);
  assert.throws(() => materializeTask({ ...input, sources: [{ path: "a", label: "Removed name" }] }), /label: unknown field/);
  await assert.rejects(store.saveTask(task, { sources: [{ ...task.value.sources[0], label: "Removed name" }] }), /label: unknown field/);
  const rejected = path.join(root, "invalid-source-label"); await mkdir(rejected); await assert.rejects(store.createTask({ directory: rejected, name: "Rejected", sources: [{ path: "../source", label: "Removed name" }] }), /label: unknown field/); assert.deepEqual(await readdir(rejected), []);
  const source = { id: "unneeded-source-id", path: "relative" };
  assert.throws(() => materializeTask({ ...input, sources: [source] }), /id: unknown field/);
  await assert.rejects(store.saveTask(task, { sources: [source] }), /id: unknown field/);
  const rejectedId = path.join(root, "invalid-source-id"); await mkdir(rejectedId); await assert.rejects(store.createTask({ directory: rejectedId, name: "Rejected", sources: [source] }), /id: unknown field/); assert.deepEqual(await readdir(rejectedId), []);
  await assert.rejects(store.saveTask(task, { id: "replacement" }), ConfigurationError);
});

test("obsolete task timestamps, destination path and fixed concurrency reject without rewriting", async () => {
  const { store, create, directory } = await fixture(); const task = await create(), filename = path.join(directory, ".delta.json"), original = await readFile(filename);
  for (const patch of [{ createdAt: "2026-01-01T00:00:00.000Z" }, { updatedAt: "2026-01-01T00:00:00.000Z" }, { destination: { path: "." } }, { behavior: { ...task.value.behavior, concurrency: 1 } }]) {
    const value = { ...task.value, ...patch }; assert.throws(() => materializeTask(value), /unknown field/);
    await assert.rejects(store.saveTask(task, patch), ConfigurationError); assert.deepEqual(await readFile(filename), original);
    const bytes = json(value); await writeFile(filename, bytes); await assert.rejects(store.loadTask(directory), /unknown field/); assert.equal(await readFile(filename, "utf8"), bytes); await writeFile(filename, original);
  }
  assert.throws(() => materializeDefaults({ settings: { behavior: { concurrency: 1 } } }), /concurrency: unknown field/);
});

test("source paths reject lexical duplicates, including independent filters and Windows casing", async () => {
  const aliases = [["documents", "./documents"], ["documents", "nested/../documents"], ["documents", "documents/"], ...(process.platform === "win32" ? [["Documents", "documents"], ["documents/folder", "documents\\folder"]] : [])];
  for (const [first, second] of aliases) assert.throws(() => materializeSettings({ sources: [{ path: first }, { path: second, filters: { exclude: ["*.tmp"] } }] }), /duplicate source path/);
  const { store, create, directory } = await fixture();
  const aliasesAtDestination = [{ path: "../documents" }, { path: path.resolve(directory, "../documents") }];
  await assert.rejects(create({ sources: aliasesAtDestination }), /duplicate source path/); assert.deepEqual(await readdir(directory), []);
  const task = await create(), filename = path.join(directory, ".delta.json"), original = await readFile(filename);
  await assert.rejects(store.saveTask(task, { sources: aliasesAtDestination }), /duplicate source path/); assert.deepEqual(await readFile(filename), original);
  const bytes = json({ ...task.value, sources: aliasesAtDestination }); await writeFile(filename, bytes); await assert.rejects(store.loadTask(directory), /duplicate source path/); assert.equal(await readFile(filename, "utf8"), bytes);
});


test("config.json holds separate application and task sections and fills missing fields without rewriting", async () => {
  const { store } = await fixture(); await store.initialize(); const filename = path.join(store.directory, "config.json");
  const partial = json({ schemaVersion: 1, application: { notifications: false }, task: { archive: { level: 0 }, schedules: [] } }); await writeFile(filename, partial);
  assert.equal((await store.readApp()).value.notifications, false); assert.equal((await store.readDefaults()).value.settings.archive.level, 0);
  assert.equal(await readFile(filename, "utf8"), partial);
  const app = await store.readApp(); await store.saveApp({ ...app.value, theme: "dark" }, app.revision);
  const disk = JSON.parse(await readFile(filename, "utf8")); assert.deepEqual(Object.keys(disk).sort(), ["application", "schemaVersion", "task"]); assert.equal(disk.task.archive.level, 0); assert.deepEqual(disk.task.schedules, []);
});

test("app and task-default forms can save concurrently without losing the other section", async () => {
  const { store } = await fixture(); await store.initialize(); const app = await store.readApp(), defaults = await store.readDefaults();
  await Promise.all([store.saveApp({ ...app.value, theme: "dark", notifications: false }, app.revision), store.saveDefaults({ ...defaults.value, settings: { ...defaults.value.settings, detection: "hash" } }, defaults.revision)]);
  assert.equal((await store.readApp()).value.theme, "dark"); assert.equal((await store.readApp()).value.notifications, false); assert.equal((await store.readDefaults()).value.settings.detection, "hash");
  assert.equal((await readdir(store.directory)).filter(name => name.endsWith(".json")).length, 2);
});

test("saving app settings preserves an externally edited defaults section but rejects an app conflict", async () => {
  const { store } = await fixture(); await store.initialize(); const filename = path.join(store.directory, "config.json"), loaded = await store.readApp();
  const disk = JSON.parse(await readFile(filename, "utf8")); disk.task.behavior.retryCount = 9; await writeFile(filename, json(disk));
  const saved = await store.saveApp({ ...loaded.value, theme: "dark" }, loaded.revision); assert.equal((await store.readDefaults()).value.settings.behavior.retryCount, 9);
  const edited = JSON.parse(await readFile(filename, "utf8")); edited.application.theme = "light"; const bytes = json(edited); await writeFile(filename, bytes);
  await assert.rejects(store.saveApp({ ...saved.value, theme: "system" }, saved.revision), ConfigurationConflictError); assert.equal(await readFile(filename, "utf8"), bytes);
});

test("config.json rejects unknown or misplaced fields without replacing the file", async () => {
  const { store } = await fixture(); await store.initialize(); const filename = path.join(store.directory, "config.json");
  for (const value of [{ app: {} }, { aaplication: {} }, { taskDefaults: {} }, { theme: "dark" }, { application: { schemaVersion: 1 } }, { task: { sources: [] } }, { task: { filters: {} } }, { settings: {} }, { application: null }, { task: null }]) {
    const bytes = json(value); await writeFile(filename, bytes); await assert.rejects(store.readConfig(), ConfigurationError); await assert.rejects(store.readApp(), ConfigurationError); await assert.rejects(store.readDefaults(), ConfigurationError); assert.equal(await readFile(filename, "utf8"), bytes);
  }
});


test("Python's six task fields load directly and GUI edits keep the authoritative source list", async () => {
  const {root,store,directory}=await fixture(), filename=path.join(directory,".delta.json");
  const original={wdir:root,proj:directory,srcs:["documents",["photos","**/*.jpg","private/.*"]],mode:2,hist:["older-backup.zip"],data:{"documents/readme.txt":"123:7","empty/":null}};
  const bytes=json(original); await writeFile(filename,bytes);
  let task=await store.loadTask(directory); assert.equal(task.id,filename); assert.equal(task.value.name,path.basename(directory)); assert.equal(task.value.mode,2);
  assert.deepEqual(task.value.srcs,original.srcs); assert.deepEqual(task.value.sources.map(source=>source.path),["documents","photos"]); assert.equal(await readFile(filename,"utf8"),bytes);
  task=await store.saveTask(task,{name:"Desktop photos",sources:task.value.sources.map(source=>({...source,filters:{include:["*.txt"],exclude:[]}}))});
  const disk=JSON.parse(await readFile(filename,"utf8")); for(const key of ["workingDirectory","backupDirectory","sources","pathMode","history","files"]) assert.deepEqual(disk[key],onDisk(original)[key]);
  assert.deepEqual(disk.sourceFilters,{documents:{include:["*.txt"],exclude:[]},photos:{include:["*.txt"],exclude:[]}});
  for(const key of ["schemaVersion","id","destination","hist","data","srcs","wdir","proj","mode"]) assert(!Object.hasOwn(disk,key));
  const next=await store.saveTask(task,{sources:[task.value.sources[1],{path:"music"}]}); assert.deepEqual(next.value.srcs,[["photos","**/*.jpg","private/.*"],"music"]);
  const header=task.value;
  for(const mode of [0,1,2]) assert.equal(materializeTask({...header,mode}, {},directory).mode,mode);
  for(const mode of [-1,3,"0",null]) assert.throws(()=>materializeTask({...header,mode}, {},directory),ConfigurationError);
});


test("task and schedule pause settings use explicit positive pause flags without enabled aliases", async () => {
  const {store,create,directory}=await fixture(); let task=await create();
  assert.equal(task.value.schedulesPaused,false); assert.deepEqual(task.value.schedules,[]); assert(!Object.hasOwn(task.value,"enabled"));
  let disk=JSON.parse(await readFile(path.join(directory,".delta.json"),"utf8")); assert.equal(disk.schedulesPaused,false); assert(!Object.hasOwn(disk,"enabled"));
  task=await store.saveTask(task,{schedulesPaused:true,schedules:[{name:"Daily",paused:true,kind:"daily"}]});
  disk=JSON.parse(await readFile(path.join(directory,".delta.json"),"utf8")); assert.equal(disk.schedulesPaused,true); assert.equal(disk.schedules[0].paused,true); assert(!Object.hasOwn(disk.schedules[0],"enabled"));
  for(const enabled of [true,false]){
    assert.throws(()=>materializeTask({...task.value,enabled}),/enabled: unknown field/);
    await assert.rejects(store.saveTask(task,{enabled}),/enabled/);
    assert.throws(()=>materializeSettings({schedules:[{enabled}]}),/enabled: unknown field/);
    assert.throws(()=>materializeDefaults({settings:{enabled}}),/enabled: unknown field/);
  }
  for(const schedulesPaused of [null,0,"false"]) assert.throws(()=>materializeSettings({schedulesPaused}),ConfigurationError);
  for(const paused of [null,0,"false"]) assert.throws(()=>materializeSettings({schedules:[{paused}]}),ConfigurationError);
});
