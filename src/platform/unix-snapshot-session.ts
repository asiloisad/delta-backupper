import { constants, type BigIntStats } from "node:fs";
import { open, lstat, readlink, opendir, realpath, type FileHandle } from "node:fs/promises";
import { createHash } from "node:crypto";
import { posix as path } from "node:path";
import type { ResolvedSource, TaskConfig } from "../domain/models.js";
import type { SourceSession } from "../engine/index.mjs";
import { createPosixSnapshotPathResolver, createPosixSnapshotScanner, type PosixSnapshotMapping, type PosixSnapshotIO } from "./posix-snapshot-paths.mjs";

const MAX_DOCUMENT = 1024 ** 2;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const inside = (parent: string, child: string) => parent === "/" || child === parent || child.startsWith(`${parent}/`);
function failure(message: string, code = "SNAPSHOT_INVALID_LEASE"): Error { return Object.assign(new Error(message), { code }); }
function absolute(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 32768 || value.includes("\0") || !value.isWellFormed() || !value.startsWith("/") || path.normalize(value) !== value || value !== "/" && value.endsWith("/")) throw failure("Unsafe POSIX snapshot path");
  return value;
}
function document(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw failure("Invalid snapshot lease document");
  return value as Record<string, unknown>;
}
export interface PosixSnapshotLease { schemaVersion: 1; platform: "linux" | "darwin"; backend: "btrfs" | "zfs" | "lvm" | "mixed" | "apfs"; sessionId: string; clientUid: number; helperElevated: true; readOnly: true; consistentSnapshot: true; consistency: "filesystem"; atomicSet: boolean; mappings: PosixSnapshotMapping[] }

/** Validate the authenticated helper's attestation before any snapshot path is opened. */
export function validatePosixSnapshotLease(value: Record<string, unknown>, platform: NodeJS.Platform = process.platform): PosixSnapshotLease {
  document(value);
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_DOCUMENT) throw failure("Snapshot lease exceeds its bounded document limit");
  if (value.schemaVersion !== 1 || !["linux", "darwin"].includes(String(value.platform)) || value.platform !== platform || value.consistentSnapshot !== true || value.helperElevated !== true || value.readOnly !== true || value.consistency !== "filesystem" || typeof value.atomicSet !== "boolean" || typeof value.sessionId !== "string" || !uuid.test(value.sessionId) || !Number.isSafeInteger(value.clientUid) || Number(value.clientUid) < 0) throw failure("The helper did not attest the required read-only snapshot lease");
  if (typeof process.getuid === "function" && value.clientUid !== process.getuid()) throw failure("The snapshot lease belongs to another user");
  const backends = value.platform === "darwin" ? ["apfs"] : ["btrfs", "zfs", "lvm", "mixed"];
  if (!backends.includes(String(value.backend))) throw failure("The snapshot backend does not match its platform");
  if (!Array.isArray(value.mappings) || !value.mappings.length || value.mappings.length > 256) throw failure("Invalid number of snapshot mappings");
  const namespace = `${value.platform === "darwin" ? "/private/var/run" : "/run"}/delta-backupper/${value.clientUid}/${value.sessionId}`;
  const logicalRoots = new Set<string>();
  const mappings = value.mappings.map((raw: unknown) => {
    const item = document(raw), root = absolute(item.root), snapshotPath = absolute(item.snapshotPath);
    if (logicalRoots.has(root) || inside(namespace, root) || !inside(namespace, snapshotPath) || snapshotPath === namespace || root !== "/" && inside(root, snapshotPath) || inside(snapshotPath, root)) throw failure("Snapshot mapping escapes or overlaps its owned namespace");
    if (item.caseSensitive !== undefined && typeof item.caseSensitive !== "boolean") throw failure("Invalid snapshot file-system case sensitivity");
    if (typeof item.identity !== "string" || !item.identity || item.identity.length > 1024 || item.identity.includes("\0") || !item.identity.isWellFormed() || typeof item.device !== "string" || !/^(?:0|[1-9][0-9]{0,19})$/.test(item.device)) throw failure("Invalid snapshot file-system identity");
    const roots = (field: "excludedRoots" | "ignoredRoots") => {
      const values = item[field] ?? [];
      if (!Array.isArray(values) || values.length > 1024) throw failure("Invalid snapshot mount exclusions");
      const result = values.map((value: unknown) => { const selected = absolute(value); if (!inside(root, selected) || field === "ignoredRoots" && selected === root) throw failure("Snapshot mount exclusion is outside its mapping or hides the mapping root"); return selected; });
      if (new Set(result).size !== result.length) throw failure("Duplicate snapshot mount exclusion"); return result;
    };
    logicalRoots.add(root); return { root, snapshotPath, identity: item.identity, device: item.device, caseSensitive: item.caseSensitive !== false, excludedRoots: roots("excludedRoots"), ignoredRoots: roots("ignoredRoots") };
  });
  // A namespace must never become a logical source through another mapping.
  for (const mapping of mappings) for (const other of mappings) if (inside(other.snapshotPath, mapping.root)) throw failure("A snapshot path was substituted for a live mapping root");
  return { schemaVersion: 1, platform: value.platform as "linux" | "darwin", backend: value.backend as PosixSnapshotLease["backend"], sessionId: value.sessionId, clientUid: Number(value.clientUid), helperElevated: true, readOnly: true, consistentSnapshot: true, consistency: "filesystem", atomicSet: value.atomicSet, mappings };
}

type Token = { logical: string; device: string; inode: string; size: number; mtimeNs: string };
function token(value: unknown): Token {
  if (typeof value !== "string" || value.length > 65536) throw failure("Missing bounded snapshot entry identity", "SNAPSHOT_FILE_IDENTITY");
  const parsed = document(JSON.parse(value)); absolute(parsed.logical);
  if (typeof parsed.device !== "string" || !/^[0-9]+$/.test(parsed.device) || typeof parsed.inode !== "string" || !/^[0-9]+$/.test(parsed.inode) || !Number.isSafeInteger(parsed.size) || Number(parsed.size) < 0 || typeof parsed.mtimeNs !== "string" || !/^-?[0-9]+$/.test(parsed.mtimeNs)) throw failure("Invalid snapshot entry identity", "SNAPSHOT_FILE_IDENTITY");
  return parsed as unknown as Token;
}
function identityMatches(info: BigIntStats, expected: Token): boolean { return info.isFile() && String(info.dev) === expected.device && String(info.ino) === expected.inode && Number(info.size) === expected.size && String(info.mtimeNs) === expected.mtimeNs; }

export interface SnapshotSessionIO extends PosixSnapshotIO { open: typeof open }
export function attachPosixSnapshotSourceSession(task: TaskConfig, sources: ResolvedSource[], rawLease: Record<string, unknown>, release: SourceSession["release"], signal?: AbortSignal, verify?: (options?: { fresh?: boolean }) => Promise<void>, options: { platform?: NodeJS.Platform; io?: SnapshotSessionIO } = {}): SourceSession {
  const lease = validatePosixSnapshotLease(rawLease, options.platform);
  if (task.snapshot.mode !== "snapshot-only") throw failure("Unix snapshots require file-system snapshot mode");
  if (!verify) throw failure("The snapshot lease has no authenticated health check");
  if (!sources.length || sources.length > 256) throw failure("Invalid number of source roots");
  for (const source of sources) absolute(source.path);
  const io = options.io ?? { open, lstat, readlink, opendir, realpath };
  const resolver = createPosixSnapshotPathResolver(lease.mappings, io);
  const scanner = createPosixSnapshotScanner(sources, lease.mappings, io);
  const physicalMappings = [...lease.mappings].sort((left, right) => right.snapshotPath.length - left.snapshotPath.length);
  const logicalPath = (physical: string): string => {
    absolute(physical); const mapping = physicalMappings.find(item => inside(item.snapshotPath, physical));
    if (!mapping) throw failure("A scanned file is outside the snapshot lease");
    return path.join(mapping.root, path.relative(mapping.snapshotPath, physical));
  };
  const health = async (options: { fresh?: boolean } = {}) => { signal?.throwIfAborted(); await verify(options); signal?.throwIfAborted(); };
  const verifyRoots = async (options: { fresh?: boolean } = {}) => {
    await health({ fresh: options.fresh !== false });
    if (options.fresh === false) return;
    for (const mapping of lease.mappings) {
      signal?.throwIfAborted(); const info = await io.lstat(mapping.snapshotPath, { bigint: true });
      if (!info.isDirectory() || info.isSymbolicLink() || String(info.dev) !== mapping.device) throw failure("Snapshot mount identity changed before publication", "SNAPSHOT_MOUNT_UNAVAILABLE");
    }
  };
  return {
    sources: sources.map(source => ({ ...source, path: resolver.mappedPath(source.path) })), consistentSnapshot: true, sourceConsistency: "filesystem-snapshot", atomicSet: lease.atomicSet,
    snapshotLease: structuredClone(rawLease), followsLinksInSnapshot: true, release,
    async validateSources() { await verifyRoots(); for (const source of sources) await resolver.resolve(source.path, signal, { followFinal: task.symlinks === "follow" }); },
    verify: verifyRoots,
    async *scan(scanTask, destination, execution) {
      for await (const entry of scanner(scanTask, destination, execution)) {
        if (entry.kind !== "file") { yield entry; continue; }
        try {
          const resolved = await resolver.resolve(logicalPath(entry.absolute!), execution.signal);
          if (resolved.absolute !== entry.absolute || !resolved.info.isFile() || Number(resolved.info.size) !== entry.size || String(resolved.info.mtimeNs) !== entry.mtimeNs) throw failure("Snapshot file identity changed during scanning", "SNAPSHOT_FILE_IDENTITY");
          yield { ...entry, providerEntryId: JSON.stringify({ logical: resolved.logicalPath, device: String(resolved.info.dev), inode: String(resolved.info.ino), size: entry.size, mtimeNs: entry.mtimeNs } satisfies Token) };
        } catch (error) {
          if (execution.signal?.aborted) throw error;
          yield { sourceId: (entry as typeof entry & { sourceId: string }).sourceId, path: entry.path, kind: "missing", size: 0, mtimeNs: "0", mode: 0, error: error instanceof Error ? error.message : String(error), code: (error as { code?: string }).code ?? "SNAPSHOT_FILE_IDENTITY" };
        }
      }
    },
    async openFile(entry, execution) {
      let handle: FileHandle | undefined;
      try {
        execution.signal?.throwIfAborted(); await health({ fresh: false }); const expected = token(entry.providerEntryId);
        if (entry.kind !== "file" || expected.size !== entry.size || expected.mtimeNs !== entry.mtimeNs) throw failure("Snapshot entry metadata changed before reading", "SNAPSHOT_FILE_IDENTITY");
        const resolved = await resolver.resolve(expected.logical, execution.signal);
        if (!identityMatches(resolved.info, expected)) throw failure("Snapshot file identity changed before reading", "SNAPSHOT_FILE_IDENTITY");
        if (typeof constants.O_NOFOLLOW !== "number") throw failure("The platform cannot safely open snapshot files", "SNAPSHOT_NOFOLLOW_UNAVAILABLE");
        handle = await io.open(resolved.absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
        if (!identityMatches(await handle.stat({ bigint: true }), expected)) throw failure("Opened snapshot file identity does not match its scanned version", "SNAPSHOT_FILE_IDENTITY");
        const fd = handle; handle = undefined; const hash = createHash("sha256"); let bytesReadTotal = 0, closed = false, complete = false, digest: string | undefined, lastHealthAt = Date.now();
        const close = async () => { if (!closed) { closed = true; await fd.close(); } };
        const reader = { size: expected.size, readable: new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              execution.signal?.throwIfAborted(); signal?.throwIfAborted();
              if (Date.now() - lastHealthAt >= 1000) { await health({ fresh: false }); lastHealthAt = Date.now(); }
              const buffer = Buffer.allocUnsafe(64 * 1024); const result = await fd.read(buffer, 0, buffer.length, null);
              if (!result.bytesRead) {
                if (bytesReadTotal !== expected.size || !identityMatches(await fd.stat({ bigint: true }), expected)) throw failure("Snapshot file changed while reading", "SNAPSHOT_FILE_IDENTITY");
                complete = true; digest = hash.digest("hex"); await close(); controller.close(); return;
              }
              bytesReadTotal += result.bytesRead; if (bytesReadTotal > expected.size) throw failure("Snapshot file grew while reading", "SNAPSHOT_FILE_IDENTITY");
              const chunk = buffer.subarray(0, result.bytesRead); hash.update(chunk); controller.enqueue(chunk);
            } catch (error) { await close().catch(() => {}); controller.error(Object.assign(error instanceof Error ? error : new Error(String(error)), { sourceReadError: true })); }
          },
          async cancel() { await close(); },
        }) };
        return { reader, close, digest() { if (!complete || !digest) throw failure("Snapshot file was not completely read", "SNAPSHOT_FILE_IDENTITY"); return digest; } };
      } catch (error) { await handle?.close().catch(() => {}); throw Object.assign(error instanceof Error ? error : new Error(String(error)), { sourceReadError: true }); }
    },
  };
}
