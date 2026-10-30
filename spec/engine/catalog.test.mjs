import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TextReader } from '@zip.js/zip.js';
import { createBoundedArchive } from '../../src/archive/bounded-writer.mjs';
import { readTaskDocument, saveTaskDocument, iterateTaskData } from '../../src/config/task-document.mjs';
import { syncTaskCatalog } from '../../src/engine/catalog.mjs';
import { listFlatRuns, openRunMetadata, archiveName } from '../../src/engine/repository.mjs';
import { jsonLines } from '../../src/engine/storage.mjs';
import { runBackup } from '../../src/engine/backup.mjs';
import { verifyRun, restoreRun } from '../../src/engine/restore.mjs';
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'delta-simple-catalog-')); t.after(() => rm(directory, { recursive: true, force: true })); const destination = join(directory, 'backup'); await mkdir(destination);
  const filename = join(destination, '.delta.json'), task = { name: 'Documents', sources: [{ path: '../Documents', filters: { include: [], exclude: [] } }] }; await saveTaskDocument(filename, task, null); return { directory, destination, filename, task };
}
async function snapshot(f, id, type, data, stored = data) {
  const archive = await createBoundedArchive(join(f.destination, archiveName(id)), { zip64: true, level: 0 }), header = { time: '2026-10-30 01:00:00.000000', ends: '2026-10-30 01:00:01.000000', comp: 0, full: type === 'full', size: 3, sizx: 3 };
  for (const [name, value] of Object.entries(stored)) if (value !== null) await archive.writer.add(name, new TextReader('abc'));
  await archive.writer.add('.snapshot.json', new TextReader(JSON.stringify({ startedAt: header.time, finishedAt: header.ends, compressionLevel: header.comp, full: header.full, totalBytes: header.size, storedBytes: header.sizx, files: data, archivedFiles: stored, errors: {} }))); await archive.writer.close();
}
const data = async filename => Object.fromEntries(await Array.fromAsync(iterateTaskData(filename)));

test('main catalog uses hist and readable data without schema or identity fields', async t => {
  const f = await fixture(t), id = '20261030010000', values = { Documents: null, 'Documents/a.txt': '1:3' }; await snapshot(f, id, 'full', values);
  await syncTaskCatalog(f.destination, { snapshotId: id, checkpoint: id, updateData: true });
  const disk = JSON.parse(await readFile(f.filename, 'utf8')); assert.deepEqual(Object.keys(disk), ['sources', 'name', 'history', 'files']); assert.deepEqual(disk.history, [`${id}.zip`]); assert.deepEqual(disk.files, values);
  const metadata = await openRunMetadata(f.destination, id); try { assert.deepEqual(await Array.fromAsync(jsonLines(metadata.dataPath)), Object.entries(values)); assert.equal(metadata.run.files, 1); assert.equal(metadata.run.parts.length, 1); } finally { await metadata.cleanup(); }
});

test('differential snapshots append history while preserving the F/I checkpoint', async t => {
  const f = await fixture(t), full = '20261030010000', differential = '20261030020000', old = { 'Documents/a.txt': '1:3' }, next = { 'Documents/a.txt': '2:3' }; await snapshot(f, full, 'full', old); await syncTaskCatalog(f.destination, { snapshotId: full, checkpoint: full });
  await snapshot(f, differential, 'differential', next); await syncTaskCatalog(f.destination, { snapshotId: differential, updateData: false }); assert.deepEqual(await data(f.filename), old);
  const runs = await listFlatRuns(f.destination); assert.deepEqual(runs.map(run => run.id), [full, differential]); assert.equal(runs[1].cycleId, full);
});

test('hist is authoritative and archives in this directory need no task ownership proof', async t => {
  const f = await fixture(t), id = '20261030010000'; await snapshot(f, id, 'full', { 'Documents/a.txt': '1:3' }); assert.deepEqual(await listFlatRuns(f.destination), []);
  const current = await readTaskDocument(f.filename); await saveTaskDocument(f.filename, current.value, current.revision, { catalog: { hist: [`${id}.zip`], data: [] } }); assert.equal((await listFlatRuns(f.destination))[0].id, id);
});

test('catalog retries preserve concurrent task settings while publishing snapshot data', async t => {
  const f = await fixture(t), id = '20261030010000'; await snapshot(f, id, 'full', { 'Documents/a.txt': '1:3' }); let checks = 0;
  await syncTaskCatalog(f.destination, { snapshotId: id, checkpoint: id, async guard() { if (++checks === 2) { const current = await readTaskDocument(f.filename); await saveTaskDocument(f.filename, { ...current.value, name: 'Renamed' }, current.revision); } } });
  const current = await readTaskDocument(f.filename); assert.equal(current.value.name, 'Renamed'); assert.deepEqual(current.hist, [`${id}.zip`]); assert.deepEqual(await data(f.filename), { 'Documents/a.txt': '1:3' }); assert(checks >= 3);
});


test('an unchanged incremental retries a version that failed to enter the previous archive', async t => {
  const f = await fixture(t), source = join(f.directory, 'Documents'); await mkdir(source); await writeFile(join(source, 'a.txt'), 'initial'); await writeFile(join(source, 'keep.txt'), 'unchanged');
  const task = { ...f.task, sequence: { types: ['full', 'incremental', 'incremental'] }, archive: { level: 0 }, detection: 'fast', behavior: { continueOnFileError: true, retryCount: 0, resume: true } };
  const current = await readTaskDocument(f.filename); await saveTaskDocument(f.filename, task, current.revision);
  const initial = await runBackup(task, f.destination); assert.equal(initial.status, 'complete');
  const changed = 'new version that initially fails to copy'; await writeFile(join(source, 'a.txt'), changed);
  const failed = await runBackup(task, f.destination, { fault(stage, { entry }) { if (stage === 'before-file' && entry.path === 'a.txt') throw Object.assign(new Error('Controlled source read failure'), { sourceReadError: true }); } });
  assert.equal(failed.status, 'incomplete'); assert.equal(failed.errors, 1); assert(!Object.hasOwn(await data(f.filename), 'a.txt'));
  const metadata = await openRunMetadata(f.destination, failed.id); try { assert((await Array.fromAsync(jsonLines(metadata.dataPath))).some(([name]) => name === 'a.txt')); assert.equal((await Array.fromAsync(jsonLines(metadata.errorsPath)))[0][0], 'a.txt'); } finally { await metadata.cleanup(); }
  const retried = await runBackup(task, f.destination); assert.equal(retried.status, 'complete'); assert.equal(retried.type, 'incremental'); assert.equal(retried.storedSize, Buffer.byteLength(changed)); assert.equal((await verifyRun(f.destination, retried.id)).status, 'complete');
  const output = join(f.directory, 'restored'); assert.equal((await restoreRun(f.destination, retried.id, output)).status, 'complete'); assert.equal(await readFile(join(output, 'a.txt'), 'utf8'), changed); assert.equal(await readFile(join(output, 'keep.txt'), 'utf8'), 'unchanged');
});
