import assert from "node:assert/strict";
import { test, after } from "node:test";
import { build } from "esbuild";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const workspace = await mkdtemp(path.join(tmpdir(), "delta-schedule-"));
after(() => rm(workspace, { recursive: true, force: true }));
const bundle = path.join(workspace, "scheduler.cjs");
await build({ entryPoints: ["src/core/scheduler.ts"], outfile: bundle, bundle: true, platform: "node", target: "node24", format: "cjs", logLevel: "silent" });
const { nextScheduledTime, wallTime, advanceSchedule, parseSchedulerState } = createRequire(import.meta.url)(bundle);
const at = text => Date.parse(text);
const schedule = (overrides = {}) => ({ name: "Daily", paused: false, kind: "daily", intervalMinutes: 60, time: "02:30", weekdays: [1, 2, 3, 4, 5, 6, 7], timeZone: "Europe/Warsaw", missed: "run-once", onDestinationAvailable: false, ...overrides });
const task = (overrides = {}) => ({ schedulesPaused: false, schedules: [schedule(overrides)] });
const saved = (definition, now, ruleFields = {}) => {
  const state = advanceSchedule(definition, undefined, now, true).state;
  for (const [id, fields] of Object.entries(ruleFields)) Object.assign(state.schedules[id], fields);
  return state;
};
const completed = state => ({ schedules: Object.fromEntries(Object.entries(state.schedules).map(([id, rule]) => [id, { ...rule, pending: false }])) });
const rule = (state, id = "0") => state.schedules[id];

test("daily schedule skips the spring DST gap and repeated fall occurrence runs once", () => {
  const daily = schedule();
  assert.equal(new Date(nextScheduledTime(daily, at("2026-03-28T12:00:00Z"))).toISOString(), "2026-03-30T00:30:00.000Z");
  const first = nextScheduledTime(daily, at("2026-10-24T12:00:00Z"));
  assert.equal(new Date(first).toISOString(), "2026-10-25T00:30:00.000Z");
  assert.equal(new Date(nextScheduledTime(daily, first, { lastWallKey: wallTime(daily, first).key })).toISOString(), "2026-10-26T01:30:00.000Z");
});

test("weekly weekdays use ISO Monday 1 through Sunday 7", () => {
  assert.equal(new Date(nextScheduledTime(schedule({ kind: "weekly", weekdays: [7], time: "12:00", timeZone: "UTC" }), at("2026-10-24T12:00:00Z"))).toISOString(), "2026-10-25T12:00:00.000Z");
  assert.equal(new Date(nextScheduledTime(schedule({ kind: "weekly", weekdays: [1], time: "12:00", timeZone: "UTC" }), at("2026-10-24T12:00:00Z"))).toISOString(), "2026-10-26T12:00:00.000Z");
});

test("interval schedule preserves its anchor and manual/paused schedules stay idle", () => {
  const anchor = at("2026-10-29T10:00:00Z"), interval = schedule({ kind: "interval", intervalMinutes: 15 });
  assert.equal(nextScheduledTime(interval, anchor + 37 * 60000, { intervalAnchor: anchor }), anchor + 45 * 60000);
  assert.equal(nextScheduledTime(schedule({ kind: "manual" }), anchor), null);
  assert.equal(nextScheduledTime(schedule({ paused: true }), anchor), null);
});

test("missed run-once creates one pending operation, skip does not replay stale history", () => {
  const now = at("2026-10-29T20:00:00Z");
  const definition = task(), previous = saved(definition, now - 4 * 86400000, { "0": { nextAt: now - 3 * 86400000, pending: false, available: true } });
  const result = advanceSchedule(definition, previous, now, true);
  assert.equal(result.due, true); assert.equal(rule(result.state).pending, true); assert(rule(result.state).nextAt > now);
  assert.equal(advanceSchedule(definition, result.state, now + 10000, true).due, false);
  const skipTask = task({ missed: "skip" }), skipPrevious = saved(skipTask, now - 4 * 86400000, { "0": { nextAt: now - 3 * 86400000, pending: false, available: true } });
  const skip = advanceSchedule(skipTask, skipPrevious, now, true);
  assert.equal(skip.due, false); assert(rule(skip.state).nextAt > now);
});

test("an interval catches up once and keeps its occurrence anchor", () => {
  const now = at("2026-10-29T10:00:00Z"), definition = task({ kind: "interval", intervalMinutes: 15 });
  const initial = advanceSchedule(definition, undefined, now, true);
  assert.equal(rule(initial.state).nextAt, now + 15 * 60000);
  const missed = advanceSchedule(definition, initial.state, now + 52 * 60000, true);
  assert.equal(missed.due, true); assert.equal(rule(missed.state).lastAt, now + 15 * 60000);
  assert.equal(rule(missed.state).nextAt, now + 60 * 60000);
  assert.equal(advanceSchedule(definition, completed(missed.state), now + 59 * 60000, true).due, false);
  assert.equal(advanceSchedule(definition, completed(missed.state), now + 60 * 60000, true).due, true);
});

test("unavailable target retains one catch-up occurrence until it returns", () => {
  const now = at("2026-10-29T20:00:00Z"), definition = task();
  const previous = saved(definition, now - 7200000, { "0": { nextAt: now - 3600000, pending: false, available: true } });
  const offline = advanceSchedule(definition, previous, now, false);
  assert.equal(offline.due, false);
  const online = advanceSchedule(definition, offline.state, now + 600000, true);
  assert.equal(online.due, true); assert.equal(rule(online.state).pending, true);
  assert.equal(advanceSchedule(definition, online.state, now + 1200000, true).due, false);
});

test("reconnect option schedules current data once; paused task schedules never run automatically", () => {
  const now = at("2026-10-29T20:00:00Z"), definition = task({ onDestinationAvailable: true });
  const previous = saved(definition, now, { "0": { nextAt: now + 86400000, pending: false, available: false } });
  const connected = advanceSchedule(definition, previous, now, true);
  assert.equal(connected.due, true);
  assert.equal(advanceSchedule(definition, connected.state, now + 1000, true).due, false);
  assert.equal(advanceSchedule({ ...definition, schedulesPaused: true }, previous, now, true).due, false);
});

test("resuming previously paused task schedules or a rule creates a future occurrence", () => {
  const now = at("2026-10-29T09:00:00Z"), enabled = task({ time: "20:00", timeZone: "UTC" });
  for (const disabled of [{ ...enabled, schedulesPaused: true }, task({ paused: true, time: "20:00", timeZone: "UTC" }), task({ kind: "manual", time: "20:00", timeZone: "UTC" })]) {
    const dormant = advanceSchedule(disabled, undefined, now, true);
    assert.equal(dormant.due, false); assert.equal(rule(dormant.state).nextAt, null);
    const activated = advanceSchedule(enabled, dormant.state, now + 60000, true);
    assert.equal(activated.due, false);
    assert.equal(rule(activated.state).nextAt, at("2026-10-29T20:00:00Z"));
    const due = advanceSchedule(enabled, activated.state, rule(activated.state).nextAt, true);
    assert.equal(due.due, true); assert.equal(rule(due.state).pending, true);
    assert.equal(advanceSchedule(enabled, due.state, rule(due.state).nextAt, true).due, false);
  }
});

test("saved rules without a fingerprint are rejected without being adopted", () => {
  const now = at("2026-10-29T20:00:00Z"), previous = { schedules: { "0": { nextAt: now - 3600000, pending: false, available: true } } };
  const unchanged = structuredClone(previous);
  assert.throws(() => advanceSchedule(task(), previous, now, true), /fingerprint is required/);
  assert.deepEqual(previous, unchanged);
  assert.equal(typeof rule(advanceSchedule(task(), undefined, now, true).state).fingerprint, "string");
});

test("editing an effective daily time recomputes its future occurrence without mutating saved state", () => {
  const now = at("2026-10-29T09:00:00Z"), original = task({ time: "20:00", timeZone: "UTC" }), edited = task({ time: "10:00", timeZone: "UTC" });
  const initial = advanceSchedule(original, undefined, now, true), initialCopy = structuredClone(initial.state);
  assert.equal(rule(initial.state).nextAt, at("2026-10-29T20:00:00Z"));
  const changed = advanceSchedule(edited, initial.state, now + 60000, true);
  assert.equal(changed.due, false); assert.equal(rule(changed.state).nextAt, at("2026-10-29T10:00:00Z"));
  const occurrence = advanceSchedule(edited, changed.state, at("2026-10-29T10:00:00Z"), true);
  assert.equal(occurrence.due, true); assert.equal(rule(occurrence.state).nextAt, at("2026-10-30T10:00:00Z"));
  assert.equal(advanceSchedule(edited, completed(occurrence.state), at("2026-10-29T20:00:00Z"), true).due, false);
  assert.deepEqual(structuredClone(initial.state), initialCopy);
});

test("editing an interval restarts its anchor at the edit time", () => {
  const now = at("2026-10-29T10:00:00Z"), original = task({ kind: "interval", intervalMinutes: 15 });
  const initial = advanceSchedule(original, undefined, now, true);
  const editTime = now + 5 * 60000, edited = task({ kind: "interval", intervalMinutes: 30 });
  const changed = advanceSchedule(edited, initial.state, editTime, true);
  assert.equal(changed.due, false); assert.equal(rule(changed.state).nextAt, editTime + 30 * 60000);
});

test("simultaneously due schedules coalesce into one task operation", () => {
  const now = at("2026-10-29T12:00:00Z");
  const definition = { schedulesPaused: false, schedules: [schedule({ time: "12:00", timeZone: "UTC" }), schedule({ kind: "interval", intervalMinutes: 60 })] };
  const previous = saved(definition, now - 3600000, { "0": { nextAt: now }, "1": { nextAt: now } }), previousCopy = structuredClone(previous);
  const result = advanceSchedule(definition, previous, now, true);
  assert.equal(result.due, true); assert.equal(rule(result.state, "0").pending, true); assert.equal(rule(result.state, "1").pending, true);
  assert.equal(rule(result.state, "0").lastAt, now); assert.equal(rule(result.state, "1").lastAt, now);
  assert.equal(advanceSchedule(definition, result.state, now + 3600000, true).due, false);
  assert.deepEqual(structuredClone(previous), previousCopy);
});

test("one pending schedule prevents another schedule from issuing the same task", () => {
  const now = at("2026-10-29T12:00:00Z");
  const definition = { schedulesPaused: false, schedules: [schedule({ kind: "interval", intervalMinutes: 15 }), schedule({ kind: "interval", intervalMinutes: 30 })] };
  const initial = advanceSchedule(definition, undefined, now, true);
  const first = advanceSchedule(definition, initial.state, now + 15 * 60000, true);
  assert.equal(first.due, true); assert.equal(rule(first.state, "0").pending, true); assert.equal(rule(first.state, "1").pending, false);
  const blocked = advanceSchedule(definition, first.state, now + 30 * 60000, true);
  assert.equal(blocked.due, false);
  assert.equal(advanceSchedule(definition, completed(blocked.state), now + 30 * 60000, true).due, true);
});

test("each schedule uses its own time zone", () => {
  const now = at("2026-10-29T07:00:00Z");
  const definition = { schedulesPaused: false, schedules: [schedule({ time: "09:00", timeZone: "Europe/Warsaw" }), schedule({ time: "09:00", timeZone: "America/New_York" })] };
  const initial = advanceSchedule(definition, undefined, now, true);
  assert.equal(rule(initial.state, "0").nextAt, at("2026-10-29T08:00:00Z"));
  assert.equal(rule(initial.state, "1").nextAt, at("2026-10-29T13:00:00Z"));
  const warsawDue = advanceSchedule(definition, initial.state, at("2026-10-29T08:00:00Z"), true);
  assert.equal(warsawDue.due, true); assert.equal(rule(warsawDue.state, "1").pending, false);
  const newYorkDue = advanceSchedule(definition, completed(warsawDue.state), at("2026-10-29T13:00:00Z"), true);
  assert.equal(newYorkDue.due, true); assert.equal(rule(newYorkDue.state, "0").pending, false); assert.equal(rule(newYorkDue.state, "1").pending, true);
});

test("reordering changed schedules recomputes the rules in their new positions", () => {
  const now = at("2026-10-29T12:00:00Z");
  const first = schedule({ kind: "interval", intervalMinutes: 15 }), second = schedule({ kind: "interval", intervalMinutes: 45 });
  const initial = advanceSchedule({ schedulesPaused: false, schedules: [first, second] }, undefined, now, true);
  const reordered = advanceSchedule({ schedulesPaused: false, schedules: [second, first] }, initial.state, now + 60000, true);
  assert.equal(reordered.due, false); assert.equal(rule(reordered.state,"0").nextAt,now+46*60000); assert.equal(rule(reordered.state,"1").nextAt,now+16*60000);
});

test("editing an interval rule starts its future anchor at the edit time", () => {
  const now = at("2026-10-29T12:00:00Z"), definition = task({ kind: "interval", intervalMinutes: 15 });
  const initial = advanceSchedule(definition, undefined, now, true), replacementTime = now + 5 * 60000;
  const replacement = advanceSchedule({ schedulesPaused: false, schedules: [schedule({ name:"Renamed", kind: "interval", intervalMinutes: 15 })] }, initial.state, replacementTime, true);
  assert.deepEqual(Object.keys(replacement.state.schedules), ["0"]);
  assert.equal(replacement.due, false); assert.equal(rule(replacement.state).nextAt, replacementTime + 15 * 60000);
});

test("deleted schedule state is removed and re-adding the rule starts fresh", () => {
  const now = at("2026-10-29T12:00:00Z"), definition = task({ kind: "interval", intervalMinutes: 15 });
  const initial = advanceSchedule(definition, undefined, now, true);
  const removed = advanceSchedule({ schedulesPaused: false, schedules: [] }, initial.state, now + 60000, true);
  assert.equal(removed.due, false); assert.deepEqual(Object.keys(removed.state.schedules), []);
  const readded = advanceSchedule(definition, removed.state, now + 5 * 60000, true);
  assert.equal(readded.due, false); assert.equal(rule(readded.state).nextAt, now + 20 * 60000);
});

test("an empty, manual-only task or paused schedules has no automatic occurrence", () => {
  const now = at("2026-10-29T12:00:00Z");
  for (const definition of [{ schedulesPaused: false, schedules: [] }, task({ kind: "manual" }), task({ paused: true }), { schedulesPaused: true, schedules: [schedule(), schedule({ kind: "interval" })] }]) {
    const result = advanceSchedule(definition, undefined, now, true);
    assert.equal(result.due, false);
    for (const state of Object.values(result.state.schedules)) { assert.equal(state.nextAt, null); assert.equal(state.pending, false); }
  }
});

test("editing a schedule during the repeated DST hour retains its last wall-clock key", () => {
  const definition = task(), firstAt = at("2026-10-25T00:30:00Z");
  const initial = advanceSchedule(definition, undefined, at("2026-10-24T12:00:00Z"), true);
  const first = advanceSchedule(definition, initial.state, firstAt, true);
  assert.equal(first.due, true); assert.equal(rule(first.state).lastWallKey, "2026-10-25 02:30");
  const edited = task({ name: "Renamed daily schedule" });
  const changed = advanceSchedule(edited, completed(first.state), firstAt + 60000, true);
  assert.equal(changed.due, false); assert.equal(rule(changed.state).lastWallKey, "2026-10-25 02:30");
  assert.equal(rule(changed.state).nextAt, at("2026-10-26T01:30:00Z"));
  assert.equal(advanceSchedule(edited, changed.state, at("2026-10-25T01:30:00Z"), true).due, false);
  const editedAgain = task({ name: "Daily, renamed again" });
  const changedAgain = advanceSchedule(editedAgain, changed.state, firstAt + 120000, true);
  assert.equal(rule(changedAgain.state).nextAt, at("2026-10-26T01:30:00Z"));
  assert.equal(advanceSchedule(editedAgain, changedAgain.state, at("2026-10-25T01:30:00Z"), true).due, false);
});

test("scheduler state rejects earlier versions instead of converting a singular schedule", () => {
  for (const value of [undefined, null, [], {}, { schemaVersion: 1, tasks: {} }, { schemaVersion: 3, tasks: {} }]) {
    assert.throws(() => parseSchedulerState(value), { code: "SCHEDULER_VERSION" });
  }
});

test("scheduler state rejects malformed roots, task keys and rule values", () => {
  const now = at("2026-10-29T12:00:00Z"), taskId = path.join(workspace,"backup",".delta.json");
  const state = advanceSchedule(task(), undefined, now, true).state;
  const make = () => ({ schemaVersion: 2, tasks: { [taskId]: structuredClone(state) } });
  const malformed = [
    { ...make(), extra: true },
    { schemaVersion: 2, tasks: [] },
    { schemaVersion: 2, tasks: { "": structuredClone(state) } },
    { schemaVersion: 2, tasks: { [taskId]: { ...structuredClone(state), nextAt: now } } },
    { schemaVersion: 2, tasks: { [taskId]: { schedules: [] } } },
    { schemaVersion: 2, tasks: { [taskId]: { schedules: { "invalid/rule": structuredClone(rule(state)) } } } }
  ];
  for (const fields of [{ nextAt: Infinity }, { nextAt: "later" }, { lastAt: NaN }, { pending: "false" }, { available: 1 }, { fingerprint: "" }, { fingerprint: undefined }, { lastWallKey: 12 }, { extra: true }]) {
    const value = make(); Object.assign(value.tasks[taskId].schedules["0"], fields); malformed.push(value);
  }
  for (const value of malformed) {
    const copy = structuredClone(value);
    assert.throws(() => parseSchedulerState(value), /Invalid scheduler/);
    assert.deepEqual(value, copy);
  }
});

test("restart preserves independent deadlines and wall keys while clearing only pending flags", () => {
  const now = at("2026-10-29T12:00:00Z"), taskId = path.join(workspace,"backup",".delta.json");
  const definition = { schedulesPaused: false, schedules: [schedule({ time: "12:00", timeZone: "UTC" }), schedule({ kind: "interval", intervalMinutes: 15 })] };
  const initial = saved(definition, now - 3600000, { "0": { nextAt: now }, "1": { nextAt: now + 60000 } });
  const state = advanceSchedule(definition, initial, now, true).state;
  const value = JSON.parse(JSON.stringify({ schemaVersion: 2, tasks: { [taskId]: state } })), copy = structuredClone(value);
  assert.equal(rule(state).pending, true); assert.equal(rule(state, "1").pending, false);
  const restored = parseSchedulerState(value)[taskId];
  for (const [id, original] of Object.entries(state.schedules)) assert.deepEqual(rule(restored, id), { ...original, pending: false });
  assert.deepEqual(value, copy);
  assert.equal(advanceSchedule(definition, restored, now + 30000, true).due, false);
  const intervalDue = advanceSchedule(definition, restored, now + 60000, true);
  assert.equal(intervalDue.due, true); assert.equal(rule(intervalDue.state).pending, false); assert.equal(rule(intervalDue.state, "1").pending, true);
});
