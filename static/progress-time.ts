/** Only a known work total can support an estimate; an operation's age cannot. */
export interface TimedOperation { id: string; status: string; paused?: boolean; progress?: unknown }
type Measurement = { phase: string; unit: "bytes" | "files"; completed: number; total: number };
type Sample = { at: number; completed: number };
type Timing = Measurement & { observedAt: number; samples: Sample[] };
const WARMUP_MS = 1000, WINDOW_MS = 30000, MAX_SAMPLES = 32, MAX_OPERATIONS = 128;
const counter = (value: unknown): number | undefined => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
function measure(operation: TimedOperation): Measurement | undefined {
  if (operation.status !== "running" || operation.paused || !operation.progress || typeof operation.progress !== "object") return;
  const progress = operation.progress as Record<string, unknown>, phase = typeof progress.phase === "string" ? progress.phase : "";
  for (const unit of ["bytes", "files"] as const) {
    const completed = counter(progress[unit === "bytes" ? "completedBytes" : "completedFiles"]) ?? counter(progress[unit]), total = counter(progress[unit === "bytes" ? "totalBytes" : "totalFiles"]);
    if (completed !== undefined && total !== undefined && total > 0 && completed <= total) return { phase, unit, completed, total };
  }
}
function sameWork(left: Measurement, right: Measurement): boolean { return left.phase === right.phase && left.unit === right.unit && left.total === right.total; }

/** Monotonic milliseconds are supplied by the caller, so wall-clock changes never alter a rate. */
export class ProgressTiming {
  private readonly operations = new Map<string, Timing>();

  observe(operation: TimedOperation, now: number): void {
    const work = measure(operation);
    if (!work || !Number.isFinite(now) || now < 0) { this.operations.delete(operation.id); return; }
    let timing = this.operations.get(operation.id);
    if (!timing || !sameWork(timing, work) || work.completed < timing.completed || now < timing.observedAt) timing = { ...work, observedAt: now, samples: [{ at: now, completed: work.completed }] };
    else {
      timing.completed = work.completed; timing.observedAt = now;
      // Bucket frequent file events without shortening the useful rate history.
      if (now - timing.samples.at(-1)!.at >= WARMUP_MS) timing.samples.push({ at: now, completed: work.completed });
      while (timing.samples.length > 1 && timing.samples[1]!.at <= now - WINDOW_MS) timing.samples.shift();
      while (timing.samples.length > MAX_SAMPLES) timing.samples.shift();
    }
    // Touch insertion order so inactive operations cannot evict recently updated ones.
    this.operations.delete(operation.id); this.operations.set(operation.id, timing);
    while (this.operations.size > MAX_OPERATIONS) this.operations.delete(this.operations.keys().next().value!);
  }

  remaining(operation: TimedOperation, now: number): number | undefined {
    const work = measure(operation), timing = this.operations.get(operation.id);
    if (!work || !timing || !sameWork(timing, work) || work.completed !== timing.completed || !Number.isFinite(now) || now < timing.observedAt) return;
    if (work.completed === work.total) return 0;
    const first = timing.samples[0]!, elapsed = now - first.at, advanced = work.completed - first.completed;
    if (elapsed < WARMUP_MS || advanced <= 0) return;
    // Count only measured work. With no new progress the denominator keeps growing,
    // so an idle operation's estimate grows rather than counting down fictitious work.
    const seconds = (work.total - work.completed) * (elapsed / 1000) / advanced;
    return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
  }

  forget(activeIds: Iterable<string>): void {
    const active = new Set(activeIds);
    for (const id of this.operations.keys()) if (!active.has(id)) this.operations.delete(id);
  }
}

/** Round up so a positive remaining duration never appears as completed work. */
export function formatDuration(seconds: number): string {
  const whole = Number.isFinite(seconds) ? Math.max(0, Math.ceil(seconds)) : 0, hours = Math.floor(whole / 3600), minutes = Math.floor(whole / 60) % 60, remainder = whole % 60;
  return `${hours ? `${String(hours).padStart(2, "0")}:` : ""}${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}
