import assert from "node:assert/strict";
import { test, after } from "node:test";
import { EventEmitter } from "node:events";
import { build } from "esbuild";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const directory = await mkdtemp(path.join(tmpdir(), "delta-desktop-integration-"));
after(() => rm(directory, { recursive: true, force: true }));
const filename = path.join(directory, "desktop-integration.cjs");
await build({ entryPoints: ["src/platform/desktop-integration.ts"], outfile: filename, bundle: true, platform: "node", target: "node24", format: "cjs", logLevel: "silent" });
const { DesktopIntegration } = createRequire(import.meta.url)(filename);
const deferred = () => { let resolve; const promise = new Promise(value => { resolve = value; }); return { promise, resolve }; };
const operation = (overrides = {}) => ({ id: "operation-1", taskId: "task-1", action: "run", status: "complete", startedAt: "2026-10-29T12:00:00.000Z", ...overrides });

class NativeNotification extends EventEmitter {
  shown = 0;
  closed = 0;
  constructor(options, behavior = "show") { super(); this.options = options; this.behavior = behavior; }
  show() {
    this.shown++;
    if (this.behavior === "throw") throw new Error("Controlled native show failure");
    if (this.behavior === "show") this.emit("show");
    if (this.behavior === "failed") queueMicrotask(() => this.emit("failed", {}, "The notification permission is denied."));
  }
  close() { this.closed++; this.emit("close"); }
}

function fixture(t, options = {}) {
  const state = { enabled: true, supported: true, trayAvailable: true, ...options.state };
  const calls = [], notifications = [], errors = [], navigations = [];
  const ports = {
    enabled: () => state.enabled,
    trayAvailable: () => state.trayAvailable,
    prepare: async () => { calls.push("prepare"); },
    supported: () => { calls.push("supported"); return state.supported; },
    afterNativeAccess: async () => { calls.push("afterNativeAccess"); },
    create: value => { calls.push("create"); const notification = new NativeNotification(value, options.behavior); notifications.push(notification); return notification; },
    navigate: async taskId => { navigations.push(taskId); },
    report: error => { errors.push(error); },
    submissionTimeoutMs: 15,
    ...options.ports,
  };
  const controller = new DesktopIntegration(ports);
  t.after(() => controller.close());
  return { controller, ports, state, calls, notifications, errors, navigations };
}

test("queued and running progress never creates native notifications or consumes terminal operation IDs", async t => {
  const { controller, notifications, calls } = fixture(t);
  for (const status of ["queued", "running", "running"]) await controller.handleOperation(operation({ status }), "Projects");
  assert.equal(notifications.length, 0); assert.deepEqual(calls, []); assert.equal(controller.diagnostics().seenOperations, 0);
  await controller.handleOperation(operation(), "Projects");
  assert.equal(notifications.length, 1); assert.equal(controller.diagnostics().seenOperations, 1);
});

test("concurrent repeated terminal events produce one native notification while preparation is pending", async t => {
  const gate = deferred(); const { controller, notifications, calls } = fixture(t, { ports: { prepare: async () => gate.promise } });
  const first = controller.handleOperation(operation(), "Projects");
  await Promise.all(Array.from({ length: 20 }, () => controller.handleOperation(operation(), "Projects")));
  assert.equal(notifications.length, 0); assert.deepEqual(calls, []); assert.equal(controller.diagnostics().seenOperations, 1);
  gate.resolve(); await first;
  await controller.handleOperation(operation({ status: "failed", error: "Repeated result" }), "Projects");
  assert.equal(notifications.length, 1);
});

test("disabled automatic notifications stay suppressed while the explicit test still submits", async t => {
  const { controller, state, notifications } = fixture(t, { state: { enabled: false } });
  await controller.handleOperation(operation(), "Projects"); assert.equal(notifications.length, 0);
  assert.deepEqual(await controller.testNotification(), { supported: true, status: "submitted" });
  assert.equal(notifications.length, 1); assert.equal(notifications[0].options.title, "Delta Backupper");
  state.enabled = true;
  await controller.handleOperation(operation(), "Projects"); assert.equal(notifications.length, 1);
  await controller.handleOperation(operation({ id: "operation-2" }), "Projects"); assert.equal(notifications.length, 2);
});

test("terminal notifications identify the operation, task and incomplete or post-commit outcomes", async t => {
  const { controller, notifications } = fixture(t);
  const examples = [
    [{ action: "run", status: "complete" }, "Backup complete"],
    [{ action: "resume", status: "complete" }, "Backup complete"],
    [{ action: "retry", status: "complete" }, "Backup retry complete"],
    [{ action: "scheduled-run", status: "complete" }, "Scheduled backup complete"],
    [{ action: "restore", status: "complete" }, "Restore complete"],
    [{ action: "verify", status: "failed", error: "Part is corrupt" }, "Verification failed"],
    [{ action: "run", status: "incomplete" }, "Backup incomplete"],
    [{ action: "run", status: "complete", error: "Backup data is committed; follow-up warning: Retention failed" }, "Backup complete with warnings"],
    [{ action: "run", status: "cancelled" }, "Backup cancelled"],
  ];
  for (const [index, [value, title]] of examples.entries()) {
    await controller.handleOperation(operation({ id: `operation-${index}`, ...value }), "  Projects żółć 🌍  ");
    const notification = notifications.at(-1);
    assert.equal(notification.options.title, title); assert(notification.options.body.startsWith("Projects żółć 🌍"));
    if (value.status === "incomplete") assert.match(notification.options.body, /incomplete.*Activity/);
    if (value.error) assert.match(notification.options.body, /Activity/);
    assert(!notification.options.body.includes(value.error ?? "This string does not occur"), "Native banners must not disclose raw file paths from operation errors");
  }
  await controller.handleOperation(operation({ id: "unnamed", action: "other-operation" }), "   ");
  assert.equal(notifications.at(-1).options.title, "Task complete"); assert.equal(notifications.at(-1).options.body, "Delta Backupper");
});

test("native objects remain retained after submission and are released on close or failure", async t => {
  const { controller, notifications, errors } = fixture(t);
  assert.equal((await controller.testNotification()).status, "submitted"); assert.equal(controller.diagnostics().retainedNotifications, 1);
  notifications[0].emit("close"); assert.equal(controller.diagnostics().retainedNotifications, 0);
  await controller.testNotification(); assert.equal(controller.diagnostics().retainedNotifications, 1);
  notifications[1].emit("failed", {}, "The notification service stopped.");
  assert.equal(controller.diagnostics().retainedNotifications, 0); assert.equal(controller.diagnostics().lastNotification.status, "failed");
  assert.equal(controller.diagnostics().lastNotification.message, "The notification service stopped."); assert.equal(errors.length, 1);
});

test("a native show event does not hide an asynchronous Windows delivery rejection", async t => {
  const { controller, notifications, errors } = fixture(t);
  const pending = controller.testNotification();
  await new Promise(resolve => setImmediate(resolve));
  notifications[0].emit("failed", {}, "Notification type is disabled by system settings");
  assert.equal((await pending).status, "blocked");
  assert.match(controller.diagnostics().lastNotification.message, /^Windows notifications are turned off\./);
  assert.equal(errors.length, 0);
  assert.equal(controller.diagnostics().retainedNotifications, 0);
});

test("Windows timed-out banners retain bounded references for late Notification Center clicks while user cancellation releases them", async t => {
  const { controller, notifications, navigations } = fixture(t);
  for (let index = 0; index < 40; index++) {
    await controller.handleOperation(operation({ id: `timed-out-${index}`, taskId: `task-${index}` }), "Projects");
    notifications.at(-1).emit("close", { reason: "timedOut" });
    assert.equal(controller.diagnostics().retainedNotifications, Math.min(index + 1, 32));
  }
  assert(notifications.slice(0, 8).every(notification => notification.closed === 1));
  assert(notifications.slice(8).every(notification => notification.closed === 0));
  const notification = notifications.at(-1);
  notification.emit("click"); notification.emit("click");
  assert.deepEqual(navigations, ["task-39"]);
  notification.emit("close", { reason: "userCanceled" });
  assert.equal(controller.diagnostics().retainedNotifications, 31);
  notifications.at(-2).emit("close", { reason: "timedOut" });
  assert.equal(controller.diagnostics().retainedNotifications, 31);
});

test("notification references are bounded and old terminal IDs are evicted without unbounded memory", async t => {
  const { controller, notifications } = fixture(t);
  for (let index = 0; index < 300; index++) await controller.handleOperation(operation({ id: `operation-${index}` }), "Projects");
  assert.equal(controller.diagnostics().seenOperations, 256); assert.equal(controller.diagnostics().retainedNotifications, 32);
  assert(notifications.slice(0, 268).every(notification => notification.closed === 1));
  assert(notifications.slice(268).every(notification => notification.closed === 0));
  await controller.handleOperation(operation({ id: "operation-299" }), "Projects"); assert.equal(notifications.length, 300);
  await controller.handleOperation(operation({ id: "operation-0" }), "Projects"); assert.equal(notifications.length, 301);
  assert.equal(controller.diagnostics().seenOperations, 256); assert.equal(controller.diagnostics().retainedNotifications, 32);
});

test("native clicks navigate to the associated task once and shutdown prevents later navigation", async t => {
  const { controller, notifications, navigations } = fixture(t);
  await controller.handleOperation(operation({ taskId: "selected-task" }), "Projects");
  notifications[0].emit("click"); notifications[0].emit("click");
  assert.deepEqual(navigations, ["selected-task"]);
  await controller.testNotification(); notifications[1].emit("click"); assert.deepEqual(navigations, ["selected-task", undefined]);
  await controller.handleOperation(operation({ id: "operation-2" }), "Projects"); controller.close(); notifications[2].emit("click");
  assert.deepEqual(navigations, ["selected-task", undefined]);
});

test("a rejected notification click reports the navigation failure without an unhandled rejection", async t => {
  const error = new Error("Window is unavailable");
  const { controller, notifications, errors } = fixture(t, { ports: { navigate: async () => { throw error; } } });
  await controller.testNotification(); notifications[0].emit("click"); await Promise.resolve();
  assert.deepEqual(errors, [error]);
});

test("asynchronous native failures and thrown show calls cannot reject backup completion handlers", async t => {
  for (const behavior of ["failed", "throw"]) {
    const { controller, notifications, errors } = fixture(t, { behavior });
    await assert.doesNotReject(controller.handleOperation(operation(), "Projects"));
    assert.equal(notifications.length, 1); assert.equal(errors.length, 1); assert.equal(controller.diagnostics().retainedNotifications, 0);
    const result = await controller.testNotification(); assert.equal(result.supported, true); assert.equal(result.status, "failed");
    assert.match(result.message, behavior === "throw" ? /Controlled native show failure/ : /permission is denied/);
  }
});

test("missing native failure detail has an actionable fallback and a silent OS submits after timeout", async t => {
  const { controller, notifications, errors } = fixture(t, { behavior: "silent" });
  const pending = controller.testNotification(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(notifications.length, 1); notifications[0].emit("failed", {}, "");
  assert.deepEqual(await pending, { supported: true, status: "failed", message: "The operating system could not display the notification." }); assert.equal(errors.length, 1);
  assert.deepEqual(await controller.testNotification(), { supported: true, status: "submitted" });
});

test("identity preparation and native registration repair complete before constructing notifications", async t => {
  const { controller, calls } = fixture(t);
  await controller.testNotification(); assert.deepEqual(calls, ["prepare", "supported", "afterNativeAccess", "create"]);
});

test("unsupported systems skip registration repair and never construct a notification", async t => {
  const { controller, calls, notifications, errors } = fixture(t, { state: { supported: false } });
  const result = await controller.testNotification();
  assert.deepEqual(result, { supported: false, status: "unsupported", message: "System notifications are not available on this computer." });
  assert.deepEqual(calls, ["prepare", "supported"]); assert.equal(notifications.length, 0); assert.equal(errors.length, 0);
});

test("preparation, support detection, repair and constructor failures are isolated with the correct support result", async t => {
  for (const [stage, supported] of [["prepare", false], ["supported", false], ["afterNativeAccess", true], ["create", true]]) {
    const error = new Error(`Controlled ${stage} failure`), calls = [];
    const ports = Object.fromEntries(["prepare", "supported", "afterNativeAccess", "create"].map(name => [name, () => { calls.push(name); if (name === stage) throw error; return name === "supported" ? true : undefined; }]));
    const { controller, errors, notifications } = fixture(t, { ports });
    assert.deepEqual(await controller.testNotification(), { supported, status: "failed", message: error.message });
    assert.deepEqual(errors, [error]); assert.equal(notifications.length, 0); assert.equal(controller.diagnostics().retainedNotifications, 0);
    const expected = ["prepare", "supported", "afterNativeAccess", "create"]; assert.deepEqual(calls, expected.slice(0, expected.indexOf(stage) + 1));
  }
});

test("shutdown settles all in-flight native submissions, closes each reference once and is idempotent", async t => {
  const { controller, notifications, navigations } = fixture(t, { behavior: "silent", ports: { submissionTimeoutMs: 60_000 } });
  const submissions = Array.from({ length: 5 }, () => controller.testNotification());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(notifications.length, 5); assert.equal(controller.diagnostics().retainedNotifications, 5);
  controller.close(); controller.close();
  const results = await Promise.all(submissions); assert(results.every(result => result.status === "failed" && /shutting down/.test(result.message)));
  assert.equal(controller.diagnostics().retainedNotifications, 0); assert(notifications.every(notification => notification.closed === 1));
  for (const notification of notifications) notification.emit("click"); assert.deepEqual(navigations, []);
});

test("shutdown during identity preparation performs no later native access or construction", async t => {
  const gate = deferred(), entered = deferred(), calls = [];
  const { controller, notifications } = fixture(t, { ports: { prepare: async () => { calls.push("prepare"); entered.resolve(); await gate.promise; } } });
  const pending = controller.testNotification(); await entered.promise; controller.close(); gate.resolve();
  assert.deepEqual(await pending, { supported: false, status: "failed", message: "The application is shutting down." });
  assert.deepEqual(calls, ["prepare"]); assert.equal(notifications.length, 0);
  assert.equal((await controller.testNotification()).status, "failed");
  await controller.handleOperation(operation(), "Projects"); assert.equal(notifications.length, 0);
});

test("shutdown during native registration repair cannot create a notification afterwards", async t => {
  const gate = deferred(), entered = deferred();
  const { controller, notifications, calls } = fixture(t, { ports: { afterNativeAccess: async () => { entered.resolve(); await gate.promise; } } });
  const pending = controller.testNotification(); await entered.promise; controller.close(); gate.resolve();
  assert.deepEqual(await pending, { supported: true, status: "failed", message: "The application is shutting down." });
  assert.deepEqual(calls, ["prepare", "supported"]); assert.equal(notifications.length, 0);
});

test("native close failures during eviction and shutdown are reported while all references are released", async t => {
  const { controller, notifications, errors } = fixture(t);
  await controller.testNotification(); notifications[0].close = () => { throw new Error("Controlled close failure"); };
  for (let index = 0; index < 32; index++) await controller.testNotification();
  assert.equal(errors.length, 1); assert.equal(controller.diagnostics().retainedNotifications, 32);
  notifications[1].close = () => { throw new Error("Controlled shutdown close failure"); };
  controller.close(); assert.equal(errors.length, 2); assert.equal(controller.diagnostics().retainedNotifications, 0);
  assert(notifications.slice(2).every(notification => notification.closed === 1));
});

test("known Windows notification policy blocks skip identity preparation and every native API", async t => {
  const { controller, calls, notifications, errors } = fixture(t, { ports: { permission: async () => ({ allowed: false, message: "Windows notifications are turned off. Enable them in Windows Settings → System → Notifications." }) } });
  await assert.doesNotReject(controller.handleOperation(operation(), "Projects"));
  const result = await controller.testNotification();
  assert.equal(result.supported, true); assert.equal(result.status, "blocked"); assert.match(result.message, /Windows Settings/);
  assert.deepEqual(calls, []); assert.deepEqual(notifications, []); assert.deepEqual(errors, []);
  assert.equal(controller.diagnostics().seenOperations, 1);
});

test("automatic permission preflight is shared and cached while an explicit test rechecks changed OS settings", async t => {
  let enabled = false, checked = 0, clock = 0;
  const { controller, notifications } = fixture(t, { ports: { now: () => clock, permission: async () => { checked++; return { allowed: enabled }; } } });
  await Promise.all(Array.from({ length: 10 }, (_, index) => controller.handleOperation(operation({ id: `blocked-${index}` }))));
  assert.equal(checked, 1); assert.equal(notifications.length, 0);
  enabled = true;
  await controller.handleOperation(operation({ id: "still-cached" }));
  assert.equal(checked, 1); assert.equal(notifications.length, 0);
  assert.equal((await controller.testNotification()).status, "submitted");
  assert.equal(checked, 2); assert.equal(notifications.length, 1);
  await controller.handleOperation(operation({ id: "enabled-cache" }));
  assert.equal(checked, 2); assert.equal(notifications.length, 2);
  enabled = false; clock = 30_000;
  await controller.handleOperation(operation({ id: "expired-cache" }));
  assert.equal(checked, 3); assert.equal(notifications.length, 2); assert.equal(controller.diagnostics().lastNotification.status, "blocked");
});

test("the Windows HRESULT becomes friendly blocked state and suppresses subsequent native attempts", async t => {
  const { controller, notifications, errors } = fixture(t);
  const pending = controller.testNotification(); await new Promise(resolve => setImmediate(resolve));
  notifications[0].emit("failed", {}, "Notification failed - Settings prevent the notification type from being delivered. (HRESULT: -2143420140)");
  const result = await pending;
  assert.equal(result.status, "blocked"); assert.match(result.message, /^Windows notifications are turned off\./); assert(!result.message.includes("HRESULT"));
  await controller.handleOperation(operation({ id: "after-native-policy-rejection" }));
  assert.equal(notifications.length, 1); assert.deepEqual(errors, []);
  assert.equal((await controller.testNotification()).status, "submitted"); assert.equal(notifications.length, 2);
});

test("a thrown native policy error is friendly while an inconclusive preflight permits native delivery", async t => {
  const { controller, calls, errors } = fixture(t, { ports: { permission: async () => { throw new Error("Registry inaccessible"); }, prepare: async () => { throw new Error("WPN_E_NOTIFICATION_TYPE_DISABLED (0x803E0114)"); } } });
  assert.equal((await controller.testNotification()).status, "blocked"); assert.deepEqual(errors, []); assert.deepEqual(calls, []);
  const normal = fixture(t, { ports: { permission: async () => { throw new Error("Registry inaccessible"); } } });
  assert.equal((await normal.controller.testNotification()).status, "submitted"); assert.equal(normal.notifications.length, 1); assert.deepEqual(normal.errors, []);
});

test("shutdown while permission is being checked cannot perform any native access afterwards", async t => {
  const gate = deferred(), entered = deferred();
  const { controller, calls, notifications } = fixture(t, { ports: { permission: async () => { entered.resolve(); await gate.promise; return { allowed: true }; } } });
  const pending = controller.testNotification(); await entered.promise; controller.close(); gate.resolve();
  assert.deepEqual(await pending, { supported: false, status: "failed", message: "The application is shutting down." });
  assert.deepEqual(calls, []); assert.equal(notifications.length, 0);
});
