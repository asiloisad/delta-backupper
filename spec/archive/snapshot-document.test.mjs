import assert from 'node:assert/strict';

import { test } from 'node:test';

import { mkdtemp, readFile, writeFile, readdir, stat, rm } from 'node:fs/promises';

import { tmpdir } from 'node:os';

import { join } from 'node:path';

import { readSnapshotDocument, writeSnapshotDocument } from '../../src/archive/snapshot-document.mjs';

const header = { time: '2026-10-30 01:00:00.000000', ends: '2026-10-30 01:00:01.000000', comp: 0, full: true, size: 3, sizx: 3 };

const maps = () => ({ data: [['Documents', null], ['Documents/\u017c\u00f3\u0142\u0107.txt', '123:3']], lock: [['Documents/\u017c\u00f3\u0142\u0107.txt', '123:3']], errs: [] });

async function fixture(t) { const directory = await mkdtemp(join(tmpdir(), 'delta-simple-snapshot-')); t.after(() => rm(directory, { recursive: true, force: true })); return { directory, filename: join(directory, '.snapshot.json') }; }



test('snapshot is a readable header and filename/fingerprint maps without identities', async t => {

  const f = await fixture(t); await writeSnapshotDocument(f.filename, header, maps()); const disk = JSON.parse(await readFile(f.filename, 'utf8'));

  assert.deepEqual(Object.keys(disk), ['startedAt', 'finishedAt', 'compressionLevel', 'full', 'totalBytes', 'storedBytes', 'files', 'archivedFiles', 'errors']);

  assert.deepEqual(disk.files, { Documents: null, 'Documents/\u017c\u00f3\u0142\u0107.txt': '123:3' });

  const seen = {}; assert.deepEqual(await readSnapshotDocument(f.filename, { onData: (name, value) => { seen[name] = value; } }), header); assert.deepEqual(seen, disk.files);

});



test('multiple maps larger than the header limit stream with async callback backpressure', { timeout: 60000 }, async t => {

  const f = await fixture(t), count = 18000, prefix = 'folder/'.repeat(160);

  async function* data() { for (let index = 0; index < count; index++) yield [`${prefix}${index}.txt`, `123:${index}`]; }

  await writeSnapshotDocument(f.filename, header, { data: data(), lock: [], errs: [] }); assert((await stat(f.filename)).size > 16 * 1024 ** 2);

  let seen = 0, active = 0, peak = 0;

  await readSnapshotDocument(f.filename, { onData: async (name, value) => { active++; peak = Math.max(peak, active); assert.equal(name, `${prefix}${seen}.txt`); assert.equal(value, `123:${seen}`); await Promise.resolve(); seen++; active--; } });

  assert.equal(seen, count); assert.equal(peak, 1);

});



test('lock and errs callbacks preserve their independent Python maps', async t => {

  const f = await fixture(t), expected = { data: [], lock: [['Docs/a', 'a'.repeat(64)]], errs: [['Docs/b', 'C:/Documents/b']] }, actual = { lock: [], errs: [] };

  await writeSnapshotDocument(f.filename, header, expected);

  await readSnapshotDocument(f.filename, { onLocked: (...v) => { actual.lock.push(v); }, onError: (...v) => { actual.errs.push(v); } });

  for (const name of Object.keys(actual)) assert.deepEqual(actual[name], expected[name]);

});



test('pause gates writes and cancellation retains the previous complete document', async t => {

  const f = await fixture(t); let entered, release; const paused = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });

  const writing = writeSnapshotDocument(f.filename, header, maps(), { waitIfPaused: async () => { entered(); await gate; } }); await paused; await assert.rejects(stat(f.filename), { code: 'ENOENT' }); release(); await writing;

  const before = await readFile(f.filename), controller = new AbortController(); let closed = false;

  async function* data() { try { yield ['a', '123:1']; controller.abort(new Error('cancelled')); yield ['b', '123:2']; } finally { closed = true; } }

  await assert.rejects(writeSnapshotDocument(f.filename, header, { data: data(), lock: [], errs: [] }, { signal: controller.signal }), /cancelled/); assert(closed); assert.deepEqual(await readFile(f.filename), before); assert.deepEqual(await readdir(f.directory), ['.snapshot.json']);

});



test('incomplete, wrong and duplicated root maps are rejected', async t => {

  const f = await fixture(t);

  for (const text of ['{}', '[]', '{"files":[],"archivedFiles":{},"errors":{}}', '{"files":{"a":{}},"archivedFiles":{},"errors":{}}', '{"files":{},"archivedFiles":{},"errors":{"a":null}}', '{"files":{},"files":{},"archivedFiles":{},"errors":{}}', '{"files":{},"archivedFiles":{},"errors":{}}broken']) { await writeFile(f.filename, text); await assert.rejects(readSnapshotDocument(f.filename)); }

});



test('Unicode decoding, scalar bounds and header bounds apply to streaming maps', async t => {

  const f = await fixture(t), huge = 'x'.repeat(1024 ** 2 + 1);

  await assert.rejects(writeSnapshotDocument(f.filename, header, { data: [['a', huge]], lock: [], errs: [] }), /1 MiB/);

  await writeFile(f.filename, `{"files":{"a":"${huge}"},"archivedFiles":{},"errors":{}}`); await assert.rejects(readSnapshotDocument(f.filename), /1 MiB/);

  await writeFile(f.filename, Buffer.concat([Buffer.from('{"files":{"a":"'), Buffer.from([0xc3, 0x28]), Buffer.from('"},"archivedFiles":{},"errors":{}}')])); await assert.rejects(readSnapshotDocument(f.filename), /encoding|encoded|UTF-8/i);

  await assert.rejects(writeSnapshotDocument(f.filename, { ...header, id: 'unnecessary' }, maps()), /exactly/);

});


test('pausing a snapshot read stops before consuming the next input chunk', async t => {
  const f = await fixture(t); const rows = Array.from({ length: 1000 }, (_, index) => [`${'folder/'.repeat(30)}${index}.txt`, `123:${index}`]);
  await writeSnapshotDocument(f.filename, header, { data: rows, lock: [], errs: [] });
  let entered, release, calls = 0, consumed = 0; const paused = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const reading = readSnapshotDocument(f.filename, { waitIfPaused: async () => { calls++; entered(); await gate; }, onData: () => { consumed++; } });
  await paused; assert.equal(consumed, 0); release(); await reading; assert.equal(consumed, rows.length); assert(calls > 1);
});
