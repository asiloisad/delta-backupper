import type { TaskConfig } from '../domain/models.js';
export interface TaskCatalogOptions { task?: TaskConfig; signal?: AbortSignal; guard?: () => Promise<void> }
export function syncTaskCatalog(destination: string, options?: TaskCatalogOptions): Promise<{ hist: string[]; checkpointRunId: string | null }>;
