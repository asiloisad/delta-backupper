import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { lstat, mkdir, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { ConfigurationConflictError } from "./task-document.mjs";
export { ConfigurationConflictError };

export interface ConfigDocument<T> { value: T; revision: string | null }
export interface DirectoryIdentity { realPath: string; device: string; inode: string }
export class DestinationUnavailableError extends Error {
  readonly code = "DESTINATION_UNAVAILABLE";
  constructor(message: string) { super(message); this.name = "DestinationUnavailableError"; }
}
export function revisionOf(bytes: Uint8Array | string): string { return createHash("sha256").update(bytes).digest("hex"); }
export async function directoryIdentity(directory: string): Promise<DirectoryIdentity> {
  try {
    const stat = await lstat(directory, { bigint: true });
    if (!stat.isDirectory() && !stat.isSymbolicLink()) throw new Error("not a directory");
    const canonical = await realpath(directory);
    const actual = await lstat(canonical, { bigint: true });
    if (!actual.isDirectory()) throw new Error("not a directory");
    return { realPath: canonical, device: String(actual.dev), inode: String(actual.ino) };
  } catch (error) { throw new DestinationUnavailableError(`Destination directory is unavailable: ${directory} (${(error as Error).message})`); }
}
export async function requireDirectoryIdentity(directory: string, expected: DirectoryIdentity): Promise<void> {
  if (JSON.stringify(await directoryIdentity(directory)) !== JSON.stringify(expected)) throw new DestinationUnavailableError("Destination directory identity changed. Discover or relink the destination before saving.");
}
export async function readDocument<T>(filename: string, materialize: (raw: unknown) => T, fallback?: T): Promise<ConfigDocument<T>> {
  let bytes: Buffer;
  try {
    const stat = await lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Configuration must be a regular file: ${filename}`);
    if (stat.size > 16 * 1024 ** 2) throw new Error(`Configuration exceeds the 16 MiB size limit: ${filename}`);
    bytes = await readFile(filename);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && fallback !== undefined) return { value: structuredClone(fallback), revision: null };
    throw error;
  }
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch (error) { throw new Error(`Invalid UTF-8 JSON in ${filename}: ${(error as Error).message}`); }
  return { value: materialize(parsed), revision: revisionOf(bytes) };
}
async function revisionAt(filename: string): Promise<string | null> {
  try { const stat = await lstat(filename); if (!stat.isFile() || stat.isSymbolicLink()) throw new ConfigurationConflictError("Configuration is no longer a regular file."); return revisionOf(await readFile(filename)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
async function acquireLock(filename: string): Promise<() => Promise<void>> {
  const lockPath = `${filename}.delta-write-lock`;
  const token = randomUUID();
  const content = JSON.stringify({ hostname: hostname(), pid: process.pid, token });
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
      return async () => { if (await readFile(lockPath, "utf8").catch(() => "") === content) await unlink(lockPath); };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const lockBytes = await readFile(lockPath, "utf8");
        const owner = JSON.parse(lockBytes) as { hostname?: string; pid?: number; token?: string };
        if (owner.hostname === hostname() && Number.isInteger(owner.pid) && owner.pid! > 0) {
          try { process.kill(owner.pid!, 0); } catch (aliveError) {
            if ((aliveError as NodeJS.ErrnoException).code === "ESRCH" && await readFile(lockPath, "utf8") === lockBytes) { await unlink(lockPath); continue; }
          }
        }
      } catch { /* An unknown, remote or incomplete owner is never reclaimed. */ }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  throw new ConfigurationConflictError("Another process is saving this configuration, or its lock owner cannot be safely identified.");
}
/** Serialized compare-and-replace for cooperating Delta processes; atomic rename preserves valid old bytes on pre-commit errors. */
export async function atomicSave<T>(filename: string, value: T, expectedRevision: string | null, guard?: () => Promise<void>): Promise<ConfigDocument<T>> {
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(bytes) > 16 * 1024 ** 2) throw new Error("Configuration exceeds 16 MiB.");
  await guard?.();
  const release = await acquireLock(filename);
  const temporary = path.join(path.dirname(filename), `.${path.basename(filename)}.${randomUUID()}.tmp`);
  let ownsTemporary = false;
  try {
    await guard?.();
    if (await revisionAt(filename) !== expectedRevision) throw new ConfigurationConflictError();
    const handle = await open(temporary, "wx", 0o600); ownsTemporary = true;
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    await guard?.();
    if (await revisionAt(filename) !== expectedRevision) throw new ConfigurationConflictError();
    // On creation an exclusive hard-link-style reservation is unnecessary: cooperating writers hold the lock.
    await rename(temporary, filename); ownsTemporary = false;
    if (process.platform !== "win32") {
      const directory = await open(path.dirname(filename), "r");
      try { await directory.sync(); } finally { await directory.close(); }
    }
    return { value: structuredClone(value), revision: revisionOf(bytes) };
  } finally {
    if (ownsTemporary) await unlink(temporary).catch(() => {});
    await release();
  }
}
export async function ensureGlobalDirectory(directory: string): Promise<void> { await mkdir(directory, { recursive: true, mode: 0o700 }); }
