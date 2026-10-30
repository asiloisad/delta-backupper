import { createServer, createConnection, type Socket, type Server } from "node:net";
import { lstat, mkdir, chmod, open, readFile, rename, unlink, mkdtemp, realpath, rmdir } from "node:fs/promises";
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import type { ApiRequest } from "./api.js";
import { runtimeDirectory, ensureRuntimeDirectory } from "../platform/application-paths.mjs";

const VERSION = 1, REQUEST_LIMIT = 1024 ** 2, RESPONSE_LIMIT = 8 * 1024 ** 2;
const AUTH_TIMEOUT = 5000, REQUEST_TIMEOUT = 30000, CONNECTION_LIMIT = 32;
type Frame = Record<string, unknown>;
interface CoordinatorInfo { version: 1; pid: number; host: string; endpoint: string; token: string }
export class CoordinatorError extends Error {
  constructor(message: string, readonly code = "COORDINATOR_UNAVAILABLE") { super(message); this.name = "CoordinatorError"; }
}
function fileFor(directory: string): string { return path.join(path.resolve(directory), "coordinator.json"); }
function hex(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }
function proof(token: string, role: string, client: string, server: string): string { return createHmac("sha256", Buffer.from(token, "hex")).update(`DeltaCoordinator/${VERSION}/${role}/${client}/${server}`).digest("hex"); }
function equal(value: unknown, expected: string): boolean { return hex(value) && timingSafeEqual(Buffer.from(value, "hex"), Buffer.from(expected, "hex")); }
function alive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; if ((error as NodeJS.ErrnoException).code === "EPERM") return true; throw error; } }
function profileKey(canonicalDirectory: string): string { return createHash("sha256").update(canonicalDirectory).digest("hex").slice(0, 12); }
function shortTemporaryBase(): string {
  const candidate = path.resolve(tmpdir());
  // macOS TMPDIR can itself be long; /tmp provides a short sticky system directory.
  return Buffer.byteLength(path.join(candidate, "delta-coord-000000000000-000000", "channel")) <= 100 ? candidate : "/tmp";
}
function endpointValid(directory: string, endpoint: unknown): endpoint is string {
  if (typeof endpoint !== "string" || endpoint.includes("\0")) return false;
  if (process.platform === "win32") return /^\\\\\.\\pipe\\delta-coordinator-[a-f0-9-]{36}$/.test(endpoint);
  return path.isAbsolute(endpoint) && path.resolve(endpoint) === endpoint && path.basename(endpoint) === "channel" && new RegExp(`^delta-coord-${profileKey(directory)}-[A-Za-z0-9]{6}$`).test(path.basename(path.dirname(endpoint)));
}
async function readInfo(directory: string): Promise<{ value: CoordinatorInfo; bytes: string } | null> {
  let parent;
  try { parent = await lstat(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  if (!parent.isDirectory() || parent.isSymbolicLink() || process.platform !== "win32" && ((parent.mode & 0o077) !== 0 || process.getuid && parent.uid !== process.getuid())) throw new CoordinatorError("Coordinator runtime directory is not private.");
  const filename = fileFor(directory);
  let stat;
  try { stat = await lstat(filename); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8192 || (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())))) throw new CoordinatorError("Coordinator discovery file is not a private ordinary file.");
  const bytes = await readFile(filename, "utf8"); let value: CoordinatorInfo;
  try { value = JSON.parse(bytes); } catch { throw new CoordinatorError("Coordinator discovery file is invalid."); }
  const identityDirectory = process.platform === "win32" ? directory : await realpath(directory);
  if (!value || value.version !== VERSION || !Number.isInteger(value.pid) || value.pid <= 0 || value.host !== hostname() || !hex(value.token) || !endpointValid(identityDirectory, value.endpoint)) throw new CoordinatorError("Coordinator discovery identity is invalid or belongs to a different host.");
  return { value, bytes };
}
function send(socket: Socket, frame: Frame, maximum: number): void {
  const body = Buffer.from(JSON.stringify({ version: VERSION, ...frame }), "utf8");
  if (!body.length || body.length > maximum) throw new CoordinatorError("Coordinator message exceeds its size limit.", "COORDINATOR_PROTOCOL");
  const header = Buffer.allocUnsafe(4); header.writeUInt32LE(body.length); socket.write(Buffer.concat([header, body]));
}
function frames(socket: Socket, maximum: number, handle: (frame: Frame) => void, failure: () => void): void {
  let pending = Buffer.alloc(0), count = 0;
  socket.on("data", (chunk: Buffer) => {
    try {
      if (pending.length + chunk.length > maximum + 4096) throw new Error(); pending = Buffer.concat([pending, chunk]);
      for (;;) {
        if (pending.length < 4) return; const length = pending.readUInt32LE();
        if (!length || length > maximum) throw new Error(); if (pending.length < length + 4) return;
        if (++count > 6) throw new Error();
        const frame = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(pending.subarray(4, length + 4))); pending = pending.subarray(length + 4);
        if (!frame || typeof frame !== "object" || Array.isArray(frame) || frame.version !== VERSION) throw new Error(); handle(frame);
      }
    } catch { failure(); }
  });
}
async function removeIfBytes(filename: string, expected: string): Promise<void> { if (await readFile(filename, "utf8").catch(() => "") === expected) await unlink(filename).catch(error => { if (error.code !== "ENOENT") throw error; }); }
async function closeServer(server: Server): Promise<void> { if (server.listening) await new Promise<void>(resolve => server.close(() => resolve())); }

/** Local profile coordinator. Windows uses the process default DACL plus profile-token authentication. */
export async function startCoordinator(configDirectory: string, handler: (request: ApiRequest) => Promise<unknown>): Promise<{ close(): Promise<void> }> {
  const directory = await ensureRuntimeDirectory(configDirectory);
  if (process.platform !== "win32") await chmod(directory, 0o700);
  const filename = fileFor(directory), lockPath = path.join(directory, "coordinator.init-lock");
  const token = randomBytes(32).toString("hex"), lockBytes = JSON.stringify({ host: hostname(), pid: process.pid, token });
  let lockOwned = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(lockPath, "wx", 0o600); lockOwned = true;
      try { await handle.writeFile(lockBytes); await handle.sync(); } finally { await handle.close(); } break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let owner: { host?: string; pid?: number }; const bytes = await readFile(lockPath, "utf8");
      try { owner = JSON.parse(bytes); } catch { throw new CoordinatorError("Coordinator initialization lock has an unknown owner."); }
      if (owner.host !== hostname() || !Number.isInteger(owner.pid) || owner.pid! <= 0 || alive(owner.pid!)) throw new CoordinatorError("A coordinator is already starting or running.");
      await removeIfBytes(lockPath, bytes);
    }
  }
  if (!lockOwned) throw new CoordinatorError("Could not obtain coordinator initialization lock.");
  let endpoint = process.platform === "win32" ? `\\\\.\\pipe\\delta-coordinator-${randomUUID()}` : "";
  let socketDirectory: string | undefined, socketIdentity: { dev: bigint; ino: bigint } | undefined;
  const server = createServer(), sockets = new Set<Socket>(); let ownsInfo = false, infoBytes = "", closing = false;
  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => closePromise ??= (async () => {
    closing = true; for (const socket of sockets) socket.destroy(); await closeServer(server);
    if (ownsInfo) await removeIfBytes(filename, infoBytes);
    // Node's bound Unix server removes its own socket on close. Do not unlink an unrelated replacement.
    if (socketDirectory && socketIdentity) {
      const current = await lstat(socketDirectory, { bigint: true }).catch(error => { if (error.code === "ENOENT") return null; throw error; });
      if (current?.isDirectory() && !current.isSymbolicLink() && current.dev === socketIdentity.dev && current.ino === socketIdentity.ino) await rmdir(socketDirectory);
    }
  })();
  try {
    const previous = await readInfo(directory); if (previous && alive(previous.value.pid)) throw new CoordinatorError("A coordinator is already running for this profile.");
    if (process.platform !== "win32") {
      socketDirectory = await mkdtemp(path.join(shortTemporaryBase(), `delta-coord-${profileKey(await realpath(directory))}-`));
      socketIdentity = await lstat(socketDirectory, { bigint: true }); await chmod(socketDirectory, 0o700);
      endpoint = path.join(socketDirectory, "channel");
    }
    if (process.platform !== "win32" && Buffer.byteLength(endpoint) > 100) throw new CoordinatorError("Configuration path is too long for a local Unix coordinator socket.");
    server.on("connection", socket => {
      if (closing || sockets.size >= CONNECTION_LIMIT) { socket.destroy(); return; }
      sockets.add(socket); let phase = "hello", clientNonce = "", serverNonce = "", done = false;
      let timer = setTimeout(() => socket.destroy(), AUTH_TIMEOUT);
      const finish = () => { if (done) return; done = true; clearTimeout(timer); socket.destroy(); };
      socket.once("close", () => { done = true; clearTimeout(timer); sockets.delete(socket); }); socket.on("error", finish);
      frames(socket, REQUEST_LIMIT, frame => {
        if (done) return;
        if (phase === "hello") {
          if (frame.type !== "hello" || !hex(frame.clientNonce)) { finish(); return; }
          clientNonce = frame.clientNonce; serverNonce = randomBytes(32).toString("hex"); phase = "authenticate";
          send(socket, { type: "challenge", serverNonce, proof: proof(token, "server", clientNonce, serverNonce) }, RESPONSE_LIMIT);
        } else if (phase === "authenticate") {
          if (frame.type !== "authenticate" || !equal(frame.proof, proof(token, "client", clientNonce, serverNonce))) { finish(); return; }
          phase = "request"; clearTimeout(timer); timer = setTimeout(() => socket.destroy(), REQUEST_TIMEOUT);
          send(socket, { type: "authenticated", proof: proof(token, "ready", clientNonce, serverNonce) }, RESPONSE_LIMIT);
        } else if (phase === "request") {
          phase = "working";
          if (frame.type === "probe") { phase = "done"; send(socket, { type: "response", ok: true, value: { protocol: VERSION } }, RESPONSE_LIMIT); socket.end(); return; }
          if (frame.type !== "request" || !frame.request || typeof frame.request !== "object" || Array.isArray(frame.request) || typeof (frame.request as ApiRequest).action !== "string") { finish(); return; }
          void Promise.resolve().then(() => handler(frame.request as ApiRequest)).then(value => {
            if (done) return; phase = "done"; send(socket, { type: "response", ok: true, value }, RESPONSE_LIMIT); socket.end();
          }, error => {
            if (done) return; phase = "done"; send(socket, { type: "response", ok: false, error: { message: error instanceof Error ? error.message : String(error), code: typeof error?.code === "string" ? error.code : undefined } }, RESPONSE_LIMIT); socket.end();
          }).catch(() => { if (!done) { try { phase = "done"; send(socket, { type: "response", ok: false, error: { message: "Coordinator response could not be serialized.", code: "COORDINATOR_PROTOCOL" } }, RESPONSE_LIMIT); socket.end(); } catch { finish(); } } });
        } else finish();
      }, finish);
    });
    server.on("error", () => { for (const socket of sockets) socket.destroy(); });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(endpoint, () => { server.removeListener("error", reject); resolve(); }); });
    if (process.platform !== "win32") await chmod(endpoint, 0o600);
    const info: CoordinatorInfo = { version: VERSION, pid: process.pid, host: hostname(), endpoint, token };
    infoBytes = `${JSON.stringify(info)}\n`;
    const temporary = path.join(directory, `.coordinator.${randomUUID()}.tmp`);
    try {
      const handle = await open(temporary, "wx", 0o600); try { await handle.writeFile(infoBytes); await handle.sync(); } finally { await handle.close(); }
      const current = await readInfo(directory);
      if ((current?.bytes ?? null) !== (previous?.bytes ?? null)) throw new CoordinatorError("Coordinator discovery changed during startup.");
      await rename(temporary, filename); ownsInfo = true;
    } finally { await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }
    return { close };
  } catch (error) { await close(); throw error; }
  finally { await removeIfBytes(lockPath, lockBytes); }
}

async function exchange(info: CoordinatorInfo, request?: ApiRequest): Promise<any> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(info.endpoint); const clientNonce = randomBytes(32).toString("hex"); let serverNonce = "", phase = "challenge", settled = false, requestSent = false;
    let timer = setTimeout(() => fail("Coordinator authentication timed out."), AUTH_TIMEOUT);
    const fail = (message: string) => { if (settled) return; settled = true; clearTimeout(timer); socket.destroy(); reject(new CoordinatorError(message, requestSent ? "COORDINATOR_UNCERTAIN" : "COORDINATOR_UNAVAILABLE")); };
    socket.once("error", () => fail("Coordinator owner is live but its local channel is unavailable; no local fallback was started."));
    socket.once("close", () => { if (!settled) fail("Coordinator connection closed without a confirmed response; no local fallback was started."); });
    socket.once("connect", () => { try { send(socket, { type: "hello", clientNonce }, REQUEST_LIMIT); } catch { fail("Coordinator hello could not be sent."); } });
    frames(socket, RESPONSE_LIMIT, frame => {
      if (settled) return;
      if (phase === "challenge") {
        if (frame.type !== "challenge" || !hex(frame.serverNonce) || !equal(frame.proof, proof(info.token, "server", clientNonce, frame.serverNonce))) { fail("Coordinator server authentication failed; request was not sent."); return; }
        serverNonce = frame.serverNonce; phase = "authenticated"; send(socket, { type: "authenticate", proof: proof(info.token, "client", clientNonce, serverNonce) }, REQUEST_LIMIT);
      } else if (phase === "authenticated") {
        if (frame.type !== "authenticated" || !equal(frame.proof, proof(info.token, "ready", clientNonce, serverNonce))) { fail("Coordinator readiness authentication failed; request was not sent."); return; }
        phase = "response"; clearTimeout(timer); timer = setTimeout(() => fail("Coordinator request timed out; its outcome may be unknown."), REQUEST_TIMEOUT);
        try { send(socket, request ? { type: "request", request } : { type: "probe" }, REQUEST_LIMIT); requestSent = request !== undefined; } catch { fail("Coordinator request could not be serialized within its size limit."); }
      } else if (phase === "response") {
        if (frame.type !== "response" || typeof frame.ok !== "boolean") { fail("Coordinator response is invalid."); return; }
        settled = true; clearTimeout(timer); socket.end();
        if (frame.ok) resolve(frame.value);
        else { const detail = frame.error as { message?: unknown; code?: unknown } | undefined; reject(new CoordinatorError(typeof detail?.message === "string" ? detail.message : "Coordinator operation failed.", typeof detail?.code === "string" ? detail.code : "COORDINATOR_OPERATION_FAILED")); }
      } else fail("Coordinator sent an unexpected message.");
    }, () => fail("Coordinator response exceeded its limit or violated the protocol."));
  });
}

/** Null permits standalone execution only when discovery is absent or its local owner is definitely dead. */
export async function connectCoordinator(configDirectory: string): Promise<null | { request(request: ApiRequest): Promise<any> }> {
  const found = await readInfo(runtimeDirectory(configDirectory)); if (!found || !alive(found.value.pid)) return null;
  const probe = await exchange(found.value); if (probe?.protocol !== VERSION) throw new CoordinatorError("Coordinator probe failed.");
  return { request: request => exchange(found.value, request) };
}
