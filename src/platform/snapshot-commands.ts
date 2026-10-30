import { spawn } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

const COMMANDS = new Set(["btrfs", "findmnt", "mount", "umount", "zfs", "lvs", "lvcreate", "lvremove"]);
export interface SnapshotCommandOptions { signal?: AbortSignal; timeoutMs?: number; maxOutput?: number }
export interface SnapshotCommandResult { stdout: string; stderr: string }

/** Privileged commands never come from task configuration, PATH or a shell. */
export async function trustedSnapshotCommand(name: string): Promise<string> {
  if (!COMMANDS.has(name)) throw new Error("Snapshot helper rejected an unknown command");
  for (const directory of ["/usr/sbin", "/sbin", "/usr/bin", "/bin", "/usr/local/sbin", "/usr/local/bin", "/run/current-system/sw/bin"]) {
    let executable: string;
    try { executable = await realpath(path.posix.join(directory, name)); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    let current = executable;
    for (;;) {
      const details = await lstat(current);
      if (details.uid !== 0 || (details.mode & 0o022) !== 0 || details.isSymbolicLink() || (current === executable ? !details.isFile() || !(details.mode & 0o111) : !details.isDirectory())) throw new Error(`Snapshot command has an unsafe owner or permissions: ${current}`);
      if (current === "/") break;
      current = path.posix.dirname(current);
    }
    return executable;
  }
  throw Object.assign(new Error(`Required snapshot tool is not installed: ${name}`), { code: "SNAPSHOT_TOOL_MISSING", cleanupVerified: true });
}

export async function runSnapshotCommand(name: string, arguments_: string[], options: SnapshotCommandOptions = {}): Promise<SnapshotCommandResult> {
  if (!Array.isArray(arguments_) || arguments_.length > 1024 || arguments_.some(value => typeof value !== "string" || value.includes("\0") || value.length > 32768)) throw new Error("Invalid snapshot command arguments");
  const executable = await trustedSnapshotCommand(name), limit = options.maxOutput ?? 4 * 1024 * 1024, timeout = options.timeoutMs ?? 120_000;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 16 * 1024 * 1024 || !Number.isSafeInteger(timeout) || timeout < 1 || timeout > 600_000) throw new Error("Invalid snapshot command bounds");
  options.signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(executable, arguments_, { stdio: ["ignore", "pipe", "pipe"], env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LC_ALL: "C", LANG: "C", HOME: "/root" }, windowsHide: true });
    const output: Buffer[] = [], diagnostics: Buffer[] = []; let bytes = 0, diagnosticBytes = 0, failure: Error | undefined, killTimer: NodeJS.Timeout | undefined;
    const terminate = (error: Error) => { if (failure) return; failure = error; child.kill("SIGTERM"); killTimer = setTimeout(() => child.kill("SIGKILL"), 5000); killTimer.unref(); };
    const abort = () => terminate(Object.assign(new Error("Snapshot command was cancelled"), { code: "ABORT_ERR" }));
    const timer = setTimeout(() => terminate(new Error(`Snapshot command timed out: ${name}`)), timeout);
    options.signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > limit) terminate(new Error(`Snapshot command exceeded its output limit: ${name}`)); else output.push(chunk); });
    child.stderr.on("data", (chunk: Buffer) => { diagnosticBytes += chunk.length; if (diagnosticBytes > 65536) terminate(new Error(`Snapshot command exceeded its diagnostic limit: ${name}`)); else diagnostics.push(chunk); });
    child.once("error", error => { failure ??= error; });
    child.once("close", (code, signal) => {
      clearTimeout(timer); clearTimeout(killTimer); options.signal?.removeEventListener("abort", abort);
      if (failure) { reject(failure); return; }
      const stdout = Buffer.concat(output).toString("utf8"), stderr = Buffer.concat(diagnostics).toString("utf8");
      if (code !== 0) { reject(Object.assign(new Error(`${name} failed (${signal ?? code}): ${stderr.slice(0, 4000)}`), { code: "SNAPSHOT_COMMAND_FAILED" })); return; }
      resolve({ stdout, stderr });
    });
    if (options.signal?.aborted) abort();
  });
}
