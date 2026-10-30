import { mkdir, mkdtemp, open, lstat, rm, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ZipWriter } from '@zip.js/zip.js';
import { assertPlainZipOptions } from './plain-options.mjs';

const COPY_BYTES = 64 * 1024;
const MAX_METADATA_BYTES = 256 * 1024;
const UINT16_MAX = 0xffff;
const UINT32_MAX = 0xffffffff;

// Each zip.js instance owns ONE entry. Payload goes straight to the output;
// close() produces a bounded directory record, which is spooled to disk. This
// deliberately uses only its public offset/add/close API: zip.js remains the
// implementation of compression, CRC, entry headers and ZIP64 extra data.
// The only records written here are the standard archive-level end records.
export async function createBoundedArchive(path, options = {}) {
  assertPlainZipOptions(options);
  options.signal?.throwIfAborted();
  const outputPath = resolve(path);
  if (options.createParent !== false) await mkdir(dirname(outputPath), { recursive: true });
  const temporaryDirectory = await mkdtemp(join(dirname(outputPath), '.delta-zip-'));
  const temporaryIdentity = await lstat(temporaryDirectory, { bigint: true });
  let output;
  let outputIdentity;
  let directory;
  let database;
  let names;
  let removeName;
  let position = 0;
  let directorySize = 0;
  let entries = 0;
  let needsZip64 = options.zip64 === true;
  let failure;
  let state = 'open';
  let active;
  let cleanupPromise;
  let removalPromise;
  const diagnostics = {
    maxCapturedDirectoryBytes: 0,
    spoolBytes: 0,
    namesDatabaseCacheBytes: 1024 * 1024,
    copyBufferBytes: COPY_BYTES,
    outputBytes: 0,
    entries: 0,
  };
  const cancellation = new AbortController();
  const archiveSignal = options.signal
    ? AbortSignal.any([options.signal, cancellation.signal]) : cancellation.signal;

  async function cleanup(removeOutput) {
    cleanupPromise ??= (async () => {
      const errors = [];
      try { database?.close(); } catch (error) { errors.push(error); }
      try { await directory?.close(); } catch (error) { errors.push(error); }
      try { await output?.close(); } catch (error) { errors.push(error); }
      try { await removeOwnedDirectory(temporaryDirectory, dirname(outputPath), temporaryIdentity); } catch (error) { errors.push(error); }
      if (errors.length) throw new AggregateError(errors, 'Could not clean up archive resources');
    })();
    const errors = [];
    try { await cleanupPromise; } catch (error) { errors.push(error); }
    if (removeOutput && outputIdentity) {
      removalPromise ??= (async () => {
        try {
          // Do not unlink a pre-existing file or a foreign replacement.
          const current = await lstat(outputPath, { bigint: true });
          if (current.ino === outputIdentity.ino && current.dev === outputIdentity.dev) await unlink(outputPath);
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
      })();
      try { await removalPromise; } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, 'Could not clean up archive resources');
  }

  function markFailed(error) {
    failure ??= error;
    state = 'failed';
    cancellation.abort(failure);
    return failure;
  }

  async function fail(error) {
    const original = markFailed(error);
    try { await cleanup(true); } catch (cleanupError) {
      throw new AggregateError([original, cleanupError], 'Archive failed and cleanup was incomplete');
    }
    throw original;
  }

  function checkOpen() {
    if (failure) throw failure;
    if (state !== 'open') throw new Error('Archive is already closed');
    archiveSignal.throwIfAborted();
  }

  try {
    output = await open(outputPath, 'wx');
    outputIdentity = await output.stat({ bigint: true });
    directory = await open(join(temporaryDirectory, 'central-directory'), 'wx+');
    database = new DatabaseSync(join(temporaryDirectory, 'names.sqlite'));
    database.exec(`
      PRAGMA journal_mode=OFF;
      PRAGMA synchronous=OFF;
      PRAGMA cache_size=-1024;
      PRAGMA mmap_size=0;
      PRAGMA temp_store=FILE;
      PRAGMA cache_spill=ON;
      CREATE TABLE names (name BLOB PRIMARY KEY) WITHOUT ROWID;
      BEGIN;
    `);
    names = database.prepare('INSERT INTO names(name) VALUES (?)');
    removeName = database.prepare('DELETE FROM names WHERE name = ?');
    checkOpen();
  } catch (error) {
    return fail(error);
  }

  async function add(name, reader, entryOptions = {}) {
    let signal;
    let input;
    const startPosition = position;
    let nameBytes;
    let reserved = false;
    let capturing = false;
    let acceptingWrites = true;
    let outputWrite;
    let outputFailed = false;
    let spoolStarted = false;
    try {
      checkOpen();
      await options.waitIfPaused?.();
      checkOpen();
      assertPlainZipOptions(entryOptions);
      signal = entryOptions.signal ? AbortSignal.any([archiveSignal, entryOptions.signal]) : archiveSignal;
      signal.throwIfAborted();
      if (typeof name !== 'string' || !name.isWellFormed()) throw new TypeError('Entry name must be a well-formed string');
      if (entryOptions.directory && !name.endsWith('/')) name += '/';
      nameBytes = Buffer.from(name, 'utf8');
      if (nameBytes.length > UINT16_MAX) throw new Error('Entry name exceeds the ZIP filename limit');
      try { names.run(nameBytes); reserved = true; } catch (error) {
        if (error.errcode === 1555 || error.errcode === 2067) throw new Error(`Duplicate ZIP entry: ${name}`);
        throw error;
      }

      let metadataSize = 0;
      const metadata = [];
      const sink = new WritableStream({
        async write(chunk) {
          if (!acceptingWrites) throw new Error('ZIP entry is no longer accepting output');
          await options.waitIfPaused?.();
          signal.throwIfAborted();
          if (!acceptingWrites) throw new Error('ZIP entry is no longer accepting output');
          if (capturing) {
            metadataSize += chunk.length;
            diagnostics.maxCapturedDirectoryBytes = Math.max(diagnostics.maxCapturedDirectoryBytes, metadataSize);
            if (metadataSize > MAX_METADATA_BYTES) throw new Error('Single-entry ZIP metadata exceeded its bounded limit');
            metadata.push(Buffer.from(chunk));
          } else {
            outputWrite = (async () => {
              try {
                await writeAll(output, chunk, position);
                position = safeSum(position, chunk.length);
                diagnostics.outputBytes = position;
              } catch (error) { outputFailed = true; throw error; }
            })();
            await outputWrite;
          }
        },
      }, { highWaterMark: 1 });
      const single = new ZipWriter(sink, {
        level: options.level ?? 1,
        zip64: options.zip64,
        offset: position,
        useWebWorkers: false,
        bufferedWrite: false,
        dataDescriptor: true,
        dataDescriptorSignature: true,
        keepOrder: true,
        useUnicodeFileNames: true,
      });
      if (reader && !entryOptions.directory) { input = await cancellableReader(reader, signal); reader = input; }
      const entry = await single.add(name, reader, {
        ...entryOptions,
        // These are invariants, even when a caller provides conflicting options.
        signal,
        useWebWorkers: false,
        bufferedWrite: false,
        dataDescriptor: true,
        dataDescriptorSignature: true,
        keepOrder: true,
        useUnicodeFileNames: true,
        encodeText: undefined,
        passThrough: false,
        entry: undefined,
      });
      signal.throwIfAborted();
      capturing = true;
      await single.close();
      signal.throwIfAborted();
      const record = extractDirectoryRecord(Buffer.concat(metadata, metadataSize));
      spoolStarted = true;
      await writeAll(directory, record);
      directorySize = safeSum(directorySize, record.length);
      entries = safeSum(entries, 1);
      diagnostics.spoolBytes = directorySize;
      diagnostics.entries = entries;
      needsZip64 ||= record.readUInt32LE(20) === UINT32_MAX || record.readUInt32LE(24) === UINT32_MAX || record.readUInt32LE(42) === UINT32_MAX;
      // A caller may persist this one bounded record as a direct metadata
      // locator. The writer itself retains no per-entry record or entry array.
      entry.centralDirectoryRecord = Buffer.from(record);
      return entry;
    } catch (error) {
      acceptingWrites = false;
      await outputWrite?.catch(() => {});
      try { await input?.readable.cancel(error); } catch { /* The abort handler also cancels an owned locked input. */ }
      if (options.recoverSourceErrors === true && error?.sourceReadError === true && state === 'open' && reserved && !capturing && !spoolStarted && !outputFailed && !signal?.aborted && !archiveSignal.aborted) {
        try {
          // Only the unfinished local entry exists. No central-directory record
          // was appended, so preceding entries and their offsets remain intact.
          await output.truncate(startPosition);
          removeName.run(nameBytes);
          position = startPosition;
          diagnostics.outputBytes = position;
          error.sourceReadErrorRecovered = true;
        } catch (rollbackError) { return fail(new AggregateError([error, rollbackError], 'Could not discard the unreadable ZIP entry')); }
        throw error;
      }
      return fail(error);
    }
  }

  async function finish(closeOptions = {}) {
    try {
      checkOpen();
      assertPlainZipOptions(closeOptions);
      if (!closeOptions || typeof closeOptions !== 'object' || Array.isArray(closeOptions) || Object.keys(closeOptions).some(key => key !== 'comment')) throw new TypeError('Archive close options may contain only a ZIP comment');
      let comment = closeOptions.comment ?? new Uint8Array();
      if (typeof comment === 'string') { if (!comment.isWellFormed()) throw new TypeError('ZIP comment must be a well-formed string'); comment = Buffer.from(comment, 'utf8'); }
      else if (comment instanceof Uint8Array) comment = Buffer.from(comment);
      else throw new TypeError('ZIP comment must be a string or Uint8Array');
      if (comment.length > UINT16_MAX) throw new Error('ZIP comment exceeds its 65535-byte limit');
      const directoryOffset = position;
      const zip64 = needsZip64 || directoryOffset >= UINT32_MAX || directorySize >= UINT32_MAX || entries >= UINT16_MAX;
      if (zip64 && options.zip64 === false) throw new Error('Archive requires ZIP64');
      const buffer = Buffer.allocUnsafe(COPY_BYTES);
      let copied = 0;
      while (copied < directorySize) {
        await options.waitIfPaused?.();
        archiveSignal.throwIfAborted();
        const length = Math.min(buffer.length, directorySize - copied);
        const { bytesRead } = await directory.read(buffer, 0, length, copied);
        if (!bytesRead) throw new Error('Unexpected end of central-directory spool');
        await writeAll(output, buffer.subarray(0, bytesRead), safeSum(directoryOffset, copied));
        copied += bytesRead;
      }
      await options.waitIfPaused?.();
      archiveSignal.throwIfAborted();
      const trailer = endOfDirectory(entries, directorySize, directoryOffset, zip64, comment);
      await writeAll(output, trailer, safeSum(directoryOffset, directorySize));
      diagnostics.outputBytes = safeSum(safeSum(directoryOffset, directorySize), trailer.length);
      await output.sync();
      archiveSignal.throwIfAborted();
      await cleanup(false);
      archiveSignal.throwIfAborted();
      state = 'closed';
    } catch (error) { return fail(error); }
  }

  // Reject concurrent calls rather than silently queueing potentially millions
  // of promises/readers. Invalid concurrent use also cancels the active write.
  function sequential(operation) {
    if (state === 'closed') return Promise.reject(new Error('Archive is already closed'));
    if (active) {
      const error = markFailed(new Error('Archive writes are strictly sequential; await each add() before the next operation'));
      return Promise.reject(error);
    }
    const promise = operation();
    active = promise;
    promise.finally(() => { if (active === promise) active = undefined; }).catch(() => {});
    return promise;
  }

  return {
    writer: {
      add(name, reader, entryOptions) { return sequential(() => add(name, reader, entryOptions)); },
      close(closeOptions) { return state === 'closed' ? Promise.resolve() : sequential(() => finish(closeOptions)); },
    },
    get diagnostics() { return { ...diagnostics }; },
    async closeHandle() {
      if (state === 'closed') return;
      markFailed(failure ?? new Error('Archive was disposed before successful close()'));
      await active?.catch(() => {});
      await cleanup(true);
    },
  };
}

async function cancellableReader(source, signal) {
  if (typeof source.init === 'function' && !source.initialized) await source.init();
  signal.throwIfAborted(); const reader = (source.readable ?? source).getReader(); let released = false;
  const release = () => { if (!released) { released = true; signal.removeEventListener('abort', abort); reader.releaseLock(); } };
  const abort = () => { void reader.cancel(signal.reason).catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  return { size: source.size, readable: new ReadableStream({
    async pull(controller) { try { const next = await reader.read(); signal.throwIfAborted(); if (next.done) { release(); controller.close(); } else controller.enqueue(next.value); } catch (error) { release(); controller.error(error); } },
    async cancel(reason) { try { await reader.cancel(reason); } finally { release(); } },
  }, { highWaterMark: 1 }) };
}

async function writeAll(handle, data, position = null) {
  let offset = 0;
  while (offset < data.length) {
    const { bytesWritten } = await handle.write(data, offset, data.length - offset, position === null ? null : safeSum(position, offset));
    if (!bytesWritten) throw new Error('Archive output stopped accepting bytes');
    offset += bytesWritten;
  }
}

function safeSum(left, right) {
  const value = left + right;
  if (!Number.isSafeInteger(value)) throw new Error('Archive exceeds the supported exact offset range');
  return value;
}

async function removeOwnedDirectory(path, parent, identity) {
  const child = relative(parent, resolve(path));
  if (!child || isAbsolute(child) || child.startsWith('..') || dirname(resolve(path)) !== parent || !basename(path).startsWith('.delta-zip-')) {
    throw new Error('Refusing to remove a temporary directory outside the archive directory');
  }
  let current;
  try { current = await lstat(path, { bigint: true }); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== identity.dev || current.ino !== identity.ino) {
    throw new Error('Refusing to remove a foreign replacement of the archive temporary directory');
  }
  await rm(path, { recursive: true, force: true });
}

function extractDirectoryRecord(data) {
  if (data.length < 46 || data.readUInt32LE(0) !== 0x02014b50) throw new Error('Missing single-entry ZIP central directory');
  const length = 46 + data.readUInt16LE(28) + data.readUInt16LE(30) + data.readUInt16LE(32);
  if (length + 22 > data.length) throw new Error('Incomplete ZIP central directory');
  const trailerSignature = data.readUInt32LE(length);
  const trailerLength = trailerSignature === 0x06064b50 ? 98 : trailerSignature === 0x06054b50 ? 22 : 0;
  if (!trailerLength || length + trailerLength !== data.length) throw new Error('Unexpected single-entry ZIP trailer');
  return data.subarray(0, length);
}

function endOfDirectory(entries, directorySize, directoryOffset, zip64, comment) {
  const data = Buffer.alloc((zip64 ? 98 : 22) + comment.length);
  let offset = 0;
  const u16 = (value) => { data.writeUInt16LE(value, offset); offset += 2; };
  const u32 = (value) => { data.writeUInt32LE(value, offset); offset += 4; };
  const u64 = (value) => { data.writeBigUInt64LE(BigInt(value), offset); offset += 8; };
  if (zip64) {
    u32(0x06064b50); u64(44); u16(45); u16(45); u32(0); u32(0);
    u64(entries); u64(entries); u64(directorySize); u64(directoryOffset);
    u32(0x07064b50); u32(0); u64(safeSum(directoryOffset, directorySize)); u32(1);
  }
  u32(0x06054b50); u16(0); u16(0);
  u16(zip64 ? UINT16_MAX : entries); u16(zip64 ? UINT16_MAX : entries);
  u32(zip64 ? UINT32_MAX : directorySize); u32(zip64 ? UINT32_MAX : directoryOffset); u16(comment.length);
  comment.copy(data, offset);
  return data;
}
