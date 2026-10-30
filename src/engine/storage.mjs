import { createReadStream } from 'node:fs';
import { open, mkdir, readFile, rename, unlink, lstat, rm, rmdir, realpath } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { join, resolve, relative, isAbsolute, dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const FORMAT = 1;
export function safeId(value) { if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(value)) throw new Error('Invalid Delta identifier'); return value; }
export function safePath(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes('\0') || value.startsWith('/') || /^[a-z]:/i.test(value) || value.split('/').some(p => !p || p === '.' || p === '..' || p.includes(':'))) throw new Error(`Unsafe manifest path: ${value}`);
  if (process.platform === 'win32' && value.split('/').some(p => /[. ]$/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) throw new Error('Unsafe Windows path');
  return value;
}
export function within(parent, child) { const rel = relative(resolve(parent), resolve(child)); return rel === '' || (!rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && rel !== '..' && !isAbsolute(rel)); }
export async function atomicJson(path, value, options = {}) { const text = `${JSON.stringify(value, null, 2)}\n`; if (Buffer.byteLength(text) > (options.maximum ?? 16 * 1024 ** 2)) throw new Error('JSON metadata exceeds its size limit'); await atomicText(path, text); }
export async function atomicText(path, value) {
  const temp = `${path}.${randomUUID()}.tmp`;
  const h = await open(temp, 'wx');
  try { await h.writeFile(value); await h.sync(); } finally { await h.close(); }
  try { await rename(temp, path); } catch (e) { await unlink(temp).catch(() => {}); throw e; }
}
export async function json(path, options = {}) {
  const maximum = options.maximum ?? 16 * 1024 ** 2; if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 64 * 1024 ** 2) throw new Error('Invalid JSON metadata size limit');
  const before = await lstat(path, { bigint: true }); if (!before.isFile() || before.isSymbolicLink() || before.size > BigInt(maximum)) throw new Error('JSON metadata must be an ordinary file within its bounded size limit');
  const handle = await open(path, 'r'); try { const opened = await handle.stat({ bigint: true }); if (!opened.isFile() || opened.ino !== before.ino || opened.dev !== before.dev || opened.size > BigInt(maximum)) throw new Error('JSON metadata changed while opening'); const bytes = Buffer.allocUnsafe(Number(opened.size) + 1); let used = 0; while (used < bytes.length) { const result = await handle.read(bytes, used, bytes.length - used, null); if (!result.bytesRead) break; used += result.bytesRead; } const after = await handle.stat({ bigint: true }); if (BigInt(used) !== opened.size || after.size !== opened.size || after.mtimeNs !== opened.mtimeNs) throw new Error('JSON metadata changed while reading'); return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, used))); } finally { await handle.close(); }
}
export async function readRunTaskConfiguration(runDirectory, _run) { return json(join(runDirectory, '.delta.json')); }
export async function* jsonLines(path, options = {}) {
  const input = createReadStream(path, { highWaterMark: 64 * 1024, signal: options.signal }); const decoder = new TextDecoder('utf-8', { fatal: true }); let pending = Buffer.alloc(0);
  try { for await (const chunk of input) { let start = 0; for (let index = 0; index < chunk.length; index++) if (chunk[index] === 10) { const line = Buffer.concat([pending, chunk.subarray(start, index)]); if (line.length > 1024 * 1024) throw new Error('Manifest row exceeds limit'); if (line.length) yield JSON.parse(decoder.decode(line)); pending = Buffer.alloc(0); start = index + 1; } const rest = chunk.subarray(start); if (pending.length + rest.length > 1024 * 1024) throw new Error('Manifest row exceeds limit'); pending = Buffer.concat([pending, rest]); } if (pending.length && !options.allowIncompleteLastRow) throw new Error('Manifest has an incomplete final row'); } finally { input.destroy(); }
}
export async function hashFile(path, signal) {
  const hash = createHash('sha256'); const input = createReadStream(path, { highWaterMark: 64 * 1024, signal });
  for await (const chunk of input) hash.update(chunk);
  return hash.digest('hex');
}
export async function taskDirectoryGuard(destination, _task) {
  const identity = await lstat(destination, { bigint: true });
  if (!identity.isDirectory() || identity.isSymbolicLink()) throw new Error('Destination must be an existing ordinary task directory');
  const check = async () => { const now = await lstat(destination, { bigint: true }); if (!now.isDirectory() || now.isSymbolicLink() || now.ino !== identity.ino || now.dev !== identity.dev) throw new Error('Destination directory changed during operation'); };
  await check(); return check;
}

export async function acquireTaskLock(destination) {
  const path = join(destination, '.delta-lock'); const token = randomUUID();
  try { await mkdir(path); } catch (e) { if (e.code === 'EEXIST') { const owner = await json(join(path, 'owner.json')).catch(() => null); const error = new Error(`Task is locked${owner ? ` by ${owner.host}:${owner.pid}` : ''}; inspect and explicitly recover the lock`); error.code = 'DELTA_LOCKED'; error.owner = owner; throw error; } throw e; }
  const identity = await lstat(path, { bigint: true });
  const owner = { schemaVersion: 1, token, host: hostname(), pid: process.pid, createdAt: new Date().toISOString() };
  try { await atomicJson(join(path, 'owner.json'), owner); } catch (e) { const now = await lstat(path, { bigint: true }).catch(() => null); if (now && now.ino === identity.ino && now.dev === identity.dev && !now.isSymbolicLink()) await rmdir(path).catch(() => {}); throw e; }
  return { owner, async release() { if ((await json(join(path, 'owner.json'))).token !== token) throw new Error('Task lock ownership changed'); await unlink(join(path, 'owner.json')); await rmdir(path); } };
}
export async function unlockTask(destination, { token }) {
  const path = join(resolve(destination), '.delta-lock'); const owner = await json(join(path, 'owner.json'));
  if (owner.token !== token) throw new Error('Lock recovery token does not match');
  if (owner.host === hostname()) { try { process.kill(owner.pid, 0); throw new Error('Lock owner is still running'); } catch (e) { if (e.code !== 'ESRCH') throw e; } }
  else throw new Error('A lock created on another host must be released on that host');
  await unlink(join(path, 'owner.json')); await rmdir(path); return owner;
}
export function openIndex(path) {
  const db = new DatabaseSync(path);
  // This index is disposable local scratch. Durable archive parts plus the
  // synced portable progress journal, never SQLite, are the recovery authority.
  db.exec(`PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA cache_size=-8192; PRAGMA mmap_size=0; PRAGMA temp_store=FILE;
    CREATE TABLE IF NOT EXISTS entries (key TEXT PRIMARY KEY, data TEXT NOT NULL, part TEXT, needsArchive INTEGER NOT NULL DEFAULT 0) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS previous (key TEXT PRIMARY KEY, data TEXT NOT NULL) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS reusable (key TEXT PRIMARY KEY, data TEXT NOT NULL) WITHOUT ROWID;`);
  db.exec('CREATE TABLE IF NOT EXISTS sourcePaths (key TEXT PRIMARY KEY,path TEXT NOT NULL) WITHOUT ROWID');
  return db;
}
export function keyOf(entry) { safePath(entry.path); return entry.path; }
export function validateEntry(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row) || typeof row.path !== 'string' || !['file', 'directory', 'symlink', 'missing'].includes(row.kind)) throw new Error('Invalid file entry'); keyOf(row);
  if (row.kind !== 'missing' && (!Number.isSafeInteger(row.size) || row.size < 0 || typeof row.mtimeNs !== 'string' || !/^-?\d{1,30}$/.test(row.mtimeNs))) throw new Error('Invalid file metadata');
  if (row.sha256 !== undefined && row.sha256 !== null && !/^[a-f0-9]{64}$/.test(row.sha256)) throw new Error('Invalid file hash');
  if (row.kind === 'symlink' && (typeof row.target !== 'string' || row.target.includes('\0') || !row.target.isWellFormed())) throw new Error('Invalid link target');
  return row;
}
export async function loadManifest(db, table, path, options = {}) { if (!['previous', 'reusable', 'entries'].includes(table)) throw new Error('Invalid index table'); const insert = db.prepare(`INSERT ${table === 'reusable' ? 'OR REPLACE' : ''} INTO ${table}(key,data) VALUES (?,?)`); db.exec('BEGIN'); try { for await (const row of jsonLines(path, { allowIncompleteLastRow: table === 'reusable', signal: options.signal })) { options.signal?.throwIfAborted(); validateEntry(row); insert.run(keyOf(row), JSON.stringify(row)); } db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; } }
export async function assertNoLinkParents(root, target) {
  if (!within(root, target)) throw new Error('Restore path escapes destination');
  let current = resolve(root); const suffix = relative(current, dirname(target));
  for (const segment of suffix ? suffix.split(/[\\/]/) : []) { current = join(current, segment); try { const st = await lstat(current); if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`Unsafe restore parent: ${current}`); } catch (e) { if (e.code !== 'ENOENT') throw e; await mkdir(current); } }
  const canonicalRoot = await realpath(root); const canonicalParent = await realpath(dirname(target));
  if (!within(canonicalRoot, canonicalParent)) throw new Error('Restore parent resolves outside destination');
}
