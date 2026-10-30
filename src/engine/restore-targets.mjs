import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { safePath } from './storage.mjs';

export function normalizeRestoreTargetName(path, platform = process.platform) {
  if (platform === 'darwin') return path.normalize('NFC').toUpperCase().normalize('NFC');
  if (platform === 'win32') return path.toUpperCase();
  return path;
}

// Names and observed filesystem identities are both disk-backed. A target may
// replace a user's existing file, but must never replace another logical file
// already restored by this operation under an alias of its name.
export function createRestoreTargetMap(db, output, options = {}) {
  const platform = options.platform ?? process.platform;
  db.exec('CREATE TABLE restore_names (normalized TEXT PRIMARY KEY,logical TEXT NOT NULL,kind TEXT NOT NULL) WITHOUT ROWID; CREATE TABLE restore_nodes (device TEXT NOT NULL,inode TEXT NOT NULL,logical TEXT NOT NULL,PRIMARY KEY(device,inode)) WITHOUT ROWID;');
  const getName = db.prepare('SELECT logical,kind FROM restore_names WHERE normalized=?');
  const putName = db.prepare('INSERT INTO restore_names(normalized,logical,kind) VALUES (?,?,?)');
  const getNode = db.prepare('SELECT logical FROM restore_nodes WHERE device=? AND inode=?');
  const putNode = db.prepare('INSERT INTO restore_nodes(device,inode,logical) VALUES (?,?,?)');
  function ambiguous(path, other) { return new Error(`Ambiguous restore target: ${path} aliases a different manifest path (${other}); restore the names separately on a compatible filesystem`); }
  function prefixes(path, kind) { safePath(path); const parts = path.split('/'); return parts.map((_, index) => ({ logical: parts.slice(0, index + 1).join('/'), kind: index === parts.length - 1 ? kind : 'directory' })); }
  async function inspect(logical, kind, remember) {
    let info; try { info = await lstat(join(output, ...logical.split('/')), { bigint: true }); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
    if (kind === 'directory' && (info.isSymbolicLink() || !info.isDirectory())) throw new Error(`Unsafe restore directory: ${logical}`);
    // Filesystems that do not expose usable IDs still receive the conservative
    // OS name policy; zero IDs cannot identify distinct files safely.
    if (info.ino === 0n) return;
    const device = String(info.dev), inode = String(info.ino); const existing = getNode.get(device, inode);
    if (existing && existing.logical !== logical) throw ambiguous(logical, existing.logical);
    if (!existing && remember) putNode.run(device, inode, logical);
  }
  return {
    async prepare(path, kind) {
      for (const entry of prefixes(path, kind)) {
        const normalized = normalizeRestoreTargetName(entry.logical, platform); const existing = getName.get(normalized);
        if (existing && (existing.logical !== entry.logical || existing.kind !== entry.kind)) throw ambiguous(entry.logical, existing.logical);
        if (!existing) putName.run(normalized, entry.logical, entry.kind);
        await inspect(entry.logical, entry.kind, entry.kind === 'directory');
      }
    },
    async parentsCreated(path, kind) { for (const entry of prefixes(path, kind)) if (entry.kind === 'directory') await inspect(entry.logical, entry.kind, true); },
    async published(path, kind) { for (const entry of prefixes(path, kind)) await inspect(entry.logical, entry.kind, true); },
  };
}
