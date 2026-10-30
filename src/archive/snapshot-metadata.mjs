import { open, mkdtemp, lstat, rm, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBoundedReader } from './bounded-reader.mjs';
import { readSnapshotDocument } from './snapshot-document.mjs';

/** Read ordinary ZIP comments only; Delta has no private archive owner markers. */
export async function readArchiveComment(filename, options = {}) {
  options.signal?.throwIfAborted(); const handle = await open(filename, 'r');
  try {
    const info = await handle.stat(), length = Math.min(info.size, 65557), tail = Buffer.alloc(length); await handle.read(tail, 0, length, info.size - length);
    for (let offset = tail.length - 22; offset >= 0; offset--) if (tail.readUInt32LE(offset) === 0x06054b50 && offset + 22 + tail.readUInt16LE(offset + 20) === tail.length) {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(tail.subarray(offset + 22)); return text ? JSON.parse(text) : {};
    }
    throw new Error('ZIP end record is unavailable.');
  } finally { await handle.close(); }
}

/** Locate .snapshot.json through the normal ZIP directory and check its CRC while extracting. */
export async function extractMetadataEntry(filename, outputFilename, options = {}) {
  const name = options.expectedName ?? '.snapshot.json', maxBytes = options.maxBytes ?? Number.MAX_SAFE_INTEGER;
  if (name !== '.snapshot.json' || !Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error('Invalid snapshot extraction options.');
  const reader = await createBoundedReader(filename, options); let output, ownsOutput = false, found = false, bytes = 0; const hash = createHash('sha256');
  try {
    for await (const entry of reader.getEntriesGenerator()) {
      await options.waitIfPaused?.(); options.signal?.throwIfAborted(); if (entry.filename !== name) continue;
      if (found || entry.directory || entry.encrypted || entry.uncompressedSize > maxBytes) throw new Error('Invalid .snapshot.json ZIP entry.'); found = true;
      output = await open(outputFilename, 'wx', 0o600); ownsOutput = true;
      await entry.getData(new WritableStream({ async write(chunk) {
        await options.waitIfPaused?.(); options.signal?.throwIfAborted(); bytes += chunk.length; if (bytes > maxBytes || bytes > entry.uncompressedSize) throw new Error('Snapshot metadata exceeds its declared size.'); hash.update(chunk);
        for (let offset = 0; offset < chunk.length;) { const { bytesWritten } = await output.write(chunk, offset, chunk.length - offset); if (!bytesWritten) throw new Error('Snapshot output stopped accepting bytes.'); offset += bytesWritten; }
      } }), { useWebWorkers: false, checkSignature: true, checkCrc32: true, signal: options.signal });
      if (bytes !== entry.uncompressedSize) throw new Error('Snapshot metadata is truncated.'); await output.sync(); await output.close(); output = undefined;
    }
    if (!found) throw new Error('ZIP archive has no .snapshot.json.');
    ownsOutput = false; return { bytes, sha256: hash.digest('hex'), name };
  } finally { await output?.close(); await reader.close(); if (ownsOutput) await unlink(outputFilename).catch(() => {}); }
}

/** Parse every byte while retaining only the small snapshot header. */
export async function readSnapshotHeader(filename, options = {}) {
  const scratch = await mkdtemp(join(options.cacheDirectory ?? tmpdir(), 'delta-snapshot-header-'));
  try { const output = join(scratch, '.snapshot.json'); await extractMetadataEntry(filename, output, options); return await readSnapshotDocument(output, options); }
  finally { await rm(scratch, { recursive: true, force: true }); }
}
