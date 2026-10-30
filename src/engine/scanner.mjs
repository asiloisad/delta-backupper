import { opendir, lstat, stat, realpath, readlink } from 'node:fs/promises';
import { resolve, join, relative, dirname, basename } from 'node:path';
import { safeId, safePath, within } from './storage.mjs';
import { resolveTaskSources, sourcePathKey } from '../domain/source-identity.mjs';

function globRegex(glob) {
  if (typeof glob !== 'string' || glob.length > 4096) throw new Error('Invalid filter');
  if (glob.endsWith('/**')) glob = glob.slice(0, -3);
  let result = '^';
  for (let i = 0; i < glob.length; i++) { const c = glob[i]; if (c === '*' && glob[i + 1] === '*') { i++; if (glob[i + 1] === '/') { i++; result += '(?:.*/)?'; } else result += '.*'; } else if (c === '*') result += '[^/]*'; else if (c === '?') result += '[^/]'; else result += c.replace(/[\\^$+?.()|{}\[\]]/g, '\\$&'); }
  return new RegExp(`${result}(?:/.*)?$`);
}
export function validateSourceFilters(filters) {
  if (filters === undefined) return { include: [], exclude: [] };
  if (!filters || typeof filters !== 'object' || Array.isArray(filters) || Object.keys(filters).some(key => !['include', 'exclude'].includes(key)) || !Array.isArray(filters.include) || !Array.isArray(filters.exclude) || [...filters.include, ...filters.exclude].some(pattern => typeof pattern !== 'string' || pattern.length > 4096)) throw new Error('Invalid source filters: include and exclude must be string arrays');
  return { include: [...filters.include], exclude: [...filters.exclude] };
}
export function makeFilter(filters) { const checked = validateSourceFilters(filters); const include = checked.include.map(globRegex), exclude = checked.exclude.map(globRegex); return (path, directory = false) => !exclude.some(x => x.test(path)) && (directory || !include.length || include.some(x => x.test(path))); }
function pythonGlob(pattern) {
  const segments = pattern.replaceAll('\\', '/').split('/');
  const segment = text => {
    let result = text.startsWith('.') ? '' : '(?!\\.)';
    for (let index = 0; index < text.length; index++) {
      const char = text[index];
      if (char === '*') result += '[^/]*'; else if (char === '?') result += '[^/]';
      else if (char === '[' && text.indexOf(']', index + 1) > index + 1) {
        const end = text.indexOf(']', index + 1); let body = text.slice(index + 1, end); if (body.startsWith('!')) body = `^${body.slice(1)}`; else if (body.startsWith('^')) body = `\\${body}`;
        result += `[${body}]`; index = end;
      } else result += char.replace(/[\\^$+?.()|{}\[\]]/g, '\\$&');
    }
    return result;
  };
  const expression = new RegExp(`^${segments.map((part, index) => part === '**' ? index < segments.length - 1 ? '(?:(?!\\.)[^/]+/)*' : '(?:(?!\\.)[^/]+(?:/(?!\\.)[^/]+)*)?' : segment(part) + (index < segments.length - 1 ? '/' : '')).join('')}$`);
  const tests = segments.map(part => part === '**' ? null : new RegExp(`^${segment(part)}$`));
  const closure = positions => { for (const position of positions) if (segments[position] === '**') positions.add(position + 1); return positions; };
  expression.prefix = name => {
    let positions = closure(new Set([0]));
    for (const part of name.split('/')) {
      const next = new Set();
      for (const position of positions) {
        if (segments[position] === '**' && !part.startsWith('.')) next.add(position);
        else if (tests[position]?.test(part)) next.add(position + 1);
      }
      positions = closure(next); if (!positions.size) return false;
    }
    return true;
  };
  return expression;
}
/** Python's glob/regex select entries; only GUI excludes prune traversal. */
export function makeSourceFilter(source) {
  const extra = makeFilter(source.filters), pattern = pythonGlob(source.pattern ?? '**');
  const expression = source.expression ? new RegExp(`^(?:${source.expression})$`) : null;
  const filter = (name, directory = false) => extra(name, directory) && pattern.test(name) && !expression?.test(name);
  filter.traverse = name => extra(name, true) && pattern.prefix(name);
  return filter;
}
export function fingerprint(st) { return { size: Number(st.size), mtimeNs: String(st.mtimeNs), mode: Number(st.mode & 0o777n) }; }
export async function validateSources(task, destination, sources = resolveTaskSources(task)) {
  if (!sources.length) throw new Error('Task has no sources');
  const canonicalDestination = await realpath(destination); const ids = new Set(), paths = new Set(); const result = [];
  for (const source of sources) {
    if (Object.hasOwn(source, 'label')) throw new Error('Source names are not supported');
    safeId(source.id); if (ids.has(source.id)) throw new Error('Duplicate source ID'); ids.add(source.id); const filters = validateSourceFilters(source.filters);
    const path = resolve(task.wdir ?? destination, source.path); const info = await lstat(path);
    const pathKey = sourcePathKey(path); if (paths.has(pathKey)) throw new Error('Duplicate source path'); paths.add(pathKey);
    // A preserved/skipped root link is the link object, not its target. Resolve
    // its parent only so a broken link remains a valid source and aliases of
    // the destination still cannot hide a link stored inside the repository.
    const canonical = info.isSymbolicLink() && task.symlinks !== 'follow' ? join(await realpath(dirname(path)), basename(path)) : await realpath(path);
    if (within(canonicalDestination, canonical)) throw new Error(canonical === canonicalDestination ? 'Source and destination are identical' : 'Source is inside the backup destination');
    result.push({ ...source, filters, path, canonicalPath: canonical, singleFile: info.isFile() || info.isSymbolicLink() && task.symlinks === 'follow' && (await stat(path)).isFile() });
  }
  return result;
}
export async function* scanSources(task, destination, sources, options = {}) {
  const destinationReal = await realpath(destination); const ancestors = new Set();
  async function* walk(source, absolute, path, filter) {
    await options.waitIfPaused?.();
    options.signal?.throwIfAborted();
    if (options.excludedSourcePaths?.some(x => x.sourceId === source.id && (path === x.path || path.startsWith(`${x.path}/`)))) return;
    const logical = path ? `${source.id}/${path}` : source.id;
    try {
      let st = await lstat(absolute, { bigint: true }); let target;
      if (st.isSymbolicLink()) {
        if (task.symlinks === 'skip') return;
        target = await readlink(absolute);
        st = await stat(absolute, { bigint: true });
      }
      if (path && !(st.isDirectory() ? filter.traverse(path) : filter(path))) return;
      const canonical = await realpath(absolute);
      if (within(destinationReal, canonical)) return;
      if (st.isDirectory()) {
        if (ancestors.has(canonical)) throw new Error('Symbolic link/junction loop detected');
        ancestors.add(canonical);
        try {
          if (path && filter(path, true)) yield { sourceId: source.id, path, kind: 'directory', absolute, ...fingerprint(st) };
          const directory = await opendir(absolute);
          for await (const item of directory) { await options.waitIfPaused?.(); options.signal?.throwIfAborted(); safePath(item.name); const child = path ? `${path}/${item.name}` : item.name; if (!filter.traverse(child)) continue; yield* walk(source, join(absolute, item.name), child, filter); }
        } finally { ancestors.delete(canonical); }
      } else if (st.isFile()) { if (!path || filter(path)) yield { sourceId: source.id, path, kind: 'file', absolute, ...fingerprint(st) }; }
      else throw new Error('Unsupported special file');
    } catch (error) { if (options.signal?.aborted) throw error; yield { sourceId: source.id, path, kind: 'missing', absolute, error: error.message, code: error.code ?? 'SCAN_ERROR', logical }; }
  }
  for (const source of sources) {
    const filter = makeSourceFilter(source);
    const st = await lstat(source.path); yield* walk(source, source.path, st.isDirectory() ? '' : basename(source.path), filter);
  }
}
