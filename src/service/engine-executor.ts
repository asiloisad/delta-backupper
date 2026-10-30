import * as engine from "../engine/index.mjs";
import type { TaskConfig } from "../domain/models.js";
import type { EngineExecutionControl } from "./pause.js";

export interface EngineRequest {
  action: "run" | "resume" | "retry" | "verify" | "restore" | "restore-plan" | "history" | "files" | "details" | "pin" | "retention" | "delete";
  directory: string;
  task?: TaskConfig;
  runId?: string;
  outputDirectory?: string;
  paths?: string[];
  overwrite?: "error" | "skip" | "replace";
  pinned?: boolean;
  offset?: number;
  limit?: number;
  query?: string;
}
export type SourceProvider = NonNullable<engine.EngineOptions["sourceProvider"]>;
export type EngineExecutor = (request: EngineRequest, progress: (value: unknown) => void, signal: AbortSignal, sourceProvider?: SourceProvider, control?: EngineExecutionControl) => Promise<unknown>;

export const executeEngine: EngineExecutor = async (request, onProgress, signal, sourceProvider, control) => {
  await control?.waitIfPaused();
  const options: Record<string, unknown> = { signal, onProgress, ...(control ? { waitIfPaused: () => control.waitIfPaused() } : {}) };
  if (request.task?.snapshot.mode !== undefined && request.task.snapshot.mode !== "off") {
    const { createSnapshotSourceProvider } = await import("../platform/snapshots.js");
    options.sourceProvider = sourceProvider ?? createSnapshotSourceProvider();
  }
  switch (request.action) {
    case "run": return engine.runBackup(request.task!, request.directory, options);
    case "resume": return engine.resumeRun(request.task!, request.directory, request.runId!, options);
    case "retry": return engine.retryRun(request.task!, request.directory, request.runId!, options);
    case "history": return engine.listRuns(request.directory, { includeUncommitted: true });
    case "details": return engine.getRunDetails(request.directory, request.runId!);
    case "files": return engine.listRunEntries(request.directory, request.runId!, { offset: request.offset, limit: request.limit, query: request.query });
    case "verify": return engine.verifyRun(request.directory, request.runId!, options);
    case "restore": return engine.restoreRun(request.directory, request.runId!, request.outputDirectory!, { ...options, paths: request.paths, overwrite: request.overwrite });
    case "restore-plan": return engine.planRestore(request.directory, request.runId!, request.outputDirectory!, { ...options, paths: request.paths, overwrite: request.overwrite });
    case "pin": return engine.pinRun(request.directory, request.runId!, request.pinned!);
    case "retention": return engine.applyRetention(request.task!, request.directory, { signal });
    case "delete": return engine.deleteRun(request.task!, request.directory, request.runId!, options);
  }
};
