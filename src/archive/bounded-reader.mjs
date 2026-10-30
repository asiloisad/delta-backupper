import { open, mkdtemp, lstat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Reader, ZipReader } from '@zip.js/zip.js';
import { assertPlainZipOptions } from './plain-options.mjs';

const EOCD = 0x06054b50;
const ZIP64_EOCD = 0x06064b50;
const ZIP64_LOCATOR = 0x07064b50;
const CENTRAL_HEADER = 0x02014b50;
const LOCAL_HEADER = 0x04034b50;
const DIGITAL_SIGNATURE = 0x05054b50;
const MAX16 = 0xffff;
const MAX32 = 0xffffffff;
const MAX64 = BigInt(Number.MAX_SAFE_INTEGER);

function invalid(reason) { return new Error(`Invalid or unsupported ZIP: ${reason}`); }

function uint64(buffer, offset) {
  const value = buffer.readBigUInt64LE(offset);
  if (value > MAX64) throw invalid('64-bit value exceeds the supported safe integer range');
  return Number(value);
}

function range(offset, length, size) {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset > size - length) {
    throw invalid('record or payload is outside the archive bounds');
  }
}

async function readExact(handle, offset, length, size) {
  range(offset, length, size);
  const data = Buffer.allocUnsafe(length);
  let read = 0;
  while (read < length) {
    const { bytesRead } = await handle.read(data, read, length - read, offset + read);
    if (!bytesRead) throw invalid('archive was truncated while reading');
    read += bytesRead;
  }
  return data;
}

async function readDirectoryLocation(handle, size) {
  if (size < 22) throw invalid('end of central directory not found');
  // APPNOTE's maximum comment is 65535 bytes. Never read a whole directory.
  const tailLength = Math.min(size, 22 + MAX16);
  const tailOffset = size - tailLength;
  const tail = await readExact(handle, tailOffset, tailLength, size);
  let end;
  for (let index = tail.length - 22; index >= 0; index--) {
    if (tail.readUInt32LE(index) === EOCD && index + 22 + tail.readUInt16LE(index + 20) === tail.length) {
      if (end !== undefined) throw invalid('ambiguous end of central directory');
      end = index;
    }
  }
  if (end === undefined) throw invalid('end of central directory not found or trailing bytes present');
  const eocdOffset = tailOffset + end;
  const eocd = tail.subarray(end, end + 22);
  const disk = eocd.readUInt16LE(4);
  const directoryDisk = eocd.readUInt16LE(6);
  if ((disk !== 0 && disk !== MAX16) || (directoryDisk !== 0 && directoryDisk !== MAX16)) throw invalid('multi-disk archives are not supported');
  const countOnDisk = eocd.readUInt16LE(8);
  const count = eocd.readUInt16LE(10);
  const size32 = eocd.readUInt32LE(12);
  const offset32 = eocd.readUInt32LE(16);
  const requires64 = count === MAX16 || countOnDisk === MAX16 || size32 === MAX32 || offset32 === MAX32 || disk === MAX16 || directoryDisk === MAX16;
  const locator = eocdOffset >= 20 ? await readExact(handle, eocdOffset - 20, 20, size) : undefined;
  const has64 = locator?.readUInt32LE(0) === ZIP64_LOCATOR;
  let directoryOffset = offset32;
  let directorySize = size32;
  let entryCount = count;
  let directoryEnd = eocdOffset;
  if (requires64 && !has64) throw invalid('ZIP64 locator is missing');
  if (has64) {
    if (locator.readUInt32LE(4) !== 0 || locator.readUInt32LE(16) !== 1) throw invalid('multi-disk ZIP64 archives are not supported');
    const offset = uint64(locator, 8);
    const record = await readExact(handle, offset, 56, size);
    if (record.readUInt32LE(0) !== ZIP64_EOCD) throw invalid('ZIP64 end record is missing');
    if (uint64(record, 4) !== 44) throw invalid('ZIP64 directory extensions and encrypted directories are not supported');
    if (offset + 56 !== eocdOffset - 20) throw invalid('ZIP64 end records do not form a contiguous trailer');
    if (record.readUInt32LE(16) !== 0 || record.readUInt32LE(20) !== 0) throw invalid('multi-disk ZIP64 archives are not supported');
    entryCount = uint64(record, 32);
    if (uint64(record, 24) !== entryCount) throw invalid('ZIP64 entry counts disagree');
    directorySize = uint64(record, 40);
    directoryOffset = uint64(record, 48);
    if ((count !== MAX16 && count !== entryCount) || (countOnDisk !== MAX16 && countOnDisk !== entryCount) ||
      (size32 !== MAX32 && size32 !== directorySize) || (offset32 !== MAX32 && offset32 !== directoryOffset)) {
      throw invalid('ZIP64 and ordinary end records disagree');
    }
    directoryEnd = offset;
  } else if (countOnDisk !== count) throw invalid('entry counts disagree');
  range(directoryOffset, directorySize, size);
  if (directoryOffset + directorySize !== directoryEnd) throw invalid('central directory bounds disagree with the trailer');
  if (entryCount > Math.floor(directorySize / 46)) throw invalid('entry count exceeds the directory bounds');
  return { directoryOffset, directorySize, entryCount };
}

function singleEntryTrailer(record, directoryOffset) {
  const result = Buffer.alloc(record.length + 98);
  record.copy(result);
  const end = record.length;
  result.writeUInt32LE(ZIP64_EOCD, end);
  result.writeBigUInt64LE(44n, end + 4);
  result.writeUInt16LE(45, end + 12);
  result.writeUInt16LE(45, end + 14);
  result.writeBigUInt64LE(1n, end + 24);
  result.writeBigUInt64LE(1n, end + 32);
  result.writeBigUInt64LE(BigInt(record.length), end + 40);
  result.writeBigUInt64LE(BigInt(directoryOffset), end + 48);
  result.writeUInt32LE(ZIP64_LOCATOR, end + 56);
  result.writeBigUInt64LE(BigInt(directoryOffset + record.length), end + 64);
  result.writeUInt32LE(1, end + 72);
  result.writeUInt32LE(EOCD, end + 76);
  result.writeUInt16LE(MAX16, end + 84);
  result.writeUInt16LE(MAX16, end + 86);
  result.writeUInt32LE(MAX32, end + 88);
  result.writeUInt32LE(MAX32, end + 92);
  return result;
}

async function dataDescriptorLength(handle, entry, payloadEnd, directoryOffset, size) {
  const length = Math.min(24, directoryOffset - payloadEnd);
  const bytes = await readExact(handle, payloadEnd, length, size);
  const preferred64 = Boolean(entry.extraFieldZip64);
  for (const zip64 of [preferred64, !preferred64]) for (const signature of [true, false]) {
    const prefix = signature ? 4 : 0;
    const recordLength = prefix + (zip64 ? 20 : 12);
    if (bytes.length < recordLength || (signature && bytes.readUInt32LE(0) !== 0x08074b50)) continue;
    // AE-2 deliberately clears crc32 in zip.js; its on-disk CRC is zero.
    if (bytes.readUInt32LE(prefix) !== (entry.crc32 ?? 0)) continue;
    let compressed;
    let uncompressed;
    if (zip64) {
      // Comparison as BigInt also avoids accepting unsafe descriptor values.
      compressed = bytes.readBigUInt64LE(prefix + 4);
      uncompressed = bytes.readBigUInt64LE(prefix + 12);
    } else {
      compressed = BigInt(bytes.readUInt32LE(prefix + 4));
      uncompressed = BigInt(bytes.readUInt32LE(prefix + 8));
    }
    if (compressed === BigInt(entry.compressedSize) && uncompressed === BigInt(entry.uncompressedSize)) return recordLength;
  }
  throw invalid(`missing or inconsistent data descriptor: ${entry.filename}`);
}

class SingleEntryReader extends Reader {
  constructor(owner, record) {
    super();
    this.owner = owner;
    this.base = owner.location.directoryOffset;
    this.trailer = singleEntryTrailer(record, this.base);
    this.size = this.base + this.trailer.length;
  }

  async readUint8Array(offset, length) {
    this.owner.assertOpen();
    range(offset, length, this.size);
    if (offset >= this.base) return this.trailer.subarray(offset - this.base, offset - this.base + length);
    if (offset + length <= this.base) return readExact(this.owner.handle, offset, length, this.owner.size);
    // zip.js probes a bounded tail to locate EOCD. Its synthetic image has no
    // useful prefix in that probe; avoid rereading up to 64 KiB per small entry.
    // Payload reads never cross this boundary (validated before entry.getData).
    // Enumeration is sequential. The parser finishes using this probe before
    // yielding its entry, so the next view may reuse the same bounded buffer.
    // Allocating a new 64 KiB probe for every tiny entry causes GBs of churn.
    if (length > 22 + MAX16) throw invalid('unexpected unbounded virtual directory probe');
    const result = this.owner.tailScratch.subarray(0, length);
    result.fill(0);
    this.trailer.copy(result, this.base - offset, 0, offset + length - this.base);
    return result;
  }
}

/**
 * Reads one central-directory record at a time, with disk-backed global name
 * and payload-range validation. The yielded entries use public zip.js APIs for
 * decompression and CRC checks. Do not accumulate yielded entries
 * when bounded memory is required. All entries become unusable after close().
 */
export class BoundedZipReader {
  constructor(path, { tempDirectory = tmpdir(), ...options } = {}) {
    this.path = path;
    this.tempDirectory = resolve(tempDirectory);
    assertPlainZipOptions(options); this.options = { ...options };
    this.closed = false;
    this.enumerating = false;
    this.tailScratch = Buffer.alloc(22 + MAX16);
  }

  async init() {
    this.assertOpen();
    if (this.handle) return;
    try {
      this.handle = await open(this.path, 'r');
      this.size = (await this.handle.stat()).size;
      if (!Number.isSafeInteger(this.size)) throw invalid('archive size exceeds the supported safe integer range');
      this.location = await readDirectoryLocation(this.handle, this.size);
      let offset = this.location.directoryOffset;
      for (let index = 0; index < this.location.entryCount; index++) {
        this.options.signal?.throwIfAborted();
        const header = await readExact(this.handle, offset, 46, this.size);
        if (header.readUInt32LE(0) !== CENTRAL_HEADER) throw invalid('central directory header is missing');
        const length = 46 + header.readUInt16LE(28) + header.readUInt16LE(30) + header.readUInt16LE(32);
        if (offset + length > this.location.directoryOffset + this.location.directorySize) throw invalid('central directory record is truncated');
        if ((header.readUInt16LE(8) & 0x2041) || header.readUInt16LE(10) === 99) throw invalid('encrypted ZIP entries are not supported');
        const extraLength = header.readUInt16LE(30);
        if (extraLength) { const extra = await readExact(this.handle, offset + 46 + header.readUInt16LE(28), extraLength, this.size); for (let field = 0; field < extra.length;) { if (field + 4 > extra.length) throw invalid('central directory extra field is truncated'); const tag = extra.readUInt16LE(field), size = extra.readUInt16LE(field + 2); if (field + 4 + size > extra.length) throw invalid('central directory extra field is truncated'); if (tag === 0x9901) throw invalid('encrypted ZIP entries are not supported'); field += 4 + size; } }
        offset += length;
      }
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  assertOpen() {
    if (this.closed) throw new Error('ZIP reader is closed');
  }

  getEntriesGenerator(options = {}) {
    assertPlainZipOptions(options); return this.iterateEntries({ ...this.options, ...options });
  }

  async *iterateEntries(options) {
    await this.init();
    if (this.enumerating) throw new Error('Concurrent ZIP enumeration is not supported');
    this.enumerating = true;
    let work;
    let workIdentity;
    let index;
    let cleanupPromise;
    const cleanup = () => cleanupPromise ??= (async () => {
      const errors = [];
      try { index?.close(); } catch (error) { errors.push(error); }
      index = undefined;
      try {
        if (work) {
          // Delete only our original directory, never a replacement or link.
          if (dirname(work) !== this.tempDirectory || !basename(work).startsWith('delta-zip-reader-')) throw new Error('Unsafe ZIP temporary directory cleanup');
          const current = await lstat(work, { bigint: true });
          if (!current.isDirectory() || current.isSymbolicLink() || !workIdentity ||
            current.dev !== workIdentity.dev || current.ino !== workIdentity.ino) {
            throw new Error('ZIP temporary directory identity changed; refusing cleanup');
          }
          await rm(work, { recursive: true, force: true });
        }
      } catch (error) { errors.push(error); }
      if (errors.length) throw new AggregateError(errors, 'ZIP reader temporary resource cleanup failed');
    })();
    try {
      work = await mkdtemp(join(this.tempDirectory, 'delta-zip-reader-'));
      workIdentity = await lstat(work, { bigint: true });
      this.assertOpen();
      index = new DatabaseSync(join(work, 'validation.sqlite'));
      index.exec('PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA temp_store=FILE; PRAGMA cache_size=-8192; PRAGMA mmap_size=0; CREATE TABLE names (name TEXT PRIMARY KEY) WITHOUT ROWID; CREATE TABLE ranges (start INTEGER PRIMARY KEY, end INTEGER NOT NULL); BEGIN');
      this.activeCleanup = cleanup;
      const insertName = index.prepare('INSERT INTO names VALUES (?)');
      const before = index.prepare('SELECT end FROM ranges WHERE start <= ? ORDER BY start DESC LIMIT 1');
      const after = index.prepare('SELECT start FROM ranges WHERE start >= ? ORDER BY start LIMIT 1');
      const insertRange = index.prepare('INSERT INTO ranges VALUES (?, ?)');
      const { directoryOffset, directorySize, entryCount } = this.location;
      let offset = directoryOffset;
      const directoryEnd = directoryOffset + directorySize;
      for (let position = 0; position < entryCount; position++) {
        this.assertOpen();
        options.signal?.throwIfAborted();
        if (directoryEnd - offset < 46) throw invalid('central directory header is truncated');
        const header = await readExact(this.handle, offset, 46, this.size);
        if (header.readUInt32LE(0) !== CENTRAL_HEADER) throw invalid('central directory header is missing');
        const length = 46 + header.readUInt16LE(28) + header.readUInt16LE(30) + header.readUInt16LE(32);
        if (length > directoryEnd - offset) throw invalid('central directory record is truncated');
        const record = Buffer.allocUnsafe(length);
        header.copy(record);
        if (length > 46) (await readExact(this.handle, offset + 46, length - 46, this.size)).copy(record, 46);
        const virtual = new ZipReader(new SingleEntryReader(this, record), {
          ...this.options, ...options, useWebWorkers: false,
          // A single-entry image deliberately omits other preceding entries.
          strictness: 'balanced', checkLocalDirectory: true, checkLocalFilename: true,
        });
        const generator = virtual.getEntriesGenerator();
        let entry;
        try {
          ({ value: entry } = await generator.next());
          await generator.next();
        } finally {
          await generator.return();
          await virtual.close();
        }
        this.assertOpen();
        if (!entry || entry.diskNumberStart !== 0) throw invalid('multi-disk entry is not supported');
        // A view containing only a later entry necessarily has preceding data.
        // Every other zip.js directory warning is relevant to the real record.
        if (virtual.warnings.some((warning) => warning.reason !== 'prepended data')) {
          throw invalid(`central directory warnings for ${entry.filename}: ${virtual.warnings.map((warning) => warning.reason).join(', ')}`);
        }
        try { insertName.run(entry.filename); } catch (error) {
          if (error.code === 'ERR_SQLITE_ERROR' && error.errcode === 1555) throw invalid(`duplicate filename: ${entry.filename}`);
          throw error;
        }
        range(entry.offset, 30, directoryOffset);
        const local = await readExact(this.handle, entry.offset, 30, this.size);
        if (local.readUInt32LE(0) !== LOCAL_HEADER) throw invalid('local file header is missing');
        const payloadOffset = entry.offset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
        range(payloadOffset, entry.compressedSize, directoryOffset);
        let end = payloadOffset + entry.compressedSize;
        if (entry.bitFlag.dataDescriptor || (local.readUInt16LE(6) & 8)) {
          end += await dataDescriptorLength(this.handle, entry, end, directoryOffset, this.size);
        }
        this.assertOpen();
        if ((before.get(entry.offset)?.end ?? -1) > entry.offset || (after.get(entry.offset)?.start ?? Infinity) < end) {
          throw invalid(`overlapping entry: ${entry.filename}`);
        }
        insertRange.run(entry.offset, end);
        entry.index = position;
        const getData = entry.getData;
        entry.getData = async (writer, entryOptions = {}) => {
          this.assertOpen();
          assertPlainZipOptions(entryOptions); return getData(writer, entryOptions);
        };
        const arrayBuffer = entry.arrayBuffer;
        entry.arrayBuffer = async (entryOptions = {}) => {
          this.assertOpen();
          assertPlainZipOptions(entryOptions); return arrayBuffer(entryOptions);
        };
        yield entry;
        if (options.onprogress) await options.onprogress(position + 1, entryCount, entry);
        offset += length;
      }
      if (offset !== directoryEnd) {
        // A bounded optional APPNOTE digital-signature record may follow CD.
        if (directoryEnd - offset < 6) throw invalid('unexpected central directory trailing data');
        const signature = await readExact(this.handle, offset, 6, this.size);
        if (signature.readUInt32LE(0) !== DIGITAL_SIGNATURE || offset + 6 + signature.readUInt16LE(4) !== directoryEnd) {
          throw invalid('unexpected central directory trailing data');
        }
      }
    } finally {
      try { await cleanup(); }
      finally {
        if (this.activeCleanup === cleanup) this.activeCleanup = undefined;
        this.enumerating = false;
      }
    }
  }

  async close() {
    if (!this.closed) {
      this.closed = true;
      const errors = [];
      try { await this.activeCleanup?.(); } catch (error) { errors.push(error); }
      try { await this.handle?.close(); } catch (error) { errors.push(error); }
      if (errors.length) throw new AggregateError(errors, 'ZIP reader cleanup failed');
    }
  }
}

export async function createBoundedReader(path, options) {
  const reader = new BoundedZipReader(path, options);
  await reader.init();
  return reader;
}
