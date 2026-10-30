import type { Notification, NotificationConstructorOptions } from "electron";
import type { Operation } from "../service/api.js";
import { notificationBlockedBySettings, WINDOWS_NOTIFICATIONS_BLOCKED, type NotificationPermission } from "./notification-permission.js";

export type NotificationResult = { supported: boolean; status: "submitted" | "unsupported" | "blocked" | "failed"; message?: string };
type NativeNotification = Pick<Notification, "on" | "show" | "close">;
export interface DesktopIntegrationPorts {
  enabled(): boolean;
  trayAvailable(): boolean;
  supported(): boolean;
  create(options: NotificationConstructorOptions): NativeNotification;
  permission?(): Promise<NotificationPermission>;
  prepare?(): Promise<unknown>;
  afterNativeAccess?(): Promise<unknown>;
  navigate(taskId?: string): Promise<void>;
  report(error: unknown): void;
  submissionTimeoutMs?: number;
  now?(): number;
}

/** Own native lifetimes independently of backup workers and renderer lifetimes. */
export class DesktopIntegration {
  private readonly seen = new Set<string>();
  private readonly live = new Set<NativeNotification>();
  private readonly pending = new Set<() => void>();
  private stopped = false;
  private lastNotification: NotificationResult | undefined;
  private permissionCache: { value: NotificationPermission; checkedAt: number } | undefined;
  private permissionCheck: Promise<NotificationPermission> | undefined;
  constructor(private readonly ports: DesktopIntegrationPorts) {}
  diagnostics() { return { trayAvailable: this.ports.trayAvailable(), retainedNotifications: this.live.size, seenOperations: this.seen.size, lastNotification: this.lastNotification }; }
  async handleOperation(operation: Operation, taskName?: string): Promise<void> {
    if (this.stopped || operation.action === "restore-plan" || ["queued", "running"].includes(operation.status) || this.seen.has(operation.id)) return;
    this.seen.add(operation.id);
    while (this.seen.size > 256) this.seen.delete(this.seen.values().next().value!);
    if (!this.ports.enabled()) return;
    const action = ({ run: "Backup", resume: "Backup", retry: "Backup retry", restore: "Restore", verify: "Verification", "scheduled-run": "Scheduled backup" } as Record<string, string>)[operation.action] ?? "Task";
    const result = operation.status === "complete" ? operation.error ? "complete with warnings" : "complete" : operation.status;
    await this.submit({ title: `${action} ${result}`, body: `${taskName?.trim().slice(0, 180) || "Delta Backupper"}${operation.status === "incomplete" ? " — the operation is incomplete. Open Activity for details." : operation.error ? " — open Activity for details." : ""}` }, operation.taskId);
  }
  testNotification(): Promise<NotificationResult> {
    return this.submit({ title: "Delta Backupper", body: "This is a test notification. Click to open Delta Backupper." }, undefined, true);
  }
  private now(): number { return this.ports.now?.() ?? performance.now(); }
  private async checkPermission(fresh: boolean): Promise<NotificationPermission> {
    if (!fresh && this.permissionCache && this.now() - this.permissionCache.checkedAt < 30_000) return this.permissionCache.value;
    if (!fresh && this.permissionCheck) return this.permissionCheck;
    if (!this.ports.permission) return { allowed: true };
    const check = this.ports.permission().catch(() => ({ allowed: true })).then(value => {
      this.permissionCache = { value, checkedAt: this.now() };
      return value;
    });
    this.permissionCheck = check;
    try { return await check; } finally { if (this.permissionCheck === check) this.permissionCheck = undefined; }
  }
  private nativeFailure(error: unknown, supported: boolean): NotificationResult {
    if (notificationBlockedBySettings(error)) {
      this.permissionCache = { value: { allowed: false, message: WINDOWS_NOTIFICATIONS_BLOCKED }, checkedAt: this.now() };
      return { supported: true, status: "blocked", message: WINDOWS_NOTIFICATIONS_BLOCKED };
    }
    this.ports.report(error instanceof Error ? error : new Error(String(error)));
    return { supported, status: "failed", message: error instanceof Error ? error.message : String(error) };
  }
  private async submit(options: NotificationConstructorOptions, taskId?: string, freshPermission = false): Promise<NotificationResult> {
    let supported = false;
    const remember = (value: NotificationResult) => { this.lastNotification = value; return value; };
    try {
      if (this.stopped) return remember({ supported: false, status: "failed", message: "The application is shutting down." });
      const permission = await this.checkPermission(freshPermission);
      if (this.stopped) return remember({ supported: false, status: "failed", message: "The application is shutting down." });
      if (!permission.allowed) return remember({ supported: true, status: "blocked", message: permission.message ?? WINDOWS_NOTIFICATIONS_BLOCKED });
      await this.ports.prepare?.();
      if (this.stopped) return remember({ supported: false, status: "failed", message: "The application is shutting down." });
      supported = this.ports.supported();
      if (!supported) return remember({ supported: false, status: "unsupported", message: "System notifications are not available on this computer." });
      await this.ports.afterNativeAccess?.();
      if (this.stopped) return remember({ supported, status: "failed", message: "The application is shutting down." });
      const notification = this.ports.create(options);
      this.live.add(notification);
      while (this.live.size > 32) {
        const oldest = this.live.values().next().value!;
        this.live.delete(oldest);
        try { oldest.close(); } catch (error) { this.ports.report(error); }
      }
      let clicked = false;
      notification.on("click", () => {
        if (clicked || this.stopped) return;
        clicked = true;
        void this.ports.navigate(taskId).catch(error => this.ports.report(error));
      });
      return await new Promise<NotificationResult>(resolve => {
        let settled = false;
        const finish = (value: NotificationResult) => {
          if (settled) return;
          settled = true; clearTimeout(timer); this.pending.delete(cancel); resolve(remember(value));
        };
        const cancel = () => finish({ supported, status: "failed", message: "The application is shutting down." });
        const timer = setTimeout(() => finish({ supported, status: "submitted" }), this.ports.submissionTimeoutMs ?? 1500);
        this.pending.add(cancel);
        // Electron may emit show before Windows asynchronously rejects delivery. Keep the short observation window open.
        notification.on("close", details => {
          // Windows can retain a timed-out banner in Notification Center, where it remains clickable.
          if (details?.reason !== "timedOut") this.live.delete(notification);
          finish({ supported, status: "submitted" });
        });
        notification.on("failed", (_event, error) => {
          this.live.delete(notification);
          const message = typeof error === "string" && error ? error : "The operating system could not display the notification.";
          const result = this.nativeFailure(message, supported);
          this.lastNotification = result;
          finish(result);
        });
        try { notification.show(); }
        catch (error) {
          this.live.delete(notification);
          finish(this.nativeFailure(error, supported));
        }
      });
    } catch (error) {
      return remember(this.nativeFailure(error, supported));
    }
  }
  close(): void {
    this.stopped = true;
    for (const cancel of this.pending) cancel();
    for (const notification of this.live) { try { notification.close(); } catch (error) { this.ports.report(error); } }
    this.live.clear();
  }
}
