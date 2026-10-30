import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, Notification, powerMonitor, screen, shell, Tray, utilityProcess } from "electron";
import { mkdir, readFile, writeFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ApplicationService, type ApiRequest, type Operation } from "./service/api.js";
import type { EngineExecutor, SourceProvider } from "./service/engine-executor.js";
import type { SourceConfig } from "./domain/models.js";
import type { SourceSession } from "./engine/index.mjs";
import { createSnapshotSourceProvider } from "./platform/snapshots.js";
import { setLinuxAutostart } from "./platform/autostart.js";
import { startUserStyles } from "./platform/user-styles.js";
import { startCoordinator } from "./service/coordinator.js";
import { ensureRuntimeDirectory } from "./platform/application-paths.mjs";
import { advanceSchedule, parseSchedulerState, type TaskScheduleState } from "./core/scheduler.js";
import { SchedulerWakeups } from "./core/scheduler-wakeups.js";
import { DesktopIntegration } from "./platform/desktop-integration.js";
import { systemNotificationPermission } from "./platform/notification-permission.js";
import { prepareNotificationIdentity, afterNotificationCreated, cleanupNotificationProbeIdentity } from "./platform/notification-identity.js";
import { UpdateChecker } from "./service/updates.js";
import { openExternalTextFile } from "./platform/external-text-editor.js";
import { openTaskLocation } from "./platform/task-locations.js";
import { createTraySnapshot, TrayPopup } from "./platform/tray-popup.js";
import { createTrayTooltip } from "./platform/tray-tooltip.js";
import { windowShortcut } from "./platform/window-shortcuts.js";

function utilityExecutor(provider: SourceProvider): EngineExecutor { return (request, progress, signal, _sourceProvider, control) => new Promise((resolve, reject) => {
  const child = utilityProcess.fork(path.join(__dirname, "engine-worker.cjs"), [], { stdio: "pipe" });
  let result: unknown;
  let hasResult = false;
  let failure: Error | undefined;
  let cancelTimer: ReturnType<typeof setTimeout> | undefined;
  let lease: SourceSession | undefined;
  const leaseAbort = new AbortController();
  let childExited = false;
  let childReady = false;
  const unsubscribePause = control?.onChange(paused => {
    if (!childReady || childExited) return;
    try { child.postMessage({ type: paused ? "pause" : "resume" }); }
    catch (error) { failure = error instanceof Error ? error : new Error(String(error)); child.kill(); }
  });
  let pendingControl: Promise<void> = Promise.resolve();
  const startup = setTimeout(() => { failure = new Error("Engine worker did not start"); child.kill(); }, 15_000);
  const abort = () => {
    child.postMessage({ type: "cancel" });
    cancelTimer = setTimeout(() => { failure = Object.assign(new Error("Engine worker did not stop; inspect the interrupted backup before restarting"), { code: "CLEANUP_UNVERIFIED" }); child.kill(); }, 15_000);
  };
  signal.addEventListener("abort", abort, { once: true });
  child.stdout?.resume(); child.stderr?.resume();
  child.on("message", (message: { type?: string; value?: unknown; message?: string; code?: string; cleanupVerified?: boolean; id?: string; fresh?: boolean; sources?: Array<import("./domain/models.js").ResolvedSource>; outcome?: { success: boolean } }) => {
    if (message.type === "ready") { clearTimeout(startup); childReady = true; if (control?.paused) child.postMessage({ type: "pause" }); child.postMessage({ type: "execute", request }); if (signal.aborted) abort(); }
    else if (message.type === "progress") progress(message.value);
    else if (message.type === "result") { hasResult = true; result = message.value; child.postMessage({ type: "finish" }); }
    else if (message.type === "error") { failure = Object.assign(new Error(message.message ?? "Engine operation failed"), { code: message.code, cleanupVerified: message.cleanupVerified }); child.postMessage({ type: "finish" }); }
    else if (message.type === "snapshot-prepare" || message.type === "snapshot-release" || message.type === "snapshot-verify") {
      pendingControl = pendingControl.then(async () => {
        try {
          let value: unknown = {};
          if (message.type === "snapshot-prepare") {
            if (lease || !request.task || !["run", "resume", "retry"].includes(request.action)) throw new Error("Invalid snapshot lease request");
            const { resolveTaskSources } = await import("./domain/source-identity.mjs");
            const expected = resolveTaskSources(request.task).map(source => ({ ...source, path: path.resolve(request.directory, source.path) }));
            if (!Array.isArray(message.sources) || message.sources.length !== expected.length || message.sources.some(source => !expected.some(item => source.id === item.id && source.path === item.path))) throw new Error("Worker requested an unexpected snapshot source");
            const prepared = await provider.prepare(request.task, { sources: expected, signal: AbortSignal.any([signal, leaseAbort.signal]) });
            if (childExited) { await prepared.release({ success: false }); throw new Error("Worker exited while preparing its snapshot lease"); }
            lease = prepared;
            value = { sources: lease.sources, consistentSnapshot: lease.consistentSnapshot, snapshotLease: lease.snapshotLease };
          } else if (message.type === "snapshot-verify") { if (!lease) throw new Error("Snapshot lease is unavailable"); await lease.verify?.({ fresh: message.fresh !== false }); }
          else { const active = lease; lease = undefined; await active?.release(message.outcome ?? { success: false }); }
          if (!childExited) child.postMessage({ type: "snapshot-response", id: message.id, value });
        } catch (error) { if (!childExited) { try { child.postMessage({ type: "snapshot-response", id: message.id, error: error instanceof Error ? error.message : String(error), code: (error as { code?: string }).code, cleanupVerified: (error as { cleanupVerified?: boolean }).cleanupVerified }); } catch { /* Child exited while responding. */ } } }
      });
    }
    else { failure = new Error("Invalid engine worker message"); child.kill(); }
  });
  child.once("exit", async code => {
    childExited = true;
    if (failure || code !== 0 || !hasResult) leaseAbort.abort(new Error("Worker exited before completing its operation"));
    clearTimeout(startup); clearTimeout(cancelTimer); signal.removeEventListener("abort", abort); unsubscribePause?.();
    try { await pendingControl; await lease?.release({ success: false }); } catch (error) { failure = error instanceof Error ? error : new Error(String(error)); }
    if (failure || code !== 0 || !hasResult) reject(failure ?? new Error(`Engine worker exited ${code} without a result`));
    else resolve(result);
  });
}); }

export async function startDesktop(configDirectory: string, options: { smokeReport?: string; show?: boolean } = {}) {
  const snapshotProvider = createSnapshotSourceProvider({ persistent: true });
  const service = new ApplicationService({ configDirectory, executor: utilityExecutor(snapshotProvider) });
  await service.ready;
  let window: BrowserWindow | undefined;
  const brandDirectory = app.isPackaged ? path.join(process.resourcesPath, "branding") : path.resolve(__dirname, "../../resources/branding");
  const applicationIcon = nativeImage.createFromBuffer(await readFile(path.join(brandDirectory, "app-icon.png")));
  const applicationMetadata = JSON.parse(await readFile(path.join(__dirname, "package.json"), "utf8")) as { version: string };
  const taskLocationOpens: Array<{ kind: "file" | "folder"; path: string }> = [];
  const updateQualification = options.smokeReport && process.argv.includes("--delta-ui-updates") ? await (await import("./core/updates-probe.js")).createUpdateQualificationTransport(configDirectory) : undefined;
  const updates = new UpdateChecker({ version: applicationMetadata.version, ...(updateQualification ? { fetch: updateQualification.fetch } : {}) });
  app.setAboutPanelOptions({ applicationName: "Delta Backupper", applicationVersion: applicationMetadata.version, copyright: "Copyright (c) 2026 Delta Backupper contributors", iconPath: path.join(brandDirectory, "app-icon.png") });
  const icon = nativeImage.createEmpty();
  for (const scale of [1, 2, 3]) {
    const size = 16 * scale;
    const bytes = await readFile(path.join(brandDirectory, `${process.platform === "darwin" ? "tray-template" : "tray"}-${size}.png`));
    icon.addRepresentation({ scaleFactor: scale, width: size, height: size, buffer: bytes });
  }
  if (process.platform === "darwin") { icon.setTemplateImage(true); app.dock?.setIcon(applicationIcon); }
  let tray: Tray | undefined;
  let trayPopup: TrayPopup | undefined;
  let trayTooltip = "";
  let quitting = false;
  let confirmingQuit = false;
  const systemProbe = Boolean(options.smokeReport && process.argv.includes("--delta-system-integration"));
  let coordinator: { close(): Promise<void> } | undefined;
  let applicationSettings = (await service.store.readApp()).value;
  const windowBackground = (): string => {
    const dark = applicationSettings.theme === "dark" || applicationSettings.theme === "system" && nativeTheme.shouldUseDarkColors;
    return applicationSettings.themeFamily === "aura" ? dark ? "#14161f" : "#ffffff" : dark ? "#282c34" : "#fafafa";
  };
  let titlebarStyleRevision = 0, titlebarStyle = "";
  async function syncNativeTitlebar(): Promise<void> {
    if (process.platform !== "win32" && process.platform !== "linux") return;
    const target = window, revision = ++titlebarStyleRevision; if (!target || target.isDestroyed() || target.webContents.isLoadingMainFrame()) return;
    const colors = await target.webContents.executeJavaScript("(() => {const titlebar=document.getElementById('titlebar');if(!titlebar)return null;const style=getComputedStyle(titlebar);return {color:style.backgroundColor,symbolColor:style.color,height:Math.round(titlebar.getBoundingClientRect().height)}})()") as { color: string; symbolColor: string; height: number } | null;
    if (!colors || colors.height <= 0 || target.isDestroyed() || target !== window || revision !== titlebarStyleRevision) return;
    const next = JSON.stringify(colors); if (next === titlebarStyle) return;
    target.setTitleBarOverlay(colors); titlebarStyle = next;
  }
  const syncWindowBackground = () => { if (window && !window.isDestroyed()) { window.setBackgroundColor(windowBackground()); void syncNativeTitlebar().catch(error => console.error("Native titlebar:", error)); } trayPopup?.update(); };
  nativeTheme.on("updated", syncWindowBackground);
  let userCss = "", userCssKey: string | undefined, userCssError: string | undefined;
  let appliedCss: string | undefined;
  let cssUpdates = Promise.resolve();
  const windowState = () => ({ platform: process.platform, maximized: window?.isMaximized() ?? false, fullscreen: window?.isFullScreen() ?? false });
  const sendWindowState = () => { if (window && !window.isDestroyed()) window.webContents.send("delta:window-state", windowState()); };
  function applyUserCss() {
    cssUpdates = cssUpdates.catch(() => {}).then(async () => {
      await trayPopup?.setUserStyles(userCss);
      const target = window;
      if (!target || target.isDestroyed() || target.webContents.isLoadingMainFrame()) return;
      const css = userCss;
      if (css === appliedCss) return;
      const previous = userCssKey;
      userCssKey = css ? await target.webContents.insertCSS(css) : undefined;
      if (previous && previous !== userCssKey && !target.isDestroyed()) await target.webContents.removeInsertedCSS(previous);
      appliedCss = css;
      await syncNativeTitlebar();
    });
    return cssUpdates;
  }
  const userStyles = await startUserStyles({ directory: configDirectory, onStyles: async css => { userCss = css; userCssError = undefined; await applyUserCss(); }, onError: error => { userCssError = error.message; console.error("User styles:", error.message); if (window && !window.isDestroyed()) window.webContents.send("delta:styles-error", error.message); } });
  const operations = () => [...service.operations.values()].filter(operation => ["queued", "running"].includes(operation.status));
  const desktopIntegration = new DesktopIntegration({
    enabled: () => applicationSettings.notifications && (!options.smokeReport || systemProbe) && !quitting,
    trayAvailable: () => Boolean(tray && !tray.isDestroyed()),
    permission: systemNotificationPermission,
    supported: () => Notification.isSupported(), create: settings => new Notification({ ...settings, icon: applicationIcon }),
    prepare: prepareNotificationIdentity, afterNativeAccess: afterNotificationCreated,
    navigate: async taskId => { await showWindow(); if (taskId && window && !window.isDestroyed()) window.webContents.send("delta:navigate", { taskId, tab: "activity" }); },
    report: error => console.error("System notification:", error instanceof Error ? error.message : String(error)),
  });
  let trayTasks: Array<{ id: string; name: string }> = [];
  let trayTasksAt = 0;
  let trayTaskRefresh: Promise<void> | undefined;
  let trayTaskError: string | undefined;
  let trayTaskRevision = 0;
  function refreshTrayTasks(): Promise<void> {
    if (!trayTaskRefresh) {
      const revision = trayTaskRevision;
      trayTaskRefresh = service.store.listTasks().then(tasks => { trayTasks = tasks.filter(entry => entry.available).map(entry => ({ id: entry.id, name: entry.name })); trayTaskError = undefined; }).catch(error => { trayTaskError = "Task names could not be refreshed. Open the application to check the task catalogue."; console.error("Tray task catalogue:", error instanceof Error ? error.message : String(error)); }).finally(() => { trayTasksAt = Date.now(); trayTaskRefresh = undefined; updateTray(); if (revision !== trayTaskRevision) void refreshTrayTasks(); });
    }
    return trayTaskRefresh;
  }
  trayPopup = new TrayPopup({
    createWindow: options => new BrowserWindow({ ...options, icon: applicationIcon }), ipc: ipcMain,
    file: path.join(__dirname, "static/tray.html"), preload: path.join(__dirname, "tray-preload.cjs"), background: windowBackground,
    workArea: anchor => screen.getDisplayMatching(anchor).workArea,
    snapshot: async () => {
      if (Date.now() - trayTasksAt > 1000) await refreshTrayTasks();
      if (trayTaskRefresh) await trayTaskRefresh;
      return { ...createTraySnapshot(applicationSettings, trayTasks, service.operations.values()), ...(trayTaskError ? { error: trayTaskError } : {}) };
    },
    action: async request => {
      if (request.action === "open") {
        if (request.taskId && !await service.store.findRememberedTask(request.taskId)) throw new Error("This task is no longer remembered");
        await showWindow();
        if (request.taskId && window && !window.isDestroyed()) {
          if (window.webContents.isLoadingMainFrame()) await new Promise<void>((resolve, reject) => {
            const contents = window!.webContents;
            const loaded = () => { cleanup(); resolve(); };
            const failed = () => { cleanup(); reject(new Error("The application window could not be loaded")); };
            const cleanup = () => { contents.removeListener("did-finish-load", loaded); contents.removeListener("did-fail-load", failed); contents.removeListener("destroyed", failed); };
            contents.once("did-finish-load", loaded); contents.once("did-fail-load", failed); contents.once("destroyed", failed);
          });
          if (window && !window.isDestroyed()) window.webContents.send("delta:navigate", { taskId: request.taskId, tab: "activity" });
        }
      }
      else if (request.action === "quit") await quit();
      else if (request.action === "cancel") {
        const operation = service.operations.get(request.operationId!);
        if (!operation || !["queued", "running"].includes(operation.status)) throw new Error("This operation is no longer running");
        await service.request({ action: "cancel", operationId: operation.id });
      } else if (request.action === "pause" || request.action === "resume") {
        const current = await service.store.readApp();
        await dispatch({ action: "app-save", revision: current.revision, value: { ...current.value, schedulerPaused: request.action === "pause" } });
      }
    },
    report: error => console.error("Tray popup:", error instanceof Error ? error.message : String(error)),
  });
  await trayPopup.setUserStyles(userCss);
  async function showWindow() {
    trayPopup?.hide();
    if (window && !window.isDestroyed()) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); return; }
    titlebarStyle = "";
    window = new BrowserWindow({ title: "Delta Backupper", icon: applicationIcon, titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "hidden", titleBarOverlay: { height: 36 }, autoHideMenuBar: true, width: 1200, height: 820, minWidth: 900, minHeight: 620, show: options.show ?? true, backgroundColor: windowBackground(), webPreferences: { preload: path.join(__dirname, "preload.cjs"), sandbox: true, contextIsolation: true, nodeIntegration: false, devTools: true } });
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", event => event.preventDefault());
    window.webContents.on("before-input-event", (event, input) => {
      const command = windowShortcut(input, process.platform);
      if (!command) return;
      event.preventDefault();
      if (input.isAutoRepeat) return;
      window!.webContents.toggleDevTools();
    });
    window.on("maximize", sendWindowState); window.on("unmaximize", sendWindowState); window.on("minimize", sendWindowState); window.on("restore", sendWindowState);
    window.on("enter-full-screen", sendWindowState); window.on("leave-full-screen", sendWindowState);
    window.webContents.on("did-finish-load", () => { userCssKey = undefined; appliedCss = undefined; sendWindowState(); if (userCssError) window!.webContents.send("delta:styles-error", userCssError); void applyUserCss().catch(error => console.error("User styles:", error.message)); });
    window.webContents.on("did-stop-loading", () => { void applyUserCss().catch(error => console.error("User styles:", error.message)); });
    window.on("close", event => { if (!quitting) { event.preventDefault(); if (applicationSettings.closeToTray && tray) window!.hide(); else void quit(); } });
    await window.loadFile(path.join(__dirname, "static/index.html"));
    await applyUserCss();
  }
  async function quit() {
    if (quitting || confirmingQuit) return;
    confirmingQuit = true;
    try {
      if (operations().length) {
        const result = await dialog.showMessageBox({ type: "question", buttons: ["Return to application", "Cancel tasks and quit"], defaultId: 0, cancelId: 0, message: "Backup or restore tasks are running.", detail: "Quitting cancels running operations. You can restart an interrupted backup." });
        if (result.response !== 1) return;
      }
    } finally { confirmingQuit = false; }
    quitting = true; schedulerWakeups.close(); userStyles.close(); updates.close(); trayPopup?.close(); nativeTheme.removeListener("updated", syncWindowBackground);
    desktopIntegration.close();
    let exitCode = 0;
    try {
      const failures: unknown[] = [];
      for (const close of [() => coordinator?.close(), () => service.shutdown(), () => snapshotProvider.shutdown()]) { try { await close(); } catch (error) { failures.push(error); } }
      if (failures.length) throw new AggregateError(failures, failures.map(error => error instanceof Error ? error.message : String(error)).join("; "));
    }
    catch (error) {
      exitCode = 1;
      await dialog.showMessageBox({ type: "error", message: "The application could not confirm that all operations finished safely.", detail: error instanceof Error ? error.message : String(error) });
    } finally { tray?.destroy(); app.exit(exitCode); }
  }
  function updateTray() {
    trayPopup?.update();
    if (!tray || tray.isDestroyed()) return;
    const tooltip = createTrayTooltip(trayTasks, operations());
    if (tooltip !== trayTooltip) { tray.setToolTip(tooltip); trayTooltip = tooltip; }
  }
  function createDesktopMenus() {
    if (options.smokeReport && !systemProbe) return;
    try {
      tray = new Tray(icon);
      const openTrayPopup = (bounds: Electron.Rectangle) => {
        const rectangle = bounds.width || bounds.height ? bounds : tray!.getBounds();
        const anchor = rectangle.width || rectangle.height ? rectangle : { ...screen.getCursorScreenPoint(), width: 1, height: 1 };
        void trayPopup?.show(anchor).catch(error => console.error("Tray popup:", error instanceof Error ? error.message : String(error)));
      };
      tray.on("click", (_event, bounds) => { if (process.platform === "linux") openTrayPopup(bounds); else void showWindow(); });
      tray.on("double-click", () => { void showWindow(); });
      tray.on("right-click", (_event, bounds) => openTrayPopup(bounds));
      updateTray();
      void refreshTrayTasks();
    }
    catch (error) { tray?.destroy(); tray = undefined; console.error("System tray:", error instanceof Error ? error.message : String(error)); }
    Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: "Delta Backupper", submenu: [{ label: "Open window", click: () => { void showWindow(); } }, { label: "About Delta Backupper", click: () => app.showAboutPanel() }, { type: "separator" }, { label: "Quit", click: () => { void quit(); } }] }, { label: "View", submenu: [{ label: "Actual Size", role: "resetZoom" }, { label: "Zoom In", role: "zoomIn" }, { label: "Zoom Out", role: "zoomOut" }, { label: "Toggle Full Screen", role: "togglefullscreen" }, { type: "separator" }, { label: "Reload", role: "reload" }, { label: "Developer Tools", role: "toggleDevTools" }] }]));
  }
  const uiFile = path.join(__dirname, "static/index.html");
  async function dispatch(request: ApiRequest, allowDialog = false) {
    if (request.action === "task-open-file" || request.action === "task-open-folder") {
      if (!allowDialog || quitting || !window || window.isDestroyed()) throw new Error("Task file shortcuts are available only in the application window");
      return openTaskLocation(service.store, request.reference, request.action === "task-open-file" ? "file" : "folder", options.smokeReport ? {
        async textFile(filename) { taskLocationOpens.push({ kind: "file", path: filename }); },
        async folder(directory) { taskLocationOpens.push({ kind: "folder", path: directory }); return ""; },
      } : { textFile: filename => openExternalTextFile(filename, original => shell.openPath(original)), folder: directory => shell.openPath(directory) });
    }
    if (["updates-status", "updates-check", "updates-open"].includes(request.action)) {
      if (!allowDialog || quitting) throw new Error("Update checking is available only in the application window");
      const settings = (await service.store.readApp()).value.updates;
      if (request.action === "updates-status") return updates.status(settings);
      if (request.action === "updates-check") return updates.check(settings);
      const current = updates.status(settings);
      if (current.status !== "available" || !current.release) throw new Error("Check for an available release before opening its page");
      // The checker constructs this URL from the configured repository and validated release tag.
      const expected = `https://github.com/${settings.repository}/releases/tag/${encodeURIComponent(current.release.tag)}`;
      if (current.release.url !== expected) throw new Error("The release address does not match the configured repository");
      await (updateQualification?.openExternal ?? ((url: string) => shell.openExternal(url)))(expected);
      return { opened: true };
    }
    if (request.action === "application-info") {
      if (!allowDialog) throw new Error("Application information is available only in the application window");
      return { name: "Delta Backupper", version: applicationMetadata.version, license: "MIT", platform: process.platform };
    }
    if (request.action === "scheduler-status") return { running: true, paused: applicationSettings.schedulerPaused, suspended: schedulerWakeups.suspended, stateError: schedulerPaused, tasks: Object.entries(scheduleState).map(([taskId, state]) => ({ taskId, ...state })) };
    if (request.action === "notification-test") {
      if (!allowDialog || !window || window.isDestroyed()) throw new Error("Notification tests are available only in the application window");
      return desktopIntegration.testNotification();
    }
    if (request.action === "window") {
      if (!allowDialog || !window || window.isDestroyed()) throw new Error("Window controls are available only in the application window");
      switch (request.command) {
        case "state": return windowState();
        case "sync-titlebar": await syncNativeTitlebar(); break;
        case "minimize": window.minimize(); break;
        case "toggle-maximize": if (window.isMaximized()) window.unmaximize(); else window.maximize(); break;
        case "close": window.close(); break;
        case "devtools": window.webContents.toggleDevTools(); break;
        default: throw new Error("Unknown window command");
      }
      return windowState();
    }
    if (request.action === "pick-directory") {
      if (!allowDialog || !window) throw new Error("Directory dialogs are available only in the application window");
      const result = await dialog.showOpenDialog(window, { title: "Select a folder", buttonLabel: "Select folder", properties: ["openDirectory", "createDirectory"] });
      return result.canceled ? null : result.filePaths[0] ?? null;
    }
    const result = await service.request(request);
    if (["create", "save", "discover", "forget", "relink", "duplicate"].includes(request.action)) { trayTaskRevision++; trayTasksAt = 0; void refreshTrayTasks(); }
    if (request.action === "app-save") {
      const previous = applicationSettings;
      applicationSettings = (await service.store.readApp()).value;
      syncWindowBackground();
      updateTray();
      void schedulerWakeups.check();
      if (app.isPackaged && !options.smokeReport && previous.launchAtLogin !== applicationSettings.launchAtLogin) {
        if (process.platform === "linux") await setLinuxAutostart(applicationSettings.launchAtLogin, process.execPath, configDirectory);
        else app.setLoginItemSettings({ openAtLogin: applicationSettings.launchAtLogin });
      }
    }
    return result;
  }
  ipcMain.handle("delta:request", async (event, request: ApiRequest) => {
    if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || !event.senderFrame.url.startsWith("file:")) throw new Error("Untrusted application request");
    return dispatch(request, true);
  });
  service.on("operation", (operation: Operation) => {
    if (window && !window.isDestroyed()) window.webContents.send("delta:operation", operation);
    updateTray();
    if (operation.status === "queued" && !trayTaskRefresh && Date.now() - trayTasksAt > 1000) void refreshTrayTasks();
    if (!["running", "queued"].includes(operation.status) && (!options.smokeReport || systemProbe)) void service.store.listTasks().then(tasks => desktopIntegration.handleOperation(operation, tasks.find(task => task.id === operation.taskId)?.name)).catch(error => console.error("System notification:", error instanceof Error ? error.message : String(error)));
  });
  const scheduleFile = path.join(await ensureRuntimeDirectory(configDirectory), "scheduler.json");
  let scheduleState: Record<string, TaskScheduleState> = {};
  let schedulerPaused = false;
  try {
    scheduleState = parseSchedulerState(JSON.parse(await readFile(scheduleFile, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      if ((error as NodeJS.ErrnoException).code === "SCHEDULER_VERSION") schedulerPaused = true;
      else { try { await rename(scheduleFile, `${scheduleFile}.corrupt-${randomUUID()}`); } catch { schedulerPaused = true; } }
      service.reportFailure("scheduler", "schedule-state", error);
    }
  }
  let ticking = false;
  async function tick() {
    if (ticking || quitting || schedulerPaused || applicationSettings.schedulerPaused || schedulerWakeups.suspended || options.smokeReport) return;
    ticking = true;
    try {
      const tasks = await service.store.listTasks();
      const online = new Set(tasks.filter(listing => listing.available && listing.task).map(listing => listing.id));
      for (const [id, state] of Object.entries(scheduleState)) if (!online.has(id)) for (const rule of Object.values(state.schedules)) rule.available = false;
      for (const listing of tasks) {
        if (quitting || applicationSettings.schedulerPaused || schedulerWakeups.suspended) break;
        if (operations().some(operation => operation.taskId === listing.id)) continue;
        const task = listing.task?.value;
        if (!listing.available || !task) continue;
        const next = advanceSchedule(task, scheduleState[listing.id], Date.now(), listing.available);
        scheduleState[listing.id] = next.state;
        if (next.due) {
          try {
            const operation = await service.request({ action: "run", reference: listing.id }) as Operation;
            void service.wait(operation.id).finally(() => { for (const rule of Object.values(scheduleState[listing.id]?.schedules ?? {})) rule.pending = false; });
          } catch (error) { for (const rule of Object.values(next.state.schedules)) rule.pending = false; service.reportFailure(listing.id, "scheduled-run", error); }
        }
      }
      const temporary = `${scheduleFile}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify({ schemaVersion: 2, tasks: scheduleState }));
      try { await rename(temporary, scheduleFile); } finally { await unlink(temporary).catch(() => {}); }
    } finally { ticking = false; }
  }
  const schedulerWakeups = new SchedulerWakeups({ power: powerMonitor, check: tick, report: error => console.error("Scheduler:", error instanceof Error ? error.message : String(error)) });
  createDesktopMenus();
  app.on("activate", () => { void showWindow(); });
  app.on("before-quit", event => { if (!quitting) { event.preventDefault(); void quit(); } });
  app.on("second-instance", () => { void showWindow(); });
  if (systemProbe && process.platform === "win32") await prepareNotificationIdentity();
  if (process.platform === "win32") Notification.handleActivation(() => { if (!quitting) void showWindow(); });
  coordinator = await startCoordinator(configDirectory, request => dispatch(request));
  await showWindow();
  await schedulerWakeups.check();
  if (!options.smokeReport && applicationSettings.updates.checkOnStartup && applicationSettings.updates.repository) {
    // An optional startup check updates the About status quietly; backup work and startup never wait for it.
    void updates.check(applicationSettings.updates).catch(error => console.error("Update check:", error instanceof Error ? error.message : String(error)));
  }
  if (options.smokeReport) {
    try {
      window!.webContents.setBackgroundThrottling(false);
      await window!.webContents.executeJavaScript("document.fonts.ready");
      await new Promise(resolve => setTimeout(resolve, 300));
      let customization: unknown;
      let systemIntegration: unknown;
      let branding: unknown;
      const themes = process.argv.includes("--delta-ui-themes") ? await (await import("./core/themes-probe.js")).qualifyThemes(window!, configDirectory) : undefined;
      const updateChecking = updateQualification ? await updateQualification.qualify(window!) : undefined;
      if (systemProbe) {
        const { qualifyTrayNotifications } = await import("./core/tray-notifications-probe.js");
        systemIntegration = await qualifyTrayNotifications(window!, configDirectory, { tray, integration: desktopIntegration, showWindow, dispatch, getTrayPopup: () => trayPopup, getTrayTooltip: () => trayTooltip, allowNativeNotifications: true });
      }
      if (process.argv.includes("--delta-ui-customization")) {
        const { qualifyUiCustomization } = await import("./core/ui-customization-probe.js");
        customization = await qualifyUiCustomization(window!, configDirectory);
      }
      if (process.argv.includes("--delta-ui-branding")) {
        const { qualifyUiBranding } = await import("./core/branding-probe.js");
        branding = await qualifyUiBranding(window!, configDirectory);
      }
      const scenarioPath = process.argv.find(argument => argument.startsWith("--delta-ui-scenario="))?.slice("--delta-ui-scenario=".length);
      let integration: unknown;
      let accessibility: unknown;
      if (scenarioPath) {
        const scenario = JSON.parse(await readFile(scenarioPath, "utf8")) as { taskId: string; sourceDirectory: string; additionalSourceDirectory: string; newTaskDestination: string; changedFile: string; changedContent: string; outputDirectory: string; updatedName: string };
        if (!scenario.taskId || !scenario.changedFile || !scenario.outputDirectory || !scenario.updatedName || typeof scenario.changedContent !== "string") throw new Error("Invalid isolated UI qualification scenario");
        window!.showInactive(); window!.focus(); window!.webContents.focus();
        await window!.webContents.executeJavaScript("new Promise((resolve,reject)=>{const deadline=Date.now()+5000;const check=()=>{if(document.hasFocus())resolve(true);else if(Date.now()>=deadline)reject(new Error('The isolated UI qualification window did not receive real native focus'));else setTimeout(check,35)};check()})");
        await writeFile(scenario.changedFile, scenario.changedContent);
        const exercise = async (parameters: { taskId: string; sourceDirectory: string; additionalSourceDirectory: string; newTaskDestination: string; updatedName: string; outputDirectory: string }) => {
          const bridge = (globalThis as unknown as { delta: { request(value: ApiRequest): Promise<any> } }).delta;
          const assertions: string[] = [];
          const assert = (value: unknown, message: string) => { if (!value) throw new Error(message); assertions.push(message); };
          const waitFor = async <T,>(predicate: () => T | Promise<T>): Promise<T> => {
            const end = Date.now() + 25_000;
            while (Date.now() < end) { const result = await predicate(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 35)); }
            throw new Error(`Timed out waiting for real UI operation: ${predicate.toString().slice(0, 350)}`);
          };
          const click = (label: string, scope: ParentNode = document) => {
            const candidate = [...scope.querySelectorAll("button")].find(element => element.textContent?.trim() === label) as HTMLButtonElement | undefined;
            if (!candidate || candidate.disabled) throw new Error(`UI button unavailable: ${label}`); candidate.click();
          };
          const modalHeaderActions = (submitLabel: string) => {
            const modal = document.getElementById("dialog")!, form = document.getElementById("dialog-form") as HTMLFormElement, header = modal.querySelector<HTMLElement>(".dialog-header"), actions = header?.querySelector(".dialog-actions"), submit = actions?.querySelector<HTMLButtonElement>("button[type=submit]"), cancel = [...actions?.querySelectorAll<HTMLButtonElement>("button") ?? []].find(button => button.textContent === "Cancel");
            assert(Boolean(form && header && submit && cancel && submit.form === form && submit.getAttribute("form") === form.id && submit.textContent === submitLabel && cancel.type === "button" && !form.contains(submit) && !form.contains(cancel) && !form.querySelector(".form-actions") && modal.querySelectorAll("button[type=submit]").length === 1), `${submitLabel} and Cancel are in the modal header with one native form-associated confirmation control`);
          };
          const input = (label: string, scope: ParentNode = document) => {
            const wrapper = [...scope.querySelectorAll("label")].find(element => element.querySelector(".field-label")?.textContent === label);
            const element = wrapper?.querySelector("input") as HTMLInputElement | undefined;
            if (!element) throw new Error(`UI field unavailable: ${label}`); return element;
          };
          const fill = (element: HTMLInputElement, value: string) => { element.value = value; element.dispatchEvent(new Event("input", { bubbles: true })); };
          const portable = (value: string) => value.replaceAll("\\", "/");
          const select = (label: string, scope: ParentNode = document) => {
            const wrapper = [...scope.querySelectorAll("label")].find(element => element.querySelector(".field-label")?.textContent === label);
            const element = wrapper?.querySelector("select") as HTMLSelectElement | undefined;
            if (!element) throw new Error(`UI choice unavailable: ${label}`); return element;
          };
          const choose = (element: HTMLSelectElement, value: string) => { element.value = value; element.dispatchEvent(new Event("change", { bubbles: true })); };
          const fieldPalette = (element: HTMLElement, state: "warning" | "error" | "focus") => {
            const probe = document.createElement("span"); probe.style.color = `var(--${state})`; probe.style.backgroundColor = `var(--${state === "focus" ? "input-focus-bg" : `${state}-soft`})`; document.body.append(probe);
            const palette = getComputedStyle(probe), border = palette.color, background = palette.backgroundColor; probe.remove();
            const style = getComputedStyle(element); return style.borderTopColor === border && style.backgroundColor === background;
          };
          const changeMarked = (element: HTMLElement) => element.dataset.changeImpact === "unsafe";
          const focusedPalette = (element: HTMLElement, state: "warning" | "error" | "focus") => { element.focus(); return document.hasFocus() && document.activeElement === element && element.matches(":focus") && fieldPalette(element, state); };
          const settingsCoverage = (scope: ParentNode) => [...scope.querySelectorAll("label")].filter(label => !["Name", "Existing destination folder"].includes(label.querySelector(".field-label")?.textContent ?? "")).map(label => {
            const editor = label.querySelector("input,select,textarea") as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null;
            return editor ? { label: label.querySelector(".field-label")?.textContent, editor: editor.tagName, type: editor instanceof HTMLInputElement ? editor.type : null, options: editor instanceof HTMLSelectElement ? [...editor.options].map(option => [option.value, option.textContent]) : null } : null;
          }).filter(Boolean);
          const sharedSettingsLayout = (form: HTMLElement, page: string) => {
            const cards = [...form.children].filter(element => element.classList.contains("card") && element.querySelector("h2")?.textContent !== "Task");
            const filePaths = cards[0], working = input("Working directory", form), paths = select("Paths in ZIP archives", form), workingLabel = working.closest("label")!, level = input("Compression level (0–9)", form);
            assert(filePaths?.querySelector("h2")?.textContent === "File paths" && filePaths.contains(working) && filePaths.contains(paths) && workingLabel.querySelector(".field-hint")?.textContent?.includes("Relative source paths") && !working.closest(".card")?.querySelector(".source-list"), `${page} presents the shared File paths card first and keeps relative-path guidance with Working directory rather than Sources`);
            assert(![...form.querySelectorAll("label")].some(label => label.querySelector(".field-label")?.textContent === "Compression") && level.type === "number" && level.min === "0" && level.max === "9" && !level.disabled, `${page} exposes one enabled compression-level editor from 0 to 9 without a separate compression-method choice`);
          };
          const editorValues = (scope: ParentNode) => [...scope.querySelectorAll("label")].filter(label => !["Name", "Existing destination folder"].includes(label.querySelector(".field-label")?.textContent ?? "")).map(label => {
            const editor = label.querySelector("input,select,textarea") as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null;
            return editor ? { label: label.querySelector(".field-label")?.textContent, value: editor instanceof HTMLInputElement && editor.type === "checkbox" ? editor.checked : editor.value } : null;
          }).filter(Boolean);
          const addSource = (value: string, scope: ParentNode = document) => { scope.querySelector<HTMLButtonElement>(".source-add")!.click(); const element = scope.querySelector<HTMLInputElement>('.source-list .source-row[data-empty="true"] .source-path'); if (!element) throw new Error("Add source did not expose an editable row"); fill(element, value); };
          const addSourceFilter = (source: HTMLElement, kind: "include" | "exclude", pattern: string) => {
            source.querySelector<HTMLButtonElement>(".source-filter-add")!.click();
            const row = source.querySelector<HTMLElement>('.source-filter-row[data-empty="true"]');
            if (!row) throw new Error("Add filter did not expose an editable row");
            if (row.dataset.kind !== kind) row.querySelector<HTMLButtonElement>(".source-filter-kind")!.click();
            fill(row.querySelector<HTMLInputElement>(".source-filter-pattern")!, pattern);
          };
          const terminal = async (action: string): Promise<Operation> => (await waitFor(async () => {
            const operations = await bridge.request({ action: "operations" }) as Operation[];
            return [...operations].reverse().find(operation => operation.action === action && !["queued", "running"].includes(operation.status));
          }))!;
          await waitFor(() => document.querySelector(".task-item"));
          await waitFor(() => document.getElementById("main")?.dataset.view === "home" && document.querySelector("#home-recent tr[data-run-id]"));
          assert(true, "Home is the initial page and shows a backup saved before this GUI process started");
          const homeSelectedBackground = getComputedStyle(document.getElementById("home")!).backgroundColor;
          assert(!document.querySelector('#main > .page-header') && !document.getElementById("home-refresh"), "Home renders its summary directly without a page header or duplicate actions");
          document.querySelector<HTMLButtonElement>(".task-item")!.click(); await waitFor(() => document.getElementById("task-tab-overview"));
          assert(getComputedStyle(document.querySelector(".task-item.selected")!).backgroundColor === homeSelectedBackground, "active Home and active task use the same selection background");
          assert(typeof (globalThis as unknown as { require?: unknown }).require === "undefined", "renderer has no Node integration");
          assert(typeof bridge?.request === "function", "sandbox preload exposes typed operation bridge");
          click("Settings"); await waitFor(() => document.querySelector("#main form"));
          const taskSave = document.getElementById("task-save") as HTMLButtonElement;
          assert(taskSave?.form === document.getElementById("task-settings-form") && taskSave.getAttribute("form") === "task-settings-form" && document.querySelector("#main > .page-header .toolbar")?.contains(taskSave) && !document.getElementById("page-content")!.contains(taskSave) && document.querySelectorAll('#main button[type="submit"]').length === 1 && document.querySelectorAll('#main > .page-header .toolbar button').length === 1 && !document.getElementById("task-open-folder") && !document.getElementById("task-run") && !document.getElementById("task-pause"), "saved-task Settings has only its single form-associated Save settings action in the fixed header instead of Overview's folder and backup controls");
          assert(document.body.textContent?.includes("Cleanup timing") && document.body.textContent?.includes("Source snapshots") && document.body.textContent?.includes("Compression level (0–9)"), "task form exposes retention, ZIP and source snapshot settings");
          const savedSettingsCoverage = settingsCoverage(document.querySelector("#main form")!), savedWorkingDirectory = input("Working directory"), savedMode = select("Paths in ZIP archives"), savedDetection = select("Change detection");
          sharedSettingsLayout(document.querySelector<HTMLElement>("#main form")!, "Saved-task Settings");
          assert(!savedWorkingDirectory.readOnly && !savedWorkingDirectory.disabled && !savedMode.disabled && !savedDetection.disabled && savedWorkingDirectory.parentElement!.querySelector(".path-browse-button")?.getAttribute("aria-label") === "Choose working directory", "saved tasks keep working directory, archive paths and change detection editable with the working-directory picker");
          const originalMode = savedMode.value, originalWorkingDirectory = savedWorkingDirectory.value, originalDetection = savedDetection.value;
          const savedName = input("Name"), savedCompression = input("Compression level (0–9)");
          for (const editor of [savedWorkingDirectory, savedMode, savedDetection]) assert(editor.dataset.changeRisk === "unsafe" && !changeMarked(editor) && focusedPalette(editor, "warning") && editor.title.startsWith("Unsafe change:") && editor.getAttribute("aria-description") === editor.title, `focusing an unchanged ${editor.dataset.taskSetting} editor immediately uses the unsafe border and background and explains the risk before any edit: ${JSON.stringify({ risk: editor.dataset.changeRisk, dirty: editor.dataset.changeImpact, focused: document.activeElement === editor, title: editor.title, description: editor.getAttribute("aria-description"), border: getComputedStyle(editor).borderTopColor, background: getComputedStyle(editor).backgroundColor })}`);
          assert(focusedPalette(savedName, "focus") && !savedName.hasAttribute("data-change-risk") && !fieldPalette(savedMode, "warning") && !fieldPalette(savedWorkingDirectory, "warning") && !fieldPalette(savedDetection, "warning"), "leaving unchanged structural fields restores their normal colors while Name keeps the ordinary accent focus palette");
          assert(focusedPalette(savedCompression, "focus") && !savedCompression.hasAttribute("data-change-risk"), "compression level remains a routine setting with the ordinary accent focus palette");
          choose(savedMode, originalMode === "0" ? "1" : "0");
          assert(changeMarked(savedMode) && fieldPalette(savedMode, "warning") && focusedPalette(savedMode, "warning") && savedMode.title.startsWith("Unsafe change:") && Boolean(savedMode.getAttribute("aria-description")) && !document.getElementById("task-change-warning") && !document.querySelector('#task-settings-form > .notice.warning') && !taskSave.disabled, "changing ZIP path structure colors only its editor border and background with the unsafe palette, keeps those colors on focus and exposes the impact accessibly without a banner or blocking Save");
          savedName.focus(); assert(fieldPalette(savedMode, "warning"), "an actual unsafe ZIP-path edit keeps both warning colors after focus leaves the editor");
          savedMode.focus(); choose(savedMode, originalMode); assert(!changeMarked(savedMode) && fieldPalette(savedMode, "warning") && savedMode.dataset.changeRisk === "unsafe", "reverting ZIP paths removes the dirty marker while its focused editor still shows the potential unsafe-change palette");
          savedName.focus(); assert(!fieldPalette(savedMode, "warning"), "leaving a reverted ZIP-path editor restores its normal border and background");
          fill(savedWorkingDirectory, originalWorkingDirectory === parameters.additionalSourceDirectory ? parameters.sourceDirectory : parameters.additionalSourceDirectory);
          assert(changeMarked(savedWorkingDirectory) && fieldPalette(savedWorkingDirectory, "warning") && focusedPalette(savedWorkingDirectory, "warning") && !savedWorkingDirectory.readOnly, "working-directory changes color their editable path border and background consistently, including on focus");
          fill(savedWorkingDirectory, originalWorkingDirectory); choose(savedDetection, originalDetection === "hash" ? "fast" : "hash");
          assert(changeMarked(savedDetection) && fieldPalette(savedDetection, "warning") && focusedPalette(savedDetection, "warning") && !savedDetection.disabled, "change-detection changes use the warning border and background without blocking the selection");
          choose(savedDetection, originalDetection); assert(!document.querySelector('#task-settings-form [data-change-impact="unsafe"]'), "restoring all original structural settings clears every field change marker");
          const keepCycles = input("Keep cycles (0 = unlimited)"), originalKeepCycles = keepCycles.value;
          fill(keepCycles, "2.5");
          assert(changeMarked(keepCycles) && fieldPalette(keepCycles, "warning"), "a tighter retention limit marks its number editor as an unsafe change");
          taskSave.click(); await waitFor(() => keepCycles.getAttribute("aria-invalid") === "true");
          assert(changeMarked(keepCycles) && fieldPalette(keepCycles, "error") && focusedPalette(keepCycles, "error") && !taskSave.disabled, "the real validation notification overrides an unsafe retention editor with both error colors while retaining its change marker and editable Save action");
          fill(keepCycles, originalKeepCycles);
          input("Name").value = parameters.updatedName;
          addSource(parameters.additionalSourceDirectory);
          assert(document.querySelectorAll('#task-sources .source-row[data-empty="false"]').length === 2 && !document.querySelector('#task-sources .source-row[data-empty="true"]') && !document.getElementById("task-sources")!.contains(document.getElementById("task-sources-add-source")), "adding a source keeps only filled rows and a separate Add source control");
          const changedSource = document.querySelector<HTMLInputElement>('#task-sources .source-row:last-child .source-path')!;
          assert(changeMarked(changedSource) && fieldPalette(changedSource, "warning") && focusedPalette(changedSource, "warning") && !changeMarked(document.querySelector<HTMLInputElement>('#task-sources .source-path')!) && [...document.querySelectorAll<HTMLInputElement>('#task-sources .source-path')].every(editor => !editor.disabled && !editor.readOnly), "a newly added source shows the unsafe border and background while the unchanged source keeps its normal appearance and both remain editable");
          const sourceRows = [...document.querySelectorAll<HTMLElement>('#task-sources .source-row[data-empty="false"]')];
          assert(!document.querySelector("dialog[open]") && sourceRows.every(source => source.querySelector<HTMLElement>(".source-filters")!.hidden && !source.querySelector<HTMLElement>(".source-filter-add")!.hidden && !source.querySelector(".source-filter-row")), "unfiltered sources show Add filter without empty pattern rows");
          addSourceFilter(sourceRows[0]!, "include", "qualification-remove.tmp");
          sourceRows[0]!.querySelector<HTMLButtonElement>('.source-filter-row[data-empty="false"] .source-filter-remove')!.click();
          assert(!sourceRows[0]!.querySelector(".source-filter-row") && sourceRows[0]!.querySelector<HTMLElement>(".source-filters")!.hidden, "filter X removes its line without leaving an empty filter row");
          for (let index = 0; index < sourceRows.length; index++) {
            const source = sourceRows[index]!;
            if (index === 1) addSourceFilter(source, "include", "*.txt");
            addSourceFilter(source, "exclude", index === 0 ? "*.tmp" : "omit-second.txt");
            const filters = [...source.querySelectorAll<HTMLElement>(".source-filter-row")], path = source.querySelector<HTMLInputElement>(".source-path")!.getBoundingClientRect();
            assert(filters.length === index + 1 && filters.every(row => row.dataset.empty === "false" && !row.querySelector<HTMLButtonElement>(".source-filter-remove")!.hidden) && !source.querySelector<HTMLElement>(".source-filters")!.hidden, "editing inline filters keeps only requested filled lines with removal controls");
            assert(filters.every(row => { const bounds = row.getBoundingClientRect(); return bounds.top >= path.bottom && Math.abs(bounds.left - path.left) < 1; }), "inline filter rows align with their source path without indentation");
            if (index === 0) assert(filters.every(row => { const editor = row.querySelector<HTMLInputElement>(".source-filter-pattern")!; return changeMarked(editor) && fieldPalette(editor, "warning"); }) && changeMarked(changedSource), "existing-source filter changes and a newly added source show their independent unsafe states together");
          }
          const beforeSave = (await bridge.request({ action: "load", reference: parameters.taskId })).value;
          assert(beforeSave.sources.length === 1 && beforeSave.sources[0].filters.include.length === 0 && beforeSave.sources[0].filters.exclude.length === 0, "inline source and filter edits remain in the form until Save");
          const sequence = document.querySelector<HTMLInputElement>("#backup-sequence")!;
          assert(sequence.value === "F" && document.querySelectorAll("#task-schedules .schedule-editor").length === 0, "new tasks start without schedules and with the F sequence");
          for (const invalid of ["IFI", "", "FIX"]) { fill(sequence, invalid); const notification = document.getElementById("notification")!; assert(sequence.getAttribute("aria-invalid") === "true" && sequence.getAttribute("aria-errormessage") === notification.id && fieldPalette(sequence, "error") && focusedPalette(sequence, "error") && !notification.hidden && notification.getAttribute("role") === "alert" && notification.dataset.error === "true" && !document.getElementById("sequence-error"), `${invalid} shows an accessible notification and uses the error border and background even on focus without a duplicate inline error`); }
          for (const valid of ["ffi", "fiifii", "fii"]) { fill(sequence, valid); assert(sequence.value === valid.toUpperCase() && !sequence.hasAttribute("aria-invalid") && !sequence.hasAttribute("aria-errormessage") && document.getElementById("notification")!.hidden, `${valid.toUpperCase()} is accepted and clears its notification and editor error together`); }
          document.getElementById("add-schedule")!.click();
          await waitFor(() => !document.getElementById("add-schedule")!.hasAttribute("disabled"));
          document.getElementById("add-schedule")!.click();
          const rules = [...document.querySelectorAll<HTMLElement>("#task-schedules .schedule-editor")];
          assert(rules.length === 2 && new Set(rules.map(rule => rule.dataset.scheduleId)).size === 2, "two schedules have separate editable rows");
          for (let index = 0; index < rules.length; index++) { fill(rules[index]!.querySelector<HTMLInputElement>(".schedule-name")!, `Rule ${index + 1}`); input("Paused", rules[index]!).checked = true; }
          const main = document.getElementById("main")!, content = document.getElementById("page-content")!; const titlebar = document.getElementById("titlebar") ?? document.querySelector(".titlebar")!;
          const header = main.querySelector<HTMLElement>(":scope > .page-header")!, tabs = main.querySelector<HTMLElement>(":scope > .tabs")!, headerTop = header.getBoundingClientRect().top, tabsTop = tabs.getBoundingClientRect().top;
          content.scrollTop = content.scrollHeight; const barRect = titlebar.getBoundingClientRect();
          assert(content.scrollTop > 0 && document.documentElement.scrollHeight === document.documentElement.clientHeight && barRect.top === 0 && main.getBoundingClientRect().top >= barRect.bottom && !content.contains(header) && !content.contains(tabs) && header.getBoundingClientRect().top === headerTop && tabs.getBoundingClientRect().top === tabsTop, "content scrolls while titlebar, page header and tabs remain outside the scroll container"); content.scrollTop = 0;
          click("Save settings", header);
          await waitFor(async () => { const loaded = await bridge.request({ action: "load", reference: parameters.taskId }); return loaded.value.name === parameters.updatedName && document.querySelector("h1")?.textContent === parameters.updatedName; });
          assert(true, "task form saves through the real configuration service");
          const saved = (await bridge.request({ action: "load", reference: parameters.taskId })).value;
          assert(saved.sources.length === 2 && portable(saved.sources[0].path) === portable(parameters.sourceDirectory) && portable(saved.sources[1].path) === portable(parameters.additionalSourceDirectory), "multiple source paths persist without technical identities in configuration");
          assert(saved.sources.every((source: object) => !Object.hasOwn(source, "label") && !Object.hasOwn(source, "id")) && !document.querySelector('#task-sources .source-name'), "sources contain only paths and filters without names or technical IDs");
          assert(!Object.hasOwn(saved, "filters") && !Object.hasOwn(saved, "encryption") && saved.sources[0].filters.exclude[0] === "*.tmp" && saved.sources[1].filters.include[0] === "*.txt" && saved.sources[1].filters.exclude[0] === "omit-second.txt", "source filters persist independently without task-level filters or encryption");
          assert(saved.sequence.types.join(",") === "full,incremental,incremental" && saved.schedules.length === 2 && saved.schedules[1].name === "Rule 2", "FII and two independent schedules persist in the task file");
          for (const [tab, key] of [["Settings", "settings"], ["History", "history"], ["Restore", "files"], ["Activity", "activity"], ["Manage", "manage"]] as const) {
            click(tab); await waitFor(() => document.getElementById(`task-tab-${key}`)?.getAttribute("aria-selected") === "true" && !document.getElementById("main")?.hasAttribute("aria-busy"));
            assert(!document.getElementById("task-run") && !document.getElementById("task-pause") && !document.getElementById("task-open-folder") && document.querySelectorAll('#main > .page-header .toolbar button').length === (key === "settings" ? 1 : 0) && (key !== "settings" || document.querySelector('#main > .page-header .toolbar button')?.id === "task-save"), `${tab} omits Overview's folder and backup controls${key === "settings" ? " and keeps only Save settings in its header" : " and has no unrelated header actions"}`);
          }
          click("Overview"); await waitFor(() => document.getElementById("task-run"));
          assert(document.querySelector("#main > .page-header .toolbar")?.contains(document.getElementById("task-run")) && document.querySelector("#main > .page-header .toolbar")?.contains(document.getElementById("task-open-folder")) && !document.getElementById("task-save"), "Overview provides Open backup folder and Run backup in the header and no Settings Save control");
          click("Open backup folder"); await waitFor(() => !document.getElementById("task-open-folder")!.hasAttribute("disabled"));
          assert(true, "Overview's backup folder shortcut completes through the actual renderer and IPC");
          click("Run backup"); const backup = await terminal("run"); assert(backup.status === "complete", `utilityProcess backup completes: ${backup.status}`);
          const runId = (backup.result as { id: string }).id;
          const archivedFiles = await bridge.request({ action: "files", reference: parameters.taskId, runId, limit: 200 });
          const archivedNames = archivedFiles.entries.map((entry: { path: string }) => entry.path);
          assert(archivedNames.includes("unchanged.txt") && archivedNames.includes("second.txt") && !archivedNames.includes("omit-first.tmp") && !archivedNames.includes("omit-second.txt") && archivedFiles.entries.every((entry: object) => !Object.hasOwn(entry, "sourceId")), "backup stores direct file paths from both filtered sources without source IDs");
          click("History"); await waitFor(() => document.querySelector("tbody tr"));
          assert(Boolean(document.querySelector("tbody tr .badge")), "history renders real committed backup status");
          click("Verify", document.querySelector("tbody tr")!); const verified = await terminal("verify"); assert(verified.status === "complete", "verification completes through renderer IPC and utilityProcess");
          click("Restore"); await waitFor(() => document.querySelector("#main .filter-bar"));
          await waitFor(() => [...document.querySelectorAll("button")].some(element => element.textContent === "Restore entire backup…"));
          click("Restore entire backup…"); await waitFor(() => document.querySelector("dialog[open]"));
          modalHeaderActions("Restore");
          input("Output directory", document.querySelector("dialog")!).value = parameters.outputDirectory;
          click("Restore", document.querySelector("dialog")!); const restored = await terminal("restore"); assert(restored.status === "complete", "restore dialog completes through the real worker");
          assert((restored.result as { runId: string }).runId === runId, "restore defaults to the latest committed history point");
          await waitFor(() => !document.querySelector("dialog[open]"));
          await new Promise(resolve => setTimeout(resolve, 150));
          click("History"); await waitFor(() => document.querySelector(`tr[data-run-id="${runId}"] button[data-remove-run]`));
          document.querySelector<HTMLButtonElement>(`tr[data-run-id="${runId}"] button[data-remove-run]`)!.click(); await waitFor(() => document.querySelector("dialog[open]"));
          modalHeaderActions("Remove backup");
          assert(document.querySelector("dialog")!.textContent!.includes("another retained restore point depends"), "snapshot removal requires confirmation and explains dependency protection");
          click("Remove backup", document.querySelector("dialog")!); const removed = await terminal("delete");
          assert(removed.status === "complete", "Remove deletes the selected independent snapshot through the actual UI and worker");
          const remainingRuns = await bridge.request({ action: "history", reference: parameters.taskId });
          assert(!remainingRuns.some((run: { id: string }) => run.id === runId) && remainingRuns.length > 0, "removal keeps the earlier base snapshot and removes only the chosen restore point");
          click("Overview"); await waitFor(() => document.querySelector("h1")?.textContent === parameters.updatedName && document.querySelector(".card-grid"));
          assert(document.getElementById("main")!.innerText.includes("FII"), "overview shows the compact backup sequence");
          click("Task defaults"); await waitFor(() => document.getElementById("main")?.dataset.view === "task-defaults" && document.querySelector("#main form"));
          const defaultsForm = document.querySelector<HTMLElement>("#main form")!;
          sharedSettingsLayout(defaultsForm, "Task defaults");
          assert(!defaultsForm.querySelector('[data-change-impact="unsafe"],[data-change-risk="unsafe"]') && !defaultsForm.querySelector('.notice.warning') && focusedPalette(input("Working directory", defaultsForm), "focus"), "Task defaults show no saved-task change warnings and use the routine focus palette");
          assert(JSON.stringify(settingsCoverage(defaultsForm)) === JSON.stringify(savedSettingsCoverage) && !defaultsForm.querySelector(".source-list") && ![...defaultsForm.querySelectorAll(".field-label")].some(label => ["Name", "Existing destination folder"].includes(label.textContent ?? "")), "Task defaults expose all shared task settings in the same order and with identical control choices, while omitting task identity, destination and sources");
          document.getElementById("new-task")!.click(); await waitFor(() => document.getElementById("draft-form"));
          assert(!document.querySelector("dialog[open]") && document.activeElement === document.getElementById("draft-task-name"), "New task opens the draft editor directly with focus on its name");
          const draft = document.getElementById("draft-form")!, destination = draft.querySelector<HTMLInputElement>("#new-task-destination")!;
          assert(JSON.stringify(settingsCoverage(draft)) === JSON.stringify(savedSettingsCoverage), "new drafts and saved-task Settings expose the same settings controls and choices, including working directory and ZIP paths");
          sharedSettingsLayout(draft, "New-task draft");
          const draftWorkingDirectory = input("Working directory", draft), draftMode = select("Paths in ZIP archives", draft), draftDetection = select("Change detection", draft);
          assert(!draftWorkingDirectory.readOnly && !draftWorkingDirectory.disabled && !draftMode.disabled && draftWorkingDirectory.parentElement!.querySelector(".path-browse-button")?.getAttribute("aria-label") === "Choose working directory", "new drafts expose the editable working-directory field with the shared inline picker and archive path choices");
          fill(draftWorkingDirectory, parameters.sourceDirectory); choose(draftMode, "1"); choose(draftDetection, "hash"); fill(input("Compression level (0–9)", draft), "0");
          assert(!draft.querySelector('[data-change-impact="unsafe"],[data-change-risk="unsafe"]') && !draft.querySelector('.notice.warning') && focusedPalette(draftWorkingDirectory, "focus"), "editing a new draft does not show saved-task change warnings and keeps the routine focus palette");
          fill(document.getElementById("draft-task-name") as HTMLInputElement, "Multi-source UI task");
          assert((await bridge.request({ action: "bootstrap" })).tasks.length === 1, "opening and naming a draft writes no task or registry entry");
          assert(Boolean(destination.compareDocumentPosition(draft.querySelector("#new-task-sources")!) & Node.DOCUMENT_POSITION_FOLLOWING), "the task editor places destination before sources");
          assert(!draft.querySelector(".source-row"), "the new task draft starts without an empty source row");
          draft.querySelector<HTMLButtonElement>(".source-add")!.click();
          const destinationIcon = destination.parentElement!.querySelector("svg path")!.getAttribute("d");
          assert(destinationIcon === draft.querySelector('#new-task-sources .source-browse svg path')?.getAttribute("d"), "destination and a requested blank source use the same arrow picker");
          assert(draft.querySelector('.source-row[data-empty="true"] .source-remove')?.getAttribute("aria-label") === "Cancel source" && !draft.querySelector('.source-row[data-empty="true"] .source-name'), "a requested blank source has a named cancellation control without an artificial source name");
          fill(destination, parameters.newTaskDestination); addSource(parameters.sourceDirectory, draft); addSource(parameters.additionalSourceDirectory, draft);
          draft.querySelector<HTMLButtonElement>(".source-remove")!.click();
          assert(draft.querySelectorAll('.source-row[data-empty="false"]').length === 1 && !draft.querySelector('.source-row[data-empty="true"]'), "source X removes its row without leaving an empty picker row");
          addSource(parameters.sourceDirectory, draft);
          const draftSources = [...draft.querySelectorAll<HTMLElement>('.source-row[data-empty="false"]')];
          addSourceFilter(draftSources[0]!, "exclude", "draft-only.tmp"); addSourceFilter(draftSources[1]!, "include", "*.txt");
          assert((await bridge.request({ action: "bootstrap" })).tasks.length === 1, "draft source filters remain local to the form until Create");
          fill(destination, `${parameters.newTaskDestination}/missing-destination`);
          const draftContent = document.getElementById("page-content")!; draftContent.scrollTop = draftContent.scrollHeight;
          document.getElementById("draft-create")!.click(); await waitFor(() => destination.getAttribute("aria-invalid") === "true" && document.getElementById("notification")?.dataset.error === "true");
          const notification = document.getElementById("notification")!, errorShownAt = Date.now(), editorBounds = destination.getBoundingClientRect(), contentBounds = draftContent.getBoundingClientRect(), errorStyle = getComputedStyle(destination), errorBorder = errorStyle.borderTopColor, errorBackground = errorStyle.backgroundColor;
          assert(notification.textContent === "The destination folder is unavailable. Choose an existing folder or reconnect its drive." && !notification.hidden && notification.getAttribute("role") === "alert" && destination.getAttribute("aria-errormessage") === notification.id && fieldPalette(destination, "error") && focusedPalette(destination, "error") && !document.getElementById("draft-error") && !draft.querySelector(".notice.error") && editorBounds.top >= contentBounds.top && editorBounds.bottom <= contentBounds.bottom, "a failed Create shows one accessible notification and matching error border and background, retains both colors on focus and scrolls that editor into view");
          assert(document.getElementById("draft-task-name") instanceof HTMLInputElement && (document.getElementById("draft-task-name") as HTMLInputElement).value === "Multi-source UI task" && draft.querySelectorAll('.source-row[data-empty="false"]').length === 2 && (await bridge.request({ action: "bootstrap" })).tasks.length === 1, "an unavailable destination retains the draft name, sources and filters without creating a task");
          await waitFor(() => notification.hidden);
          assert(Date.now() - errorShownAt >= 13_000 && !destination.hasAttribute("aria-invalid") && !destination.hasAttribute("aria-errormessage") && getComputedStyle(destination).borderTopColor !== errorBorder && getComputedStyle(destination).backgroundColor !== errorBackground, "the actual notification timeout removes its message and restores both editor border and background together after fourteen seconds");
          await waitFor(() => !(document.getElementById("draft-create") as HTMLButtonElement).disabled); fill(destination, parameters.newTaskDestination);
          document.getElementById("draft-create")!.click(); await waitFor(() => document.getElementById("main")?.dataset.view === "task" && document.querySelector("h1")?.textContent === "Multi-source UI task");
          assert(document.getElementById("task-tab-overview")?.getAttribute("aria-selected") === "true" && !document.getElementById("main")!.querySelector("form"), "creating a task opens its Overview");
          const registry = await bridge.request({ action: "bootstrap" }); const created = registry.tasks.find((item: any) => item.name === "Multi-source UI task");
          assert(created?.task?.value.sources.length === 2 && created.task.value.sources[0].filters.exclude[0] === "draft-only.tmp" && created.task.value.sources[1].filters.include[0] === "*.txt", "Create saves multiple sources and their independent inline filters from the draft form");
          assert(created.task.value.mode === 1 && portable(created.task.value.wdir) === portable(parameters.sourceDirectory) && created.task.value.detection === "hash", "Create persists the draft's working directory, ZIP path mode and change detection through the real configuration service");
          assert(created.task.value.archive.level === 0 && !Object.hasOwn(created.task.value.archive, "compression"), "Create persists level 0 as the single no-compression setting without a second method key");
          const tuplePattern = "**", tupleExclusion = "temporary-[0-9]+\\.tmp", tupleSources = created.task.value.srcs.map((entry: unknown, index: number) => index === 0 ? [created.task.value.sources[0].path, tuplePattern, tupleExclusion] : entry);
          await bridge.request({ action: "save", reference: created.id, revision: created.task.revision, patch: { srcs: tupleSources } });
          click("Settings"); await waitFor(() => document.querySelector("#main form"));
          assert(portable(input("Working directory").value) === portable(parameters.sourceDirectory) && select("Paths in ZIP archives").value === "1" && select("Change detection").value === "hash", "opening Settings reloads the archive path, working directory and detection chosen in the draft");
          const retargetedSource = "../second-source"; fill(document.querySelector<HTMLInputElement>('#task-sources .source-row[data-empty="false"] .source-path')!, retargetedSource);
          click("Save settings", document.querySelector("#main > .page-header")!);
          const retargeted = await waitFor(async () => { const task = await bridge.request({ action: "load", reference: created.id }); return Array.isArray(task.value.srcs[0]) && task.value.srcs[0][0] === retargetedSource && document.querySelector<HTMLInputElement>('#task-sources .source-row[data-empty="false"] .source-path')?.value === retargetedSource ? task : null; });
          assert(retargeted.value.srcs[0][1] === tuplePattern && retargeted.value.srcs[0][2] === tupleExclusion && retargeted.value.sources[0].filters.exclude[0] === "draft-only.tmp", "retargeting a source in Settings preserves its original glob and regular-expression tuple as well as its GUI filters");
          const copiedSettings = editorValues(document.querySelector("#main form")!), copiedSources = [...document.querySelectorAll('#task-sources .source-row[data-empty="false"]')].map(row => ({ path: row.querySelector<HTMLInputElement>(".source-path")!.value, filters: [...row.querySelectorAll<HTMLElement>('.source-filter-row[data-empty="false"]')].map(filter => ({ kind: filter.dataset.kind, pattern: filter.querySelector<HTMLInputElement>(".source-filter-pattern")!.value })) }));
          click("Manage"); await waitFor(() => document.getElementById("task-retention")); click("Duplicate"); await waitFor(() => document.getElementById("main")?.dataset.view === "draft" && document.getElementById("draft-form"));
          const copyDraft = document.getElementById("draft-form")!, copySources = [...copyDraft.querySelectorAll('.source-row[data-empty="false"]')].map(row => ({ path: row.querySelector<HTMLInputElement>(".source-path")!.value, filters: [...row.querySelectorAll<HTMLElement>('.source-filter-row[data-empty="false"]')].map(filter => ({ kind: filter.dataset.kind, pattern: filter.querySelector<HTMLInputElement>(".source-filter-pattern")!.value })) }));
          assert(!document.querySelector("dialog[open]") && document.activeElement === document.getElementById("draft-task-name") && input("Name", copyDraft).value === "Multi-source UI task (copy)" && input("Existing destination folder", copyDraft).value === "", "Duplicate opens the main draft editor with a copied name, focused name editor and blank destination");
          assert(JSON.stringify(editorValues(copyDraft)) === JSON.stringify(copiedSettings) && JSON.stringify(copySources) === JSON.stringify(copiedSources) && (await bridge.request({ action: "bootstrap" })).tasks.length === registry.tasks.length, "Duplicate prefills every editable setting, source and filter without creating a task");
          fill(input("Name", copyDraft), "Discarded duplicate draft"); document.getElementById("draft-cancel")!.click(); await waitFor(() => document.getElementById("main")?.dataset.view === "home");
          assert((await bridge.request({ action: "bootstrap" })).tasks.length === registry.tasks.length && !(await bridge.request({ action: "bootstrap" })).tasks.some((item: any) => item.name === "Discarded duplicate draft"), "cancelling an edited duplicate returns Home without persisting the copy");
          await bridge.request({ action: "forget", reference: created.id });
          [...document.querySelectorAll<HTMLButtonElement>(".task-item")].find(item => item.querySelector(".task-name")?.textContent === parameters.updatedName)!.click();
          await waitFor(() => document.querySelector("h1")?.textContent === parameters.updatedName); click("Overview");
          await new Promise(resolve => setTimeout(resolve, 150));
          return { assertions, runId, operationCount: (await bridge.request({ action: "operations" })).length };
        };
        integration = await window!.webContents.executeJavaScript(`(${exercise.toString()})(${JSON.stringify(scenario)})`);
        const normalBounds = window!.getBounds(), responsiveHeaders: Array<{ width: number; below: boolean }> = [];
        try {
          for (const width of [900, 1024, 1200]) {
            window!.setSize(width, normalBounds.height); await new Promise(resolve => setTimeout(resolve, 70));
            const header = await window!.webContents.executeJavaScript("(() => {const main=document.getElementById('main'),content=document.getElementById('page-content'),page=main.querySelector(':scope > .page-header'),tabs=main.querySelector(':scope > .tabs'),text=page?.firstElementChild,toolbar=page?.querySelector('.toolbar'),buttons=toolbar?[...toolbar.querySelectorAll('button')].filter(button=>!button.hidden):[],card=[...content.querySelectorAll('.card')].find(item=>!item.hidden&&!item.parentElement.classList.contains('card-grid'));if(!page||!text||!toolbar||!tabs||!card||buttons.length!==2)return null;const a=page.getBoundingClientRect(),m=main.getBoundingClientRect(),t=text.getBoundingClientRect(),g=toolbar.getBoundingClientRect(),c=card.getBoundingClientRect(),tab=tabs.getBoundingClientRect(),tabStyle=getComputedStyle(tabs),r=buttons.map(button=>button.getBoundingClientRect());return {sameRow:r.every(rect=>Math.abs(rect.top-r[0].top)<1),inside:g.left>=a.left-1&&g.right<=a.right+1,below:g.top>=t.bottom-1,right:g.left>=t.right-1,headerOutside:!content.contains(page),fullDivider:Math.abs(tab.left-m.left)<1&&Math.abs(tab.right-m.right)<1&&parseFloat(tabStyle.borderBottomWidth)>0,aligned:Math.abs(t.left-c.left)<1.5&&Math.abs(g.right-c.right)<1.5&&Math.abs(tab.left+parseFloat(tabStyle.paddingLeft)-c.left)<1.5}})()") as { sameRow: boolean; inside: boolean; below: boolean; right: boolean; headerOutside: boolean; fullDivider: boolean; aligned: boolean } | null;
            if (!header?.sameRow || !header.inside || !(header.below || header.right) || !header.headerOutside || !header.fullDivider || !header.aligned) throw new Error(`Task header, action group or content alignment failed at width ${width}: ${JSON.stringify(header)}`);
            responsiveHeaders.push({ width, below: header.below });
          }
        } finally { window!.setBounds(normalBounds); await new Promise(resolve => setTimeout(resolve, 70)); }
        Object.assign(integration as object, { responsiveHeaders });
        const waitForUi = async (expression: string) => { const deadline = Date.now() + 12_000; while (Date.now() < deadline) { if (await window!.webContents.executeJavaScript(expression)) return; await new Promise(resolve => setTimeout(resolve, 35)); } throw new Error("The isolated UI capture did not become ready"); };
        const captureUi = async (filename: string) => { await window!.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true }); await new Promise(resolve => setTimeout(resolve, 90)); await writeFile(filename, (await window!.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG()); };
        await window!.webContents.executeJavaScript("document.getElementById('task-tab-settings').click()"); await waitForUi("!!document.querySelector('#task-sources .source-filter-row[data-empty=false]')");
        const sourcesScreenshot = `${options.smokeReport}.sources.png`; await captureUi(sourcesScreenshot);
        await window!.webContents.executeJavaScript("(() => {const filters=document.querySelector('#task-sources .source-filters');filters.scrollIntoView({block:'center'});filters.querySelector('.source-filter-pattern').focus({preventScroll:true})})()"); await waitForUi("!document.getElementById('dialog').open&&document.activeElement?.classList.contains('source-filter-pattern')");
        const sourceFiltersScreenshot = `${options.smokeReport}.source-filters.png`; await captureUi(sourceFiltersScreenshot);
        await window!.webContents.executeJavaScript("document.getElementById('task-tab-overview').click()"); await waitForUi("!!document.querySelector('#main .card-grid')");
        Object.assign(integration as object, { sourcesScreenshot, sourceFiltersScreenshot });
        if (await readFile(path.join(scenario.outputDirectory, path.basename(scenario.changedFile)), "utf8") !== scenario.changedContent) throw new Error("Real UI restore content differs from the source");
        if (process.argv.includes("--delta-ui-accessibility")) {
          const { qualifyUiAccessibility } = await import("./core/ui-accessibility-probe.js");
          accessibility = await qualifyUiAccessibility(window!, scenario.taskId, scenario.outputDirectory);
        }
      }
      const renderer = await window!.webContents.executeJavaScript("({title:document.title,node:typeof require,api:typeof window.delta?.request,text:document.body.innerText})");
      if (renderer.node !== "undefined" || renderer.api !== "function" || renderer.text.includes("Could not load configuration")) throw new Error("Renderer initialization failed");
      await mkdir(path.dirname(options.smokeReport), { recursive: true });
      const screenshot = `${options.smokeReport}.png`;
      // Warm the hidden compositor; its previous surface may precede the final DOM change.
      await window!.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
      await new Promise(resolve => setTimeout(resolve, 120));
      await writeFile(screenshot, (await window!.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG());
      quitting = true; schedulerWakeups.close(); userStyles.close(); updates.close(); trayPopup?.close(); nativeTheme.removeListener("updated", syncWindowBackground); desktopIntegration.close(); tray?.destroy(); await coordinator.close(); await snapshotProvider.shutdown();
      const notificationIdentity = systemProbe ? await cleanupNotificationProbeIdentity() : undefined;
      await writeFile(options.smokeReport, JSON.stringify({ status: "passed", renderer, screenshot, uiFile, integration, customization, systemIntegration, notificationIdentity, accessibility, branding, updateChecking, themes, taskLocationOpens }, null, 2));
      window!.destroy(); app.exit(0);
    } catch (error) {
      await mkdir(path.dirname(options.smokeReport), { recursive: true });
      const renderer = await window?.webContents.executeJavaScript("({title:document.title,text:document.body.innerText})").catch(() => null);
      if (window && !window.isDestroyed()) await writeFile(`${options.smokeReport}.png`, (await window.webContents.capturePage()).toPNG());
      await writeFile(options.smokeReport, JSON.stringify({ status: "failed", error: error instanceof Error ? error.message : String(error), renderer, operations: [...service.operations.values()] }, null, 2));
      quitting = true; schedulerWakeups.close(); userStyles.close(); updates.close(); trayPopup?.close(); nativeTheme.removeListener("updated", syncWindowBackground); desktopIntegration.close(); tray?.destroy(); await service.shutdown(); if (systemProbe) await cleanupNotificationProbeIdentity().catch(error => console.error(error)); window?.destroy(); app.exit(1);
    }
  }
  return service;
}
