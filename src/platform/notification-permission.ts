import { execFile } from "node:child_process";
import path from "node:path";

export interface NotificationPermission { allowed: boolean; message?: string }
export const WINDOWS_NOTIFICATIONS_BLOCKED = "Windows notifications are turned off. Enable them in Windows Settings → System → Notifications.";
const toastSettings = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\PushNotifications";

/** Match the Windows delivery-policy error, without disguising unrelated native failures. */
export function notificationBlockedBySettings(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /0x803e0114|-2143420140|settings prevent the notification type from being delivered|notification type is disabled by system settings/i.test(message);
}

export interface NotificationPermissionPorts {
  platform: NodeJS.Platform;
  query(): Promise<string>;
}

/** An absent setting or inaccessible registry is inconclusive: let the native API decide. */
export async function notificationPermission(ports: NotificationPermissionPorts): Promise<NotificationPermission> {
  if (ports.platform !== "win32") return { allowed: true };
  try {
    const output = await ports.query();
    const value = /^\s*ToastEnabled\s+REG_DWORD\s+(0x[0-9a-f]+|\d+)\s*$/im.exec(output)?.[1];
    if (value !== undefined && Number(value) === 0) return { allowed: false, message: WINDOWS_NOTIFICATIONS_BLOCKED };
  } catch { /* Registry access is a preflight hint, never a prerequisite for notification delivery. */ }
  return { allowed: true };
}

export function systemNotificationPermission(): Promise<NotificationPermission> {
  return notificationPermission({
    platform: process.platform,
    query: () => new Promise<string>((resolve, reject) => {
      const executable = path.win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "reg.exe");
      execFile(executable, ["query", toastSettings, "/v", "ToastEnabled"], { windowsHide: true, shell: false, timeout: 3000, maxBuffer: 16 * 1024 }, (error, stdout) => error ? reject(error) : resolve(stdout));
    }),
  });
}
