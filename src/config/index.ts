import { homedir } from "node:os";
import path from "node:path";
import type { AppConfig, DeepPartial, GlobalConfig, ScheduleConfig, SourceConfig, TaskConfig, TaskDefaults, TaskDefaultSettings, TaskRegistry, TaskSettings } from "../domain/models.js";
import { builtInGlobalConfig } from "./defaults.js";
import { atomicSave, ConfigurationConflictError, DestinationUnavailableError, directoryIdentity, ensureGlobalDirectory, readDocument, requireDirectoryIdentity, revisionOf, type ConfigDocument, type DirectoryIdentity } from "./files.js";
import { ConfigurationError, materializeApp, materializeDefaults, materializeGlobalConfig, materializeRegistry, materializeTask, mergeMissing, validateSourcePaths, type TaskPatch } from "./validation.js";
import { withTaskReadSlot } from "../platform/task-read-slots.js";
import { readTaskDocument, saveTaskDocument } from "./task-document.mjs";
import { portablePath } from "../domain/source-identity.mjs";
import { sequenceFromString, sequenceToString } from "./sequence.mjs";

export * from "./defaults.js";
export * from "./validation.js";
export { ConfigurationConflictError, DestinationUnavailableError } from "./files.js";
export type { ConfigDocument, DirectoryIdentity } from "./files.js";
export type { AppConfig, DeepPartial, GlobalConfig, TaskConfig, TaskDefaults, TaskDefaultSettings, TaskSettings, SourceConfig, ScheduleConfig, TaskRegistry } from "../domain/models.js";
export interface LoadedTask extends ConfigDocument<TaskConfig> { id: string; revision: string; directory: string; guard: DirectoryIdentity }
export interface TaskListing { id: string; directory: string; available: boolean; name: string; schedulesPaused?: boolean; task?: LoadedTask; error?: string }
export function taskFile(reference: string): string { const resolved = path.resolve(reference); return portablePath(path.basename(resolved).toLowerCase() === ".delta.json" ? resolved : path.join(resolved, ".delta.json")); }
function taskPathKey(reference: string): string { const filename = taskFile(reference); return process.platform === "win32" ? filename.toLowerCase() : filename; }
export interface CreateTaskOptions { directory: string; name: string; sources?: Array<{ path: string; filters?: DeepPartial<SourceConfig["filters"]> }>; settings?: DeepPartial<TaskSettings> & Partial<Pick<TaskConfig, "mode" | "wdir" | "srcs">> }
function storedGlobalConfig(value: GlobalConfig) {
  const { wdir, mode, ...settings } = value.task;
  return { ...value, task: { workingDirectory: portablePath(wdir), pathMode: mode, ...settings, sequence: sequenceToString(settings.sequence) } };
}
function loadedGlobalConfig(value: unknown): GlobalConfig {
  const document = structuredClone(value) as { task?: Record<string, unknown> };
  if (document?.task && typeof document.task === "object" && !Array.isArray(document.task)) {
    for (const key of ["wdir", "mode"]) if (Object.hasOwn(document.task, key)) throw new ConfigurationError(`config.task.${key}: unknown field`);
    const { workingDirectory, pathMode, ...settings } = document.task;
    document.task = { ...settings, ...(workingDirectory === undefined ? {} : { wdir: workingDirectory }), ...(pathMode === undefined ? {} : { mode: pathMode }) };
  }
  if (document?.task && Object.hasOwn(document.task, "sequence")) {
    try { document.task.sequence = sequenceFromString(document.task.sequence); } catch (error) { throw new ConfigurationError((error as Error).message); }
  }
  return materializeGlobalConfig(document);
}
export class ConfigurationStore {
  readonly directory: string;
  private taskReads = new Map<string, { at: number; promise: Promise<void> }>();
  private taskQueue = new Set<string>();
  private taskResults = new Map<string, TaskListing>();
  private taskReadChanges = new Set<() => void>();
  constructor(options: { homeDirectory?: string; configDirectory?: string } = {}) { this.directory = portablePath(path.resolve(options.configDirectory ?? path.join(options.homeDirectory ?? homedir(), ".delta"))); }
  private file(name: string): string { return path.join(this.directory, name); }
  async initialize(): Promise<void> {
    await ensureGlobalDirectory(this.directory);
    for (const [name, value] of [["config.json", storedGlobalConfig(builtInGlobalConfig())], ["tasks.json", []]] as const) {
      try { await atomicSave(this.file(name), value, null); } catch (error) { if (!(error instanceof ConfigurationConflictError)) throw error; }
    }
    await Promise.all([this.readConfig(), this.readRegistry()]);
  }
  async readConfig(): Promise<ConfigDocument<GlobalConfig>> { return readDocument(this.file("config.json"), loadedGlobalConfig, builtInGlobalConfig()); }
  private sectionRevision(document: ConfigDocument<GlobalConfig>, section: "application" | "task"): string | null { return document.revision === null ? null : revisionOf(JSON.stringify(document.value[section])); }
  private async saveSection<K extends "application" | "task">(section: K, value: GlobalConfig[K], revision: string | null): Promise<ConfigDocument<GlobalConfig>> {
    await ensureGlobalDirectory(this.directory);
    for (let attempt = 0; ; attempt++) {
      const document = await this.readConfig();
      if (this.sectionRevision(document, section) !== revision) throw new ConfigurationConflictError();
      try { const updated = { ...document.value, [section]: value }, saved = await atomicSave(this.file("config.json"), storedGlobalConfig(updated), document.revision); return { value: updated, revision: saved.revision }; }
      catch (error) { if (!(error instanceof ConfigurationConflictError) || attempt >= 4) throw error; }
    }
  }
  async readApp(): Promise<ConfigDocument<AppConfig>> { const document = await this.readConfig(); return { value: { schemaVersion: 1, ...document.value.application }, revision: this.sectionRevision(document, "application") }; }
  async saveApp(value: unknown, revision: string | null): Promise<ConfigDocument<AppConfig>> { const { schemaVersion: _schema, ...app } = materializeApp(value), document = await this.saveSection("application", app, revision); return { value: { schemaVersion: 1, ...document.value.application }, revision: this.sectionRevision(document, "application") }; }
  async readDefaults(): Promise<ConfigDocument<TaskDefaults>> { const document = await this.readConfig(); return { value: { schemaVersion: 1, settings: document.value.task }, revision: this.sectionRevision(document, "task") }; }
  async saveDefaults(value: unknown, revision: string | null): Promise<ConfigDocument<TaskDefaults>> { const document = await this.saveSection("task", materializeDefaults(value).settings, revision); return { value: { schemaVersion: 1, settings: document.value.task }, revision: this.sectionRevision(document, "task") }; }
  async readRegistry(): Promise<ConfigDocument<TaskRegistry>> { return readDocument(this.file("tasks.json"), materializeRegistry, []); }
  async saveRegistry(value: unknown, revision: string | null): Promise<ConfigDocument<TaskRegistry>> { const materialized = materializeRegistry(value); await ensureGlobalDirectory(this.directory); return atomicSave(this.file("tasks.json"), materialized, revision); }
  async loadTask(directory: string): Promise<LoadedTask> {
    directory = path.dirname(taskFile(directory));
    const guard = await directoryIdentity(directory);
    const defaults = await this.readDefaults();
    const document = await readTaskDocument(path.join(directory, ".delta.json"));
    const config = materializeTask(document.value, defaults.value.settings, directory); validateSourcePaths(config.sources, config.wdir);
    const task = { value: config, revision: document.revision };
    await requireDirectoryIdentity(directory, guard);
    if (!task.revision) throw new DestinationUnavailableError("Task configuration is unavailable.");
    return { ...task, id: taskFile(directory), revision: task.revision, directory, guard };
  }
  async assertTaskDestination(task: LoadedTask): Promise<void> {
    await requireDirectoryIdentity(task.directory, { realPath: task.guard.realPath, device: task.guard.device, inode: task.guard.inode });
  }
  async createTask(options: CreateTaskOptions): Promise<LoadedTask> {
    const directory = portablePath(path.resolve(options.directory));
    const identity = await directoryIdentity(directory); // Never creates a missing USB/NAS mount.
    const defaults = await this.readDefaults();
    const raw = mergeMissing<Record<string, unknown>>({ name: options.name, ...structuredClone(defaults.value.settings) }, options.settings ?? {});
    if (options.sources) raw.sources = structuredClone(options.sources);
    const config = materializeTask(raw, defaults.value.settings, directory);
    validateSourcePaths(config.sources, config.wdir);
    const guard = () => requireDirectoryIdentity(directory, identity);
    await saveTaskDocument(path.join(directory, ".delta.json"), config, null, { guard });
    const loaded = await this.loadTask(directory); await this.rememberTask(loaded); return loaded;
  }
  async saveTask(loaded: LoadedTask, patch: TaskPatch): Promise<LoadedTask> {
    const allowed = new Set(["name", "wdir", "proj", "srcs", "mode", "schedulesPaused", "sources", "schedules", "sequence", "retention", "archive", "detection", "symlinks", "snapshot", "behavior"]);
    for (const field of Object.keys(patch)) if (!allowed.has(field)) throw new ConfigurationError(`Task patch cannot change ${field}.`);
    const defaults = await this.readDefaults();
    const input = mergeMissing(loaded.value, patch);
    if (Object.hasOwn(patch, "srcs") && !Object.hasOwn(patch, "sources")) {
      Object.assign(input, { filters: Object.fromEntries(loaded.value.sources.map(source => [source.path, source.filters])) });
      delete (input as Partial<TaskConfig>).sources;
    }
    const config = materializeTask(input, defaults.value.settings, loaded.directory);
    validateSourcePaths(config.sources, config.wdir);
    await saveTaskDocument(path.join(loaded.directory, ".delta.json"), config, loaded.revision, { guard: () => this.assertTaskDestination(loaded) });
    const saved = await this.loadTask(loaded.directory); await this.rememberTask(saved); return saved;
  }
  private async editRegistry(edit: (registry: TaskRegistry) => void): Promise<void> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const document = await this.readRegistry(); edit(document.value);
      try { await this.saveRegistry(document.value, document.revision); return; } catch (error) { if (!(error instanceof ConfigurationConflictError) || attempt === 4) throw error; }
    }
  }
  async rememberTask(task: LoadedTask): Promise<void> {
    await this.assertTaskDestination(task);
    await this.editRegistry(registry => {
      const directory = portablePath(path.resolve(task.directory));
      if (!registry.some(item => taskPathKey(item) === taskPathKey(directory))) registry.push(directory);
    });
  }
  async discoverTask(directory: string): Promise<LoadedTask> { const loaded = await this.loadTask(directory); await this.rememberTask(loaded); return loaded; }
  async findRememberedTask(reference: string): Promise<string | undefined> {
    const entries = (await this.readRegistry()).value;
    const direct = entries.find(directory => taskPathKey(directory) === taskPathKey(reference)); if (direct) return taskFile(direct);
    const available = (await this.listTasks()).filter(item => item.available), identified = available.filter(item => item.id === reference);
    const matches = (identified.length ? identified : available.filter(item => item.name === reference)).map(item => taskFile(item.directory));
    if (matches.length > 1) throw new ConfigurationError("Several remembered tasks have this name; use the task directory path");
    return matches[0];
  }
  async relinkTask(reference: string, directory: string): Promise<LoadedTask> {
    const loaded = await this.loadTask(directory);
    const previous = await this.findRememberedTask(reference);
    if (!previous) throw new DestinationUnavailableError("The previous task directory is not remembered. Select its directory path before relinking.");
    await this.editRegistry(registry => { const replacement = portablePath(path.resolve(loaded.directory)), updated = registry.map(directory => taskPathKey(directory) === taskPathKey(previous) ? replacement : directory).filter((directory, index, all) => all.findIndex(other => taskPathKey(other) === taskPathKey(directory)) === index); registry.splice(0, registry.length, ...updated); });
    return loaded;
  }
  prepareDuplicateTask(task: LoadedTask): { name: string; settings: NonNullable<CreateTaskOptions["settings"]> } {
    const { name, proj: _proj, ...settings } = structuredClone(task.value);
    return { name: `${name} (copy)`, settings };
  }
  async duplicateTask(task: LoadedTask, options: { directory: string; name?: string }): Promise<LoadedTask> {
    const draft = this.prepareDuplicateTask(task);
    return this.createTask({ directory: options.directory, name: options.name ?? draft.name, settings: draft.settings });
  }
  async forgetTask(reference: string): Promise<void> { const filename = await this.findRememberedTask(reference); if (!filename) throw new DestinationUnavailableError("Task is not remembered or is offline. Use its directory path to forget it."); await this.editRegistry(registry => { const kept = registry.filter(item => taskPathKey(item) !== taskPathKey(filename)); registry.splice(0, registry.length, ...kept); }); }
  async listTasks(): Promise<TaskListing[]> {
    const files = (await this.readRegistry()).value.map(taskFile), wanted = new Set(files);
    for (const filename of this.taskQueue) if (!wanted.has(filename)) this.taskQueue.delete(filename);
    for (const filename of this.taskResults.keys()) if (!wanted.has(filename)) this.taskResults.delete(filename);
    for (const filename of files) if (!this.taskReads.has(filename)) { this.taskResults.delete(filename); this.taskQueue.add(filename); }
    this.drainTaskReads();
    const pending = () => files.some(filename => { const job = this.taskReads.get(filename); return job ? Date.now() - job.at < 1200 : this.taskQueue.has(filename) && this.taskReads.size < 2; });
    if (pending()) await new Promise<void>(resolve => {
      const finish = () => { clearTimeout(timer); this.taskReadChanges.delete(check); resolve(); }, check = () => { if (!pending()) finish(); };
      const timer = setTimeout(finish, 1200); this.taskReadChanges.add(check); check();
    });
    return files.map(filename => this.taskReads.has(filename) || this.taskQueue.has(filename) ? this.unavailableTask(filename, "The task file is taking time to respond. Open or relink its path when it becomes available.") : this.taskResults.get(filename) ?? this.unavailableTask(filename, "Task file is unavailable"));
  }
  private unavailableTask(filename: string, error: string): TaskListing { const directory = path.dirname(filename); return { id: filename, directory, available: false, name: path.basename(directory), error }; }
  private drainTaskReads() {
    for (const filename of this.taskQueue) {
      if (this.taskReads.size >= 2) return;
      if (this.taskReads.has(filename)) continue;
      this.taskQueue.delete(filename);
      const promise = withTaskReadSlot(() => this.loadTask(filename)).then(task => { this.taskResults.set(filename, { id: taskFile(task.directory), directory: task.directory, available: true, name: task.value.name, schedulesPaused: task.value.schedulesPaused, task }); }, error => { this.taskResults.set(filename, this.unavailableTask(filename, (error as Error).message)); }).finally(() => { this.taskReads.delete(filename); this.drainTaskReads(); for (const listener of this.taskReadChanges) listener(); });
      this.taskReads.set(filename, { at: Date.now(), promise });
    }
  }
}
