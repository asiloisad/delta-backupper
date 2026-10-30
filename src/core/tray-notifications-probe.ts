import type { BrowserWindow, Tray } from "electron";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ApiRequest, Operation } from "../service/api.js";
import type { DesktopIntegration, NotificationResult } from "../platform/desktop-integration.js";
import type { TrayPopup } from "../platform/tray-popup.js";

interface QualificationPorts {
  tray: Tray | undefined;
  integration: DesktopIntegration;
  getTrayPopup(): TrayPopup | undefined;
  getTrayTooltip(): string;
  showWindow(): Promise<void>;
  dispatch(request: ApiRequest, allowDialog?: boolean): Promise<unknown>;
  allowNativeNotifications?: boolean;
}
export interface TrayNotificationsQualification {
  assertions: string[];
  platform: string;
  screenshot: string;
  screenshotSha256: string;
  appSettingsRestored: boolean;
  windowStateRestored: boolean;
  nativeNotifications: { status: "skipped" | "submitted" | "unsupported" | "blocked" | "failed"; uiTest?: NotificationResult; simulatedOperation?: NotificationResult };
  diagnostics?: ReturnType<DesktopIntegration["diagnostics"]>;
  scope: string;
}

/** Isolated opt-in harness; tray activation and operation events are programmatic. */
export async function qualifyTrayNotifications(window: BrowserWindow, configDirectory: string, ports: QualificationPorts): Promise<TrayNotificationsQualification> {
  const ownershipFile = path.join(configDirectory, ".system-integration-qualification.json");
  const ownershipInfo = await lstat(ownershipFile);
  if (!ownershipInfo.isFile() || ownershipInfo.isSymbolicLink() || ownershipInfo.size > 8192) throw new Error("System integration qualification requires an owned ordinary fixture marker");
  const ownership = JSON.parse(await readFile(ownershipFile, "utf8"));
  if (ownership.schemaVersion !== 1 || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(ownership.id) || ownership.configDirectory !== configDirectory || await realpath(configDirectory) !== configDirectory) throw new Error("System integration qualification marker does not match its isolated configuration directory");
  const appFile = path.join(configDirectory, "config.json"), originalApp = await readFile(appFile);
  const original = (await ports.dispatch({ action: "bootstrap" }) as { app: { value: Record<string, unknown>; revision: string } }).app.value;
  const initial = { visible: window.isVisible(), focused: window.isFocused(), minimized: window.isMinimized(), maximized: window.isMaximized(), fullscreen: window.isFullScreen(), bounds: window.getNormalBounds() };
  const result: TrayNotificationsQualification = { assertions: [], platform: process.platform, screenshot: "", screenshotSha256: "", appSettingsRestored: false, windowStateRestored: false, nativeNotifications: { status: "skipped" }, scope: "Actual Electron Tray object and native icon tooltip submissions while its menu is hidden, sandboxed custom popup, real backup progress and cancellation, native window close/hide/restore, real settings DOM and IPC. Tray events use Tray.emit; shell mouse input, rendered OS tooltips and taskbar placement are not qualified. Notification operation results are simulated separately from the real popup backup job. Native notification submission does not prove that an OS banner was visible, audible or activated by a user." };
  const assert = (value: unknown, message: string) => { if (!value) throw new Error(message); result.assertions.push(message); };
  async function waitFor(predicate: () => unknown | Promise<unknown>, description: string, timeout = 12_000): Promise<void> {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { if (window.isDestroyed()) throw new Error(`Qualification window was destroyed while waiting for ${description}`); if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 40)); }
    throw new Error(`Timed out waiting for ${description}`);
  }
  async function saveApp(value: Record<string, unknown>) {
    const current = (await ports.dispatch({ action: "bootstrap" }) as { app: { revision: string } }).app;
    await ports.dispatch({ action: "app-save", revision: current.revision, value });
  }
  async function click(id: string) {
    await window.webContents.executeJavaScript(`(() => { const control=document.getElementById(${JSON.stringify(id)}); if (!(control instanceof HTMLButtonElement)||control.disabled) throw new Error('System integration qualification control unavailable'); control.click(); })()`);
  }
  const simulatedOperation = (status: Operation["status"]): Operation => ({ id: randomUUID(), taskId: randomUUID(), action: "run", status, startedAt: new Date().toISOString(), ...(status !== "running" && status !== "queued" ? { finishedAt: new Date().toISOString() } : {}) });
  let ownedOperationId: string | undefined;
  let primaryError: unknown;
  try {
    const tray = ports.tray;
    assert(tray && !tray.isDestroyed() && ports.integration.diagnostics().trayAvailable, "actual native tray is available and retained");
    const popup = ports.getTrayPopup(); assert(popup, "custom tray popup controller is retained");
    let remoteDenied = false;
    try { await ports.dispatch({ action: "notification-test" }, false); } catch { remoteDenied = true; }
    assert(remoteDenied, "notification test rejects coordinator and other non-window requests");
    await saveApp({ ...original, closeToTray: true, notifications: false });
    await ports.showWindow(); await waitFor(() => window.isVisible() && !window.isMinimized(), "visible window before close");
    await window.webContents.executeJavaScript("window.delta.request({action:'window',command:'close'})"); await waitFor(() => !window.isVisible(), "native window close hides the window");
    assert(!window.isDestroyed() && !tray!.isDestroyed(), "window close via the real IPC hides the window while preserving its tray and process");
    tray!.emit("click", {}, { x: 0, y: 0, width: 0, height: 0 }, { x: 0, y: 0 });
    await waitFor(() => window.isVisible() && !window.isMinimized(), "programmatic tray activation opens hidden window");
    assert(true, "programmatically emitted tray click restores the actual hidden window");
    window.minimize(); await waitFor(() => window.isMinimized(), "native minimize before tray activation");
    tray!.emit("double-click", {}, { x: 0, y: 0, width: 0, height: 0 });
    await waitFor(() => window.isVisible() && !window.isMinimized(), "programmatic tray double-click restores minimized window");
    assert(true, "programmatically emitted tray double-click restores the actual minimized window");
    window.hide(); tray!.emit("right-click", {}, tray!.getBounds());
    await waitFor(() => Boolean(popup!.window?.isVisible()), "custom tray popup after right click");
    const popupWindow = popup!.window!;
    const evaluatePopup = <T,>(source: string): Promise<T> => popupWindow.webContents.executeJavaScript(source);
    await waitFor(async () => await evaluatePopup("!!document.getElementById('tray-open')&&typeof window.deltaTray?.snapshot==='function'"), "sandboxed tray renderer");
    assert(await evaluatePopup("typeof require==='undefined'&&typeof window.delta==='undefined'&&document.getElementById('tray-open').textContent.includes('Open')&&document.getElementById('tray-quit').textContent.includes('Quit')"), "custom tray renderer exposes only its limited bridge and English controls");
    const clickPopup = async (id: string) => { await waitFor(async () => await evaluatePopup(`!!document.getElementById(${JSON.stringify(id)})&&!document.getElementById(${JSON.stringify(id)}).disabled`), `enabled tray ${id}`); await evaluatePopup(`document.getElementById(${JSON.stringify(id)}).click()`); };
    await clickPopup("tray-scheduler"); await waitFor(async () => (await popup!.snapshot()).app.schedulerPaused !== original.schedulerPaused, "popup toggles scheduler pause");
    await waitFor(async () => await evaluatePopup(`document.getElementById('tray-scheduler').textContent===${JSON.stringify(original.schedulerPaused ? "Pause schedules" : "Resume schedules")}`), "updated tray scheduler label");
    await clickPopup("tray-scheduler"); await waitFor(async () => (await popup!.snapshot()).app.schedulerPaused === original.schedulerPaused, "popup restores scheduler pause");
    assert(true, "custom tray pause and resume use actual application settings");
    popupWindow.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" }); popupWindow.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
    await waitFor(() => !popupWindow.isVisible(), "Escape hides tray popup"); assert(true, "Escape dismisses the custom tray popup");
    await new Promise(resolve => setTimeout(resolve, 80));
    tray!.emit("right-click", {}, tray!.getBounds()); await waitFor(() => popupWindow.isVisible(), "reopened tray popup"); await clickPopup("tray-open");
    await waitFor(() => window.isVisible() && !window.isMinimized() && !popupWindow.isVisible(), "custom tray Open restores main window"); assert(true, "custom tray Open restores the actual main window and dismisses the popup");
    const qualification = path.join(configDirectory, "qualification"), source = path.join(qualification, "tray-source"), destination = path.join(qualification, "tray-backup");
    await mkdir(source, { recursive: true }); await mkdir(destination, { recursive: true });
    const payload = randomBytes(4 * 1024 ** 2); for (let index = 0; index < 16; index++) await writeFile(path.join(source, `progress-${index}.bin`), payload);
    const fixtureTask = await ports.dispatch({ action: "create", directory: destination, name: "Tray progress qualification", sources: [{ path: source }], settings: { schedules: [], archive: { level: 9 } } }) as { id: string };
    await window.webContents.executeJavaScript("document.getElementById('home').click()");
    await waitFor(async () => window.webContents.executeJavaScript("document.getElementById('main').dataset.view==='home'&&!document.querySelector('#main > .page-header')"), "Home content without a page header");
    await window.webContents.executeJavaScript("document.getElementById('refresh').click()");
    await waitFor(async () => window.webContents.executeJavaScript("document.querySelector('.task-item .task-name')?.textContent==='Tray progress qualification'"), "Home knows the actual task");
    popup!.hide(); await waitFor(() => !popupWindow.isVisible(), "hidden tray menu before real backup");
    const realOperation = await ports.dispatch({ action: "run", reference: fixtureTask.id }) as Operation;
    ownedOperationId = realOperation.id;
    const homeRow = `#home-current [data-operation-id="${realOperation.id}"]`;
    await waitFor(async () => window.webContents.executeJavaScript(`(() => {const row=document.querySelector('${homeRow}');return !!row&&/MiB/.test(row.textContent)&&!!row.querySelector('[data-operation-action="pause"]')})()`), "real backup and Pause on Home", 30_000);
    await waitFor(() => { const tooltip = ports.getTrayTooltip(); return !popupWindow.isVisible() && tooltip.includes("Tray progress qualification") && (/\d{1,3}%/.test(tooltip) || /(?:Scanning|Backing up|Finalizing|Working)[^\n]*(?:files|[KMGTPE]?i?B)\b/.test(tooltip)); }, "native tray icon progress tooltip while its menu is hidden");
    const liveTooltip = ports.getTrayTooltip();
    assert(!popupWindow.isVisible() && liveTooltip.includes("Tray progress qualification") && liveTooltip.isWellFormed() && (process.platform !== "win32" || liveTooltip.length <= 127), "native tray icon receives the cached task name and real progress within its platform limit while the menu is hidden");
    await window.webContents.executeJavaScript(`(() => {const row=document.querySelector('${homeRow}'),bar=row?.querySelector('[role="progressbar"]'),fill=bar?.querySelector('.operation-progress-fill'),sidebar=document.querySelector('.task-item');if(!row||!bar||!fill||!sidebar)throw new Error('Live custom progress elements are missing');window.__deltaLiveProgress={row,bar,fill,animation:fill.getAnimations().find(animation=>animation instanceof CSSAnimation&&animation.animationName==='operation-progress-sweep'),sidebar};row.querySelector('[data-operation-action="pause"]').click()})()`);
    const currentOperation = async () => (await ports.dispatch({ action: "operations" }) as Operation[]).find(operation => operation.id === realOperation.id);
    await waitFor(async () => (await currentOperation())?.paused === true, "actual worker pause request");
    await waitFor(async () => window.webContents.executeJavaScript(`document.querySelector('${homeRow} [data-operation-action="pause"]')?.textContent==='Resume'`), "Resume replaces Pause");
    await waitFor(() => ports.getTrayTooltip().includes("Tray progress qualification") && ports.getTrayTooltip().includes("Paused"), "paused state submitted to the native tray icon");
    assert(!popupWindow.isVisible() && (process.platform !== "win32" || ports.getTrayTooltip().length <= 127), "native tray icon reports the paused real worker without opening its menu");
    await new Promise(resolve => setTimeout(resolve, 500)); const pausedProgress = JSON.stringify((await currentOperation())?.progress);
    await window.webContents.executeJavaScript("document.getElementById('refresh').click()"); await new Promise(resolve => setTimeout(resolve, 450));
    assert((await currentOperation())?.status === "running" && (await currentOperation())?.paused === true && JSON.stringify((await currentOperation())?.progress) === pausedProgress, "pausing the actual worker stops progress while retaining the active operation");
    assert(await window.webContents.executeJavaScript(`(() => {const saved=window.__deltaLiveProgress,row=document.querySelector('${homeRow}'),bar=row?.querySelector('[role="progressbar"]'),fill=bar?.querySelector('.operation-progress-fill');return !!row&&!!bar&&!!fill&&!!saved?.bar&&!!saved.fill&&!!saved.sidebar&&row===saved.row&&bar===saved.bar&&fill===saved.fill&&document.querySelector('.task-item')===saved.sidebar&&bar.dataset.paused==='true'&&(bar.dataset.mode==='determinate'||(matchMedia('(prefers-reduced-motion: reduce)').matches?getComputedStyle(fill).animationName==='none':!!saved.animation&&fill.getAnimations().includes(saved.animation)&&getComputedStyle(fill).animationPlayState==='paused'))})()`), "Home refresh preserves the operation, custom bar, fill and sidebar nodes with the real worker animation paused");
    tray!.emit("right-click", {}, tray!.getBounds()); await waitFor(() => popupWindow.isVisible(), "tray menu reopened after native icon progress checks");
    await waitFor(async () => await evaluatePopup(`(() => {const row=document.querySelector('.tray-operation-item[data-operation-id="${realOperation.id}"]');return !!row&&row.textContent.includes('Tray progress qualification')&&/MiB/.test(row.title)})()`), "real worker progress in the tray item's tooltip", 30_000);
    const activeSnapshot = await popup!.snapshot(); const active = activeSnapshot.operations.find(operation => operation.id === realOperation.id);
    assert(active?.status === "running" && Number(active.progress?.completedBytes ?? active.progress?.bytes) > 0 && Number(active.progress?.files) >= 0 && Number(active.progress?.bytes) >= 0, "custom tray tooltip contains actual completed or in-flight bytes with consistent nonnegative file counters");
    assert(await evaluatePopup("document.querySelectorAll('progress,[role=progressbar],.operation-progress').length===0&&![...document.querySelectorAll('.tray-operation-item')].some(item=>/MiB|Writing backup|\\d+ files/.test(item.textContent))"), "tray is a plain menu list without visible progress cards or counters");
    const hoverPoint = await evaluatePopup<{ x: number; y: number }>(`(() => {const rect=document.querySelector('.tray-operation-item[data-operation-id="${realOperation.id}"]').getBoundingClientRect();return {x:Math.round(rect.left+rect.width/2),y:Math.round(rect.top+rect.height/2)}})()`);
    popupWindow.webContents.sendInputEvent({ type: "mouseMove", ...hoverPoint });
    await waitFor(async () => await evaluatePopup(`document.querySelector('.tray-operation-item[data-operation-id="${realOperation.id}"]').matches(':hover')`), "hover over the actual tray operation item");
    assert(true, "a hovered tray menu item retains its separate current-progress title");
    await waitFor(async () => window.webContents.executeJavaScript(`(() => {const row=document.querySelector('#home-current [data-operation-id="${realOperation.id}"]');return document.getElementById('main').dataset.view==='home'&&!!row&&row.textContent.includes('Tray progress qualification')&&/MiB/.test(row.textContent)&&!!row.querySelector('[role="progressbar"]')})()`), "Home shows the same real running operation");
    assert(true, "Home presents actual backup progress without navigating away from its summary");
    await writeFile(path.join(qualification, "home-progress.png"), (await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG());
    const beforeResume = JSON.stringify((await currentOperation())?.progress);
    await window.webContents.executeJavaScript(`document.querySelector('${homeRow} [data-operation-action="pause"]').click()`);
    await waitFor(async () => { const value = await currentOperation(); return value?.paused === false && JSON.stringify(value.progress) !== beforeResume; }, "Resume continues actual worker progress", 30_000);
    assert(await window.webContents.executeJavaScript(`(() => {const saved=window.__deltaLiveProgress,bar=document.querySelector('${homeRow} [role="progressbar"]'),fill=bar?.querySelector('.operation-progress-fill');return !!bar&&!!fill&&!!saved?.bar&&!!saved.fill&&bar===saved.bar&&fill===saved.fill&&(!saved.animation||fill.getAnimations().includes(saved.animation))})()`), "resuming progress reuses the same bar without replacing its animation node");
    await window.webContents.executeJavaScript(`document.querySelector('${homeRow} [data-operation-action="pause"]').click()`);
    await waitFor(async () => (await currentOperation())?.paused === true, "second pause before cancellation");
    await window.webContents.executeJavaScript(`[...document.querySelectorAll('.task-item')].find(item=>item.dataset.taskId===${JSON.stringify(fixtureTask.id)}).click()`);
    await waitFor(async () => window.webContents.executeJavaScript("!!document.getElementById('task-tab-activity')"), "task tabs while paused");
    await window.webContents.executeJavaScript("document.getElementById('task-tab-activity').click()");
    const activityRow = `#task-panel .operation[data-operation-id="${realOperation.id}"]`;
    await waitFor(async () => window.webContents.executeJavaScript(`!!document.querySelector('${activityRow} [role="progressbar"]')`), "actual Activity progress bar");
    const beforeActivityResume = JSON.stringify((await currentOperation())?.progress);
    await window.webContents.executeJavaScript(`(() => {const row=document.querySelector('${activityRow}'),bar=row?.querySelector('[role="progressbar"]'),fill=bar?.querySelector('.operation-progress-fill');if(!row||!bar||!fill)throw new Error('Activity custom progress elements are missing');window.__deltaActivityProgress={row,bar,fill};row.querySelector('[data-operation-action="pause"]').click()})()`);
    await waitFor(async () => { const value = await currentOperation(); return value?.paused === false && JSON.stringify(value.progress) !== beforeActivityResume; }, "Resume from Activity continues the worker", 30_000);
    await new Promise(resolve => setTimeout(resolve, 150));
    assert(await window.webContents.executeJavaScript(`(() => {const saved=window.__deltaActivityProgress,row=document.querySelector('${activityRow}'),bar=row?.querySelector('[role="progressbar"]'),fill=bar?.querySelector('.operation-progress-fill');return !!row&&!!bar&&!!fill&&!!saved?.bar&&!!saved.fill&&row===saved.row&&bar===saved.bar&&fill===saved.fill})()`), "Activity progress updates retain the same operation and bar nodes without rerendering the page");
    await window.webContents.executeJavaScript(`document.querySelector('${activityRow} [data-operation-action="pause"]').click()`);
    await waitFor(async () => (await currentOperation())?.paused === true, "Activity pauses the same operation");
    await waitFor(async () => window.webContents.executeJavaScript(`(() => {const button=document.querySelector('${activityRow} [data-operation-action="pause"]');return button?.textContent==='Resume'&&!button.disabled&&!document.getElementById('task-pause')&&!document.getElementById('task-run')})()`), "Activity renders Resume in its operation row without Overview's header controls");
    await writeFile(path.join(qualification, "activity-progress.png"), (await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG());
    await window.webContents.executeJavaScript("document.getElementById('task-tab-overview').click()");
    await waitFor(async () => window.webContents.executeJavaScript("document.getElementById('task-pause')?.textContent==='Resume'&&!document.getElementById('task-pause').disabled&&document.getElementById('task-run')?.textContent==='Cancel'&&!document.getElementById('task-run').disabled&&!document.getElementById('task-save')"), "paused worker controls in Overview's header");
    await window.webContents.executeJavaScript("document.getElementById('task-pause').click()"); await waitFor(async () => (await currentOperation())?.paused === false, "Overview header resumes the real worker");
    await waitFor(async () => window.webContents.executeJavaScript("document.getElementById('task-pause')?.textContent==='Pause'&&!document.getElementById('task-pause').disabled"), "Overview header Pause after Resume");
    await window.webContents.executeJavaScript("document.getElementById('task-pause').click()"); await waitFor(async () => (await currentOperation())?.paused === true, "Overview header pauses the real worker again");
    assert(true, "Overview alone exposes the active operation's header Resume/Pause and Cancel controls, and its Resume/Pause buttons control the real worker");
    await window.webContents.executeJavaScript("document.getElementById('home').click()");
    await waitFor(async () => window.webContents.executeJavaScript(`!!document.querySelector('${homeRow} [data-operation-action="cancel"]')`), "paused operation on Home after Activity");
    await window.webContents.executeJavaScript(`document.querySelector('${homeRow} [data-operation-action="cancel"]').click()`);
    await waitFor(async () => { const operations = await ports.dispatch({ action: "operations" }) as Operation[]; return operations.find(operation => operation.id === realOperation.id)?.status === "cancelled"; }, "real worker cancellation from Home");
    await waitFor(() => ports.getTrayTooltip() === "Delta Backupper", "native tray icon tooltip returns to its idle title");
    assert(ports.getTrayTooltip() === "Delta Backupper", "terminal operation progress is removed from the native tray icon tooltip");
    assert(true, "Cancel on Home wakes and safely cancels the paused real backup worker");
    await ports.dispatch({ action: "forget", reference: fixtureTask.id }); popup!.hide(); await ports.showWindow();
    const beforeRunning = ports.integration.diagnostics();
    await ports.integration.handleOperation(simulatedOperation("running"), "Qualification task");
    assert(ports.integration.diagnostics().retainedNotifications === beforeRunning.retainedNotifications && ports.integration.diagnostics().seenOperations === beforeRunning.seenOperations, "simulated running progress creates no native result notification");
    const muted = simulatedOperation("complete");
    await ports.integration.handleOperation(muted, "Qualification task");
    const afterMuted = ports.integration.diagnostics();
    assert(afterMuted.retainedNotifications === beforeRunning.retainedNotifications && afterMuted.seenOperations === beforeRunning.seenOperations + 1, "saved disabled notification preference suppresses a simulated terminal result");
    await ports.integration.handleOperation(muted, "Qualification task");
    assert(ports.integration.diagnostics().seenOperations === afterMuted.seenOperations, "duplicate simulated terminal result is consumed only once");
    await click("app-settings");
    await waitFor(async () => await window.webContents.executeJavaScript("Boolean(document.getElementById('notification-test') && document.querySelector('#main h1')?.textContent === 'Application settings')"), "actual application settings notification controls");
    const settingsCopy = await window.webContents.executeJavaScript("document.getElementById('main').innerText");
    assert(settingsCopy.includes("Background behavior") && settingsCopy.includes("Notifications") && settingsCopy.includes("Do Not Disturb"), "actual English settings explain tray behavior and OS notification controls");
    if (ports.allowNativeNotifications) {
      await click("notification-test");
      await waitFor(async () => await window.webContents.executeJavaScript("(() => {const result=document.getElementById('notification-test-result'),button=document.getElementById('notification-test');return !!result&&!result.hidden&&!button.disabled&&['submitted','unsupported','blocked','failed'].includes(result.dataset.status)})()"), "actual native notification test result", 30_000);
      const ui = await window.webContents.executeJavaScript("(() => {const result=document.getElementById('notification-test-result');return {status:result.dataset.status,message:result.textContent}})()") as { status: NotificationResult["status"]; message: string };
      const last = ports.integration.diagnostics().lastNotification;
      assert(last?.status === ui.status && Boolean(ui.message), "real Test notification button submits through renderer IPC and exposes its actual native result");
      result.nativeNotifications.uiTest = last;
      await saveApp({ ...original, closeToTray: true, notifications: true });
      const terminal = simulatedOperation("complete");
      await ports.integration.handleOperation(terminal, "Qualification task — simulated result");
      const afterTerminal = ports.integration.diagnostics();
      result.nativeNotifications.simulatedOperation = afterTerminal.lastNotification;
      assert(afterTerminal.lastNotification !== undefined && ["submitted", "unsupported", "blocked", "failed"].includes(afterTerminal.lastNotification.status), "enabled simulated task result reaches the actual native notification backend");
      await ports.integration.handleOperation(terminal, "Qualification task — simulated result");
      assert(ports.integration.diagnostics().seenOperations === afterTerminal.seenOperations && ports.integration.diagnostics().retainedNotifications <= afterTerminal.retainedNotifications, "repeated simulated task result does not create a second native notification");
      const statuses = [result.nativeNotifications.uiTest?.status, result.nativeNotifications.simulatedOperation?.status];
      result.nativeNotifications.status = statuses.includes("failed") ? "failed" : statuses.includes("blocked") ? "blocked" : statuses.includes("unsupported") ? "unsupported" : "submitted";
    }
    await window.webContents.executeJavaScript("document.getElementById('notification-test')?.scrollIntoView({block:'center'})");
    const directory = path.join(configDirectory, "qualification"); await mkdir(directory, { recursive: true }); result.screenshot = path.join(directory, "tray-notifications.png");
    await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true }); await new Promise(resolve => setTimeout(resolve, 120));
    const screenshot = (await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG(); await writeFile(result.screenshot, screenshot); result.screenshotSha256 = createHash("sha256").update(screenshot).digest("hex");
    assert(screenshot.length > 1000, "actual notification settings screenshot is preserved");
    result.diagnostics = ports.integration.diagnostics();
  } catch (error) { primaryError = error; }
  finally {
    const restorationErrors: unknown[] = [];
    if (ownedOperationId) try {
      const operation = (await ports.dispatch({ action: "operations" }) as Operation[]).find(value => value.id === ownedOperationId);
      if (operation && ["queued", "running"].includes(operation.status)) { await ports.dispatch({ action: "cancel", operationId: ownedOperationId }); await waitFor(async () => !(await ports.dispatch({ action: "operations" }) as Operation[]).some(value => value.id === ownedOperationId && ["queued", "running"].includes(value.status)), "owned qualification operation cleanup"); }
    } catch (error) { restorationErrors.push(error); }
    ports.getTrayPopup()?.hide();
    try { await saveApp(original); result.appSettingsRestored = (await readFile(appFile)).equals(originalApp); if (!result.appSettingsRestored) throw new Error("Original application settings bytes were not restored"); } catch (error) { restorationErrors.push(error); }
    try {
      if (window.isDestroyed()) throw new Error("Cannot restore destroyed qualification window");
      if (window.isMinimized()) window.restore(); if (window.isFullScreen()) window.setFullScreen(false); if (window.isMaximized()) window.unmaximize(); window.setBounds(initial.bounds);
      if (initial.maximized) window.maximize(); if (initial.fullscreen) window.setFullScreen(true); if (initial.minimized) window.minimize();
      if (initial.visible) window.showInactive(); else window.hide(); if (initial.focused && initial.visible) window.focus();
      await waitFor(() => window.isVisible() === initial.visible && window.isMinimized() === initial.minimized && window.isMaximized() === initial.maximized && window.isFullScreen() === initial.fullscreen, "original native window state"); result.windowStateRestored = true;
    } catch (error) { restorationErrors.push(error); }
    if (restorationErrors.length) { const errors = [...(primaryError ? [primaryError] : []), ...restorationErrors]; throw new AggregateError(errors, `System integration qualification or restoration failed: ${errors.map(error => error instanceof Error ? error.message : String(error)).join("; ")}. Completed: ${result.assertions.join("; ")}`); }
  }
  if (primaryError) throw primaryError;
  assert(result.appSettingsRestored && result.windowStateRestored, "original owned application settings and native window state are restored");
  return result;
}
