import type { AppConfig, GlobalConfig, ScheduleConfig, TaskDefaults, TaskSettings } from "../domain/models.js";

export function builtInSchedule(index = 0): ScheduleConfig {
  return { name: `Schedule ${index + 1}`, paused: false, kind: "manual", intervalMinutes: 1440, time: "20:00", weekdays: [1, 2, 3, 4, 5, 6, 7], timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC", missed: "run-once", onDestinationAvailable: false };
}

export function builtInSettings(): TaskSettings {
  return {
    wdir: "",
    mode: 0,
    schedulesPaused: false,
    sources: [],
    schedules: [],
    sequence: { types: ["full"] },
    retention: { when: "after", keepCycles: 0, maxAgeDays: 0, protectPinned: true },
    archive: { level: 6 },
    detection: "fast", symlinks: "follow",
    snapshot: { mode: "off", fallback: "fail", lvmCowSizeBytes: 8 * 1024 ** 3 },
    behavior: { continueOnFileError: true, retryCount: 0, resume: true },
  };
}
export function builtInAppConfig(): AppConfig {
  return { schemaVersion: 1, theme: "system", themeFamily: "one", language: "en", closeToTray: true, launchAtLogin: false, notifications: true, schedulerPaused: false, maxConcurrentTasks: 1, updates: { repository: "", checkOnStartup: false, includePrereleases: false } };
}
export function builtInTaskDefaults(): TaskDefaults { const { sources: _sources, ...settings } = builtInSettings(); return { schemaVersion: 1, settings }; }
export function builtInGlobalConfig(): GlobalConfig { const { schemaVersion: _schema, ...app } = builtInAppConfig(); return { schemaVersion: 1, application: app, task: builtInTaskDefaults().settings }; }
