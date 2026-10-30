import { join, resolve } from 'node:path';
import { json, jsonLines } from './storage.mjs';
import { listFlatRuns, openRunMetadata, iterateRunEntries, pausePoint } from './repository.mjs';

export async function listRunEntries(destination, runId, options = {}) {
  const limit = Math.min(1000, Math.max(1, options.limit ?? 200)), offset = Math.max(0, options.offset ?? 0); if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(limit)) throw new Error('Invalid page');
  const entries = []; let matched = 0; const query = (options.query ?? '').toLowerCase();
  for await (const entry of iterateRunEntries(resolve(destination), runId, options)) { await pausePoint(options); if (query && !entry.path.toLowerCase().includes(query)) continue; if (matched >= offset && entries.length < limit) entries.push(entry); matched++; }
  return { entries, total: matched, nextOffset: offset + entries.length < matched ? offset + entries.length : null, sourcePaths: {} };
}
export async function getRunDetails(destination, runId, options = {}) {
  const metadata = await openRunMetadata(resolve(destination), runId, { ...options, allowUncommitted: true });
  try {
    const errors = [], limit = Math.min(1000, Math.max(1, options.limit ?? 200));
    for await (const [path, error] of jsonLines(metadata.errorsPath, options)) if (errors.length < limit) errors.push({ path, error });
    return { ...metadata.run, fileErrors: errors, taskConfig: metadata.taskConfig, sourcePaths: {} };
  } finally { await metadata.cleanup(); }
}
export async function getTaskStatus(destination) {
  destination = resolve(destination); const optional = async path => { try { return await json(path); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
  const runs = await listFlatRuns(destination, { includeUncommitted: true }), latest = runs.findLast(run => run.committed && run.status === 'complete' && run.type !== 'differential');
  return { lock: await optional(join(destination, '.delta-lock', 'owner.json')), lastRun: runs.at(-1) ?? null, checkpoint: latest ? { runId: latest.id, cycleId: latest.cycleId } : null };
}
