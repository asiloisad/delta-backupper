import { executeEngine, type EngineRequest } from "./service/engine-executor.js";
import { randomUUID } from "node:crypto";
import { attachSnapshotSourceSession } from "./platform/snapshots.js";
import { PauseController } from "./service/pause.js";

if (!process.parentPort) throw new Error("Parent message port is unavailable");
const controller = new AbortController();
const pause = new PauseController(controller.signal);
let started = false;
let finished = false;
let lastProgressAt = 0;
let lastProgressPhase: unknown;
let latestProgress: unknown;
const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
function control(type: string, data: object): Promise<unknown> {
  const id = randomUUID();
  return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); process.parentPort!.postMessage({ type, id, ...data }); });
}
process.parentPort.on("message", (event: { data: { type: string; request?: EngineRequest; id?: string; error?: string; code?: string; cleanupVerified?: boolean; value?: unknown } }) => {
  if (event.data.type === "snapshot-response" && event.data.id) {
    const handler = pending.get(event.data.id); pending.delete(event.data.id);
    if (event.data.error) handler?.reject(Object.assign(new Error(event.data.error), { code: event.data.code, cleanupVerified: event.data.cleanupVerified })); else handler?.resolve(event.data.value);
    return;
  }
  if (event.data.type === "finish" && finished) { process.exit(process.exitCode ?? 0); }
  if (event.data.type === "cancel") { controller.abort(new Error("Cancelled by user")); return; }
  if (event.data.type === "pause" || event.data.type === "resume") { if (!controller.signal.aborted && !finished) pause.setPaused(event.data.type === "pause"); return; }
  if (event.data.type !== "execute" || started || !event.data.request) return;
  started = true;
  executeEngine(event.data.request, progress => {
    latestProgress = progress;
    const phase = progress && typeof progress === "object" && "phase" in progress ? progress.phase : undefined, now = Date.now();
    if (phase !== lastProgressPhase || now - lastProgressAt >= 150) { lastProgressAt = now; lastProgressPhase = phase; process.parentPort!.postMessage({ type: "progress", value: progress }); }
  }, controller.signal, {
    async prepare(task, options) {
      const response = await control("snapshot-prepare", { sources: options.sources }) as { snapshotLease: Record<string, unknown> };
      try {
        return attachSnapshotSourceSession(task, options.sources, response.snapshotLease, async (outcome?: { success: boolean }) => { await control("snapshot-release", { outcome: outcome ?? { success: true } }); }, controller.signal, async health => { await control("snapshot-verify", { fresh: health?.fresh !== false }); });
      } catch (error) {
        try { await control("snapshot-release", { outcome: { success: false } }); }
        catch (cleanupError) { throw Object.assign(new AggregateError([error, cleanupError], "Snapshot attachment failed and cleanup was not verified"), { code: "SNAPSHOT_CLEANUP_UNVERIFIED", cleanupVerified: false }); }
        throw Object.assign(error instanceof Error ? error : new Error(String(error)), { cleanupVerified: true });
      }
    },
  }, pause).then(
    result => { pause.dispose(); if (latestProgress) process.parentPort!.postMessage({ type: "progress", value: latestProgress }); process.exitCode = 0; finished = true; process.parentPort!.postMessage({ type: "result", value: result }); },
    error => { pause.dispose(); process.exitCode = 1; finished = true; process.parentPort!.postMessage({ type: "error", message: error instanceof Error ? error.message : String(error), code: (error as { code?: string }).code, cleanupVerified: (error as { cleanupVerified?: boolean }).cleanupVerified }); },
  );
});
process.parentPort.postMessage({ type: "ready" });
