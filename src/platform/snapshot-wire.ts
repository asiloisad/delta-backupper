import type { Socket } from "node:net";

export const SNAPSHOT_FRAME_LIMIT = 65536;
export type SnapshotMessage = Record<string, unknown>;
export class SnapshotWire {
  private buffered = Buffer.alloc(0);
  private messages: SnapshotMessage[] = [];
  private waiter?: { resolve(value: SnapshotMessage): void; reject(error: Error): void; timer: NodeJS.Timeout };
  private failure?: Error;
  private writes = new Set<(error: Error) => void>();
  constructor(readonly socket: Socket) {
    socket.on("data", (chunk: Buffer) => {
      if (this.failure) return;
      this.buffered = Buffer.concat([this.buffered, chunk]);
      for (;;) {
        const newline = this.buffered.indexOf(10);
        if (newline < 0) { if (this.buffered.length > SNAPSHOT_FRAME_LIMIT) this.fail(new Error("Oversized snapshot protocol frame")); return; }
        if (newline >= SNAPSHOT_FRAME_LIMIT) { this.fail(new Error("Oversized snapshot protocol frame")); return; }
        const bytes = this.buffered.subarray(0, newline); this.buffered = this.buffered.subarray(newline + 1);
        try {
          const text = bytes.toString("utf8"); if (!Buffer.from(text).equals(bytes)) throw new Error("Invalid snapshot protocol UTF-8");
          const value: unknown = JSON.parse(text);
          if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid snapshot protocol document");
          if (this.waiter) { const waiter = this.waiter; this.waiter = undefined; clearTimeout(waiter.timer); waiter.resolve(value as SnapshotMessage); }
          else { if (this.messages.length >= 8) throw new Error("Snapshot protocol queue overflow"); this.messages.push(value as SnapshotMessage); }
        } catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); return; }
      }
    });
    socket.on("error", error => this.fail(error));
    socket.on("end", () => this.fail(new Error("Snapshot helper disconnected")));
    socket.on("close", () => this.fail(new Error("Snapshot helper closed its connection")));
  }
  private fail(error: Error) { this.failure ??= error; this.messages = []; this.buffered = Buffer.alloc(0); if (this.waiter) { const waiter = this.waiter; this.waiter = undefined; clearTimeout(waiter.timer); waiter.reject(this.failure); } for (const reject of [...this.writes]) reject(this.failure); this.socket.destroy(); }
  read(timeoutMs = 120_000): Promise<SnapshotMessage> {
    if (this.failure) return Promise.reject(this.failure);
    const value = this.messages.shift(); if (value) return Promise.resolve(value);
    if (this.waiter) return Promise.reject(new Error("Concurrent snapshot protocol reads are not permitted"));
    return new Promise((resolve, reject) => { const timer = setTimeout(() => this.fail(new Error("Snapshot helper response timed out")), timeoutMs); this.waiter = { resolve, reject, timer }; });
  }
  async send(value: SnapshotMessage): Promise<void> {
    if (this.failure) throw this.failure;
    const bytes = Buffer.from(`${JSON.stringify(value)}\n`); if (bytes.length > SNAPSHOT_FRAME_LIMIT || this.socket.destroyed) throw new Error("Snapshot protocol request exceeds its limit or the connection is closed");
    await new Promise<void>((resolve, reject) => {
      let complete = false;
      const finish = (error?: Error | null) => { if (complete) return; complete = true; clearTimeout(timer); this.writes.delete(failed); error ? reject(error) : resolve(); };
      const failed = (error: Error) => finish(error);
      const timer = setTimeout(() => this.fail(new Error("Snapshot helper write timed out")), 15_000);
      this.writes.add(failed);
      try { this.socket.write(bytes, error => { if (error) this.fail(error); else finish(); }); } catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); }
    });
  }
  close() { this.socket.end(); this.fail(new Error("Snapshot connection is closed")); }
}

export function snapshotFailure(message: string, code: string, cleanupVerified: boolean): Error & { code: string; cleanupVerified: boolean } { return Object.assign(new Error(message), { code, cleanupVerified }); }
