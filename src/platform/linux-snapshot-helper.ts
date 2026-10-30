import { connect } from "node:net";
import { mkdir, lstat, realpath, rmdir, readFile, readdir, rename, unlink, open } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { prepareLinuxSnapshots, recoverLinuxSnapshots, type LinuxSnapshotLease, type SnapshotSourceRoot } from "./linux-snapshots.js";
import { runSnapshotCommand } from "./snapshot-commands.js";
import { SnapshotWire } from "./snapshot-wire.js";

export function parseSnapshotHelperArguments(arguments_: string[]): { socket: string; nonce: string; uid: number; gid: number } {
  if (arguments_.length !== 8) throw new Error("Snapshot helper requires exact socket, nonce, uid and gid arguments");
  const values = new Map<string, string>();
  for (let index = 0; index < arguments_.length; index += 2) {
    const key = arguments_[index]!, value = arguments_[index + 1]!;
    if (!["--socket", "--nonce", "--uid", "--gid"].includes(key) || values.has(key) || !value) throw new Error("Invalid snapshot helper argument"); values.set(key, value);
  }
  const socket = values.get("--socket")!, nonce = values.get("--nonce")!, uidText = values.get("--uid")!, gidText = values.get("--gid")!;
  if (!/^\/tmp\/delta-snapshot-[A-Za-z0-9]+\/control\.sock$/.test(socket) || socket.length > 100 || !/^[a-f0-9]{64}$/.test(nonce) || !/^[1-9][0-9]{0,9}$/.test(uidText) || !/^(?:0|[1-9][0-9]{0,9})$/.test(gidText)) throw new Error("Invalid snapshot helper identity or control path");
  const uid = Number(uidText), gid = Number(gidText); if (uid > 0xffffffff || gid > 0xffffffff) throw new Error("Snapshot caller identity is outside the system range");
  return { socket, nonce, uid, gid };
}
async function ownedRootDirectory(directory: string, mode: number): Promise<void> {
  try { await mkdir(directory, { mode }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== 0 || (info.mode & 0o022) || await realpath(directory) !== directory) throw new Error(`Snapshot workspace is not controlled by root: ${directory}`);
}
async function processStart(pid: number): Promise<string | undefined> {
  try { const text = await readFile(`/proc/${pid}/stat`, "utf8"), fields = text.slice(text.lastIndexOf(")") + 2).split(" "); return /^[0-9]+$/.test(fields[19] ?? "") ? fields[19] : undefined; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
async function durableDocument(filename: string, value: Record<string, unknown>): Promise<void> {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`); if (bytes.length > 1024 * 1024) throw new Error("Snapshot recovery journal exceeds its bound");
  const temporary = `${filename}.${randomUUID()}.tmp`, file = await open(temporary, "wx", 0o600);
  try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
  await rename(temporary, filename); const parent = await open(path.posix.dirname(filename), "r"); try { await parent.sync(); } finally { await parent.close(); }
}
async function recoveryDirectory(uid: number): Promise<string> {
  for (const directory of ["/var/lib/delta-backupper", "/var/lib/delta-backupper/snapshots", `/var/lib/delta-backupper/snapshots/${uid}`]) await ownedRootDirectory(directory, 0o700);
  return `/var/lib/delta-backupper/snapshots/${uid}`;
}
async function recoverOwnedLeases(directory: string, bootId: string, uid: number): Promise<void> {
  const names = await readdir(directory); if (names.length > 1024) throw new Error("Too many snapshot recovery records; inspect owned journals before continuing");
  for (const name of names) {
    if (!/^[a-f0-9-]{36}\.json$/i.test(name)) throw new Error(`Unexpected file in root-owned snapshot recovery directory: ${directory}/${name}`);
    const filename = path.posix.join(directory, name), info = await lstat(filename);
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== 0 || (info.mode & 0o077) || info.size > 1024 * 1024) throw new Error(`Unsafe snapshot recovery record: ${filename}`);
    const value = JSON.parse(await readFile(filename, "utf8"));
    if (value.schemaVersion !== 1 || value.uid !== uid || typeof value.sessionId !== "string" || `${value.sessionId}.json` !== name || !Number.isSafeInteger(value.helperPid) || typeof value.helperStart !== "string" || typeof value.bootId !== "string" || value.workspace !== `/run/delta-backupper/${uid}/${value.sessionId}`) throw new Error(`Invalid snapshot recovery record: ${filename}`);
    if (value.bootId === bootId) { const start = await processStart(value.helperPid); if (start === value.helperStart) continue; }
    if (value.backendState) {
      await ownedRootDirectory("/run/delta-backupper", 0o755); await ownedRootDirectory(`/run/delta-backupper/${uid}`, 0o711); await ownedRootDirectory(value.workspace, 0o711);
      await recoverLinuxSnapshots(value.backendState, { sessionId: value.sessionId, workspace: value.workspace, run: runSnapshotCommand });
    }
    else if (value.state !== "preparing") throw new Error(`Snapshot recovery metadata is incomplete: ${filename}`);
    const workspace = await lstat(value.workspace).catch(error => { if (error.code === "ENOENT") return undefined; throw error; });
    if (workspace) { if (!workspace.isDirectory() || workspace.isSymbolicLink() || workspace.uid !== 0) throw new Error(`Snapshot workspace changed ownership: ${value.workspace}`); await rmdir(value.workspace); }
    await unlink(filename);
  }
}
export function validateSnapshotSourceRoots(value: unknown): SnapshotSourceRoot[] {
  if (!Array.isArray(value) || !value.length || value.length > 64) throw new Error("Invalid snapshot source count");
  return value.map(item => {
    if (!item || typeof item !== "object" || Object.keys(item).some(key => !["id", "path"].includes(key)) || typeof item.id !== "string" || !/^[a-f0-9-]{36}$/i.test(item.id) || typeof item.path !== "string" || !path.posix.isAbsolute(item.path) || item.path.includes("\0") || item.path.length > 32768 || !item.path.isWellFormed()) throw new Error("Invalid snapshot source");
    return { id: item.id, path: item.path };
  });
}

/** Called only by the internal SEA entry, after a system authorization prompt. No shell or root file-reader API is exposed. */
export async function runLinuxSnapshotHelper(arguments_: string[]): Promise<number> {
  if (process.platform !== "linux" || process.getuid?.() !== 0 || process.geteuid?.() !== 0) throw new Error("The Linux snapshot helper requires system authorization");
  const request = parseSnapshotHelperArguments(arguments_);
  if (process.env.PKEXEC_UID !== undefined && process.env.PKEXEC_UID !== String(request.uid)) throw new Error("Snapshot caller identity does not match polkit authorization");
  if (process.env.SUDO_UID !== undefined && process.env.SUDO_UID !== String(request.uid)) throw new Error("Snapshot caller identity does not match sudo authorization");
  const directory = path.posix.dirname(request.socket), directoryInfo = await lstat(directory), socketInfo = await lstat(request.socket);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink() || directoryInfo.uid !== request.uid || (directoryInfo.mode & 0o777) !== 0o700 || await realpath(directory) !== directory || !socketInfo.isSocket() || socketInfo.uid !== request.uid || (socketInfo.mode & 0o777) !== 0o600) throw new Error("Snapshot control socket ownership or permissions are unsafe");
  const socket = connect(request.socket); await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
  const wire = new SnapshotWire(socket), sessionId = randomUUID(), controller = new AbortController();
  let lease: LinuxSnapshotLease | undefined, work: Promise<void> | undefined, prepared = false, closing = false, workspace: string | undefined, failedCleanup: Error | undefined, journalFile: string | undefined;
  await wire.send({ type: "hello", protocol: 1, nonce: request.nonce, platform: "linux", elevated: true });
  const cleanup = async () => {
    controller.abort(new Error("Snapshot lease closed"));
    await work?.catch(() => {});
    if (lease) { await lease.release(); lease = undefined; }
    if (failedCleanup) throw failedCleanup;
    if (workspace) {
      // An ordinary directory can be removed only after the backend proved its mounts and objects are gone.
      const info = await lstat(workspace);
      if (info.uid !== 0 || !info.isDirectory() || info.isSymbolicLink() || await realpath(workspace) !== workspace) throw new Error("Snapshot workspace ownership changed during cleanup");
      await rmdir(workspace); workspace = undefined;
    }
    if (journalFile) { await unlink(journalFile); journalFile = undefined; }
  };
  const abort = () => { controller.abort(new Error("Snapshot helper was interrupted")); socket.destroy(); };
  process.on("SIGINT", abort); process.on("SIGTERM", abort); socket.on("close", () => controller.abort(new Error("Snapshot client disconnected")));
  async function respond(id: string, value: Record<string, unknown>) { await wire.send({ id, ok: true, value }); }
  async function errorReply(id: string, error: unknown, cleanupVerified: boolean) { await wire.send({ id, ok: false, error: { code: cleanupVerified ? (error as { code?: string })?.code ?? "SNAPSHOT_HELPER_FAILED" : "SNAPSHOT_CLEANUP_UNVERIFIED", message: error instanceof Error ? error.message.slice(0, 4000) : String(error).slice(0, 4000), cleanupVerified } }); }
  try {
    while (!closing) {
      const message = await wire.read(lease ? 45_000 : 120_000);
      if (message.command === "cancel" && message.id === undefined) { controller.abort(new Error("Snapshot operation was cancelled")); continue; }
      if (typeof message.id !== "string" || !/^[a-f0-9-]{36}$/i.test(message.id)) throw new Error("Invalid snapshot request identity");
      const id = message.id;
      if (message.command === "prepare") {
        if (prepared || work || message.mode !== "snapshot-only") { await errorReply(id, new Error("Invalid snapshot preparation state or mode"), !prepared); continue; }
        prepared = true;
        work = (async () => {
          let backendStarted = false;
          try {
            const sources = validateSnapshotSourceRoots(message.sources), lvmCowSizeBytes = message.lvmCowSizeBytes;
            if (!Number.isSafeInteger(lvmCowSizeBytes) || (lvmCowSizeBytes as number) < 256 * 1024 ** 2) throw new Error("Invalid LVM snapshot space");
            const recovery = await recoveryDirectory(request.uid), bootId = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim(), helperStart = await processStart(process.pid);
            if (!/^[a-f0-9-]{36}$/i.test(bootId) || !helperStart) throw new Error("Cannot identify the snapshot helper process and boot for recovery");
            try { await recoverOwnedLeases(recovery, bootId, request.uid); } catch (error) { throw Object.assign(error instanceof Error ? error : new Error(String(error)), { code: "SNAPSHOT_CLEANUP_UNVERIFIED", cleanupVerified: false }); }
            const root = "/run/delta-backupper"; await ownedRootDirectory(root, 0o755); await ownedRootDirectory(`${root}/${request.uid}`, 0o711); workspace = `${root}/${request.uid}/${sessionId}`; await ownedRootDirectory(workspace, 0o711);
            const journal: Record<string, unknown> = { schemaVersion: 1, sessionId, uid: request.uid, helperPid: process.pid, helperStart, bootId, workspace, createdAt: new Date().toISOString(), sources, state: "preparing" };
            journalFile = path.posix.join(recovery, `${sessionId}.json`); await durableDocument(journalFile, journal);
            const saveBackend = async (backendState: Record<string, unknown>) => { journal.backendState = backendState; await durableDocument(journalFile!, journal); };
            backendStarted = true;
            lease = await prepareLinuxSnapshots(sources, { sessionId, workspace, run: runSnapshotCommand, signal: controller.signal, lvmCowSizeBytes: lvmCowSizeBytes as number, journal: saveBackend });
            journal.state = "active"; journal.backend = lease.backend; await durableDocument(journalFile, journal);
            await respond(id, { schemaVersion: 1, platform: "linux", backend: lease.backend, sessionId, clientUid: request.uid, helperElevated: true, readOnly: true, consistency: "filesystem", consistentSnapshot: true, atomicSet: lease.atomicSet, mappings: lease.mappings });
          } catch (error) {
            let verified = !backendStarted || (error as { cleanupVerified?: boolean })?.cleanupVerified === true;
            if (lease) { try { await lease.release(); lease = undefined; verified = true; } catch (cleanupError) { failedCleanup = cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError)); verified = false; } }
            if (!verified || (error as { cleanupVerified?: boolean })?.cleanupVerified === false) failedCleanup ??= error instanceof Error ? error : new Error(String(error));
            await errorReply(id, error, !failedCleanup && (verified || workspace === undefined));
          }
        })(); void work.catch(error => { failedCleanup ??= error instanceof Error ? error : new Error(String(error)); socket.destroy(); });
      } else if (message.command === "verify" || message.command === "ping") {
        await work; if (!lease || failedCleanup) { await errorReply(id, failedCleanup ?? new Error("Snapshot lease is unavailable"), false); continue; }
        try { await lease.verify(); await respond(id, { healthy: true }); } catch (error) { await errorReply(id, error, false); }
      } else if (message.command === "release") {
        closing = true;
        try { await cleanup(); await respond(id, { cleanupVerified: true, ownedSnapshotsDeleted: true }); } catch (error) { failedCleanup = error instanceof Error ? error : new Error(String(error)); await errorReply(id, error, false); }
      } else await errorReply(id, new Error("Unknown snapshot helper command"), !lease && !failedCleanup);
    }
  } catch (error) {
    try { await cleanup(); } catch (cleanupError) { failedCleanup = cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError)); }
    if (failedCleanup) process.stderr.write(`Snapshot cleanup was not confirmed: ${failedCleanup.message}\n`);
  } finally { process.off("SIGINT", abort); process.off("SIGTERM", abort); wire.close(); }
  return failedCleanup ? 1 : 0;
}
