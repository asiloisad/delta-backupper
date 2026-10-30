export interface EngineExecutionControl {
  readonly paused: boolean;
  waitIfPaused(): Promise<void>;
  onChange(listener: (paused: boolean) => void): () => void;
}

/** Cooperative waits keep the event loop, snapshot leases and cancellation live. */
export class PauseController implements EngineExecutionControl {
  private value = false;
  private closed = false;
  private waiting = new Set<{ resolve(): void; reject(error: unknown): void }>();
  private listeners = new Set<(paused: boolean) => void>();
  private abort = () => { for (const waiter of this.waiting) waiter.reject(this.signal.reason); this.waiting.clear(); };
  constructor(private readonly signal: AbortSignal) { signal.addEventListener("abort", this.abort, { once: true }); }
  get paused() { return this.value; }
  setPaused(paused: boolean): void {
    if (this.closed) throw new Error("Operation is no longer active");
    this.signal.throwIfAborted();
    if (this.value === paused) return;
    this.value = paused;
    if (!paused) { for (const waiter of this.waiting) waiter.resolve(); this.waiting.clear(); }
    for (const listener of this.listeners) listener(paused);
  }
  async waitIfPaused(): Promise<void> {
    this.signal.throwIfAborted();
    while (this.value && !this.closed) {
      await new Promise<void>((resolve, reject) => this.waiting.add({ resolve, reject }));
      this.signal.throwIfAborted();
    }
  }
  onChange(listener: (paused: boolean) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  dispose(): void {
    if (this.closed) return;
    this.closed = true; this.value = false; this.signal.removeEventListener("abort", this.abort);
    for (const waiter of this.waiting) waiter.resolve(); this.waiting.clear(); this.listeners.clear();
  }
}
