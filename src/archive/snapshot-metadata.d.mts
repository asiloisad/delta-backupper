export interface MetadataOptions { signal?: AbortSignal; waitIfPaused?: () => Promise<void>; expectedName?: string; maxBytes?: number; cacheDirectory?: string }
export function readArchiveComment(filename: string, options?: MetadataOptions): Promise<Record<string, any>>;
export function extractMetadataEntry(filename: string, outputFilename: string, options?: MetadataOptions): Promise<{ bytes: number; sha256: string; name: string }>;
export function readSnapshotHeader(filename: string, options?: MetadataOptions): Promise<Record<string, any>>;
