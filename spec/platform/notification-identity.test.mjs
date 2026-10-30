import assert from "node:assert/strict";
import { test, after } from "node:test";
import { build } from "esbuild";
import { createRequire } from "node:module";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { APP_ID, APP_NAME, APP_TOAST_CLSID, DEVELOPMENT_APP_ID } from "../../src/platform/application-identity.mjs";

const directory = await mkdtemp(path.join(tmpdir(), "delta-notification-identity-"));
after(() => rm(directory, { recursive: true, force: true }));
const filename = path.join(directory, "identity.cjs");
await build({ entryPoints: ["src/platform/notification-identity.ts"], outfile: filename, bundle: true, platform: "node", target: "node24", format: "cjs", logLevel: "silent", plugins: [{ name: "fake-electron", setup(builder) { builder.onResolve({ filter: /^electron$/ }, () => ({ path: "electron", namespace: "fake" })); builder.onLoad({ filter: /.*/, namespace: "fake" }, () => ({ contents: "export const app = {}; export const shell = {};" })); } }] });
const { createNotificationIdentity, notificationIdentityController, quoteWindowsArgument } = createRequire(import.meta.url)(filename);
function ports(overrides = {}) {
  const calls = [];
  return { calls, platform: "win32", packaged: true, executable: "C:\\Program Files\\Delta Backupper\\Delta Backupper.exe", projectDirectory: "C:\\source project\\Delta", programsDirectory: "C:\\Users\\Example\\Start Menu\\Programs", setName: value => calls.push(["name", value]), setAppId: value => calls.push(["appId", value]), setClsid: value => calls.push(["clsid", value]), readShortcut: async () => null, writeShortcut: async (filename, value) => calls.push(["shortcut", filename, value]), registry: async mode => { calls.push(["registry", mode]); }, ...overrides };
}

test("production, development and UUID probes have distinct stable Windows identities", () => {
  const production = createNotificationIdentity(ports());
  const development = createNotificationIdentity(ports({ packaged: false }));
  const probe = createNotificationIdentity(ports(), "fd99192e-2a18-427a-a2e9-8c22a9562ad9");
  assert.equal(production.appId, APP_ID); assert.equal(production.name, APP_NAME); assert.equal(production.clsid, APP_TOAST_CLSID);
  assert.equal(production.iconPath, "C:\\Program Files\\Delta Backupper\\resources\\branding\\app.ico");
  assert.equal(development.appId, DEVELOPMENT_APP_ID); assert.notEqual(development.clsid, production.clsid);
  assert.deepEqual(development.arguments, ["C:\\source project\\Delta", "-f", "--dev"]);
  assert.equal(development.iconPath, "C:\\source project\\Delta\\resources\\branding\\app.ico");
  assert(probe.appId.endsWith(".probe.fd99192e-2a18-427a-a2e9-8c22a9562ad9")); assert.equal(probe.clsid, "{FD99192E-2A18-427A-A2E9-8C22A9562AD9}");
  assert.deepEqual(probe.arguments, ["--delta-notification-probe-activation"]);
  assert.equal(createNotificationIdentity(ports({ packaged: false }), "fd99192e-2a18-427a-a2e9-8c22a9562ad9").arguments.at(-1), "--delta-notification-probe-activation");
  assert.throws(() => createNotificationIdentity(ports(), "../../foreign"), /UUID v4/);
});

test("Windows launch commands quote spaces, embedded quotes and terminal backslashes as argv", () => {
  assert.equal(quoteWindowsArgument("C:\\folder with spaces\\"), '"C:\\folder with spaces\\\\"');
  assert.equal(quoteWindowsArgument('a"b'), '"a\\"b"');
  assert.equal(quoteWindowsArgument('a\\"b'), '"a\\\\\\"b"');
  assert.throws(() => quoteWindowsArgument("line\nbreak"), /control/);
  assert.equal(createNotificationIdentity(ports()).command, '"C:\\Program Files\\Delta Backupper\\Delta Backupper.exe"');
});

test("identity configures before native setup and registry preflight precedes every shortcut write", async () => {
  const fake = ports(); const controller = notificationIdentityController(fake);
  controller.configure(); await controller.prepare(); await controller.prepare();
  assert.deepEqual(fake.calls.slice(0, 3).map(call => call[0]), ["name", "appId", "clsid"]);
  assert.deepEqual(fake.calls.slice(3).map(call => call.slice(0, 2)), [["registry", "Check"], ["shortcut", controller.identity.shortcut], ["registry", "Prepare"]]);
  const shortcut = fake.calls.find(call => call[0] === "shortcut")[2];
  assert.equal(shortcut.appUserModelId, APP_ID); assert.equal(shortcut.toastActivatorClsid, APP_TOAST_CLSID);
  assert.equal(shortcut.icon, controller.identity.iconPath); assert.equal(shortcut.iconIndex, 0);
});

test("development and probe shortcuts use Delta artwork rather than the shared Electron executable", async () => {
  for (const probeId of [undefined, "fd99192e-2a18-427a-a2e9-8c22a9562ad9"]) {
    const fake = ports({ packaged: false, executable: "C:\\runtime\\electron.exe", iconPath: "C:\\custom resources\\branding\\app.ico" });
    const controller = notificationIdentityController(fake, probeId); await controller.prepare();
    const shortcut = fake.calls.find(call => call[0] === "shortcut")[2];
    assert.equal(shortcut.target, "C:\\runtime\\electron.exe");
    assert.equal(shortcut.icon, "C:\\custom resources\\branding\\app.ico");
    assert.notEqual(shortcut.icon, shortcut.target);
  }
});

test("concurrent preparation coalesces registry and shortcut work and a failed attempt can retry", async () => {
  const fake = ports(); let attempts = 0;
  fake.readShortcut = async () => { attempts++; await new Promise(resolve => setTimeout(resolve, 10)); if (attempts === 1) throw new Error("temporary shortcut read failure"); return null; };
  const controller = notificationIdentityController(fake);
  const failed = await Promise.allSettled([controller.prepare(), controller.prepare()]);
  assert(failed.every(result => result.status === "rejected")); assert.equal(attempts, 1);
  await Promise.all([controller.prepare(), controller.prepare(), controller.prepare()]);
  assert.equal(attempts, 2); assert.equal(fake.calls.filter(call => call[0] === "shortcut").length, 1); assert.equal(fake.calls.filter(call => call[0] === "registry").length, 2);
});

test("foreign shortcut identity is protected even when it points to the same shared Electron executable", async () => {
  for (const change of [{ target: "C:\\other.exe" }, { appUserModelId: "other.application" }, { toastActivatorClsid: "{00000000-0000-0000-0000-000000000000}" }]) {
    const fake = ports(); const expected = createNotificationIdentity(fake);
    fake.readShortcut = async () => ({ target: expected.executable, appUserModelId: expected.appId, toastActivatorClsid: expected.clsid, ...change });
    await assert.rejects(notificationIdentityController(fake).prepare(), /foreign Start Menu/);
    assert.equal(fake.calls.length, 0);
  }
});

test("foreign registry registration prevents shortcut mutation and an exact owned shortcut can be refreshed", async () => {
  const fake = ports({ registry: async () => { throw new Error("foreign registry"); } });
  await assert.rejects(notificationIdentityController(fake).prepare(), /foreign registry/); assert.equal(fake.calls.length, 0);
  const owned = ports(); const expected = createNotificationIdentity(owned);
  owned.readShortcut = async () => ({ target: expected.executable.toLowerCase(), appUserModelId: expected.appId, toastActivatorClsid: expected.clsid.toLowerCase() });
  await notificationIdentityController(owned).prepare(); assert(owned.calls.some(call => call[0] === "shortcut"));
});

test("native asynchronous COM repair runs once, waits for preparation and can retry a failure", async () => {
  const fake = ports(); let repairs = 0;
  fake.registry = async mode => { if (mode === "Repair" && ++repairs === 1) throw new Error("registration failed"); };
  const controller = notificationIdentityController(fake);
  await assert.rejects(controller.afterNotificationCreated(), /Prepare/); await controller.prepare();
  await assert.rejects(controller.afterNotificationCreated(), /registration failed/);
  await Promise.all([controller.afterNotificationCreated(), controller.afterNotificationCreated()]); assert.equal(repairs, 2);
});

test("Linux and macOS set the application name without Windows filesystem or registry effects", async () => {
  for (const platform of ["linux", "darwin"]) {
    const fake = ports({ platform }); const controller = notificationIdentityController(fake); controller.configure(); await controller.prepare(); await controller.afterNotificationCreated();
    assert.deepEqual(fake.calls, [["name", APP_NAME]]);
  }
});

test("runtime cleanup is restricted to UUID probes and delegates only guarded removal", async () => {
  const regular = notificationIdentityController(ports()); await assert.rejects(regular.cleanupProbe(), /Only an isolated/);
  const fake = ports({ packaged: false }); const controller = notificationIdentityController(fake, "fd99192e-2a18-427a-a2e9-8c22a9562ad9");
  await controller.cleanupProbe(); assert.deepEqual(fake.calls, [["registry", "Remove"]]);
});

test("packaged UUID probes refuse an existing product-name shortcut before registry or shortcut mutation", async () => {
  for (const shortcut of [{ target: "C:\\human-app.exe", appUserModelId: APP_ID, toastActivatorClsid: APP_TOAST_CLSID }, { target: "C:\\Program Files\\Delta Backupper\\Delta Backupper.exe" }]) {
    const fake = ports(), canonical = path.win32.join(fake.programsDirectory, `${APP_NAME}.lnk`);
    const reads = [];
    fake.readShortcut = async filename => { reads.push(filename); return filename === canonical ? shortcut : null; };
    const controller = notificationIdentityController(fake, "fd99192e-2a18-427a-a2e9-8c22a9562ad9");
    await assert.rejects(controller.prepare(), /requires.*shortcut to be absent/);
    assert.deepEqual(reads, [canonical]); assert.deepEqual(fake.calls, []);
    await assert.rejects(controller.afterNotificationCreated(), /Prepare/);
  }
});

test("packaged probe cleanup removes its product-name alias using the UUID's exact ownership guards", async () => {
  const fake = ports(), id = "fd99192e-2a18-427a-a2e9-8c22a9562ad9";
  const shortcuts = new Map(), removals = [];
  fake.readShortcut = async filename => shortcuts.get(filename) ?? null;
  fake.writeShortcut = async (filename, value) => shortcuts.set(filename, value);
  fake.registry = async (mode, identity) => {
    if (mode !== "Remove") return;
    removals.push(identity);
    const shortcut = shortcuts.get(identity.shortcut);
    if (shortcut?.target === identity.executable && shortcut.appUserModelId === identity.appId && shortcut.toastActivatorClsid === identity.clsid) shortcuts.delete(identity.shortcut);
    return { mode, removed: [identity.shortcut], preserved: [] };
  };
  const controller = notificationIdentityController(fake, id); await controller.prepare();
  const canonical = path.win32.join(fake.programsDirectory, `${APP_NAME}.lnk`);
  shortcuts.set(canonical, { target: controller.identity.executable, appUserModelId: controller.identity.appId, toastActivatorClsid: controller.identity.clsid });
  const cleaned = await controller.cleanupProbe();
  assert.equal(removals.length, 2); assert.equal(shortcuts.size, 0);
  assert.equal(removals[0].name, `${APP_NAME} Probe ${id}`); assert.equal(removals[1].name, APP_NAME); assert.equal(removals[1].shortcut, canonical);
  for (const identity of removals) { assert.equal(identity.appId, controller.identity.appId); assert.equal(identity.clsid, controller.identity.clsid); assert.equal(identity.executable, controller.identity.executable); }
  assert.equal(cleaned.nativeProductShortcut.ownedAliasAbsent, true); assert.equal(cleaned.nativeProductShortcut.shortcutAbsent, true); assert.equal(cleaned.nativeProductShortcut.preservedForeignShortcut, false);
});

test("packaged probe cleanup preserves a foreign product alias and still attempts alias cleanup after a primary removal error", async () => {
  const fake = ports(), canonical = path.win32.join(fake.programsDirectory, `${APP_NAME}.lnk`);
  const foreign = { target: "C:\\human-app.exe", appUserModelId: APP_ID, toastActivatorClsid: APP_TOAST_CLSID };
  const removals = [];
  fake.readShortcut = async filename => filename === canonical ? foreign : null;
  fake.registry = async (mode, identity) => { removals.push(identity); return { mode, removed: [], preserved: [identity.shortcut] }; };
  const controller = notificationIdentityController(fake, "fd99192e-2a18-427a-a2e9-8c22a9562ad9");
  const cleaned = await controller.cleanupProbe();
  assert.equal(removals.length, 2); assert.equal(cleaned.nativeProductShortcut.ownedAliasAbsent, true); assert.equal(cleaned.nativeProductShortcut.shortcutAbsent, false); assert.equal(cleaned.nativeProductShortcut.preservedForeignShortcut, true);
  removals.length = 0;
  fake.registry = async (mode, identity) => { removals.push(identity); if (identity.shortcut !== canonical) throw new Error("Primary cleanup failed"); return { mode, preserved: [identity.shortcut] }; };
  await assert.rejects(controller.cleanupProbe(), /cleanup was incomplete/);
  assert.equal(removals.length, 2); assert.equal(removals[1].shortcut, canonical);
});

test("packaged probe cleanup fails when its own native product alias remains", async () => {
  const fake = ports(), controller = notificationIdentityController(fake, "fd99192e-2a18-427a-a2e9-8c22a9562ad9");
  const canonical = path.win32.join(fake.programsDirectory, `${APP_NAME}.lnk`);
  fake.readShortcut = async filename => filename === canonical ? { target: controller.identity.executable, appUserModelId: controller.identity.appId, toastActivatorClsid: controller.identity.clsid } : null;
  await assert.rejects(controller.cleanupProbe(), /cleanup was incomplete/);
});

test("uninstaller resource invokes guarded notification cleanup before changing PATH or deleting application files", async () => {
  const template = await readFile(new URL("../../resources/win/installer.nsi", import.meta.url), "utf8");
  const uninstall = template.slice(template.indexOf('Section "Uninstall"'));
  assert(uninstall.indexOf("notification-registration.ps1") < uninstall.indexOf("install-path.ps1"));
  assert(uninstall.includes('IfFileExists "$WINDIR\\Sysnative\\WindowsPowerShell\\v1.0\\powershell.exe" 0 +2'), "32-bit NSIS must select native PowerShell for the desktop's CLSID registry view");
  assert(uninstall.indexOf('StrCpy $2 "$WINDIR\\Sysnative') < uninstall.indexOf("notification-registration.ps1"));
  const helper = await readFile(new URL("../../resources/win/notification-registration.ps1", import.meta.url), "utf8");
  assert(helper.includes(APP_ID)); assert(helper.includes(APP_TOAST_CLSID)); assert(!helper.includes("DeleteSubKeyTree"));
  assert(helper.includes("$key.SetValue('IconUri', $expectedIcon)"));
});
