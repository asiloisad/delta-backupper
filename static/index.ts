import type { TaskConfig, TaskSettings } from "../src/domain/models.js";
import type { LoadedTask, TaskListing } from "../src/config/index.js";
import type { RestorePlan } from "../src/engine/index.mjs";
import type { DashboardSnapshot } from "../src/service/dashboard.js";
import { ProgressTiming, formatDuration } from "./progress-time.js";

type Operation = { id: string; taskId: string; action: string; status: string; paused?: boolean; startedAt?: string; finishedAt?: string; progress?: Record<string, unknown>; result?: unknown; error?: unknown };
type Page = "home" | "task" | "draft" | "application-settings" | "task-defaults" | "about";
type FormSettings = TaskSettings & Partial<Pick<TaskConfig, "srcs">>;
type SettingsEditor = (() => FormSettings) & { preview(): FormSettings };
type TaskDraft = { name: string; directory: string; settings: FormSettings };
type Request = { action: string; [key: string]: unknown };
type WindowState = { platform: string; maximized: boolean; fullscreen: boolean };
type UpdateResult = { status: "not-configured" | "not-checked" | "no-releases" | "up-to-date" | "available" | "unavailable" | "error" | "rate-limited"; currentVersion: string; repository: string; includePrereleases: boolean; checkedAt?: string; release?: { version: string; tag: string; name: string; url: string; publishedAt: string }; message?: string; retryAt?: string };
declare global { interface Window { delta: { request(request: Request): Promise<any>; onProgress(listener: (operation: Operation) => void): () => void; onWindowState(listener: (state: WindowState) => void): () => void; onStylesError(listener: (message: string) => void): () => void; onNavigate(listener: (destination: { taskId: string; tab: "activity" }) => void): () => void } } }
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] => {
  const element = document.createElement(tag); if (element instanceof HTMLFormElement) element.noValidate = true; if (text !== undefined) element.textContent = text; if (className) element.className = className; return element;
};
const state: { app: any; defaults: any; tasks: TaskListing[]; operations: Operation[]; selected: string | null; tab: string; loaded: LoadedTask | null; runId: string | null; filesOffset: number; filesQuery: string; selectedFiles: Set<string>; viewToken: number; page: Page; draft: TaskDraft | null } = {
  app: null, defaults: null, tasks: [], operations: [], selected: null, tab: "overview", loaded: null, runId: null, filesOffset: 0, filesQuery: "", selectedFiles: new Set(), viewToken: 0, page: "home", draft: null,
};
let notificationTimer: ReturnType<typeof setTimeout> | undefined;
type Editor = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
const notificationEditors = new Set<Editor>();
const progressTiming = new ProgressTiming();
function dismissNotification(): void {
  clearTimeout(notificationTimer); $("notification").hidden = true;
  for (const editor of notificationEditors) { editor.removeAttribute("aria-invalid"); editor.removeAttribute("aria-errormessage"); }
  notificationEditors.clear();
}
function placeNotification(): void {
  const dialog = $<HTMLDialogElement>("dialog"), host = dialog.open ? dialog : document.body;
  if ($("notification").parentElement !== host) host.append($("notification"));
}
function notify(message: string, error = false, editors: Editor[] = []): void {
  dismissNotification(); placeNotification();
  for (const editor of editors) if (error && editor.isConnected) { notificationEditors.add(editor); editor.setAttribute("aria-invalid", "true"); editor.setAttribute("aria-errormessage", "notification"); }
  const el = $("notification"); el.setAttribute("role", error ? "alert" : "status"); el.textContent = message; el.dataset.error = String(error); el.hidden = false;
  notificationTimer = setTimeout(dismissNotification, error ? 14000 : 6000);
}
function fieldError(message: string, ...editors: Editor[]): Error { return Object.assign(new Error(message), { editors }); }
function notifyError(error: unknown, ...editors: Editor[]): void {
  const attached = (error as { editors?: Editor[] } | null)?.editors ?? [], fields = [...attached, ...editors];
  notify(errorText(error), true, fields); const first = fields.find(editor => editor.isConnected);
  first?.scrollIntoView({ block: "nearest" });
  if (first?.disabled) queueMicrotask(() => { if (notificationEditors.has(first)) first.focus({ preventScroll: true }); });
  else first?.focus({ preventScroll: true });
}
function unavailableDestination(error: unknown): boolean {
  return /DestinationUnavailableError|DESTINATION_UNAVAILABLE|The destination folder is unavailable/.test(errorText(error));
}
function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === "object" && error !== null && "message" in error ? String(error.message) : String(error);
  if (/DestinationUnavailableError|DESTINATION_UNAVAILABLE/.test(message)) return "The destination folder is unavailable. Choose an existing folder or reconnect its drive.";
  return message.replace(/^Error invoking remote method '[^']+':\s*/, "");
}
function button(text: string, action: () => unknown | Promise<unknown>, className = ""): HTMLButtonElement {
  const el = node("button", text, className); el.type = "button";
  if (text) el.dataset.focusKey = `button:${text}`;
  el.addEventListener("click", async () => { el.disabled = true; el.dataset.pending = "true"; try { await action(); } catch (error) { if (!el.isConnected) return; notifyError(error); } finally { delete el.dataset.pending; if (el.isConnected) el.disabled = false; } }); return el;
}
function retainFocus(root: HTMLElement): () => void {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || !root.contains(active)) return () => {};
  const key = active.dataset.focusKey, id = active.id;
  return () => {
    if (document.activeElement !== document.body && document.activeElement !== active) return;
    const replacement = id ? document.getElementById(id) : key ? [...root.querySelectorAll<HTMLElement>("[data-focus-key]")].find(element => element.dataset.focusKey === key) : undefined;
    if (replacement && !(replacement instanceof HTMLButtonElement && replacement.disabled)) replacement.focus({ preventScroll: true });
  };
}
function focusMain(): void { (document.getElementById("page-content") ?? $("main")).focus({ preventScroll: true }); }
function enterPage(page: Page): void { if (state.page === "draft" && page !== "draft") state.draft = null; state.page = page; $("home").setAttribute("aria-current", page === "home" ? "page" : "false"); renderTaskList(); }
let pageResizeObserver: ResizeObserver | undefined;
function pageLayout(header: HTMLElement | null, tabs?: HTMLElement, label = "Page content"): HTMLElement {
  pageResizeObserver?.disconnect(); const main = $("main"), content = node("div", undefined, "page-content"); content.id = "page-content"; content.tabIndex = -1; content.setAttribute("role", "region"); content.setAttribute("aria-label", label); main.setAttribute("aria-label", label.replace(/ content$/, "")); header?.classList.toggle("has-tabs", !!tabs); main.replaceChildren(...(header ? [header] : []), ...(tabs ? [tabs] : []), content);
  const alignChrome = () => {
    if (!content.isConnected) return; const style = getComputedStyle(content), box = content.getBoundingClientRect(), workspace = main.getBoundingClientRect(), borderLeft = parseFloat(style.borderLeftWidth) || 0, borderRight = parseFloat(style.borderRightWidth) || 0, gutter = Math.max(0, content.offsetWidth - content.clientWidth - borderLeft - borderRight), leftGutter = Math.max(0, content.clientLeft - borderLeft);
    const insets = { left: box.left - workspace.left + borderLeft + (parseFloat(style.paddingLeft) || 0) + leftGutter, right: workspace.right - box.right + borderRight + (parseFloat(style.paddingRight) || 0) + Math.max(0, gutter - leftGutter) };
    for (const side of ["left", "right"] as const) { const value = `${Math.round(insets[side] * 1000) / 1000}px`, property = `--page-content-inset-${side}`; if (main.style.getPropertyValue(property) !== value) main.style.setProperty(property, value); }
  };
  pageResizeObserver = new ResizeObserver(alignChrome); pageResizeObserver.observe(content); alignChrome(); return content;
}
async function renderCurrentPage(): Promise<void> { if (state.page === "home") await renderHome(); else if (state.page === "draft") { if (!document.getElementById("draft-form")) renderDraft(); } else if (state.page === "application-settings") await appSettings(); else if (state.page === "task-defaults") await defaultsSettings(); else if (state.page === "about") await aboutApplication(); else await renderPage(); }
async function request(action: string, values: Record<string, unknown> = {}): Promise<any> { return window.delta.request({ action, ...values }); }
function selectedTask(): TaskListing | undefined { return state.tasks.find(task => task.id === state.selected); }
function taskName(id: string): string { return state.tasks.find(task => task.id === id)?.name ?? id; }
function statusLabel(status: string): string { return ({ queued: "Queued", running: "Running", complete: "Complete", completed: "Complete", incomplete: "Incomplete", failed: "Failed", cancelled: "Cancelled" } as Record<string, string>)[status] ?? status; }
function activeOperation(operation: Operation): boolean { return ["queued", "running"].includes(operation.status); }
function pausableOperation(operation: Operation): boolean { return activeOperation(operation) && ["run", "resume", "retry"].includes(operation.action); }
function operationStatus(operation: Operation): string { return activeOperation(operation) && operation.paused ? "Paused" : statusLabel(operation.status); }
function operationTitle(operation: Operation): string { return ({ run: "Backup", restore: "Restore", "restore-plan": "Restore preview", verify: "Verification", resume: "Resume backup", retry: "Retry files", retention: "Retention cleanup", delete: "Remove backup" } as Record<string, string>)[operation.action] ?? operation.action; }
function setText(element: HTMLElement, text: string): void { if (element.textContent !== text) element.textContent = text; }
function badge(text: string, status?: string): HTMLElement { return node("span", text, `badge${status === "failed" ? " error" : status === "incomplete" || status === "cancelled" ? " warning" : ""}`); }
function formatDate(value: unknown): string { if (typeof value !== "string") return "—"; const date = new Date(value); return Number.isNaN(date.valueOf()) ? value : date.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }); }
function bytes(value: unknown): string { let number = Number(value ?? 0); if (!Number.isFinite(number)) return "—"; const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"]; let index = 0; while (number >= 1024 && index < units.length - 1) { number /= 1024; index++; } return `${number.toLocaleString("en-GB", { maximumFractionDigits: index ? 1 : 0 })} ${units[index]}`; }
function heading(title: string, subtitle = "", actions: HTMLElement[] = []): HTMLElement {
  const header = node("header", undefined, "page-header"), text = node("div"); text.append(node("h1", title)); if (subtitle) text.append(node("p", subtitle, "subtitle")); header.append(text);
  if (actions.length) { const toolbar = node("div", undefined, "toolbar"); toolbar.append(...actions); header.append(toolbar); } return header;
}
function card(title?: string): HTMLElement { const el = node("section", undefined, "card"); if (title) el.append(node("h2", title)); return el; }
function brandLogo(className: string): HTMLElement {
  const mark = node("span", undefined, `brand-logo ${className}`); mark.setAttribute("aria-hidden", "true");
  for (const [file, variant] of [["logo.svg", "color"], ["logo-light.svg", "light"]]) { const image = node("img"); image.src = `assets/branding/${file}`; image.alt = ""; image.className = `brand-logo-${variant}`; mark.append(image); }
  return mark;
}
function notice(text: string, kind = ""): HTMLElement { return node("div", text, `notice ${kind}`); }
function metric(label: string, value: string): HTMLElement { const el = card(); el.append(node("span", label, "metric-label"), node("span", value, "metric-value")); return el; }
function detailList(values: Array<[string, string]>): HTMLElement { const el = node("dl", undefined, "details"); for (const [key, value] of values) el.append(node("dt", key), node("dd", value)); return el; }
function syncNativeTitlebar(): void { void request("window", { command: "sync-titlebar" }).catch(error => console.error("Native titlebar:", error)); }
function applyTheme(): void { const theme = state.app?.value?.theme ?? "system"; document.body.dataset.themeFamily = state.app?.value?.themeFamily ?? "one"; if (theme === "system") delete document.body.dataset.theme; else document.body.dataset.theme = theme; syncNativeTitlebar(); }
async function refresh(preserve = true): Promise<void> {
  const previousDirectory = preserve ? selectedTask()?.directory : undefined;
  const result = await request("bootstrap"); state.app = result.app; state.defaults = result.defaults; state.tasks = result.tasks ?? []; state.operations = result.operations ?? []; const now = performance.now(); for (const operation of state.operations) progressTiming.observe(operation, now); progressTiming.forget(state.operations.map(operation => operation.id));
  if (!preserve || !state.tasks.some(task => task.id === state.selected)) state.selected = (previousDirectory ? state.tasks.find(task => task.directory === previousDirectory)?.id : undefined) ?? state.tasks[0]?.id ?? null;
  state.loaded = selectedTask()?.task ?? null; applyTheme(); renderTaskList(); await renderCurrentPage();
}
function renderTaskList(): void {
  const root = $("task-list"), restoreFocus = retainFocus(root), existing = new Map([...root.querySelectorAll<HTMLButtonElement>(":scope > .task-item")].map(element => [element.dataset.taskId, element])), retained = new Set<HTMLElement>();
  state.tasks.forEach((task, index) => {
    let el = existing.get(task.id);
    if (!el) {
      const id = task.id; el = button("", async () => { const current = state.tasks.find(item => item.id === id); if (!current) return; state.selected = id; state.tab = "overview"; state.runId = null; state.selectedFiles.clear(); state.loaded = current.task ?? null; enterPage("task"); await renderPage(); }, "task-item");
      el.dataset.taskId = id; el.append(node("span", undefined, "task-name"), node("span", undefined, "task-status"));
    }
    const operation = state.operations.find(item => item.taskId === task.id && activeOperation(item)), selected = task.id === state.selected && state.page === "task";
    const status = el.querySelector<HTMLElement>(".task-status")!; status.dataset.indicator = String(!operation);
    setText(el.querySelector<HTMLElement>(".task-name")!, task.name); setText(status, operation ? operationStatus(operation) : !task.available ? "Destination unavailable" : "Ready to run");
    el.classList.toggle("selected", selected); el.dataset.focusKey = `task:${task.directory}`; el.setAttribute("aria-current", selected ? "page" : "false"); retained.add(el); if (root.children[index] !== el) root.insertBefore(el, root.children[index] ?? null);
  });
  for (const child of [...root.children]) if (!retained.has(child as HTMLElement)) child.remove();
  if (!state.tasks.length) root.append(node("p", "Add your first task or discover an existing backup folder.", "muted")); restoreFocus();
}
async function renderPage(): Promise<void> {
  enterPage("task");
  const token = ++state.viewToken, main = $("main"), restoreFocus = retainFocus(main); main.dataset.view = "task"; main.removeAttribute("aria-busy"); main.replaceChildren(); const listing = selectedTask();
  try {
  if (!listing) { await renderHome(); return; }
  if (!listing.available || !listing.task) {
    state.loaded = null; const content = pageLayout(heading(listing.name, listing.directory), undefined, "Unavailable task content"), unavailable = card("Task configuration unavailable");
    unavailable.append(notice("Connect the destination or select its new location to read this task’s settings and backup history.", "warning"), detailList([["Task file", listing.id], ["Destination", listing.directory]])); if (listing.error) unavailable.append(node("p", listing.error, "field-hint")); const actions = node("div", undefined, "toolbar"); if (state.tab === "overview") actions.append(button("Open backup folder", () => request("task-open-folder", { reference: listing.id }))); actions.append(button("Relink destination", relink), button("Forget task", forget, "danger")); unavailable.append(actions); content.append(unavailable); return;
  }
  const task = state.loaded?.value ?? listing.task.value;
  const runButton = button("Run backup", () => { const running = state.operations.find(item => item.taskId === listing.id && activeOperation(item)); return running ? cancelOperation(running) : runTask(); }, "primary"); runButton.id = "task-run";
  const pause = button("Pause", () => { const running = state.operations.find(item => item.taskId === listing.id && activeOperation(item)); return running && pauseOperation(running); }); pause.id = "task-pause";
  const openBackupFolder = button("Open backup folder", () => request("task-open-folder", { reference: listing.id })); openBackupFolder.id = "task-open-folder"; openBackupFolder.title = "Open this task’s backup folder in your file manager.";
  const saveButton = state.tab === "settings" ? node("button", "Save settings", "primary") : undefined;
  if (saveButton) { saveButton.id = "task-save"; saveButton.type = "submit"; saveButton.setAttribute("form", "task-settings-form"); saveButton.disabled = true; }
  const pageHeader = heading(task.name, listing.directory, state.tab === "overview" ? [openBackupFolder, pause, runButton] : saveButton ? [saveButton] : []);
  const tabs = node("nav", undefined, "tabs"); tabs.setAttribute("role", "tablist"); tabs.setAttribute("aria-label", "Task views");
  for (const [key, label] of [["overview", "Overview"], ["settings", "Settings"], ["history", "History"], ["files", "Restore"], ["activity", "Activity"], ["manage", "Manage"]]) {
    const tab = button(label!, async () => { state.tab = key!; await renderPage(); $("task-tab-" + key).focus({ preventScroll: true }); }, state.tab === key ? "active" : "");
    tab.dataset.label = label!; tab.replaceChildren(node("span", label!, "tab-label"));
    tab.id = `task-tab-${key}`; tab.setAttribute("role", "tab"); tab.setAttribute("aria-selected", String(state.tab === key)); tab.setAttribute("aria-controls", "task-panel"); tab.tabIndex = state.tab === key ? 0 : -1; tabs.append(tab);
  }
  tabs.addEventListener("keydown", event => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key) || !(event.target instanceof HTMLButtonElement)) return;
    const buttons = [...tabs.querySelectorAll<HTMLButtonElement>("[role=tab]")], index = buttons.indexOf(event.target);
    if (index < 0) return; event.preventDefault();
    const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next]!.click();
  });
  const scroll = pageLayout(pageHeader, tabs, "Task content"), content = node("div"); content.id = "task-panel"; content.setAttribute("role", "tabpanel"); content.setAttribute("aria-labelledby", `task-tab-${state.tab}`); content.tabIndex = 0; scroll.append(content);
  patchTaskHeader();
  if (state.tab === "overview") renderOverview(content, task, listing);
  if (state.tab === "settings") {
    state.loaded = await request("load", { reference: listing.id }); if (token !== state.viewToken) return;
    renderTaskEditor(content, state.loaded!.value, async patch => { await request("save", { reference: listing.id, revision: state.loaded!.revision, patch }); notify("Task settings saved."); await refresh(); }, saveButton!);
  }
  if (state.tab === "history") await renderHistory(content, token);
  if (state.tab === "files") await renderFiles(content, token);
  if (state.tab === "activity") renderActivity(content);
  if (state.tab === "manage") renderManage(content, listing);
  } finally { if (token === state.viewToken) restoreFocus(); }
}
let homeDashboard: DashboardSnapshot | undefined, homeDashboardError: string | undefined, homeDashboardRequest = 0;
let homeUpdateTimer: ReturnType<typeof setTimeout> | undefined, homeHistoryDirty = false;
function homeCount(value: unknown): number | undefined { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined; }
function homeElapsed(operation: Operation): string { const start = Date.parse(operation.startedAt ?? ""); if (!Number.isFinite(start)) return ""; const seconds = Math.floor(Math.max(0, Date.now() - start) / 1000), hours = Math.floor(seconds / 3600); return `${operation.status === "queued" ? "Queued" : "Elapsed"} ${hours ? `${hours}:` : ""}${String(Math.floor(seconds / 60) % 60).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`; }
function operationTiming(operation: Operation): HTMLElement {
  const root = node("span", undefined, "operation-timing"), elapsed = node("span", undefined, "operation-elapsed"), estimated = node("span", undefined, "operation-estimated"); root.dataset.timingOperationId = operation.id; root.append(elapsed, estimated); patchOperationTiming(root, operation); return root;
}
function patchOperationTiming(root: HTMLElement, operation: Operation): void {
  const remaining = progressTiming.remaining(operation, performance.now()), estimated = root.querySelector<HTMLElement>(".operation-estimated")!;
  setText(root.querySelector<HTMLElement>(".operation-elapsed")!, homeElapsed(operation)); setText(estimated, `Estimated ${remaining === undefined ? "—" : formatDuration(Math.ceil(remaining))}`);
  estimated.title = operation.paused ? "Estimated time remaining is unavailable while paused." : remaining === undefined ? "Estimated time remaining will appear once the total work and processing rate are known." : "Estimated time remaining, based on the current processing rate.";
}
function homePhase(value: unknown): string { return typeof value === "string" && value ? ({ scan: "Scanning sources", backup: "Writing backup", restore: "Restoring files", verify: "Verifying backup", snapshot: "Preparing source snapshots", retention: "Cleaning backup cycles", warning: "Continuing with a warning" } as Record<string, string>)[value] ?? value.replaceAll(/[-_]/g, " ").replace(/^./, first => first.toUpperCase()) : "Working"; }
async function openTask(reference: string, tab = "overview"): Promise<void> { const listing = state.tasks.find(task => task.id === reference); if (!listing) return; state.selected = reference; state.loaded = listing.task ?? null; state.tab = tab; enterPage("task"); await renderPage(); }
function homeOperation(operation: Operation): HTMLElement {
  const root = node("article", undefined, "home-operation"), header = node("div", undefined, "home-operation-header"), identity = node("div"), name = taskName(operation.taskId); root.dataset.operationId = operation.id;
  const open = button(name, () => openTask(operation.taskId, "activity"), "home-task-link"), kind = node("span", undefined, "home-operation-kind"); open.dataset.focusKey = `home-task:${operation.taskId}`; identity.append(open, kind);
  const controls = operationControls(operation); header.append(identity, controls.root); root.append(header);
  const phase = node("p", undefined, "home-phase"), bar = progressBar(), meta = node("div", undefined, "home-progress-meta"), counts = node("span", undefined, "home-counts"), time = operationTiming(operation), currentPath = node("p", undefined, "home-path"), message = node("p", undefined, "home-operation-message"); meta.append(counts, time); root.append(phase, bar, meta, currentPath, message);
  homeOperationViews.set(root, { open, kind, phase, bar, counts, time, currentPath, message, controls }); patchHomeOperation(root, operation); return root;
}
type OperationControls = { root: HTMLElement; pause: HTMLButtonElement; cancel: HTMLButtonElement };
type HomeOperationView = { open: HTMLButtonElement; kind: HTMLElement; phase: HTMLElement; bar: HTMLDivElement; counts: HTMLElement; time: HTMLElement; currentPath: HTMLElement; message: HTMLElement; controls: OperationControls };
const homeOperationViews = new WeakMap<HTMLElement, HomeOperationView>();
function operationControls(operation: Operation): OperationControls {
  const root = node("div", undefined, "operation-controls"), pause = button("Pause", () => { const current = state.operations.find(item => item.id === operation.id); return current && pauseOperation(current); }), cancel = button("Cancel", () => { const current = state.operations.find(item => item.id === operation.id); return current && cancelOperation(current); });
  pause.dataset.focusKey = `pause:${operation.id}`; pause.dataset.operationAction = "pause"; cancel.dataset.focusKey = `cancel:${operation.id}`; cancel.dataset.operationAction = "cancel"; root.append(pause, cancel); const controls = { root, pause, cancel }; patchOperationControls(controls, operation); return controls;
}
function patchOperationControls(controls: OperationControls, operation: Operation): void {
  controls.root.hidden = !activeOperation(operation); controls.pause.hidden = !pausableOperation(operation);
  const verb = operation.paused ? "Resume" : "Pause"; setText(controls.pause, verb); controls.pause.setAttribute("aria-label", `${verb} backup for ${taskName(operation.taskId)}`); controls.cancel.setAttribute("aria-label", `Cancel operation for ${taskName(operation.taskId)}`);
}
function operationProgress(operation: Operation): { ratio?: number; counts: string; phase: string; currentPath: string; message: string } {
  const progress = operation.progress ?? {}, files = homeCount(progress.completedFiles) ?? homeCount(progress.files), size = homeCount(progress.completedBytes) ?? homeCount(progress.bytes), totalFiles = homeCount(progress.totalFiles), totalBytes = homeCount(progress.totalBytes); let ratio: number | undefined;
  if (operation.status === "running") { if (size !== undefined && totalBytes !== undefined && totalBytes > 0 && size <= totalBytes) ratio = size / totalBytes; else if (files !== undefined && totalFiles !== undefined && totalFiles > 0 && files <= totalFiles) ratio = files / totalFiles; }
  const phase = operation.paused && activeOperation(operation) ? "Paused" : operation.status === "queued" ? "Queued" : homePhase(progress.phase), counts = [files !== undefined ? `${files.toLocaleString("en-GB")}${totalFiles !== undefined && totalFiles >= files ? ` / ${totalFiles.toLocaleString("en-GB")}` : ""} files` : "", size !== undefined ? bytes(size) : ""].filter(Boolean).join(" · ") || (operation.paused ? "Backup paused" : operation.status === "queued" ? "Waiting for an available worker" : "Waiting for progress…");
  return { ratio, counts, phase, currentPath: typeof progress.path === "string" ? progress.path : "", message: typeof progress.message === "string" ? progress.message : "" };
}
function progressBar(): HTMLDivElement {
  const bar = node("div", undefined, "operation-progress"), fill = node("div", undefined, "operation-progress-fill");
  bar.setAttribute("role", "progressbar"); bar.setAttribute("aria-valuemin", "0"); bar.setAttribute("aria-valuemax", "100"); fill.setAttribute("aria-hidden", "true"); bar.append(fill); return bar;
}
function patchProgressBar(bar: HTMLDivElement, operation: Operation, progress: ReturnType<typeof operationProgress>): void {
  const ratio = progress.ratio, text = ratio === undefined ? `${progress.phase} · ${progress.counts}` : `${Math.floor(ratio * 100)}% · ${progress.counts}`;
  if (ratio === undefined) bar.removeAttribute("aria-valuenow");
  else { const value = String(ratio); if (bar.style.getPropertyValue("--progress-ratio") !== value) bar.style.setProperty("--progress-ratio", value); bar.setAttribute("aria-valuenow", String(ratio * 100)); }
  // Keep the same fill and animation timeline as file/counter updates arrive.
  bar.dataset.operationId = operation.id; bar.dataset.mode = ratio === undefined ? "indeterminate" : "determinate"; bar.dataset.paused = String(!!operation.paused); bar.dataset.status = operation.status; bar.setAttribute("aria-label", `Operation progress for ${taskName(operation.taskId)}`); if (bar.getAttribute("aria-valuetext") !== text) bar.setAttribute("aria-valuetext", text);
}
function patchHomeOperation(root: HTMLElement, operation: Operation): void {
  const view = homeOperationViews.get(root)!; const name = taskName(operation.taskId), progress = operationProgress(operation); setText(view.open, name); view.open.title = name; setText(view.kind, `${operationTitle(operation)} · ${operationStatus(operation)}`); setText(view.phase, progress.phase); patchProgressBar(view.bar, operation, progress); setText(view.counts, `${progress.ratio === undefined ? "" : `${Math.floor(progress.ratio * 100)}% · `}${progress.counts}`); patchOperationTiming(view.time, operation); setText(view.currentPath, progress.currentPath); view.currentPath.title = progress.currentPath; view.currentPath.hidden = !progress.currentPath; setText(view.message, progress.message); view.message.hidden = !progress.message; patchOperationControls(view.controls, operation); root.dataset.paused = String(!!operation.paused);
}
function reconcileOperationElements(container: HTMLElement, operations: Operation[], create: (operation: Operation) => HTMLElement, patch: (root: HTMLElement, operation: Operation) => void): void {
  const existing = new Map([...container.children].filter((element): element is HTMLElement => element instanceof HTMLElement).map(element => [element.dataset.operationId, element])), retained = new Set<HTMLElement>();
  operations.forEach((operation, index) => { const element = existing.get(operation.id) ?? create(operation); patch(element, operation); retained.add(element); if (container.children[index] !== element) container.insertBefore(element, container.children[index] ?? null); });
  for (const element of [...container.children]) if (!retained.has(element as HTMLElement)) element.remove();
}
function renderHomeActivity(): void {
  if (state.page !== "home" || $("main").dataset.view !== "home" || !document.getElementById("home-current")) return;
  const active = state.operations.filter(activeOperation), running = active.filter(operation => operation.status === "running" && !operation.paused).length, paused = active.filter(operation => operation.paused).length, queued = active.filter(operation => operation.status === "queued" && !operation.paused).length, metrics = $("home-metrics");
  const values: Array<[string, string]> = [["TASKS", String(state.tasks.length)], ["ACTIVE OPERATIONS", String(active.length)], ["RECENT ISSUES", homeDashboard ? String(homeDashboard.recent.filter(run => ["failed", "incomplete"].includes(run.status)).length) : "—"], ["UNAVAILABLE DESTINATIONS", String(state.tasks.filter(task => !task.available).length)]];
  values.forEach(([label, value], index) => { let item = metrics.children[index] as HTMLElement | undefined; if (!item) { item = metric(label, value); metrics.append(item); } else setText(item.querySelector<HTMLElement>(".metric-value")!, value); });
  setText($("home-live-summary"), `${running} running · ${queued} queued${paused ? ` · ${paused} paused` : ""}${state.app?.value?.schedulerPaused ? " · Schedules paused" : ""}`);
  const current = $("home-current"), restoreFocus = retainFocus(current); let list = current.querySelector<HTMLElement>(".home-active-list"); if (!list) { const empty = node("p", "No operations are running.", "muted"); empty.id = "home-no-operations"; list = node("div", undefined, "home-active-list"); const more = node("p", undefined, "muted"); more.id = "home-more-operations"; current.append(empty, list, more); }
  reconcileOperationElements(list, [...active].sort((a, b) => Number(a.status !== "running") - Number(b.status !== "running")).slice(0, 20), homeOperation, patchHomeOperation); list.hidden = !active.length; $("home-no-operations").hidden = active.length > 0; const more = $("home-more-operations"); more.hidden = active.length <= 20; setText(more, `${active.length - 20} more operations are active. Select a task to see its activity.`); restoreFocus();
}
function renderHomeRecent(): void {
  const root = document.getElementById("home-recent"); if (!root || state.page !== "home") return; const restoreFocus = retainFocus(root); root.replaceChildren();
  if (homeDashboardError) root.append(notice(`Could not refresh recent activity. ${homeDashboardError}`, "error"));
  if (homeDashboard) {
    if (!homeDashboard.recent.length) root.append(node("p", "No finished backups yet. Backup results will appear here.", "muted"));
    else { const table = node("table", undefined, "home-recent-table"), head = node("thead"), tr = node("tr"); for (const label of ["Task", "Result", "Files", "Size", "Finished"]) tr.append(node("th", label)); head.append(tr); const body = node("tbody");
      for (const run of homeDashboard.recent.slice(0, 20)) { const row = node("tr"), name = node("td"), result = node("td"), link = button(run.taskName, () => openTask(run.taskId, "history"), "home-task-link"); row.dataset.runId = run.id; row.dataset.taskId = run.taskId; link.dataset.focusKey = `home-run:${run.id}`; link.disabled = !state.tasks.some(task => task.id === run.taskId); name.append(link); result.append(badge(statusLabel(run.status), run.status)); if (run.error) { const error = node("span", run.error, "home-result-error"); error.title = run.error; result.append(error); } row.append(name, result, node("td", run.files.toLocaleString("en-GB")), node("td", bytes(run.bytes)), node("td", formatDate(run.finishedAt ?? run.startedAt))); body.append(row); }
      table.append(head, body); const wrapper = node("div", undefined, "home-recent-scroll"); wrapper.append(table); root.append(wrapper);
    }
    if (homeDashboard.errors.length) { const warning = notice("Some recent results could not be read.", "warning"), list = node("ul"); for (const error of homeDashboard.errors.slice(0, 10)) list.append(node("li", `${error.taskId ? `${taskName(error.taskId)}: ` : ""}${error.message}`)); warning.append(list); root.append(warning); }
  } else if (!homeDashboardError) root.append(node("p", "Loading recent activity…", "muted")); restoreFocus();
}
async function loadHomeDashboard(token: number): Promise<void> {
  const generation = ++homeDashboardRequest, recent = document.getElementById("home-recent"); recent?.setAttribute("aria-busy", "true");
  try { const value = await request("dashboard") as DashboardSnapshot; if (generation !== homeDashboardRequest || token !== state.viewToken || state.page !== "home") return; homeDashboard = value; homeDashboardError = undefined; renderHomeActivity(); renderHomeRecent(); }
  catch (error) { if (generation === homeDashboardRequest && token === state.viewToken && state.page === "home") { homeDashboardError = errorText(error); renderHomeRecent(); } }
  finally { if (generation === homeDashboardRequest && token === state.viewToken) document.getElementById("home-recent")?.removeAttribute("aria-busy"); }
}
async function renderHome(): Promise<void> {
  enterPage("home"); const token = ++state.viewToken, main = $("main"), restoreFocus = retainFocus(main); main.dataset.view = "home"; main.removeAttribute("aria-busy");
  if (document.getElementById("home-current")) { renderHomeActivity(); renderHomeRecent(); restoreFocus(); void loadHomeDashboard(token); return; }
  const content = pageLayout(null, undefined, "Home content");
  if (!state.tasks.length && !state.operations.some(operation => ["running", "queued"].includes(operation.status))) { const empty = node("section", undefined, "empty"); empty.append(brandLogo("empty-mark"), node("h1", "Delta Backupper"), node("p", "Your files. Peace of mind.", "empty-tagline"), node("p", "Create a task, choose your sources and a backup folder. Each destination has its own history and standard ZIP archives.", "muted")); content.append(empty); restoreFocus(); return; }
  const metrics = node("div", undefined, "card-grid home-metrics"); metrics.id = "home-metrics"; const active = card("Current activity"), summary = node("p", undefined, "home-live-summary"), operations = node("div"); summary.id = "home-live-summary"; summary.setAttribute("role", "status"); summary.setAttribute("aria-live", "polite"); operations.id = "home-current"; active.append(summary, operations); const recent = card("Recent backups"), results = node("div"); results.id = "home-recent"; recent.append(results); content.append(metrics, active, recent); renderHomeActivity(); renderHomeRecent(); restoreFocus(); void loadHomeDashboard(token);
}
function queueHomeUpdate(refreshHistory = false): void { homeHistoryDirty ||= refreshHistory; if (homeUpdateTimer) return; homeUpdateTimer = setTimeout(() => { homeUpdateTimer = undefined; if (state.page !== "home" || $("main").dataset.view !== "home") { homeHistoryDirty = false; return; } if (!document.getElementById("home-current") && state.operations.some(operation => ["running", "queued"].includes(operation.status))) { homeHistoryDirty = false; void renderHome(); return; } renderHomeActivity(); if (homeHistoryDirty) { homeHistoryDirty = false; void loadHomeDashboard(state.viewToken); } }, 200); }
setInterval(() => { for (const element of document.querySelectorAll<HTMLElement>(".operation-timing[data-timing-operation-id]")) { const operation = state.operations.find(value => value.id === element.dataset.timingOperationId); if (operation && activeOperation(operation)) patchOperationTiming(element, operation); } }, 1000);
function scheduleSummary(schedule: TaskSettings["schedules"][number]): string {
  const weekdays = schedule.weekdays.map(day => ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][day - 1]).join(", ");
  const timing = ({ manual: "No timed runs", interval: `Every ${schedule.intervalMinutes} min`, daily: `Daily at ${schedule.time}`, weekly: `${weekdays || "No weekdays"} at ${schedule.time}` } as Record<string, string>)[schedule.kind];
  return `${schedule.paused ? "Paused" : "Active"} · ${timing}${schedule.kind === "manual" ? "" : ` · ${schedule.timeZone}`}${schedule.onDestinationAvailable ? " · On destination reconnect" : ""}`;
}
function renderOverview(parent: HTMLElement, task: TaskConfig, listing: TaskListing): void {
  const metrics = node("div", undefined, "card-grid"); metrics.append(metric("SOURCES", String(task.sources.length)), metric("CHANGE DETECTION", task.detection === "fast" ? "Size and time" : "Content hash"), metric("ARCHIVE", "ZIP")); parent.append(metrics);
  const active = state.operations.filter(operation => operation.taskId === selectedTask()?.id && activeOperation(operation)), current = card("Current operation"), operations = node("div"); current.id = "task-current-operation"; operations.dataset.operationList = "overview"; current.hidden = !active.length; reconcileOperationElements(operations, active, operationElement, patchOperationElement); current.append(operations); parent.append(current);
  const sourceCard = card("Protected sources"); if (!task.sources.length) sourceCard.append(node("p", "No sources selected. Add them in the task settings.", "muted")); else for (const source of task.sources) sourceCard.append(node("p", source.path, "path-cell")); parent.append(sourceCard);
  const settings = card("Backup policy"), activeSchedules = task.schedules.filter(schedule => !schedule.paused && (schedule.kind !== "manual" || schedule.onDestinationAvailable)); settings.append(detailList([["Schedules", task.schedulesPaused ? "Schedules paused" : activeSchedules.length ? `${activeSchedules.length} active · ${task.schedules.length} configured` : "Manual only"], ["Sequence", task.sequence.types.map(type => ({ full: "F", incremental: "I", differential: "D" })[type]).join("")], ["Retention", `${task.retention.when === "before" ? "Before backup" : "After backup"}; ${task.retention.keepCycles ? `${task.retention.keepCycles} cycles` : "no cycle limit"}; ${task.retention.maxAgeDays ? `${task.retention.maxAgeDays} days` : "no age limit"}`], ["Links", ({ follow: "Follow targets", skip: "Skip" })[task.symlinks]], ["Source snapshots", ({ off: "Off", "snapshot-only": "File system snapshot", writers: "Windows VSS writers" })[task.snapshot.mode]]])); for (const schedule of task.schedules) settings.append(node("h3", schedule.name), node("p", scheduleSummary(schedule), "field-hint")); parent.append(settings);
  if (!listing.available) parent.prepend(notice("Other tasks and destinations operate independently of this device."));
}
function renderManage(parent: HTMLElement, listing: TaskListing): void {
  const active = state.operations.some(operation => operation.taskId === listing.id && activeOperation(operation));
  const actions = card("Manage task"), toolbar = node("div", undefined, "toolbar"), retention = button("Run retention now…", () => retentionDialog()); retention.id = "task-retention"; retention.disabled = !listing.available || active; toolbar.append(button("Duplicate", () => duplicateDialog()), button("Relink destination", () => relink()), retention, button("Forget task", () => forget(), "danger")); actions.append(toolbar, node("p", "Forgetting a task removes it from this application. Backup files remain in the destination folder.", "field-hint")); parent.append(actions);
}
async function runTask(action = "run", runId?: string): Promise<void> {
  const reference = state.selected; if (!reference) return;
  const operation = await request(action, { reference, runId }); addOperation(operation); state.tab = "activity"; await renderPage();
}
let operationUpdateTimer: ReturnType<typeof setTimeout> | undefined;
function queueOperationUpdate(): void { if (operationUpdateTimer) return; operationUpdateTimer = setTimeout(() => { operationUpdateTimer = undefined; renderTaskList(); patchTaskOperations(); }, 100); }
function addOperation(operation: Operation): void { if (!operation?.id) return; progressTiming.observe(operation, performance.now()); const index = state.operations.findIndex(item => item.id === operation.id); if (index === -1) state.operations.unshift(operation); else state.operations[index] = operation; while (state.operations.length > 100) { const lastCompleted = state.operations.findLastIndex(item => !activeOperation(item)); if (lastCompleted < 0) break; state.operations.splice(lastCompleted, 1); } progressTiming.forget(state.operations.map(item => item.id)); queueOperationUpdate(); if (state.page === "home") queueHomeUpdate(!activeOperation(operation)); }
async function cancelOperation(operation: Operation): Promise<void> { await request("cancel", { operationId: operation.id }); notify("Cancellation requested."); }
async function pauseOperation(operation: Operation): Promise<void> { if (!pausableOperation(operation)) return; const paused = !operation.paused, result = await request(paused ? "pause" : "resume-operation", { operationId: operation.id }); if (result?.id) addOperation(result); notify(paused ? "Backup pause requested. Current file work may finish before the backup pauses." : "Backup resumed."); }
type OperationView = { title: HTMLElement; name: HTMLElement; status: HTMLElement; bar: HTMLDivElement; meta: HTMLElement; counts: HTMLElement; time: HTMLElement; controls: OperationControls; currentPath: HTMLElement; message: HTMLElement; error: HTMLElement; details: HTMLDetailsElement; result: HTMLElement; lastResult?: unknown };
const operationViews = new WeakMap<HTMLElement, OperationView>();
function operationElement(operation: Operation): HTMLElement {
  const el = node("div", undefined, "operation"), header = node("div", undefined, "operation-header"), label = node("div"), title = node("strong"), name = node("span", undefined, "muted"), status = badge(""), bar = progressBar(), meta = node("div", undefined, "progress-meta"), counts = node("span", undefined, "operation-counts"), time = operationTiming(operation), controls = operationControls(operation), currentPath = node("p", undefined, "field-hint operation-path"), message = node("p", undefined, "field-hint operation-message"), error = notice("", "error"), details = node("details"), result = node("pre");
  el.dataset.operationId = operation.id; label.append(title, name); header.append(label, status); meta.append(counts, time, controls.root); details.append(node("summary", "Result details"), result); el.append(header, bar, meta, currentPath, message, error, details); operationViews.set(el, { title, name, status, bar, meta, counts, time, controls, currentPath, message, error, details, result }); patchOperationElement(el, operation); return el;
}
function patchOperationElement(root: HTMLElement, operation: Operation): void {
  const view = operationViews.get(root)!, progress = operationProgress(operation); setText(view.title, operationTitle(operation)); setText(view.name, ` · ${taskName(operation.taskId)}`); setText(view.status, operationStatus(operation)); view.status.classList.toggle("error", operation.status === "failed"); view.status.classList.toggle("warning", ["incomplete", "cancelled"].includes(operation.status)); view.bar.hidden = !activeOperation(operation); view.meta.hidden = !activeOperation(operation); patchProgressBar(view.bar, operation, progress); setText(view.counts, `${progress.ratio === undefined ? "" : `${Math.floor(progress.ratio * 100)}% · `}${progress.counts}`); patchOperationTiming(view.time, operation); patchOperationControls(view.controls, operation);
  setText(view.currentPath, progress.currentPath || (activeOperation(operation) ? progress.phase : "")); view.currentPath.hidden = !view.currentPath.textContent; setText(view.message, progress.message); view.message.hidden = !progress.message; setText(view.error, operation.error ? errorText(operation.error) : ""); view.error.hidden = !operation.error;
  view.details.hidden = operation.result === undefined; if (operation.result !== undefined && view.lastResult !== operation.result) { setText(view.result, JSON.stringify(operation.result, null, 2)); view.lastResult = operation.result; } root.dataset.paused = String(!!operation.paused);
}
function patchTaskHeader(): void {
  if (state.page !== "task") return; const listing = selectedTask(), run = document.getElementById("task-run") as HTMLButtonElement | null, pause = document.getElementById("task-pause") as HTMLButtonElement | null; if (!listing || !run || !pause) return; const active = state.operations.find(operation => operation.taskId === listing.id && activeOperation(operation));
  setText(run, active ? "Cancel" : "Run backup"); run.classList.toggle("primary", !active); if (!run.dataset.pending) run.disabled = !listing.available; pause.hidden = !active || !pausableOperation(active); setText(pause, active?.paused ? "Resume" : "Pause"); pause.setAttribute("aria-label", `${active?.paused ? "Resume" : "Pause"} backup for ${listing.name}`);
}
function patchTaskOperations(): void {
  if (state.page !== "task" || $("main").dataset.view !== "task") return; patchTaskHeader(); const taskId = selectedTask()?.id, operations = state.operations.filter(operation => operation.taskId === taskId), active = operations.filter(activeOperation);
  const overview = document.querySelector<HTMLElement>('[data-operation-list="overview"]'); if (overview) { reconcileOperationElements(overview, active, operationElement, patchOperationElement); $("task-current-operation").hidden = !active.length; }
  const activity = document.querySelector<HTMLElement>('[data-operation-list="activity"]'); if (activity) { reconcileOperationElements(activity, operations, operationElement, patchOperationElement); $("task-no-operations").hidden = operations.length > 0; }
  const retention = document.getElementById("task-retention") as HTMLButtonElement | null; if (retention && !retention.dataset.pending) retention.disabled = !selectedTask()?.available || active.length > 0;
  for (const remove of document.querySelectorAll<HTMLButtonElement>('button[data-remove-run]')) { if (!remove.dataset.pending) remove.disabled = remove.dataset.pinned === "true" || active.length > 0; }
}
function renderActivity(parent: HTMLElement): void { const panel = card("Task activity"), operations = state.operations.filter(item => item.taskId === selectedTask()?.id), empty = node("p", "No operations in this session yet.", "muted"), list = node("div"); empty.id = "task-no-operations"; empty.hidden = operations.length > 0; list.dataset.operationList = "activity"; reconcileOperationElements(list, operations, operationElement, patchOperationElement); panel.append(empty, list); parent.append(panel); }
async function renderHistory(parent: HTMLElement, token: number): Promise<void> {
  if (!selectedTask()?.available) { parent.append(notice("Connect the destination to read its backup history.")); return; }
  const data = await request("history", { reference: state.selected }); if (token !== state.viewToken) return;
  const runs: any[] = [...(Array.isArray(data) ? data : data?.runs ?? [])].reverse();
  if (!runs.length) { parent.append(notice("No backups yet. Run the first full backup of this task.")); return; }
  const panel = card("Restore points"), wrapper = node("div", undefined, "table-scroll"), table = node("table"), head = node("thead"), header = node("tr"); table.setAttribute("aria-label", "Backup restore points"); ["Date", "Type", "Status", "Data", "Actions"].forEach(text => { const cell = node("th", text); cell.scope = "col"; header.append(cell); }); head.append(header); table.append(head); const body = node("tbody");
  for (const run of runs) {
    const row = node("tr"); row.dataset.runId = run.id; row.append(node("td", formatDate(run.startedAt)), node("td", ({ full: "Full", incremental: "Incremental", differential: "Differential" } as Record<string, string>)[run.type] ?? run.type)); const status = node("td"); status.append(badge(run.committed === false && run.status === "complete" ? "Uncommitted" : statusLabel(run.status), run.committed === false && run.status === "complete" ? "incomplete" : run.status)); if (run.pinned) status.append(node("span", " · pinned", "muted")); row.append(status, node("td", `${Number(run.files ?? 0).toLocaleString("en-GB")} files · ${bytes(run.bytes)}`));
    const actions = node("td"), toolbar = node("div", undefined, "toolbar");
    if (run.committed !== false && ["complete", "incomplete"].includes(run.status)) toolbar.append(button("Files", async () => { state.runId = run.id; state.filesOffset = 0; state.selectedFiles.clear(); state.tab = "files"; await renderPage(); }), button("Verify", () => verify(run.id)), button(run.pinned ? "Unpin" : "Pin", async () => { await request("pin", { reference: state.selected, runId: run.id, pinned: !run.pinned }); await renderPage(); }));
    toolbar.append(button("Details", () => runDetailsDialog(run.id)));
    if (run.committed === false || ["cancelled", "failed", "running"].includes(run.status)) toolbar.append(button("Resume", () => runTask("resume", run.id)));
    if (run.status === "incomplete") toolbar.append(button("Retry missing files", () => runTask("retry", run.id)));
    const remove = button("Remove", () => removeBackupDialog(run), "danger"); remove.dataset.removeRun = run.id; remove.dataset.pinned = String(!!run.pinned); remove.setAttribute("aria-label", `Remove backup from ${formatDate(run.startedAt)}`); remove.disabled = !!run.pinned || state.operations.some(operation => operation.taskId === state.selected && activeOperation(operation)); remove.title = run.pinned ? "Unpin this backup before removing it." : "Permanently remove this backup if no other restore point depends on it."; toolbar.append(remove);
    actions.append(toolbar); row.append(actions); body.append(row);
  }
  table.append(body); wrapper.append(table); panel.append(wrapper); parent.append(panel);
}
async function removeBackupDialog(run: { id: string; startedAt?: string; status: string; pinned?: boolean }): Promise<void> {
  const current = selectedTask(); if (!current?.available || run.pinned) return;
  await dialogForm("Remove backup", "Permanently remove this restore point and its archive data.", (body, close) => {
    body.append(detailList([["Task", current.name], ["Backup", run.id], ["Created", formatDate(run.startedAt)], ["Status", statusLabel(run.status)]]), notice("Delta refuses removal when the backup is pinned or another retained restore point depends on it. Other restore points are never removed automatically.", "warning"));
    return async () => { const operation = await request("delete", { reference: current.id, runId: run.id }); close(true); addOperation(operation); if (state.runId === run.id) { state.runId = null; state.selectedFiles.clear(); } state.tab = "activity"; await renderPage(); };
  }, "Remove backup");
}
async function runDetailsDialog(runId: string): Promise<void> {
  const details = await request("details", { reference: state.selected, runId });
  await dialogForm("Run details", `${formatDate(details.startedAt)} · ${statusLabel(details.status)}`, (body, close) => {
    body.append(detailList([["Archive", `${details.id}.zip`], ["Files", String(details.files ?? 0)], ["Bytes", bytes(details.bytes)], ["Missing versions", String(details.errors ?? 0)]]));
    if (details.error) body.append(notice(String(details.error), "error"));
    if (details.retentionError) body.append(notice(`Retention: ${details.retentionError}`, "warning"));
    if (details.cleanupError) body.append(notice(`Cleanup: ${details.cleanupError}`, "error"));
    for (const error of details.fileErrors ?? []) { const block = node("div", undefined, "operation"); block.append(node("p", String(error.path), "path-cell"), node("p", String(error.error), "muted")); body.append(block); }
    if (!details.errors && !details.error) body.append(notice("No missing file versions were reported."));
    return async () => { close(true); };
  }, "Close", { showCancel: false });
}
async function verify(runId: string): Promise<void> {
  const reference = state.selected; if (!reference) return;
  addOperation(await request("verify", { reference, runId })); state.tab = "activity"; await renderPage();
}
async function renderFiles(parent: HTMLElement, token: number): Promise<void> {
  if (!selectedTask()?.available) { parent.append(notice("Connect the destination to browse and restore files.")); return; }
  const data = await request("history", { reference: state.selected }); if (token !== state.viewToken) return;
  const runs: any[] = [...(Array.isArray(data) ? data : data?.runs ?? [])].reverse().filter(run => run.committed !== false && ["complete", "incomplete"].includes(run.status)); if (!runs.length) { parent.append(notice("No committed backup is available to restore. Complete or resume a run from History.")); return; }
  if (!runs.some(run => run.id === state.runId)) state.runId = runs.find(run => run.status === "complete" || run.status === "incomplete")?.id ?? runs[0].id;
  const panel = card("Restore files"); const picker = node("select"); picker.setAttribute("aria-label", "Restore point"); for (const run of runs) { const option = node("option", `${formatDate(run.startedAt)} · ${statusLabel(run.status)} · ${run.type}`); option.value = run.id; option.selected = run.id === state.runId; picker.append(option); } picker.addEventListener("change", () => { state.runId = picker.value; state.filesOffset = 0; state.selectedFiles.clear(); void renderPage().catch(error => notifyError(error)); }); panel.append(picker);
  const filter = node("div", undefined, "filter-bar"); filter.style.marginTop = "16px"; const query = node("input"); query.placeholder = "Search paths…"; query.value = state.filesQuery; query.setAttribute("aria-label", "Search files"); const search = async () => { state.filesQuery = query.value; state.filesOffset = 0; state.selectedFiles.clear(); await renderPage(); }; query.addEventListener("keydown", event => { if (event.key === "Enter") { event.preventDefault(); void search().catch(error => notifyError(error)); } }); filter.append(query, button("Search", search)); panel.append(filter); parent.append(panel);
  const result = await request("files", { reference: state.selected, runId: state.runId, offset: state.filesOffset, limit: 200, query: state.filesQuery }); if (token !== state.viewToken) return;
  const entries: any[] = Array.isArray(result) ? result : result.entries ?? []; const total = Number(result.total ?? entries.length);
  const controls = node("div", undefined, "toolbar"); controls.append(button("Restore entire backup…", () => restoreDialog()), button(`Restore selected (${state.selectedFiles.size})…`, () => restoreDialog([...state.selectedFiles]), "primary")); (controls.lastElementChild as HTMLButtonElement).disabled = state.selectedFiles.size === 0; panel.append(controls, node("p", `${total.toLocaleString("en-GB")} entries. Selections apply to paths in this restore point.`, "field-hint"));
  const wrapper = node("div", undefined, "table-scroll"), table = node("table"), head = node("thead"), header = node("tr"); table.setAttribute("aria-label", "Files in the selected restore point"); ["Selection", "Path", "Type", "Size"].forEach(text => { const cell = node("th", text); cell.scope = "col"; header.append(cell); }); head.append(header); table.append(head); const body = node("tbody");
  for (const entry of entries) { const row = node("tr"), checkCell = node("td"), input = node("input"); input.type = "checkbox"; const key = String(entry.path), displayPath = key; input.checked = state.selectedFiles.has(key); input.setAttribute("aria-label", `Select ${displayPath}`); input.addEventListener("change", () => { if (input.checked) state.selectedFiles.add(key); else state.selectedFiles.delete(key); const restore = controls.lastElementChild as HTMLButtonElement; restore.textContent = `Restore selected (${state.selectedFiles.size})…`; restore.disabled = !state.selectedFiles.size; }); checkCell.append(input); row.append(checkCell, node("td", displayPath, "path-cell"), node("td", ({ file: "File", directory: "Folder", symlink: "Link", missing: "Missing" } as Record<string, string>)[entry.kind] ?? String(entry.kind)), node("td", bytes(entry.size))); body.append(row); }
  table.append(body); wrapper.append(table); panel.append(wrapper); const pagination = node("div", undefined, "toolbar"); const previous = button("← Previous", async () => { state.filesOffset = Math.max(0, state.filesOffset - 200); await renderPage(); }); previous.disabled = state.filesOffset === 0; const next = button("Next →", async () => { state.filesOffset += 200; await renderPage(); }); next.disabled = state.filesOffset + entries.length >= total; pagination.append(previous, node("span", `${state.filesOffset + (entries.length ? 1 : 0)}–${state.filesOffset + entries.length} of ${total}`, "muted"), next); panel.append(pagination);
}
async function restoreDialog(paths?: string[]): Promise<void> {
  const reference = state.selected, runId = state.runId;
  let ownedPreview: { id: string; cancelRequested: boolean } | undefined, dialogActive = true, previewPolling = false;
  const cancelOwnedPreview = async () => { const current = ownedPreview; if (current) { current.cancelRequested = true; await request("cancel", { operationId: current.id }); if (!previewPolling && ownedPreview === current) ownedPreview = undefined; } };
  await dialogForm("Restore backup", "Choose an output directory and how to handle existing files.", (body, close) => {
    const destination = pathField(body, "Output directory", "", "Choose output folder");
    const overwrite = selectField(body, "Existing files", "error", [["error", "Report a file collision"], ["skip", "Skip existing files"], ["replace", "Replace existing files"]]);
    body.append(notice(paths?.length ? `Selected ${paths.length} paths.` : "The entire selected restore point will be restored."));
    const preview = node("section", undefined, "restore-preview"); preview.id = "restore-preview"; preview.setAttribute("aria-label", "Restore preview"); preview.setAttribute("aria-live", "polite"); preview.hidden = true;
    const previewStatus = node("p", "", "field-hint"); previewStatus.id = "restore-preview-status"; previewStatus.setAttribute("role", "status"); previewStatus.hidden = true;
    const cancelPreview = button("Cancel preview", async () => { await cancelOwnedPreview(); if (!ownedPreview && dialogActive && body.isConnected) { cancelPreview.hidden = true; previewStatus.hidden = true; } }); cancelPreview.id = "restore-preview-cancel"; cancelPreview.dataset.allowWhileBusy = "true"; cancelPreview.hidden = true;
    let confirmation: string | null = null;
    const submitButton = () => formSubmit(body);
    const parameters = () => ({ reference, runId, outputDirectory: destination.value, paths, overwrite: overwrite.value });
    const runPreview = async (values: Record<string, unknown>): Promise<RestorePlan> => {
      if (ownedPreview) throw new Error("A restore preview is already running.");
      const currentPreview = { id: crypto.randomUUID(), cancelRequested: false }, operationId = currentPreview.id; ownedPreview = currentPreview; previewPolling = true;
      preview.hidden = true; previewStatus.textContent = "Preparing restore preview…"; previewStatus.hidden = false; cancelPreview.hidden = false;
      const controls = [...body.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement>("input,select,textarea,button")].filter(control => control.dataset.allowWhileBusy !== "true" && !control.disabled); controls.forEach(control => { control.disabled = true; });
      let terminal = false, cancellationRequested = false;
      try {
        let operation = await request("restore-plan", { ...values, operationId }) as Operation; addOperation(operation);
        while (["queued", "running"].includes(operation.status)) {
          await new Promise(resolve => setTimeout(resolve, 150));
          const operations = await request("operations", { operationId }) as Operation[], current = operations.find(item => item.id === operationId);
          if (!current) throw new Error("The restore preview is no longer available. Try the preview again."); operation = current; addOperation(operation);
          if (dialogActive && body.isConnected) previewStatus.textContent = operation.status === "queued" ? "Restore preview queued…" : "Checking restore paths and required archives…";
        }
        terminal = true;
        if (currentPreview.cancelRequested || operation.status === "cancelled") throw new Error("Restore preview cancelled.");
        if (operation.status === "failed") throw new Error(`Restore preview failed: ${operation.error ? errorText(operation.error) : "Unknown error."}`);
        const plan = operation.result as RestorePlan | undefined;
        if (!plan || !["ready", "blocked"].includes(plan.status)) throw new Error("The restore preview did not return a valid result.");
        return plan;
      } catch (failure) {
        if (!terminal) {
          try { await request("cancel", { operationId }); cancellationRequested = true; }
          catch (cancellationError) { throw new Error(`${errorText(failure)} Cancellation could not be confirmed: ${errorText(cancellationError)}. Try Cancel preview again.`); }
        }
        throw failure;
      } finally {
        previewPolling = false;
        if (ownedPreview === currentPreview && (terminal || cancellationRequested)) ownedPreview = undefined;
        if (dialogActive && body.isConnected) {
          previewStatus.hidden = !ownedPreview; cancelPreview.hidden = !ownedPreview; if (ownedPreview) previewStatus.textContent = "The preview could not be stopped. Try Cancel preview again.";
          controls.forEach(control => { if (control.isConnected) control.disabled = control === submitButton() ? control.dataset.blocked === "true" || control.dataset.submitting === "true" : false; });
          const dismiss = document.getElementById("dialog-cancel") as HTMLButtonElement | null; if (dismiss && body.dataset.submitting === "true" && !ownedPreview) dismiss.disabled = true;
        }
      }
    };
    const showPlan = (plan: RestorePlan) => {
      if (!dialogActive || !body.isConnected) return;
      preview.hidden = false; preview.replaceChildren(node("h3", plan.status === "ready" ? "Ready to restore" : "Resolve these issues before restoring"), detailList([["Files", Number(plan.files ?? 0).toLocaleString("en-GB")], ["Data", bytes(plan.bytes)], ["Folders and links", `${Number(plan.directories ?? 0)} folders · ${Number(plan.links ?? 0)} links`], ["Existing files", `${Number(plan.conflicts ?? 0)} conflicts · ${Number(plan.skipped ?? 0)} skipped`], ["Archives", `${Number(plan.parts ?? 0)} required ZIP files`]]));
      for (const issue of (plan.issues ?? []).slice(0, 100)) { const item = node("div", undefined, "restore-issue"); item.append(node("p", String(issue.path), "path-cell"), node("p", String(issue.error), "field-hint")); preview.append(item); }
      if (plan.issuesTruncated) preview.append(node("p", "Only the first 100 issues are shown.", "field-hint"));
      preview.append(node("p", String(plan.scope ?? "The preview checks metadata and archive availability. Restoring checks the files again."), "field-hint"));
      const submit = submitButton(); if (submit) { submit.dataset.blocked = String(plan.status !== "ready"); submit.disabled = plan.status !== "ready" || submit.dataset.submitting === "true"; }
    };
    const resetPreview = () => { confirmation = null; preview.hidden = true; const submit = submitButton(); if (submit) { delete submit.dataset.blocked; submit.disabled = submit.dataset.submitting === "true"; submit.textContent = "Restore"; } };
    destination.addEventListener("input", resetPreview); overwrite.addEventListener("change", resetPreview);
    body.append(button("Preview restore", async () => { if (!destination.value.trim()) throw fieldError("Choose an output directory.", destination); const values = parameters(), signature = JSON.stringify(values), plan = await runPreview(values); if (JSON.stringify(parameters()) === signature) showPlan(plan); }), previewStatus, cancelPreview, preview);
    return async () => {
      if (!destination.value.trim()) throw fieldError("Choose an output directory.", destination);
      const values = parameters(), plan = await runPreview(values); if (!dialogActive || !body.isConnected) return; showPlan(plan); if (plan.status !== "ready") return;
      if (Number(plan.conflicts ?? 0) > 0 && overwrite.value === "replace") {
        const signature = JSON.stringify({ values, plan });
        if (confirmation !== signature) { confirmation = signature; const submit = submitButton(); if (submit) submit.textContent = "Confirm replacement"; preview.prepend(notice(`${Number(plan.conflicts)} existing files will be replaced. Review the preview, then choose Confirm replacement.`, "warning")); return; }
      }
      const operation = await request("restore", values); dialogActive = false; close(true); addOperation(operation); state.tab = "activity"; await renderPage();
    };
  }, "Restore", { cancelWhileBusy: () => Boolean(ownedPreview), onDismiss: async () => { await cancelOwnedPreview(); dialogActive = false; } });
}
function field(parent: HTMLElement, label: string, value: string | number, type = "text", hint?: string): HTMLInputElement {
  const wrapper = node("label", undefined, "field"); wrapper.append(node("span", label, "field-label")); const input = node("input"); input.type = type; input.value = String(value); wrapper.append(input); if (hint) wrapper.append(node("span", hint, "field-hint")); parent.append(wrapper); return input;
}
function checkField(parent: HTMLElement, label: string, value: boolean): HTMLInputElement { const wrapper = node("label", undefined, "field check"), input = node("input"); input.type = "checkbox"; input.checked = value; wrapper.append(input, node("span", label, "field-label")); parent.append(wrapper); return input; }
function selectField(parent: HTMLElement, label: string, value: string, choices: string[][]): HTMLSelectElement { const wrapper = node("label", undefined, "field"); wrapper.append(node("span", label, "field-label")); const input = node("select"); for (const [key, text] of choices) { const option = node("option", text); option.value = key!; option.selected = key === value; input.append(option); } wrapper.append(input); parent.append(wrapper); return input; }
function numeric(input: HTMLInputElement, min: number, max = Number.MAX_SAFE_INTEGER): number { const value = Number(input.value); if (!input.value.trim() || !Number.isSafeInteger(value) || value < min || value > max) throw fieldError(`Field “${input.closest("label")?.querySelector(".field-label")?.textContent ?? "value"}” requires a whole number from ${min} to ${max}.`, input); return value; }
function snapshotSpace(input: HTMLInputElement): number { const value = Number(input.value) * 1024 ** 2; if (!input.value.trim() || !Number.isSafeInteger(value) || value < 256 * 1024 ** 2 || value > 1024 ** 4) throw fieldError("LVM snapshot space must be between 256 MiB and 1 TiB and represent an exact whole-byte size.", input); return value; }
function browseIcon(): SVGSVGElement {
  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg"); icon.setAttribute("viewBox", "0 0 20 20"); icon.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(icon.namespaceURI, "path"); path.setAttribute("d", "M8 5H3v11h11v-5M10 3h7v7M17 3l-9 9"); icon.append(path); return icon;
}
function browseButton(label: string, action: () => unknown | Promise<unknown>, className = ""): HTMLButtonElement {
  const picker = button("", action, `path-browse-button ${className}`.trim()); picker.setAttribute("aria-label", label); picker.title = label; picker.append(browseIcon()); return picker;
}
function pathField(parent: HTMLElement, label: string, value: string, pickerLabel: string, id?: string): HTMLInputElement {
  const wrapper = node("label", undefined, "field"), row = node("div", undefined, "path-field-row"), input = node("input"); input.type = "text"; input.value = value; input.setAttribute("aria-label", label); if (id) input.id = id;
  const picker = browseButton(pickerLabel, async () => { const selected = await request("pick-directory"); if (selected && input.isConnected) { input.value = selected; input.dispatchEvent(new Event("input", { bubbles: true })); } }); row.append(input, picker); wrapper.append(node("span", label, "field-label"), row); parent.append(wrapper); return input;
}
type SourceFilters = TaskSettings["sources"][number]["filters"];
type FilterEditor = { read(): SourceFilters; add(): void; hasRows(): boolean };
function filterFields(parent: HTMLElement, initial: SourceFilters, focusAdd: () => void): FilterEditor {
  type Kind = "include" | "exclude";
  type FilterRow = { root: HTMLElement; kind: Kind; input: HTMLInputElement; toggle: HTMLButtonElement; remove: HTMLButtonElement };
  const filterRows: FilterRow[] = [];
  function update(row: FilterRow): void {
    const blank = !row.input.value.trim(), include = row.kind === "include";
    row.root.dataset.empty = String(blank); row.root.dataset.kind = row.kind;
    row.remove.setAttribute("aria-label", blank ? "Cancel filter" : "Remove filter"); row.remove.title = blank ? "Cancel filter" : "Remove filter";
    row.toggle.textContent = include ? "+" : "−"; row.toggle.setAttribute("aria-pressed", String(!include));
    row.toggle.setAttribute("aria-label", include ? "Include filter; switch to exclude" : "Exclude filter; switch to include"); row.toggle.title = include ? "Include matching paths; click to exclude" : "Exclude matching paths; click to include";
    row.input.setAttribute("aria-label", blank ? "New filter pattern" : "Filter pattern");
  }
  function removeFilter(row: FilterRow, returnToAdd = false): void {
    const index = filterRows.indexOf(row); if (index < 0) return;
    const blank = !row.input.value.trim(); filterRows.splice(index, 1); row.root.remove(); parent.hidden = filterRows.length === 0;
    if (returnToAdd || blank || !filterRows.length) focusAdd(); else filterRows[Math.min(index, filterRows.length - 1)]!.input.focus();
  }
  function addFilter(kind: Kind, pattern = ""): FilterRow {
    const root = node("div", undefined, "source-filter-row"), toggle = node("button", undefined, "source-filter-kind"), input = node("input", undefined, "source-filter-pattern");
    toggle.type = "button"; input.type = "text"; input.value = pattern; input.placeholder = "Filter pattern"; input.autocomplete = "off"; input.spellcheck = false;
    let row: FilterRow;
    const remove = button("×", () => removeFilter(row), "source-filter-remove");
    row = { root, kind, input, toggle, remove };
    toggle.addEventListener("click", () => { row.kind = row.kind === "include" ? "exclude" : "include"; update(row); });
    input.dataset.taskSetting = "filters"; input.addEventListener("input", () => update(row));
    input.addEventListener("keydown", event => { if (event.key === "Enter") { event.preventDefault(); if (!input.value.trim()) removeFilter(row, true); else focusAdd(); } });
    root.addEventListener("keydown", event => { if (event.key === "Escape" && !input.value.trim()) { event.preventDefault(); event.stopPropagation(); removeFilter(row, true); } });
    root.append(toggle, input, remove); filterRows.push(row); parent.append(root); parent.hidden = false; update(row); return row;
  }
  for (const kind of ["include", "exclude"] as const) for (const pattern of initial[kind]) if (pattern.trim()) addFilter(kind, pattern);
  parent.hidden = filterRows.length === 0;
  return {
    read() { const filters = { include: [] as string[], exclude: [] as string[] }; for (const row of filterRows) { const pattern = row.input.value.trim(); if (pattern) filters[row.kind].push(pattern); } return filters; },
    add() { const row = filterRows.find(item => !item.input.value.trim()) ?? addFilter(filterRows.at(-1)?.kind ?? "include"); row.input.focus(); },
    hasRows() { return filterRows.length > 0; },
  };
}
function sourceFields(parent: HTMLElement, initial: TaskSettings["sources"], listId = "task-sources", entries: TaskConfig["srcs"] = []): (() => TaskConfig["sources"]) & { srcs(): TaskConfig["srcs"] } {
  const rows = node("div", undefined, "source-list"); rows.id = listId;
  type SourceRow = { root: HTMLElement; path: HTMLInputElement; action: HTMLButtonElement; browse: HTMLButtonElement; addFilter: HTMLButtonElement; filterControls: HTMLElement; editor: FilterEditor; template?: TaskConfig["srcs"][number] };
  const sourceRows: SourceRow[] = [];
  const add = node("button", "Add source", "source-add"); add.type = "button"; add.id = `${listId}-add-source`; add.dataset.taskSetting = "sources";
  add.addEventListener("click", () => { const row = sourceRows.find(item => !item.path.value.trim()) ?? addSource(); row.path.focus(); }); parent.append(rows, add);
  function update(row: SourceRow): void {
    const blank = !row.path.value.trim(); row.root.dataset.empty = String(blank); row.browse.hidden = !blank; row.addFilter.hidden = blank;
    row.action.setAttribute("aria-label", blank ? "Cancel source" : "Remove source"); row.action.title = blank ? "Cancel source" : "Remove source";
    row.filterControls.hidden = blank || !row.editor.hasRows(); row.filterControls.setAttribute("aria-label", `Filters for ${row.path.value.trim() || "source"}`);
  }
  function removeSource(row: SourceRow, returnToAdd = false): void {
    const index = sourceRows.indexOf(row); if (index < 0) return;
    const blank = !row.path.value.trim(); sourceRows.splice(index, 1); row.root.remove();
    if (returnToAdd || blank || !sourceRows.length) add.focus(); else sourceRows[Math.min(index, sourceRows.length - 1)]!.path.focus();
  }
  function addSource(source?: TaskSettings["sources"][number]): SourceRow {
    const root = node("div", undefined, "source-row"), input = node("input", undefined, "source-path"); root.setAttribute("role", "group"); root.setAttribute("aria-label", "Backup source"); input.value = source?.path ?? ""; input.placeholder = "File or folder path"; input.setAttribute("aria-label", "Source path"); input.dataset.taskSetting = "sources";
    let row: SourceRow;
    const action = button("×", () => removeSource(row), "source-action source-remove");
    const browse = browseButton("Choose source folder", async () => { const selected = await request("pick-directory"); if (selected && input.isConnected) { input.value = selected; update(row); input.focus(); } }, "source-browse");
    const filterControls = node("div", undefined, "source-filters"); filterControls.setAttribute("role", "group");
    let editor: FilterEditor;
    const addFilter = node("button", "Add filter", "source-filter-add"); addFilter.type = "button"; addFilter.dataset.taskSetting = "filters"; addFilter.addEventListener("click", () => editor.add());
    editor = filterFields(filterControls, source?.filters ?? { include: [], exclude: [] }, () => addFilter.focus());
    row = { root, path: input, action, browse, addFilter, filterControls, editor, template: entries.find(entry => (typeof entry === "string" ? entry : entry[0]) === source?.path) };
    input.addEventListener("input", () => update(row));
    input.addEventListener("keydown", event => { if (event.key === "Enter") { event.preventDefault(); if (!input.value.trim()) removeSource(row, true); else add.focus(); } else if (event.key === "Escape" && !input.value.trim()) { event.preventDefault(); removeSource(row, true); } });
    root.append(input, addFilter, browse, action, filterControls); sourceRows.push(row); rows.append(root); update(row); return row;
  }
  for (const source of initial) if (source.path.trim()) addSource(source);
  return Object.assign(() => sourceRows.filter(row => row.path.value.trim()).map(row => ({ path: row.path.value, filters: row.editor.read() })), { srcs: () => sourceRows.filter(row => row.path.value.trim()).map(row => Array.isArray(row.template) ? [row.path.value, ...row.template.slice(1)] as TaskConfig["srcs"][number] : row.path.value) });
}
function sequenceField(parent: HTMLElement, initial: TaskSettings["sequence"]["types"]): () => TaskSettings["sequence"]["types"] {
  const codes = { full: "F", incremental: "I", differential: "D" }, types = { F: "full", I: "incremental", D: "differential" } as const;
  const input = field(parent, "Backup sequence", initial.map(type => codes[type]).join(""), "text", "F = full, I = incremental, D = differential. Start each cycle with F, for example FII or FFI."); input.id = "backup-sequence"; input.autocomplete = "off"; input.spellcheck = false;
  const message = "Start with F and use only F, I or D.", valid = () => /^F[FID]*$/.test(input.value);
  input.addEventListener("input", () => { const start = input.selectionStart, end = input.selectionEnd; input.value = input.value.toUpperCase(); if (start !== null && end !== null) input.setSelectionRange(start, end); if (!valid()) notify(message, true, [input]); else if (notificationEditors.has(input)) dismissNotification(); });
  return () => { if (!valid()) throw fieldError(message, input); return [...input.value].map(code => types[code as keyof typeof types]); };
}
function scheduleFields(parent: HTMLElement, initial: TaskSettings["schedules"]): () => TaskSettings["schedules"] {
  type Schedule = TaskSettings["schedules"][number];
  const panel = card("Schedules"), rows = node("div", undefined, "schedule-list"), empty = node("p", "No schedules. Run this task manually or add a schedule.", "muted"); rows.id = "task-schedules"; panel.append(rows, empty);
  const entries: Array<{ root: HTMLElement; id: string; name: HTMLInputElement; read: () => Schedule }> = [];
  const updateEmpty = () => { empty.hidden = entries.length > 0; };
  function addSchedule(source?: Schedule): void {
    let number = 1; while (entries.some(entry => entry.id === `schedule-${number}` || entry.name.value.trim() === `Schedule ${number}`)) number++;
    const value: Schedule = source ?? { name: `Schedule ${number}`, paused: false, kind: "daily", intervalMinutes: 1440, time: "20:00", weekdays: [1, 2, 3, 4, 5, 6, 7], timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC", missed: "run-once", onDestinationAvailable: false };
    const id = `schedule-${number}`, root = node("section", undefined, "schedule-editor"), header = node("div", undefined, "schedule-editor-header"), title = node("h3", value.name); root.dataset.scheduleId = id;
    const remove = button("Remove", () => { const index = entries.indexOf(entry); entries.splice(index, 1); root.remove(); updateEmpty(); (entries[Math.min(index, entries.length - 1)]?.root.querySelector("input") ?? add).focus(); }, "schedule-remove"); remove.setAttribute("aria-label", "Remove schedule"); header.append(title, remove); root.append(header);
    const name = field(root, "Schedule name", value.name); name.classList.add("schedule-name"); name.addEventListener("input", () => { title.textContent = name.value.trim() || "Schedule"; });
    const paused = checkField(root, "Paused", value.paused), kind = selectField(root, "Frequency", value.kind, [["manual", "No timed runs"], ["interval", "Every specified number of minutes"], ["daily", "Daily"], ["weekly", "Selected weekdays"]]); kind.classList.add("schedule-kind");
    const frequency = node("div", undefined, "field-row"), interval = field(frequency, "Interval (minutes)", value.intervalMinutes, "number"), time = field(frequency, "Time", value.time, "time"); root.append(frequency); const zone = field(root, "IANA time zone", value.timeZone, "text", "For example, Europe/Warsaw, UTC or America/New_York.");
    const weekdays = node("div", undefined, "schedule-weekdays"); weekdays.append(node("h3", "Weekdays")); const checks = node("div", undefined, "check-list"), days: Array<{ day: number; input: HTMLInputElement }> = []; ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].forEach((label, index) => { days.push({ day: index + 1, input: checkField(checks, label, value.weekdays.includes(index + 1)) }); }); weekdays.append(checks); root.append(weekdays);
    const missed = selectField(root, "Missed runs", value.missed, [["run-once", "Run one current backup when available again"], ["skip", "Skip and wait for the next scheduled run"]]), onAvailable = checkField(root, "Run a current backup when the destination reconnects", value.onDestinationAvailable);
    const showFrequency = () => { interval.closest<HTMLElement>("label")!.hidden = kind.value !== "interval"; time.closest<HTMLElement>("label")!.hidden = !["daily", "weekly"].includes(kind.value); frequency.hidden = kind.value === "manual"; weekdays.hidden = kind.value !== "weekly"; }; kind.addEventListener("change", showFrequency); showFrequency();
    const entry = { root, id, name, read: (): Schedule => ({ name: name.value.trim(), paused: paused.checked, kind: kind.value as Schedule["kind"], intervalMinutes: kind.value === "interval" ? numeric(interval, 1) : Number.isSafeInteger(Number(interval.value)) && Number(interval.value) >= 1 ? Number(interval.value) : 1440, time: time.value || (!["daily", "weekly"].includes(kind.value) ? "20:00" : ""), weekdays: days.filter(day => day.input.checked).map(day => day.day), timeZone: zone.value, missed: missed.value as Schedule["missed"], onDestinationAvailable: onAvailable.checked }) }; entries.push(entry); rows.append(root); updateEmpty();
  }
  const add = button("Add schedule", () => { addSchedule(); entries.at(-1)?.root.querySelector<HTMLInputElement>(".schedule-name")?.focus(); }); add.id = "add-schedule";
  initial.forEach(addSchedule); panel.append(add, node("p", "Schedules run independently. A task already running is never started a second time.", "field-hint")); parent.append(panel); updateEmpty();
  return () => entries.map(entry => entry.read());
}
function settingsFields(parent: HTMLElement, initial: FormSettings, includeSources = true, sourceListId = "task-sources"): SettingsEditor {
  let readSources: () => TaskSettings["sources"] = () => [];
  let readSourceEntries: (() => TaskConfig["srcs"]) | undefined;
  const paths = card("File paths"), workingDirectory = pathField(paths, "Working directory", initial.wdir, "Choose working directory"); workingDirectory.id = `${sourceListId}-working-directory`; workingDirectory.closest("label")!.append(node("span", "Relative source paths use this folder. Leave empty to use the destination folder.", "field-hint"));
  const mode = selectField(paths, "Paths in ZIP archives", String(initial.mode), [["0", "Relative to each source"], ["1", "Include the configured source path"], ["2", "Include the absolute source path without its drive"]]); parent.append(paths);
  if (includeSources) { const sources = card("Sources"), editor = sourceFields(sources, initial.sources, sourceListId, initial.srcs); readSources = editor; readSourceEntries = editor.srcs; sources.append(node("p", "Filters: + includes, − excludes. An empty Include list selects all files. Patterns are relative to each source.", "field-hint")); parent.append(sources); }
  const execution = card("Execution"), schedulesPaused = checkField(execution, "Pause schedules", initial.schedulesPaused), detection = selectField(execution, "Change detection", initial.detection, [["fast", "Fast — size and modification time"], ["hash", "Thorough — content hash"]]), symlinks = selectField(execution, "Symbolic links and junctions", initial.symlinks, [["follow", "Copy target contents with loop detection"], ["skip", "Skip links"]]); parent.append(execution);
  const readSchedules = scheduleFields(parent, initial.schedules);
  const policy = card("Sequence and retention"), readSequence = sequenceField(policy, initial.sequence.types), retentionWhen = selectField(policy, "Cleanup timing", initial.retention.when, [["after", "After backup"], ["before", "Before backup"]]); const retentionRow = node("div", undefined, "field-row"), keepCycles = field(retentionRow, "Keep cycles (0 = unlimited)", initial.retention.keepCycles, "number"), maxAge = field(retentionRow, "Maximum age in days (0 = unlimited)", initial.retention.maxAgeDays, "number"); policy.append(retentionRow); const pinned = checkField(policy, "Protect pinned points and their dependencies", initial.retention.protectPinned); parent.append(policy);
  const archive = card("ZIP archive"), level = field(archive, "Compression level (0–9)", initial.archive.level, "number", "0 = no compression; 1–9 = DEFLATE, from fastest to smallest. Each snapshot uses one ZIP archive."); level.min = "0"; level.max = "9"; level.step = "1"; parent.append(archive);
  const security = card("Source snapshots"), snapshot = selectField(security, "Source snapshots", initial.snapshot.mode, [["off", "Off"], ["snapshot-only", "File system snapshot"], ["writers", "Windows VSS writers"]]), fallback = selectField(security, "If snapshot fails", initial.snapshot.fallback, [["fail", "Fail — require a snapshot"], ["live", "Continue reading live files without a snapshot"]]); const lvmSpace = field(security, "LVM snapshot space (MiB)", String(initial.snapshot.lvmCowSizeBytes / 1024 ** 2), "number", "Space reserved for changes while a classic Linux LVM snapshot exists; this is not the backup size. Thin LVM snapshots are currently unsupported."); lvmSpace.min = "256"; lvmSpace.max = "1048576"; lvmSpace.step = "any"; security.append(node("p", "Windows uses VSS; Linux supports Btrfs, ZFS and LVM with ext4/XFS, and macOS supports APFS. Availability depends on the source file system and snapshot permissions. Writer coordination is available only on Windows. Snapshots of separate file systems may represent different moments.", "field-hint")); parent.append(security);
  const resilience = card("Errors and performance"), continueErrors = checkField(resilience, "Continue after individual file errors and mark the backup incomplete", initial.behavior.continueOnFileError), resume = checkField(resilience, "Allow restarting interrupted backups", initial.behavior.resume); const behaviorRow = node("div", undefined, "field-row"), retries = field(behaviorRow, "Automatic file retries", initial.behavior.retryCount, "number"); resilience.append(behaviorRow); parent.append(resilience);
  for (const [key, control] of Object.entries({ wdir: workingDirectory, mode, detection, symlinks, sequence: policy.querySelector<HTMLInputElement>("#backup-sequence")!, retentionWhen, keepCycles, maxAge, pinned, snapshot, fallback, continueErrors })) control.dataset.taskSetting = key;
  const location = () => ({ mode: Number(mode.value) as TaskConfig["mode"], wdir: workingDirectory.value.trim() || (state.page === "task" ? selectedTask()?.directory ?? initial.wdir : ""), ...(readSourceEntries ? { srcs: readSourceEntries() } : {}) });
  const read = () => ({ ...location(), schedulesPaused: schedulesPaused.checked, sources: readSources(), schedules: readSchedules(), sequence: { types: readSequence() }, retention: { when: retentionWhen.value as "before" | "after", keepCycles: numeric(keepCycles, 0), maxAgeDays: numeric(maxAge, 0), protectPinned: pinned.checked }, archive: { level: numeric(level, 0, 9) }, detection: detection.value as "fast" | "hash", symlinks: symlinks.value as TaskSettings["symlinks"], snapshot: { mode: snapshot.value as TaskSettings["snapshot"]["mode"], fallback: fallback.value as "fail" | "live", lvmCowSizeBytes: snapshotSpace(lvmSpace) }, behavior: { continueOnFileError: continueErrors.checked, retryCount: numeric(retries, 0, 100), resume: resume.checked } });
  return Object.assign(read, { preview: () => { let sequence = initial.sequence; try { sequence = { types: readSequence() }; } catch { /* Invalid input is handled on submit. */ } return { ...initial, ...location(), sources: readSources(), detection: detection.value as TaskSettings["detection"], symlinks: symlinks.value as TaskSettings["symlinks"], sequence, retention: { when: retentionWhen.value as "before" | "after", keepCycles: Number(keepCycles.value), maxAgeDays: Number(maxAge.value), protectPinned: pinned.checked }, snapshot: { ...initial.snapshot, mode: snapshot.value as TaskSettings["snapshot"]["mode"], fallback: fallback.value as "fail" | "live" }, behavior: { ...initial.behavior, continueOnFileError: continueErrors.checked } }; } });
}
function pathSetting(value: string | undefined): string { return document.body.dataset.platform === "win32" ? (value ?? "").replaceAll("\\", "/") : value ?? ""; }
function sourcePaths(sources: TaskSettings["sources"]): string { return JSON.stringify(sources.map(source => pathSetting(source.path)).sort()); }
function sourceSelection(sources: TaskSettings["sources"]): string { return JSON.stringify(sources.map(source => ({ path: pathSetting(source.path), include: source.filters.include.map(pattern => pattern.replaceAll("\\", "/")).sort(), exclude: source.filters.exclude.map(pattern => pattern.replaceAll("\\", "/")).sort() })).sort((a, b) => a.path.localeCompare(b.path))); }
function taskUnsafeChanges(previous: TaskConfig, next: FormSettings): Map<string, string> {
  const messages = new Map<string, string>();
  if (previous.mode !== next.mode) messages.set("mode", "Paths in future ZIP archives will change. Run a full backup after saving to establish a new baseline.");
  if (pathSetting(previous.wdir) !== pathSetting(next.wdir)) messages.set("wdir", "Relative source paths will use the new working directory. Run a full backup if an existing archive path now refers to different data.");
  const pathsChanged = sourcePaths(previous.sources) !== sourcePaths(next.sources);
  if (pathsChanged) messages.set("sources", "Sources have changed. Future backups will use the new selection. Run a full backup when an existing archive path now refers to different data.");
  const previousCommon = previous.sources.filter(source => next.sources.some(current => pathSetting(current.path) === pathSetting(source.path))), nextCommon = next.sources.filter(source => previous.sources.some(current => pathSetting(current.path) === pathSetting(source.path)));
  if (sourceSelection(previousCommon) !== sourceSelection(nextCommon)) messages.set("filters", "Source filters have changed. Future restore points will reflect the new selection.");
  if (previous.detection !== next.detection) messages.set("detection", "File fingerprints will change. The next backup will read and write the selected files again.");
  if (previous.symlinks !== next.symlinks) messages.set("symlinks", "Following or skipping links changes the contents selected for future backups.");
  if (JSON.stringify(previous.sequence) !== JSON.stringify(next.sequence)) messages.set("sequence", "The next backup type may change. The sequence position is calculated from the current history.");
  const tighter = (oldLimit: number, newLimit: number) => newLimit > 0 && (oldLimit === 0 || newLimit < oldLimit);
  const retention = "The new retention policy applies at the next cleanup and may permanently delete eligible archives.";
  if (tighter(previous.retention.keepCycles, next.retention.keepCycles)) messages.set("keepCycles", retention);
  if (tighter(previous.retention.maxAgeDays, next.retention.maxAgeDays)) messages.set("maxAge", retention);
  if (previous.retention.protectPinned && !next.retention.protectPinned) messages.set("pinned", retention);
  if (previous.retention.when !== "before" && next.retention.when === "before" && (next.retention.keepCycles > 0 || next.retention.maxAgeDays > 0)) messages.set("retentionWhen", retention);
  if (previous.snapshot.mode !== "off" && next.snapshot.mode === "off") messages.set("snapshot", "Source snapshots will be disabled. Files in future backups may be read at different moments.");
  else if (previous.snapshot.mode === "writers" && next.snapshot.mode === "snapshot-only") messages.set("snapshot", "VSS writer coordination will be disabled. Future backups use filesystem consistency only.");
  if (next.snapshot.mode !== "off" && previous.snapshot.fallback === "fail" && next.snapshot.fallback === "live") messages.set("fallback", "If a source snapshot fails, the backup may continue by reading live files.");
  if (!previous.behavior.continueOnFileError && next.behavior.continueOnFileError) messages.set("continueErrors", "Individual file errors will allow an incomplete backup to be saved. Missing versions remain reported.");
  return messages;
}
function renderTaskEditor(parent: HTMLElement, task: TaskConfig, save: (patch: unknown) => Promise<void>, submit: HTMLButtonElement): void {
  const form = node("form"); form.id = "task-settings-form"; const identity = card("Task"), name = field(identity, "Name", task.name); identity.append(detailList([["Destination", selectedTask()?.directory ?? ""]])); form.append(identity); const values = settingsFields(form, task); submit.disabled = false;
  const originalHints = new WeakMap<HTMLElement, { title: string | null; description: string | null }>();
  const unsafeSettings = new Set(["wdir", "mode", "sources", "filters", "detection", "symlinks", "sequence", "retentionWhen", "keepCycles", "maxAge", "snapshot", "fallback"]);
  const prepareFocusState = (editor: Element) => {
    if (!(editor instanceof HTMLInputElement || editor instanceof HTMLSelectElement || editor instanceof HTMLTextAreaElement) || editor instanceof HTMLInputElement && ["checkbox", "radio", "hidden"].includes(editor.type) || !unsafeSettings.has(editor.dataset.taskSetting ?? "") || editor.dataset.changeRisk === "unsafe") return;
    editor.dataset.changeRisk = "unsafe";
    const description = "Unsafe change: editing this setting can affect future backups.";
    if (!editor.hasAttribute("title")) editor.title = description;
    if (!editor.hasAttribute("aria-description")) editor.setAttribute("aria-description", description);
  };
  for (const editor of form.querySelectorAll("input,select,textarea")) prepareFocusState(editor);
  form.addEventListener("focusin", event => { if (event.target instanceof Element) prepareFocusState(event.target); });
  const mark = (editor: HTMLElement, message: string) => { if (!originalHints.has(editor)) originalHints.set(editor, { title: editor.getAttribute("title"), description: editor.getAttribute("aria-description") }); editor.dataset.changeImpact = "unsafe"; editor.title = `Unsafe change: ${message}`; editor.setAttribute("aria-description", editor.title); };
  const showChanges = () => {
    for (const editor of form.querySelectorAll("input,select,textarea")) prepareFocusState(editor);
    for (const editor of form.querySelectorAll<HTMLElement>('[data-change-impact="unsafe"]')) { delete editor.dataset.changeImpact; const hints = originalHints.get(editor)!; for (const [attribute, value] of [["title", hints.title], ["aria-description", hints.description]]) { if (value === null) editor.removeAttribute(attribute!); else editor.setAttribute(attribute!, value!); } }
    const next = values.preview(), messages = taskUnsafeChanges(task, next);
    for (const [key, message] of messages) {
      if (key === "sources") {
        const previousPaths = new Set(task.sources.map(source => pathSetting(source.path))), editors = [...form.querySelectorAll<HTMLInputElement>(".source-path")].filter(editor => editor.value.trim() && !previousPaths.has(pathSetting(editor.value)));
        for (const editor of editors) mark(editor, message);
        if (!editors.length) { const add = form.querySelector<HTMLElement>(".source-add"); if (add) mark(add, message); }
      } else if (key === "filters") {
        for (const row of form.querySelectorAll<HTMLElement>(".source-row")) { const path = row.querySelector<HTMLInputElement>(".source-path")!.value, previous = task.sources.find(source => pathSetting(source.path) === pathSetting(path)), current = next.sources.find(source => source.path === path); if (!previous || !current || sourceSelection([previous]) === sourceSelection([current])) continue; const inputs = [...row.querySelectorAll<HTMLInputElement>('input[data-task-setting="filters"]')]; if (inputs.length) for (const input of inputs) mark(input, message); else { const add = row.querySelector<HTMLElement>(".source-filter-add"); if (add) mark(add, message); } }
      } else for (const editor of form.querySelectorAll<HTMLElement>(`[data-task-setting="${key}"]`)) mark(editor, message);
    }
    submit.title = messages.size ? `Unsafe change\n${[...messages.values()].join("\n")}` : "Save task settings";
  };
  form.addEventListener("input", showChanges); form.addEventListener("change", showChanges); form.addEventListener("click", () => queueMicrotask(showChanges));
  form.addEventListener("submit", async event => { event.preventDefault(); if (submit.disabled) return; submit.disabled = true; try { if (!name.value.trim()) throw fieldError("Enter a task name.", name); await save({ ...values(), name: name.value }); } catch (error) { notifyError(error); } finally { if (submit.isConnected) submit.disabled = false; } }); parent.append(form);
}
function formSubmit(element: HTMLElement): HTMLButtonElement | undefined { return element instanceof HTMLFormElement ? [...element.elements].find((control): control is HTMLButtonElement => control instanceof HTMLButtonElement && control.type === "submit") : element.querySelector<HTMLButtonElement>('button[type="submit"]') ?? undefined; }
function dialogForm(title: string, description: string, setup: (body: HTMLElement, close: (value: unknown) => void) => () => Promise<void>, submitLabel = "Save", options: { onDismiss?(): Promise<void>; cancelWhileBusy?: boolean | (() => boolean); showCancel?: boolean } = {}): Promise<unknown> {
  const dialog = $<HTMLDialogElement>("dialog"), body = $("dialog-body");
  if (dialog.open) return Promise.reject(new Error("Finish the current dialog first."));
  return new Promise(resolve => {
    const previousFocus = document.activeElement, heading = node("h2", title), header = node("header", undefined, "dialog-header"); heading.id = "dialog-title"; header.append(heading); body.replaceChildren(header); dialog.setAttribute("aria-labelledby", heading.id);
    const form = node("form"); form.id = "dialog-form"; form.className = "dialog-content";
    if (description) { const detail = node("p", description, "muted"); detail.id = "dialog-description"; form.append(detail); dialog.setAttribute("aria-describedby", detail.id); } else dialog.removeAttribute("aria-describedby");
    let settled = false;
    let dismissing = false;
    const dismiss = async () => {
      const cancelWhileBusy = typeof options.cancelWhileBusy === "function" ? options.cancelWhileBusy() : options.cancelWhileBusy;
      if (dismissing || form.dataset.submitting === "true" && !cancelWhileBusy) return; dismissing = true;
      try { await options.onDismiss?.(); close(null); }
      catch (failure) { if (form.isConnected) notifyError(failure); }
      finally { dismissing = false; }
    };
    const cancelled = (event: Event) => { event.preventDefault(); void dismiss(); };
    // A native close event can arrive after the next modal has already opened.
    const dismissed = () => { if (!dialog.open) void dismiss(); };
    const close = (value: unknown) => {
      if (settled) return; settled = true; dialog.removeEventListener("cancel", cancelled); dialog.removeEventListener("close", dismissed);
      if (dialog.open && form.isConnected) { document.body.append($("notification")); dialog.close(); }
      resolve(value);
      setTimeout(() => { if (dialog.open || document.activeElement !== document.body && document.activeElement !== dialog) return; if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus({ preventScroll: true }); else focusMain(); }, 0);
    };
    const submitAction = setup(form, close);
    const actions = node("div", undefined, "dialog-actions"), submit = node("button", submitLabel, "primary"), cancel = button("Cancel", dismiss); submit.id = "dialog-submit"; submit.type = "submit"; submit.setAttribute("form", form.id); cancel.id = "dialog-cancel"; if (options.cancelWhileBusy) cancel.dataset.allowWhileBusy = "true"; if (options.showCancel !== false) actions.append(cancel); actions.append(submit); header.append(actions); body.append(form);
    form.addEventListener("submit", async event => {
      event.preventDefault(); if (submit.disabled || submit.dataset.submitting === "true") return; submit.disabled = true; submit.dataset.submitting = "true"; form.dataset.submitting = "true"; form.setAttribute("aria-busy", "true");
      const controls = [...form.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement>("input,select,textarea,button"), cancel].filter(control => control !== submit && control.dataset.allowWhileBusy !== "true" && !control.disabled); controls.forEach(control => { control.disabled = true; });
      try { await submitAction(); } catch (failure) { if (form.isConnected) notifyError(failure); }
      finally { delete submit.dataset.submitting; delete form.dataset.submitting; form.removeAttribute("aria-busy"); controls.forEach(control => { if (control.isConnected) control.disabled = false; }); if (cancel.isConnected) cancel.disabled = false; if (submit.isConnected) submit.disabled = submit.dataset.blocked === "true"; }
    });
    dialog.addEventListener("cancel", cancelled); dialog.addEventListener("close", dismissed); dialog.showModal(); placeNotification(); form.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>("input:not([type='hidden']):not([disabled]),select:not([disabled]),textarea:not([disabled])")?.focus({ preventScroll: true });
  });
}

async function createDraft(): Promise<void> {
  if (!state.defaults) { const loaded = await request("bootstrap"); state.app = loaded.app; state.defaults = loaded.defaults; state.tasks = loaded.tasks ?? []; state.operations = loaded.operations ?? []; applyTheme(); }
  state.draft = { name: "", directory: "", settings: structuredClone({ ...state.defaults.value.settings, sources: [] }) }; renderDraft();
}
function renderDraft(): void {
  const draft = state.draft; if (!draft) { void renderHome(); return; } enterPage("draft"); const token = ++state.viewToken, main = $("main"); main.dataset.view = "draft"; main.removeAttribute("aria-busy");
  const form = node("form"); form.id = "draft-form"; const create = node("button", "Create task", "primary"); create.id = "draft-create"; create.type = "submit"; create.setAttribute("form", form.id); const cancel = button("Cancel draft", async () => { state.draft = null; await renderHome(); }); cancel.id = "draft-cancel";
  const content = pageLayout(heading("New task", "Choose a destination and sources. Nothing is saved until you create the task.", [cancel, create]), undefined, "Draft task content"), identity = card("Task"), name = field(identity, "Name", draft.name); name.id = "draft-task-name"; name.placeholder = "Task name"; const directory = pathField(identity, "Existing destination folder", draft.directory, "Choose destination folder", "new-task-destination"); form.append(identity); const values = settingsFields(form, draft.settings, true, "new-task-sources"); content.append(form);
  form.addEventListener("submit", async event => {
    event.preventDefault(); if (form.dataset.submitting === "true") return; create.disabled = true; cancel.disabled = true; form.dataset.submitting = "true";
    const controls = [...form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLButtonElement>("input,textarea,select,button")].filter(control => !control.disabled);
    try { const settings = { ...draft.settings, ...values() }; if (!name.value.trim() || !directory.value.trim() || !settings.sources.length) throw fieldError("Enter a name, destination and at least one source.", ...[name, directory].filter(editor => !editor.value.trim())); controls.forEach(control => { control.disabled = true; }); const result = await request("create", { directory: directory.value, name: name.value.trim(), settings }); if (state.page === "draft" && token === state.viewToken) { state.selected = result.id; state.tab = "overview"; state.runId = null; state.selectedFiles.clear(); enterPage("task"); } await refresh(); notify("Task created."); }
    catch (failure) { controls.forEach(control => { if (control.isConnected) control.disabled = false; }); notifyError(failure, ...(unavailableDestination(failure) ? [directory] : [])); }
    finally { delete form.dataset.submitting; controls.forEach(control => { if (control.isConnected) control.disabled = false; }); if (create.isConnected) create.disabled = false; if (cancel.isConnected) cancel.disabled = false; }
  }); name.focus({ preventScroll: true });
}
async function discover(): Promise<void> { const directory = await request("pick-directory"); if (!directory) return; const task = await request("discover", { directory }); state.selected = task.id; state.tab = "overview"; enterPage("task"); await refresh(); notify("Existing task remembered."); }
async function relink(): Promise<void> { const reference = state.selected, directory = await request("pick-directory"); if (!directory) return; await request("relink", { reference, directory }); await refresh(); notify("Task location updated."); }
async function duplicateDialog(): Promise<void> { const current = selectedTask(); if (!current?.available) return; const prepared = await request("duplicate-draft", { reference: current.id }); state.draft = { name: prepared.name, directory: "", settings: structuredClone(prepared.settings) }; renderDraft(); }
async function forget(): Promise<void> { const current = selectedTask(); if (!current) return; await dialogForm("Forget task", "The configuration and all backups remain on the device. Only this application's remembered entry is removed.", (_body, close) => async () => { await request("forget", { reference: current.id }); close(true); state.selected = null; await refresh(); }, "Forget"); }

async function retentionDialog(): Promise<void> {
  const current = selectedTask(); if (!current?.available) return;
  await dialogForm("Run retention now", "Apply this task's current retention policy immediately. Eligible backup cycles are permanently deleted; protected points and required dependencies are retained.", (body, close) => {
    const task = state.loaded?.value ?? current.task?.value; if (!task) throw new Error("Connect the destination to read this task’s retention policy."); body.append(detailList([["Keep cycles", task.retention.keepCycles ? String(task.retention.keepCycles) : "Unlimited"], ["Maximum age", task.retention.maxAgeDays ? `${task.retention.maxAgeDays} days` : "Unlimited"], ["Pinned points", task.retention.protectPinned ? "Protected" : "Not protected by this policy"]]));
    return async () => { const operation = await request("retention", { reference: current.id }); close(true); addOperation(operation); state.tab = "activity"; await renderPage(); };
  }, "Run retention");
}
async function appSettings(): Promise<void> {
  enterPage("application-settings"); const token = ++state.viewToken, main = $("main"); main.dataset.view = "application-settings"; main.setAttribute("aria-busy", "true"); const submit = node("button", "Save settings", "primary"); submit.id = "app-settings-save"; submit.type = "submit"; submit.setAttribute("form", "app-settings-form"); submit.disabled = true; const content = pageLayout(heading("Application settings", "Global Delta Backupper preferences.", [submit]), undefined, "Application settings content"); content.append(notice("Loading current preferences…"));
  try { const current = await request("bootstrap"); if (token !== state.viewToken) return; state.app = current.app; applyTheme(); }
  catch (failure) { if (token === state.viewToken) { main.removeAttribute("aria-busy"); content.replaceChildren(notice(errorText(failure), "error"), button("Try again", appSettings)); } return; }
  main.removeAttribute("aria-busy"); content.replaceChildren(); const form = node("form"), appearance = card("Appearance"), value = state.app.value; form.id = "app-settings-form"; submit.disabled = false;
  const themeFamily = selectField(appearance, "Theme", value.themeFamily, [["one", "One"], ["aura", "Aura"]]); themeFamily.id = "theme-family";
  const theme = selectField(appearance, "Color mode", value.theme, [["system", "System"], ["light", "Light"], ["dark", "Dark"]]); theme.id = "color-mode";
  appearance.append(node("p", "One follows Lumine's classic day and night palette. Aura adds brighter light surfaces, deeper dark surfaces and softer corners. System follows your operating system's appearance.", "field-hint"));
  const background = card("Background behavior"), tray = checkField(background, "Keep running in the tray when the window closes", value.closeToTray), login = checkField(background, "Launch at login", value.launchAtLogin), paused = checkField(background, "Pause scheduled backups", value.schedulerPaused), max = field(background, "Concurrent tasks", value.maxConcurrentTasks, "number");
  background.append(node("p", "When the tray is available, closing the window keeps scheduled backups and active operations running. Open Delta from its tray icon, or choose Quit in the tray menu to exit.", "field-hint"));
  const notificationPanel = card("Notifications"), notifications = checkField(notificationPanel, "Show system notifications for task results", value.notifications);
  notificationPanel.append(node("p", "Your operating system controls notification permissions and Do Not Disturb. A submitted notification may be hidden or silenced by those settings.", "field-hint"));
  const notificationResult = node("p", "", "field-hint"); notificationResult.id = "notification-test-result"; notificationResult.setAttribute("role", "status"); notificationResult.setAttribute("aria-live", "polite"); notificationResult.hidden = true;
  const testNotification = button("Test notification", async () => {
    notificationResult.hidden = false; notificationResult.textContent = "Submitting a test notification…"; delete notificationResult.dataset.status;
    try {
      const result = await request("notification-test") as { supported: boolean; status: "submitted" | "unsupported" | "blocked" | "failed"; message?: string };
      notificationResult.dataset.status = result.status;
      notificationResult.textContent = result.status === "submitted" ? "Test notification submitted. Check your system notification area." : result.message ?? (result.status === "unsupported" ? "System notifications are not available on this computer." : "The test notification could not be submitted.");
    } catch (error) { notificationResult.dataset.status = "failed"; notificationResult.textContent = `The test notification could not be submitted: ${errorText(error)}`; }
  }); testNotification.id = "notification-test"; notificationPanel.append(testNotification, notificationResult);
  const updates = card("GitHub updates"), updateSettings = value.updates, repository = field(updates, "GitHub repository", updateSettings.repository, "text", "Enter owner/repository. Leave empty during preproduction, before the public release repository is ready."); repository.id = "update-repository"; repository.placeholder = "owner/repository"; repository.autocomplete = "off"; repository.spellcheck = false;
  const includePrereleases = checkField(updates, "Include prereleases", updateSettings.includePrereleases); includePrereleases.id = "update-prereleases";
  const checkOnStartup = checkField(updates, "Check for updates when Delta starts", updateSettings.checkOnStartup); checkOnStartup.id = "update-startup";
  updates.append(node("p", "Checks read public GitHub Releases. A repository without releases is expected during preproduction. Delta opens available releases in your browser so you can choose what to download.", "field-hint"));
  form.append(appearance, background, notificationPanel, updates); form.addEventListener("submit", async event => { event.preventDefault(); if (submit.disabled) return; submit.disabled = true; try { const saved = await request("app-save", { revision: state.app.revision, value: { ...value, schemaVersion: 1, theme: theme.value, themeFamily: themeFamily.value, language: "en", closeToTray: tray.checked, launchAtLogin: login.checked, notifications: notifications.checked, schedulerPaused: paused.checked, maxConcurrentTasks: numeric(max, 1, 64), updates: { repository: repository.value.trim(), includePrereleases: includePrereleases.checked, checkOnStartup: checkOnStartup.checked } } }); if (token !== state.viewToken) return; state.app = saved; applyTheme(); notify("Application settings saved."); } catch (error) { if (token === state.viewToken) notifyError(error); } finally { if (submit.isConnected) submit.disabled = false; } }); content.append(form);
}
async function defaultsSettings(): Promise<void> {
  enterPage("task-defaults"); ++state.viewToken; const main = $("main"); main.dataset.view = "task-defaults"; main.removeAttribute("aria-busy"); const submit = node("button", "Save defaults", "primary"); submit.id = "task-defaults-save"; submit.type = "submit"; submit.setAttribute("form", "task-defaults-form"); const content = pageLayout(heading("Task defaults", "New tasks receive these values. Existing complete tasks keep their own settings.", [submit]), undefined, "Task defaults content");
  const form = node("form"); form.id = "task-defaults-form"; const values = settingsFields(form, { ...state.defaults.value.settings, sources: [] }, false);
  form.addEventListener("submit", async event => {
    event.preventDefault(); if (submit.disabled) return; submit.disabled = true;
    try { const { sources: _sources, ...settings } = values(); state.defaults = await request("defaults-save", { revision: state.defaults.revision, value: { schemaVersion: 1, settings } }); notify("Task defaults saved."); }
    catch (error) { notifyError(error); }
    finally { submit.disabled = false; }
  }); content.append(form);
}
async function aboutApplication(): Promise<void> {
  enterPage("about"); const token = ++state.viewToken, main = $("main"); main.dataset.view = "about"; main.setAttribute("aria-busy", "true");
  const content = node("section", undefined, "about-content"), identity = node("header", undefined, "page-header about-brand"), wordmark = node("div"); wordmark.append(node("h1", "Delta Backupper"), node("p", "Transparent ZIP backups for your files.", "muted")); identity.append(brandLogo("about-mark"), wordmark); pageLayout(identity, undefined, "About content").append(content);
  const information = card("Application"); information.append(node("p", "Loading application information…", "muted")); content.append(information);
  const updates = card("Updates"), updateStatus = node("div", undefined, "update-status"), updateActions = node("div", undefined, "toolbar"); updates.id = "updates-card"; updateStatus.id = "update-status"; updateStatus.setAttribute("role", "status"); updateStatus.setAttribute("aria-live", "polite"); updateStatus.setAttribute("aria-atomic", "true"); updateStatus.append(node("p", "Loading update status…", "muted"));
  const currentView = (): boolean => token === state.viewToken && updates.isConnected;
  const check = node("button", "Check for updates"); check.type = "button"; check.id = "update-check"; check.disabled = true;
  check.addEventListener("click", async () => {
    check.disabled = true; updates.dataset.status = "checking"; updates.setAttribute("aria-busy", "true"); updateStatus.replaceChildren(node("p", "Checking GitHub Releases…", "muted")); openRelease.hidden = true;
    try { const result = await request("updates-check") as UpdateResult; if (currentView()) showUpdateResult(result); }
    catch (error) { if (currentView()) { updates.dataset.status = "error"; updateStatus.replaceChildren(node("p", "Could not check for updates.", "muted"), node("p", errorText(error), "field-hint")); check.disabled = false; } }
    finally { if (currentView()) updates.removeAttribute("aria-busy"); }
  });
  const openRelease = button("View release", () => request("updates-open")); openRelease.id = "update-open"; openRelease.hidden = true;
  const configure = button("Update settings", appSettings); configure.id = "update-settings"; updateActions.append(check, openRelease, configure); updates.append(updateStatus, updateActions); content.append(updates);
  function showUpdateResult(result: UpdateResult): void {
    updates.dataset.status = result.status; updateStatus.replaceChildren();
    const labels: Record<UpdateResult["status"], string> = {
      "not-configured": "Update checking is not configured. Preproduction builds can run before the first public release.",
      "not-checked": "No update check has been performed in this session.",
      "no-releases": "No published releases are available for this channel. This is expected during preproduction.",
      "up-to-date": "No newer published version is available for this channel.",
      available: `Delta Backupper ${result.release?.version ?? "update"} is available.`,
      unavailable: "No matching public release is available.",
      error: "Could not check for updates.",
      "rate-limited": "GitHub's request limit has been reached. Try again later.",
    };
    updateStatus.append(node("p", labels[result.status], result.status === "available" ? "update-available" : "muted"));
    if (result.message) updateStatus.append(node("p", result.message, "field-hint"));
    const details: Array<[string, string]> = [];
    if (result.repository) details.push(["Repository", result.repository], ["Channel", result.includePrereleases ? "Stable and prereleases" : "Stable releases"]);
    if (result.release && result.status === "available") { details.push(["Release", result.release.name || result.release.tag]); if (result.release.publishedAt) details.push(["Published", formatDate(result.release.publishedAt)]); }
    if (result.checkedAt) details.push(["Last checked", formatDate(result.checkedAt)]);
    if (result.retryAt) details.push(["Try again after", formatDate(result.retryAt)]);
    if (details.length) updateStatus.append(detailList(details));
    check.disabled = result.status === "not-configured"; openRelease.hidden = result.status !== "available" || !result.release; configure.textContent = result.status === "not-configured" ? "Configure updates" : "Update settings";
  }
  const format = card("Your backups, in the open"); format.append(node("p", "Your files are stored in standard ZIP archives alongside readable metadata. Every destination keeps its own task settings and backup history.", "muted")); content.append(format);
  const [info, status] = await Promise.allSettled([request("application-info"), request("updates-status")]); if (token !== state.viewToken) return;
  if (info.status === "fulfilled") { const value = info.value as { name: string; version: string; license: string; platform: string }; information.replaceChildren(node("h2", "Application"), detailList([["Version", value.version], ["License", value.license], ["Platform", ({ win32: "Windows", linux: "Linux", darwin: "macOS" } as Record<string, string>)[value.platform] ?? value.platform]])); }
  else information.replaceChildren(node("h2", "Application"), notice(errorText(info.reason), "error"), button("Try again", aboutApplication));
  if (status.status === "fulfilled") showUpdateResult(status.value as UpdateResult);
  else { updateStatus.replaceChildren(node("p", "Could not load update status.", "muted"), node("p", errorText(status.reason), "field-hint")); check.disabled = false; }
  main.removeAttribute("aria-busy");
}
function bind(id: string, action: () => Promise<unknown>): void { $(id).addEventListener("click", () => { void action().catch(error => notifyError(error)); }); }
function applyWindowState(value: WindowState): void {
  document.body.dataset.platform = value.platform; document.body.classList.toggle("window-maximized", value.maximized); document.body.classList.toggle("window-fullscreen", value.fullscreen);
}
window.delta.onWindowState(applyWindowState);
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", syncNativeTitlebar);
window.delta.onStylesError(message => { notify(`styles.css: ${message}`, true); });
window.delta.onNavigate(destination => {
  void (async () => {
    state.selected = destination.taskId; state.tab = "activity"; enterPage("task");
    await refresh();
    if (!state.tasks.some(task => task.id === destination.taskId)) return;
    state.selected = destination.taskId; state.loaded = selectedTask()?.task ?? null; state.tab = "activity"; state.runId = null; state.selectedFiles.clear();
    renderTaskList(); await renderPage();
  })().catch(error => notifyError(error));
});
void request("window", { command: "state" }).then(applyWindowState).catch(error => notifyError(error));
bind("home", async () => { enterPage("home"); await refresh(); }); bind("new-task", createDraft); bind("discover-task", discover); bind("refresh", () => refresh()); bind("app-settings", appSettings); bind("defaults", defaultsSettings); bind("about", aboutApplication);
$("skip-content").addEventListener("click", event => { event.preventDefault(); focusMain(); });
$("task-list").addEventListener("keydown", event => {
  if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key) || !(event.target instanceof HTMLButtonElement)) return;
  const tasks = [...$("task-list").querySelectorAll<HTMLButtonElement>(".task-item")], current = tasks.indexOf(event.target); if (current < 0) return;
  event.preventDefault(); const next = event.key === "Home" ? 0 : event.key === "End" ? tasks.length - 1 : Math.max(0, Math.min(tasks.length - 1, current + (event.key === "ArrowDown" ? 1 : -1))); tasks[next]?.focus();
});
document.addEventListener("keydown", event => {
  if (event.key !== "F6" || $<HTMLDialogElement>("dialog").open) return; event.preventDefault();
  if ($("main").contains(document.activeElement)) (state.page === "home" ? $("home") : $("task-list").querySelector<HTMLButtonElement>('[aria-current="page"]') ?? $("home")).focus(); else focusMain();
});
window.delta.onProgress(operation => {
  const old = state.operations.find(item => item.id === operation.id); addOperation(operation);
  if (operation.action !== "restore-plan" && old?.status !== operation.status && !["running", "queued"].includes(operation.status)) notify(`${taskName(operation.taskId)}: ${statusLabel(operation.status).toLocaleLowerCase("en-GB")}.`, operation.status === "failed");
});
void refresh().catch(error => { pageLayout(heading("Could not load configuration"), undefined, "Configuration error content").append(notice(errorText(error), "error"), button("Try again", () => refresh())); });
