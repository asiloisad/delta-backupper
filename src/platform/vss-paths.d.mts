import type { TaskConfig, ResolvedSource } from '../domain/models.js';
import type { EngineOptions, Entry } from '../engine/index.mjs';
export interface SnapshotMapping { root: string; guid: string; device: string; snapshotId: string }
export function createVssPathResolver(mappings: SnapshotMapping[]): { resolve(value: string, signal?: AbortSignal, options?: { followFinal?: boolean }): Promise<{ absolute: string; logicalPath: string; identity: string; info: import('node:fs').BigIntStats }>; mappedPath(value: string): string };
export function createVssSnapshotScanner(sources: ResolvedSource[], mappings: SnapshotMapping[]): (task: TaskConfig, destination: string, options?: EngineOptions) => AsyncIterable<Entry & { absolute?: string }>;
