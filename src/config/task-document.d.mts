import type { TaskConfig } from '../domain/models.js';
export class ConfigurationConflictError extends Error { readonly code: 'CONFIGURATION_CONFLICT'; constructor(message?: string); }
export interface TaskCatalog { hist: string[]; data: AsyncIterable<[string, string | null]>; }
export interface TaskDocument<T = Record<string, unknown>> { value: T; hist: string[]; pinned: string[]; revision: string; }
export function readTaskDocument(filename: string, options?: { signal?: AbortSignal }): Promise<TaskDocument>;
export function iterateTaskData(filename: string, options?: { signal?: AbortSignal }): AsyncGenerator<[string, string | null]>;
export function saveTaskDocument<T extends object = TaskConfig>(filename: string, settings: T, expectedRevision: string | null, options?: { guard?: () => Promise<void>; catalog?: TaskCatalog; pinned?: string[]; signal?: AbortSignal }): Promise<TaskDocument<T>>;
