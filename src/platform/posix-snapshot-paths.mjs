import { lstat, readlink, opendir, realpath } from 'node:fs/promises';
import { posix as path } from 'node:path';
import { fingerprint, makeSourceFilter } from '../engine/scanner.mjs';
import { safePath } from '../engine/storage.mjs';

function failure(message, code = 'SNAPSHOT_PATH_UNAVAILABLE') { return Object.assign(new Error(message), { code }); }
function checked(value) {
  if (typeof value !== 'string' || !value || value.length > 32768 || value.includes('\0') || !value.isWellFormed()) throw failure('Invalid snapshot path');
  return value;
}
function absolute(value) { checked(value); if (!path.isAbsolute(value)) throw failure('Snapshot mappings and sources require absolute POSIX paths'); return value; }
function normalized(value) { const result = path.normalize(absolute(value)); return result === '/' ? result : result.replace(/\/$/, ''); }
function inside(parent, child) { return parent === '/' || child === parent || child.startsWith(`${parent}/`); }
function matches(mapping, parent, child) { return mapping.caseSensitive === false ? inside(parent.toLowerCase(), child.toLowerCase()) : inside(parent, child); }
function components(value) { return value.split('/').filter(Boolean); }

// The helper attests and owns immutable, read-only mount roots until release.
// Never stat/realpath through a link: inspect each component and reopen a link's
// target through its separately attested snapshot, including absolute links.
export function createPosixSnapshotPathResolver(mappings, io = { lstat, readlink }) {
  if (!Array.isArray(mappings) || !mappings.length || mappings.length > 1024) throw failure('Invalid snapshot mappings');
  const roots = new Set();
  const volumes = mappings.map(value => {
    const root = normalized(value.root); const snapshotPath = normalized(value.snapshotPath);
    if (roots.has(root) || root === snapshotPath || typeof value.identity !== 'string' || !value.identity || value.identity.length > 1024 || value.identity.includes('\0')) throw failure('Invalid or duplicate snapshot mapping');
    roots.add(root);
    const exclusions = values => values.map(excluded => {
      const excludedPath = normalized(excluded);
      if (!matches(value, root, excludedPath)) throw failure('Snapshot exclusion lies outside its mapping');
      return excludedPath;
    });
    return { ...value, root, snapshotPath, excludedRoots: exclusions(value.excludedRoots ?? []), ignoredRoots: exclusions(value.ignoredRoots ?? []), rootParts: components(root) };
  }).sort((a, b) => b.rootParts.length - a.rootParts.length);
  const directories = new Map();
  function locate(value) {
    const tokens = components(absolute(value));
    const mapping = volumes.find(candidate => candidate.rootParts.every((part, index) => candidate.caseSensitive === false ? tokens[index]?.toLowerCase() === part.toLowerCase() : tokens[index] === part));
    if (!mapping) throw failure('Path targets a filesystem outside the snapshot lease');
    return { mapping, tokens: tokens.slice(mapping.rootParts.length) };
  }
  function selected(value) { return volumes.find(candidate => matches(candidate, candidate.root, value)); }
  function guard(mapping, value) {
    if (mapping.ignoredRoots.some(excluded => matches(mapping, excluded, value))) throw failure('Path belongs to protected snapshot infrastructure', 'SNAPSHOT_INTERNAL_PATH');
    if (mapping.excludedRoots.some(excluded => matches(mapping, excluded, value))) throw failure('Path crosses a mount or subvolume without its own snapshot lease', 'SNAPSHOT_MOUNT_UNAVAILABLE');
  }
  const physical = (mapping, parts) => path.join(mapping.snapshotPath, ...parts);
  const identity = (mapping, value, info) => typeof info.ino === 'bigint' && info.ino > 0n ? `${mapping.identity}:${info.dev}:${info.ino}` : `${mapping.identity}:${value}`;
  async function metadata(mapping, parts, expectedDevice, signal) {
    signal?.throwIfAborted();
    const value = physical(mapping, parts);
    const info = directories.get(value) ?? await io.lstat(value, { bigint: true });
    if (info.dev === undefined || String(info.dev) !== String(expectedDevice)) throw failure('Snapshot path crosses an unattested filesystem', 'SNAPSHOT_MOUNT_UNAVAILABLE');
    if (info.isDirectory()) {
      if (directories.size >= 512) directories.delete(directories.keys().next().value);
      directories.set(value, info);
    }
    return info;
  }
  async function resolve(value, signal, { followFinal = true } = {}) {
    signal?.throwIfAborted();
    let pending = locate(value); let expansions = 0; const visited = new Set();
    for (;;) {
      signal?.throwIfAborted();
      let mapping = pending.mapping; let parts = []; let logicalPath = mapping.root;
      guard(mapping, logicalPath);
      const rootInfo = await io.lstat(mapping.snapshotPath, { bigint: true });
      if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw failure('Snapshot mount root is not an ordinary directory');
      if (rootInfo.dev === undefined || (mapping.device !== undefined && String(rootInfo.dev) !== String(mapping.device))) throw failure('Snapshot mount identity changed', 'SNAPSHOT_MOUNT_UNAVAILABLE');
      let info = rootInfo; let restart = false;
      for (let index = 0; index < pending.tokens.length; index++) {
        signal?.throwIfAborted(); const token = pending.tokens[index];
        if (token === '.') continue;
        if (token === '..') {
          pending = locate(`${path.dirname(logicalPath)}/${pending.tokens.slice(index + 1).join('/')}`); restart = true; break;
        }
        logicalPath = path.join(logicalPath, token);
        const childMapping = selected(logicalPath);
        if (!childMapping) throw failure('Path targets a filesystem outside the snapshot lease');
        if (childMapping !== mapping) { pending = locate(`${logicalPath}/${pending.tokens.slice(index + 1).join('/')}`); restart = true; break; }
        guard(mapping, logicalPath); parts.push(token);
        info = await metadata(mapping, parts, rootInfo.dev, signal);
        if (info.isSymbolicLink()) {
          const result = { absolute: physical(mapping, parts), logicalPath, identity: identity(mapping, logicalPath, info), info };
          if (!followFinal && index === pending.tokens.length - 1) return result;
          const linkState = `${result.identity}\0${pending.tokens.slice(index + 1).join('/')}`;
          if (++expansions > 64 || visited.has(linkState)) throw failure('Symbolic link loop detected in snapshot', 'SNAPSHOT_LINK_LOOP');
          visited.add(linkState);
          const target = checked(await io.readlink(result.absolute));
          const next = path.isAbsolute(target) ? target : `${path.dirname(logicalPath)}/${target}`;
          pending = locate(`${next}/${pending.tokens.slice(index + 1).join('/')}`); restart = true; break;
        }
        if (index < pending.tokens.length - 1 && !info.isDirectory()) throw failure('A snapshot path parent is not a directory', 'ENOTDIR');
      }
      if (restart) continue;
      return { absolute: physical(mapping, parts), logicalPath, identity: identity(mapping, logicalPath, info), info };
    }
  }
  return {
    resolve,
    mappedPath(value) {
      const located = locate(value);
      if (located.tokens.some(token => token === '..' || token === '.')) throw failure('Unresolved component traversal in snapshot path');
      const normalized = path.join(located.mapping.root, ...located.tokens); guard(located.mapping, normalized);
      return physical(located.mapping, located.tokens);
    },
  };
}

export function createPosixSnapshotScanner(sources, mappings, io = { lstat, readlink, opendir, realpath }) {
  const resolver = createPosixSnapshotPathResolver(mappings, io);
  return async function* scan(task, destination, options = {}) {
    options.signal?.throwIfAborted();
    const ancestors = new Set();
    const destinationReal = normalized(await io.realpath(destination)); const destinationPath = normalized(destination);
    const excludedDirectories = new Set();
    for (const candidate of new Set([destinationPath, destinationReal])) {
      try { excludedDirectories.add((await resolver.resolve(candidate, options.signal)).identity); } catch (error) { if (options.signal?.aborted) throw error; }
    }
    async function* walk(source, logicalPath, name, filter) {
      await options.waitIfPaused?.();
      options.signal?.throwIfAborted();
      try {
        const resolved = await resolver.resolve(logicalPath, options.signal, { followFinal: task.symlinks === 'follow' }); const info = resolved.info;
        if (name && !(info.isDirectory() ? filter.traverse(name) : filter(name))) return;
        if (inside(destinationPath, resolved.logicalPath) || inside(destinationReal, resolved.logicalPath) || excludedDirectories.has(resolved.identity)) return;
        if (info.isSymbolicLink()) {
          if (task.symlinks === 'skip') return;
          const target = checked(await io.readlink(resolved.absolute));
          yield { sourceId: source.id, path: name, kind: 'symlink', absolute: resolved.absolute, target, ...fingerprint(info) };
        } else if (info.isDirectory()) {
          if (ancestors.has(resolved.identity)) throw failure('Symbolic link loop detected in snapshot', 'SNAPSHOT_LINK_LOOP');
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
        } else throw failure('Unsupported special file in snapshot', 'SNAPSHOT_SPECIAL_FILE');
      } catch (error) {
        if (options.signal?.aborted) throw error;
        if (error.code === 'SNAPSHOT_INTERNAL_PATH') return;
        yield { sourceId: source.id, path: name, kind: 'missing', error: String(error.message), code: error.code ?? 'SNAPSHOT_SCAN_ERROR' };
      }
    }
    for (const source of sources) {
      const filter = makeSourceFilter(source);
      // A missing/unleased source is an operation error, never a complete empty
      // backup. Descendant errors instead remain explicit incomplete entries.
      const root = await resolver.resolve(source.path, options.signal, { followFinal: task.symlinks === 'follow' });
      yield* walk(source, source.path, root.info.isDirectory() ? '' : path.basename(source.path), filter);
    }
  };
}
