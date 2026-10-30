import test from 'node:test';

import assert from 'node:assert/strict';

import { mkdtemp, readFile, writeFile, lstat, rm } from 'node:fs/promises';

import { tmpdir } from 'node:os';

import { join } from 'node:path';

import { TextReader } from '@zip.js/zip.js';

import { createBoundedArchive } from '../../src/archive/bounded-writer.mjs';

import { readArchiveComment, readSnapshotHeader, extractMetadataEntry } from '../../src/archive/snapshot-metadata.mjs';

const data = JSON.stringify({ startedAt: '2026-10-30 00:00:00.000000', finishedAt: '2026-10-30 00:00:01.000000', compressionLevel: 0, full: true, totalBytes: 3, storedBytes: 3, files: { 'Documents/\u017c\u00f3\u0142\u0107.txt': '1:3' }, archivedFiles: { 'Documents/\u017c\u00f3\u0142\u0107.txt': '1:3' }, errors: {} });

async function fixture(t, { zip64 = true, level = 0, metadata = data, name = '.snapshot.json' } = {}) {

  const directory = await mkdtemp(join(tmpdir(), 'delta-simple-metadata-')); t.after(() => rm(directory, { recursive: true, force: true })); const filename = join(directory, 'backup.zip'), output = join(directory, '.snapshot.json');

  const archive = await createBoundedArchive(filename, { zip64, level }); await archive.writer.add('Documents/a.txt', new TextReader('payload')); await archive.writer.add(name, new TextReader(metadata)); await archive.writer.close(); return { directory, filename, output };

}

for (const zip64 of [false, true]) for (const level of [0, 1]) test(`ordinary ZIP metadata roundtrip without comments, ZIP64=${zip64}, level=${level}`, async t => {

  const f = await fixture(t, { zip64, level }); assert.deepEqual(await readArchiveComment(f.filename), {});

  const expected = { time: '2026-10-30 00:00:00.000000', ends: '2026-10-30 00:00:01.000000', comp: 0, full: true, size: 3, sizx: 3 }; assert.deepEqual(await readSnapshotHeader(f.filename), expected);

  const result = await extractMetadataEntry(f.filename, f.output); assert.equal(result.bytes, Buffer.byteLength(data)); assert.equal(result.name, '.snapshot.json'); assert.equal(await readFile(f.output, 'utf8'), data);

});

test('metadata extraction is exclusive and never replaces an existing output', async t => { const f = await fixture(t); await writeFile(f.output, 'existing'); await assert.rejects(extractMetadataEntry(f.filename, f.output), { code: 'EEXIST' }); assert.equal(await readFile(f.output, 'utf8'), 'existing'); });

test('size limits and cancellation leave no partial metadata files', async t => { const f = await fixture(t); await assert.rejects(extractMetadataEntry(f.filename, f.output, { maxBytes: 5 }), /Invalid \.snapshot\.json/); await assert.rejects(lstat(f.output), { code: 'ENOENT' }); await assert.rejects(extractMetadataEntry(f.filename, f.output, { signal: AbortSignal.abort() }), { name: 'AbortError' }); });

test('missing metadata and malformed JSON fail clearly', async t => { const f = await fixture(t, { name: 'other.json' }); await assert.rejects(readSnapshotHeader(f.filename), /no \.snapshot\.json/); const malformed = await fixture(t, { metadata: '{' }); await assert.rejects(readSnapshotHeader(malformed.filename)); });

test('the previous metadata filename is not accepted as an alias', async t => { const f = await fixture(t, { name: 'snapshot.json' }); await assert.rejects(readSnapshotHeader(f.filename), /no \.snapshot\.json/); });

test('ordinary ZIP CRC catches changed snapshot metadata', async t => { const f = await fixture(t), bytes = await readFile(f.filename), offset = bytes.indexOf(Buffer.from('Documents/\u017c\u00f3\u0142\u0107.txt')); assert(offset >= 0); bytes[offset] ^= 1; await writeFile(f.filename, bytes); await assert.rejects(readSnapshotHeader(f.filename), /CRC|signature|checksum/i); });
