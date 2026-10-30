import type { TaskConfig, BackupType, ResolvedSource } from '../domain/models.js';
export interface ArchivePart { name: string; bytes: number; }
export interface RunSummary { id: string; cycleId: string; type: BackupType; baseRunId: string | null; startedAt: string; finishedAt: string | null; status: 'running' | 'complete' | 'incomplete' | 'cancelled' | 'failed'; files: number; bytes: number; errors: number; parts: ArchivePart[]; pinned: boolean; consistentSnapshot: boolean; resumedFrom: string | null; sourceConsistency: string; atomicSet?: boolean; committed?: boolean; compression?: number; storedSize?: number; error?: string; retentionError?: string; cleanupError?: string; checkpointError?: string; postCommitError?: string }
export interface Entry { path: string; kind: 'file' | 'directory' | 'symlink' | 'missing'; size: number; mtimeNs: string; mode: number; fingerprint?: string | null; sha256?: string | null; target?: string; error?: string; code?: string; }
export interface Progress { phase: string; runId?: string; files?: number; bytes?: number; completedFiles?: number; completedBytes?: number; totalFiles?: number; totalBytes?: number; errors?: number; path?: string; message?: string }
export interface SourceSession { sources: ResolvedSource[]; consistentSnapshot: boolean; snapshotLease?: Record<string, unknown>; sourceConsistency?: string; atomicSet?: boolean; followsLinksInSnapshot?: boolean; validateSources?(): Promise<void>; verify?(options?: { fresh?: boolean }): Promise<void>; release(outcome?: { success: boolean }): Promise<void>; scan?(task: TaskConfig, destination: string, options: EngineOptions): AsyncIterable<Entry & { providerEntryId?: string }>; openFile?(entry: Entry & { providerEntryId?: string }, options: { signal?: AbortSignal }): Promise<{ reader: { size: number; readable: ReadableStream<Uint8Array> }; digest(): string; close(): Promise<void> }> }
export interface EngineOptions { type?: BackupType; signal?: AbortSignal; waitIfPaused?: () => Promise<void>; cacheDirectory?: string; onProgress?: (event: Progress) => void; sourceProvider?: { prepare(task: TaskConfig, options: EngineOptions & { sources: ResolvedSource[] }): Promise<SourceSession> }; fault?: (stage: string, context: Record<string, unknown>) => Promise<void> | void; reuseRunId?: string }
export interface RestoreOptions extends EngineOptions { paths?: string[]; overwrite?: 'error' | 'skip' | 'replace'; restoreLinks?: boolean; maxErrors?: number; maxIssues?: number }
export interface RestorePlan { runId: string; status: 'ready' | 'blocked'; files: number; bytes: number; directories: number; links: number; skipped: number; conflicts: number; missing: number; unsafe: number; parts: number; issues: { path: string; error: string; kind: 'conflict' | 'missing' | 'unsafe' }[]; issuesTruncated: boolean; scope: string }
export interface ContentResult { runId: string; status: 'complete' | 'incomplete'; files: number; bytes: number; skipped: number; errors: { path: string; error: string }[] }
export function runBackup(task: TaskConfig, destination: string, options?: EngineOptions): Promise<RunSummary>;
export function listRuns(destination: string, options?: { includeUncommitted?: boolean; ignoreInvalid?: boolean; verifyManifest?: boolean; signal?: AbortSignal }): Promise<RunSummary[]>;
export function verifyRun(destination: string, runId: string, options?: RestoreOptions): Promise<ContentResult>;
export function restoreRun(destination: string, runId: string, outputDirectory: string, options?: RestoreOptions): Promise<ContentResult>;
export function planRestore(destination: string, runId: string, outputDirectory: string, options?: RestoreOptions): Promise<RestorePlan>;
export function resumeRun(task: TaskConfig, destination: string, runId: string, options?: EngineOptions): Promise<RunSummary>;
export const retryRun: typeof resumeRun;
export function applyRetention(task: TaskConfig, destination: string, options?: EngineOptions): Promise<{ removed: string[] }>;
export function recoverRetention(task: TaskConfig, destination: string, options?: EngineOptions): Promise<{ recovered: string[] }>;
export function pinRun(destination: string, runId: string, pinned?: boolean): Promise<RunSummary>;
export function unlockTask(destination: string, options: { token: string }): Promise<unknown>;
export function listRunEntries(destination: string, runId: string, options?: { offset?: number; limit?: number; query?: string }): Promise<{ entries: Entry[]; total: number; nextOffset: number | null; sourcePaths: Record<string, string> }>;
export function getRunDetails(destination: string, runId: string, options?: { limit?: number }): Promise<RunSummary & { taskConfig: TaskConfig; sourcePaths: Record<string, string>; fileErrors: { path: string; error: string; code?: string }[] }>;
export function getTaskStatus(destination: string): Promise<{ lock: { token: string; host: string; pid: number; createdAt: string } | null; lastRun: RunSummary | null; checkpoint: { runId: string; cycleId: string } | null; checkpointError?: string }>;

export function iterateRunEntries(destination: string, runId: string, options?: EngineOptions): AsyncGenerator<Entry>;
export function readLatestRunSummary(destination: string, options?: EngineOptions & { completeOnly?: boolean }): Promise<RunSummary | null>;
export function recoverTaskConfiguration(destination: string, runId?: string, options?: EngineOptions): Promise<TaskConfig>;
export interface DeleteRunPlan { runId: string; status: 'ready' | 'blocked'; allowed: boolean; files: string[]; fileDetails: { name: string; bytes: number }[]; bytes: number; blockers: string[] }
export function planDeleteRun(task: TaskConfig, destination: string, runId: string, options?: EngineOptions): Promise<DeleteRunPlan>;
export function deleteRun(task: TaskConfig, destination: string, runId: string, options?: EngineOptions): Promise<{ runId: string; deleted: string[]; bytes: number }>;
