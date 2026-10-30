import type { TaskConfig, ResolvedSource } from '../domain/models.js';
import type { EngineOptions, Entry } from '../engine/index.mjs';
export interface PosixSnapshotMapping { root: string; snapshotPath: string; identity: string; device?: string | number | bigint; caseSensitive?: boolean; excludedRoots?: string[]; ignoredRoots?: string[] }
export interface PosixSnapshotResolvedPath { absolute: string; logicalPath: string; identity: string; info: import('node:fs').BigIntStats }
export interface PosixSnapshotIO { lstat: typeof import('node:fs/promises').lstat; readlink: typeof import('node:fs/promises').readlink; opendir: typeof import('node:fs/promises').opendir; realpath: typeof import('node:fs/promises').realpath }
export function createPosixSnapshotPathResolver(mappings: PosixSnapshotMapping[], io?: Pick<PosixSnapshotIO, 'lstat' | 'readlink'>): { resolve(value: string, signal?: AbortSignal, options?: { followFinal?: boolean }): Promise<PosixSnapshotResolvedPath>; mappedPath(value: string): string };
export function createPosixSnapshotScanner(sources: ResolvedSource[], mappings: PosixSnapshotMapping[], io?: PosixSnapshotIO): (task: TaskConfig, destination: string, options?: EngineOptions) => AsyncIterable<Entry & { absolute?: string }>;
