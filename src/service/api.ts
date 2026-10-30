import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { ConfigurationStore, type CreateTaskOptions, type LoadedTask } from "../config/index.js";
import { executeEngine, type EngineExecutor, type EngineRequest } from "./engine-executor.js";
import { Dashboard } from "./dashboard.js";
import { runtimeDirectory } from "../platform/application-paths.mjs";
import { PauseController } from "./pause.js";

export interface ApiRequest { action: string; [key: string]: unknown }
export interface Operation {
  id: string; taskId: string; action: string;
  status: "queued" | "running" | "complete" | "incomplete" | "cancelled" | "failed";
  startedAt: string; finishedAt?: string; paused?: boolean; progress?: unknown; result?: unknown; error?: string; code?: string;
}
function text(value: unknown, name: string) {
  if (typeof value !== "string" || !value || value.length > 32768 || value.includes("\0")) throw new Error(`Invalid ${name}`);
  return value;
}

export class ApplicationService extends EventEmitter {
  readonly store: ConfigurationStore;
  private dashboard: Dashboard;
  readonly operations = new Map<string, Operation>();
  readonly ready: Promise<void>;
  private controllers = new Map<string, AbortController>();
  private pauseControllers = new Map<string, PauseController>();
  private queue: Array<{ operation: Operation; request: EngineRequest; controller: AbortController }> = [];
  private active = 0;
  private maximumConcurrent = 1;
  private stopping = false;
  private withdrawn = new Map<string, number>();
  constructor(options: { homeDirectory?: string; configDirectory?: string; executor?: EngineExecutor } = {}) {
    super();
    this.setMaxListeners(512);
    this.store = new ConfigurationStore(options);
    this.dashboard = new Dashboard({ directory: runtimeDirectory(this.store.directory), registry: async () => (await this.store.readRegistry()).value });
    this.executor = options.executor ?? executeEngine;
    this.ready = this.store.initialize().then(async () => { this.maximumConcurrent = (await this.store.readApp()).value.maxConcurrentTasks; });
  }
  private executor: EngineExecutor;
  async resolveTask(reference: string): Promise<LoadedTask> {
    await this.ready;
    const remembered = await this.store.findRememberedTask(reference);
    if (remembered) return this.store.loadTask(remembered);
    return this.store.loadTask(path.resolve(reference));
  }

  private async read(request: EngineRequest) { return this.executor(request, () => {}, new AbortController().signal); }
  private update(operation: Operation) { this.dashboard.record(operation); this.emit("operation", { ...operation }); }
  private pruneOperations() {
    while (this.operations.size > 100) {
      const oldest = [...this.operations.values()].find(value => !["queued", "running"].includes(value.status));
      if (!oldest) break;
      this.operations.delete(oldest.id);
    }
  }
  private enqueue(request: EngineRequest, taskId: string, requestedId?: string) {
    if (this.stopping) throw new Error("The application is shutting down");
    if (this.queue.length >= 128) throw new Error("Operation queue is full");
    if ([...this.operations.values()].some(operation => operation.taskId === taskId && ["running", "queued"].includes(operation.status))) throw new Error("An operation is already active for this task");
    const operation: Operation = { id: requestedId ?? randomUUID(), taskId, action: request.action, status: "queued", paused: false, startedAt: new Date().toISOString() };
    if (this.operations.has(operation.id)) throw new Error("Operation ID was already used");
    if (this.withdrawn.delete(operation.id)) {
      operation.status = "cancelled"; operation.finishedAt = new Date().toISOString();
      this.operations.set(operation.id, operation); this.pruneOperations(); this.update(operation); return { ...operation };
    }
    const controller = new AbortController();
    this.operations.set(operation.id, operation);
    this.controllers.set(operation.id, controller);
    this.pauseControllers.set(operation.id, new PauseController(controller.signal));
    this.queue.push({ operation, request, controller });
    this.update(operation);
    this.pump();
    return { ...operation };
  }
  private pump() {
    while (this.active < this.maximumConcurrent && this.queue.length) {
      const runnable = this.queue.findIndex(item => !item.operation.paused);
      if (runnable < 0) return;
      const item = this.queue.splice(runnable, 1)[0]!;
      const { operation, request, controller } = item;
      if (controller.signal.aborted) continue;
      this.active++;
      operation.status = "running";
      this.update(operation);
      let lastProgress = 0;
      let lastProgressPhase: unknown;
      this.executor(request, progress => {
        operation.progress = progress;
        const phase = progress && typeof progress === "object" && "phase" in progress ? progress.phase : undefined, now = Date.now();
        if (phase !== lastProgressPhase || now - lastProgress >= 150) { lastProgress = now; lastProgressPhase = phase; this.update(operation); }
      }, controller.signal, undefined, this.pauseControllers.get(operation.id)).then(result => {
        operation.result = result;
        const status = (result as { status?: unknown } | null)?.status;
        const cleanupError = (result as { cleanupError?: string } | null)?.cleanupError;
        operation.status = cleanupError ? "failed" : status === "complete" ? "complete" : status === "incomplete" || status === "blocked" ? "incomplete" : status === "failed" ? "failed" : controller.signal.aborted || status === "cancelled" ? "cancelled" : "complete";
        if (cleanupError) { operation.error = cleanupError; operation.code = "CLEANUP_UNVERIFIED"; }
        else {
          const warnings = result as { retentionError?: string; checkpointError?: string } | null;
          if (warnings?.retentionError || warnings?.checkpointError) operation.error = `Backup data is committed; follow-up warning: ${warnings.retentionError ?? warnings.checkpointError}`;
        }
      }, error => {
        operation.status = controller.signal.aborted && (error as { code?: string }).code !== "CLEANUP_UNVERIFIED" ? "cancelled" : "failed";
        operation.error = error instanceof Error ? error.message : String(error);
        operation.code = typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : undefined;
      }).finally(() => {
        operation.finishedAt = new Date().toISOString();
        operation.paused = false;
        this.active--;
        this.controllers.delete(operation.id);
        this.pauseControllers.get(operation.id)?.dispose(); this.pauseControllers.delete(operation.id);
        this.update(operation);
        this.pruneOperations();
        this.pump();
      });
    }
  }
  cancel(operationId: string) {
    const operation = this.operations.get(operationId);
    if (!operation && /^[0-9a-f-]{36}$/i.test(operationId)) {
      this.withdrawn.set(operationId, Date.now());
      for (const [id, at] of this.withdrawn) if (Date.now() - at > 300_000 || this.withdrawn.size > 256) this.withdrawn.delete(id);
    }
    this.controllers.get(operationId)?.abort(new Error("Cancelled by user"));
    if (operation?.status === "queued") {
      operation.status = "cancelled"; operation.paused = false; operation.finishedAt = new Date().toISOString();
      this.queue = this.queue.filter(item => item.operation.id !== operationId);
      this.controllers.delete(operationId);
      this.pauseControllers.get(operationId)?.dispose(); this.pauseControllers.delete(operationId);
      this.update(operation);
    }
    return operation;
  }
  setPaused(operationId: string, paused: boolean): Operation {
    const operation = this.operations.get(operationId), control = this.pauseControllers.get(operationId);
    if (!operation || !control || !["queued", "running"].includes(operation.status)) throw new Error("This operation is no longer active");
    if (!["run", "resume", "retry"].includes(operation.action)) throw new Error("Only backup operations can be paused");
    if (this.stopping) throw new Error("The application is shutting down");
    control.setPaused(paused); operation.paused = paused; this.update(operation);
    if (!paused) this.pump();
    return { ...operation };
  }
  reportFailure(taskId: string, action: string, error: unknown) {
    const timestamp = new Date().toISOString();
    const operation: Operation = { id: randomUUID(), taskId, action, status: "failed", startedAt: timestamp, finishedAt: timestamp, error: error instanceof Error ? error.message : String(error) };
    this.operations.set(operation.id, operation); this.pruneOperations(); this.update(operation);
  }
  async wait(operationId: string): Promise<Operation> {
    const current = this.operations.get(operationId);
    if (!current) throw new Error("Unknown operation");
    if (!["queued", "running"].includes(current.status)) return current;
    return new Promise(resolve => {
      const listener = (operation: Operation) => {
        if (operation.id === operationId && !["queued", "running"].includes(operation.status)) { this.off("operation", listener); resolve(operation); }
      };
      this.on("operation", listener);
    });
  }
  async shutdown() {
    this.stopping = true;
    const running = [...this.operations.keys()];
    for (const id of running) this.cancel(id);
    await Promise.all(running.map(id => this.wait(id)));
    await this.dashboard.close();
  }
  async request(request: ApiRequest): Promise<unknown> {
    await this.ready;
    if (!request || typeof request !== "object" || typeof request.action !== "string") throw new Error("Invalid request");
    for (const field of ["password", "rawPassword", "rememberPassword", "credentialRef", "encryption"]) if (Object.hasOwn(request, field)) throw new Error(`Unsupported request field: ${field}`);
    switch (request.action) {
      case "dashboard": return this.dashboard.snapshot();
      case "bootstrap": {
        const [app, defaults, tasks] = await Promise.all([this.store.readApp(), this.store.readDefaults(), this.store.listTasks()]);
        return { app, defaults, tasks, operations: [...this.operations.values()] };
      }
      case "load": return this.resolveTask(text(request.reference, "task reference"));
      case "discover": return this.store.discoverTask(text(request.directory, "directory"));
      case "relink": return this.store.relinkTask(text(request.reference, "task reference"), text(request.directory, "directory"));
      case "forget": return this.store.forgetTask(text(request.reference, "task reference"));
      case "create": {
        const loaded = await this.store.createTask({ directory: text(request.directory, "directory"), name: text(request.name, "name"), sources: request.sources as CreateTaskOptions["sources"], settings: request.settings as CreateTaskOptions["settings"] });
        return loaded;
      }
      case "save": {
        const loaded = await this.resolveTask(text(request.reference, "task reference"));
        if (request.revision !== loaded.revision) throw new Error("Task was changed externally; reload before saving");
        const patch = structuredClone(request.patch ?? {}) as Record<string, unknown>;
        return this.store.saveTask(loaded, patch);
      }
      case "duplicate-draft": return this.store.prepareDuplicateTask(await this.resolveTask(text(request.reference, "task reference")));
      case "duplicate": return this.store.duplicateTask(await this.resolveTask(text(request.reference, "task reference")), { directory: text(request.directory, "directory"), name: typeof request.name === "string" ? request.name : undefined });
      case "app-save": {
        const result = await this.store.saveApp(request.value, request.revision as string | null);
        this.maximumConcurrent = result.value.maxConcurrentTasks; this.pump(); return result;
      }
      case "defaults-save": return this.store.saveDefaults(request.value, request.revision as string | null);
      case "operations": {
        if (request.summary !== undefined && typeof request.summary !== "boolean") throw new Error("Invalid operation summary option");
        const values = request.operationId === undefined ? [...this.operations.values()] : [this.operations.get(text(request.operationId, "operation ID"))].filter((value): value is Operation => Boolean(value));
        return request.summary ? values.map(({ result: _result, ...summary }) => summary) : values;
      }
      case "cancel": return this.cancel(text(request.operationId, "operation ID"));
      case "pause": return this.setPaused(text(request.operationId, "operation ID"), true);
      case "resume-operation": return this.setPaused(text(request.operationId, "operation ID"), false);
      case "history": case "files": case "details": case "pin": {
        const loaded = await this.resolveTask(text(request.reference, "task reference"));
        if (request.action === "pin" && typeof request.pinned !== "boolean") throw new Error("Invalid pinned value");
        return this.read({ action: request.action, directory: loaded.directory, runId: request.action === "history" ? undefined : text(request.runId, "run ID"), pinned: request.pinned as boolean, offset: request.offset as number, limit: request.limit as number, query: request.query as string });
      }
      case "run": case "resume": case "retry": case "verify": case "restore": case "restore-plan": case "retention": case "delete": {
        const operationId = request.operationId === undefined ? undefined : text(request.operationId, "operation ID");
        if (operationId && !/^[0-9a-f-]{36}$/i.test(operationId)) throw new Error("Invalid operation ID");
        const loaded = await this.resolveTask(text(request.reference, "task reference"));
        await this.store.assertTaskDestination(loaded);
        const runId = ["run", "retention"].includes(request.action) ? undefined : text(request.runId, "run ID");
        const effectiveTask = structuredClone(loaded.value);
        if (request.overwrite !== undefined && !["error", "skip", "replace"].includes(request.overwrite as string)) throw new Error("Invalid overwrite policy");
        if (request.paths !== undefined && (!Array.isArray(request.paths) || request.paths.length > 10000 || request.paths.some(value => typeof value !== "string" || value.length > 32768))) throw new Error("Invalid restore selection");
        return this.enqueue({ action: request.action, task: effectiveTask, directory: loaded.directory, runId, outputDirectory: ["restore", "restore-plan"].includes(request.action) ? text(request.outputDirectory, "output directory") : undefined, paths: request.paths as string[], overwrite: request.overwrite as "error" | "skip" | "replace" }, loaded.id, operationId);
      }
      default: throw new Error(`Unknown action: ${request.action}`);
    }
  }
}
