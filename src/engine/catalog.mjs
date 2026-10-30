import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { readTaskDocument, saveTaskDocument, iterateTaskData } from '../config/task-document.mjs';
import { listFlatRuns, openRunMetadata, archiveName, pausePoint } from './repository.mjs';
import { jsonLines } from './storage.mjs';

/** Failed reads are not a checkpoint: an unchanged incremental must retry them. */
async function* checkpointData(metadata, options) {
  const db = new DatabaseSync(join(metadata.path, 'checkpoint.sqlite'));
  try {
    db.exec('PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA cache_size=-1024; PRAGMA mmap_size=0; PRAGMA temp_store=FILE; CREATE TABLE failed(path TEXT PRIMARY KEY) WITHOUT ROWID');
    const insert = db.prepare('INSERT OR IGNORE INTO failed(path) VALUES (?)'), contains = db.prepare('SELECT 1 FROM failed WHERE path=?');
    for await (const [path] of jsonLines(metadata.errorsPath, options)) { await pausePoint(options); insert.run(path); }
    for await (const pair of jsonLines(metadata.dataPath, options)) { await pausePoint(options); if (!contains.get(pair[0])) yield pair; }
  } finally { db.close(); }
}

/** Update the readable task catalog after publishing one snapshot. */
export async function syncTaskCatalog(destination, options = {}) {
  destination = resolve(destination); const filename = join(destination, '.delta.json');
  for (let attempt = 0; attempt < 3; attempt++) {
    await pausePoint(options); await options.guard?.(); const current = await readTaskDocument(filename, { signal: options.signal });
    const id = options.snapshotId ?? options.runId ?? options.checkpoint, removed = new Set((options.removeSnapshotIds ?? options.removedRunIds ?? []).map(id => archiveName(id))), hist = current.hist.filter(name => !removed.has(name));
    if (id && !hist.includes(archiveName(id))) hist.push(archiveName(id));
    let metadata;
    try {
      let checkpoint = options.checkpoint ?? id;
      const updateData = options.updateData ?? (!!options.checkpoint || removed.size > 0);
      if (updateData && !checkpoint && hist.length) {
        const runs = await listFlatRuns(destination, { ...options, ignoreInvalid: true }); checkpoint = runs.findLast(run => !removed.has(archiveName(run.id)) && run.status === 'complete' && run.type !== 'differential')?.id;
      }
      if (updateData && checkpoint) metadata = await openRunMetadata(destination, checkpoint, options);
      const data = metadata ? checkpointData(metadata, options) : updateData ? [] : iterateTaskData(filename, options);
      await saveTaskDocument(filename, current.value, current.revision, { signal: options.signal, catalog: { hist, data }, guard: options.guard });
      return { hist, checkpointRunId: metadata?.run.id ?? null };
    } catch (error) { if (error.code !== 'CONFIGURATION_CONFLICT' || attempt === 2) throw error; }
    finally { await metadata?.cleanup(); }
  }
}
