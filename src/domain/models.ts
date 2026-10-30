/** Public on-disk schema. Destination paths are relative to the task file. */
export const SCHEMA_VERSION = 1 as const;
export type BackupType = "full" | "incremental" | "differential";
export type RunStatus = "queued" | "running" | "completed" | "incomplete" | "cancelled" | "failed";
export type Identifier = string;
export type DeepPartial<T> = T extends readonly unknown[] ? T : T extends object ? { [P in keyof T]?: DeepPartial<T[P]> } : T;

export interface SourceConfig { path: string; filters: { include: string[]; exclude: string[] } }
export type PythonSource = string | [path: string, glob?: string | null, frex?: string | null];
/** Derived execution identity; never accepted or persisted in editable task configuration. */
export interface ResolvedSource extends SourceConfig { id: Identifier }
export interface ScheduleConfig {
  name: string;
  paused: boolean;
  kind: "manual" | "interval" | "daily" | "weekly";
  intervalMinutes: number;
  time: string;
  weekdays: number[];
  timeZone: string;
  missed: "run-once" | "skip";
  onDestinationAvailable: boolean;
}
export interface TaskSettings {
  wdir: string;
  mode: 0 | 1 | 2;
  schedulesPaused: boolean;
  sources: SourceConfig[];
  schedules: ScheduleConfig[];
  sequence: { types: BackupType[] };
  retention: { when: "before" | "after"; keepCycles: number; maxAgeDays: number; protectPinned: boolean };
  archive: { level: number };
  detection: "fast" | "hash";
  symlinks: "follow" | "skip";
  snapshot: { mode: "off" | "snapshot-only" | "writers"; fallback: "fail" | "live"; lvmCowSizeBytes: number };
  behavior: { continueOnFileError: boolean; retryCount: number; resume: boolean };
}
export interface TaskConfig extends TaskSettings {
  name: string;
  proj: string;
  srcs: PythonSource[];
}
export interface AppConfig {
  schemaVersion: 1;
  theme: "system" | "light" | "dark";
  themeFamily: "one" | "aura";
  language: "en";
  closeToTray: boolean;
  launchAtLogin: boolean;
  notifications: boolean;
  schedulerPaused: boolean;
  maxConcurrentTasks: number;
  updates: { repository: string; checkOnStartup: boolean; includePrereleases: boolean };
}
export type TaskDefaultSettings = Omit<TaskSettings, "sources">;
export interface TaskDefaults { schemaVersion: 1; settings: TaskDefaultSettings }
export interface GlobalConfig { schemaVersion: 1; application: Omit<AppConfig, "schemaVersion">; task: TaskDefaultSettings }
export type TaskRegistry = string[];
export interface OperationEvent {
  schemaVersion: 1;
  operationId: Identifier;
  taskId: Identifier;
  timestamp: string;
  type: "state" | "progress" | "file-error";
  status: RunStatus;
  completedFiles: number;
  completedBytes: number;
  message: string;
}
