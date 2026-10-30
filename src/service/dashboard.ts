import path from "node:path";
import { readTaskDocument } from "../config/task-document.mjs";
import type { TaskRegistry } from "../domain/models.js";
import { atomicSave, ConfigurationConflictError, readDocument } from "../config/files.js";
import type { Operation } from "./api.js";
import { withTaskReadSlot } from "../platform/task-read-slots.js";
import * as engine from "../engine/index.mjs";
import { ensurePrivateDirectory } from "../platform/application-paths.mjs";
import { portablePath } from "../domain/source-identity.mjs";

export interface DashboardRun {
  id: string; taskId: string; taskName: string; startedAt: string; finishedAt?: string;
  status: "complete" | "incomplete" | "failed" | "cancelled";
  type?: "full" | "incremental" | "differential";
  files: number; bytes: number; error?: string; operationId?: string;
}
export interface DashboardSnapshot { recent: DashboardRun[]; errors: Array<{ taskId: string; message: string }>; now: number }
type SavedRun = Omit<DashboardRun, "taskName">;
interface ActivityDocument { schemaVersion: 1; entries: SavedRun[] }
const LIMIT = 100;
const safeId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(value);
const instant = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));
const taskReference = (value: unknown): value is string => typeof value === "string" && !!value && value.length <= 32768 && !value.includes("\0");
const snapshotName = (value: unknown): value is string => typeof value === "string" && !!value && value.length <= 255 && !/[\\/\0]/.test(value);
const counter = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const recentOrder = (left: SavedRun, right: SavedRun) => (right.finishedAt ?? right.startedAt).localeCompare(left.finishedAt ?? left.startedAt) || right.id.localeCompare(left.id);
function mergeRuns(...groups: SavedRun[][]): SavedRun[] {
  const runs = new Map<string, SavedRun>();
  for (const group of groups) for (const run of group) runs.set(`${run.taskId}/${run.id}`, run);
  return [...runs.values()].sort(recentOrder).slice(0, LIMIT);
}
export function validateActivity(value: unknown): ActivityDocument {
  if (!record(value) || value.schemaVersion !== 1 || Object.keys(value).some(key => !["schemaVersion", "entries"].includes(key)) || !Array.isArray(value.entries) || value.entries.length > LIMIT) throw new Error("Unsupported or invalid activity summary");
  const keys = new Set<string>();
  for (const row of value.entries) {
    if (!record(row) || Object.keys(row).some(key => !["id", "taskId", "startedAt", "finishedAt", "status", "type", "files", "bytes", "error", "operationId"].includes(key)) || !snapshotName(row.id) || !taskReference(row.taskId) || !instant(row.startedAt) || row.finishedAt !== undefined && !instant(row.finishedAt) || typeof row.status !== "string" || !["complete", "incomplete", "failed", "cancelled"].includes(row.status) || row.type !== undefined && (typeof row.type !== "string" || !["full", "incremental", "differential"].includes(row.type)) || !counter(row.files) || !counter(row.bytes) || row.error !== undefined && (typeof row.error !== "string" || row.error.length > 4000) || row.operationId !== undefined && !safeId(row.operationId)) throw new Error("Invalid activity summary entry");
    const key = `${row.taskId}/${row.id}`; if (keys.has(key)) throw new Error("Duplicate activity summary entry"); keys.add(key);
  }
  return structuredClone(value) as unknown as ActivityDocument;
}

export function summarizeBackupOperation(operation: Operation): SavedRun | undefined {
  if (!["run", "resume", "retry", "scheduled-run"].includes(operation.action) || !["complete", "incomplete", "failed", "cancelled"].includes(operation.status) || !safeId(operation.id) || !taskReference(operation.taskId) || !instant(operation.startedAt)) return;
  const result = record(operation.result) ? operation.result : {}, progress = record(operation.progress) ? operation.progress : {};
  const summary: SavedRun = {
    id: snapshotName(result.id) ? result.id : operation.id, taskId: operation.taskId, operationId: operation.id,
    startedAt: instant(result.startedAt) ? result.startedAt : operation.startedAt,
    status: operation.status as SavedRun["status"],
    files: counter(result.files) ? result.files : counter(progress.files) ? progress.files : 0,
    bytes: counter(result.bytes) ? result.bytes : counter(progress.bytes) ? progress.bytes : 0,
  };
  if (instant(operation.finishedAt)) summary.finishedAt = operation.finishedAt;
  if (typeof result.type === "string" && ["full", "incremental", "differential"].includes(result.type)) summary.type = result.type as SavedRun["type"];
  const error = operation.error ?? (typeof result.error === "string" ? result.error : undefined);
  if (error) summary.error = error.slice(0, 4000);
  return summary;
}

/** Only task and snapshot metadata is read. No manifests, source files or archive verification. */
export interface DashboardInspection { taskId: string; name: string; run?: SavedRun }
export async function readLatestBackup(filename: string): Promise<DashboardInspection> {
  filename = portablePath(path.resolve(filename)); const directory = path.dirname(filename), task = (await readTaskDocument(filename)).value;
  const result: DashboardInspection = { taskId: filename, name: typeof task.name === "string" && task.name ? task.name : path.basename(directory) };
  const run = await engine.readLatestRunSummary(directory, { completeOnly: true });
  if (!run) return result;
  if (!snapshotName(run.id) || run.status !== "complete" || !["full", "incremental", "differential"].includes(run.type) || !instant(run.startedAt) || !instant(run.finishedAt) || !counter(run.files) || !counter(run.bytes)) throw new Error("Invalid latest backup summary");
  result.run = { id: run.id, taskId: filename, startedAt: run.startedAt, finishedAt: run.finishedAt, status: "complete", type: run.type as SavedRun["type"], files: run.files, bytes: run.bytes };
  const warning = run.retentionError ?? run.checkpointError ?? run.postCommitError; if (typeof warning === "string" && warning) result.run.error = warning.slice(0, 4000);
  return result;
}

interface DashboardPorts {
  directory: string;
  registry(): Promise<TaskRegistry>;
  inspect?(filename: string): Promise<DashboardInspection>;
  now?(): number;
  timeoutMs?: number;
  cacheMs?: number;
}
interface ProbeResult { signature: string; at: number; taskId?: string; name?: string; run?: SavedRun; error?: string }
interface Probe { signature: string; startedAt: number; promise: Promise<void> }
export class Dashboard {
  private memory: SavedRun[] = [];
  private activityAt = -Infinity;
  private activityError: string | undefined;
  private activityRead: Promise<void> | undefined;
  private writes = Promise.resolve();
  private pendingWrites: SavedRun[] = [];
  private saving = false;
  private cache = new Map<string, ProbeResult>();
  private queue = new Map<string, string>();
  private probes = new Map<string, Probe>();
  private changes = new Set<() => void>();
  private closed = false;
  private now: () => number;
  private filename: string;
  constructor(private readonly ports: DashboardPorts) { this.now = ports.now ?? Date.now; this.filename = path.join(ports.directory, "activity.json"); }
  private signature(filename: string) { return filename; }
  private async loadActivity() {
    if (this.activityRead) return this.activityRead;
    if (this.now() - this.activityAt < (this.ports.cacheMs ?? 5000)) return;
    this.activityRead = readDocument(this.filename, validateActivity, { schemaVersion: 1, entries: [] }).then(document => { this.memory = mergeRuns(document.value.entries, this.memory); this.activityError = undefined; }).catch(error => { this.activityError = `Saved activity could not be read: ${(error as Error).message}`; }).finally(() => { this.activityAt = this.now(); this.activityRead = undefined; });
    return this.activityRead;
  }
  record(operation: Operation): void {
    const summary = summarizeBackupOperation(operation); if (!summary || this.closed) return;
    this.memory = mergeRuns(this.memory, [summary]); for (const [key, value] of this.cache) if (value.taskId === summary.taskId) this.cache.delete(key);
    this.pendingWrites = mergeRuns(this.pendingWrites, [summary]); this.startSaving();
  }
  private startSaving() {
    if (this.saving) return;
    this.saving = true;
    this.writes = this.writes.catch(() => {}).then(async () => {
      while (this.pendingWrites.length) {
        const batch = this.pendingWrites; this.pendingWrites = [];
        try {
          await ensurePrivateDirectory(this.ports.directory);
          for (let attempt = 0; attempt < 8; attempt++) {
            const current = await readDocument(this.filename, validateActivity, { schemaVersion: 1, entries: [] });
            try { await atomicSave(this.filename, { schemaVersion: 1, entries: mergeRuns(current.value.entries, batch) }, current.revision); this.activityError = undefined; break; }
            catch (error) { if (!(error instanceof ConfigurationConflictError) || attempt === 7) throw error; }
          }
        } catch (error) { this.activityError = `Recent activity could not be saved: ${(error as Error).message}`; }
      }
    }).finally(() => {
      this.saving = false;
      if (this.pendingWrites.length) this.startSaving();
    });
  }
  invalidate(taskId?: string) { if (taskId) this.cache.delete(taskId); else this.cache.clear(); }
  private drain() {
    if (this.closed) return;
    // Slow removable/NAS reads can remain pending in the OS. Keep their slots
    // until they really settle, reserving at least two default libuv threads.
    for (const [id, entry] of this.queue) {
      if (this.probes.size >= 2) break;
      if (this.probes.has(id)) continue;
      this.queue.delete(id); const signature = this.signature(entry), startedAt = this.now();
      const promise = withTaskReadSlot(() => (this.ports.inspect ?? readLatestBackup)(entry)).then(value => { this.cache.set(id, { signature, at: this.now(), ...value }); }, error => { this.cache.set(id, { signature, at: this.now(), error: `Backup destination status is unavailable: ${(error as Error).message}` }); }).finally(() => { this.probes.delete(id); this.drain(); for (const listener of this.changes) listener(); });
      this.probes.set(id, { signature, startedAt, promise });
    }
  }
  async snapshot(): Promise<DashboardSnapshot> {
    await this.loadActivity();
    const registry = (await this.ports.registry()).map(directory => portablePath(path.join(directory, ".delta.json"))), ids = new Set(registry);
    for (const id of this.queue.keys()) if (!ids.has(id)) this.queue.delete(id);
    for (const id of this.cache.keys()) if (!ids.has(id)) this.cache.delete(id);
    const cacheMs = this.ports.cacheMs ?? 5000;
    for (const entry of registry) {
      const previous = this.cache.get(entry), signature = this.signature(entry);
      if (!previous || previous.signature !== signature || this.now() - previous.at >= cacheMs) {
        if (this.probes.get(entry)?.signature !== signature) this.queue.set(entry, entry);
      }
    }
    this.drain();
    const timeoutMs = this.ports.timeoutMs ?? 1200;
    const pending = () => [...this.probes.entries()].some(([id, job]) => ids.has(id) && this.now() - job.startedAt < timeoutMs) || this.probes.size < 2 && [...this.queue.keys()].some(id => ids.has(id));
    if (pending()) await new Promise<void>(resolve => {
      const finish = () => { clearTimeout(timer); this.changes.delete(check); resolve(); };
      const check = () => { if (!pending()) finish(); };
      const timer = setTimeout(finish, timeoutMs); this.changes.add(check); check();
    });
    const errors: DashboardSnapshot["errors"] = [], disk: SavedRun[] = [], names = new Map<string, string>();
    if (this.activityError) errors.push({ taskId: "", message: this.activityError });
    for (const entry of registry) {
      const cached = this.cache.get(entry);
      if (cached?.signature === this.signature(entry)) { if (cached.taskId) names.set(cached.taskId, cached.name ?? path.basename(path.dirname(entry))); if (cached.run) disk.push(cached.run); if (cached.error) errors.push({ taskId: entry, message: cached.error }); }
      else errors.push({ taskId: entry, message: this.probes.has(entry) ? "The backup destination is taking time to respond. Recent saved activity is shown." : "Backup destination status is waiting to be checked. Recent saved activity is shown." });
    }
    return { recent: mergeRuns(disk, this.memory).slice(0, 20).map(run => ({ ...run, taskName: names.get(run.taskId) ?? run.taskId })), errors, now: this.now() };
  }
  async close(): Promise<void> { this.closed = true; this.queue.clear(); while (this.saving || this.pendingWrites.length) { if (!this.saving) this.startSaving(); await this.writes; } }
}
