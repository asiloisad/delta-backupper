import type { BrowserWindow } from "electron";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

interface Preferences { revision: string; value: Record<string, unknown> }
interface UpdateSettings { repository: string; checkOnStartup: boolean; includePrereleases: boolean }
interface UpdateQualification {
  assertions: string[];
  platform: string;
  scope: string;
  requests: string[];
  openedUrls: string[];
  originalPreferencesRestored: boolean;
  outstandingRequests: number;
  screenshot: string;
  screenshotSha256: string;
}

/** Injected responses exercise the actual renderer, IPC and release checker without contacting GitHub or opening a browser. */
export async function createUpdateQualificationTransport(configDirectory: string): Promise<{ fetch: typeof fetch; openExternal: (url: string) => Promise<void>; qualify: (window: BrowserWindow) => Promise<unknown> }> {
  const argument = (name: string): string => {
    const matches = process.argv.filter(value => value.startsWith(`${name}=`));
    if (matches.length !== 1 || !matches[0]!.slice(name.length + 1)) throw new Error(`Update qualification requires one explicit ${name} path`);
    return path.resolve(matches[0]!.slice(name.length + 1));
  };
  const configured = argument("--delta-config-dir"), profile = argument("--stage0-profile"), report = argument("--delta-smoke-report"), resolved = path.resolve(configDirectory);
  if (!process.argv.includes("--delta-ui-updates") || configured !== resolved) throw new Error("Update qualification requires its explicit isolated profile and smoke flags");
  const fixture = path.dirname(resolved);
  for (const target of [profile, report]) { const relative = path.relative(fixture, target); if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || target === resolved) throw new Error("Update qualification profile and report must belong to its isolated fixture"); }
  const directory = await lstat(resolved), markerFile = path.join(resolved, ".updates-qualification.json"), markerInfo = await lstat(markerFile);
  if (!directory.isDirectory() || directory.isSymbolicLink() || await realpath(resolved) !== resolved || !markerInfo.isFile() || markerInfo.isSymbolicLink() || markerInfo.size > 4096) throw new Error("Update qualification requires an owned ordinary configuration directory and marker");
  const markerBytes = await readFile(markerFile), marker = JSON.parse(markerBytes.toString("utf8"));
  if (marker.schemaVersion !== 1 || marker.kind !== "delta-updates-qualification" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(marker.id)) throw new Error("Update qualification ownership marker is invalid");
  async function ordinaryDocument(name: string): Promise<Record<string, unknown>> { const filename = path.join(resolved, name), info = await lstat(filename); if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) throw new Error(`Update qualification requires an ordinary ${name}`); return JSON.parse(await readFile(filename, "utf8")); }
  const initialApp = (await ordinaryDocument("config.json")).application as Record<string, unknown>, registry = await ordinaryDocument("tasks.json");
  if (initialApp.launchAtLogin !== false || !Array.isArray(registry) || registry.length !== 0) throw new Error("Update qualification requires an empty task catalogue in the current format with login startup disabled");
  const requests: string[] = [], openedUrls: string[] = [];
  let pending = 0;
  const expectedReleaseUrl = "https://github.com/delta-qualification/available/releases/tag/v1.2.3";
  const fixtureFetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url), method = init?.method ?? (typeof input === "object" && "method" in input ? input.method : "GET");
    const route = /^\/repos\/delta-qualification\/(empty|available|missing|offline)\/releases$/.exec(url.pathname);
    if (url.origin !== "https://api.github.com" || url.username || url.password || url.hash || method !== "GET" || !route || [...url.searchParams.keys()].some(key => key !== "per_page" && key !== "page") || (url.searchParams.has("per_page") && url.searchParams.get("per_page") !== "100") || (url.searchParams.has("page") && !/^[1-9]\d{0,2}$/.test(url.searchParams.get("page")!))) throw new Error("Qualification transport rejected an unexpected GitHub endpoint");
    init?.signal?.throwIfAborted(); requests.push(url.href); pending++;
    try {
      await new Promise(resolve => setTimeout(resolve, 60)); init?.signal?.throwIfAborted();
      if (route[1] === "offline") throw new Error("Isolated qualification transport is offline");
      if (route[1] === "missing") return new Response(JSON.stringify({ message: "Not Found" }), { status: 404, headers: { "content-type": "application/json" } });
      const releases = route[1] === "available" ? [{ tag_name: "v1.2.3", name: "Delta 1.2.3", draft: false, prerelease: false, published_at: "2026-10-01T12:00:00Z", html_url: expectedReleaseUrl }] : [];
      return new Response(JSON.stringify(releases), { status: 200, headers: { "content-type": "application/json" } });
    } finally { pending--; }
  };
  async function openExternal(url: string): Promise<void> { if (url !== expectedReleaseUrl) throw new Error("Qualification browser rejected an unexpected release URL"); openedUrls.push(url); }
  async function qualify(window: BrowserWindow): Promise<UpdateQualification> {
    const result: UpdateQualification = { assertions: [], platform: process.platform, scope: "Actual Electron renderer, settings form, sandbox IPC and main-process GitHub release checker, with injected empty, available, unavailable and offline GitHub responses. Browser opening is captured by an injected transport. No live GitHub requests, tags, releases, downloads, installer execution, login items or OS notification changes.", requests, openedUrls, originalPreferencesRestored: false, outstandingRequests: 0, screenshot: "", screenshotSha256: "" };
    const assert = (condition: unknown, message: string): void => { if (!condition) throw new Error(message); result.assertions.push(message); };
    const evaluate = async <T = unknown>(code: string): Promise<T> => window.webContents.executeJavaScript(code) as Promise<T>;
    async function waitFor(code: string, description: string): Promise<void> { const end = Date.now() + 12_000; while (Date.now() < end) { if (window.isDestroyed()) throw new Error(`Update qualification window destroyed while waiting for ${description}`); if (await evaluate(code)) return; await new Promise(resolve => setTimeout(resolve, 40)); } throw new Error(`Timed out waiting for ${description}`); }
    async function click(id: string): Promise<void> { await evaluate(`(() => {const control=document.getElementById(${JSON.stringify(id)});if(!(control instanceof HTMLButtonElement)||control.disabled)throw new Error('Update qualification control unavailable: '+${JSON.stringify(id)});control.click()})()`); }
    async function current(): Promise<Preferences> { return evaluate("window.delta.request({action:'bootstrap'}).then(value=>value.app)"); }
    const bootstrap = await evaluate<{ tasks: unknown[]; app: Preferences }>("window.delta.request({action:'bootstrap'})");
    assert(bootstrap.tasks.length === 0 && bootstrap.app.value.launchAtLogin === false, "owned update fixture has no remembered tasks and login startup is disabled");
    assert(requests.length === 0 && pending === 0, "qualification starts without background network requests");
    assert(await evaluate("typeof require==='undefined'&&document.documentElement.lang==='en'"), "update interface remains sandboxed and English-only");
    const initial = bootstrap.app; let ownedRevision = initial.revision;
    async function assertRevision(): Promise<Preferences> { const document = await current(); if (document.revision !== ownedRevision) throw new Error("Update qualification preferences changed unexpectedly; refusing to overwrite a different revision"); return document; }
    async function settings(options: UpdateSettings): Promise<void> {
      const before = await assertRevision(); await click("app-settings");
      await waitFor("document.getElementById('main').dataset.view==='application-settings'&&!document.getElementById('main').hasAttribute('aria-busy')&&!!document.getElementById('update-repository')", "current update settings form");
      await evaluate(`(() => {document.getElementById('update-repository').value=${JSON.stringify(options.repository)};document.getElementById('update-prereleases').checked=${options.includePrereleases};document.getElementById('update-startup').checked=${options.checkOnStartup};document.querySelector('#main form').requestSubmit()})()`);
      await waitFor(`window.delta.request({action:'bootstrap'}).then(value=>value.app.revision!==${JSON.stringify(before.revision)})`, "saved update settings through real UI and IPC");
      await waitFor("[...document.querySelectorAll('#main button')].some(button=>button.textContent==='Save settings'&&!button.disabled)", "settings save completion");
      const saved = await current(); ownedRevision = saved.revision;
      assert(isDeepStrictEqual(saved.value, { ...initial.value, updates: options }), `settings form saves ${options.repository} and update options while preserving every other preference`);
      assert(saved.value.launchAtLogin === false, `${options.repository}: updating preferences keeps operating-system login startup disabled`);
    }
    async function about(expected: string): Promise<void> { await click("about"); await waitFor(`document.getElementById('main').dataset.view==='about'&&!document.getElementById('main').hasAttribute('aria-busy')&&document.getElementById('updates-card')?.dataset.status===${JSON.stringify(expected)}`, `${expected} rendered update status`); }
    async function check(expected: string): Promise<void> { await click("update-check"); await waitFor(`document.getElementById('updates-card')?.dataset.status===${JSON.stringify(expected)}&&!document.getElementById('updates-card').hasAttribute('aria-busy')&&!document.getElementById('update-check').disabled`, `${expected} completed manual release check`); }
    let failure: unknown;
    try {
      await about("not-configured");
      assert(await evaluate("document.getElementById('update-check').disabled&&document.getElementById('update-open').hidden&&document.getElementById('update-status').textContent.includes('Preproduction')"), "unconfigured preproduction is a normal rendered state without a release link or enabled network check");
      assert(await evaluate("document.getElementById('update-status').getAttribute('role')==='status'&&document.getElementById('update-status').getAttribute('aria-live')==='polite'"), "update status is announced politely through an accessible live region");
      assert(requests.length === 0, "opening About reads cached update state without contacting GitHub");
      const unconfigured = await evaluate<{ status: string }>("window.delta.request({action:'updates-check'})");
      assert(unconfigured.status === "not-configured" && requests.length === 0, "manual IPC check with no repository performs no request");
      await settings({ repository: "delta-qualification/empty", checkOnStartup: true, includePrereleases: true }); await about("not-checked");
      assert(requests.length === 0, "saving startup preference during qualification does not issue a background check");
      await check("no-releases");
      assert(requests.length === 1 && await evaluate("document.getElementById('update-status').textContent.includes('No published releases')&&document.getElementById('update-open').hidden&&!document.querySelector('#notification[role=alert]:not([hidden])')"), "a repository without releases renders the expected preproduction status without an error notification");
      await settings({ repository: "delta-qualification/available", checkOnStartup: false, includePrereleases: false }); await about("not-checked");
      assert(await evaluate("document.getElementById('update-open').hidden"), "changing the configured repository invalidates its previous release state");
      await check("available");
      assert(requests.length === 2 && await evaluate("document.getElementById('update-status').textContent.includes('1.2.3')&&!document.getElementById('update-open').hidden"), "a newer release is rendered with its version and an explicit View release action");
      await click("update-open"); await waitFor("!document.getElementById('update-open').disabled", "captured release browser action");
      assert(openedUrls.length === 1 && openedUrls[0] === expectedReleaseUrl, "View release passes only the main-process verified GitHub release URL to the captured browser transport");
      const output = path.join(resolved, "qualification", "updates"); await mkdir(output, { recursive: true }); await evaluate("document.fonts.ready"); await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true }); await new Promise(resolve => setTimeout(resolve, 100)); const png = (await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG(); result.screenshot = path.join(output, "available-release.png"); result.screenshotSha256 = createHash("sha256").update(png).digest("hex"); await writeFile(result.screenshot, png);
      assert(png.length > 1000, "an authentic screenshot captures the actual available-release interface");
      await settings({ repository: "delta-qualification/missing", checkOnStartup: false, includePrereleases: false }); await about("not-checked"); await check("unavailable");
      assert(requests.length === 3 && await evaluate("document.getElementById('update-open').hidden&&!document.getElementById('update-status').textContent.includes('latest published version')"), "an unavailable repository is distinct from an empty repository or an up-to-date application");
      await settings({ repository: "delta-qualification/offline", checkOnStartup: false, includePrereleases: false }); await about("not-checked"); await check("error");
      assert(requests.length === 4 && await evaluate("document.getElementById('update-open').hidden&&document.getElementById('update-status').textContent.includes('Could not check')"), "a failed transport leaves a retryable inline check status without an available release action");
      assert(pending === 0 && requests.every(value => new URL(value).origin === "https://api.github.com"), "all injected requests have settled and target only the permitted public GitHub API origin");
    } catch (error) { failure = error; }
    finally {
      try {
        const currentApp = await assertRevision();
        const saved = await evaluate<Preferences>(`window.delta.request({action:'app-save',revision:${JSON.stringify(currentApp.revision)},value:${JSON.stringify(initial.value)}})`); ownedRevision = saved.revision;
        await click("refresh"); await click("home"); await waitFor("document.getElementById('main').dataset.view==='home'&&!!document.querySelector('.empty-mark')", "restored original Home view");
        const restored = await current(); result.originalPreferencesRestored = restored.revision === ownedRevision && isDeepStrictEqual(restored.value, initial.value); if (!result.originalPreferencesRestored) throw new Error("Original update qualification preferences were not restored");
        const markerNow = await readFile(markerFile); if (!markerNow.equals(markerBytes)) throw new Error("Update qualification ownership marker changed");
        result.outstandingRequests = pending; if (pending !== 0) throw new Error("Update qualification left outstanding injected requests");
      } catch (restoration) { throw new AggregateError([...(failure ? [failure] : []), restoration], `Update qualification or restoration failed after ${result.assertions.length} assertions`); }
    }
    if (failure) throw new Error(`${failure instanceof Error ? failure.message : String(failure)}; completed ${result.assertions.length} update assertions`, { cause: failure });
    assert(result.originalPreferencesRestored && result.outstandingRequests === 0, "original isolated application preferences are restored and no injected request remains active");
    return result;
  }
  return { fetch: fixtureFetch, openExternal, qualify };
}
