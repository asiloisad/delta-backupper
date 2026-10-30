import type { ResolvedSource, TaskConfig } from './models.js';
export function portablePath(value: string): string;
export function portableGlob(value: string): string;
export function sourcePathKey(sourcePath: string): string;
export function resolveTaskSources(task: Pick<TaskConfig, 'sources'> & Partial<Pick<TaskConfig, 'srcs'>>): ResolvedSource[];
export function archiveSourcePath(task: Pick<TaskConfig, 'mode' | 'wdir'>, source: ResolvedSource & { configuredPath?: string }, relativePath: string): string;
