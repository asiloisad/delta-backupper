import { lstat, readlink, opendir, realpath } from 'node:fs/promises';
import { win32 as path } from 'node:path';
import { fingerprint, makeSourceFilter } from '../engine/scanner.mjs';
import { safePath } from '../engine/storage.mjs';

const lower = value => value.toLowerCase();
function pathText(value) { return path.normalize(value).replace(/^[a-z]:/i, drive => drive.toUpperCase()).replace(/\\$/, ''); }
// NTFS can distinguish directory components by case. Only drive letters have
// unconditional case-insensitive identity; aliases use observed inode IDs.
function inside(parent, child) { parent = pathText(parent); child = pathText(child); return child === parent || child.startsWith(`${parent}\\`); }
function failure(message, code = 'VSS_LINK_UNAVAILABLE') { return Object.assign(new Error(message), { code }); }
function checked(value) {
  if (typeof value !== 'string' || !value || value.length > 32768 || value.includes('\0') || !value.isWellFormed()) throw failure('Invalid VSS link path');
  return value.replaceAll('/', '\\');
}

// Every filesystem operation below addresses one already inspected component
// beneath a snapshot device. Letting realpath/stat follow a snapshot's junction
// would allow Windows to redirect the operation into the live filesystem.
export function createVssPathResolver(mappings, io = { lstat, readlink }) {
  const volumes = [...mappings].sort((a, b) => b.root.length - a.root.length);
  const cache = new Map();
  const physical = ({ mapping, parts }) => `${mapping.device.replace(/\\$/, '')}\\${parts.join('\\')}`;
  const logical = ({ mapping, parts }) => path.join(mapping.root, ...parts);
  const identity = (current, info) => typeof info.ino === 'bigint' && info.ino > 0n ? `${lower(current.mapping.guid)}:${info.ino}` : `${lower(current.mapping.guid)}:${current.parts.join('\\')}`;
  function reference(value, parent) {
    value = checked(value);
    const direct = volumes.find(volume => lower(value) === lower(volume.device.replace(/\\$/, '')) || lower(value).startsWith(lower(`${volume.device.replace(/\\$/, '')}\\`)));
    if (direct) value = `${direct.guid}${value.slice(direct.device.replace(/\\$/, '').length).replace(/^\\/, '')}`;
    if (/^\\\?\?\\/i.test(value)) value = `\\\\?\\${value.slice(4)}`;
    const guid = /^\\\\\?\\(Volume\{[0-9a-f-]{36}\})\\/i.exec(value);
    if (guid) {
      const mapping = volumes.find(volume => lower(volume.guid) === lower(`\\\\?\\${guid[1]}\\`));
      if (!mapping) throw failure('VSS link targets a volume outside the snapshot lease');
      const suffix = path.normalize(`\\${value.slice(guid[0].length)}`).slice(1);
      if (suffix.includes(':')) throw failure('VSS link targets an alternate data stream');
      return { mapping, parts: suffix.split('\\').filter(Boolean) };
    }
    if (/^\\\\\?\\[a-z]:\\/i.test(value)) value = value.slice(4);
    if (value.startsWith('\\\\') || /^[a-z]:(?!\\)/i.test(value)) throw failure('VSS link requires an absolute local path in the snapshot lease');
    if (!/^[a-z]:\\/i.test(value)) {
      if (!parent) throw failure('VSS source is not an absolute local path');
      value = path.resolve(path.dirname(parent), value);
    }
    value = path.normalize(value);
    if (value.slice(2).includes(':')) throw failure('VSS link targets an alternate data stream');
    const mapping = volumes.find(volume => inside(volume.root, value));
    if (!mapping) throw failure('VSS link targets a volume outside the snapshot lease');
    return { mapping, parts: path.relative(mapping.root, value).split('\\').filter(Boolean) };
  }
  async function resolve(value, signal, { followFinal = true } = {}) {
    let pending = reference(value); let expansions = 0; const visited = new Set();
    for (;;) {
      signal?.throwIfAborted();
      let current = { mapping: pending.mapping, parts: [] }; let info;
      const count = pending.parts.length;
      for (let index = -1; index < count; index++) {
        signal?.throwIfAborted();
        if (index >= 0) current.parts.push(pending.parts[index]);
        // NTFS can enable case sensitivity for individual directories. A
        // lowercased cache key could reuse a directory's type for a different
        // junction and accidentally let a later child lookup traverse it.
        const absolute = physical(current); const key = absolute;
        info = cache.get(key) ?? await io.lstat(absolute, { bigint: true });
        if (info.isSymbolicLink()) {
          if (index < 0) throw failure('VSS snapshot root is a reparse point');
          if (!followFinal && index === count - 1) return { absolute, logicalPath: logical(current), identity: identity(current, info), info };
          const linkIdentity = identity(current, info);
          if (++expansions > 64 || visited.has(linkIdentity)) throw failure('Symbolic link/junction loop detected', 'VSS_LINK_LOOP');
          visited.add(linkIdentity);
          const target = checked(await io.readlink(absolute));
          const next = reference(target, logical(current));
          // The remaining suffix cannot be opened through the link. Restart
          // component inspection at the target's attested snapshot device.
          pending = reference(path.join(logical(next), ...pending.parts.slice(index + 1)));
          break;
        }
        if (index < count - 1 && !info.isDirectory()) throw failure('A VSS path parent is not a directory', 'ENOTDIR');
        if (info.isDirectory()) {
          if (cache.size >= 512) cache.delete(cache.keys().next().value);
          cache.set(key, info);
        }
        if (index === count - 1) return { absolute, logicalPath: logical(current), identity: identity(current, info), info };
      }
    }
  }
  return { resolve, mappedPath(value) { return physical(reference(value)); } };
}

export function createVssSnapshotScanner(sources, mappings, io = { lstat, readlink, opendir, realpath }) {
  const resolver = createVssPathResolver(mappings, io);
  return async function* scan(task, destination, options = {}) {
    const ancestors = new Set();
    const destinationReal = await io.realpath(destination);
    const excludedDirectories = new Set();
    for (const candidate of new Set([destination, destinationReal])) {
      try { excludedDirectories.add((await resolver.resolve(candidate, options.signal)).identity); } catch (error) { if (options.signal?.aborted) throw error; /* Destination volume/path can be outside the snapshot. */ }
    }
    async function* walk(source, logicalPath, name, filter) {
      await options.waitIfPaused?.();
      options.signal?.throwIfAborted();
      // Live-source exclusions were computed with host path comparisons, which
      // may fold case. Decide from the resolved snapshot path and inode below.
      try {
        const resolved = await resolver.resolve(logicalPath, options.signal, { followFinal: task.symlinks === 'follow' }); const info = resolved.info;
        if (name && !(info.isDirectory() ? filter.traverse(name) : filter(name))) return;
        if (inside(destinationReal, resolved.logicalPath) || inside(destination, resolved.logicalPath) || excludedDirectories.has(resolved.identity)) return;
        if (info.isSymbolicLink()) {
          if (task.symlinks === 'skip') return;
          const target = await io.readlink(resolved.absolute); checked(target);
          yield { sourceId: source.id, path: name, kind: 'symlink', absolute: resolved.absolute, target, ...fingerprint(info) };
        } else if (info.isDirectory()) {
          if (ancestors.has(resolved.identity)) throw failure('Symbolic link/junction loop detected', 'VSS_LINK_LOOP');
          ancestors.add(resolved.identity);
          try {
            if (!name || filter(name, true)) yield { sourceId: source.id, path: name, kind: 'directory', absolute: resolved.absolute, ...fingerprint(info) };
            const directory = await io.opendir(resolved.absolute);
            for await (const item of directory) {
              await options.waitIfPaused?.(); options.signal?.throwIfAborted();
              safePath(item.name); const child = name ? `${name}/${item.name}` : item.name;
              if (filter.traverse(child)) yield* walk(source, path.join(resolved.logicalPath, item.name), child, filter);
            }
          } finally { ancestors.delete(resolved.identity); }
        } else if (info.isFile()) {
          if (!name || filter(name)) yield { sourceId: source.id, path: name, kind: 'file', absolute: resolved.absolute, ...fingerprint(info) };
        } else throw failure('Unsupported special file in VSS snapshot');
      } catch (error) {
        if (options.signal?.aborted) throw error;
        yield { sourceId: source.id, path: name, kind: 'missing', error: String(error.message), code: error.code ?? 'VSS_SCAN_ERROR' };
      }
    }
    for (const source of sources) {
      const filter = makeSourceFilter(source);
      // Source root failure is an operation error, rather than an apparently
      // successful empty snapshot. Every descendant failure stays explicit.
      const root = await resolver.resolve(source.path, options.signal, { followFinal: task.symlinks === 'follow' });
      yield* walk(source, source.path, root.info.isDirectory() ? '' : path.basename(source.path), filter);
    }
  };
}
