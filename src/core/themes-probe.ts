import { nativeTheme, type BrowserWindow } from "electron";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

type Family = "one" | "aura";
type Mode = "light" | "dark";
interface Preferences { revision: string; value: Record<string, unknown> }
interface ColorInspection { color: number[]; background: number[]; border: number[]; borderWidth: string; borderStyle: string; outline: number[]; outlineWidth: string; outlineStyle: string; colorScheme: string }
export interface ThemeQualification {
  assertions: string[];
  platform: string;
  screenshots: Array<{ family: Family; mode: Mode; filename: string; sha256: string }>;
  contrasts: Array<{ family: Family; mode: Mode; label: string; ratio: number; minimum: number }>;
  originalPreferencesRestored: boolean;
  nativeThemeRestored: boolean;
  scope: string;
}

/** Test-only: exercises the real settings, persisted preferences and renderer in an explicitly owned empty profile. */
export async function qualifyThemes(window: BrowserWindow, configDirectory: string): Promise<ThemeQualification> {
  const argument = (name: string): string => { const matches = process.argv.filter(value => value.startsWith(`${name}=`)); if (matches.length !== 1 || !matches[0]!.slice(name.length + 1)) throw new Error(`Theme qualification requires one explicit ${name} path`); return path.resolve(matches[0]!.slice(name.length + 1)); };
  const configured = argument("--delta-config-dir"), profile = argument("--stage0-profile"), report = argument("--delta-smoke-report"), resolved = path.resolve(configDirectory), fixture = path.dirname(resolved);
  if (!process.argv.includes("--delta-ui-themes") || configured !== resolved) throw new Error("Theme qualification requires its explicit isolated profile and smoke flags");
  for (const target of [profile, report]) { const relative = path.relative(fixture, target); if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || target === resolved) throw new Error("Theme qualification profile and report must belong to its isolated fixture"); }
  for (const directory of [fixture, resolved, profile]) { const info = await lstat(directory); if (!info.isDirectory() || info.isSymbolicLink() || await realpath(directory) !== directory) throw new Error("Theme qualification requires ordinary isolated directories without symbolic links"); }
  const reportInfo = await lstat(report).catch(error => { if (error.code === "ENOENT") return undefined; throw error; });
  if (reportInfo && (!reportInfo.isFile() || reportInfo.isSymbolicLink())) throw new Error("Theme qualification report must be an ordinary owned file");
  const markerFile = path.join(resolved, ".themes-qualification.json"), markerInfo = await lstat(markerFile);
  if (!markerInfo.isFile() || markerInfo.isSymbolicLink() || markerInfo.size > 4096) throw new Error("Theme qualification requires an ordinary ownership marker");
  const markerBytes = await readFile(markerFile), marker = JSON.parse(markerBytes.toString("utf8"));
  if (marker.schemaVersion !== 1 || marker.kind !== "delta-themes-qualification" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(marker.id)) throw new Error("Theme qualification ownership marker is invalid");
  for (const name of ["config.json", "tasks.json"]) { const info = await lstat(path.join(resolved, name)); if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) throw new Error(`Theme qualification requires an ordinary ${name}`); }
  const registry = JSON.parse(await readFile(path.join(resolved, "tasks.json"), "utf8"));
  if (!Array.isArray(registry) || registry.length) throw new Error("Theme qualification requires an empty task catalogue in the current format");
  const result: ThemeQualification = { assertions: [], platform: process.platform, screenshots: [], contrasts: [], originalPreferencesRestored: false, nativeThemeRestored: false, scope: "Actual Electron settings form, sandbox IPC, persisted theme family and color mode, live system appearance changes, rendered control and status color contrasts, and authentic One/Aura light/dark screenshots. Only an explicitly owned empty profile is changed; its preferences and Electron theme source are restored. No backup, login item, OS notification or network operations." };
  const assert = (condition: unknown, message: string): void => { if (!condition) throw new Error(message); result.assertions.push(message); };
  const evaluate = async <T = unknown>(code: string): Promise<T> => window.webContents.executeJavaScript(code) as Promise<T>;
  async function waitFor(code: string, description: string): Promise<void> { const deadline = Date.now() + 12_000; while (Date.now() < deadline) { if (window.isDestroyed()) throw new Error(`Theme qualification window destroyed while waiting for ${description}`); if (await evaluate(code)) return; await new Promise(resolve => setTimeout(resolve, 40)); } throw new Error(`Timed out waiting for ${description}`); }
  async function click(id: string): Promise<void> { await evaluate(`(() => {const control=document.getElementById(${JSON.stringify(id)});if(!(control instanceof HTMLButtonElement)||control.disabled)throw new Error('Theme qualification control unavailable');control.click()})()`); }
  async function current(): Promise<Preferences> { return evaluate("window.delta.request({action:'bootstrap'}).then(value=>value.app)"); }
  const bootstrap = await evaluate<{ tasks: unknown[]; app: Preferences }>("window.delta.request({action:'bootstrap'})");
  if (bootstrap.tasks.length || bootstrap.app.value.launchAtLogin !== false) throw new Error("Theme qualification requires no remembered tasks and login startup disabled");
  const initial = bootstrap.app, source = nativeTheme.themeSource; let ownedRevision = initial.revision;
  async function ownPreferences(): Promise<Preferences> { const value = await current(); if (value.revision !== ownedRevision) throw new Error("Theme qualification preferences changed unexpectedly; refusing to overwrite a different revision"); return value; }
  async function settings(): Promise<void> { await click("app-settings"); await waitFor("document.getElementById('main').dataset.view==='application-settings'&&!document.getElementById('main').hasAttribute('aria-busy')&&!!document.getElementById('theme-family')&&!!document.getElementById('color-mode')", "current theme settings form"); }
  async function save(family: Family, mode: Mode | "system"): Promise<void> {
    await ownPreferences(); await settings();
    const documentToken = `theme-qualification-${marker.id}`;
    await evaluate(`(() => {window.__deltaThemeQualification=${JSON.stringify(documentToken)};document.getElementById('theme-family').value=${JSON.stringify(family)};document.getElementById('color-mode').value=${JSON.stringify(mode)};document.querySelector('#main form').requestSubmit()})()`);
    await waitFor(`window.delta.request({action:'bootstrap'}).then(value=>value.app.value.themeFamily===${JSON.stringify(family)}&&value.app.value.theme===${JSON.stringify(mode)})`, `saved ${family}/${mode} preferences`);
    await waitFor(`document.body.dataset.themeFamily===${JSON.stringify(family)}&&${mode === "system" ? "!document.body.hasAttribute('data-theme')" : `document.body.dataset.theme===${JSON.stringify(mode)}`}&&[...document.querySelectorAll('#main button')].some(button=>button.textContent==='Save settings'&&!button.disabled)`, `immediate ${family}/${mode} appearance`);
    const saved = await current(); ownedRevision = saved.revision;
    assert(isDeepStrictEqual(saved.value, { ...initial.value, themeFamily: family, theme: mode }), `${family}/${mode}: settings save preserves every unrelated application preference`);
    assert(await evaluate(`window.__deltaThemeQualification===${JSON.stringify(documentToken)}`), `${family}/${mode}: saving applies the appearance immediately without reloading the document`);
  }
  async function inspect(): Promise<Record<string, ColorInspection> & { family: string; mode: string | null; focusVisible: boolean; logos: string[][] }> {
    window.webContents.focus(); window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Tab" }); window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Tab" });
    await new Promise(resolve => setTimeout(resolve, 40));
    return evaluate(`(() => {
      const canvas=document.createElement('canvas');canvas.width=1;canvas.height=1;const context=canvas.getContext('2d',{willReadFrequently:true});
      const parse=value=>{context.clearRect(0,0,1,1);context.fillStyle=value;context.fillRect(0,0,1,1);const pixel=[...context.getImageData(0,0,1,1).data];return [...pixel.slice(0,3),pixel[3]/255]};
      const read=element=>{if(!element)throw new Error('Theme inspection control missing');const style=getComputedStyle(element);return {color:parse(style.color),background:parse(style.backgroundColor),border:parse(style.borderTopColor),borderWidth:style.borderTopWidth,borderStyle:style.borderTopStyle,outline:parse(style.outlineColor),outlineWidth:style.outlineWidth,outlineStyle:style.outlineStyle,colorScheme:style.colorScheme}};
      const values={body:read(document.body),sidebar:read(document.querySelector('.sidebar')),titlebar:read(document.querySelector('.titlebar')),panel:read(document.querySelector('#main .card')),select:read(document.getElementById('theme-family')),input:read(document.querySelector('#main input[type=number]')),primary:read(document.querySelector('#main button.primary')),muted:read(document.querySelector('#main .field-hint')),sidebarText:read(document.querySelector('.sidebar-footer button'))};
      for(const kind of ['error','warning']){const status=document.createElement('p');status.className='notice '+kind;status.style.position='fixed';status.style.left='-10000px';status.textContent='Theme qualification';document.querySelector('#main .card').append(status);values[kind]=read(status);status.remove()}
      const select=document.getElementById('theme-family');select.blur();values.select=read(select);select.focus({preventScroll:true});values.focus=read(select);const logos=[...document.querySelectorAll('.brand-logo')].map(mark=>[...mark.querySelectorAll('img')].filter(image=>getComputedStyle(image).display!=='none').map(image=>image.className));return {...values,family:document.body.dataset.themeFamily,mode:document.body.getAttribute('data-theme'),focusVisible:select.matches(':focus-visible'),logos};
    })()`);
  }
  function composite(front: number[], back: number[]): number[] { const alpha = front[3] ?? 1; return front.slice(0, 3).map((channel, index) => channel * alpha + back[index]! * (1 - alpha)); }
  function contrast(front: number[], back: number[]): number { const luminance = (color: number[]): number => color.slice(0, 3).map(channel => { const value = channel / 255; return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4; }).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index]!, 0); const first = luminance(composite(front, back)), second = luminance(back); return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05); }
  const expectedBackgrounds: Record<Family, Record<Mode, number[]>> = { one: { light: [250, 250, 250], dark: [40, 44, 52] }, aura: { light: [255, 255, 255], dark: [20, 22, 31] } };
  async function colors(family: Family, mode: Mode): Promise<void> {
    const values = await inspect(), background = values.body!.background, panel = composite(values.panel!.background, background), sidebar = composite(values.sidebar!.background, background);
    assert(values.family === family && background.slice(0, 3).every((channel, index) => channel === expectedBackgrounds[family][mode][index]), `${family}/${mode}: actual body background matches the source theme palette`);
    const expectedNative = expectedBackgrounds[family][mode].map(channel => channel.toString(16).padStart(2, "0")).join(""), nativeBackground = window.getBackgroundColor().toLowerCase();
    assert(nativeBackground === `#${expectedNative}` || nativeBackground === `#ff${expectedNative}`, `${family}/${mode}: native window background matches the rendered theme`);
    assert(["body", "panel", "select", "input"].every(key => values.mode === null ? values[key]!.colorScheme === "light dark" : values[key]!.colorScheme === mode), `${family}/${mode}: document and native form controls expose the ${values.mode === null ? "system-responsive" : "explicit"} color scheme`);
    assert(values.logos.length === 1 && values.logos.every(variants => variants.length === 1 && variants[0] === (mode === "dark" ? "brand-logo-light" : "brand-logo-color")), `${family}/${mode}: titlebar displays the correct logo variant without duplicate sidebar branding`);
    assert(isDeepStrictEqual(values.titlebar!.background, values.sidebar!.background) && !isDeepStrictEqual(background, sidebar) && !isDeepStrictEqual(panel, sidebar), `${family}/${mode}: titlebar follows the sidebar and content surfaces remain distinct`);
    for (const [label, foreground, surface, minimum] of [
      ["body text", values.body!.color, background, 4.5], ["panel text", values.panel!.color, panel, 4.5], ["muted panel text", values.muted!.color, panel, 4.5], ["sidebar text", values.sidebarText!.color, sidebar, 4.5],
      ["select text", values.select!.color, composite(values.select!.background, panel), 4.5], ["input text", values.input!.color, composite(values.input!.background, panel), 4.5], ["primary label", values.primary!.color, composite(values.primary!.background, panel), 4.5],
      ["error notice text", values.error!.color, composite(values.error!.background, panel), 4.5], ["warning notice text", values.warning!.color, composite(values.warning!.background, panel), 4.5], ["focus border", values.focus!.border, panel, 3],
    ] as Array<[string, number[], number[], number]>) { const ratio = contrast(foreground, surface); result.contrasts.push({ family, mode, label, ratio, minimum }); assert(ratio >= minimum, `${family}/${mode}: ${label} contrast ${ratio.toFixed(2)} meets ${minimum}:1`); }
    assert(values.focusVisible && values.focus!.borderStyle === "solid" && Number.parseFloat(values.focus!.borderWidth) > 0 && values.focus!.borderWidth === values.select!.borderWidth && values.focus!.outlineStyle === "none", `${family}/${mode}: keyboard-visible select focus preserves the existing border thickness without an added outline`);
  }
  async function capture(family: Family, mode: Mode): Promise<void> { const output = path.join(resolved, "qualification", "themes"); await mkdir(output, { recursive: true }); await evaluate("document.fonts.ready"); await evaluate("document.activeElement.blur();document.getElementById('page-content').scrollTop=0"); await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true }); await new Promise(resolve => setTimeout(resolve, 100)); const png = (await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG(), filename = path.join(output, `${family}-${mode}.png`); if (png.length < 1000) throw new Error("Theme screenshot is unexpectedly empty"); await writeFile(filename, png); result.screenshots.push({ family, mode, filename, sha256: createHash("sha256").update(png).digest("hex") }); }
  let failure: unknown, overrideCss: string | undefined;
  try {
    assert(await evaluate("typeof require==='undefined'&&document.documentElement.lang==='en'"), "theme interface retains the sandbox and English-only document language");
    await settings();
    assert(await evaluate("document.getElementById('theme-family').closest('label').querySelector('.field-label').textContent==='Theme'&&document.getElementById('color-mode').closest('label').querySelector('.field-label').textContent==='Color mode'&&[...document.getElementById('theme-family').options].map(option=>option.value).join(',')==='one,aura'&&[...document.getElementById('color-mode').options].map(option=>option.value).join(',')==='system,light,dark'"), "Appearance exposes independent, labelled One/Aura theme and System/Light/Dark mode controls");
    for (const family of ["one", "aura"] as const) for (const mode of ["light", "dark"] as const) {
      nativeTheme.themeSource = mode === "light" ? "dark" : "light"; await save(family, mode); await colors(family, mode); await capture(family, mode);
      await evaluate("window.__deltaThemeBeforeReload=true"); window.webContents.reload();
      await waitFor(`!!document.querySelector('.empty-mark')&&document.body.dataset.themeFamily===${JSON.stringify(family)}&&document.body.dataset.theme===${JSON.stringify(mode)}&&!window.__deltaThemeBeforeReload`, `persisted ${family}/${mode} appearance after renderer reload`);
      await settings(); assert(await evaluate(`document.getElementById('theme-family').value===${JSON.stringify(family)}&&document.getElementById('color-mode').value===${JSON.stringify(mode)}`), `${family}/${mode}: persisted selections are restored after reloading the actual renderer`);
    }
    for (const family of ["one", "aura"] as const) {
      await save(family, "system"); const saved = await ownPreferences();
      for (const mode of ["light", "dark"] as const) { nativeTheme.themeSource = mode; await waitFor(`matchMedia('(prefers-color-scheme: dark)').matches===${mode === "dark"}`, `live ${mode} system appearance`); await colors(family, mode); assert(await evaluate("!document.body.hasAttribute('data-theme')") && (await current()).revision === saved.revision, `${family}/system/${mode}: native appearance changes the palette without a save or preference mutation`); }
    }
    overrideCss = await window.webContents.insertCSS(":root { --accent: rgb(17, 31, 47); } body { --bg: rgb(17, 31, 47); }", { cssOrigin: "author" });
    for (const [family, mode] of [["one", "light"], ["aura", "dark"]] as const) {
      await save(family, mode); const value = await inspect();
      assert(isDeepStrictEqual(value.body!.background.slice(0, 3), [17, 31, 47]), `${family}/${mode}: body stylesheet variables keep precedence when the saved theme changes`);
      assert(await evaluate("getComputedStyle(document.body).getPropertyValue('--accent').replace(/\\s+/g,'')==='rgb(17,31,47)'"), `${family}/${mode}: root stylesheet variables inherit into the body across saved theme changes`);
    }
    await window.webContents.removeInsertedCSS(overrideCss); overrideCss = undefined;
    const unmodified = await inspect(); assert(isDeepStrictEqual(unmodified.body!.background.slice(0, 3), expectedBackgrounds.aura.dark), "removing the isolated user-style override restores the selected Aura dark palette");
    assert(result.screenshots.length === 4, "four authentic settings screenshots preserve One and Aura in both color modes");
  } catch (error) { failure = error; }
  finally {
    const restorationErrors: unknown[] = [];
    if (overrideCss) try { await window.webContents.removeInsertedCSS(overrideCss); overrideCss = undefined; } catch (error) { restorationErrors.push(error); }
    try { const before = await ownPreferences(), saved = await evaluate<Preferences>(`window.delta.request({action:'app-save',revision:${JSON.stringify(before.revision)},value:${JSON.stringify(initial.value)}})`); ownedRevision = saved.revision; await click("refresh"); await click("home"); await waitFor("document.getElementById('main').dataset.view==='home'&&!!document.querySelector('.empty-mark')", "restored original Home view"); const restored = await current(); result.originalPreferencesRestored = restored.revision === ownedRevision && isDeepStrictEqual(restored.value, initial.value); if (!result.originalPreferencesRestored || !(await readFile(markerFile)).equals(markerBytes)) throw new Error("Original theme preferences or ownership marker were not restored"); } catch (error) { restorationErrors.push(error); }
    try { nativeTheme.themeSource = source; result.nativeThemeRestored = nativeTheme.themeSource === source; if (!result.nativeThemeRestored) throw new Error("Original Electron theme source was not restored"); } catch (error) { restorationErrors.push(error); }
    if (restorationErrors.length) throw new AggregateError([...(failure ? [failure] : []), ...restorationErrors], `Theme qualification or restoration failed after ${result.assertions.length} assertions`);
  }
  if (failure) throw new Error(`${failure instanceof Error ? failure.message : String(failure)}; completed ${result.assertions.length} theme assertions`, { cause: failure });
  assert(result.originalPreferencesRestored && result.nativeThemeRestored, "original isolated application preferences and Electron theme source are restored");
  return result;
}
