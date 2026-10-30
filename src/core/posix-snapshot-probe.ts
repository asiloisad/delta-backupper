import { mkdtemp, mkdir, realpath, lstat, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ConfigurationStore } from "../config/index.js";
import { createSnapshotSourceProvider } from "../platform/snapshots.js";
import { runBackup, verifyRun, restoreRun } from "../engine/index.mjs";

/** Human-invoked native qualification: creates only new UUID fixtures and never reformats a disk. */
export async function runPosixSnapshotProbe(options: { sourceDirectory: string; reportPath?: string }) {
  if (process.platform !== "linux" && process.platform !== "darwin") throw new Error("Run this probe natively on Linux or macOS as your normal user");
  if (process.getuid?.() === 0) throw new Error("Run delta probe snapshots as your normal user; its helper requests authorization separately");
  const parent = await realpath(path.resolve(options.sourceDirectory)); const parentInfo = await lstat(parent);
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) throw new Error("--source-directory must identify a local directory on the file system being qualified");
  const source = await mkdtemp(path.join(parent, "delta-snapshot-qualification-")), fixture = await mkdtemp(path.join(tmpdir(), "delta-snapshot-result-"));
  const ownership = { kind: "delta-native-snapshot-qualification", schemaVersion: 1, id: randomUUID() }; await writeFile(path.join(source, ".delta-qualification.json"), JSON.stringify(ownership), { flag: "wx", mode: 0o600 });
  const reportFile = path.resolve(options.reportPath ?? path.join(fixture, "report.json"));
  const report: Record<string, any> = { schemaVersion: 1, timestamp: new Date().toISOString(), platform: process.platform, status: "running", source, fixture, reportFile, ownership, checks: [], cleanupVerified: false, scope: "Actual native snapshot through the ordinary-user CLI and authorized helper; mutate only newly created source fixture after snapshot preparation, backup/verify/restore original bytes. Does not qualify power loss, forced helper death, all file systems or application-level consistency." };
  const save = async () => { await mkdir(path.dirname(reportFile), { recursive: true }); await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`); };
  await save();
  const controller = new AbortController(), provider = createSnapshotSourceProvider();
  const abort = () => controller.abort(new Error("Native snapshot qualification was cancelled")); process.once("SIGINT", abort); process.once("SIGTERM", abort);
  const original = "Delta native snapshot — original contents\n".repeat(1024), changed = "Delta native snapshot — live file changed\n".repeat(1024), sourceFile = path.join(source, "snapshot-unicode-żółć.txt"); await writeFile(sourceFile, original);
  let prepared = false, released = false;
  try {
    const directory = path.join(fixture, "backup"); await mkdir(directory); const store = new ConfigurationStore({ configDirectory: path.join(fixture, "profile") }); await store.initialize();
    const task = await store.createTask({ directory, name: "Native snapshot qualification", sources: [{ path: source }], settings: { snapshot: { mode: "snapshot-only", fallback: "fail" }, archive: { level: 0 }, detection: "hash" } });
    const summary = await runBackup(task.value, directory, { signal: controller.signal, sourceProvider: {
      async prepare(task, execution) {
        const session = await provider.prepare(task, execution); prepared = true;
        await writeFile(sourceFile, changed);
        return { ...session, async release(outcome) { await session.release(outcome); released = true; } };
      },
    } });
    if (summary.status !== "complete" || summary.consistentSnapshot !== true || summary.sourceConsistency !== "filesystem-snapshot" || !released) throw new Error("Backup did not confirm a complete filesystem snapshot and verified lease cleanup");
    report.summary = summary; report.checks.push("backup uses a real file-system snapshot", "live mutation occurs after snapshot preparation", "lease cleanup completes before publication");
    const verification = await verifyRun(directory, summary.id, { signal: controller.signal }); if (verification.status !== "complete") throw new Error("Snapshot archive verification failed"); report.checks.push("all committed ZIP contents verify");
    const output = path.join(fixture, "restored"); const restored = await restoreRun(directory, summary.id, output, { signal: controller.signal }); if (restored.status !== "complete") throw new Error("Snapshot restore failed");
    if (await readFile(path.join(output, path.basename(sourceFile)), "utf8") !== original || await readFile(sourceFile, "utf8") !== changed) throw new Error("Restored data did not retain the snapshot while live data changed");
    report.checks.push("restore contains the original snapshot bytes", "live source retains the later changed bytes"); report.status = "passed"; report.cleanupVerified = true;
  } catch (error) {
    const value = error as { code?: string; cleanupVerified?: boolean };
    report.status = /PERMISSION|ENTITLEMENT|AUTHORIZATION|UNSUPPORTED|MISSING|NORMAL_USER/.test(value.code ?? "") && value.cleanupVerified === true ? "blocked" : "failed";
    report.error = error instanceof Error ? error.message : String(error); report.code = value.code; report.cleanupVerified = released || !prepared && value.cleanupVerified === true;
  } finally {
    process.off("SIGINT", abort); process.off("SIGTERM", abort);
    try { await provider.shutdown(); } catch (error) { report.status = "failed"; report.cleanupVerified = false; report.cleanupError = error instanceof Error ? error.message : String(error); }
    report.finishedAt = new Date().toISOString(); await save();
  }
  return report;
}
