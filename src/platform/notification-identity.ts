import { app, shell } from "electron";
import { execFile } from "node:child_process";
import { lstat, mkdir } from "node:fs/promises";
import path from "node:path";
import { APP_ID, APP_NAME, APP_TOAST_CLSID, DEVELOPMENT_APP_ID, DEVELOPMENT_APP_NAME, DEVELOPMENT_TOAST_CLSID } from "./application-identity.mjs";

export interface NotificationIdentity {
  appId: string;
  name: string;
  clsid: string;
  executable: string;
  iconPath: string;
  arguments: string[];
  command: string;
  shortcut: string;
}
export interface IdentityPorts {
  platform: NodeJS.Platform;
  packaged: boolean;
  executable: string;
  projectDirectory: string;
  programsDirectory: string;
  iconPath?: string;
  setName(name: string): void;
  setAppId(id: string): void;
  setClsid(id: string): void;
  readShortcut(filename: string): Promise<Electron.ShortcutDetails | null>;
  writeShortcut(filename: string, details: Electron.ShortcutDetails): Promise<void>;
  registry(mode: "Check" | "Prepare" | "Repair" | "Remove", identity: NotificationIdentity): Promise<unknown>;
}

/** Quote a single Windows argv element; no shell evaluates the result. */
export function quoteWindowsArgument(value: string): string {
  if (/[\0\r\n]/.test(value)) throw new Error("Notification launch arguments cannot contain control characters");
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, "$1$1")}"`;
}
function samePath(left: string | undefined, right: string) {
  return typeof left === "string" && path.win32.resolve(left).toLowerCase() === path.win32.resolve(right).toLowerCase();
}
export function createNotificationIdentity(ports: IdentityPorts, probeId?: string): NotificationIdentity {
  if (probeId && !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(probeId)) throw new Error("Notification probe identity must be a UUID v4");
  const appId = probeId ? `${APP_ID}.probe.${probeId.toLowerCase()}` : ports.packaged ? APP_ID : DEVELOPMENT_APP_ID;
  const name = probeId ? `${APP_NAME} Probe ${probeId.toLowerCase()}` : ports.packaged ? APP_NAME : DEVELOPMENT_APP_NAME;
  const clsid = probeId ? `{${probeId.toUpperCase()}}` : ports.packaged ? APP_TOAST_CLSID : DEVELOPMENT_TOAST_CLSID;
  const args = ports.packaged ? [] : [ports.projectDirectory, "-f", "--dev"];
  // Clicking an isolated probe after it exits must never start a normal user profile.
  if (probeId) args.push("--delta-notification-probe-activation");
  const executable = path.win32.resolve(ports.executable);
  const iconPath = path.win32.resolve(ports.iconPath ?? path.win32.join(ports.packaged ? path.win32.dirname(executable) : ports.projectDirectory, "resources/branding/app.ico"));
  const command = [executable, ...args].map(quoteWindowsArgument).join(" ");
  return { appId, name, clsid, executable, iconPath, arguments: args, command, shortcut: path.win32.join(ports.programsDirectory, `${name}.lnk`) };
}

/** Injectable controller keeps registry and shortcut side effects out of unit tests. */
export function notificationIdentityController(ports: IdentityPorts, probeId?: string) {
  const identity = createNotificationIdentity(ports, probeId);
  // The Windows presenter can use the executable's ProductName for its native
  // shortcut, even when a packaged probe has a distinct runtime app name.
  const nativeProductAlias: NotificationIdentity | undefined = probeId && ports.packaged ? { ...identity, name: APP_NAME, shortcut: path.win32.join(ports.programsDirectory, `${APP_NAME}.lnk`) } : undefined;
  let prepared = false;
  let preparation: Promise<NotificationIdentity> | undefined;
  let repair: Promise<unknown> | undefined;
  function configure() {
    ports.setName(identity.name);
    if (ports.platform === "win32") { ports.setAppId(identity.appId); ports.setClsid(identity.clsid); }
    return identity;
  }
  function prepare(): Promise<NotificationIdentity> {
    if (ports.platform !== "win32" || prepared) return Promise.resolve(identity);
    preparation ??= (async () => {
      if (nativeProductAlias && await ports.readShortcut(nativeProductAlias.shortcut)) throw new Error("The packaged notification probe requires the Delta Backupper Start Menu shortcut to be absent");
      const existing = await ports.readShortcut(identity.shortcut);
      // A path match alone is insufficient in development, where every Electron app shares electron.exe.
      if (existing && (!samePath(existing.target, identity.executable) || existing.appUserModelId !== identity.appId || existing.toastActivatorClsid?.toLowerCase() !== identity.clsid.toLowerCase())) throw new Error("A foreign Start Menu shortcut already uses the notification name");
      await ports.registry("Check", identity);
      await ports.writeShortcut(identity.shortcut, { target: identity.executable, args: identity.arguments.map(quoteWindowsArgument).join(" "), cwd: path.win32.dirname(identity.executable), description: identity.name, icon: identity.iconPath, iconIndex: 0, appUserModelId: identity.appId, toastActivatorClsid: identity.clsid });
      await ports.registry("Prepare", identity);
      prepared = true;
      return identity;
    })().catch(error => { preparation = undefined; throw error; });
    return preparation;
  }
  async function afterNotificationCreated() {
    if (ports.platform !== "win32") return;
    if (!prepared) throw new Error("Prepare notification identity before accessing native notifications");
    // Electron may register asynchronously or keep a complete custom registration.
    // Verify the complete owned command; a native raw-executable write is not required.
    repair ??= ports.registry("Repair", identity).catch(error => { repair = undefined; throw error; });
    await repair;
  }
  async function cleanupProbe() {
    if (!probeId) throw new Error("Only an isolated notification probe identity can be cleaned up at runtime");
    if (ports.platform !== "win32") return;
    await preparation?.catch(() => {});
    const errors: unknown[] = [];
    let registration: unknown;
    let nativeProductShortcut: { identity: NotificationIdentity; registration: unknown; ownedAliasAbsent: boolean; shortcutAbsent: boolean; preservedForeignShortcut: boolean } | undefined;
    try { registration = await ports.registry("Remove", identity); } catch (error) { errors.push(error); }
    if (nativeProductAlias) {
      try {
        // Changing only the presentation name/path keeps the probe UUID's exact
        // AppID, CLSID and executable guards. A real user's shortcut is foreign.
        const removed = await ports.registry("Remove", nativeProductAlias);
        const remaining = await ports.readShortcut(nativeProductAlias.shortcut);
        const owned = remaining && samePath(remaining.target, nativeProductAlias.executable) && remaining.appUserModelId === nativeProductAlias.appId && remaining.toastActivatorClsid?.toLowerCase() === nativeProductAlias.clsid.toLowerCase();
        if (owned) throw new Error("The owned native notification probe shortcut remains after cleanup");
        nativeProductShortcut = { identity: nativeProductAlias, registration: removed, ownedAliasAbsent: true, shortcutAbsent: !remaining, preservedForeignShortcut: Boolean(remaining) };
      } catch (error) { errors.push(error); }
    }
    prepared = false; preparation = undefined; repair = undefined;
    if (errors.length) throw new AggregateError(errors, "Notification probe identity cleanup was incomplete");
    return { identity, registration, ...(nativeProductShortcut ? { nativeProductShortcut } : {}) };
  }
  return { identity, configure, prepare, afterNotificationCreated, cleanupProbe };
}

function registryHelper(mode: "Check" | "Prepare" | "Repair" | "Remove", identity: NotificationIdentity): Promise<unknown> {
  const helper = app.isPackaged ? path.join(path.dirname(process.execPath), "notification-registration.ps1") : path.resolve(__dirname, "../../resources/win/notification-registration.ps1");
  const executable = path.join(process.env.SystemRoot ?? "C:/Windows", "System32/WindowsPowerShell/v1.0/powershell.exe");
  const environment = { ...process.env }; delete environment.PSModulePath;
  return new Promise((resolve, reject) => {
    const child = execFile(executable, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", helper, "-Mode", mode], { windowsHide: true, timeout: 12_000, maxBuffer: 256 * 1024, env: environment }, (error, stdout, stderr) => {
      if (error) { reject(new Error(`Windows notification registration failed: ${stderr.trim() || error.message}`)); return; }
      try { resolve(JSON.parse(stdout.replace(/^\uFEFF/, "").trim())); } catch { reject(new Error("Invalid notification registration response")); }
    });
    child.stdin?.end(JSON.stringify(identity), "utf8");
  });
}

let active: ReturnType<typeof notificationIdentityController> | undefined;
/** Call before app.whenReady(), and before single-instance locking. */
export function configureNotificationIdentity(options: { probeId?: string; ports?: IdentityPorts } = {}) {
  const ports: IdentityPorts = options.ports ?? {
    platform: process.platform, packaged: app.isPackaged, executable: process.execPath, projectDirectory: app.getAppPath(), programsDirectory: path.join(app.getPath("appData"), "Microsoft/Windows/Start Menu/Programs"),
    iconPath: app.isPackaged ? path.join(process.resourcesPath, "branding/app.ico") : path.resolve(__dirname, "../../resources/branding/app.ico"),
    setName: name => app.setName(name), setAppId: id => app.setAppUserModelId(id), setClsid: id => app.setToastActivatorCLSID(id),
    async readShortcut(filename) { try { const info = await lstat(filename); if (!info.isFile() || info.isSymbolicLink()) throw new Error("Notification shortcut is not a regular file"); return shell.readShortcutLink(filename); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; } },
    async writeShortcut(filename, details) { await mkdir(path.dirname(filename), { recursive: true }); if (!shell.writeShortcutLink(filename, "create", details)) throw new Error("Cannot create the notification Start Menu shortcut"); },
    registry: registryHelper,
  };
  active = notificationIdentityController(ports, options.probeId);
  return active.configure();
}
/** Call after ready, before Notification.isSupported() or new Notification(). */
export async function prepareNotificationIdentity(): Promise<void> { if (!active) throw new Error("Notification identity is not configured"); await active.prepare(); }
/** Call after the first Notification.isSupported() or constructor; await before showing the first toast. */
export async function afterNotificationCreated() { if (!active) throw new Error("Notification identity is not configured"); return active.afterNotificationCreated(); }
/** Probe teardown only; normal application registrations belong to the installer lifecycle. */
export async function cleanupNotificationProbeIdentity() { if (!active) throw new Error("Notification identity is not configured"); return active.cleanupProbe(); }
