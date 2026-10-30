import path from 'node:path';
import { homedir } from 'node:os';

/** Persist Windows paths with forward slashes; a POSIX backslash is part of a filename. */
export function portablePath(value) { return process.platform === 'win32' ? value.replaceAll('\\', '/') : value; }
/** Filter patterns describe paths, so their separators are portable on every OS. */
export function portableGlob(value) { return value.replaceAll('\\', '/'); }

export function expandSourcePath(value) {
  return value.replace(/^~(?=$|[\\/])/, homedir()).replace(/\$(?:\{([^}]+)\}|([A-Za-z_][A-Za-z0-9_]*))|%([^%]+)%/g, (text, braced, name, windows) => process.env[braced ?? name ?? windows] ?? text);
}

/** Duplicate checking is lexical and never depends on a mounted source. */
export function sourcePathKey(sourcePath) {
  if (typeof sourcePath !== 'string' || !sourcePath.trim() || sourcePath.includes('\0')) throw new Error('Source path must be a nonempty string without NUL');
  let key = path.normalize(sourcePath);
  const root = path.parse(key).root;
  while (key.length > root.length && key.endsWith(path.sep)) key = key.slice(0, -1);
  return process.platform === 'win32' ? key.toLowerCase() : key;
}

/** Source numbers only correlate an execution with a native snapshot provider. */
export function resolveTaskSources(task) {
  if (!task) throw new Error('Task sources are required');
  const configured = task.srcs ?? task.sources?.map(source => source.path);
  if (!Array.isArray(configured)) throw new Error('Task sources are required');
  const seen = new Set();
  return configured.map((item, index) => {
    const [configuredPath, pattern, expression] = Array.isArray(item) ? item : [item];
    const source = { path: configuredPath, filters: task.sources?.find(source => source.path === configuredPath)?.filters ?? task.filters?.[configuredPath] ?? { include: [], exclude: [] } };
    const key = sourcePathKey(source.path);
    if (seen.has(key)) throw new Error('Duplicate source path');
    seen.add(key);
    // The native helper protocol uses UUID-shaped request tokens. This is only
    // an array index for this invocation, never a stored source identity.
    const token = `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
    return { ...source, id: token, configuredPath, ...(pattern ? { pattern } : {}), ...(expression ? { expression } : {}) };
  });
}

/** Match delta.py's mode: relative, configured path, or absolute path; strip drive/root. */
export function archiveSourcePath(task, source, relativePath) {
  const configured = expandSourcePath(source.configuredPath ?? source.path);
  const directory = source.singleFile ? path.dirname(configured) : configured;
  const base = task.mode === 2 ? path.resolve(task.wdir ?? process.cwd(), directory) : task.mode === 1 ? directory : '';
  let name = base ? path.join(base, relativePath) : relativePath;
  name = name.replaceAll('\\', '/').replace(/^[A-Za-z]:/, '').replace(/^\/+/, '');
  return name;
}
