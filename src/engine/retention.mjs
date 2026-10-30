import { lstat, mkdtemp, rm, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { acquireTaskLock, taskDirectoryGuard, safePath, jsonLines } from './storage.mjs';
import { listFlatRuns, openRunMetadata, writePin, runId, pausePoint } from './repository.mjs';
import { syncTaskCatalog } from './catalog.mjs';
import { readTaskDocument } from '../config/task-document.mjs';

async function withLock(task, destination, work) {
  const guard = await taskDirectoryGuard(destination, task), lock = await acquireTaskLock(destination);
  try { await guard(); return await work(guard); } finally { await lock.release(); }
}
const content = value => typeof value === 'string';
function pair(row) { if (!Array.isArray(row) || row.length !== 2) throw new Error('Invalid snapshot file map'); safePath(row[0]); return row; }

/** The dependency check asks whether a retained point can still find each desired version. */
async function inventory(destination, options = {}) {
  const runs = await listFlatRuns(destination, options), scratch = await mkdtemp(join(tmpdir(), 'delta-retention-'));
  const db = new DatabaseSync(join(scratch, 'versions.sqlite'));
  db.exec('PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA cache_size=-8192; PRAGMA mmap_size=0; PRAGMA temp_store=FILE; CREATE TABLE wanted(snapshot TEXT,position INTEGER,path TEXT,fingerprint TEXT,PRIMARY KEY(snapshot,path)) WITHOUT ROWID; CREATE TABLE stored(snapshot TEXT,position INTEGER,path TEXT,fingerprint TEXT,PRIMARY KEY(snapshot,path)) WITHOUT ROWID; CREATE INDEX stored_version ON stored(path,fingerprint,position); CREATE TABLE deleting(snapshot TEXT PRIMARY KEY) WITHOUT ROWID');
  const cleanup = async () => { db.close(); await rm(scratch, { recursive: true, force: true }); };
  try {
    const putWanted = db.prepare('INSERT INTO wanted(snapshot,position,path,fingerprint) VALUES (?,?,?,?)'), putStored = db.prepare('INSERT INTO stored(snapshot,position,path,fingerprint) VALUES (?,?,?,?)');
    for (const [position, run] of runs.entries()) {
      await pausePoint(options); const metadata = await openRunMetadata(destination, run.id, options), name = run.parts[0].name;
      try {
        for await (const row of jsonLines(metadata.dataPath, options)) { const [path, value] = pair(row); if (content(value)) putWanted.run(name, position, path, JSON.stringify(value)); }
        for await (const row of jsonLines(metadata.storedPath, options)) { const [path, value] = pair(row); if (content(value)) putStored.run(name, position, path, JSON.stringify(value)); }
      } finally { await metadata.cleanup(); }
    }
    return { runs, db, cleanup };
  } catch (error) { await cleanup(); throw error; }
}
function blockersFor(state, target, respectPin = true) {
  const blockers = [];
  if (respectPin && target.pinned) blockers.push({ runId: target.id, reason: 'This snapshot is pinned.' });
  const name = target.parts[0].name;
  const needed = state.db.prepare('SELECT DISTINCT w.snapshot FROM wanted w WHERE w.snapshot<>? AND EXISTS(SELECT 1 FROM stored t WHERE t.snapshot=? AND t.path=w.path AND t.fingerprint=w.fingerprint AND t.position<=w.position) AND NOT EXISTS(SELECT 1 FROM stored s WHERE s.snapshot<>? AND s.path=w.path AND s.fingerprint=w.fingerprint AND s.position<=w.position)');
  for (const row of needed.iterate(name, name, name)) blockers.push({ runId: row.snapshot.slice(0, -4), reason: 'This snapshot needs a file version stored only in the selected archive.' });
  return blockers;
}
async function ordinary(filename) { const info = await lstat(filename, { bigint: true }); if (!info.isFile() || info.isSymbolicLink() || info.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Snapshot archive must be an ordinary file'); return info; }
const same = (a, b) => a.isFile() && !a.isSymbolicLink() && a.ino === b.ino && a.dev === b.dev && a.size === b.size && a.mtimeNs === b.mtimeNs;
async function deleteArchive(destination, run, options, guard) {
  const name = run.parts[0].name; if (name !== `${runId(run.id)}.zip`) throw new Error('Invalid snapshot archive filename');
  const filename = join(destination, name), before = await ordinary(filename);
  await pausePoint(options); await options.fault?.('before-retention-delete', { runId: run.id }); await guard();
  if (!same(await ordinary(filename), before)) throw new Error('Snapshot archive changed before deletion');
  await unlink(filename); return { name, bytes: Number(before.size) };
}

export async function planDeleteRun(task, destination, id, options = {}) {
  destination = resolve(destination); runId(id); const guard = await taskDirectoryGuard(destination, task); await guard();
  const state = await inventory(destination, options);
  try {
    const target = state.runs.find(run => run.id === id); if (!target) throw new Error(`Snapshot is unavailable: ${id}`);
    const blockers = blockersFor(state, target), name = target.parts[0].name, info = await ordinary(join(destination, name)); await guard();
    return { runId: id, status: blockers.length ? 'blocked' : 'ready', allowed: !blockers.length, blockers: blockers.map(blocker => `${blocker.runId}: ${blocker.reason}`), files: [name], fileDetails: [{ name, bytes: Number(info.size) }], bytes: Number(info.size) };
  } finally { await state.cleanup(); }
}
export async function deleteRun(task, destination, id, options = {}) {
  destination = resolve(destination); runId(id);
  return withLock(task, destination, async guard => {
    const state = await inventory(destination, options);
    try {
      const target = state.runs.find(run => run.id === id); if (!target) throw new Error(`Snapshot is unavailable: ${id}`);
      const blockers = blockersFor(state, target); if (blockers.length) throw Object.assign(new Error(blockers.map(blocker => `${blocker.runId}: ${blocker.reason}`).join(' ')), { code: 'DELETE_BLOCKED', blockers });
      const file = await deleteArchive(destination, target, options, guard); await syncTaskCatalog(destination, { task, guard, signal: options.signal, removeSnapshotIds: [target.id] });
      return { runId: id, deleted: [file.name], bytes: file.bytes };
    } finally { await state.cleanup(); }
  });
}
export async function applyRetention(task, destination, options = {}) { destination = resolve(destination); return withLock(task, destination, guard => applyRetentionUnlocked(task, destination, { ...options, destinationGuard: guard })); }
export async function applyRetentionUnlocked(task, destination, options = {}) {
  const policy = task.retention; if (!policy?.keepCycles && !policy?.maxAgeDays) return { removed: [] };
  const state = await inventory(destination, options), guard = options.destinationGuard ?? await taskDirectoryGuard(destination, task);
  try {
    const cycles = [...new Set(state.runs.map(run => run.cycleId ?? run.id))], protectedCycles = new Set(options.preserveCycleIds ?? []);
    if (policy.keepCycles > 0) for (const cycle of cycles.slice(-policy.keepCycles)) protectedCycles.add(cycle);
    const cutoff = Date.now() - (policy.maxAgeDays ?? 0) * 86400000;
    for (const run of state.runs) if (run.status !== 'complete' || policy.protectPinned && run.pinned || options.excludeRunIds?.includes(run.id) || policy.maxAgeDays > 0 && Date.parse(run.startedAt) >= cutoff) protectedCycles.add(run.cycleId ?? run.id);
    const byName = new Map(state.runs.map(run => [run.parts[0].name, run]));
    const missing = state.db.prepare('SELECT DISTINCT (SELECT s.snapshot FROM stored s WHERE s.path=w.path AND s.fingerprint=w.fingerprint AND s.position<=w.position ORDER BY s.position DESC LIMIT 1) AS provider FROM wanted w WHERE w.snapshot NOT IN (SELECT snapshot FROM deleting) AND NOT EXISTS(SELECT 1 FROM stored s WHERE s.path=w.path AND s.fingerprint=w.fingerprint AND s.position<=w.position AND s.snapshot NOT IN (SELECT snapshot FROM deleting))');
    let changed;
    do {
      state.db.exec('DELETE FROM deleting'); const put = state.db.prepare('INSERT INTO deleting(snapshot) VALUES (?)');
      for (const run of state.runs) if (!protectedCycles.has(run.cycleId ?? run.id)) put.run(run.parts[0].name);
      changed = false;
      for (const row of missing.iterate()) { const provider = byName.get(row.provider); if (provider && !protectedCycles.has(provider.cycleId ?? provider.id)) { protectedCycles.add(provider.cycleId ?? provider.id); changed = true; } }
    } while (changed);
    const removed = [];
    for (const run of [...state.runs].reverse()) if (!protectedCycles.has(run.cycleId ?? run.id)) {
      await deleteArchive(destination, run, options, guard); removed.push(run.id);
      await syncTaskCatalog(destination, { task, guard, signal: options.signal, removeSnapshotIds: [run.id] });
    }
    return { removed };
  } finally { await state.cleanup(); }
}
export async function recoverRetention(task, destination, options = {}) {
  destination = resolve(destination);
  return withLock(task, destination, async guard => { await pausePoint(options); await syncTaskCatalog(destination, { task, guard, signal: options.signal }); return { recovered: [] }; });
}
export async function pinRun(destination, id, pinned = true) {
  destination = resolve(destination); runId(id); if (typeof pinned !== 'boolean') throw new TypeError('Pinned must be a boolean');
  const task = (await readTaskDocument(join(destination, '.delta.json'))).value;
  return withLock(task, destination, async guard => { await guard(); return writePin(destination, id, pinned); });
}
