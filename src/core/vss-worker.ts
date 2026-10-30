import { createHash } from "node:crypto";
import type { Readable, Writable } from "node:stream";

// Qualification protocol only: the broker exposes an opaque, single fixture ID,
// never arbitrary paths or a privileged filesystem handle to the worker.
export const VSS_FRAME_LIMIT = 65_536;
export const VSS_FIXTURE_LINE = "Delta snapshot original — zażółć Δ 日本語\n";
export const VSS_FIXTURE_REPETITIONS = 65_536;
const fixtureLine = Buffer.from(VSS_FIXTURE_LINE, "utf8");
export const VSS_FIXTURE_BYTES = fixtureLine.length * VSS_FIXTURE_REPETITIONS;
const expectedHash = createHash("sha256");
for (let index = 0; index < VSS_FIXTURE_REPETITIONS; index++) expectedHash.update(fixtureLine);
export const VSS_FIXTURE_SHA256 = expectedHash.digest("hex");

export type VssWorkerScenario = "normal" | "cancel" | "disconnect";
export type VssWorkerResult = {
  scenario: VssWorkerScenario;
  bytes: number;
  sha256: string;
  deniedFlags: number;
  acknowledged: boolean;
  exitCode: 0 | 130;
};

type Frame = { opcode: number; payload: Buffer };
type WorkerOptions = { scenario?: VssWorkerScenario; readTimeoutMs?: number; totalTimeoutMs?: number };
const OPCODE = { read: 1, finish: 2, cancel: 3, hello: 0x80, data: 0x81, eof: 0x82, ack: 0x83, denied: 0xff };
const MAGIC = Buffer.from("DV01", "ascii");

class WorkerChannel {
  private failure: Error | undefined;
  private readonly deadline: number;
  private readonly operationTimeout: number;
  private readonly input: Readable;
  private readonly output: Writable;

  constructor(input: Readable, output: Writable, options: WorkerOptions) {
    this.input = input;
    this.output = output;
    this.operationTimeout = options.readTimeoutMs ?? 30_000;
    const totalTimeout = options.totalTimeoutMs ?? 120_000;
    if (![this.operationTimeout, totalTimeout].every(value => Number.isSafeInteger(value) && value > 0 && value <= 600_000)) {
      throw new Error("Invalid VSS worker timeout");
    }
    this.deadline = Date.now() + totalTimeout;
    // The runner owns both streams until close, including asynchronous errors
    // arriving during destroy(). Keep these observers until the streams are GC'd.
    const capture = (error: Error) => { this.failure ??= error; };
    input.on("error", capture);
    output.on("error", capture);
  }

  private remaining(operationDeadline: number) {
    const remaining = Math.min(this.deadline, operationDeadline) - Date.now();
    if (remaining <= 0) throw new Error("VSS worker channel timed out");
    if (this.failure) throw this.failure;
    return remaining;
  }

  private async waitReadable(deadline: number): Promise<void> {
    const timeout = this.remaining(deadline);
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.input.off("readable", ready);
        this.input.off("end", ready);
        this.input.off("close", ready);
        this.input.off("error", failed);
        this.output.off("error", failed);
      };
      const ready = () => { cleanup(); resolve(); };
      const failed = (error: Error) => { cleanup(); reject(error); };
      const timer = setTimeout(() => failed(new Error("VSS worker channel timed out")), timeout);
      this.input.once("readable", ready);
      this.input.once("end", ready);
      this.input.once("close", ready);
      this.input.once("error", failed);
      this.output.once("error", failed);
      if (this.input.readableLength > 0 || this.input.readableEnded || this.input.destroyed) ready();
    });
  }

  private async exact(length: number, deadline: number, allowEnd = false): Promise<Buffer | null> {
    const buffer = Buffer.allocUnsafe(length);
    let offset = 0;
    while (offset < length) {
      this.remaining(deadline);
      // Consume available fragments immediately: waiting for read(n) while a
      // shorter fragment is buffered can prevent a backpressured peer advancing.
      const lengthToRead = Math.min(length - offset, this.input.readableLength || length - offset);
      const chunk: unknown = this.input.read(lengthToRead);
      if (chunk !== null) {
        if (!Buffer.isBuffer(chunk) || chunk.length === 0 || chunk.length > length - offset) {
          throw new Error("VSS worker requires bounded binary input");
        }
        chunk.copy(buffer, offset);
        offset += chunk.length;
        continue;
      }
      if (this.input.readableEnded) {
        if (allowEnd && offset === 0) return null;
        throw new Error("VSS worker channel ended before the complete frame");
      }
      if (this.input.destroyed) throw new Error("VSS worker channel closed unexpectedly");
      await this.waitReadable(deadline);
    }
    return buffer;
  }

  async frame(): Promise<Frame> {
    const deadline = Date.now() + this.operationTimeout;
    const header = (await this.exact(12, deadline))!;
    if (!header.subarray(0, 4).equals(MAGIC) || header[5] !== 0 || header.readUInt16LE(6) !== 0) {
      throw new Error("Invalid VSS worker frame header");
    }
    if (![OPCODE.hello, OPCODE.data, OPCODE.eof, OPCODE.ack, OPCODE.denied].includes(header[4]!)) {
      throw new Error("Invalid VSS worker frame direction or opcode");
    }
    const length = header.readUInt32LE(8);
    if (length > VSS_FRAME_LIMIT) throw new Error("Oversized VSS worker frame");
    if (header[4] !== OPCODE.data && length !== 0) throw new Error("Unexpected VSS worker control payload");
    return { opcode: header[4]!, payload: length === 0 ? Buffer.alloc(0) : (await this.exact(length, deadline))! };
  }

  async expect(opcode: number) {
    const frame = await this.frame();
    if (frame.opcode !== opcode || frame.payload.length !== 0) throw new Error("Unexpected VSS worker protocol state");
  }

  async send(opcode: number, payload: Buffer = Buffer.alloc(0)) {
    if (payload.length > VSS_FRAME_LIMIT) throw new Error("Oversized VSS worker request");
    const buffer = Buffer.allocUnsafe(12 + payload.length);
    buffer.write("DV01", 0, "ascii");
    buffer[4] = opcode;
    buffer[5] = 0;
    buffer.writeUInt16LE(0, 6);
    buffer.writeUInt32LE(payload.length, 8);
    payload.copy(buffer, 12);
    const timeout = this.remaining(Date.now() + this.operationTimeout);
    if (this.output.destroyed || this.output.writableEnded) throw new Error("VSS worker output is closed");
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.output.off("error", finish);
        this.output.off("close", closed);
        error ? reject(error) : resolve();
      };
      const closed = () => finish(new Error("VSS worker output closed during write"));
      const timer = setTimeout(() => finish(new Error("VSS worker channel timed out")), timeout);
      this.output.once("error", finish);
      this.output.once("close", closed);
      try { this.output.write(buffer, finish); } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
    });
  }

  async endAfterAck() {
    if (await this.exact(1, Date.now() + this.operationTimeout, true)) throw new Error("Unexpected VSS worker data after acknowledgement");
  }

  async closeOutput() {
    if (this.output.destroyed) throw new Error("VSS worker output closed before completion");
    const timeout = this.remaining(Date.now() + this.operationTimeout);
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error | null) => {
        clearTimeout(timer);
        this.output.off("error", finish);
        error ? reject(error) : resolve();
      };
      const timer = setTimeout(() => finish(new Error("VSS worker output timed out closing")), timeout);
      this.output.once("error", finish);
      this.output.end(finish);
    });
  }

  destroy() {
    this.input.destroy();
    this.output.destroy();
  }
}

/** Owns the dedicated binary channels; stdout must contain no diagnostics. */
export async function runVssWorker(input: Readable, output: Writable, options: WorkerOptions = {}): Promise<VssWorkerResult> {
  const scenario = options.scenario ?? "normal";
  if (!["normal", "cancel", "disconnect"].includes(scenario)) throw new Error("Invalid VSS worker scenario");
  const channel = new WorkerChannel(input, output, options);
  try {
    await channel.expect(OPCODE.hello);
    let deniedFlags = 0;
    for (const [index, source] of ["C:\\Windows\\System32\\config\\SAM", "..\\fixture", "fixture:secret"].entries()) {
      await channel.send(OPCODE.read, Buffer.from(source, "utf8"));
      await channel.expect(OPCODE.denied);
      deniedFlags |= 1 << index;
    }
    await channel.send(0x7f);
    await channel.expect(OPCODE.denied);
    deniedFlags |= 8;
    await channel.send(OPCODE.read, Buffer.from("fixture", "utf8"));
    const hash = createHash("sha256");
    let bytes = 0;
    while (true) {
      const frame = await channel.frame();
      if (frame.opcode === OPCODE.eof) break;
      if (frame.opcode !== OPCODE.data || frame.payload.length === 0) throw new Error("Unexpected VSS worker file stream frame");
      bytes += frame.payload.length;
      if (bytes > VSS_FIXTURE_BYTES) throw new Error("VSS worker fixture exceeds its declared size");
      hash.update(frame.payload);
    }
    const sha256 = hash.digest("hex");
    if (bytes !== VSS_FIXTURE_BYTES || sha256 !== VSS_FIXTURE_SHA256) throw new Error("VSS worker snapshot fixture integrity mismatch");
    if (scenario !== "disconnect") {
      const result = Buffer.alloc(76);
      result.writeBigUInt64LE(BigInt(bytes), 0);
      result.writeUInt32LE(deniedFlags, 8);
      result.write(sha256, 12, "ascii");
      await channel.send(scenario === "cancel" ? OPCODE.cancel : OPCODE.finish, result);
      await channel.expect(OPCODE.ack);
      await channel.endAfterAck();
    }
    await channel.closeOutput();
    return { scenario, bytes, sha256, deniedFlags, acknowledged: scenario !== "disconnect", exitCode: scenario === "cancel" ? 130 : 0 };
  } finally {
    channel.destroy();
  }
}
