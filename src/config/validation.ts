import path from "node:path";
import type { AppConfig, DeepPartial, GlobalConfig, PythonSource, ScheduleConfig, TaskConfig, TaskDefaults, TaskRegistry, TaskSettings } from "../domain/models.js";
import { builtInAppConfig, builtInSchedule, builtInSettings } from "./defaults.js";
import { isUpdateRepository } from "../service/updates.js";
import { sourcePathKey, portablePath, portableGlob } from "../domain/source-identity.mjs";
import { sequenceFromString } from "./sequence.mjs";

export class ConfigurationError extends Error {
  readonly code = "INVALID_CONFIGURATION";
  constructor(message: string) { super(message); this.name = "ConfigurationError"; }
}
type Rule = (value: unknown, path: string) => void;
const fail = (path: string, message: string): never => { throw new ConfigurationError(`${path}: ${message}`); };
const string: Rule = (v, p) => { if (typeof v !== "string" || v.includes("\0")) fail(p, "expected a string without NUL"); };
const nonempty: Rule = (v, p) => { string(v, p); if (!(v as string).trim()) fail(p, "must not be empty"); };
const bool: Rule = (v, p) => { if (typeof v !== "boolean") fail(p, "expected a boolean"); };
const integer = (min: number, max = Number.MAX_SAFE_INTEGER): Rule => (v, p) => { if (!Number.isSafeInteger(v) || (v as number) < min || (v as number) > max) fail(p, `expected an integer in ${min}..${max}`); };
const enumeration = (...values: unknown[]): Rule => (v, p) => { if (!values.includes(v)) fail(p, `expected one of ${values.join(", ")}`); };
const array = (rule: Rule, minimum = 0): Rule => (v, p) => { if (!Array.isArray(v) || v.length < minimum) fail(p, `expected an array with at least ${minimum} items`); (v as unknown[]).forEach((x, i) => rule(x, `${p}[${i}]`)); };
const object = (fields: Record<string, Rule>): Rule => (v, p) => {
  if (!v || typeof v !== "object" || Array.isArray(v) || Object.getPrototypeOf(v) !== Object.prototype) fail(p, "expected an object");
  for (const [key, value] of Object.entries(v as object)) { if (!Object.hasOwn(fields, key)) fail(`${p}.${key}`, "unknown field"); fields[key]!(value, `${p}.${key}`); }
};
const timezone: Rule = (v, p) => { nonempty(v, p); try { new Intl.DateTimeFormat("en", { timeZone: v as string }).format(); } catch { fail(p, "unknown IANA time zone"); } };
const time: Rule = (v, p) => { string(v, p); if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(v as string)) fail(p, "expected HH:mm"); };
const sourceFields = { path: nonempty, filters: object({ include: array(string), exclude: array(string) }) };
const scheduleFields = { name: nonempty, paused: bool, kind: enumeration("manual", "interval", "daily", "weekly"), intervalMinutes: integer(1, Math.floor(Number.MAX_SAFE_INTEGER / 60_000)), time, weekdays: array(integer(1, 7)), timeZone: timezone, missed: enumeration("run-once", "skip"), onDestinationAvailable: bool };
const settingsFields: Record<string, Rule> = {
  wdir: string,
  mode: enumeration(0, 1, 2),
  schedulesPaused: bool,
  sources: array(object(sourceFields)),
  schedules: array(object(scheduleFields)),
  sequence: object({ types: array(enumeration("full", "incremental", "differential"), 1) }),
  retention: object({ when: enumeration("before", "after"), keepCycles: integer(0), maxAgeDays: integer(0), protectPinned: bool }),
  archive: object({ level: integer(0, 9) }),
  detection: enumeration("fast", "hash"), symlinks: enumeration("follow", "skip"),
  snapshot: object({ mode: enumeration("off", "snapshot-only", "writers"), fallback: enumeration("fail", "live"), lvmCowSizeBytes: integer(256 * 1024 ** 2, 1024 ** 4) }),
  behavior: object({ continueOnFileError: bool, retryCount: integer(0, 100), resume: bool }),
};
const defaultSettingsFields = Object.fromEntries(Object.entries(settingsFields).filter(([key]) => key !== "sources"));
const pythonSource: Rule = (value, location) => {
  if (typeof value === "string") { nonempty(value, location); return; }
  if (!Array.isArray(value) || value.length < 1 || value.length > 3) fail(location, "expected a path or [path, glob, exclude regex]");
  const parts = value as unknown[];
  nonempty(parts[0], `${location}[0]`);
  for (let index = 1; index < parts.length; index++) if (parts[index] !== null) string(parts[index], `${location}[${index}]`);
};
const sourceFilters: Rule = (value, location) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(location, "expected source filters by path");
  for (const [key, filters] of Object.entries(value as object)) { nonempty(key, location); object({ include: array(string), exclude: array(string) })(filters, `${location}.${key}`); }
};
const taskFields = { name: nonempty, proj: nonempty, srcs: array(pythonSource), filters: sourceFilters, ...settingsFields };
const updateRepository: Rule = (value, path) => { if (!isUpdateRepository(value)) fail(path, "expected an empty string or a GitHub owner/repo name"); };
const appFields = { schemaVersion: enumeration(1), theme: enumeration("system", "light", "dark"), themeFamily: enumeration("one", "aura"), language: enumeration("en"), closeToTray: bool, launchAtLogin: bool, notifications: bool, schedulerPaused: bool, maxConcurrentTasks: integer(1, 64), updates: object({ repository: updateRepository, checkOnStartup: bool, includePrereleases: bool }) };

/** Arrays replace atomically. Only absent object members inherit; invalid explicit values never do. */
export function mergeMissing<T>(base: T, patch: unknown): T {
  if (patch === undefined) return structuredClone(base);
  if (patch === null || Array.isArray(patch) || typeof patch !== "object") return structuredClone(patch) as T;
  const result: Record<string, unknown> = base && typeof base === "object" && !Array.isArray(base) ? structuredClone(base) as Record<string, unknown> : {};
  for (const [key, value] of Object.entries(patch)) Object.defineProperty(result, key, { value: mergeMissing(result[key], value), enumerable: true, writable: true, configurable: true });
  return result as T;
}
/** Missing fields use current defaults; an explicitly different schema is never converted. */
function currentDocument(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("configuration", "expected an object");
  const document = structuredClone(value) as Record<string, unknown>;
  if (document.schemaVersion === undefined) document.schemaVersion = 1;
  if (document.schemaVersion !== 1) fail("schemaVersion", "unsupported schema version; file was not changed");
  return document;
}
function runtimeSequence(value: unknown): unknown {
  if (value && typeof value === "object" && !Array.isArray(value) && typeof (value as Record<string, unknown>).sequence === "string") {
    try { return { ...value, sequence: sequenceFromString((value as Record<string, unknown>).sequence) }; }
    catch (error) { throw new ConfigurationError((error as Error).message); }
  }
  return value;
}
export function materializeSettings(partial: unknown = {}, globalDefaults: unknown = {}): TaskSettings {
  partial = runtimeSequence(partial); globalDefaults = runtimeSequence(globalDefaults);
  object(defaultSettingsFields)(globalDefaults, "defaults"); object(settingsFields)(partial, "task");
  const result = mergeMissing(mergeMissing(builtInSettings(), globalDefaults), partial);
  result.wdir = portablePath(result.wdir);
  result.sources = result.sources.map((source, index) => {
    if (!source.path) fail(`sources[${index}].path`, "required field");
    return { path: portablePath(source.path), filters: { include: (source.filters?.include ?? []).map(portableGlob), exclude: (source.filters?.exclude ?? []).map(portableGlob) } };
  });
  validateSourcePaths(result.sources);
  const defaultSchedules = (globalDefaults as { schedules?: Array<Partial<ScheduleConfig>> }).schedules ?? [];
  result.schedules = result.schedules.map((schedule, index) => mergeMissing(mergeMissing(builtInSchedule(index), defaultSchedules[index]), schedule));
  for (const [index, schedule] of result.schedules.entries()) {
    if (new Set(schedule.weekdays).size !== schedule.weekdays.length) fail(`schedules[${index}].weekdays`, "duplicate weekday");
    if (!schedule.paused && schedule.kind === "weekly" && schedule.weekdays.length === 0) fail(`schedules[${index}].weekdays`, "weekly schedule needs at least one day");
  }
  if (result.sequence.types[0] !== "full") fail("sequence.types", "must begin with a full backup");
  return result;
}
/** Reject lexical aliases without touching source disks, which may be offline. */
export function validateSourcePaths(sources: TaskSettings["sources"], directory?: string): void {
  const seen = new Set<string>();
  for (const [index, source] of sources.entries()) {
    const key = sourcePathKey(directory === undefined ? source.path : path.resolve(directory, source.path));
    if (seen.has(key)) fail(`sources[${index}].path`, "duplicate source path");
    seen.add(key);
  }
}
export function materializeTask(value: unknown, globalDefaults: unknown = {}, directory = process.cwd()): TaskConfig {
  value = runtimeSequence(value);
  object(taskFields)(value, "task");
  const doc = value as Record<string, unknown>;
  const partial = Object.fromEntries(Object.keys(settingsFields).filter(key => Object.hasOwn(doc, key)).map(key => [key, doc[key]]));
  const supplied = (doc.srcs as PythonSource[] | undefined)?.map(source => typeof source === "string" ? portablePath(source) : source.map((value, index) => index === 0 ? portablePath(value as string) : index === 1 && typeof value === "string" ? portableGlob(value) : value) as PythonSource);
  const filters = doc.filters === undefined ? undefined : Object.fromEntries(Object.entries(doc.filters as Record<string, Partial<TaskSettings["sources"][number]["filters"]>>).map(([sourcePath, value]) => [portablePath(sourcePath), value]));
  if (!Object.hasOwn(doc, "sources")) partial.sources = (supplied ?? []).map(source => { const sourcePath = typeof source === "string" ? source : source[0]; return { path: sourcePath, filters: filters && Object.hasOwn(filters, sourcePath) ? filters[sourcePath] : {} }; });
  const settings = materializeSettings(partial, globalDefaults);
  const srcs = settings.sources.map(source => structuredClone(supplied?.find(item => (typeof item === "string" ? item : item[0]) === source.path) ?? source.path));
  return { ...settings, wdir: settings.wdir || portablePath(directory), proj: portablePath(doc.proj as string ?? directory), srcs, name: doc.name as string ?? path.basename(directory) };
}
export function materializeApp(value: unknown = {}): AppConfig {
  const doc = currentDocument(value); object(appFields)(doc, "app");
  return mergeMissing(builtInAppConfig(), doc);
}
export function materializeDefaults(value: unknown = {}): TaskDefaults {
  const doc = currentDocument(value); if (Object.hasOwn(doc, "settings")) doc.settings = runtimeSequence(doc.settings); object({ schemaVersion: enumeration(1), settings: object(defaultSettingsFields) })(doc, "task-defaults");
  const { sources: _sources, ...settings } = materializeSettings({}, doc.settings ?? {});
  return { schemaVersion: 1, settings };
}
export function materializeGlobalConfig(value: unknown = {}): GlobalConfig {
  const doc = currentDocument(value);
  const { schemaVersion: _schema, ...preferences } = appFields;
  object({ schemaVersion: enumeration(1), application: object(preferences), task: object(defaultSettingsFields) })(doc, "config");
  const { schemaVersion: _appSchema, ...app } = materializeApp(doc.application ?? {});
  return { schemaVersion: 1, application: app, task: materializeDefaults({ settings: doc.task ?? {} }).settings };
}
export function materializeRegistry(value: unknown = []): TaskRegistry {
  array(nonempty)(value, "registry");
  const registry = (value as string[]).map(directory => {
    if (!path.isAbsolute(directory) || path.basename(directory).toLowerCase() === ".delta.json") fail("registry", "expected an absolute task directory path");
    return portablePath(path.resolve(directory));
  });
  const seen = new Set<string>();
  for (const directory of registry) {
    const key = process.platform === "win32" ? directory.toLowerCase() : directory;
    if (seen.has(key)) fail("registry", "duplicate task directory path"); seen.add(key);
  }
  return registry;
}
export type TaskPatch = DeepPartial<TaskSettings> & { name?: string; wdir?: string; proj?: string; srcs?: PythonSource[]; mode?: 0 | 1 | 2 };
