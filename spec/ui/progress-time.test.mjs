import assert from "node:assert/strict";
import { after, test } from "node:test";
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

const temporary = await mkdtemp(path.join(tmpdir(), "delta-progress-time-"));
after(() => { assert.equal(path.dirname(temporary), path.resolve(tmpdir())); return rm(temporary, { recursive: true, force: true }); });
const bundle = path.join(temporary, "progress-time.cjs");
await build({ entryPoints: ["static/progress-time.ts"], outfile: bundle, bundle: true, platform: "node", target: "node24", format: "cjs", logLevel: "silent" });
const { ProgressTiming, formatDuration } = createRequire(import.meta.url)(bundle);
const operation = (completed, overrides = {}) => ({ id: "backup", status: "running", progress: { phase: "backup", completedFiles: completed, totalFiles: 100 }, ...overrides });
const close = (actual, expected) => assert(Math.abs(actual - expected) < .000001, `Expected ${actual} to be ${expected}`);

test("unknown totals, unavailable states and unmoving counters never produce a guessed estimate", () => {
  const timing = new ProgressTiming();
  for (const value of [operation(0), operation(1, { progress: { phase: "scan", files: 1 } }), operation(1, { progress: null }), operation(1, { status: "queued" }), operation(1, { status: "complete" }), operation(1, { status: "failed" }), operation(1, { paused: true })]) {
    timing.observe(value, 0); assert.equal(timing.remaining(value, 5000), undefined);
  }
  const stuck = operation(10); timing.observe(stuck, 0); timing.observe(stuck, 5000); assert.equal(timing.remaining(stuck, 10000), undefined);
});

test("an estimate warms up on observed work rather than treating previously completed files as measured speed", () => {
  const timing = new ProgressTiming(); timing.observe(operation(50), 0); timing.observe(operation(55), 500);
  assert.equal(timing.remaining(operation(55), 500), undefined);
  timing.observe(operation(60), 1000); close(timing.remaining(operation(60), 1000), 4);
});

test("byte totals take precedence over file counts and both current-counter spellings work", () => {
  const timing = new ProgressTiming(), initial = operation(0, { progress: { phase: "backup", bytes: 0, totalBytes: 1000, files: 0, totalFiles: 2 } }), next = operation(0, { progress: { phase: "backup", completedBytes: 250, totalBytes: 1000, completedFiles: 1, totalFiles: 2 } });
  timing.observe(initial, 0); timing.observe(next, 1000); close(timing.remaining(next, 1000), 3);
  const files = operation(20, { id: "files", progress: { phase: "restore", files: 20, totalFiles: 100 } }); timing.observe({ ...files, progress: { ...files.progress, files: 0 } }, 0); timing.observe(files, 2000); close(timing.remaining(files, 2000), 8);
});

test("a stall increases the estimate until actual progress changes the measured rate", () => {
  const timing = new ProgressTiming(); timing.observe(operation(0), 0); timing.observe(operation(20), 2000);
  close(timing.remaining(operation(20), 2000), 8); close(timing.remaining(operation(20), 10000), 40);
  timing.observe(operation(20), 10000); close(timing.remaining(operation(20), 10000), 40);
  timing.observe(operation(30), 12000); close(timing.remaining(operation(30), 12000), 28);
});

test("pause removes the old rate and resume requires fresh progress without including the long pause", () => {
  const timing = new ProgressTiming(); timing.observe(operation(0), 0); timing.observe(operation(20), 2000); close(timing.remaining(operation(20), 2000), 8);
  const paused = operation(20, { paused: true }); timing.observe(paused, 2500); assert.equal(timing.remaining(paused, 90000), undefined);
  timing.observe(operation(25), 100000); assert.equal(timing.remaining(operation(25), 100000), undefined);
  timing.observe(operation(35), 101000); close(timing.remaining(operation(35), 101000), 6.5);
});

test("changing phase, total, work unit or resetting a counter starts a separate measurement", () => {
  const changes = [
    operation(20, { progress: { phase: "verify", completedFiles: 20, totalFiles: 100 } }),
    operation(20, { progress: { phase: "backup", completedFiles: 20, totalFiles: 200 } }),
    operation(20, { progress: { phase: "backup", completedBytes: 20, totalBytes: 100 } }),
    operation(5),
  ];
  for (const changed of changes) {
    const timing = new ProgressTiming(); timing.observe(operation(0), 0); timing.observe(operation(20), 2000); assert(timing.remaining(operation(20), 2000) > 0);
    timing.observe(changed, 3000); assert.equal(timing.remaining(changed, 3000), undefined); assert.equal(timing.remaining(changed, 8000), undefined);
    const field = "completedBytes" in changed.progress ? "completedBytes" : "completedFiles", advanced = { ...changed, progress: { ...changed.progress, [field]: changed.progress[field] + 10 } }; timing.observe(advanced, 4000); assert(timing.remaining(advanced, 4000) > 0);
  }
});

test("zero is reserved for an actual positive total that has been completely measured", () => {
  const timing = new ProgressTiming();
  for (const progress of [{ completedFiles: 0, totalFiles: 0 }, { completedFiles: 101, totalFiles: 100 }, { completedFiles: 10, totalFiles: Infinity }, { completedFiles: -1, totalFiles: 100 }, { completedFiles: NaN, totalFiles: 100 }]) { const invalid = operation(0, { progress }); timing.observe(invalid, 0); assert.equal(timing.remaining(invalid, 1000), undefined); }
  timing.observe(operation(100), 2000); assert.equal(timing.remaining(operation(100), 2000), 0);
  const paused = operation(100, { paused: true }); assert.equal(timing.remaining(paused, 2000), undefined);
  assert.equal(timing.remaining(operation(100, { status: "complete" }), 2000), undefined);
});

test("operations remain independent and explicit cleanup discards only forgotten work", () => {
  const timing = new ProgressTiming(), other = operation(0, { id: "other" }); timing.observe(operation(0), 0); timing.observe(other, 0); timing.observe(operation(20), 2000); const second = operation(50, { id: "other" }); timing.observe(second, 2000);
  close(timing.remaining(operation(20), 2000), 8); close(timing.remaining(second, 2000), 2); timing.forget(["other"]);
  assert.equal(timing.remaining(operation(20), 2000), undefined); close(timing.remaining(second, 2000), 2);
});

test("frequent progress remains measurable while stale operations and old samples are bounded", () => {
  const timing = new ProgressTiming(), value = count => operation(0, { progress: { phase: "backup", bytes: count, totalBytes: 20000 } });
  for (let count = 0; count <= 10000; count++) timing.observe(value(count), count * 5);
  close(timing.remaining(value(10000), 50000), 50);
  for (let index = 0; index < 1000; index++) timing.observe(operation(0, { id: `work-${index}` }), 50000);
  assert.equal(timing.remaining(value(10000), 50000), undefined);
  const latest = operation(10, { id: "work-999" }); timing.observe(latest, 51000); close(timing.remaining(latest, 51000), 9);
});

test("invalid or regressing monotonic timestamps cannot create a rate", () => {
  const timing = new ProgressTiming(); timing.observe(operation(0), 1000); timing.observe(operation(20), 2000); assert(timing.remaining(operation(20), 2000) > 0); assert.equal(timing.remaining(operation(20), 1900), undefined);
  timing.observe(operation(30), 500); assert.equal(timing.remaining(operation(30), 2000), undefined);
  timing.observe(operation(40), NaN); assert.equal(timing.remaining(operation(40), 2000), undefined);
});

test("duration formatting keeps nonzero remaining work visible and expands to hours", () => {
  for (const [seconds, expected] of [[0, "00:00"], [.01, "00:01"], [1.1, "00:02"], [59, "00:59"], [59.1, "01:00"], [60, "01:00"], [3599, "59:59"], [3600, "01:00:00"], [3661, "01:01:01"], [90061, "25:01:01"], [-2, "00:00"], [NaN, "00:00"], [Infinity, "00:00"]]) assert.equal(formatDuration(seconds), expected);
});
