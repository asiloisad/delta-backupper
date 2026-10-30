import type { ScheduleConfig, TaskConfig } from "../domain/models.js";

type Schedule = ScheduleConfig;
const dayNumbers: Record<string, number> = { Sun: 7, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function wallTime(schedule: Schedule, at: number) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: schedule.timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23" }).formatToParts(at);
  const fields = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return { key: `${fields.year}-${fields.month}-${fields.day} ${fields.hour}:${fields.minute}`, time: `${fields.hour}:${fields.minute}`, weekday: dayNumbers[fields.weekday!]! };
}

/** DST gaps are skipped; a repeated wall-clock occurrence runs only once. */
export function nextScheduledTime(schedule: Schedule, after: number, options: { lastWallKey?: string; intervalAnchor?: number } = {}): number | null {
  if (schedule.paused || schedule.kind === "manual") return null;
  if (schedule.kind === "interval") {
    const period = schedule.intervalMinutes * 60_000;
    if (!Number.isSafeInteger(period) || period <= 0) throw new Error("Invalid schedule interval");
    const anchor = options.intervalAnchor ?? after;
    return anchor + Math.max(1, Math.floor((after - anchor) / period) + 1) * period;
  }
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: schedule.timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23" });
  for (let at = Math.floor(after / 60_000) * 60_000 + 60_000, end = at + 9 * 86_400_000; at < end; at += 60_000) {
    const values = Object.fromEntries(formatter.formatToParts(at).map(part => [part.type, part.value]));
    const key = `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}`;
    if (`${values.hour}:${values.minute}` === schedule.time && key !== options.lastWallKey && (schedule.kind !== "weekly" || schedule.weekdays.includes(dayNumbers[values.weekday!]!))) return at;
  }
  return null;
}

export interface ScheduleState { nextAt: number | null; lastWallKey?: string; lastAt?: number; pending: boolean; available: boolean; fingerprint: string }
export interface TaskScheduleState { schedules: Record<string, ScheduleState> }

/** Each task owns independent deadlines identified by their position in the task. One tick requests at most one backup. */
export function advanceSchedule(task: TaskConfig, previous: TaskScheduleState | undefined, now: number, available: boolean): { state: TaskScheduleState; due: boolean } {
  if (previous && (!previous.schedules || typeof previous.schedules !== "object" || Array.isArray(previous.schedules))) throw new Error("Invalid scheduler state: schedules are required");
  const blocked = Object.values(previous?.schedules ?? {}).some(state => state.pending);
  const schedules: Record<string, ScheduleState> = {};
  let due = false;
  for (const [index, schedule] of task.schedules.entries()) {
    const key = String(index);
    const remembered = Object.hasOwn(previous?.schedules ?? {}, key) ? previous!.schedules[key] : undefined;
    const next = advanceRule(task.schedulesPaused, schedule, remembered, now, available, blocked);
    schedules[key] = next.state;
    due ||= next.due;
  }
  return { state: { schedules }, due };
}

function advanceRule(schedulesPaused: boolean, schedule: Schedule, previous: ScheduleState | undefined, now: number, available: boolean, blocked: boolean): { state: ScheduleState; due: boolean } {
  if (previous && (typeof previous.fingerprint !== "string" || !previous.fingerprint)) throw new Error("Invalid scheduler state: fingerprint is required");
  const fingerprint = JSON.stringify({ schedulesPaused, schedule });
  if (schedulesPaused || schedule.paused) return { state: { ...previous, nextAt: null, pending: previous?.pending ?? false, available, fingerprint }, due: false };
  const changed = previous?.fingerprint !== fingerprint;
  let state: ScheduleState = previous && !changed ? { ...previous, fingerprint } : { ...previous, nextAt: nextScheduledTime(schedule, now, { lastWallKey: previous?.lastWallKey }), pending: previous?.pending ?? false, available, fingerprint };
  if (blocked) return { state, due: false };
  if (state.nextAt === null && schedule.kind !== "manual") state.nextAt = nextScheduledTime(schedule, now, { lastWallKey: state.lastWallKey });
  const reconnected = !state.available && available && schedule.onDestinationAvailable;
  state.available = available;
  if (state.pending) return { state, due: false };
  const overdue = state.nextAt !== null && state.nextAt <= now;
  const due = available && (reconnected || overdue && (schedule.missed === "run-once" || now - state.nextAt! < 60_000));
  if (due) {
    const occurrence = overdue ? state.nextAt! : now;
    state.lastAt = occurrence;
    state.lastWallKey = wallTime(schedule, occurrence).key;
    state.pending = true;
  }
  if (overdue && (available || schedule.missed === "skip") || reconnected) state.nextAt = nextScheduledTime(schedule, now, { lastWallKey: state.lastWallKey, intervalAnchor: state.lastAt });
  return { state, due };
}

/** Saved pending operations are recovered separately by task locks and checkpoints, never replayed blindly. */
export function parseSchedulerState(value: unknown): Record<string, TaskScheduleState> {
  const record = (item: unknown): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item) && Object.getPrototypeOf(item) === Object.prototype;
  if (!record(value) || value.schemaVersion !== 2) throw Object.assign(new Error("Unsupported scheduler state version; scheduler paused"), { code: "SCHEDULER_VERSION" });
  if (Object.keys(value).some(key => !["schemaVersion", "tasks"].includes(key)) || !record(value.tasks)) throw new Error("Invalid scheduler state");
  const tasks: Record<string, TaskScheduleState> = {};
  for (const [taskId, task] of Object.entries(value.tasks)) {
    if (!taskId || taskId.includes('\0') || taskId.length > 32768 || !record(task) || Object.keys(task).some(key => key !== "schedules") || !record(task.schedules)) throw new Error("Invalid scheduler task state");
    const schedules: Record<string, ScheduleState> = {};
    for (const [scheduleId, state] of Object.entries(task.schedules)) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(scheduleId) || !record(state) || Object.keys(state).some(key => !["nextAt", "lastWallKey", "lastAt", "pending", "available", "fingerprint"].includes(key)) || !(state.nextAt === null || typeof state.nextAt === "number" && Number.isFinite(state.nextAt)) || typeof state.pending !== "boolean" || typeof state.available !== "boolean" || typeof state.fingerprint !== "string" || !state.fingerprint || state.lastAt !== undefined && (typeof state.lastAt !== "number" || !Number.isFinite(state.lastAt)) || state.lastWallKey !== undefined && (typeof state.lastWallKey !== "string" || state.lastWallKey.length > 64)) throw new Error("Invalid scheduler rule state");
      schedules[scheduleId] = { ...state as unknown as ScheduleState, pending: false };
    }
    tasks[taskId] = { schedules };
  }
  return tasks;
}
