import { open, mkdtemp, rm, stat, realpath, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createBoundedArchive } from '../archive/bounded-writer.mjs';
import { assertPlainZipOptions } from '../archive/plain-options.mjs';
import { writeSnapshotDocument } from '../archive/snapshot-document.mjs';
import { iterateTaskData } from '../config/task-document.mjs';
import { safePath, acquireTaskLock, within, taskDirectoryGuard } from './storage.mjs';
import { scanSources, validateSources } from './scanner.mjs';
import { applyRetentionUnlocked } from './retention.mjs';
import { listFlatRuns, reserveRunId, archiveName, publishArchive, pausePoint } from './repository.mjs';
import { syncTaskCatalog } from './catalog.mjs';
import { resolveTaskSources, archiveSourcePath, expandSourcePath, portablePath } from '../domain/source-identity.mjs';

export const listRuns = listFlatRuns;
const errorText = error => String(error?.message ?? error).slice(0, 4000);
function pythonTime(value = new Date()) {
  const pad = (n, length = 2) => String(n).padStart(length, '0');
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())} ${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}.${pad(value.getMilliseconds(), 3)}000`;
}
function chooseType(task, runs, requested) {
  if (!runs.length) return 'full';
  if (requested) return requested;
  return task.sequence.types[runs.length % task.sequence.types.length];
}
async function inputReader(filename, expected, options = {}) {
  const handle = await open(filename, 'r'); let closed = false;
  const close = async () => { if (!closed) { closed = true; await handle.close(); } };
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || expected && (String(before.mtimeNs) !== expected.mtimeNs || Number(before.size) !== expected.size)) throw new Error('Source changed before reading');
    const hash = createHash('sha256'); let bytes = 0;
    return { reader: { size: Number(before.size), readable: new ReadableStream({ async pull(controller) {
      try {
        await pausePoint(options); const buffer = Buffer.allocUnsafe(64 * 1024), result = await handle.read(buffer, 0, buffer.length, null);
        if (!result.bytesRead) {
          const after = await handle.stat({ bigint: true });
          if (before.mtimeNs !== after.mtimeNs || before.size !== after.size || bytes !== Number(before.size)) throw new Error('Source changed while reading');
          await close(); controller.close(); return;
        }
        const chunk = buffer.subarray(0, result.bytesRead); bytes += chunk.length; hash.update(chunk); controller.enqueue(chunk);
      } catch (error) { error.sourceReadError = true; await close(); controller.error(error); }
    }, async cancel() { await close(); } }) }, digest: () => hash.digest('hex'), close };
  } catch (error) { error.sourceReadError = true; await close(); throw error; }
}

export async function runBackup(task, destination, options = {}) {
  assertPlainZipOptions(options);
  task = { sequence: { types: ['full'] }, archive: { level: 6 }, detection: 'fast', symlinks: 'follow', snapshot: { mode: 'off', fallback: 'fail' }, behavior: { continueOnFileError: true, retryCount: 0, resume: true }, ...structuredClone(task) };
  if (Object.hasOwn(task, 'encryption')) throw new Error('Unsupported task field: encryption');
  const types = task.sequence?.types;
  if (!Array.isArray(types) || types[0] !== 'full' || types.some(type => !['full', 'incremental', 'differential'].includes(type))) throw new Error('Backup sequence must start with F and contain only F, I or D');
  if (options.type !== undefined && !['full', 'incremental', 'differential'].includes(options.type)) throw new Error('Unknown backup type');
  destination = resolve(destination); const guard = await taskDirectoryGuard(destination, task);
  const sources = resolveTaskSources(task).map(source => ({ ...source, path: resolve(task.wdir ?? destination, expandSourcePath(source.path)) }));
  destination = await realpath(destination); const lock = await acquireTaskLock(destination);
  try { await guard(); return await execute(task, destination, { ...options, resolvedSources: sources, destinationGuard: guard }); }
  finally { await lock.release(); }
}

async function execute(task, destination, options) {
  const originals = await validateSources(task, destination, options.resolvedSources);
  const excludedSourcePaths = originals.filter(source => within(source.canonicalPath, destination)).map(source => ({ sourceId: source.id, path: relative(source.canonicalPath, destination).replaceAll('\\', '/') }));
  const runs = await listRuns(destination, options), type = chooseType(task, runs, options.type), id = await reserveRunId(destination, options), name = archiveName(id);
  let provider, sources = originals, scratch, db, archive, published = false, success = false;
  const run = { id, type, cycleId: type === 'full' ? id : runs.at(-1)?.cycleId ?? id, baseRunId: runs.at(-1)?.id ?? null, startedAt: pythonTime(), finishedAt: null, status: 'running', files: 0, bytes: 0, errors: 0, parts: [], pinned: false, consistentSnapshot: false, sourceConsistency: 'live', resumedFrom: options.reuseRunId ?? null, committed: false };
  try {
    if (task.snapshot.mode !== 'off' || options.sourceProvider) {
      if (!options.sourceProvider) throw new Error('A source snapshot was requested but no qualified source provider is available');
      try {
        provider = await options.sourceProvider.prepare(task, { ...options, sources: originals });
        if (task.snapshot.mode !== 'off' && !provider.consistentSnapshot) throw new Error('The source provider did not confirm a consistent snapshot');
        if (task.snapshot.mode !== 'off' && task.symlinks === 'follow' && (!provider.scan || !provider.followsLinksInSnapshot)) throw new Error('Snapshot followed links require a scanner that remaps links into the snapshot');
        await provider.validateSources?.(); sources = provider.scan ? provider.sources : await validateSources(task, destination, provider.sources);
        run.consistentSnapshot = provider.consistentSnapshot === true; run.sourceConsistency = provider.sourceConsistency ?? 'snapshot'; run.atomicSet = provider.atomicSet;
      } catch (error) {
        let cleaned = !provider && error.cleanupVerified === true;
        if (provider) { await provider.release({ success: false }); provider = undefined; cleaned = true; }
        if (!cleaned || options.signal?.aborted || error.cleanupVerified === false || task.snapshot.fallback !== 'live') throw error;
        sources = originals; options.onProgress?.({ phase: 'warning', message: `Live fallback: ${errorText(error)}` });
      }
    }
    scratch = await mkdtemp(join(options.cacheDirectory ?? tmpdir(), 'delta-backup-'));
    db = new DatabaseSync(join(scratch, 'files.sqlite'));
    db.exec('PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA cache_size=-2048; PRAGMA temp_store=FILE; CREATE TABLE previous(path TEXT PRIMARY KEY,value TEXT) WITHOUT ROWID; CREATE TABLE files(path TEXT PRIMARY KEY,row TEXT,value TEXT,locked INTEGER DEFAULT 0,error TEXT) WITHOUT ROWID;');
    const previous = db.prepare('INSERT OR REPLACE INTO previous VALUES (?,?)');
    for await (const [path, value] of iterateTaskData(join(destination, '.delta.json'), options)) { await pausePoint(options); previous.run(path, JSON.stringify(value)); }
    if (task.retention?.when === 'before') await applyRetentionUnlocked(task, destination, options);
    const put = db.prepare('INSERT OR REPLACE INTO files(path,row) VALUES (?,?)');
    options.onProgress?.({ phase: 'scan', runId: id }); let lastProgress = 0, totalsKnown = true;
    const scanOptions = { ...options, excludedSourcePaths };
    for await (const row of provider?.scan ? provider.scan(task, destination, scanOptions) : scanSources(task, destination, sources, scanOptions)) {
      await pausePoint(options); const source = originals.find(source => source.id === row.sourceId);
      if (!source) throw new Error('Scanner returned an unknown source');
      if (!row.path && row.kind === 'missing') throw new Error(`Source is unavailable: ${source.path}: ${row.error}`);
      const path = archiveSourcePath(task, source, row.path); if (!path) continue;
      safePath(path); if (path === '.snapshot.json') throw new Error('Source path .snapshot.json conflicts with snapshot metadata; choose another archive path mode');
      if (row.kind === 'file' && (!Number.isSafeInteger(row.size) || row.size < 0)) Object.assign(row, { kind: 'missing', error: 'Invalid source file size' });
      if (row.kind === 'missing') totalsKnown = false;
      row.logicalPath = path; row.originalPath = portablePath(row.path && !source.singleFile ? join(source.path, row.path) : source.path);
      const existing = db.prepare('SELECT row FROM files WHERE path=?').get(path);
      if (existing && !(row.kind === 'directory' && JSON.parse(existing.row).kind === 'directory')) throw new Error(`Sources produce the same archive path: ${path}. Choose configured or absolute archive paths in task settings.`);
      put.run(path, JSON.stringify(row)); await options.fault?.('scan-entry', { entry: row, runId: id });
      if (Date.now() - lastProgress >= 150) { lastProgress = Date.now(); options.onProgress?.({ phase: 'scan', runId: id, path }); }
    }
    const totals = db.prepare("SELECT COUNT(*) AS files,COALESCE(SUM(json_extract(row,'$.size')),0) AS bytes FROM files WHERE json_extract(row,'$.kind')='file'").get();
    let completedFiles = 0, completedBytes = 0, currentBytes = 0;
    const emit = path => options.onProgress?.({ phase: 'backup', runId: id, files: completedFiles, bytes: completedBytes, completedFiles, completedBytes: completedBytes + currentBytes, ...(totalsKnown ? { totalFiles: Number(totals.files), totalBytes: Number(totals.bytes) } : {}), errors: run.errors, ...(path ? { path } : {}) });
    const update = db.prepare('UPDATE files SET value=?,locked=?,error=? WHERE path=?'), prior = db.prepare('SELECT value FROM previous WHERE path=?');
    const partial = join(destination, `.${name}.partial`);
    archive = await createBoundedArchive(partial, { createParent: false, zip64: true, recoverSourceErrors: true, level: task.archive.level, signal: options.signal, waitIfPaused: options.waitIfPaused });
    emit();
    for (const queued of db.prepare('SELECT path,row FROM files ORDER BY path').iterate()) {
      await pausePoint(options); const row = JSON.parse(queued.row), path = queued.path; let value;
      currentBytes = 0;
      try {
        if (row.kind === 'missing') throw new Error(row.error);
        if (row.kind === 'symlink') throw new Error('Preserving symbolic links is not supported by the Python snapshot format');
        value = row.kind === 'directory' ? null : `${row.mtimeNs}:${row.size}`;
        let changed = type === 'full' || prior.get(path)?.value !== JSON.stringify(value);
        let readError;
        for (let attempt = 0; attempt <= Math.min(100, task.behavior.retryCount); attempt++) {
          let input, writerStarted = false;
          const openInput = async () => {
            try { return provider?.openFile ? await provider.openFile(row, { signal: options.signal }) : await inputReader(row.absolute, row, options); }
            catch (error) { error.sourceReadError = true; throw error; }
          };
          const track = input => {
            let readBytes = 0;
            return { ...input.reader, readable: input.reader.readable.pipeThrough(new TransformStream({ transform(chunk, controller) {
              readBytes += chunk.byteLength; currentBytes = Math.max(currentBytes, readBytes);
              if (readBytes === chunk.byteLength || Date.now() - lastProgress >= 150) { lastProgress = Date.now(); emit(path); }
              controller.enqueue(chunk);
            } })) };
          };
          try {
            if (row.kind === 'file' && (changed || task.detection === 'hash')) {
              try { await options.fault?.('before-file', { entry: row, runId: id }); } catch (error) { error.sourceReadError = true; throw error; }
              if (task.detection === 'hash') {
                input = await openInput(); const reader = track(input).readable.getReader();
                try { for (;;) { await pausePoint(options); if ((await reader.read()).done) break; } }
                catch (error) { error.sourceReadError = true; throw error; }
                finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
                value = input.digest(); changed = type === 'full' || prior.get(path)?.value !== JSON.stringify(value);
                await input.close(); input = undefined;
              }
            }
            if (changed) {
              if (row.kind === 'file') input = await openInput();
              writerStarted = true;
              await archive.writer.add(path, input ? track(input) : undefined, { directory: row.kind === 'directory', lastModDate: new Date(Number(BigInt(row.mtimeNs) / 1000000n)), externalFileAttributes: ((row.kind === 'directory' ? 0o40755 : 0o100000 | row.mode) << 16) >>> 0 });
              // A changed hash between the comparison and archive read invalidates this ZIP.
              if (input && task.detection === 'hash' && input.digest() !== value) throw new Error('Source content changed between comparison and archiving');
              run.storedSize = (run.storedSize ?? 0) + (row.kind === 'file' ? row.size : 0);
            }
            readError = undefined; break;
          } catch (error) {
            if (options.signal?.aborted || writerStarted && !error.sourceReadErrorRecovered || !error.sourceReadError) throw error;
            readError = error;
          } finally { await input?.close(); }
        }
        if (readError) throw readError;
        update.run(JSON.stringify(value), Number(changed), null, path);
        if (row.kind === 'file') { run.files++; run.bytes += row.size; }
      } catch (error) {
        if (options.signal?.aborted || !task.behavior.continueOnFileError || row.kind !== 'missing' && !error.sourceReadError) throw error;
        update.run(value === undefined ? null : JSON.stringify(value), 0, row.originalPath, path); run.errors++; totalsKnown = false;
        options.onProgress?.({ phase: 'file-error', runId: id, path, message: errorText(error) });
      } finally { currentBytes = 0; }
      if (row.kind === 'file') { completedFiles++; completedBytes += row.size; }
      emit(path);
    }
    await provider?.verify?.({ fresh: true });
    options.onProgress?.({ phase: 'finalizing', runId: id, files: completedFiles, bytes: completedBytes, errors: run.errors });
    run.finishedAt = pythonTime(); run.status = run.errors ? 'incomplete' : 'complete';
    const missing = Number(db.prepare('SELECT COUNT(*) AS count FROM files WHERE value IS NOT NULL AND locked=0').get().count);
    const snapshot = { time: run.startedAt, ends: run.finishedAt, comp: task.archive.level, full: type === 'full' || missing === 0, size: Number(totals.bytes), sizx: run.storedSize ?? 0 };
    async function* map(kind) {
      const query = kind === 'errs' ? 'SELECT path,error AS value FROM files WHERE error IS NOT NULL ORDER BY path' : `SELECT path,value FROM files WHERE value IS NOT NULL${kind === 'lock' ? ' AND locked=1' : ''} ORDER BY path`;
      for (const item of db.prepare(query).iterate()) { await pausePoint(options); yield [item.path, kind === 'errs' ? item.value : JSON.parse(item.value)]; }
    }
    const metadataPath = join(scratch, '.snapshot.json');
    await writeSnapshotDocument(metadataPath, snapshot, { data: map('data'), lock: map('lock'), errs: map('errs') }, options);
    const metadata = await inputReader(metadataPath, undefined, options);
    try { await archive.writer.add('.snapshot.json', metadata.reader, { level: 0 }); } finally { await metadata.close(); }
    await options.fault?.('before-commit', { runId: id }); await options.destinationGuard(); await archive.writer.close();
    if (provider) { await provider.release({ success: run.errors === 0 }); provider = undefined; }
    await pausePoint(options); await options.destinationGuard();
    await publishArchive(partial, join(destination, name)); published = true;
    run.parts = [{ name, bytes: Number((await stat(join(destination, name))).size) }]; run.committed = true;
    // A published ZIP must reach the catalogue even when Cancel arrives here.
    await syncTaskCatalog(destination, { snapshotId: id, updateData: type !== 'differential', guard: options.destinationGuard });
    success = true;
    if (task.retention?.when === 'after') { try { await applyRetentionUnlocked(task, destination, options); } catch (error) { run.retentionError = errorText(error); } }
    return run;
  } finally {
    const errors = [];
    try {
      if (!published && archive) {
        await archive.closeHandle(); await options.destinationGuard();
        await unlink(join(destination, `.${name}.partial`)).catch(error => { if (error.code !== 'ENOENT') throw error; });
      }
    } catch (error) { errors.push(error); }
    try { db?.close(); } catch (error) { errors.push(error); }
    if (scratch) try { await rm(scratch, { recursive: true, force: true }); } catch (error) { errors.push(error); }
    try { await provider?.release({ success }); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, 'Backup resource cleanup failed');
  }
}

// Retrying a single ZIP scans current sources into a new archive.
export async function resumeRun(task, destination, runId, options = {}) {
  if (task.behavior?.resume === false) throw new Error('Task settings disable resuming');
  return runBackup(task, destination, { ...options, type: options.type ?? 'full', reuseRunId: runId });
}
export const retryRun = resumeRun;
