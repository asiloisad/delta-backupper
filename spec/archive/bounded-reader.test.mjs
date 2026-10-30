import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ZipWriter, Uint8ArrayWriter, TextWriter, TextReader } from '@zip.js/zip.js';
import { createBoundedReader } from '../../src/archive/bounded-reader.mjs';

async function fixture(context, options = {}, entries = [
  ['folder/', undefined, { directory: true }],
  ['folder/zażółć-日本語.txt', 'Backup test 🙂'],
  ['empty', ''],
]) {
  const directory = await mkdtemp(join(tmpdir(), 'delta-bounded-reader-test-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'archive.zip');
  const writer = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false, ...options });
  for (const [name, content, entryOptions] of entries) {
    await writer.add(name, content === undefined ? undefined : new TextReader(content), entryOptions);
  }
  await writeFile(path, await writer.close());
  return { path, directory };
}

async function readEntries(path, options) {
  const reader = await createBoundedReader(path, options);
  try {
    const results = [];
    for await (const entry of reader.getEntriesGenerator()) {
      results.push({ name: entry.filename, directory: entry.directory, size: entry.uncompressedSize,
        text: await entry.getData(new TextWriter(), {
          ...options, checkCrc32: true, checkAuthenticationCode: true, useWebWorkers: false,
        }) });
    }
    return results;
  } finally { await reader.close(); }
}

test('encrypted ZIP entries are rejected during initialization even after a plain entry', async context => {
  for (const encryption of [{ password: 'public rejection fixture', encryptionStrength: 3 }, { password: 'public rejection fixture', zipCrypto: true }]) {
    const { path, directory } = await fixture(context, {}, [['plain.txt', 'plain'], ['secret.txt', 'unsupported encrypted content', encryption]]);
    await assert.rejects(createBoundedReader(path, { tempDirectory: directory }), /encrypted ZIP entries are not supported/); assert.deepEqual(await readdir(directory), ['archive.zip']);
  }
});

test('reader construction, enumeration and extraction reject removed password options', async context => {
  const { path } = await fixture(context, {}, [['plain.txt', 'plain']]);
  for (const options of [{ password: 'not-supported' }, { rawPassword: new Uint8Array([1]) }, { password: undefined }]) await assert.rejects(createBoundedReader(path, options), /Unsupported ZIP encryption option/);
  const reader = await createBoundedReader(path); try { assert.throws(() => reader.getEntriesGenerator({ password: 'not-supported' }), /Unsupported ZIP encryption option/); for await (const entry of reader.getEntriesGenerator()) { await assert.rejects(entry.getData(new TextWriter(), { password: 'not-supported' }), /Unsupported ZIP encryption option/); await assert.rejects(entry.arrayBuffer({ rawPassword: new Uint8Array([1]) }), /Unsupported ZIP encryption option/); } } finally { await reader.close(); }
});

test('bounded ZIP reader preserves names, directories, empty files and STORE/DEFLATE data', async (context) => {
  for (const zip64 of [false, true]) for (const level of [0, 1]) {
    const { path, directory } = await fixture(context, { zip64, level });
    const entries = await readEntries(path, { tempDirectory: directory });
    assert.deepEqual(entries.map(({ name, directory, text }) => [name, directory, text]), [
      ['folder/', true, ''], ['folder/zażółć-日本語.txt', false, 'Backup test 🙂'], ['empty', false, ''],
    ]);
    assert.deepEqual(await readdir(directory), ['archive.zip']);
  }
});





test('bounded reader accepts an empty archive and cleans temporary index after an early stop', async (context) => {
  const empty = await fixture(context, {}, []);
  assert.deepEqual(await readEntries(empty.path), []);
  const { path, directory } = await fixture(context);
  const reader = await createBoundedReader(path, { tempDirectory: directory });
  try { for await (const entry of reader.getEntriesGenerator()) { assert.ok(entry.filename); break; } }
  finally { await reader.close(); }
  assert.deepEqual(await readdir(directory), ['archive.zip']);
});

test('closing a paused iterator releases its disk index and invalidates yielded entries', async (context) => {
  const { path, directory } = await fixture(context);
  const reader = await createBoundedReader(path, { tempDirectory: directory });
  const iterator = reader.getEntriesGenerator();
  const { value: entry } = await iterator.next();
  await reader.close();
  assert.deepEqual(await readdir(directory), ['archive.zip']);
  await assert.rejects(entry.getData(new TextWriter()), /reader is closed/);
  await assert.rejects(iterator.next(), /reader is closed/);
  await iterator.return();
});

test('bounded reader rejects duplicate decoded names and cleans temporary state', async (context) => {
  const { path, directory } = await fixture(context, {}, [['one', '1'], ['two', '2']]);
  const bytes = await readFile(path);
  // A malicious duplicate cannot be emitted by ZipWriter itself.
  for (let offset = 0; offset < bytes.length - 4; offset++) {
    if (bytes.readUInt32LE(offset) === 0x02014b50 && bytes.subarray(offset + 46, offset + 49).toString() === 'two') {
      bytes.write('one', offset + 46);
      const local = bytes.readUInt32LE(offset + 42);
      bytes.write('one', local + 30);
    }
  }
  await writeFile(path, bytes);
  await assert.rejects(readEntries(path, { tempDirectory: directory }), /duplicate filename/);
  assert.deepEqual(await readdir(directory), ['archive.zip']);
});

test('bounded reader rejects truncated, multi-disk and inconsistent directory metadata', async (context) => {
  const { path } = await fixture(context);
  const original = await readFile(path);
  for (const mutate of [
    (bytes) => bytes.subarray(0, bytes.length - 1),
    (bytes) => { bytes.writeUInt16LE(1, bytes.length - 22 + 4); return bytes; },
    (bytes) => { bytes.writeUInt32LE(0x7fffffff, bytes.length - 22 + 16); return bytes; },
    (bytes) => { bytes.writeUInt32LE(0x7fffffff, bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])) + 42); return bytes; },
    (bytes) => { bytes.writeUInt16LE(1, bytes.length - 22 + 8); return bytes; },
  ]) {
    await writeFile(path, mutate(Buffer.from(original)));
    await assert.rejects(readEntries(path), /Invalid or unsupported ZIP/);
  }
});

test('bounded reader rejects overlapping local records', async (context) => {
  const { path } = await fixture(context, { level: 0 }, [['one', '1'], ['two', '1']]);
  const bytes = await readFile(path);
  const first = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  const second = first + 46 + bytes.readUInt16LE(first + 28) + bytes.readUInt16LE(first + 30) + bytes.readUInt16LE(first + 32);
  bytes.writeUInt32LE(bytes.readUInt32LE(first + 42), second + 42);
  await writeFile(path, bytes);
  await assert.rejects(readEntries(path), /overlapping entry/);
});

test('bounded reader rejects corrupted descriptors and preflights malformed directory extra fields', async (context) => {
  const { path } = await fixture(context, { level: 0 }, [['one', 'one']]);
  const original = await readFile(path);
  const descriptor = original.indexOf(Buffer.from([0x50, 0x4b, 0x07, 0x08]));
  assert.ok(descriptor > 0);
  const badDescriptor = Buffer.from(original);
  badDescriptor[descriptor + 4] ^= 0x80;
  await writeFile(path, badDescriptor);
  let reader = await createBoundedReader(path);
  try { await assert.rejects(reader.getEntriesGenerator().next(), /data descriptor/); }
  finally { await reader.close(); }

  const malformedExtra = Buffer.from(original);
  const central = malformedExtra.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  const extraOffset = central + 46 + malformedExtra.readUInt16LE(central + 28);
  assert.ok(malformedExtra.readUInt16LE(central + 30) >= 4);
  malformedExtra.writeUInt16LE(0x7fff, extraOffset + 2);
  await writeFile(path, malformedExtra);
  await assert.rejects(createBoundedReader(path), /extra field is truncated/);
});

test('bounded reader handles ZIP64 local offsets beyond 4 GiB without reading sparse gaps', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'delta-bounded-reader-large-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'sparse.zip');
  const offset = 0x100000000 + 128;
  const name = Buffer.from('beyond-4gib');
  const local = Buffer.alloc(30 + name.length);
  local.writeUInt32LE(0x04034b50);
  local.writeUInt16LE(45, 4);
  local.writeUInt16LE(name.length, 26);
  name.copy(local, 30);
  const central = Buffer.alloc(46 + name.length + 12);
  central.writeUInt32LE(0x02014b50);
  central.writeUInt16LE(45, 4);
  central.writeUInt16LE(45, 6);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt16LE(12, 30);
  central.writeUInt32LE(0xffffffff, 42);
  name.copy(central, 46);
  central.writeUInt16LE(1, 46 + name.length);
  central.writeUInt16LE(8, 48 + name.length);
  central.writeBigUInt64LE(BigInt(offset), 50 + name.length);
  const cdOffset = offset + local.length;
  const trailer = Buffer.alloc(98);
  trailer.writeUInt32LE(0x06064b50);
  trailer.writeBigUInt64LE(44n, 4);
  trailer.writeUInt16LE(45, 12);
  trailer.writeUInt16LE(45, 14);
  trailer.writeBigUInt64LE(1n, 24);
  trailer.writeBigUInt64LE(1n, 32);
  trailer.writeBigUInt64LE(BigInt(central.length), 40);
  trailer.writeBigUInt64LE(BigInt(cdOffset), 48);
  trailer.writeUInt32LE(0x07064b50, 56);
  trailer.writeBigUInt64LE(BigInt(cdOffset + central.length), 64);
  trailer.writeUInt32LE(1, 72);
  trailer.writeUInt32LE(0x06054b50, 76);
  trailer.writeUInt16LE(0xffff, 84);
  trailer.writeUInt16LE(0xffff, 86);
  trailer.writeUInt32LE(0xffffffff, 88);
  trailer.writeUInt32LE(0xffffffff, 92);
  const handle = await open(path, 'wx');
  try {
    if (process.platform === 'win32') {
      // NTFS needs this flag before writing past EOF; do not allocate 4 GiB.
      const sparse = spawnSync('fsutil', ['sparse', 'setflag', path], { windowsHide: true });
      if (sparse.status !== 0) { context.skip('Sparse files are unavailable on this Windows volume'); return; }
    }
    await handle.write(local, 0, local.length, offset);
    await handle.write(central, 0, central.length, cdOffset);
    await handle.write(trailer, 0, trailer.length, cdOffset + central.length);
  } finally { await handle.close(); }
  assert.deepEqual(await readEntries(path), [{ name: name.toString(), directory: false, size: 0, text: '' }]);
});
