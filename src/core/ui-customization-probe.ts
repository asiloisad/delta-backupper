import type { BrowserWindow } from "electron";
import { lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

interface CssState { value: string; owned: string }
export interface UiCustomizationQualification {
  assertions: string[];
  platform: string;
  screenshot: string;
  screenshotSha256: string;
  originalStylesSha256: string;
  originalStylesRestored: boolean;
  windowStateRestored: boolean;
  scope: string;
}

/** Test-only entry: requires the isolated harness's explicit ownership marker. */
export async function qualifyUiCustomization(window: BrowserWindow, configDirectory: string): Promise<UiCustomizationQualification> {
  const filename = path.join(configDirectory, "styles.css");
  const info = await lstat(filename);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) throw new Error("Customization probe requires an owned ordinary styles.css fixture");
  const original = await readFile(filename);
  const firstLine = original.subarray(0, original.indexOf(10) < 0 ? original.length : original.indexOf(10)).toString("utf8");
  const ownership = /^\/\* Delta customization qualification ([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}) \*\/$/i.exec(firstLine);
  if (!ownership) throw new Error("Refusing to rewrite styles.css without the customization qualification ownership marker");
  const marker = firstLine, sentinel = `owned-${ownership[1]}`;
  const initial = { visible: window.isVisible(), focused: window.isFocused(), maximized: window.isMaximized(), minimized: window.isMinimized(), fullscreen: window.isFullScreen(), normalBounds: window.getNormalBounds(), devtools: window.webContents.isDevToolsOpened() };
  const result: UiCustomizationQualification = { assertions: [], platform: process.platform, screenshot: "", screenshotSha256: "", originalStylesSha256: createHash("sha256").update(original).digest("hex"), originalStylesRestored: false, windowStateRestored: false, scope: "Actual user CSS watcher, native caption overlay geometry, draggable titlebar content, Ctrl+Shift+I and F12. Window-state IPC exercises native maximize/minimize/restore; native caption hit testing and native overlay pixels are not qualified by renderer capture. Close/quit/tray are not exercised." };
  const assert = (condition: unknown, message: string) => { if (!condition) throw new Error(message); result.assertions.push(message); };
  async function waitFor(predicate: () => unknown | Promise<unknown>, description: string, timeout = 12_000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { if (window.isDestroyed()) throw new Error(`Window destroyed while waiting for ${description}`); if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 45)); }
    throw new Error(`Timed out waiting for ${description}`);
  }
  const cssState = async () => await window.webContents.executeJavaScript("({value:getComputedStyle(document.body).getPropertyValue('--delta-qualification').trim(),owned:getComputedStyle(document.body).getPropertyValue('--delta-qualification-owned').trim()})") as CssState;
  async function expectCss(value: string, owned = sentinel) { let observed: CssState | undefined; try { await waitFor(async () => { observed = await cssState(); return observed.value === value && observed.owned === owned; }, `computed user CSS ${value || '(empty)'}`); } catch (error) { const diagnostics = { loading: window.webContents.isLoadingMainFrame(), url: window.webContents.getURL(), document: await window.webContents.executeJavaScript("({readyState:document.readyState,accent:getComputedStyle(document.body).getPropertyValue('--accent'),sheets:[...document.styleSheets].map(s=>({href:s.href,rules:s.cssRules.length}))})") }; throw new Error(`${error instanceof Error ? error.message : String(error)}; expected ${JSON.stringify({ value, owned })}, observed ${JSON.stringify(observed)}, diagnostics ${JSON.stringify(diagnostics)}`); } }
  async function assertOwned(allowMissing = false) {
    let current: Buffer;
    try { const currentInfo = await lstat(filename); if (!currentInfo.isFile() || currentInfo.isSymbolicLink() || currentInfo.size > 1024 * 1024) throw new Error("Refusing to modify a replaced styles.css fixture"); current = await readFile(filename); }
    catch (error) { if (allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    const line = current.subarray(0, current.indexOf(10) < 0 ? current.length : current.indexOf(10)).toString("utf8");
    if (line !== marker) throw new Error("Refusing to modify styles.css whose qualification ownership marker changed");
  }
  const css = (value: string) => `${marker}\nbody { --delta-qualification: ${value}; --delta-qualification-owned: ${sentinel}; }\n`;
  async function click(id: string) {
    await window.webContents.executeJavaScript(`(() => { const button=document.getElementById(${JSON.stringify(id)}); if(!(button instanceof HTMLButtonElement)||button.disabled)throw new Error('Qualification control unavailable'); button.click(); })()`);
  }
  async function rendererMaximized(value: boolean) { return await window.webContents.executeJavaScript(`document.body.classList.contains('window-maximized')===${value}`) as boolean; }
  async function windowCommand(command: "toggle-maximize" | "minimize") { await window.webContents.executeJavaScript(`window.delta.request({action:'window',command:${JSON.stringify(command)}})`); }
  async function f12() { window.webContents.focus(); window.webContents.sendInputEvent({ type: "keyDown", keyCode: "F12" }); window.webContents.sendInputEvent({ type: "keyUp", keyCode: "F12" }); }
  async function devtoolsShortcut() { window.webContents.focus(); window.webContents.sendInputEvent({ type: "keyDown", keyCode: "I", modifiers: ["control", "shift"] }); window.webContents.sendInputEvent({ type: "keyUp", keyCode: "I", modifiers: ["control", "shift"] }); }
  let temporary: string | undefined;
  let primaryError: unknown;
  try {
    const english = await window.webContents.executeJavaScript("(() => ({language:document.documentElement.lang,labels:Object.fromEntries(['new-task','discover-task','defaults','app-settings'].map(id=>[id,document.getElementById(id)?.textContent?.trim()])),accessibleLabels:Object.fromEntries(['home','about'].map(id=>[id,document.getElementById(id)?.getAttribute('aria-label')]))}))()");
    const expectedLabels: Record<string, string> = { "new-task": "New task", "discover-task": "Discover existing", "defaults": "Task defaults", "app-settings": "Application settings" };
    assert(english.language === "en" && Object.entries(expectedLabels).every(([id, label]) => english.labels[id] === label) && english.accessibleLabels.home === "Home" && english.accessibleLabels.about === "About Delta Backupper", "actual interface chrome and titlebar accessibility labels are English");
    // `initial` is a CSS-wide keyword, so its computed custom value is empty.
    // The distinct sentinel proves the initial fixture was really loaded.
    await expectCss(""); assert(true, "initial owned styles.css is applied by the real watcher");
    await assertOwned(); await writeFile(filename, css("regular")); await expectCss("regular"); assert(true, "regular save updates computed CSS without renderer reload");
    await assertOwned(); temporary = path.join(configDirectory, `.styles-qualification-${randomUUID()}.tmp`); await writeFile(temporary, css("atomic"), { flag: "wx", mode: 0o600 }); await rename(temporary, filename); temporary = undefined; await expectCss("atomic"); assert(true, "atomic rename save updates computed CSS through the directory watcher");
    await assertOwned(); await writeFile(filename, Buffer.concat([Buffer.from(css("must-not-apply"), "utf8"), Buffer.from([0xff, 0xfe])]));
    await waitFor(async () => await window.webContents.executeJavaScript("(() => {const n=document.getElementById('notification');return !!n&&!n.hidden&&n.dataset.error==='true'&&n.textContent.includes('not valid UTF-8')&&n.textContent.includes('previous styles were retained')})()"), "visible English invalid UTF-8 styles error");
    await expectCss("atomic"); assert(true, "invalid UTF-8 preserves last good CSS and displays an actual UI error");
    await assertOwned(); await unlink(filename); await expectCss("", ""); assert(true, "deleting styles.css unloads the user stylesheet");
    await assertOwned(true); await writeFile(filename, css("recreated"), { flag: "wx", mode: 0o600 }); await expectCss("recreated"); assert(true, "recreating styles.css reloads user CSS without manual reload");

    if (window.isFullScreen()) { window.setFullScreen(false); await waitFor(() => !window.isFullScreen(), "leaving fullscreen for titlebar qualification"); }
    if (window.isMinimized()) window.restore();
    if (window.isMaximized()) { window.unmaximize(); await waitFor(() => !window.isMaximized(), "normal window before control clicks"); }
    window.showInactive(); window.focus(); window.webContents.focus();
    await waitFor(async () => await window.webContents.executeJavaScript("!!document.querySelector('#titlebar .titlebar-content')"), "native titlebar content");
    if (process.platform !== "darwin") await waitFor(async () => await window.webContents.executeJavaScript("navigator.windowControlsOverlay?.visible===true&&navigator.windowControlsOverlay.getTitlebarAreaRect().width>0"), "visible native window controls overlay");
    const chrome = await window.webContents.executeJavaScript("(() => {const t=document.getElementById('titlebar'),inner=t?.querySelector('.titlebar-content'),home=document.getElementById('home'),area=navigator.windowControlsOverlay?.getTitlebarAreaRect(),bounds=inner?.getBoundingClientRect();return {present:!!t&&!!inner&&!!home,drag:t?getComputedStyle(t).getPropertyValue('-webkit-app-region'):'',buttonDrag:home?getComputedStyle(home).getPropertyValue('-webkit-app-region'):'',height:t?t.getBoundingClientRect().height:0,noReplacements:['window-minimize','window-maximize','window-close','window-devtools'].every(id=>!document.getElementById(id)),overlayVisible:navigator.windowControlsOverlay?.visible===true,overlayReserved:!!area&&area.width>0&&area.width<innerWidth&&!!bounds&&bounds.left>=area.x-1&&bounds.right<=area.x+area.width+1,macInset:!!bounds&&bounds.left>=78}})()");
    assert(chrome.present && chrome.drag === "drag" && chrome.buttonDrag === "no-drag" && chrome.height > 0 && chrome.noReplacements && (process.platform === "darwin" ? chrome.macInset : chrome.overlayVisible && chrome.overlayReserved), "custom titlebar reserves the platform's native caption area without replacement HTML window buttons");
    assert(await window.webContents.executeJavaScript("(() => {const bar=document.getElementById('titlebar').getBoundingClientRect(),home=document.getElementById('home').getBoundingClientRect(),native=navigator.windowControlsOverlay?.getTitlebarAreaRect();return Math.abs(home.height-bar.height)<.01&&(document.body.dataset.platform==='darwin'||native&&Math.abs(native.height-home.height)<.01)&&parseFloat(getComputedStyle(document.getElementById('titlebar')).borderBottomWidth)===0&&parseFloat(getComputedStyle(document.querySelector('.app-shell')).borderTopWidth)>0})()"), "Home and native caption controls share their full height with the separator below the entire titlebar");
    if (window.webContents.isDevToolsOpened()) window.webContents.closeDevTools();
    await devtoolsShortcut(); await waitFor(() => window.webContents.isDevToolsOpened(), "DevTools opened by Ctrl+Shift+I"); assert(true, "Ctrl+Shift+I opens the actual developer tools");
    await devtoolsShortcut(); await waitFor(() => !window.webContents.isDevToolsOpened(), "DevTools closed by Ctrl+Shift+I"); assert(true, "Ctrl+Shift+I closes the actual developer tools");
    window.focus(); await f12(); await waitFor(() => window.webContents.isDevToolsOpened(), "DevTools opened by an F12 input event"); assert(true, "F12 input event opens actual DevTools");
    window.focus(); await f12(); await waitFor(() => !window.webContents.isDevToolsOpened(), "DevTools closed by an F12 input event"); assert(true, "F12 input event closes actual DevTools");
    await windowCommand("toggle-maximize"); await waitFor(async () => window.isMaximized() && await rendererMaximized(true), "native maximize and renderer window state"); assert(true, "maximize IPC changes native window state and renderer state");
    await windowCommand("minimize"); await waitFor(() => window.isMinimized(), "native minimize"); assert(true, "minimize IPC minimizes the actual native window");
    window.restore(); await waitFor(() => !window.isMinimized(), "native restore after minimize");
    if (!window.isMaximized()) { await windowCommand("toggle-maximize"); await waitFor(() => window.isMaximized(), "maximize after restoring a minimized window"); }
    await windowCommand("toggle-maximize"); await waitFor(async () => !window.isMaximized() && await rendererMaximized(false), "native unmaximize and renderer state"); assert(true, "maximize IPC toggle restores the native size and renderer state");
    await waitFor(async () => await window.webContents.executeJavaScript("document.getElementById('notification').hidden"), "transient error notification to finish", 20_000);
    await expectCss("recreated");
    const directory = path.join(configDirectory, "qualification"); await mkdir(directory, { recursive: true }); result.screenshot = path.join(directory, "customization.png");
    await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true }); await new Promise(resolve => setTimeout(resolve, 120)); const png = (await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG(); await writeFile(result.screenshot, png); result.screenshotSha256 = createHash("sha256").update(png).digest("hex"); assert(png.length > 1000, "actual customized application screenshot is preserved");
  } catch (error) { primaryError = error; }
  finally {
    const restorationErrors: unknown[] = [];
    try { await assertOwned(true); await writeFile(filename, original); await expectCss(""); result.originalStylesRestored = (await readFile(filename)).equals(original); if (!result.originalStylesRestored) throw new Error("Original styles.css was not restored"); } catch (error) { restorationErrors.push(error); }
    if (temporary) { try { await unlink(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") restorationErrors.push(error); } }
    try {
      if (window.isDestroyed()) throw new Error("Cannot restore a destroyed qualification window");
      if (window.isMinimized()) window.restore(); if (window.isFullScreen()) window.setFullScreen(false); if (window.isMaximized()) window.unmaximize(); window.setBounds(initial.normalBounds);
      if (initial.maximized) window.maximize(); if (initial.fullscreen) window.setFullScreen(true); if (initial.minimized) window.minimize();
      if (initial.visible) window.showInactive(); else window.hide(); if (initial.focused && initial.visible) window.focus();
      if (initial.devtools && !window.webContents.isDevToolsOpened()) window.webContents.openDevTools({ mode: "detach", activate: false }); else if (!initial.devtools && window.webContents.isDevToolsOpened()) window.webContents.closeDevTools();
      await waitFor(() => window.isVisible() === initial.visible && window.isMinimized() === initial.minimized && window.isMaximized() === initial.maximized && window.isFullScreen() === initial.fullscreen && window.webContents.isDevToolsOpened() === initial.devtools, "original window visibility and state restored"); result.windowStateRestored = true;
    } catch (error) { restorationErrors.push(error); }
    if (restorationErrors.length) { const failures = [...(primaryError ? [primaryError] : []), ...restorationErrors]; throw new AggregateError(failures, `Customization qualification or restoration failed: ${failures.map(error => error instanceof Error ? error.message : String(error)).join("; ")}. Completed: ${result.assertions.join("; ")}`); }
  }
  if (primaryError) throw primaryError;
  assert(result.originalStylesRestored && result.windowStateRestored, "original owned CSS and native window state are restored");
  return result;
}
