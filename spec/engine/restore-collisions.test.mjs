import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, unlink, rm, stat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createBoundedArchive } from '../../src/archive/bounded-writer.mjs';
import { restoreRun, verifyRun } from '../../src/engine/index.mjs';
import { hashFile, openIndex } from '../../src/engine/storage.mjs';
import { createRestoreTargetMap } from '../../src/engine/restore-targets.mjs';
import { flatPoint } from './flat-fixtures.mjs';

async function committedPoint(t, specification) {
  return flatPoint(t, specification);
}

test('Windows replace preserves the first restored file when a valid Linux point contains A.txt and a.txt', { skip: process.platform !== 'win32' }, async t => {
  const f = await committedPoint(t, [{ path: 'A.txt', content: 'first logical file' }, { path: 'a.txt', content: 'second logical file' }]); assert.equal((await verifyRun(f.destination, f.runId)).status, 'complete'); await mkdir(join(f.output), { recursive: true }); await writeFile(join(f.output, 'A.txt'), 'pre-existing user file');
  const result = await restoreRun(f.destination, f.runId, f.output, { overwrite: 'replace' }); assert.equal(result.status, 'incomplete'); assert.equal(result.files, 1); assert.equal(result.skipped, 0); assert.ok(result.errors.some(e => e.error.includes('Ambiguous restore target'))); assert.equal(await readFile(join(f.output, 'A.txt'), 'utf8'), 'first logical file'); assert.deepEqual(await readdir(join(f.output)), ['A.txt']);
  const selectedOutput = join(f.root, 'selected'); const selected = await restoreRun(f.destination, f.runId, selectedOutput, { overwrite: 'replace', paths: ['a.txt'] }); assert.equal(selected.status, 'complete'); assert.equal(await readFile(join(selectedOutput, 'a.txt'), 'utf8'), 'second logical file');
});
test('Windows top-level archive directories differing only in case do not merge', { skip: process.platform !== 'win32' }, async t => {
  const f = await committedPoint(t, [{ path: 'SRC_CASE/one', content: 'first source' }, { path: 'src_case/two', content: 'second source' }]); assert.equal((await verifyRun(f.destination, f.runId)).status, 'complete'); const result = await restoreRun(f.destination, f.runId, f.output, { overwrite: 'replace' }); assert.equal(result.status, 'incomplete'); assert.equal(result.files, 1); assert.equal(await readFile(join(f.output, 'SRC_CASE', 'one'), 'utf8'), 'first source'); assert.deepEqual(await readdir(join(f.output, 'SRC_CASE')), ['one']);
});
test('Windows directory aliases are rejected before their separate logical children are merged', { skip: process.platform !== 'win32' }, async t => {
  const f = await committedPoint(t, [{ path: 'Dir/a', content: 'first directory child' }, { path: 'dir/b', content: 'second directory child' }]); const result = await restoreRun(f.destination, f.runId, f.output, { overwrite: 'replace' }); assert.equal(result.status, 'incomplete'); assert.equal(result.files, 1); assert.equal(await readFile(join(f.output, 'Dir', 'a'), 'utf8'), 'first directory child'); assert.deepEqual(await readdir(join(f.output, 'Dir')), ['a']);
});
test('Windows file/directory case aliases remain explicit errors under replace', { skip: process.platform !== 'win32' }, async t => {
  const f = await committedPoint(t, [{ path: 'Folder', kind: 'directory' }, { path: 'Folder/kept', content: 'kept content' }, { path: 'folder', content: 'would replace directory' }]); const result = await restoreRun(f.destination, f.runId, f.output, { overwrite: 'replace' }); assert.equal(result.status, 'incomplete'); assert.equal(await readFile(join(f.output, 'Folder', 'kept'), 'utf8'), 'kept content'); assert.ok(result.errors.some(e => e.error.includes('Ambiguous restore target')));
});
test('macOS conservative target policy rejects NFC/NFD aliases using the disk ledger', async t => {
  const root = await mkdtemp(join(tmpdir(), 'delta-unicode-policy-')); let db; t.after(async () => { db?.close(); await rm(root, { recursive: true, force: true }); }); const output = join(root, 'output'); await mkdir(join(output, 'src'), { recursive: true }); db = openIndex(join(root, 'names.sqlite')); const targets = createRestoreTargetMap(db, output, { platform: 'darwin' }); await targets.prepare('src/é.txt', 'file'); await writeFile(join(output, 'src', 'é.txt'), 'first Unicode spelling'); await targets.published('src/é.txt', 'file'); await assert.rejects(targets.prepare('src/e\u0301.txt', 'file'), /Ambiguous restore target/); assert.equal(await readFile(join(output, 'src', 'é.txt'), 'utf8'), 'first Unicode spelling');
});
test('observed filesystem identity catches aliases even when the OS name policy is case-sensitive', { skip: process.platform !== 'win32' }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'delta-physical-alias-')); let db; t.after(async () => { db?.close(); await rm(root, { recursive: true, force: true }); }); const output = join(root, 'output'); await mkdir(join(output, 'src'), { recursive: true }); db = openIndex(join(root, 'names.sqlite')); const targets = createRestoreTargetMap(db, output, { platform: 'linux' }); await targets.prepare('src/First.txt', 'file'); await writeFile(join(output, 'src', 'First.txt'), 'first accepted content'); await targets.published('src/First.txt', 'file'); await assert.rejects(targets.prepare('src/first.txt', 'file'), /Ambiguous restore target/); assert.equal(await readFile(join(output, 'src', 'First.txt'), 'utf8'), 'first accepted content');
});
