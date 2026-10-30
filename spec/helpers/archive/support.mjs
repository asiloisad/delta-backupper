import { createHash } from 'node:crypto';
import { access, mkdir, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { Reader, ZipReader, ZipWriter, configure } from '@zip.js/zip.js';

export const CHUNK_BYTES = 64 * 1024;

// Archive fixtures use sequential writes with bounded buffering.
// bufferedWrite:false and data descriptors prevent whole-entry buffering.
configure({ useWebWorkers: false, chunkSize: CHUNK_BYTES });

export class FileReader extends Reader {
  constructor(path) {
    super();
    this.path = path;
  }

  async init() {
    this.handle = await open(this.path, 'r');
    this.size = (await this.handle.stat()).size;
    super.init();
  }

  async readUint8Array(offset, length) {
    const buffer = Buffer.allocUnsafe(Math.min(length, this.size - offset));
    const { bytesRead } = await this.handle.read(buffer, 0, buffer.length, offset);
    return buffer.subarray(0, bytesRead);
  }

  async close() {
    await this.handle?.close();
  }
}

export async function createArchive(path, options = {}) {
  const { level = 1, zip64 } = options;
  await mkdir(dirname(path), { recursive: true });
  const handle = await open(path, 'wx');
  let closed = false;
  const close = async () => {
    if (!closed) {
      closed = true;
      await handle.close();
    }
  };
  const sink = new WritableStream({
    async write(chunk) {
      let offset = 0;
      while (offset < chunk.length) {
        const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset);
        if (!bytesWritten) throw new Error('Archive output stopped accepting bytes');
        offset += bytesWritten;
      }
    },
    async close() {
      await handle.sync();
      await close();
    },
    abort: close,
  }, { highWaterMark: 1 });
  return {
    writer: new ZipWriter(sink, {
      zip64,
      level,
      useWebWorkers: false,
      bufferedWrite: false,
      dataDescriptor: true,
      dataDescriptorSignature: true,
      useUnicodeFileNames: true,
    }),
    closeHandle: close,
  };
}

export function generatedSource(size, { onChunk } = {}) {
  if (!Number.isSafeInteger(size) || size < 0) throw new Error('Invalid generated source size');
  const hash = createHash('sha256');
  // Repeated deterministic bytes avoid needing a multi-GiB source fixture.
  const pattern = Buffer.alloc(CHUNK_BYTES);
  for (let index = 0; index < pattern.length; index++) pattern[index] = index % 251;
  let produced = 0;
  let cancelled = false;
  const stream = new ReadableStream({
    pull(controller) {
      if (produced === size) {
        controller.close();
        return;
      }
      const chunk = pattern.subarray(0, Math.min(CHUNK_BYTES, size - produced));
      hash.update(chunk);
      produced += chunk.length;
      controller.enqueue(chunk);
      onChunk?.(produced);
    },
    cancel() { cancelled = true; },
  }, { highWaterMark: 1 });
  return {
    stream,
    get produced() { return produced; },
    get cancelled() { return cancelled; },
    digest() { return hash.digest('hex'); },
  };
}

export function hashingSink() {
  const hash = createHash('sha256');
  let bytes = 0;
  return {
    writable: new WritableStream({
      write(chunk) { bytes += chunk.length; hash.update(chunk); },
    }, { highWaterMark: 1 }),
    result() { return { bytes, sha256: hash.digest('hex') }; },
  };
}

export async function withArchive(path, callback) {
  const file = new FileReader(path);
  const reader = new ZipReader(file, { useWebWorkers: false });
  try {
    return await callback(reader);
  } finally {
    await reader.close();
    await file.close();
  }
}

export async function readEntryHash(entry) {
  if (arguments.length !== 1) throw new Error('Unsupported archive extraction probe argument');
  const sink = hashingSink();
  await entry.getData(sink.writable, {
    checkCrc32: true, useWebWorkers: false,
  });
  return sink.result();
}

export async function inspectTrailer(path) {
  const handle = await open(path, 'r');
  try {
    const size = (await handle.stat()).size;
    const length = Math.min(size, 128 * 1024);
    const data = Buffer.alloc(length);
    await handle.read(data, 0, length, size - length);
    return {
      bytes: size,
      zip64End: data.includes(Buffer.from([0x50, 0x4b, 0x06, 0x06])),
      zip64Locator: data.includes(Buffer.from([0x50, 0x4b, 0x06, 0x07])),
    };
  } finally { await handle.close(); }
}

export async function find7zip() {
  const candidates = [
    process.env.DELTA_PROBE_7ZIP,
    process.platform === 'win32' ? 'C:\\Program Files\\7-Zip\\7z.exe' : undefined,
    ...((process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':').flatMap((path) =>
      (process.platform === 'win32' ? ['7z.exe', '7zz.exe'] : ['7zz', '7z']).map((name) => join(path, name)))),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try { await access(candidate, constants.X_OK); return candidate; } catch { /* Try the next tool. */ }
  }
  return undefined;
}

export async function external7zip(tool, archive, options = {}) {
  if (Object.keys(options).some(key => !['entry', 'test'].includes(key))) throw new Error('Unsupported external archive probe option');
  const { entry, test = false } = options;
  const args = [test ? 't' : 'x', '-bd', '-y', '-bb0', ...(test ? [] : ['-so']),
    archive, ...(entry ? [entry] : [])];
  const child = spawn(tool, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const hash = createHash('sha256');
  let bytes = 0;
  let output = '';
  child.stdout.on('data', (data) => {
    if (test) output += data.toString().slice(0, Math.max(0, 16 * 1024 - output.length));
    else { bytes += data.length; hash.update(data); }
  });
  child.stderr.on('data', (data) => { output += data.toString().slice(0, Math.max(0, 16 * 1024 - output.length)); });
  const exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  return { exitCode, bytes, ...(test ? {} : { sha256: hash.digest('hex') }), output };
}
