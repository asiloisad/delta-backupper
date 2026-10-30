import { open, readdir, lstat, mkdtemp, copyFile, link, rm, unlink } from 'node:fs/promises';
import { constants, createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { extractMetadataEntry, readSnapshotHeader } from '../archive/snapshot-metadata.mjs';
import { readSnapshotDocument } from '../archive/snapshot-document.mjs';
import { readTaskDocument, saveTaskDocument } from '../config/task-document.mjs';
import { json, jsonLines, atomicJson, safePath } from './storage.mjs';

export const ARCHIVE_PATTERN = /^([^/\\\0]+)\.zip$/i;
export function runId(value) { if (typeof value !== 'string' || !value || value.includes('/') || value.includes('\\') || value.includes('\0')) throw new Error('Invalid snapshot filename'); safePath(value); return value; }
export function archiveName(id, index = 1) { runId(id); if (index !== 1) throw new Error('A snapshot has exactly one ZIP archive'); return /\.zip$/i.test(id) ? id : `${id}.zip`; }
export function archiveIndex(name) { const match = ARCHIVE_PATTERN.exec(name); if (!match) throw new Error('Invalid snapshot archive filename'); runId(match[1]); return { id: match[1], index: 1 }; }
export const pendingPath = (directory, id) => join(directory, `.${runId(id)}.pending.json`);
export const progressPath = (directory, id) => join(directory, `.${runId(id)}.progress.jsonl`);
const timestamp = time => { const date = new Date(time); return `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}${String(date.getHours()).padStart(2, '0')}${String(date.getMinutes()).padStart(2, '0')}${String(date.getSeconds()).padStart(2, '0')}${String(date.getMilliseconds()).padStart(3, '0')}000`; };
export async function reserveRunId(directory, options = {}) {
  const names = new Set(await readdir(directory)); let time = options.now ?? Date.now();
  for (;;) { const id = timestamp(time); if (!names.has(`${id}.zip`) && !names.has(`.${id}.pending.json`) && ![...names].some(name => name.startsWith(`.${id}.`) || name.startsWith(`${id}.zip.`))) return id; time++; }
}
export async function pausePoint(options = {}) { options.signal?.throwIfAborted(); await options.waitIfPaused?.(); options.signal?.throwIfAborted(); }
export async function publishArchive(source, target) {
  try { await link(source, target); }
  catch (error) { if (!['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV'].includes(error.code)) throw error; await copyFile(source, target, constants.COPYFILE_EXCL); const handle = await open(target, 'r+'); try { await handle.sync(); } finally { await handle.close(); } }
  await unlink(source);
}
export async function hashPrefix(filename, bytes, options = {}) {
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('Invalid archive hash prefix'); const hash = createHash('sha256'); let seen = 0;
  if (bytes) for await (const chunk of createReadStream(filename, { start: 0, end: bytes - 1, highWaterMark: 64 * 1024, signal: options.signal })) { await pausePoint(options); seen += chunk.length; hash.update(chunk); }
  if (seen !== bytes) throw new Error('Archive prefix is truncated'); return hash.digest('hex');
}
export async function verifyPart(directory, part, options = {}) {
  archiveIndex(part.name); await pausePoint(options); const info = await lstat(join(directory, part.name));
  if (!info.isFile() || info.isSymbolicLink() || part.bytes !== undefined && info.size !== part.bytes) throw new Error(`Snapshot archive is unavailable or changed: ${part.name}`);
}
function checkedHeader(header) {
  if (!header || typeof header.time !== 'string' || !Number.isFinite(Date.parse(header.time)) || header.ends !== null && typeof header.ends !== 'string' || ![true, false, null].includes(header.full) || header.comp !== null && (!Number.isInteger(header.comp) || header.comp < 0 || header.comp > 9) || !Number.isSafeInteger(header.size) || header.size < 0 || !Number.isSafeInteger(header.sizx) || header.sizx < 0) throw new Error('Invalid .snapshot.json header.');
  return header;
}
function summary(header, id, bytes, counts = {}) {
  checkedHeader(header);
  return { id, type: header.full ? 'full' : 'incremental', status: header.ends && !counts.errors ? 'complete' : 'incomplete', startedAt: header.time, finishedAt: header.ends, files: counts.files ?? 0, bytes: header.size, errors: counts.errors ?? 0, parts: bytes === undefined ? [] : [{ name: archiveName(id), bytes }], pinned: false, committed: bytes !== undefined, compression: header.comp, storedSize: header.sizx, cycleId: id, baseRunId: null, consistentSnapshot: false, sourceConsistency: 'live', atomicSet: false, resumedFrom: null };
}
const headerCache = new Map();
async function readHeader(directory, id, options = {}) {
  const filename = join(directory, archiveName(id)), info = await lstat(filename);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Snapshot archive is not an ordinary file.');
  const key = `${filename}:${info.size}:${info.mtimeMs}`, cached = headerCache.get(key); if (cached) return { ...cached, filename };
  let files = 0, errors = 0;
  const snapshot = await readSnapshotHeader(filename, { ...options, onData: (name, value) => { safePath(name); if (value !== null) files++; }, onError: () => { errors++; } });
  const result = { name: archiveName(id), filename, snapshot, run: summary(snapshot, id, info.size, { files, errors }) };
  if (headerCache.size >= 256) headerCache.delete(headerCache.keys().next().value); headerCache.set(key, result); return result;
}
async function taskDocument(directory, options = {}) { return readTaskDocument(join(directory, '.delta.json'), { signal: options.signal }); }
export async function listFlatRuns(directory, options = {}) {
  directory = resolve(directory); let document;
  try { document = await taskDocument(directory, options); } catch (error) { if (error.code !== 'ENOENT') throw error; return []; }
  const runs = new Map();
  for (const name of document.hist) {
    await pausePoint(options); const id = archiveIndex(name).id;
    try { const part = await readHeader(directory, id, options); runs.set(id, { ...part.run, pinned: document.pinned?.includes(name) ?? false }); }
    catch (error) { if (!options.ignoreInvalid && !(options.ignoreMissing && error.code === 'ENOENT')) throw error; }
  }
  if (options.includeUncommitted) for (const item of await readdir(directory, { withFileTypes: true })) if (item.isFile() && /^\..+\.pending\.json$/.test(item.name)) {
    const id = item.name.slice(1, -'.pending.json'.length); if (runs.has(id)) continue; const pending = await json(join(directory, item.name), { maximum: 64 * 1024 ** 2 }), header = pending.snapshot ?? pending.run ?? pending;
    runs.set(id, { ...summary(header, id), ...header, id, parts: [], committed: false });
  }
  const result = [...runs.values()]; let cycleId;
  const sequence = document.value.sequence?.types ?? ['full'];
  for (const [index, run] of result.entries()) {
    if (run.type === 'full' || !cycleId) cycleId = run.id;
    if (run.type !== 'full' && sequence[index % sequence.length] === 'differential') run.type = 'differential';
    run.cycleId = cycleId;
  }
  return result;
}
export async function readFlatRun(directory, id, options = {}) {
  runId(id);
  try { const part = await readHeader(directory, id, options), document = await taskDocument(directory, options), listed = (await listFlatRuns(directory, { ...options, ignoreMissing: true })).find(run => run.id === id); return { run: listed ?? { ...part.run, pinned: document.pinned?.includes(archiveName(id)) ?? false }, snapshot: part.snapshot, part, taskConfig: document.value }; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (options.allowUncommitted) {
    const pending = await json(pendingPath(directory, id), { maximum: 64 * 1024 ** 2 }), snapshot = pending.snapshot ?? pending.run ?? pending, document = await taskDocument(directory, options);
    return { run: { ...summary(snapshot, id), ...snapshot, id, parts: [], committed: false }, snapshot, taskConfig: document.value, pending: true };
  }
  throw new Error(`Snapshot is unavailable: ${id}`);
}
export async function openRunMetadata(directory, id, options = {}) {
  directory = resolve(directory); const read = await readFlatRun(directory, id, options), scratch = await mkdtemp(join(options.cacheDirectory ?? tmpdir(), 'delta-snapshot-meta-'));
  const cleanup = () => rm(scratch, { recursive: true, force: true });
  try {
    const mapPaths = Object.fromEntries(['data', 'stored', 'errors', 'links'].map(name => [name, join(scratch, `${name}.jsonl`)])), outputs = {};
    let snapshot = read.snapshot;
    try {
      for (const [name, filename] of Object.entries(mapPaths)) {
        const handle = await open(filename, 'wx', 0o600); let chunks = [], size = 0;
        const flush = async () => { if (size) { await handle.writeFile(chunks.join('')); chunks = []; size = 0; } };
        outputs[name] = { async record(filename, value) { const row = `${JSON.stringify([filename, value])}\n`; chunks.push(row); size += Buffer.byteLength(row); if (size >= 64 * 1024) await flush(); }, async close() { try { await flush(); } finally { await handle.close(); } } };
      }
      if (read.run.committed) {
        const snapshotFile = join(scratch, '.snapshot.json'); await extractMetadataEntry(read.part.filename, snapshotFile, options);
        const record = name => async (filename, value) => { await pausePoint(options); safePath(filename); await outputs[name].record(filename, value); };
        snapshot = await readSnapshotDocument(snapshotFile, { signal: options.signal, onData: record('data'), onLocked: record('stored'), onError: record('errors') });
      }
    } finally { for (const output of Object.values(outputs)) await output.close(); }
    await atomicJson(join(scratch, '.delta.json'), read.taskConfig); await atomicJson(join(scratch, 'run.json'), read.run);
    return { ...read, snapshot, path: scratch, dataPath: mapPaths.data, storedPath: mapPaths.stored, errorsPath: mapPaths.errors, linksPath: mapPaths.links, manifestPaths: [mapPaths.data], cleanup };
  } catch (error) { await cleanup(); throw error; }
}
export async function* iterateRunEntries(directory, id, options = {}) {
  const metadata = await openRunMetadata(directory, id, options), db = new DatabaseSync(join(metadata.path, 'listing.sqlite'));
  try {
    db.exec('PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA cache_size=-1024; CREATE TABLE links(path TEXT PRIMARY KEY,target TEXT) WITHOUT ROWID; CREATE TABLE errors(path TEXT PRIMARY KEY,error TEXT) WITHOUT ROWID;');
    const link = db.prepare('INSERT INTO links(path,target) VALUES (?,?)'), error = db.prepare('INSERT INTO errors(path,error) VALUES (?,?)');
    for await (const row of jsonLines(metadata.linksPath, options)) link.run(...row);
    for await (const row of jsonLines(metadata.errorsPath, options)) error.run(...row);
    const findLink = db.prepare('SELECT target FROM links WHERE path=?'), findError = db.prepare('SELECT error FROM errors WHERE path=?');
    for await (const [name, value] of jsonLines(metadata.dataPath, options)) {
      await pausePoint(options); const match = typeof value === 'string' ? /^(-?\d+):(\d+)$/.exec(value) : null, target = findLink.get(name)?.target, failure = findError.get(name)?.error;
      yield { path: name, kind: failure ? 'missing' : value === null ? 'directory' : target !== undefined ? 'symlink' : 'file', size: match ? Number(match[2]) : target !== undefined ? Buffer.byteLength(target) : 0, mtimeNs: match?.[1] ?? '0', mode: value === null ? 0o755 : 0o644, fingerprint: value, ...(typeof value === 'string' && /^(?:sha256:)?[a-f0-9]{64}$/.test(value) ? { sha256: value.replace(/^sha256:/, '') } : {}), ...(target !== undefined ? { target } : {}), ...(failure ? { error: `File was not backed up: ${failure}` } : {}) };
    }
  } finally { db.close(); await metadata.cleanup(); }
}
export async function readLatestRunSummary(directory, options = {}) { return (await listFlatRuns(directory, { ...options, ignoreMissing: true })).findLast(run => options.completeOnly === false || run.status === 'complete') ?? null; }
export async function recoverTaskConfiguration(directory, _id, options = {}) { return (await taskDocument(resolve(directory), options)).value; }
export async function writePin(directory, id, pinned) {
  const filename = join(resolve(directory), '.delta.json'), current = await taskDocument(directory); if (!current.hist.includes(archiveName(id))) throw new Error('Snapshot is not in task history.');
  const values = new Set(current.pinned ?? []); if (pinned) values.add(archiveName(id)); else values.delete(archiveName(id));
  await saveTaskDocument(filename, current.value, current.revision, { pinned: [...values] }); return (await readFlatRun(directory, id)).run;
}
