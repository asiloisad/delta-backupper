import { lstat, realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { acquireTaskLock, within } from './storage.mjs';
import { assertPlainZipOptions } from '../archive/plain-options.mjs';
import { prepareRestoreIndex, resolveOutputSelection, targetFor } from './restore.mjs';
import { createRestoreTargetMap } from './restore-targets.mjs';
import { pausePoint } from './repository.mjs';

/** Preview the selected file versions and destination without writing restored content. */
export async function planRestore(destination, runId, outputDirectory, options = {}) {
  assertPlainZipOptions(options);
  const selectedDestination = resolve(destination); destination = await realpath(selectedDestination);
  const identity = await stat(destination, { bigint: true }), lock = await acquireTaskLock(destination); let index;
  const result = { runId, status: 'ready', files: 0, bytes: 0, directories: 0, links: 0, skipped: 0, conflicts: 0, missing: 0, unsafe: 0, parts: 0, issues: [], issuesTruncated: false, scope: 'Snapshot maps, ZIP directory and destination preflight; content CRC and fingerprints are verified during restore.' };
  const maximum = options.maxIssues ?? 100, limit = Number.isSafeInteger(maximum) && maximum >= 0 ? Math.min(100, maximum) : 100;
  function issue(path, error, kind, blocking = true) { if (blocking) result.status = 'blocked'; result[kind === 'conflict' ? 'conflicts' : kind]++; if (result.issues.length < limit) result.issues.push({ path, error: String(error?.message ?? error), kind }); else result.issuesTruncated = true; }
  try {
    index = await prepareRestoreIndex(destination, runId, options); const { db, selection } = index;
    const chosen = await resolveOutputSelection(outputDirectory), output = chosen.path;
    if (within(destination, output) || within(output, destination)) throw new Error('Restore destination must not overlap the backup repository');
    await chosen.assert(); const targets = createRestoreTargetMap(db, output);
    result.parts = db.prepare('SELECT COUNT(DISTINCT archive) AS count FROM restore_entries WHERE selected=1 AND archive IS NOT NULL').get().count;
    for (const path of selection.unmatched) issue(path, 'Selected path is absent from this restore point', 'missing');
    for (const entry of db.prepare('SELECT * FROM restore_entries WHERE selected>0 ORDER BY path').iterate()) {
      await pausePoint(options);
      if (entry.error) { issue(entry.path, entry.error, 'missing'); continue; }
      if (entry.kind === 'file') { result.files++; result.bytes += entry.size; }
      else if (entry.kind === 'directory') result.directories++;
      try {
        await targets.prepare(entry.path, entry.kind); const target = targetFor(output, entry);
        const existing = await lstat(target).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
        if (entry.kind === 'directory') continue;
        if (existing) {
          if (!existing.isFile() || existing.isSymbolicLink()) { issue(entry.path, 'Restore destination is occupied by a symlink or non-file', 'unsafe'); continue; }
          if (options.overwrite === 'skip' && entry.kind === 'file') { issue(entry.path, 'Existing file will be skipped', 'conflict', false); result.skipped++; continue; }
          if (options.overwrite !== 'replace' || entry.kind !== 'file') { issue(entry.path, 'Restore collision', 'conflict'); continue; }
          issue(entry.path, 'Existing file will be replaced', 'conflict', false);
        }
      } catch (error) { if (options.signal?.aborted) throw error; issue(entry.path, error, 'unsafe'); }
    }
    await chosen.assert(); const current = await stat(selectedDestination, { bigint: true });
    if (identity.ino !== current.ino || identity.dev !== current.dev || await realpath(selectedDestination) !== destination) throw new Error('Backup repository changed during restore preview');
    return result;
  } catch (error) { if (options.signal?.aborted) throw error; issue('', error, error.code === 'ENOENT' ? 'missing' : 'unsafe'); return result; }
  finally { await index?.cleanup(); await lock.release(); }
}
