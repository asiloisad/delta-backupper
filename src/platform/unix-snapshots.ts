import { resolveTaskSources } from "../domain/source-identity.mjs";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:net";
import { chmod, lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import type { ResolvedSource, TaskConfig } from "../domain/models.js";
import type { SourceSession } from "../engine/index.mjs";
import { SnapshotWire, snapshotFailure } from "./snapshot-wire.js";
import { attachPosixSnapshotSourceSession } from "./unix-snapshot-session.js";

export interface UnixSnapshotProviderOptions { platform?: NodeJS.Platform; helperPath?: string; timeoutMs?: number; launch?: (executable: string, arguments_: string[]) => ChildProcess }
export function quoteSnapshotShellArgument(value: string): string { if (value.includes("\0") || !value.isWellFormed()) throw new Error("Invalid snapshot launcher argument"); return `'${value.replaceAll("'", "'\\''")}'`; }
export function macSnapshotAuthorizationScript(executable: string, arguments_: string[]): string {
  const command = [executable, ...arguments_].map(quoteSnapshotShellArgument).join(" ");
  return `do shell script ${JSON.stringify(command)} with administrator privileges`;
}
async function helperCommand(platform: NodeJS.Platform, configured?: string): Promise<{ executable: string; prefix: string[] }> {
  const candidates: string[] = [];
  if (configured) { if (!path.isAbsolute(configured)) throw snapshotFailure("Snapshot helper path must be absolute", "SNAPSHOT_HELPER_MISSING", true); candidates.push(configured); }
  else if (platform === "linux") {
    const sea = !process.versions.electron ? process.getBuiltinModule("node:sea") as { isSea?(): boolean } | undefined : undefined;
    if (sea?.isSea?.()) return { executable: process.execPath, prefix: ["internal-snapshot-helper"] };
    candidates.push(path.join(path.dirname(process.execPath), "bin/delta"), path.join(path.dirname(process.execPath), "delta"), path.resolve(__dirname, "../sea/delta"));
  } else candidates.push(path.join(path.dirname(process.execPath), "delta-snapshot"), path.resolve(__dirname, "../native/macos/delta-snapshot"));
  for (const candidate of candidates) {
    try { const resolved = await realpath(candidate), details = await lstat(resolved); if (details.isFile() && (details.mode & 0o111)) return { executable: resolved, prefix: platform === "linux" ? ["internal-snapshot-helper"] : [] }; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  throw snapshotFailure("Snapshot helper is missing. Build a native local package for this operating system.", "SNAPSHOT_HELPER_MISSING", true);
}
async function authorizationLauncher(platform: NodeJS.Platform): Promise<string> {
  const terminal = !process.versions.electron && process.stdin.isTTY;
  const candidates = platform === "darwin" ? ["/usr/bin/osascript"] : terminal ? ["/usr/bin/sudo", "/bin/sudo", "/usr/bin/pkexec", "/bin/pkexec"] : ["/usr/bin/pkexec", "/bin/pkexec"];
  for (const candidate of candidates) {
    try { const resolved = await realpath(candidate), details = await lstat(resolved); if (details.uid === 0 && details.isFile() && !(details.mode & 0o022) && (details.mode & 0o111)) return resolved; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  throw snapshotFailure("A system authorization agent is required for source snapshots. Linux needs polkit/pkexec and an authentication agent; macOS needs osascript.", "SNAPSHOT_AUTHORIZATION_UNAVAILABLE", true);
}
interface Connection { wire: SnapshotWire; child: ChildProcess; directory: string; directoryIno: bigint; server: Server; exited: Promise<number>; requested: boolean }
async function connectHelper(platform: NodeJS.Platform, options: UnixSnapshotProviderOptions, signal?: AbortSignal): Promise<Connection> {
  const uid = process.getuid?.(), gid = process.getgid?.();
  if (uid === undefined || gid === undefined || uid === 0) throw snapshotFailure("Run Delta as your normal user; only its snapshot helper may be elevated", "SNAPSHOT_NORMAL_USER_REQUIRED", true);
  signal?.throwIfAborted();
  const command = await helperCommand(platform, options.helperPath), launcher = await authorizationLauncher(platform), nonce = randomBytes(32).toString("hex");
  const directory = await realpath(await mkdtemp("/tmp/delta-snapshot-")); await chmod(directory, 0o700);
  const details = await lstat(directory, { bigint: true }), filename = path.join(directory, "control.sock");
  if (filename.length > 100 || details.uid !== BigInt(uid) || details.isSymbolicLink() || await realpath(directory) !== directory) throw snapshotFailure("Unsafe snapshot control directory", "SNAPSHOT_PROTOCOL_ERROR", true);
  const server = createServer(); let child: ChildProcess | undefined, connected = false, readyTimer: NodeJS.Timeout | undefined, cancelAuthorization: (() => void) | undefined, acceptedWire: SnapshotWire | undefined;
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(filename, () => { server.off("error", reject); resolve(); }); }); await chmod(filename, 0o600);
    const ready = new Promise<SnapshotWire>((resolve, reject) => {
      readyTimer = setTimeout(() => reject(new Error("Snapshot authorization or helper connection timed out")), options.timeoutMs ?? 120_000);
      cancelAuthorization = () => { child?.kill(); reject(new Error("Snapshot authorization was cancelled")); }; signal?.addEventListener("abort", cancelAuthorization, { once: true });
      server.on("error", reject);
      server.on("connection", socket => {
        if (connected) { socket.destroy(); return; } connected = true;
        const wire = new SnapshotWire(socket);
        acceptedWire = wire;
        void wire.read(15_000).then(hello => {
          if (hello.type !== "hello" || hello.protocol !== 1 || hello.nonce !== nonce || hello.platform !== platform || hello.elevated !== true) throw new Error("Snapshot helper identity handshake failed");
          clearTimeout(readyTimer); resolve(wire);
        }).catch(error => { clearTimeout(readyTimer); socket.destroy(); reject(error); });
      });
    });
    void ready.catch(() => {});
    const arguments_ = [...command.prefix, "--socket", filename, "--nonce", nonce, "--uid", String(uid), "--gid", String(gid)];
    const sudo = platform === "linux" && path.posix.basename(launcher) === "sudo";
    const launchArguments = platform === "darwin" ? ["-e", macSnapshotAuthorizationScript(command.executable, arguments_)] : sudo ? ["--", command.executable, ...arguments_] : ["--disable-internal-agent", command.executable, ...arguments_];
    child = options.launch ? options.launch(launcher, launchArguments) : spawn(launcher, launchArguments, { stdio: [sudo ? "inherit" : "ignore", "ignore", sudo ? "inherit" : "pipe"], env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", ...(process.env.TERM ? { TERM: process.env.TERM } : {}), ...(process.env.DISPLAY ? { DISPLAY: process.env.DISPLAY } : {}), ...(process.env.WAYLAND_DISPLAY ? { WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY } : {}), ...(process.env.DBUS_SESSION_BUS_ADDRESS ? { DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS } : {}), ...(process.env.XDG_RUNTIME_DIR ? { XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR } : {}) }, windowsHide: true });
    if (signal?.aborted) cancelAuthorization?.();
    let diagnostics = "";
    child.stderr?.on("data", (bytes: Buffer) => { if (diagnostics.length < 8192) diagnostics += bytes.toString("utf8").slice(0, 8192 - diagnostics.length); });
    const exited = new Promise<number>((resolve, reject) => { child!.once("error", reject); child!.once("close", (code, signal) => code === null ? reject(new Error(`Snapshot helper terminated (${signal})`)) : resolve(code)); }); void exited.catch(() => {});
    const wire = await Promise.race([ready, exited.then(code => { throw new Error(`Snapshot authorization was declined or its helper exited (${code}): ${diagnostics.slice(0, 2000)}`); })]);
    clearTimeout(readyTimer);
    if (cancelAuthorization) signal?.removeEventListener("abort", cancelAuthorization);
    return { wire, child, directory, directoryIno: details.ino, server, exited, requested: false };
  } catch (error) {
    clearTimeout(readyTimer); acceptedWire?.close(); server.close(); child?.kill();
    if (cancelAuthorization) signal?.removeEventListener("abort", cancelAuthorization);
    const now = await lstat(directory, { bigint: true }).catch(() => null);
    if (now?.ino === details.ino && now.uid === BigInt(uid) && !now.isSymbolicLink()) await rm(directory, { recursive: true, force: true });
    throw snapshotFailure(error instanceof Error ? error.message : String(error), "SNAPSHOT_AUTHORIZATION_FAILED", true);
  }
}

export function snapshotSourceRoots(sources: readonly ResolvedSource[]): Array<Pick<ResolvedSource, "id" | "path">> { return sources.map(source => ({ id: source.id, path: source.path })); }

export function createUnixSnapshotSourceProvider(options: UnixSnapshotProviderOptions = {}) {
  const platform = options.platform ?? process.platform;
  let closing = false, queue = Promise.resolve(); const releases = new Set<() => Promise<void>>(); const shutdown = new AbortController();
  async function acquire(signal?: AbortSignal) {
    const previous = queue; let unlock!: () => void; const slot = new Promise<void>(resolve => { unlock = resolve; }); queue = previous.then(() => slot);
    let cancel: (() => void) | undefined;
    try { signal?.throwIfAborted(); await Promise.race([previous, new Promise<never>((_, reject) => { if (signal) { cancel = () => reject(signal.reason ?? new Error("Snapshot preparation was cancelled")); signal.addEventListener("abort", cancel, { once: true }); } })]); signal?.throwIfAborted(); return unlock; }
    catch (error) { unlock(); throw error; }
    finally { if (cancel) signal?.removeEventListener("abort", cancel); }
  }
  return {
    async prepare(task: TaskConfig, execution: { sources?: ResolvedSource[]; signal?: AbortSignal } = {}): Promise<SourceSession> {
      if (platform !== "linux" && platform !== "darwin") throw snapshotFailure("POSIX source snapshots are unavailable on this operating system", "SNAPSHOT_UNSUPPORTED", true);
      if (closing) throw snapshotFailure("Snapshot provider is shutting down", "SNAPSHOT_SHUTDOWN", true);
      if (task.snapshot.mode === "off" || task.snapshot.mode === "writers") throw snapshotFailure(task.snapshot.mode === "writers" ? "VSS writers are available only on Windows. Select a file system snapshot on this operating system." : "Snapshots are disabled for this task", "SNAPSHOT_UNSUPPORTED_MODE", true);
      execution.signal?.throwIfAborted();
      const sources = execution.sources ?? resolveTaskSources(task);
      if (!sources.length || sources.length > 64 || sources.some(source => !path.posix.isAbsolute(source.path) || source.path.includes("\0"))) throw snapshotFailure("Snapshot sources must be between 1 and 64 absolute local paths", "SNAPSHOT_INVALID_SOURCE", true);
      const combined = AbortSignal.any([shutdown.signal, ...(execution.signal ? [execution.signal] : [])]);
      const unlock = await acquire(combined);
      let connection: Connection;
      try { if (closing) throw new Error("Snapshot provider is shutting down"); connection = await connectHelper(platform, options, combined); }
      catch (error) { unlock(); throw error; }
      let chain = Promise.resolve(), heartbeat: NodeJS.Timeout | undefined, healthFailure: Error | undefined, releasePromise: Promise<void> | undefined, verifying: Promise<void> | undefined, lastVerified = -Infinity;
      async function rpc(command: string, values: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
        const previous = chain; let unlock!: () => void; const slot = new Promise<void>(resolve => { unlock = resolve; }); chain = previous.then(() => slot);
        await previous;
        try {
          const id = randomUUID(); await connection.wire.send({ id, command, ...values });
          const reply = await connection.wire.read(options.timeoutMs ?? 120_000);
          if (reply.id !== id || typeof reply.ok !== "boolean") throw snapshotFailure("Unexpected snapshot helper reply", "SNAPSHOT_PROTOCOL_ERROR", false);
          if (!reply.ok) { const error = reply.error as Record<string, unknown> | undefined; throw snapshotFailure(typeof error?.message === "string" ? error.message.slice(0, 4000) : "Snapshot helper operation failed", typeof error?.code === "string" ? error.code : "SNAPSHOT_HELPER_FAILED", error?.cleanupVerified === true); }
          if (!reply.value || typeof reply.value !== "object" || Array.isArray(reply.value)) throw snapshotFailure("Invalid snapshot helper result", "SNAPSHOT_PROTOCOL_ERROR", false);
          return reply.value as Record<string, unknown>;
        } finally { unlock(); }
      }
      async function cleanupTransport() {
        connection.wire.close(); connection.server.close();
        let timer: NodeJS.Timeout | undefined;
        try { await Promise.race([connection.exited.then(code => { if (code !== 0) throw new Error(`Snapshot helper exited unsuccessfully (${code})`); }), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Snapshot helper exit was not confirmed")), 15_000); })]); }
        finally { clearTimeout(timer); connection.wire.socket.destroy(); }
        const uid = process.getuid!(), details = await lstat(connection.directory, { bigint: true }).catch(() => null);
        if (details?.ino === connection.directoryIno && details.uid === BigInt(uid) && !details.isSymbolicLink()) await rm(connection.directory, { recursive: true, force: true });
      }
      const release = () => releasePromise ??= (async () => {
        clearInterval(heartbeat); combined.removeEventListener("abort", cancel);
        try { const result = await rpc("release"); if (result.cleanupVerified !== true || result.ownedSnapshotsDeleted !== true) throw snapshotFailure("Snapshot cleanup was not confirmed", "SNAPSHOT_CLEANUP_UNVERIFIED", false); }
        catch (error) { throw snapshotFailure(error instanceof Error ? error.message : String(error), "SNAPSHOT_CLEANUP_UNVERIFIED", false); }
        finally { releases.delete(release); try { await cleanupTransport(); } catch (error) { throw snapshotFailure(error instanceof Error ? error.message : String(error), "SNAPSHOT_CLEANUP_UNVERIFIED", false); } finally { unlock(); } }
      })();
      const cancel = () => { void connection.wire.send({ command: "cancel" }).catch(() => {}); };
      const verify = async (verification: { fresh?: boolean } = {}) => {
        if (healthFailure) throw healthFailure; combined.throwIfAborted();
        if (verification.fresh === false && performance.now() - lastVerified < 1000) return;
        if (verifying) { await verifying; if (verification.fresh === false) return; }
        const check = rpc("verify").then(value => { if (value.healthy !== true) throw snapshotFailure("Source snapshot is no longer healthy", "SNAPSHOT_INVALIDATED", false); lastVerified = performance.now(); });
        verifying = check;
        try { await check; } catch (error) { healthFailure = error instanceof Error ? error : new Error(String(error)); throw healthFailure; }
        finally { if (verifying === check) verifying = undefined; }
      };
      releases.add(release); combined.addEventListener("abort", cancel, { once: true });
      try {
        connection.requested = true;
        const lease = await rpc("prepare", { sources: snapshotSourceRoots(sources), mode: task.snapshot.mode, ...(platform === "linux" ? { lvmCowSizeBytes: task.snapshot.lvmCowSizeBytes } : {}) });
        combined.throwIfAborted();
        const session = attachPosixSnapshotSourceSession(task, sources, lease, release, execution.signal, verify, { platform });
        heartbeat = setInterval(() => { void verify().catch(error => { healthFailure = error instanceof Error ? error : new Error(String(error)); }); }, 10_000); heartbeat.unref();
        return session;
      } catch (error) {
        try { await release(); }
        catch (cleanup) { throw snapshotFailure(`${error instanceof Error ? error.message : error}; ${cleanup instanceof Error ? cleanup.message : cleanup}`, "SNAPSHOT_CLEANUP_UNVERIFIED", false); }
        throw Object.assign(error instanceof Error ? error : new Error(String(error)), { cleanupVerified: true });
      }
    },
    async shutdown(): Promise<void> { closing = true; shutdown.abort(new Error("Snapshot provider is shutting down")); const results = await Promise.allSettled([...releases].map(release => release())); await queue; const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected"); if (failures.length) throw new AggregateError(failures.map(result => result.reason), "Snapshot cleanup was not confirmed"); },
  };
}
