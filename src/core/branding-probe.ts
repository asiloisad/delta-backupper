import { nativeTheme, type BrowserWindow } from "electron";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

interface Preferences { revision: string; value: Record<string, unknown> }
export interface UiBrandingQualification {
  assertions: string[];
  platform: string;
  applicationVersion: string;
  screenshots: Array<{ view: "welcome" | "about"; theme: "light" | "dark"; filename: string; sha256: string }>;
  originalPreferencesRestored: boolean;
  nativeThemeRestored: boolean;
  scope: string;
}

/** Test-only: an empty, explicitly owned profile prevents changes to a user's tasks or login settings. */
export async function qualifyUiBranding(window: BrowserWindow, configDirectory: string): Promise<UiBrandingQualification> {
  const configured = process.argv.find(argument => argument.startsWith("--delta-config-dir="))?.slice("--delta-config-dir=".length);
  if (!process.argv.includes("--delta-ui-branding") || !process.argv.some(argument => argument.startsWith("--delta-smoke-report=")) || !process.argv.some(argument => argument.startsWith("--stage0-profile=")) || !configured || path.resolve(configured) !== path.resolve(configDirectory)) throw new Error("Branding qualification requires its explicit isolated profile and smoke flags");
  const directoryInfo = await lstat(configDirectory), markerFile = path.join(configDirectory, ".branding-qualification.json"), markerInfo = await lstat(markerFile);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink() || !markerInfo.isFile() || markerInfo.isSymbolicLink() || markerInfo.size > 4096) throw new Error("Branding qualification requires an owned ordinary configuration directory and marker");
  const marker = JSON.parse(await readFile(markerFile, "utf8"));
  if (marker.schemaVersion !== 1 || marker.kind !== "delta-ui-branding-qualification" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(marker.id)) throw new Error("Branding qualification ownership marker is invalid");
  const product = JSON.parse(await readFile(path.join(__dirname, "package.json"), "utf8")) as { name?: unknown; version?: unknown; license?: unknown };
  if (product.name !== "delta-backupper" || product.license !== "MIT" || typeof product.version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(product.version)) throw new Error("Branding qualification requires the generated Delta Backupper product manifest");
  const result: UiBrandingQualification = { assertions: [], platform: process.platform, applicationVersion: product.version, screenshots: [], originalPreferencesRestored: false, nativeThemeRestored: false, scope: "Actual packaged or development Electron renderer, local SVG decoding, explicit and system theme variants, About metadata checked against the generated product manifest and authentic empty-profile screenshots. Isolated preferences and Electron theme source are restored; no backup, login-item or OS notification changes." };
  const assert = (condition: unknown, message: string) => { if (!condition) throw new Error(message); result.assertions.push(message); };
  const evaluate = async <T = unknown>(code: string): Promise<T> => window.webContents.executeJavaScript(code) as Promise<T>;
  async function waitFor(code: string, description: string) {
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) { if (window.isDestroyed()) throw new Error(`Window destroyed while waiting for ${description}`); if (await evaluate(code)) return; await new Promise(resolve => setTimeout(resolve, 40)); }
    throw new Error(`Timed out waiting for ${description}`);
  }
  const bootstrap = await evaluate<{ tasks: unknown[]; app: Preferences }>("window.delta.request({action:'bootstrap'})");
  assert(bootstrap.tasks.length === 0 && bootstrap.app.value.launchAtLogin === false, "branding fixture has no remembered tasks and cannot enable login startup");
  const initial = bootstrap.app, nativeThemeSource = nativeTheme.themeSource;
  let ownedRevision = initial.revision;
  async function writePreferences(value: Record<string, unknown>): Promise<Preferences> {
    const current = await evaluate<Preferences>("window.delta.request({action:'bootstrap'}).then(result=>result.app)");
    if (current.revision !== ownedRevision) throw new Error("Branding preferences changed unexpectedly; refusing to overwrite a different revision");
    const saved = await evaluate<Preferences>(`window.delta.request({action:'app-save',revision:${JSON.stringify(current.revision)},value:${JSON.stringify(value)}})`); ownedRevision = saved.revision; return saved;
  }
  async function click(id: string) { await evaluate(`(() => {const button=document.getElementById(${JSON.stringify(id)});if(!(button instanceof HTMLButtonElement)||button.disabled)throw new Error('Branding qualification control unavailable');button.click()})()`); }
  async function showWelcome(theme: "light" | "dark" | "system", system: "light" | "dark") {
    nativeTheme.themeSource = system;
    await writePreferences({ ...initial.value, theme }); await click("refresh"); await click("home");
    await waitFor(`document.getElementById('main').dataset.view==='home'&&!!document.querySelector('.empty-mark')&&${theme === "system" ? "!document.body.hasAttribute('data-theme')" : `document.body.dataset.theme===${JSON.stringify(theme)}`}`, `${theme} welcome theme`);
    await waitFor(`matchMedia('(prefers-color-scheme: dark)').matches===${system === "dark"}`, `${system} Electron system appearance`);
  }
  async function checkMarks(view: "welcome" | "about", expected: "light" | "dark") {
    const inspection = await evaluate<any>(`(async () => {
      const marks=[...document.querySelectorAll('.brand-logo')]; await Promise.all(marks.flatMap(mark=>[...mark.querySelectorAll('img')].map(image=>image.decode())));
      const expectedFiles=['logo.svg','logo-light.svg'];
      return {title:document.title,windowTitle:document.getElementById('window-title').textContent,sidebarBrand:!!document.querySelector('.sidebar .brand-logo,.sidebar .brand-wordmark,.sidebar .brand-mark'),marks:marks.map(mark=>{
        const images=[...mark.querySelectorAll('img')],visible=images.filter(image=>getComputedStyle(image).display!=='none');const bounds=mark.getBoundingClientRect();
        return {classes:mark.className,decorative:mark.getAttribute('aria-hidden')==='true'&&images.every(image=>image.alt===''),decoded:images.length===2&&images.every((image,index)=>image.naturalWidth>0&&image.naturalHeight>0&&decodeURI(image.src)===decodeURI(new URL('assets/branding/'+expectedFiles[index],location.href).href)),variant:visible.length===1?(visible[0].classList.contains('brand-logo-light')?'dark':'light'):'invalid',width:bounds.width,height:bounds.height,imageFits:visible.length===1&&Math.abs(visible[0].getBoundingClientRect().width-bounds.width)<1&&Math.abs(visible[0].getBoundingClientRect().height-bounds.height)<1};
      })};
    })()`);
    assert(inspection.title === "Delta Backupper" && inspection.windowTitle === "Delta Backupper" && !inspection.sidebarBrand, `${view} ${expected}: the titlebar identifies Delta Backupper without duplicate sidebar branding`);
    assert(inspection.marks.length === 2 && inspection.marks.every((mark: any) => mark.decoded && mark.decorative), `${view} ${expected}: all four local SVG images decode and decorative logos avoid duplicate accessible names`);
    assert(inspection.marks.every((mark: any) => mark.variant === expected && mark.imageFits && mark.width === mark.height && mark.width > 0), `${view} ${expected}: one correct logo variant fills each square mark without layout distortion`);
    assert(inspection.marks.some((mark: any) => mark.classes.includes("titlebar-logo") && mark.width === 20) && inspection.marks.some((mark: any) => mark.classes.includes(view === "welcome" ? "empty-mark" : "about-mark") && mark.width === (view === "welcome" ? 88 : 64)), `${view} ${expected}: titlebar and page use the intended logo dimensions`);
  }
  async function capture(view: "welcome" | "about", theme: "light" | "dark") {
    const output = path.join(configDirectory, "qualification", "branding"); await mkdir(output, { recursive: true });
    await window.webContents.executeJavaScript("document.fonts.ready"); await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true }); await new Promise(resolve => setTimeout(resolve, 150));
    const png = (await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG(), filename = path.join(output, `${view}-${theme}.png`); if (png.length < 1000) throw new Error("Branding screenshot is unexpectedly empty"); await writeFile(filename, png); result.screenshots.push({ view, theme, filename, sha256: createHash("sha256").update(png).digest("hex") });
  }
  let failure: unknown;
  try {
    assert(await evaluate("typeof require==='undefined'&&document.documentElement.lang==='en'"), "branded interface retains the sandbox and English-only document language");
    assert(await evaluate("(() => {const button=document.getElementById('about'),mark=button?.querySelector('.brand-logo.titlebar-logo');return button instanceof HTMLButtonElement&&!button.disabled&&button.tabIndex===0&&button.closest('#titlebar')!==null&&button.title==='About'&&button.getAttribute('aria-label')==='About Delta Backupper'&&!!mark&&getComputedStyle(button).getPropertyValue('-webkit-app-region')==='no-drag'&&getComputedStyle(button).cursor==='pointer'})()"), "titlebar logo is a keyboard-accessible About button with an About tooltip and pointer cursor outside the drag region");
    assert(await evaluate("document.querySelector('.sidebar-footer #about')===null&&document.getElementById('task-groups')===null&&!document.querySelector('.sidebar-footer').textContent.includes('About Delta Backupper')"), "sidebar contains task defaults and application settings without duplicate About or linked views controls");
    for (const theme of ["light", "dark"] as const) {
      await showWelcome(theme, theme === "light" ? "dark" : "light"); await checkMarks("welcome", theme); await capture("welcome", theme);
      assert(await evaluate("document.querySelector('.empty h1').textContent==='Delta Backupper'&&!!document.getElementById('new-task')&&!!document.getElementById('discover-task')"), `welcome ${theme}: product identity accompanies real task creation and discovery controls`);
      await click("about"); await waitFor("document.getElementById('main').dataset.view==='about'&&!document.getElementById('main').hasAttribute('aria-busy')&&!!document.querySelector('.about-content .details')", `${theme} runtime About metadata`);
      const information = await evaluate<{ version: string; license: string; platform: string }>("window.delta.request({action:'application-info'})");
      assert(information.version === product.version && information.license === product.license && information.platform === process.platform, `about ${theme}: metadata matches the generated Delta Backupper product version, MIT license and platform`);
      assert(await evaluate(`(() => {const values=Object.fromEntries([...document.querySelectorAll('.about-content .details dt')].map(term=>[term.textContent,term.nextElementSibling.textContent]));return document.querySelector('#main > .about-brand h1').textContent==='Delta Backupper'&&values.Version===${JSON.stringify(information.version)}&&values.License==='MIT'&&values.Platform===${JSON.stringify(({ win32: "Windows", linux: "Linux", darwin: "macOS" } as Record<string, string>)[process.platform] ?? process.platform)}})()`), `about ${theme}: actual runtime details are rendered in the branded page`);
      await checkMarks("about", theme); await capture("about", theme);
    }
    for (const system of ["light", "dark"] as const) { await showWelcome("system", system); await checkMarks("welcome", system); }
    assert(result.screenshots.length === 4, "authentic light and dark welcome and About screenshots are preserved");
  } catch (error) { failure = error; }
  finally {
    const restorationErrors: unknown[] = [];
    try {
      const saved = await writePreferences(initial.value); await click("refresh"); await click("home");
      await waitFor(`!!document.querySelector('.empty-mark')&&${initial.value.theme === "system" ? "!document.body.hasAttribute('data-theme')" : `document.body.dataset.theme===${JSON.stringify(initial.value.theme)}`}`, "original rendered theme");
      const restored = await evaluate<Preferences>("window.delta.request({action:'bootstrap'}).then(result=>result.app)");
      result.originalPreferencesRestored = restored.revision === saved.revision && JSON.stringify(restored.value) === JSON.stringify(initial.value); if (!result.originalPreferencesRestored) throw new Error("Original branding preferences were not restored");
    } catch (error) { restorationErrors.push(error); }
    try { nativeTheme.themeSource = nativeThemeSource; result.nativeThemeRestored = nativeTheme.themeSource === nativeThemeSource; if (!result.nativeThemeRestored) throw new Error("Original Electron theme source was not restored"); } catch (error) { restorationErrors.push(error); }
    if (restorationErrors.length) throw new AggregateError([...(failure ? [failure] : []), ...restorationErrors], `Branding qualification or restoration failed after ${result.assertions.length} assertions`);
  }
  if (failure) throw new Error(`${failure instanceof Error ? failure.message : String(failure)}; completed ${result.assertions.length} branding assertions`, { cause: failure });
  assert(result.originalPreferencesRestored && result.nativeThemeRestored, "original isolated application preferences and Electron theme source are restored");
  return result;
}
