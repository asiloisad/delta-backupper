import { resolveTaskSources } from "../domain/source-identity.mjs";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { access, lstat } from "node:fs/promises";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import type { ResolvedSource, TaskConfig } from "../domain/models.js";
import { createVssPathResolver, createVssSnapshotScanner } from "./vss-paths.mjs";
import type { SourceSession } from "../engine/index.mjs";

const LIMIT = 65_536;
const MAGIC = Buffer.from("DV02", "ascii");
type Frame = { opcode: number; payload: Buffer };
type Mapping = { root: string; guid: string; device: string; snapshotId: string };
export interface VssSourceSession extends SourceSession { consistentSnapshot: true; snapshotLease: Record<string, unknown>; followsLinksInSnapshot: true }
export interface VssProviderOptions { helperPath?: string; platform?: NodeJS.Platform; timeoutMs?: number; persistent?: boolean; launch?: (executable: string, arguments_: readonly string[]) => ChildProcessWithoutNullStreams }

class Channel {
  private failure: Error | undefined;
  private readonly input: Readable;
  private readonly output: Writable;
  private readonly timeout: number;
  constructor(input: Readable, output: Writable, timeout: number) {
    this.input = input; this.output = output; this.timeout = timeout;
    input.on("error", error => { this.failure ??= error; });
    output.on("error", error => { this.failure ??= error; });
  }
  private async exact(length: number, end: number): Promise<Buffer> {
    const result = Buffer.allocUnsafe(length); let offset = 0;
    while (offset < length) {
      if (this.failure) throw this.failure;
      const remaining = end - Date.now(); if (remaining <= 0) throw new Error("VSS helper channel timed out");
      const chunk: unknown = this.input.read(Math.min(length - offset, this.input.readableLength || length - offset));
      if (chunk !== null) {
        if (!Buffer.isBuffer(chunk) || !chunk.length || chunk.length > length - offset) throw new Error("Invalid binary VSS helper stream");
        chunk.copy(result, offset); offset += chunk.length; continue;
      }
      if (this.input.readableEnded || this.input.destroyed) throw new Error("VSS helper disconnected before completing its response");
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => { clearTimeout(timer); this.input.off("readable", ready); this.input.off("end", ready); this.input.off("close", ready); this.input.off("error", failed); };
        const ready = () => { cleanup(); resolve(); };
        const failed = (error: Error) => { cleanup(); reject(error); };
        const timer = setTimeout(() => failed(new Error("VSS helper channel timed out")), remaining);
        this.input.once("readable", ready); this.input.once("end", ready); this.input.once("close", ready); this.input.once("error", failed);
        if (this.input.readableLength || this.input.readableEnded || this.input.destroyed) ready();
      });
    }
    return result;
  }
  async frame(): Promise<Frame> {
    const end = Date.now() + this.timeout; const header = await this.exact(12, end);
    if (!header.subarray(0, 4).equals(MAGIC) || header[5] || header.readUInt16LE(6)) throw new Error("Invalid VSS helper response header");
    const length = header.readUInt32LE(8); if (length > LIMIT) throw new Error("Oversized VSS helper response");
    return { opcode: header[4]!, payload: length ? await this.exact(length, end) : Buffer.alloc(0) };
  }
  async send(opcode: number, payload: Buffer = Buffer.alloc(0)) {
    if (payload.length > LIMIT || this.output.destroyed || this.output.writableEnded) throw new Error("VSS helper request cannot be sent");
    const frame = Buffer.alloc(12 + payload.length); MAGIC.copy(frame); frame[4] = opcode; frame.writeUInt32LE(payload.length, 8); payload.copy(frame, 12);
    await new Promise<void>((resolve, reject) => {
      let complete = false;
      const finish = (error?: Error | null) => { if (complete) return; complete = true; clearTimeout(timer); this.output.off("error", finish); error ? reject(error) : resolve(); };
      const timer = setTimeout(() => finish(new Error("VSS helper write timed out")), this.timeout);
      this.output.once("error", finish); this.output.write(frame, finish);
    });
  }
}
function document(frame: Frame): Record<string, unknown> {
  const text = frame.payload.toString("utf8"); if (!Buffer.from(text, "utf8").equals(frame.payload)) throw new Error("Invalid UTF-8 in VSS helper response");
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid VSS helper document");
  const result = value as Record<string, unknown>;
  if (frame.opcode === 0xff) { const error = new Error(typeof result.message === "string" ? result.message.slice(0, 4000) : "VSS helper failed"); Object.assign(error, { code: result.code, cleanupVerified: result.cleanupVerified === true }); throw error; }
  return result;
}
function request(task: TaskConfig, sources: ResolvedSource[]): Buffer {
  if (!sources.length || sources.length > 64) throw new Error("VSS supports between 1 and 64 source roots per task");
  const values = sources.map(source => {
    if (!path.win32.isAbsolute(source.path) || !/^[A-Za-z]:[\\/]/.test(source.path) || source.path.includes("\0")) throw new Error("VSS requires local absolute Windows source paths");
    const value = Buffer.from(source.path, "utf8"); if (value.toString("utf8") !== source.path || value.length > 32_768) throw new Error("Invalid VSS source path");
    const length = Buffer.alloc(4); length.writeUInt32LE(value.length); return Buffer.concat([length, value]);
  });
  const header = Buffer.alloc(8); header[0] = task.snapshot.mode === "writers" ? 1 : 0; header.writeUInt32LE(values.length, 4);
  const result = Buffer.concat([header, ...values]); if (result.length > LIMIT) throw new Error("VSS source request exceeds its bounded protocol limit"); return result;
}
function snapshotMappings(value: Record<string, unknown>, mode: string): Mapping[] {
  if (value.schemaVersion !== 1 || value.mode !== mode || value.consistentSnapshot !== true || value.helperElevated !== true || value.clientUnelevated !== true || value.sourceAccess !== "worker-token" || !Array.isArray(value.volumes) || !value.volumes.length || value.volumes.length > 64) throw new Error("VSS helper did not attest the required snapshot lease");
  const mappings: Mapping[] = value.volumes.map((entry: unknown) => {
    if (!entry || typeof entry !== "object") throw new Error("Invalid VSS volume mapping");
    const item = entry as Record<string, unknown>;
    if (typeof item.root !== "string" || !/^[A-Za-z]:\\(?:[^\0]*\\)?$/.test(item.root) || typeof item.guid !== "string" || !/^\\\\\?\\Volume\{[0-9a-f-]{36}\}\\$/i.test(item.guid) || typeof item.device !== "string" || !/^\\\\\?\\GLOBALROOT\\Device\\HarddiskVolumeShadowCopy[1-9][0-9]*\\?$/i.test(item.device) || typeof item.snapshotId !== "string" || !/^\{[0-9a-f-]{36}\}$/i.test(item.snapshotId)) throw new Error("Unsafe VSS volume mapping");
    if (path.win32.normalize(item.root) !== item.root || item.root.slice(2).includes(":")) throw new Error("Unsafe VSS mount root");
    return item as unknown as Mapping;
  }).sort((first, second) => second.root.length - first.root.length);
  if (new Set(mappings.map(item => item.root.toLowerCase())).size !== mappings.length) throw new Error("Duplicate VSS mount root");
  const identities = new Map<string, string>();
  for (const item of mappings) {
    const guid = item.guid.toLowerCase(), device = item.device.replace(/\\$/, "").toLowerCase(), snapshot = item.snapshotId.toLowerCase();
    for (const [key, identity] of [[`volume:${guid}`, `${device}:${snapshot}`], [`device:${device}`, `${guid}:${snapshot}`], [`snapshot:${snapshot}`, `${guid}:${device}`]] as const) {
      if (identities.has(key) && identities.get(key) !== identity) throw new Error("Inconsistent VSS snapshot identity across mount roots");
      identities.set(key, identity);
    }
  }
  return mappings;
}
export function mapVssSources(sources: ResolvedSource[], value: Record<string, unknown>, mode: string): ResolvedSource[] {
  const mappings = snapshotMappings(value, mode);
  const resolver = createVssPathResolver(mappings);
  return sources.map(source => {
    return { ...source, path: resolver.mappedPath(source.path) };
  });
}
export function attachVssSourceSession(task: TaskConfig, sources: ResolvedSource[], snapshotLease: Record<string, unknown>, release: VssSourceSession["release"], signal?: AbortSignal): VssSourceSession {
  const mapped = mapVssSources(sources, snapshotLease, task.snapshot.mode);
  const mappings = snapshotMappings(snapshotLease, task.snapshot.mode);
  const resolver = createVssPathResolver(mappings);
  return {
    sources: mapped, consistentSnapshot: true, snapshotLease, followsLinksInSnapshot: true,
    async validateSources() { for (const source of sources) await resolver.resolve(source.path, signal, { followFinal: task.symlinks === "follow" }); },
    scan: createVssSnapshotScanner(sources, mappings), release,
  };
}
async function helperExecutable(configured?: string): Promise<string> {
  const processWithResources = process as NodeJS.Process & { resourcesPath?: string };
  const candidates = configured ? [configured] : process.env.DELTA_VSS_HELPER_PATH ? [process.env.DELTA_VSS_HELPER_PATH] : [
    path.join(path.dirname(process.execPath), "native", "delta-vss.exe"),
    path.join(path.dirname(process.execPath), "..", "native", "delta-vss.exe"),
    ...(processWithResources.resourcesPath ? [path.join(processWithResources.resourcesPath, "native", "delta-vss.exe")] : []),
  ];
  for (const candidate of candidates) {
    if (!path.isAbsolute(candidate)) throw new Error("The VSS helper path must be absolute");
    try { await access(candidate); const details = await lstat(candidate); if (details.isFile() && !details.isSymbolicLink()) return path.resolve(candidate); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  throw new Error("Native VSS helper is missing from this installation");
}
export function createVssSourceProvider(options: VssProviderOptions = {}) {
  const timeout = options.timeoutMs ?? 120_000;
  if (!Number.isSafeInteger(timeout) || timeout < 1000 || timeout > 600_000) throw new Error("Invalid VSS helper timeout");
  type Client = { child: ChildProcessWithoutNullStreams; channel: Channel; exited: Promise<number>; dead: boolean; diagnostics: string; heartbeat?: NodeJS.Timeout };
  let shared: Client | undefined; let queue = Promise.resolve(); let shuttingDown = false; let shutdownPromise: Promise<void> | undefined;
  const waitExit = async (client: Client) => {
    let timer: NodeJS.Timeout | undefined;
    try { return await Promise.race([client.exited, new Promise<never>((_, reject) => { timer = setTimeout(() => { client.child.kill(); reject(new Error("VSS client exit timed out; snapshot cleanup could not be verified")); }, timeout); })]); }
    finally { if (timer) clearTimeout(timer); }
  };
  const cleanupReply = (response: Frame) => {
    const data = document(response);
    if (response.opcode !== 0x82 || data.cleanupVerified !== true || data.ownedSnapshotsDeleted !== true) throw new Error("VSS snapshot deletion could not be verified");
  };
  const stop = async (client: Client) => {
    if (client.heartbeat) clearInterval(client.heartbeat);
    if (shared === client) shared = undefined;
    try {
      if (!client.dead && !client.child.stdin.writableEnded && !client.child.stdin.destroyed) { await client.channel.send(4); cleanupReply(await client.channel.frame()); }
    } finally { client.child.stdin.end(); if (await waitExit(client) !== 0) throw new Error(`VSS client exited unsuccessfully: ${client.diagnostics}`); }
  };
  const clientForOperation = async (): Promise<Client> => {
    if (options.persistent && shared && !shared.dead) return shared;
    const executable = await helperExecutable(options.helperPath);
    const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(NODE_|ELECTRON_)/i.test(key)));
    const arguments_ = [options.persistent ? "--session" : "--lease"];
    const child = options.launch ? options.launch(executable, arguments_) : spawn(executable, arguments_, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: environment });
    const channel = new Channel(child.stdout, child.stdin, timeout);
    const client = { child, channel, dead: false, diagnostics: "" } as Client;
    child.stderr.on("data", (chunk: Buffer) => { if (client.diagnostics.length < 8192) client.diagnostics += chunk.toString("utf8").slice(0, 8192 - client.diagnostics.length); });
    client.exited = new Promise<number>((resolve, reject) => { child.once("error", error => { client.dead = true; reject(error); }); child.once("exit", (code, signal) => { client.dead = true; if (client.heartbeat) clearInterval(client.heartbeat); code === null ? reject(new Error(`VSS client terminated by ${signal}`)) : resolve(code); }); });
    void client.exited.catch(() => {});
    if (options.persistent) shared = client;
    return client;
  };
  const gate = async (signal?: AbortSignal) => {
    const previous = queue; let unlock!: () => void;
    const slot = new Promise<void>(resolve => { unlock = resolve; }); queue = previous.then(() => slot);
    let aborted: (() => void) | undefined;
    try {
      signal?.throwIfAborted();
      await Promise.race([previous, new Promise<never>((_, reject) => { if (signal) { aborted = () => reject(signal.reason ?? new Error("VSS operation was aborted")); signal.addEventListener("abort", aborted, { once: true }); } })]);
      signal?.throwIfAborted(); return unlock;
    } catch (error) { unlock(); throw error; }
    finally { if (aborted) signal?.removeEventListener("abort", aborted); }
  };
  return {
    async prepare(task: TaskConfig, execution: { sources?: ResolvedSource[]; signal?: AbortSignal } = {}): Promise<VssSourceSession> {
      if ((options.platform ?? process.platform) !== "win32") throw new Error("VSS is available only on Windows");
      execution.signal?.throwIfAborted();
      if (task.snapshot.mode === "off") throw new Error("VSS source provider was called for a task with VSS disabled");
      const sources = execution.sources ?? resolveTaskSources(task); const encoded = request(task, sources);
      const unlock = await gate(execution.signal); let client: Client | undefined; let releasePromise: Promise<void> | undefined;
      const release = (outcome?: { success: boolean }) => releasePromise ??= (async () => {
        if (!client) { unlock(); return; }
        try {
          const aborted = execution.signal?.aborted === true || outcome?.success === false;
          await client.channel.send(aborted ? 4 : 2); cleanupReply(await client.channel.frame());
          if (!options.persistent || aborted) {
            if (client.heartbeat) clearInterval(client.heartbeat); if (shared === client) shared = undefined;
            client.child.stdin.end(); if (await waitExit(client) !== 0) throw new Error(`VSS client exited unsuccessfully: ${client.diagnostics}`);
          }
        } catch (error) {
          if (!(options.persistent && (error as { cleanupVerified?: boolean }).cleanupVerified === true)) await stop(client).catch(() => {});
          throw error;
        } finally { unlock(); }
      })();
      try {
        if (shuttingDown) throw new Error("VSS source provider is shutting down");
        client = await clientForOperation(); await client.channel.send(1, encoded);
        if (!client.heartbeat) { const current = client; current.heartbeat = setInterval(() => { void current.channel.send(3).catch(() => { current.child.stdin.end(); current.dead = true; if (current.heartbeat) clearInterval(current.heartbeat); }); }, 30_000); current.heartbeat.unref(); }
        const response = await client.channel.frame(); const data = document(response);
        if (response.opcode !== 0x81) throw new Error("Unexpected VSS prepare response");
        execution.signal?.throwIfAborted();
        return attachVssSourceSession(task, sources, data, release, execution.signal);
      } catch (error) {
        if (client && !(options.persistent && (error as { cleanupVerified?: boolean }).cleanupVerified === true)) await stop(client).catch(() => {});
        unlock(); throw error;
      }
    },
    shutdown() {
      shuttingDown = true;
      return shutdownPromise ??= (async () => { await queue; if (shared) await stop(shared); })();
    },
  };
}
