import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream, readFileSync, statSync } from "node:fs";
import { mkdir, open, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ConfigurationStore } from "../config/index.js";
import { runBackup, verifyRun, restoreRun } from "../engine/index.mjs";
import { createVssSourceProvider, type VssSourceSession } from "../platform/vss.js";
import { runtimeInfo } from "./runtime.js";
import { resolveTaskSources } from "../domain/source-identity.mjs";

interface ProbeReport {
  schemaVersion: 1; probe: "vss-application"; status: "unverified" | "passed" | "blocked" | "failed";
  createdAt: string; finishedAt?: string; mode: "snapshot-only" | "writers"; reportPath: string;
  fixture: string; runtime: ReturnType<typeof runtimeInfo>; checks: Array<{ name: string; status: "passed"; detail?: unknown }>;
  nativeClientLaunches: number; helperPath?: string; helperSha256?: string; helperUnchangedDuringQualification?: boolean; cliSha256?: string; runId?: string; cleanupVerified: boolean;
  engineRun?: { status: string; error?: string; cleanupError?: string; files: number; bytes: number };
  error?: string; cleanupErrors?: string[]; currentTokenUnelevated?: boolean; tokenEvidence?: string;
}
async function sha256(filename: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash("sha256"); for await (const chunk of createReadStream(filename, { highWaterMark: 64 * 1024, signal })) hash.update(chunk); return hash.digest("hex");
}
async function durableFile(filename: string, value: string) {
  const file = await open(filename, "w", 0o600); try { await file.writeFile(value, "utf8"); await file.sync(); } finally { await file.close(); }
}
async function saveReport(report: ProbeReport) {
  const temporary = `${report.reportPath}.${randomUUID()}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try { await file.writeFile(`${JSON.stringify(report, null, 2)}\n`, "utf8"); await file.sync(); } finally { await file.close(); }
  await rename(temporary, report.reportPath);
}

/** Manual qualification only: real UAC, real snapshots and ordinary Node reads. */
export async function runVssApplicationProbe(options: { reportPath?: string; writers?: boolean } = {}): Promise<ProbeReport> {
  const id = randomUUID();
  const parent = options.reportPath ? path.dirname(path.resolve(options.reportPath)) : path.join(tmpdir(), "delta-qualifications");
  const fixture = path.join(parent, `vss-application-${id}`);
  const report: ProbeReport = {
    schemaVersion: 1, probe: "vss-application", status: "unverified", createdAt: new Date().toISOString(),
    mode: options.writers ? "writers" : "snapshot-only", reportPath: options.reportPath ? path.resolve(options.reportPath) : path.join(fixture, "report.json"),
    fixture, runtime: runtimeInfo(), checks: [], nativeClientLaunches: 0, cleanupVerified: false,
  };
  await mkdir(parent, { recursive: true }); await mkdir(fixture);
  const controller = new AbortController(); const cancel = () => controller.abort(new Error("VSS application qualification cancelled"));
  const deadline = setTimeout(() => controller.abort(new Error("VSS application qualification exceeded ten minutes")), 10 * 60_000); deadline.unref();
  process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
  let active: VssSourceSession | undefined; let cleanupFailed = false;
  const provider = createVssSourceProvider({ persistent: true, launch(executable, arguments_) {
    report.nativeClientLaunches++; report.helperPath = executable;
    if (!statSync(executable).isFile() || statSync(executable).size > 16 * 1024 * 1024) throw new Error("Unexpected native VSS helper artifact size");
    const hash = createHash("sha256").update(readFileSync(executable)).digest("hex");
    if (report.helperSha256 && report.helperSha256 !== hash) throw new Error("Native VSS helper changed between client launches");
    report.helperSha256 = hash;
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(NODE_|ELECTRON_)/i.test(key)));
    return spawn(executable, [...arguments_], { windowsHide: true, stdio: "pipe", env });
  } });
  const check = (name: string, condition: unknown, detail?: unknown) => {
    controller.signal.throwIfAborted(); if (!condition) throw new Error(`VSS application qualification failed: ${name}`);
    report.checks.push({ name, status: "passed", ...(detail === undefined ? {} : { detail }) });
  };
  // A forced termination must leave this attempt unverified, rather than an
  // older successful report at the requested latest-report path.
  await saveReport(report);
  try {
    if (process.platform !== "win32") { report.status = "blocked"; throw new Error("VSS application qualification requires Windows"); }
    report.cliSha256 = await sha256(process.execPath, controller.signal);
    const source = path.join(fixture, "źródło"), destination = path.join(fixture, "backup"), output = path.join(fixture, "restored");
    await Promise.all([mkdir(source), mkdir(destination), mkdir(output)]);
    const live = path.join(source, "marker-żółć.txt"); const original = "Delta original — zażółć Δ 日本語 🌍\n".repeat(4096); const updated = "Delta changed after snapshot — inny stan 密碼\n".repeat(4097);
    await durableFile(live, original); const before = await sha256(live, controller.signal);
    const store = new ConfigurationStore({ configDirectory: path.join(fixture, "catalog") }); await store.initialize();
    const loaded = await store.createTask({ directory: destination, name: "Isolated VSS qualification", sources: [{ path: source }], settings: {
      snapshot: { mode: report.mode, fallback: "fail" }, detection: "hash", symlinks: "follow",
      archive: { level: 0 }, behavior: { continueOnFileError: false },
    } });
    const task = loaded.value, sources = resolveTaskSources(task); const sourceId = sources[0]!.id;
    active = await provider.prepare(task, { sources, signal: controller.signal });
    check("real-native-snapshot-lease-created", active.consistentSnapshot === true);
    report.currentTokenUnelevated = true;
    report.tokenEvidence = "Native client inherited the CLI primary token and attested non-elevated operation; Node opens snapshot files directly under its unchanged token";
    const firstPath = path.join(active.sources.find(item => item.id === sourceId)!.path, path.basename(live));
    check("ordinary-node-reads-original-snapshot", await sha256(firstPath, controller.signal) === before);
    await durableFile(live, updated); const after = await sha256(live, controller.signal);
    check("live-fixture-changed", after !== before);
    check("snapshot-retains-original-after-live-change", await sha256(firstPath, controller.signal) === before);
    await active.release({ success: true }); active = undefined; check("first-lease-owned-snapshots-cleaned", true);
    active = await provider.prepare(task, { sources, signal: controller.signal });
    const secondPath = path.join(active.sources.find(item => item.id === sourceId)!.path, path.basename(live));
    check("next-snapshot-sees-new-live-state", await sha256(secondPath, controller.signal) === after);
    await active.release({ success: true }); active = undefined; check("second-lease-owned-snapshots-cleaned", true);
    check("persistent-native-session-reused", report.nativeClientLaunches === 1, { nativeClientLaunches: report.nativeClientLaunches });
    const run = await runBackup(task, destination, { sourceProvider: provider, signal: controller.signal }); report.runId = run.id;
    report.engineRun = { status: run.status, error: run.error, cleanupError: run.cleanupError, files: run.files, bytes: run.bytes };
    if (run.cleanupError) { cleanupFailed = true; throw new Error(`Engine VSS cleanup failed: ${run.cleanupError}`); }
    check("actual-engine-backup-committed-with-snapshot", run.status === "complete" && run.consistentSnapshot === true && run.sourceConsistency === "snapshot", { runId: run.id, files: run.files, bytes: run.bytes });
    const verified = await verifyRun(destination, run.id, { signal: controller.signal }); check("actual-engine-verification", verified.status === "complete");
    const restored = await restoreRun(destination, run.id, output, { signal: controller.signal });
    check("actual-engine-restore", restored.status === "complete" && await sha256(path.join(output, path.basename(live)), controller.signal) === after);
    check("engine-reused-same-native-session", report.nativeClientLaunches === 1);
    report.status = "passed";
  } catch (error) {
    if (report.status !== "blocked") report.status = "failed";
    report.error = error instanceof Error ? error.message.slice(0, 8000) : String(error).slice(0, 8000);
  } finally {
    const cleanupErrors: string[] = [];
    if (active) try { await active.release({ success: false }); } catch (error) { cleanupErrors.push(error instanceof Error ? error.message : String(error)); }
    try { await provider.shutdown(); } catch (error) { cleanupErrors.push(error instanceof Error ? error.message : String(error)); }
    report.cleanupVerified = !cleanupFailed && cleanupErrors.length === 0;
    if (cleanupErrors.length) { report.cleanupErrors = cleanupErrors.map(value => value.slice(0, 4000)); report.status = "failed"; }
    if (report.helperPath) try {
      report.helperUnchangedDuringQualification = await sha256(report.helperPath) === report.helperSha256;
      if (!report.helperUnchangedDuringQualification) { report.status = "failed"; report.error = "Helper artifact changed during qualification"; }
    } catch (error) { report.status = "failed"; report.error = `Helper artifact could not be hashed: ${error instanceof Error ? error.message : String(error)}`; }
    if (controller.signal.aborted && report.status === "passed") { report.status = "failed"; report.error = String(controller.signal.reason); }
    clearTimeout(deadline); process.off("SIGINT", cancel); process.off("SIGTERM", cancel);
    report.finishedAt = new Date().toISOString(); await saveReport(report);
  }
  return report;
}
