import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { PassThrough, Writable } from "node:stream";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runVssWorker, VSS_FIXTURE_BYTES, VSS_FIXTURE_SHA256 } from "../../src/core/vss-worker.ts";

// These are synthetic broker peers. They exercise the real worker parser and
// streaming code without claiming that a VSS snapshot has been created.
const line = Buffer.from("Delta snapshot original — zażółć Δ 日本語\n", "utf8");
const content = Buffer.from(line.toString("utf8").repeat(65_536), "utf8");
const sha256 = createHash("sha256").update(content).digest("hex");
const requestPaths = ["C:\\Windows\\System32\\config\\SAM", "..\\fixture", "fixture:secret"];

function frame(opcode, payload = Buffer.alloc(0)) {
  const header = Buffer.alloc(12);
  header.write("DV01", 0, "ascii");
  header[4] = opcode;
  header.writeUInt32LE(payload.length, 8);
  return Buffer.concat([header, payload]);
}

async function* requests(stream) {
  let pending = Buffer.alloc(0);
  for await (const chunk of stream) {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= 12 && pending.length >= 12 + pending.readUInt32LE(8)) {
      assert.equal(pending.subarray(0, 4).toString("ascii"), "DV01");
      assert.equal(pending[5], 0);
      assert.equal(pending.readUInt16LE(6), 0);
      const size = pending.readUInt32LE(8);
      assert.ok(size <= 65_536);
      yield { opcode: pending[4], payload: pending.subarray(12, 12 + size) };
      pending = pending.subarray(12 + size);
    }
  }
  assert.equal(pending.length, 0);
}

function setup({ scenario = "normal", timeout = 2_000, totalTimeout = 15_000, slowWrites = false } = {}) {
  const input = new PassThrough({ highWaterMark: 1_024 });
  const requestsPipe = new PassThrough({ highWaterMark: 32 });
  let largestReadRequest = 0;
  const read = input.read.bind(input);
  input.read = size => { largestReadRequest = Math.max(largestReadRequest, size ?? 0); return read(size); };
  const output = slowWrites ? new Writable({
    highWaterMark: 16,
    write(chunk, encoding, callback) {
      setTimeout(() => requestsPipe.write(chunk, callback), 1);
    },
    final(callback) { requestsPipe.end(callback); },
    destroy(error, callback) { requestsPipe.destroy(); callback(error); },
  }) : requestsPipe;
  input.on("error", () => {});
  requestsPipe.on("error", () => {});
  output.on("error", () => {});
  const worker = runVssWorker(input, output, { scenario, readTimeoutMs: timeout, totalTimeoutMs: totalTimeout });
  const iterator = requests(requestsPipe);
  return { input, output, worker, iterator, largestRead: () => largestReadRequest };
}

async function put(stream, bytes, fragment = false) {
  const sizes = fragment ? [1, 2, 5, 7, 509, 4_096, bytes.length] : [bytes.length];
  let offset = 0;
  for (const size of sizes) {
    if (offset >= bytes.length) break;
    const end = Math.min(offset + size, bytes.length);
    await new Promise((resolve, reject) => stream.write(bytes.subarray(offset, end), error => error ? reject(error) : resolve()));
    offset = end;
  }
}

async function nextRequest(peer) {
  const result = await peer.iterator.next();
  assert.equal(result.done, false, "worker closed its request stream prematurely");
  return result.value;
}

async function prelude(peer, { fragment = false, badDenial = false } = {}) {
  await put(peer.input, frame(0x80), fragment);
  for (const source of requestPaths) {
    const request = await nextRequest(peer);
    assert.equal(request.opcode, 1);
    assert.equal(request.payload.toString("utf8"), source);
    await put(peer.input, frame(badDenial ? 0x82 : 0xff), fragment);
    if (badDenial) return;
  }
  const unknown = await nextRequest(peer);
  assert.equal(unknown.opcode, 0x7f);
  assert.equal(unknown.payload.length, 0);
  await put(peer.input, frame(0xff), fragment);
  const request = await nextRequest(peer);
  assert.equal(request.opcode, 1);
  assert.equal(request.payload.toString("utf8"), "fixture");
}

async function serve(peer, { scenario = "normal", fragment = false, corrupt = false, extraAfterEof = false, extraAfterAck = false } = {}) {
  await prelude(peer, { fragment });
  for (let offset = 0; offset < content.length; offset += 65_536) {
    let data = content.subarray(offset, Math.min(offset + 65_536, content.length));
    if (corrupt && offset === 0) { data = Buffer.from(data); data[0] ^= 1; }
    await put(peer.input, frame(0x81, data), fragment);
  }
  await put(peer.input, frame(0x82), fragment);
  if (corrupt) { peer.input.end(); return; }
  if (scenario === "disconnect") {
    assert.equal((await peer.iterator.next()).done, true, "disconnect must not send FINISH or CANCEL");
    return;
  }
  const result = await nextRequest(peer);
  assert.equal(result.opcode, scenario === "cancel" ? 3 : 2);
  assert.equal(result.payload.length, 76);
  assert.equal(result.payload.readBigUInt64LE(0), BigInt(content.length));
  assert.equal(result.payload.readUInt32LE(8), 15);
  assert.equal(result.payload.toString("ascii", 12), sha256);
  if (extraAfterEof) { await put(peer.input, frame(0x81, Buffer.from("extra"))); peer.input.end(); return; }
  await put(peer.input, frame(0x83), fragment);
  if (extraAfterAck) await put(peer.input, frame(0xff));
  peer.input.end();
  if (!extraAfterAck) assert.equal((await peer.iterator.next()).done, true);
}

test("VSS worker hashes a fragmented, backpressured multi-megabyte stream with bounded reads", async () => {
  assert.equal(VSS_FIXTURE_BYTES, content.length);
  assert.equal(VSS_FIXTURE_SHA256, sha256);
  const peer = setup({ slowWrites: true });
  const [result] = await Promise.all([peer.worker, serve(peer, { fragment: true })]);
  assert.deepEqual(result, { scenario: "normal", bytes: content.length, sha256, deniedFlags: 15, acknowledged: true, exitCode: 0 });
  assert.ok(peer.largestRead() <= 65_536);
  assert.equal(peer.input.destroyed, true);
  assert.equal(peer.output.destroyed, true);
});

for (const scenario of ["cancel", "disconnect"]) {
  test(`VSS worker ${scenario} owns and closes its inherited channels`, async () => {
    const peer = setup({ scenario });
    const [result] = await Promise.all([peer.worker, serve(peer, { scenario })]);
    assert.equal(result.exitCode, scenario === "cancel" ? 130 : 0);
    assert.equal(result.acknowledged, scenario !== "disconnect");
    assert.equal(peer.input.destroyed, true);
    assert.equal(peer.output.destroyed, true);
  });
}

test("VSS worker rejects malformed, oversized and wrong-direction frames before reading payloads", async context => {
  const cases = [
    ["magic", header => header.write("BAD!", 0, "ascii")],
    ["high-bit magic", header => { header[0] |= 0x80; }],
    ["flags", header => { header[5] = 1; }],
    ["reserved", header => header.writeUInt16LE(1, 6)],
    ["oversized", header => header.writeUInt32LE(65_537, 8)],
    ["direction", header => { header[4] = 1; }],
    ["control payload", header => header.writeUInt32LE(1, 8)],
    ["reordered EOF", header => { header[4] = 0x82; }],
  ];
  for (const [name, mutate] of cases) await context.test(name, async () => {
    const peer = setup();
    const rejected = assert.rejects(peer.worker, /VSS worker/);
    const header = frame(0x80);
    mutate(header);
    peer.input.end(header);
    await rejected;
    assert.equal(peer.output.destroyed, true);
  });
});

test("VSS worker rejects premature EOF, truncated headers and stalled peers", async context => {
  for (const bytes of [Buffer.alloc(0), frame(0x80).subarray(0, 11)]) await context.test(`EOF after ${bytes.length} bytes`, async () => {
    const peer = setup();
    const rejected = assert.rejects(peer.worker, /ended before|closed unexpectedly/);
    peer.input.end(bytes);
    await rejected;
  });
  const peer = setup({ timeout: 50 });
  await assert.rejects(peer.worker, /timed out/);
  assert.equal(peer.input.destroyed, true);
  assert.equal(peer.output.destroyed, true);
});

test("VSS worker fails when an unauthorized request is not explicitly denied", async () => {
  const peer = setup();
  const rejected = assert.rejects(peer.worker, /protocol state/);
  await prelude(peer, { badDenial: true });
  peer.input.end();
  await rejected;
});

test("VSS worker rejects empty, truncated and premature fixture streams", async context => {
  for (const [name, bytes, pattern] of [
    ["empty DATA", frame(0x81), /file stream frame/],
    ["short content", Buffer.concat([frame(0x81, Buffer.from("short")), frame(0x82)]), /integrity mismatch/],
    ["truncated payload", frame(0x81, Buffer.from("truncated")).subarray(0, 14), /ended before/],
    ["wrong control frame", frame(0x80), /file stream frame/],
  ]) await context.test(name, async () => {
    const peer = setup();
    const rejected = assert.rejects(peer.worker, pattern);
    await prelude(peer);
    peer.input.end(bytes);
    await rejected;
  });
});

test("VSS worker bounds total lifetime even when a peer keeps a partial header moving", async () => {
  const peer = setup({ timeout: 1_000, totalTimeout: 60 });
  const rejected = assert.rejects(peer.worker, /timed out/);
  let count = 0;
  const timer = setInterval(() => { if (!peer.input.destroyed) { peer.input.write(Buffer.from("D")); count++; } }, 15);
  try { await rejected; } finally { clearInterval(timer); }
  assert.ok(count > 0 && count < 12);
  assert.equal(peer.output.destroyed, true);
});

test("VSS worker terminates a blocked request write within its deadline", async () => {
  const input = new PassThrough();
  const output = new Writable({ write() {} });
  const worker = runVssWorker(input, output, { readTimeoutMs: 50 });
  input.end(frame(0x80));
  await assert.rejects(worker, /timed out/);
  assert.equal(input.destroyed, true);
  assert.equal(output.destroyed, true);
});

test("VSS worker rejects an incorrect snapshot hash and never sends a completion claim", async () => {
  const peer = setup();
  const rejected = assert.rejects(peer.worker, /integrity mismatch/);
  await serve(peer, { corrupt: true });
  await rejected;
  await assert.rejects(peer.iterator.next(), { code: "ERR_STREAM_PREMATURE_CLOSE" });
});

test("VSS worker rejects data after file EOF and after final acknowledgement", async context => {
  for (const option of ["extraAfterEof", "extraAfterAck"]) await context.test(option, async () => {
    const peer = setup();
    const rejected = assert.rejects(peer.worker, /protocol state|after acknowledgement/);
    await serve(peer, { [option]: true });
    await rejected;
  });
});

test("VSS worker handles asynchronous channel errors without unhandled errors", async () => {
  const peer = setup();
  const rejected = assert.rejects(peer.worker, /synthetic channel error/);
  peer.input.destroy(new Error("synthetic channel error"));
  await rejected;
  assert.equal(peer.output.destroyed, true);
});

test("VSS worker CLI requires an exact, explicit scenario and keeps stdout binary", () => {
  const entry = fileURLToPath(new URL("../../.dev/build/cli.cjs", import.meta.url));
  for (const arguments_ of [[], ["--scenario", "unknown"], ["--scenario", "normal", "--extra"], ["--scenario", "normal", "--scenario", "cancel"]]) {
    const result = spawnSync(process.execPath, [entry, "probe", "vss-worker", ...arguments_], { encoding: "utf8", timeout: 2_000 });
    assert.equal(result.status, 2, result.stderr);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /Usage: delta probe vss-worker/);
  }
});
