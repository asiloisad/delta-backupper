export interface ApplicationPathOptions { platform?: NodeJS.Platform; environment?: NodeJS.ProcessEnv; homeDirectory?: string }
export function runtimeDirectory(configDirectory: string, options?: ApplicationPathOptions): string;
export function ensurePrivateDirectory(directory: string): Promise<string>;
export function ensureRuntimeDirectory(configDirectory: string): Promise<string>;
