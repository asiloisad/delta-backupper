import assert from "node:assert/strict";
import { after, test } from "node:test";
import { build } from "esbuild";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const directory = await mkdtemp(path.join(tmpdir(), "delta-notification-permission-"));
after(() => rm(directory, { recursive: true, force: true }));
const filename = path.join(directory, "permission.cjs");
await build({ entryPoints: ["src/platform/notification-permission.ts"], outfile: filename, bundle: true, platform: "node", target: "node24", format: "cjs", logLevel: "silent" });
const { notificationPermission, notificationBlockedBySettings, WINDOWS_NOTIFICATIONS_BLOCKED } = createRequire(import.meta.url)(filename);

test("an explicit disabled Windows ToastEnabled policy is actionable without invoking the native notification API", async () => {
  for (const value of ["0x0", "0"]) {
    let calls = 0;
    const permission = await notificationPermission({ platform: "win32", query: async () => { calls++; return `HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\PushNotifications\r\n    ToastEnabled    REG_DWORD    ${value}\r\n`; } });
    assert.deepEqual(permission, { allowed: false, message: WINDOWS_NOTIFICATIONS_BLOCKED }); assert.equal(calls, 1);
    assert(!permission.message.includes("HRESULT"));
  }
});

test("enabled, absent, unexpected and inaccessible Windows policies leave native delivery available", async () => {
  for (const value of ["ToastEnabled REG_DWORD 0x1", "ToastEnabled REG_DWORD 1", "OtherPolicy REG_DWORD 0x0", "ToastEnabled REG_SZ 0", ""]) {
    assert.deepEqual(await notificationPermission({ platform: "win32", query: async () => value }), { allowed: true });
  }
  assert.deepEqual(await notificationPermission({ platform: "win32", query: async () => { throw new Error("ERROR: The system was unable to find the specified registry key or value."); } }), { allowed: true });
});

test("non-Windows platforms never execute a Windows registry query", async () => {
  for (const platform of ["linux", "darwin"]) assert.deepEqual(await notificationPermission({ platform, query: async () => { throw new Error("Must not query registry"); } }), { allowed: true });
});

test("only known notification settings policy errors are classified as blocked", () => {
  for (const value of ["HRESULT: -2143420140", "HRESULT 0x803E0114", "Settings prevent the notification type from being delivered.", "Notification type is disabled by system settings"]) assert.equal(notificationBlockedBySettings(new Error(value)), true);
  for (const value of ["Notification service stopped", "Permission is denied", "HRESULT: -2147024891", "0x803e0115"]) assert.equal(notificationBlockedBySettings(value), false);
});
