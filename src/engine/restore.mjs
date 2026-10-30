import { open, mkdir, mkdtemp, rename, link, copyFile, unlink, lstat, stat, chmod, utimes, rm, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createBoundedReader } from '../archive/bounded-reader.mjs';
import { jsonLines, safePath, assertNoLinkParents, within, acquireTaskLock } from './storage.mjs';
import { createRestoreTargetMap } from './restore-targets.mjs';
import { assertPlainZipOptions } from '../archive/plain-options.mjs';
import { openRunMetadata, archiveIndex, pausePoint } from './repository.mjs';
import { readTaskDocument } from '../config/task-document.mjs';

export async function runMetadata(destination, runId, options = {}) { assertPlainZipOptions(options); return openRunMetadata(destination, runId, options); }
export async function verifyRun(destination, runId, options = {}) { return processRun(destination, runId, null, options); }
export async function restoreRun(destination, runId, outputDirectory, options = {}) { return processRun(destination, runId, resolve(outputDirectory), options); }

function fingerprint(value) {
  if (value === null) return { kind: 'directory', size: 0, mtimeNs: null };
  if (typeof value !== 'string') throw new Error('Invalid snapshot fingerprint');
  const fast = /^(-?\d{1,30}):(\d+)$/.exec(value);
  if (fast) { const size = Number(fast[2]); if (!Number.isSafeInteger(size) || size < 0) throw new Error('Invalid snapshot file size'); return { kind: 'file', size, mtimeNs: fast[1] }; }
  if (/^(?:sha256:)?[a-f0-9]{64}$/.test(value)) return { kind: 'file', size: null, mtimeNs: null };
  throw new Error('Invalid snapshot fingerprint');
}
function pair(row) { if (!Array.isArray(row) || row.length !== 2) throw new Error('Invalid snapshot file map'); safePath(row[0]); return row; }

export function prepareRestoreSelection(db, options = {}) {
  if (options.paths !== undefined && (!Array.isArray(options.paths) || options.paths.length > 10000)) throw new Error('Restore selection must contain at most 10000 paths');
  if (options.overwrite !== undefined && !['error', 'skip', 'replace'].includes(options.overwrite)) throw new Error('Invalid restore collision policy');
  if (options.restoreLinks !== undefined && typeof options.restoreLinks !== 'boolean') throw new Error('Invalid restore links setting');
  const paths = [...new Set((options.paths ?? []).map(safePath))], unmatched = [];
  if (!paths.length) db.exec('UPDATE restore_entries SET selected=1');
  else {
    const exists = db.prepare('SELECT 1 FROM restore_entries WHERE path=? OR (path>=? AND path<?) LIMIT 1');
    const select = db.prepare('UPDATE restore_entries SET selected=1 WHERE path=? OR (path>=? AND path<?)');
    const parent = db.prepare("UPDATE restore_entries SET selected=2 WHERE path=? AND selected=0 AND kind='directory'");
    for (const path of paths) { options.signal?.throwIfAborted(); if (!exists.get(path, `${path}/`, `${path}0`)) unmatched.push(path); select.run(path, `${path}/`, `${path}0`); const parts = path.split('/'); for (let end = 1; end < parts.length; end++) parent.run(parts.slice(0, end).join('/')); }
  }
  return { paths, unmatched };
}

/** Resolve desired fingerprints against stored maps, newest first through the selected snapshot. */
export async function prepareRestoreIndex(destination, runId, options = {}) {
  let scratch, db, metadata;
  const cleanup = async () => { db?.close(); db = undefined; if (scratch) await rm(scratch, { recursive: true, force: true }); await metadata?.cleanup(); };
  try {
    metadata = await runMetadata(destination, runId, options); scratch = await mkdtemp(join(tmpdir(), 'delta-restore-'));
    db = new DatabaseSync(join(scratch, 'restore.sqlite'));
    db.exec("PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA cache_size=-8192; PRAGMA mmap_size=0; PRAGMA temp_store=FILE; CREATE TABLE restore_entries(path TEXT PRIMARY KEY,fingerprint TEXT,kind TEXT NOT NULL,size INTEGER,mtimeNs TEXT,archive TEXT,error TEXT,selected INTEGER NOT NULL DEFAULT 0,done INTEGER NOT NULL DEFAULT 0,mode INTEGER) WITHOUT ROWID");
    const insert = db.prepare('INSERT INTO restore_entries(path,fingerprint,kind,size,mtimeNs) VALUES (?,?,?,?,?)');
    for await (const row of jsonLines(metadata.dataPath, options)) { await pausePoint(options); const [path, value] = pair(row), entry = fingerprint(value); insert.run(path, value, entry.kind, entry.size, entry.mtimeNs); }
    const setError = db.prepare("INSERT INTO restore_entries(path,kind,size,error) VALUES (?,'missing',0,?) ON CONFLICT(path) DO NOTHING");
    for await (const row of jsonLines(metadata.errorsPath, options)) { await pausePoint(options); const [path, source] = pair(row); setError.run(path, `Source was unavailable during backup: ${source}`); }
    const selection = prepareRestoreSelection(db, options), assign = db.prepare("UPDATE restore_entries SET archive=? WHERE path=? AND fingerprint IS ? AND kind='file' AND selected=1 AND archive IS NULL");
    const history = (await readTaskDocument(join(destination, '.delta.json'), options)).hist, selectedIndex = history.findIndex(name => archiveIndex(name).id === metadata.run.id);
    if (selectedIndex < 0) throw new Error('Snapshot is absent from task history');
    const runs = history.slice(0, selectedIndex + 1).reverse();
    for (const name of runs) {
      await pausePoint(options); if (!db.prepare("SELECT 1 FROM restore_entries WHERE selected=1 AND kind='file' AND archive IS NULL LIMIT 1").get()) break;
      const id = archiveIndex(name).id, point = id === metadata.run.id ? metadata : await openRunMetadata(destination, id, options);
      try { for await (const row of jsonLines(point.storedPath, options)) { await pausePoint(options); const [path, value] = pair(row); assign.run(name, path, value); } } finally { if (point !== metadata) await point.cleanup(); }
    }
    db.exec("UPDATE restore_entries SET error='Required file version is unavailable' WHERE selected=1 AND kind='file' AND archive IS NULL");
    const archives = db.prepare('SELECT DISTINCT archive FROM restore_entries WHERE selected=1 AND archive IS NOT NULL ORDER BY archive');
    const get = db.prepare('SELECT * FROM restore_entries WHERE selected=1 AND archive=? AND path=?'), size = db.prepare('UPDATE restore_entries SET size=?,mode=? WHERE path=?');
    db.exec('CREATE TEMP TABLE zip_names(path TEXT PRIMARY KEY) WITHOUT ROWID');
    for (const group of archives.iterate()) {
      await pausePoint(options); const filename = join(destination, group.archive), info = await lstat(filename);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('Required archive is not an ordinary file');
      const reader = await createBoundedReader(filename, { signal: options.signal });
      try {
        db.exec('DELETE FROM zip_names');
        for await (const entry of reader.getEntriesGenerator()) {
          await pausePoint(options); const row = get.get(group.archive, entry.filename.replace(/\/$/, '')); if (!row) continue;
          if ((row.kind === 'directory') !== entry.directory || !Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0 || row.size !== null && row.size !== entry.uncompressedSize) throw new Error(`Archive entry size does not match snapshot: ${row.path}`);
          try { db.prepare('INSERT INTO zip_names(path) VALUES (?)').run(row.path); } catch { throw new Error(`Repeated archive entry: ${row.path}`); }
          size.run(entry.uncompressedSize, (entry.externalFileAttributes >>> 16) & 0o777, row.path);
        }
        db.prepare("UPDATE restore_entries SET error='Required archive entry is unavailable' WHERE archive=? AND selected=1 AND path NOT IN (SELECT path FROM zip_names)").run(group.archive);
      } finally { await reader.close(); }
    }
    return { db, metadata, selection, cleanup };
  } catch (error) { await cleanup(); throw error; }
}

async function processRun(destination, runId, output, options) {
  assertPlainZipOptions(options);
  const selectedDestination = resolve(destination); destination = await realpath(selectedDestination); const repositoryIdentity = await stat(destination, { bigint: true });
  const assertRepository = async () => { const current = await stat(selectedDestination, { bigint: true }); if (current.ino !== repositoryIdentity.ino || current.dev !== repositoryIdentity.dev || await realpath(selectedDestination) !== destination) throw new Error('Backup repository changed during restore'); };
  const lock = await acquireTaskLock(destination); let index;
  try {
    index = await prepareRestoreIndex(destination, runId, options); const { db, selection } = index;
    let assertOutput = async () => {};
    if (output) {
      const chosen = await resolveOutputSelection(output); output = chosen.path;
      if (within(destination, output) || within(output, destination)) throw new Error('Restore destination must not overlap the backup repository');
      await chosen.assert(); await mkdir(output, { recursive: true }); const root = await lstat(output, { bigint: true }); if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('Restore destination is not an ordinary directory');
      assertOutput = async () => { await chosen.assert(); const now = await lstat(output, { bigint: true }); if (!now.isDirectory() || now.isSymbolicLink() || now.ino !== root.ino || now.dev !== root.dev || await realpath(chosen.selected) !== output) throw new Error('Restore destination changed during operation'); };
    }
    const result = { runId, status: 'complete', files: 0, bytes: 0, skipped: 0, errors: [] }, targets = output ? createRestoreTargetMap(db, output) : null;
    const totals = db.prepare("SELECT COUNT(*) AS files,COALESCE(SUM(size),0) AS bytes FROM restore_entries WHERE selected=1 AND kind='file'").get();
    let totalsKnown = Number.isSafeInteger(totals.bytes) && !selection.unmatched.length && !db.prepare('SELECT 1 FROM restore_entries WHERE selected=1 AND error IS NOT NULL LIMIT 1').get();
    let completedFiles = 0, completedBytes = 0, inFlightBytes = 0, lastProgress = 0;
    const emit = entry => options.onProgress?.({ phase: output ? 'restore' : 'verify', files: result.files, bytes: result.bytes, completedFiles, completedBytes: completedBytes + inFlightBytes, ...(totalsKnown ? { totalFiles: totals.files, totalBytes: totals.bytes } : {}), ...(entry ? { path: entry.path } : {}) });
    const errorFor = (path, error) => { totalsKnown = false; result.status = 'incomplete'; if (result.errors.length < (options.maxErrors ?? 1000)) result.errors.push({ path, error: String(error?.message ?? error) }); };
    for (const path of selection.unmatched) errorFor(path, 'Selected path is absent from this restore point');
    for (const entry of db.prepare('SELECT path,error FROM restore_entries WHERE selected=1 AND error IS NOT NULL').iterate()) errorFor(entry.path, entry.error);
    emit();
    if (output) for (const entry of db.prepare("SELECT * FROM restore_entries WHERE selected>0 AND kind='directory' AND error IS NULL ORDER BY path").iterate()) {
      await pausePoint(options); await assertOutput();
      try { const target = targetFor(output, entry); await targets.prepare(entry.path, 'directory'); await assertNoLinkParents(output, target); const existing = await lstat(target).catch(e => { if (e.code !== 'ENOENT') throw e; return null; }); if (existing && (!existing.isDirectory() || existing.isSymbolicLink())) throw new Error('Directory restore path is occupied'); if (!existing) await mkdir(target); await targets.published(entry.path, 'directory'); } catch (error) { errorFor(entry.path, error); }
    }
    for (const group of db.prepare('SELECT DISTINCT archive FROM restore_entries WHERE selected=1 AND error IS NULL AND archive IS NOT NULL ORDER BY archive').iterate()) {
      await pausePoint(options); await assertRepository(); await assertOutput();
      const reader = await createBoundedReader(join(destination, group.archive), { signal: options.signal });
      try {
        const get = db.prepare("SELECT * FROM restore_entries WHERE selected=1 AND kind='file' AND error IS NULL AND archive=? AND path=? AND done=0");
        for await (const entry of reader.getEntriesGenerator()) {
          await pausePoint(options); await assertOutput(); const row = get.get(group.archive, entry.filename); if (!row) continue;
          let temporary, file, bytes = 0; inFlightBytes = 0;
          try {
            if (entry.directory || entry.uncompressedSize !== row.size) throw new Error('Archive entry size changed before restore');
            let target;
            if (output) {
              target = targetFor(output, row); await targets.prepare(row.path, 'file'); await assertNoLinkParents(output, target); await targets.parentsCreated(row.path, 'file');
              const existing = await lstat(target).catch(e => { if (e.code !== 'ENOENT') throw e; return null; });
              if (existing) { if (existing.isSymbolicLink() || !existing.isFile()) throw new Error('Restore collision with symlink or non-file'); if (options.overwrite === 'skip') { result.skipped++; completedFiles++; completedBytes += row.size; db.prepare('UPDATE restore_entries SET done=1 WHERE path=?').run(row.path); emit(row); continue; } if (options.overwrite !== 'replace') throw new Error('Restore collision'); }
              temporary = join(dirname(target), `.delta-restore-${randomUUID()}.tmp`); file = await open(temporary, 'wx', 0o600);
            }
            const hash = /^(?:sha256:)?[a-f0-9]{64}$/.test(row.fingerprint) ? createHash('sha256') : null;
            await entry.getData(new WritableStream({ async write(chunk) {
              await pausePoint(options); if (bytes + chunk.length > row.size) throw new Error('Restored content exceeds the snapshot size'); hash?.update(chunk); bytes += chunk.length;
              if (file) for (let offset = 0; offset < chunk.length;) { const { bytesWritten } = await file.write(chunk, offset, chunk.length - offset); if (!bytesWritten) throw new Error('Restore output stopped accepting bytes'); offset += bytesWritten; }
              inFlightBytes = bytes; const now = Date.now(); if (now - lastProgress >= 150) { lastProgress = now; emit(row); }
            } }), { checkSignature: true, signal: options.signal });
            if (bytes !== row.size || hash && hash.digest('hex') !== row.fingerprint.replace(/^sha256:/, '')) throw new Error('Restored content fingerprint or size mismatch');
            if (file) {
              await file.sync(); await file.close(); file = undefined; await assertOutput(); await assertNoLinkParents(output, target); await targets.prepare(row.path, 'file');
              if (options.overwrite === 'replace') { const now = await lstat(target).catch(e => { if (e.code !== 'ENOENT') throw e; return null; }); if (now && (!now.isFile() || now.isSymbolicLink())) throw new Error('Restore collision changed type'); await rename(temporary, target); }
              else { await publishVerifiedFile(temporary, target); await unlink(temporary); }
              temporary = undefined; await targets.published(row.path, 'file'); if (row.mode) await chmod(target, row.mode).catch(() => {}); if (row.mtimeNs) { const seconds = Number(BigInt(row.mtimeNs) / 1000000n) / 1000; await utimes(target, seconds, seconds).catch(() => {}); }
            }
            db.prepare('UPDATE restore_entries SET done=1 WHERE path=?').run(row.path); result.files++; result.bytes += bytes; completedFiles++; completedBytes += bytes; inFlightBytes = 0; emit(row);
          } catch (error) { if (options.signal?.aborted) throw error; errorFor(row.path, error); } finally { inFlightBytes = 0; await file?.close().catch(() => {}); if (temporary) await unlink(temporary).catch(() => {}); }
        }
      } finally { await reader.close(); }
    }
    for (const row of db.prepare("SELECT path FROM restore_entries WHERE selected=1 AND kind='file' AND error IS NULL AND done=0").iterate()) errorFor(row.path, 'Required archive entry was not verified');
    options.onProgress?.({ phase: 'finalizing', files: result.files, bytes: result.bytes });
    await assertOutput(); await assertRepository(); return result;
  } finally { await index?.cleanup(); await lock.release(); }
}

export async function resolveOutputSelection(selected) {
  selected = resolve(selected); let ancestor = selected; const suffix = []; let identity;
  for (;;) { try { const info = await lstat(ancestor, { bigint: true }); if (ancestor === selected && info.isSymbolicLink()) throw new Error('Restore destination is not an ordinary directory'); identity = await stat(ancestor, { bigint: true }); if (!identity.isDirectory()) throw new Error('Restore destination parent is not a directory'); break; } catch (e) { if (e.code !== 'ENOENT' || dirname(ancestor) === ancestor) throw e; suffix.unshift(basename(ancestor)); ancestor = dirname(ancestor); } }
  const canonicalAncestor = await realpath(ancestor), path = join(canonicalAncestor, ...suffix);
  return { selected, path, async assert() { const now = await stat(ancestor, { bigint: true }); if (!now.isDirectory() || now.ino !== identity.ino || now.dev !== identity.dev || await realpath(ancestor) !== canonicalAncestor) throw new Error('Restore destination parent or selected alias changed during operation'); } };
}
export function targetFor(output, entry) { safePath(entry.path); return join(output, ...entry.path.split('/')); }
export async function publishVerifiedFile(temporaryPath, target, io = {}) {
  try { await (io.link ?? link)(temporaryPath, target); } catch (e) { if (!['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV'].includes(e.code)) throw e; await (io.copyFile ?? copyFile)(temporaryPath, target, constants.COPYFILE_EXCL); const output = await open(target, 'r+'); try { await output.sync(); } finally { await output.close(); } }
}
