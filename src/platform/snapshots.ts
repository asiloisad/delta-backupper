import type { ResolvedSource, TaskConfig } from "../domain/models.js";
import type { SourceSession } from "../engine/index.mjs";
import { createVssSourceProvider, attachVssSourceSession, type VssProviderOptions } from "./vss.js";
import { attachPosixSnapshotSourceSession } from "./unix-snapshot-session.js";

export interface SnapshotProviderOptions extends VssProviderOptions {}
type Provider = { prepare(task: TaskConfig, options: { sources?: ResolvedSource[]; signal?: AbortSignal }): Promise<SourceSession>; shutdown(): Promise<void> };

function unsupported(platform: string): Error { return Object.assign(new Error(`Source snapshots are unavailable on ${platform}`), { code: "SNAPSHOT_UNSUPPORTED_PLATFORM", cleanupVerified: true }); }

/** One owner per coordinator; the actual file system is discovered by the native helper. */
export function createSnapshotSourceProvider(options: SnapshotProviderOptions = {}): Provider {
  const platform = options.platform ?? process.platform;
  const windows = platform === "win32" ? createVssSourceProvider(options) : undefined;
  let unix: Promise<Provider> | undefined;
  let closed = false;
  return {
    async prepare(task, execution = {}) {
      execution.signal?.throwIfAborted();
      if (closed) throw Object.assign(new Error("The source snapshot provider is shutting down"), { code: "SNAPSHOT_PROVIDER_CLOSED", cleanupVerified: true });
      if (windows) {
        const session = await windows.prepare(task, execution);
        return Object.assign(session, { sourceConsistency: task.snapshot.mode === "writers" ? "application-snapshot" : "filesystem-snapshot", atomicSet: true });
      }
      if (platform !== "linux" && platform !== "darwin") throw unsupported(platform);
      // Keep Unix process integration out of the Windows startup path.
      unix ??= import("./unix-snapshots.js").then(({ createUnixSnapshotSourceProvider }) => createUnixSnapshotSourceProvider({ ...options, platform }));
      return (await unix).prepare(task, execution);
    },
    async shutdown() { closed = true; await windows?.shutdown(); if (unix) await (await unix).shutdown(); },
  };
}

/** Reconstruct only read access in the ordinary worker; the parent retains all mutation authority. */
export function attachSnapshotSourceSession(task: TaskConfig, sources: ResolvedSource[], lease: Record<string, unknown>, release: SourceSession["release"], signal?: AbortSignal, verify?: (options?: { fresh?: boolean }) => Promise<void>): SourceSession {
  if (!lease || typeof lease !== "object") throw new Error("The snapshot lease is missing");
  if (lease.platform === undefined || lease.platform === "win32") {
    if (process.platform !== "win32") throw new Error("A Windows snapshot lease cannot be used on this platform");
    return Object.assign(attachVssSourceSession(task, sources, lease, release, signal), { sourceConsistency: task.snapshot.mode === "writers" ? "application-snapshot" : "filesystem-snapshot", atomicSet: true, ...(verify ? { verify } : {}) });
  }
  return attachPosixSnapshotSourceSession(task, sources, lease, release, signal, verify);
}
