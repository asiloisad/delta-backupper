interface PowerEvents {
  on(event: "suspend" | "resume", listener: () => void): unknown;
  off(event: "suspend" | "resume", listener: () => void): unknown;
}
/** Coalesce polling, settings changes and wake events without overlapping scheduler checks. */
export class SchedulerWakeups {
  suspended = false;
  private closed = false;
  private requested = false;
  private running: Promise<void> | undefined;
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly suspend = () => { this.suspended = true; };
  private readonly resume = () => { this.suspended = false; void this.check(); };
  constructor(private readonly ports: { power: PowerEvents; check(): Promise<void>; report(error: unknown): void; intervalMs?: number }) {
    ports.power.on("suspend", this.suspend); ports.power.on("resume", this.resume);
    this.timer = setInterval(() => { void this.check(); }, ports.intervalMs ?? 15_000);
    this.timer.unref();
  }
  check(): Promise<void> {
    if (this.closed || this.suspended) return Promise.resolve();
    this.requested = true;
    this.running ??= (async () => {
      // Yield so the running promise is assigned before a synchronous port failure is handled.
      await Promise.resolve();
      while (this.requested && !this.closed && !this.suspended) {
        this.requested = false;
        try { await this.ports.check(); } catch (error) { this.ports.report(error); }
      }
    })().finally(() => { this.running = undefined; });
    return this.running;
  }
  close(): void {
    this.closed = true; this.requested = false; clearInterval(this.timer);
    this.ports.power.off("suspend", this.suspend); this.ports.power.off("resume", this.resume);
  }
}
