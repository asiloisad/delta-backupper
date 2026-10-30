import type { BrowserWindow, BrowserWindowConstructorOptions, IpcMain, IpcMainInvokeEvent, Rectangle } from "electron";
import { pathToFileURL } from "node:url";
import type { AppConfig } from "../domain/models.js";
import type { Operation } from "../service/api.js";

export interface TrayProgress { phase?: string; files?: number; bytes?: number; completedFiles?: number; completedBytes?: number; errors?: number; path?: string; message?: string; totalFiles?: number; totalBytes?: number }
export interface TrayOperation { id: string; taskId: string; action: string; status: Operation["status"]; startedAt: string; paused?: boolean; finishedAt?: string; progress?: TrayProgress; error?: string }
export interface TraySnapshot { app: Pick<AppConfig, "theme" | "themeFamily" | "schedulerPaused">; tasks: Array<{ id: string; name: string }>; operations: TrayOperation[]; now: number; error?: string }
export type TrayPopupAction = { action: "open"; taskId?: string } | { action: "pause" | "resume" | "quit" | "dismiss" } | { action: "cancel"; operationId: string } | { action: "resize"; height: number };

/** A small projection deliberately excludes task paths, settings, credentials and operation results. */
export function createTraySnapshot(settings: AppConfig, tasks: Array<{ id: string; name: string }>, operations: Iterable<Operation>, now = Date.now()): TraySnapshot {
  const values = [...operations], active = values.filter(operation => ["queued", "running"].includes(operation.status));
  const recent = values.filter(operation => !["queued", "running"].includes(operation.status)).sort((a, b) => (b.finishedAt ?? b.startedAt).localeCompare(a.finishedAt ?? a.startedAt)).slice(0, 5);
  return {
    app: { theme: settings.theme, themeFamily: settings.themeFamily, schedulerPaused: settings.schedulerPaused },
    tasks: tasks.map(task => ({ id: task.id, name: task.name })),
    operations: [...active, ...recent].map(operation => {
      const value: TrayOperation = { id: operation.id, taskId: operation.taskId, action: operation.action, status: operation.status, startedAt: operation.startedAt };
      if (operation.paused !== undefined) value.paused = operation.paused;
      if (operation.finishedAt) value.finishedAt = operation.finishedAt;
      if (operation.error) value.error = operation.error;
      if (operation.progress && typeof operation.progress === "object" && !Array.isArray(operation.progress)) {
        const raw = operation.progress as Record<string, unknown>, progress: TrayProgress = {};
        for (const key of ["phase", "path", "message"] as const) if (typeof raw[key] === "string") progress[key] = raw[key].slice(0, 32768);
        for (const key of ["files", "bytes", "completedFiles", "completedBytes", "errors", "totalFiles", "totalBytes"] as const) if (typeof raw[key] === "number" && Number.isSafeInteger(raw[key]) && raw[key] >= 0) progress[key] = raw[key];
        value.progress = progress;
      }
      return value;
    }),
    now,
  };
}

/** Work-area coordinates are device-independent and may be negative on secondary displays. */
export function trayPopupBounds(anchor: Rectangle, workArea: Rectangle, size = { width: 340, height: 132 }): Rectangle {
  const gap = 8, marginX = Math.min(gap, Math.max(0, Math.floor((workArea.width - 1) / 2))), marginY = Math.min(gap, Math.max(0, Math.floor((workArea.height - 1) / 2)));
  const width = Math.max(1, Math.min(size.width, workArea.width - 2 * marginX)), height = Math.max(1, Math.min(size.height, workArea.height - 2 * marginY));
  const clamp = (value: number, minimum: number, maximum: number) => Math.round(Math.min(Math.max(value, minimum), Math.max(minimum, maximum)));
  let x = anchor.x + anchor.width - width;
  if (anchor.x >= workArea.x + workArea.width) x = anchor.x - width - gap;
  else if (anchor.x + anchor.width <= workArea.x) x = anchor.x + anchor.width + gap;
  const below = anchor.y + anchor.height + gap;
  const y = below + height <= workArea.y + workArea.height - gap ? below : anchor.y - height - gap;
  return { x: clamp(x, workArea.x + marginX, workArea.x + workArea.width - width - marginX), y: clamp(y, workArea.y + marginY, workArea.y + workArea.height - height - marginY), width, height };
}

export function validateTrayRequest(value: unknown): TrayPopupAction | { action: "snapshot" } {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error("Invalid tray request");
  const request = value as Record<string, unknown>;
  if (typeof request.action !== "string" || !["snapshot", "open", "pause", "resume", "quit", "cancel", "dismiss", "resize"].includes(request.action)) throw new Error("Unknown tray action");
  const allowed = request.action === "open" ? ["action", "taskId"] : request.action === "cancel" ? ["action", "operationId"] : request.action === "resize" ? ["action", "height"] : ["action"];
  if (Object.keys(request).some(key => !allowed.includes(key))) throw new Error("Unexpected tray action field");
  if (request.action === "cancel") {
    if (typeof request.operationId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(request.operationId)) throw new Error("Invalid tray operation ID");
  }
  if (request.action === "open" && Object.hasOwn(request, "taskId") && (typeof request.taskId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(request.taskId))) throw new Error("Invalid tray task ID");
  if (request.action === "resize" && (!Number.isInteger(request.height) || (request.height as number) < 120 || (request.height as number) > 560)) throw new Error("Invalid tray menu height");
  return request as unknown as TrayPopupAction | { action: "snapshot" };
}

interface TrayPopupPorts {
  createWindow(options: BrowserWindowConstructorOptions): BrowserWindow;
  ipc: Pick<IpcMain, "handle" | "removeHandler">;
  workArea(anchor: Rectangle): Rectangle;
  snapshot(): TraySnapshot | Promise<TraySnapshot>;
  action(request: TrayPopupAction): void | Promise<void>;
  background(): string;
  report(error: unknown): void;
  file: string;
  preload: string;
  throttleMs?: number;
}

export class TrayPopup {
  private target: BrowserWindow | undefined;
  private creating: Promise<BrowserWindow> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private elapsed: ReturnType<typeof setInterval> | undefined;
  private blurTimer: ReturnType<typeof setTimeout> | undefined;
  private publishing = false;
  private dirty = false;
  private closed = false;
  private lastPublished = 0;
  private visibilityRevision = 0;
  private anchor: Rectangle | undefined;
  private height = 132;
  private css = "";
  private cssKey: string | undefined;
  private appliedCss: string | undefined;
  private cssUpdates = Promise.resolve();
  private readonly url: string;
  constructor(private readonly ports: TrayPopupPorts) {
    this.url = pathToFileURL(ports.file).href;
    ports.ipc.handle("delta:tray-request", async (event: IpcMainInvokeEvent, value: unknown) => {
      const window = this.target;
      if (this.closed || !window || window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== this.url) throw new Error("Untrusted tray request");
      const request = validateTrayRequest(value);
      if (request.action === "snapshot") return this.snapshot();
      if (request.action === "resize") { this.height = request.height; this.fitWindow(); return; }
      if (request.action === "dismiss") { this.hide(); return; }
      if (["open", "quit"].includes(request.action)) this.hide();
      await this.ports.action(request);
      this.update();
    });
  }
  get window(): BrowserWindow | undefined { return this.target && !this.target.isDestroyed() ? this.target : undefined; }
  snapshot(): TraySnapshot | Promise<TraySnapshot> { return this.ports.snapshot(); }
  private async ensureWindow(): Promise<BrowserWindow> {
    if (this.closed) throw new Error("Tray popup is closed");
    if (this.creating) return this.creating;
    if (this.window) return this.window;
    this.creating = (async () => {
      const window = this.ports.createWindow({ title: "Delta Backupper", width: 340, height: 132, show: false, frame: false, transparent: false, resizable: false, minimizable: false, maximizable: false, fullscreenable: false, skipTaskbar: true, alwaysOnTop: true, autoHideMenuBar: true, backgroundColor: this.ports.background(), webPreferences: { preload: this.ports.preload, sandbox: true, contextIsolation: true, nodeIntegration: false, devTools: false } });
      this.target = window;
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      window.webContents.on("will-navigate", event => event.preventDefault());
      window.webContents.on("will-frame-navigate", event => event.preventDefault());
      window.webContents.on("before-input-event", (event, input) => { if (input.type === "keyDown" && input.key === "Escape") { event.preventDefault(); this.hide(); } });
      window.webContents.on("render-process-gone", () => { this.hide(); if (!window.isDestroyed()) window.destroy(); });
      window.webContents.on("did-finish-load", () => { this.cssKey = undefined; this.appliedCss = undefined; void this.setUserStyles(this.css).catch(this.ports.report); });
      window.on("blur", () => {
        if (!window.isVisible() || window.isFocused()) return;
        const revision = this.visibilityRevision;
        clearTimeout(this.blurTimer);
        // Native blur can arrive after hide followed by an immediate reopening.
        // Let the requested focus settle, then dismiss only this visible generation.
        this.blurTimer = setTimeout(() => {
          this.blurTimer = undefined;
          if (!this.closed && this.window === window && revision === this.visibilityRevision && window.isVisible() && !window.isFocused()) this.hide();
        }, 50);
        this.blurTimer.unref?.();
      });
      window.on("close", event => { if (!this.closed) { event.preventDefault(); this.hide(); } });
      window.on("closed", () => { if (this.target === window) { this.target = undefined; this.stopTimers(); } });
      try { await window.loadFile(this.ports.file); }
      catch (error) { if (!window.isDestroyed()) window.destroy(); throw error; }
      if (this.closed) { if (!window.isDestroyed()) window.destroy(); throw new Error("Tray popup was closed while loading"); }
      return window;
    })();
    try { return await this.creating; } finally { this.creating = undefined; }
  }
  async show(anchor: Rectangle): Promise<void> {
    const revision = ++this.visibilityRevision;
    clearTimeout(this.blurTimer); this.blurTimer = undefined;
    const window = await this.ensureWindow();
    if (this.closed || revision !== this.visibilityRevision || window.isDestroyed()) return;
    this.anchor = { ...anchor }; this.fitWindow();
    window.setBackgroundColor(this.ports.background());
    await this.setUserStyles(this.css);
    if (this.closed || revision !== this.visibilityRevision || window.isDestroyed()) return;
    window.show(); window.focus();
    if (!this.elapsed) { this.elapsed = setInterval(() => this.update(), 1000); this.elapsed.unref?.(); }
    this.dirty = true;
    await this.publish();
  }
  hide(): void {
    this.visibilityRevision++;
    this.window?.hide(); this.stopTimers(); this.dirty = false;
  }
  private fitWindow(): void {
    const window = this.window;
    if (this.closed || !window || !this.anchor) return;
    const bounds = trayPopupBounds(this.anchor, this.ports.workArea(this.anchor), { width: 340, height: this.height });
    const current = window.getBounds();
    if (bounds.x !== current.x || bounds.y !== current.y || bounds.width !== current.width || bounds.height !== current.height) window.setBounds(bounds);
  }
  setUserStyles(css: string): Promise<void> {
    this.css = css;
    this.cssUpdates = this.cssUpdates.catch(() => {}).then(async () => {
      const window = this.window;
      if (this.closed || !window || window.webContents.isLoadingMainFrame() || this.appliedCss === this.css) return;
      const css = this.css, previous = this.cssKey;
      const key = css ? await window.webContents.insertCSS(css) : undefined;
      if (this.closed || this.window !== window) return;
      this.cssKey = key; this.appliedCss = css;
      if (previous && previous !== key && !window.isDestroyed()) await window.webContents.removeInsertedCSS(previous);
    });
    return this.cssUpdates;
  }
  update(): void {
    if (this.closed || !this.window?.isVisible()) return;
    this.dirty = true;
    if (this.timer || this.publishing) return;
    const delay = Math.max(0, (this.ports.throttleMs ?? 200) - (Date.now() - this.lastPublished));
    this.timer = setTimeout(() => { this.timer = undefined; void this.publish().catch(this.ports.report); }, delay);
    this.timer.unref?.();
  }
  private async publish(): Promise<void> {
    const window = this.window;
    if (this.closed || !window?.isVisible() || this.publishing) return;
    this.publishing = true; this.dirty = false;
    try {
      const snapshot = await this.snapshot();
      if (!this.closed && this.window === window && window.isVisible()) { window.setBackgroundColor(this.ports.background()); window.webContents.send("delta:tray-update", snapshot); this.lastPublished = Date.now(); }
    } finally { this.publishing = false; if (this.dirty) this.update(); }
  }
  private stopTimers() { clearTimeout(this.timer); clearInterval(this.elapsed); clearTimeout(this.blurTimer); this.timer = undefined; this.elapsed = undefined; this.blurTimer = undefined; }
  close(): void {
    if (this.closed) return;
    this.closed = true; this.visibilityRevision++; this.stopTimers(); this.ports.ipc.removeHandler("delta:tray-request");
    if (this.window) this.window.destroy(); this.target = undefined;
  }
}
