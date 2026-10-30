import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { TextReader } from '@zip.js/zip.js';
import {
  createArchive, generatedSource, withArchive, readEntryHash,
  inspectTrailer, external7zip,
} from './support.mjs';

const utf8 = new TextEncoder();
const digest = (data) => createHash('sha256').update(data).digest('hex');

export async function smoke({ directory, tool }) {
  const path = join(directory, 'unicode-zip64.zip');
  const fixtures = [
    ['Zażółć gęślą jaźń/日本語/🗂️.txt', 'Delta Backupper — treść próbna.\n'],
    ['empty.txt', ''],
  ];
  const { writer, closeHandle } = await createArchive(path, { zip64: true });
  try {
    for (const [name, content] of fixtures) await writer.add(name, new TextReader(content));
    await writer.add('pusty katalog/', undefined, { directory: true });
    await writer.close();
  } finally { await closeHandle(); }
  const trailer = await inspectTrailer(path);
  assert.equal(trailer.zip64End, true);
  assert.equal(trailer.zip64Locator, true);
  await withArchive(path, async (reader) => {
    const entries = [];
    for await (const entry of reader.getEntriesGenerator()) entries.push(entry);
    assert.equal(entries.length, 3);
    for (const [name, content] of fixtures) {
      const entry = entries.find((value) => value.filename === name);
      assert.ok(entry, `Unicode name missing: ${name}`);
      assert.equal(entry.encrypted, false);
      assert.deepEqual(await readEntryHash(entry), {
        bytes: utf8.encode(content).length, sha256: digest(utf8.encode(content)),
      });
    }
  });
  const external = [];
  if (tool) {
    for (const [name, content] of fixtures) {
      const result = await external7zip(tool, path, { entry: name });
      assert.equal(result.exitCode, 0, result.output);
      assert.equal(result.sha256, digest(utf8.encode(content)));
      assert.equal(result.bytes, utf8.encode(content).length);
      external.push({ name, ...result });
    }
  }
  return { trailer, unicodeNames: true, encrypted: false, external };
}

export async function cancellation({ directory }) {
  const path = join(directory, 'cancelled.partial.zip');
  const controller = new AbortController();
  const size = 1024 * 1024 * 1024;
  const source = generatedSource(size, {
    onChunk(produced) {
      if (produced >= 4 * 1024 * 1024) controller.abort(new Error('Deliberate test cancellation'));
    },
  });
  const { writer, closeHandle } = await createArchive(path, { level: 0 });
  let rejected;
  try {
    await assert.rejects(async () => {
      try { await writer.add('interrupted.bin', source.stream, { signal: controller.signal }); }
      catch (error) { rejected = { name: error.name, message: error.message }; throw error; }
    });
    assert.ok(source.produced < size, 'Cancellation consumed the entire input');
  } finally { await closeHandle(); }
  // Deliberately do not finalize this output. It is not a valid backup part.
  const unfinishedOutput = await inspectTrailer(path);
  return { expectedBytes: size, consumedBytes: source.produced, rejected,
    unfinishedOutput, finalized: false };
}
