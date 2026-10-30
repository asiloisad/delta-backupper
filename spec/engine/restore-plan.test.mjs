import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, lstat, readdir, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { flatPoint } from './flat-fixtures.mjs';
import { planRestore, restoreRun, verifyRun, runBackup } from '../../src/engine/index.mjs';
import { acquireTaskLock } from '../../src/engine/storage.mjs';

const point = flatPoint;

test('Restore preview counts selected files and directories without creating output or leaving a repository lock', async t => {
  const f = await point(t, [{ path: 'folder', kind: 'directory' }, { path: 'folder/a', content: 'alpha' }, { path: 'other', content: 'second' }]);
  const preview = await planRestore(f.destination, f.runId, f.output, { paths: ['folder/a'] });
  assert.equal(preview.status, 'ready', JSON.stringify(preview)); assert.equal(preview.files, 1); assert.equal(preview.bytes, 5); assert.equal(preview.directories, 1); assert.equal(preview.parts, 1);
  await assert.rejects(lstat(f.output), { code: 'ENOENT' }); await assert.rejects(lstat(join(f.destination, '.delta-lock')), { code: 'ENOENT' });
  assert.match(preview.scope, /verified during restore/);
});

test('Restore preview exposes collisions and honors skip and replace only for ordinary files', async t => {
  const f = await point(t); await mkdir(join(f.output), { recursive: true }); const target = join(f.output, 'a.txt'); await writeFile(target, 'original');
  const collision = await planRestore(f.destination, f.runId, f.output); assert.equal(collision.status, 'blocked'); assert.equal(collision.conflicts, 1);
  const skipped = await planRestore(f.destination, f.runId, f.output, { overwrite: 'skip' }); assert.equal(skipped.status, 'ready'); assert.equal(skipped.skipped, 1); assert.equal(skipped.conflicts, 1);
  const replace = await planRestore(f.destination, f.runId, f.output, { overwrite: 'replace' }); assert.equal(replace.status, 'ready'); assert.equal(replace.conflicts, 1); assert.match(replace.issues[0].error, /replaced/); assert.equal(await readFile(target, 'utf8'), 'original');
  await rm(target); await mkdir(target); const occupied = await planRestore(f.destination, f.runId, f.output, { overwrite: 'replace' }); assert.equal(occupied.status, 'blocked'); assert.equal(occupied.unsafe, 1);
});

test('Restore preview bounds issues independently of total conflict counts', async t => {
  const f = await point(t, Array.from({ length: 105 }, (_, index) => ({ path: `${index}.txt`, content: 'data' }))); await mkdir(join(f.output), { recursive: true });
  await Promise.all(f.entries.map(entry => writeFile(join(f.output, entry.path), 'keep')));
  const preview = await planRestore(f.destination, f.runId, f.output, { maxIssues: 1000 }); assert.equal(preview.conflicts, 105); assert.equal(preview.issues.length, 100); assert.equal(preview.issuesTruncated, true);
  const limited = await planRestore(f.destination, f.runId, f.output, { maxIssues: 1 }); assert.equal(limited.conflicts, 105); assert.equal(limited.issues.length, 1); assert.equal(limited.issuesTruncated, true);
});

test('Selective preview and restore ignore an unavailable older archive when selected current content is present', async t => {
  const f = await point(t); await rm(join(f.destination, `${f.runId}.zip`));
  const source = join(f.root, 'source'); await mkdir(source); await writeFile(join(source, 'a'), 'alpha'); await writeFile(join(source, 'b'), 'bravo');
  const task = { ...f.task, sequence: { types: ['full', 'incremental'] } };
  await writeFile(join(f.destination, '.delta.json'), JSON.stringify({ workingDirectory: f.root, backupDirectory: f.destination, sources: ['source'], pathMode: 0, history: [], files: {} }));
  const first = await runBackup(task, f.destination); await writeFile(join(source, 'a'), 'changed alpha'); const selected = await runBackup(task, f.destination);
  assert.equal(first.status, 'complete', first.error); assert.equal(selected.status, 'complete', selected.error); await rm(join(f.destination, `${first.id}.zip`));
  assert.equal((await planRestore(f.destination, selected.id, f.output)).status, 'blocked');
  assert.equal((await planRestore(f.destination, selected.id, f.output, { paths: ['a'] })).status, 'ready');
  const restored = await restoreRun(f.destination, selected.id, f.output, { paths: ['a'] }); assert.equal(restored.status, 'complete'); assert.equal(await readFile(join(f.output, 'a'), 'utf8'), 'changed alpha');
});

test('Preview inspects ZIP structure while extraction verifies payload CRC', async t => {
  const f = await point(t), archivePath = join(f.destination, f.run.parts[0].name), bytes = await readFile(archivePath), marker = bytes.indexOf(Buffer.from('alpha'));
  assert(marker >= 0); bytes[marker] ^= 1; await writeFile(archivePath, bytes);
  assert.equal((await planRestore(f.destination, f.runId, f.output)).status, 'ready');
  const restored = await restoreRun(f.destination, f.runId, f.output); assert.equal(restored.status, 'incomplete'); assert(restored.errors.some(error => /CRC|signature|integrity/i.test(error.error)));
  await writeFile(archivePath, bytes.subarray(0, bytes.length - 1)); const truncated = await planRestore(f.destination, f.runId, f.output); assert.equal(truncated.status, 'blocked'); assert.equal(truncated.missing + truncated.unsafe, 1);
});

test('Missing backup versions and unmatched selections block preview and unmatched actual restore cannot report success', async t => {
  const f = await point(t, [{ path: 'a', content: 'alpha' }, { path: 'missing', kind: 'missing' }]);
  assert.equal((await planRestore(f.destination, f.runId, f.output)).missing, 1);
  const unknown = await planRestore(f.destination, f.runId, f.output, { paths: ['unknown'] }); assert.equal(unknown.status, 'blocked'); assert.equal(unknown.missing, 1); assert.equal(unknown.parts, 0);
  const restored = await restoreRun(f.destination, f.runId, f.output, { paths: ['unknown'] }); assert.equal(restored.status, 'incomplete'); assert.match(restored.errors[0].error, /absent/);
  const invalid = await planRestore(f.destination, f.runId, f.output, { paths: Array(10001).fill('a') }); assert.equal(invalid.status, 'blocked'); assert.match(invalid.issues[0].error, /10000/);
});

test('Preview rejects malformed snapshot fields and metadata CRC failures without creating output', async t => {
  const f = await point(t); await f.commit({ snapshot: { startedAt: 'invalid timestamp' } });
  const invalid = await planRestore(f.destination, f.runId, f.output); assert.equal(invalid.status, 'blocked'); assert.equal(invalid.unsafe, 1); await assert.rejects(lstat(f.output), { code: 'ENOENT' });
  await f.commit(); await f.tamperSnapshot(); const tampered = await planRestore(f.destination, f.runId, f.output); assert.equal(tampered.status, 'blocked'); assert.match(tampered.issues[0].error, /integrity|signature|CRC|metadata/i);
});

test('Preview rejects a destination overlapping the backup repository', async t => {
  const f = await point(t); const overlap = await planRestore(f.destination, f.runId, f.destination); assert.equal(overlap.status, 'blocked'); assert.match(overlap.issues[0].error, /overlap/);
});

test('Preview refuses an existing redirected output parent and preserves external data', async t => {
  const f = await point(t, [{ path: 'nested/a', content: 'alpha' }]); const outside = join(f.root, 'outside'); await mkdir(outside); await writeFile(join(outside, 'keep'), 'keep'); await mkdir(join(f.output), { recursive: true }); await symlink(outside, join(f.output, 'nested'), process.platform === 'win32' ? 'junction' : 'dir');
  const preview = await planRestore(f.destination, f.runId, f.output); assert.equal(preview.status, 'blocked'); assert.equal(preview.unsafe, 1); assert.deepEqual(await readdir(outside), ['keep']);
});

test('Preview shares task locking and propagates cancellation while releasing its own lock', async t => {
  const f = await point(t); const lock = await acquireTaskLock(f.destination); await assert.rejects(planRestore(f.destination, f.runId, f.output), /locked/); await lock.release();
  const controller = new AbortController(); controller.abort(new Error('cancel preview')); await assert.rejects(planRestore(f.destination, f.runId, f.output, { signal: controller.signal }), /cancel preview/);
  await assert.rejects(lstat(join(f.destination, '.delta-lock')), { code: 'ENOENT' });
});

test('Windows preview rejects case aliases before writing either target', { skip: process.platform !== 'win32' }, async t => {
  const f = await point(t, [{ path: 'A', content: 'upper' }, { path: 'a', content: 'lower' }]); const preview = await planRestore(f.destination, f.runId, f.output, { overwrite: 'replace' });
  assert.equal(preview.status, 'blocked'); assert.equal(preview.unsafe, 1); assert.match(preview.issues[0].error, /Ambiguous restore target/); await assert.rejects(lstat(f.output), { code: 'ENOENT' });
  assert.equal((await verifyRun(f.destination, f.runId)).status, 'complete');
});
