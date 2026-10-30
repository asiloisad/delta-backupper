import assert from "node:assert/strict";
import { test, after } from "node:test";
import { build } from "esbuild";
import { createRequire } from "node:module";
import { randomBytes, createHmac, createHash, randomUUID } from "node:crypto";
import { createConnection, createServer } from "node:net";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, stat, lstat, rm, realpath, rmdir, unlink } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { runtimeDirectory, ensureRuntimeDirectory } from "../../src/platform/application-paths.mjs";

const workspace = await mkdtemp(path.join(tmpdir(), "delta-coord-")), temporarySocketDirectories = [];
process.env.LOCALAPPDATA = path.join(workspace, "state"); process.env.XDG_STATE_HOME = path.join(workspace, "state");
after(async () => { await rm(workspace, { recursive: true, force: true }); for (const directory of temporarySocketDirectories) await rmdir(directory); });
const bundle = path.join(workspace, "coordinator.cjs"); await build({ entryPoints: ["src/service/coordinator.ts"], outfile: bundle, bundle: true, platform: "node", target: "node24", format: "cjs", logLevel: "silent" });
const { startCoordinator, connectCoordinator, CoordinatorError } = createRequire(import.meta.url)(bundle);
const capability = () => randomBytes(32).toString("hex");
const signature = (token, role, client, server) => createHmac("sha256", Buffer.from(token, "hex")).update(`DeltaCoordinator/1/${role}/${client}/${server}`).digest("hex");
function encode(value) { const body = Buffer.from(JSON.stringify({ version: 1, ...value })); const size = Buffer.alloc(4); size.writeUInt32LE(body.length); return Buffer.concat([size, body]); }
function peer(socket, onFrame) {
  let pending = Buffer.alloc(0);
  socket.on("data", bytes => { pending = Buffer.concat([pending, bytes]); for (;;) { if (pending.length < 4 || pending.length < pending.readUInt32LE() + 4) return; const size = pending.readUInt32LE(); const value = JSON.parse(pending.subarray(4, size + 4)); pending = pending.subarray(size + 4); onFrame(value); } });
}
async function fixture(t, handler = async request => ({ action: request.action })) {
  const directory = await mkdtemp(path.join(workspace, "profile-")), coordinator = await startCoordinator(directory, handler); t.after(() => coordinator.close());
  return { directory, coordinator, info: JSON.parse(await readFile(path.join(runtimeDirectory(directory), "coordinator.json"), "utf8")) };
}
async function endpoint(directory) {
  if (process.platform === "win32") return `\\\\.\\pipe\\delta-coordinator-${randomUUID()}`;
  const key = createHash("sha256").update(await realpath(await ensureRuntimeDirectory(directory))).digest("hex").slice(0, 12), base = Buffer.byteLength(path.join(tmpdir(), "delta-coord-000000000000-000000", "channel")) <= 100 ? tmpdir() : "/tmp";
  const temporary = await mkdtemp(path.join(base, `delta-coord-${key}-`)); temporarySocketDirectories.push(temporary); return path.join(temporary, "channel");
}
async function fakeInfo(directory, overrides = {}) { await ensureRuntimeDirectory(directory); const info = { version: 1, pid: process.pid, host: hostname(), endpoint: await endpoint(directory), token: capability(), ...overrides }; await writeFile(path.join(runtimeDirectory(directory), "coordinator.json"), JSON.stringify(info), { mode: 0o600 }); return info; }

test("coordinator serves real requests, isolates probe, propagates operation errors and cleans owned discovery", async t => {
  const calls = []; const { directory, coordinator } = await fixture(t, async request => { calls.push(request); if (request.action === "failure") { const error = new Error("Expected operation error"); error.code = "DELTA_LOCKED"; throw error; } return { action: request.action, length: request.password?.length ?? 0 }; });
  const client = await connectCoordinator(directory); assert(client); assert.equal(calls.length, 0, "discovery probe must not execute the application handler");
  const secret = "hasło 密碼 🌍 exact "; assert.deepEqual(await client.request({ action: "run", password: secret }), { action: "run", length: secret.length }); assert.equal(calls[0].password, secret);
  await assert.rejects(client.request({ action: "failure" }), error => error.code === "DELTA_LOCKED" && error.message === "Expected operation error");
  if (process.platform !== "win32") { assert.equal((await stat(path.join(runtimeDirectory(directory), "coordinator.json"))).mode & 0o777, 0o600); assert.equal((await stat(runtimeDirectory(directory))).mode & 0o777, 0o700); }
  await coordinator.close(); await coordinator.close(); assert.equal(await connectCoordinator(directory), null);
});

test("absent and definitely dead local owners allow standalone execution; live broken owners never do", async () => {
  const directory = await mkdtemp(path.join(workspace, "discovery-")); assert.equal(await connectCoordinator(directory), null);
  const child = spawn(process.execPath, ["-e", ""], { windowsHide: true, stdio: "ignore" }); const pid = child.pid; await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  await fakeInfo(directory, { pid }); assert.equal(await connectCoordinator(directory), null);
  await fakeInfo(directory); await assert.rejects(connectCoordinator(directory), error => error instanceof CoordinatorError && error.code === "COORDINATOR_UNAVAILABLE");
  await fakeInfo(directory, { host: "another-host" }); await assert.rejects(connectCoordinator(directory), /different host|identity/);
  await fakeInfo(directory, { version: 99 }); await assert.rejects(connectCoordinator(directory), /identity/);
});

test("Unix endpoints outside recognized private socket directories are rejected before connection", { skip: process.platform === "win32" }, async t => {
  const directory = await realpath(await mkdtemp("/tmp/delta-coord-old-"));
  await ensureRuntimeDirectory(directory); const filename = path.join(runtimeDirectory(directory), "coordinator.json"), endpoint = path.join(directory, `coordinator-${randomUUID()}.sock`);
  let connections = 0;
  const server = createServer(socket => { connections++; socket.destroy(); });
  t.after(async () => {
    if (server.listening) await new Promise(resolve => server.close(resolve));
    await unlink(filename).catch(error => { if (error.code !== "ENOENT") throw error; });
    await rmdir(directory);
  });
  await new Promise(resolve => server.listen(endpoint, resolve));
  await writeFile(filename, JSON.stringify({ version: 1, pid: process.pid, host: hostname(), endpoint, token: capability() }), { mode: 0o600 });
  await assert.rejects(connectCoordinator(directory), /discovery identity/);
  assert.equal(connections, 0);
});

test("only one concurrent coordinator owns a profile and stale dead discovery can be replaced", async () => {
  const directory = await mkdtemp(path.join(workspace, "exclusive-"));
  const results = await Promise.allSettled([startCoordinator(directory, async () => 1), startCoordinator(directory, async () => 2)]);
  assert.equal(results.filter(value => value.status === "fulfilled").length, 1); assert.equal(results.filter(value => value.status === "rejected").length, 1);
  const owner = results.find(value => value.status === "fulfilled").value; await owner.close();
  const child = spawn(process.execPath, ["-e", ""], { windowsHide: true, stdio: "ignore" }); const pid = child.pid; await new Promise(resolve => child.once("close", resolve));
  await fakeInfo(directory, { pid }); const replacement = await startCoordinator(directory, async () => 3);
  try { assert.equal(await (await connectCoordinator(directory)).request({ action: "run" }), 3); } finally { await replacement.close(); }
});

test("wrong client HMAC and oversized frames never reach the application handler", async t => {
  let calls = 0; const { info } = await fixture(t, async () => { calls++; });
  const forged = createConnection(info.endpoint); const closed = new Promise(resolve => forged.once("close", resolve));
  forged.on("error", () => {}); peer(forged, frame => { assert.equal(frame.type, "challenge"); forged.write(encode({ type: "authenticate", proof: "0".repeat(64) })); });
  forged.once("connect", () => forged.write(encode({ type: "hello", clientNonce: capability() }))); await closed;
  const oversized = createConnection(info.endpoint), rejected = new Promise(resolve => oversized.once("close", resolve)); oversized.on("error", () => {});
  oversized.once("connect", () => { const header = Buffer.alloc(4); header.writeUInt32LE(1024 ** 2 + 1); oversized.write(header); }); await rejected;
  assert.equal(calls, 0);
});

test("secret requests are withheld when the server proof fails after successful discovery", async () => {
  const directory = await mkdtemp(path.join(workspace, "forged-server-")), info = await fakeInfo(directory), received = [];
  let connections = 0; const server = createServer(socket => {
    const ordinal = ++connections; let clientNonce, serverNonce;
    socket.on("error", () => {}); peer(socket, frame => {
      received.push(frame);
      if (frame.type === "hello") { clientNonce = frame.clientNonce; serverNonce = capability(); socket.write(encode({ type: "challenge", serverNonce, proof: ordinal === 2 ? "0".repeat(64) : signature(info.token, "server", clientNonce, serverNonce) })); }
      else if (frame.type === "authenticate") socket.write(encode({ type: "authenticated", proof: ordinal === 3 ? "0".repeat(64) : signature(info.token, "ready", clientNonce, serverNonce) }));
      else if (frame.type === "probe") socket.end(encode({ type: "response", ok: true, value: { protocol: 1 } }));
    });
  });
  await new Promise(resolve => server.listen(info.endpoint, resolve));
  try {
    const client = await connectCoordinator(directory); const secret = "NEVER_TRANSMIT_UNAUTHENTICATED_PASSWORD_密碼";
    await assert.rejects(client.request({ action: "run", password: secret }), /authentication failed/);
    await assert.rejects(client.request({ action: "run", password: secret }), /readiness authentication failed/);
    assert(!JSON.stringify(received).includes(secret)); assert(!received.some(frame => frame.type === "request"));
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test("lost connection after an authenticated request reports an uncertain outcome without retrying", async () => {
  const directory = await mkdtemp(path.join(workspace, "uncertain-")), info = await fakeInfo(directory); let requests = 0;
  const server = createServer(socket => {
    let clientNonce, serverNonce; socket.on("error", () => {}); peer(socket, frame => {
      if (frame.type === "hello") { clientNonce = frame.clientNonce; serverNonce = capability(); socket.write(encode({ type: "challenge", serverNonce, proof: signature(info.token, "server", clientNonce, serverNonce) })); }
      else if (frame.type === "authenticate") socket.write(encode({ type: "authenticated", proof: signature(info.token, "ready", clientNonce, serverNonce) }));
      else if (frame.type === "probe") socket.end(encode({ type: "response", ok: true, value: { protocol: 1 } }));
      else if (frame.type === "request") { requests++; socket.destroy(); }
    });
  }); await new Promise(resolve => server.listen(info.endpoint, resolve));
  try { const client = await connectCoordinator(directory); await assert.rejects(client.request({ action: "run" }), error => error.code === "COORDINATOR_UNCERTAIN"); assert.equal(requests, 1); }
  finally { await new Promise(resolve => server.close(resolve)); }
});

test("request and response budgets reject oversized data without invoking unintended work", async t => {
  let calls = 0; const { directory } = await fixture(t, async request => { calls++; return request.action === "large" ? "x".repeat(8 * 1024 ** 2 + 1) : true; }); const client = await connectCoordinator(directory);
  await assert.rejects(client.request({ action: "run", payload: "x".repeat(1024 ** 2) }), /size limit|serialized/); assert.equal(calls, 0);
  await assert.rejects(client.request({ action: "large" }), /serialized/); assert.equal(calls, 1);
});

test("close preserves a replacement discovery token and destroys outstanding owned connections", async t => {
  const { directory, coordinator, info } = await fixture(t);
  const waiting = createConnection(info.endpoint); waiting.on("error", () => {}); await new Promise(resolve => waiting.once("connect", resolve));
  const replacement = { ...info, token: capability() }; await writeFile(path.join(runtimeDirectory(directory), "coordinator.json"), JSON.stringify(replacement), { mode: 0o600 });
  const closed = new Promise(resolve => waiting.once("close", resolve)); await coordinator.close(); await closed;
  assert.equal(JSON.parse(await readFile(path.join(runtimeDirectory(directory), "coordinator.json"), "utf8")).token, replacement.token);
});

test("unauthenticated sockets expire at the five-second deadline", { timeout: 8000 }, async t => {
  const { info } = await fixture(t); const socket = createConnection(info.endpoint); socket.on("error", () => {}); const started = Date.now(); await new Promise(resolve => socket.once("close", resolve));
  assert(Date.now() - started >= 4500); assert(Date.now() - started < 7500);
});

test("at most thirty-two sockets can hold authentication slots", { timeout: 6000 }, async t => {
  const { info, coordinator } = await fixture(t), sockets = [];
  for (let index = 0; index < 32; index++) { const socket = createConnection(info.endpoint); socket.on("error", () => {}); await new Promise(resolve => socket.once("connect", resolve)); sockets.push(socket); }
  const extra = createConnection(info.endpoint); extra.on("error", () => {}); const started = Date.now(); await new Promise(resolve => extra.once("close", resolve));
  assert(Date.now() - started < 1500, "excess connections should be rejected before the authentication deadline");
  await coordinator.close(); for (const socket of sockets) socket.destroy();
});

test("deep configuration paths use a short independent local endpoint and clean its private directory", async t => {
  const directory = path.join(workspace, `deep-${randomUUID()}`, "nested-profile-".repeat(5), "another-segment-".repeat(5));
  assert(Buffer.byteLength(directory) > 100);
  const coordinator = await startCoordinator(directory, async () => ({ status: "complete" })); t.after(() => coordinator.close());
  const info = JSON.parse(await readFile(path.join(runtimeDirectory(directory), "coordinator.json"), "utf8")); assert(Buffer.byteLength(info.endpoint) <= 100);
  const client = await connectCoordinator(directory); assert.equal((await client.request({ action: "status" })).status, "complete");
  if (process.platform !== "win32") {
    assert.notEqual(path.dirname(info.endpoint), directory); assert.equal((await stat(path.dirname(info.endpoint))).mode & 0o777, 0o700); assert.equal((await stat(info.endpoint)).mode & 0o777, 0o600);
    await coordinator.close(); await assert.rejects(lstat(path.dirname(info.endpoint)), { code: "ENOENT" });
  }
});
