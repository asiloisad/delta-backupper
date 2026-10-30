import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { parser } from 'stream-json';
import Assembler from 'stream-json/assembler.js';

const HEADER_FIELDS = ['time', 'ends', 'comp', 'full', 'size', 'sizx'];
const WIRE_HEADER = { time: 'startedAt', ends: 'finishedAt', comp: 'compressionLevel', full: 'full', size: 'totalBytes', sizx: 'storedBytes' };
const WIRE_MAPS = { data: 'files', lock: 'archivedFiles', errs: 'errors' };
const HEADER_LIMIT = 16 * 1024 ** 2, RECORD_LIMIT = 1024 ** 2, MAX_DEPTH = 128, CHUNK_SIZE = 64 * 1024;
const plain = value => value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const stamp = stat => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
const abort = signal => signal?.throwIfAborted();
function regular(stat, filename) { if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Snapshot document must be a regular file: ${filename}`); }
async function statAt(filename) { try { return await lstat(filename, { bigint: true }); } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; } }
function boundedString(value) { if (Buffer.byteLength(value) > RECORD_LIMIT) throw new Error('Snapshot key or scalar exceeds the 1 MiB limit.'); }
function validateTree(value, depth = 1, seen = new Set()) {
  if (typeof value === 'string') { boundedString(value); return; }
  if (typeof value === 'number') { if (!Number.isFinite(value)) throw new Error('Snapshot numbers must be finite.'); return; }
  if (value === null || typeof value === 'boolean' || value === undefined) return;
  if (typeof value !== 'object' || !Array.isArray(value) && !plain(value)) throw new Error('Snapshot values must be plain JSON data.');
  if (depth > MAX_DEPTH) throw new Error('Snapshot document exceeds the nesting limit.');
  if (seen.has(value)) throw new Error('Snapshot document contains a circular value.'); seen.add(value);
  for (const [key, child] of Object.entries(value)) { boundedString(key); validateTree(child, depth + 1, seen); }
  seen.delete(value);
}

/** Count canonical JSON bytes and reject duplicate keys before assembling bounded objects. */
class BoundedAssembler {
  constructor(limit, depthOffset = 0) { this.limit = limit; this.depthOffset = depthOffset; this.bytes = 0; this.contexts = []; this.assembler = new Assembler(); }
  consume(token) {
    const parent = this.contexts.at(-1); let cost = 0;
    if (token.name === 'keyValue') {
      if (parent.keys.has(token.value)) throw new Error(`Duplicate snapshot key: ${token.value}`); parent.keys.add(token.value);
      cost = Buffer.byteLength(JSON.stringify(token.value)) + 1 + Number(!parent.first); parent.first = false;
    } else if (token.name === 'endObject' || token.name === 'endArray') { cost = 1; this.contexts.pop(); }
    else {
      if (parent && parent.kind === 'array') { cost += Number(!parent.first); parent.first = false; }
      if (token.name === 'startObject' || token.name === 'startArray') {
        cost++; this.contexts.push({ kind: token.name === 'startObject' ? 'object' : 'array', first: true, keys: token.name === 'startObject' ? new Set() : undefined });
        if (this.contexts.length + this.depthOffset > MAX_DEPTH) throw new Error('Snapshot document exceeds the nesting limit.');
      } else if (token.name === 'stringValue') cost += Buffer.byteLength(JSON.stringify(token.value));
      else if (token.name === 'numberValue') { const number = Number(token.value); if (!Number.isFinite(number)) throw new Error('Snapshot numbers must be finite.'); cost += Buffer.byteLength(JSON.stringify(number)); }
      else if (token.name === 'nullValue') cost += 4;
      else if (token.name === 'trueValue') cost += 4;
      else if (token.name === 'falseValue') cost += 5;
      else throw new Error(`Unsupported snapshot token: ${token.name}`);
    }
    this.bytes += cost;
    if (this.bytes > this.limit) throw new Error(this.limit === HEADER_LIMIT ? 'Snapshot header exceeds the 16 MiB limit.' : 'Snapshot file record exceeds the 1 MiB limit.');
    this.assembler.consume(token);
  }
  get value() { return this.assembler.current; }
}

/** Stream the file maps without retaining their entries in memory. */
export async function readSnapshotDocument(filename, options = {}) {
  const { signal } = options;
  abort(signal); const before = await lstat(filename, { bigint: true }); regular(before, filename);
  const handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); let input, tokens, failure;
  try {
    if (stamp(before) !== stamp(await handle.stat({ bigint: true }))) throw new Error('Snapshot document changed while opening it.');
    const decoder = new TextDecoder('utf-8', { fatal: true });
    async function* text() {
      const buffer = Buffer.allocUnsafe(CHUNK_SIZE);
      for (;;) { await options.waitIfPaused?.(); abort(signal); const { bytesRead } = await handle.read(buffer, 0, buffer.length, null); if (!bytesRead) break; const value = decoder.decode(buffer.subarray(0, bytesRead), { stream: true }); if (value) yield value; }
      const tail = decoder.decode(); if (tail) yield tail;
    }
    input = Readable.from(text(), { objectMode: false, highWaterMark: CHUNK_SIZE }); tokens = parser.asStream({ packValues: false, streamValues: true }); input.on('error', error => tokens.destroy(error)); input.pipe(tokens);
    const header = new BoundedAssembler(HEADER_LIMIT), rootKeys = new Set(), callbacks = { files: options.onData, archivedFiles: options.onLocked ?? options.onStored, errors: options.onError };
    let depth = 0, rootKey, map, key, scalarKind, scalarParts, scalarBytes = 0, ended = false;
    for await (const raw of tokens) {
      abort(signal); let token = raw;
      if (['startKey', 'startString', 'startNumber'].includes(raw.name)) { scalarKind = raw.name; scalarParts = []; scalarBytes = 0; continue; }
      if (raw.name === 'stringChunk' || raw.name === 'numberChunk') { scalarBytes += Buffer.byteLength(raw.value); if (scalarBytes > RECORD_LIMIT) throw new Error('Snapshot key or scalar exceeds the 1 MiB limit.'); scalarParts.push(raw.value); continue; }
      if (['endKey', 'endString', 'endNumber'].includes(raw.name)) { token = { name: scalarKind === 'startKey' ? 'keyValue' : scalarKind === 'startString' ? 'stringValue' : 'numberValue', value: scalarParts.join('') }; scalarKind = undefined; scalarParts = undefined; }
      if (depth === 0) { if (ended || token.name !== 'startObject') throw new Error('Snapshot document must contain one root object.'); depth = 1; header.consume(token); continue; }
      if (map) {
        if (token.name === 'endObject' && key === undefined) { map = undefined; rootKey = undefined; continue; }
        if (token.name === 'keyValue' && key === undefined) { key = token.value; if (!key || key.includes('\0') || !key.isWellFormed()) throw new Error('Invalid snapshot filename.'); continue; }
        if (key !== undefined && (token.name === 'stringValue' || token.name === 'nullValue') && (map !== 'errors' || token.name === 'stringValue')) {
          const value = token.name === 'nullValue' ? null : token.value; await callbacks[map]?.(key, value); key = undefined; abort(signal); continue;
        }
        throw new Error(`Snapshot ${map} must be an object of filename/string pairs${map === 'files' || map === 'archivedFiles' ? ' or null directory values' : ''}.`);
      }
      if (token.name === 'keyValue' && depth === 1) {
        rootKey = token.value; if (!Object.values(WIRE_HEADER).includes(rootKey) && !Object.hasOwn(callbacks, rootKey)) throw new Error(`Unknown snapshot field: ${rootKey}`); if (rootKeys.has(rootKey)) throw new Error(`Duplicate snapshot field: ${rootKey}`); rootKeys.add(rootKey);
        if (Object.hasOwn(callbacks, rootKey)) continue;
      }
      if (Object.hasOwn(callbacks, rootKey ?? '')) { if (token.name !== 'startObject') throw new Error(`Snapshot ${rootKey} must be an object.`); map = rootKey; continue; }
      header.consume(token);
      if (token.name === 'startObject' || token.name === 'startArray') depth++;
      else if (token.name === 'endObject' || token.name === 'endArray') { depth--; if (!depth) ended = true; }
      if (depth === 1 && token.name !== 'keyValue') rootKey = undefined;
    }
    if (!ended || Object.values(WIRE_HEADER).some(key => !rootKeys.has(key)) || !rootKeys.has('files') || !rootKeys.has('archivedFiles') || !rootKeys.has('errors') || map || key !== undefined) throw new Error('Snapshot requires complete files, archivedFiles and errors maps.');
    return Object.fromEntries(Object.entries(WIRE_HEADER).map(([internal, wire]) => [internal, header.value[wire]]));
  } catch (error) { failure = error; throw error; }
  finally {
    input?.destroy(); tokens?.destroy();
    try { const current = await lstat(filename, { bigint: true }); regular(current, filename); if (stamp(before) !== stamp(current) || stamp(before) !== stamp(await handle.stat({ bigint: true }))) throw new Error('Snapshot document changed while reading it.'); }
    catch (error) { if (!failure) throw error; }
    finally { await handle.close(); }
  }
}

/** Private scratch output is complete and fsynced before an atomic replacement. */
export async function writeSnapshotDocument(filename, header, maps, { signal, waitIfPaused } = {}) {
  if (!plain(header) || Object.keys(header).length !== HEADER_FIELDS.length || HEADER_FIELDS.some(key => !Object.hasOwn(header, key))) throw new Error('Snapshot header requires exactly time, ends, comp, full, size and sizx.');
  validateTree(header); const headerText = JSON.stringify(Object.fromEntries(Object.entries(WIRE_HEADER).map(([internal, wire]) => [wire, header[internal]])), null, 2); if (Buffer.byteLength(headerText) > HEADER_LIMIT) throw new Error('Snapshot header exceeds the 16 MiB limit.');
  const checkpoint = async () => { abort(signal); await waitIfPaused?.(); abort(signal); };
  await checkpoint(); const before = await statAt(filename); if (before) regular(before, filename);
  const temporary = path.join(path.dirname(filename), `.${path.basename(filename)}.${randomUUID()}.tmp`); let handle, ownsTemporary = false;
  try {
    handle = await open(temporary, 'wx', 0o600); ownsTemporary = true;
    const write = async value => { const bytes = Buffer.from(value); for (let offset = 0; offset < bytes.length;) { await checkpoint(); const { bytesWritten } = await handle.write(bytes, offset, Math.min(CHUNK_SIZE, bytes.length - offset), null); if (!bytesWritten) throw new Error('Snapshot write made no progress.'); offset += bytesWritten; } };
    await write(headerText.slice(0, -1).trimEnd());
    let preceding = Object.keys(header).length > 0;
    for (const name of ['data', 'lock', 'errs']) {
      await write(`${preceding ? ',' : ''}\n  ${JSON.stringify(WIRE_MAPS[name])}: {`); preceding = true;
      let first = true, parts = [], size = 0;
      for await (const [key, value] of maps[name] ?? []) {
        await checkpoint(); if (typeof key !== 'string' || !key || key.includes('\0') || !key.isWellFormed() || (value !== null && typeof value !== 'string') || (name === 'errs' && value === null)) throw new Error(`Invalid snapshot ${name} record.`);
        boundedString(key); if (value !== null) boundedString(value);
        const record = `${first ? '' : ','}\n    ${JSON.stringify(key)}: ${JSON.stringify(value)}`; first = false; parts.push(record); size += Buffer.byteLength(record);
        if (size >= CHUNK_SIZE) { await write(parts.join('')); parts = []; size = 0; }
      }
      if (parts.length) await write(parts.join('')); await write('\n  }');
    }
    await write('\n}\n'); await handle.sync(); await handle.close(); handle = undefined;
    await checkpoint(); const current = await statAt(filename); if (current) regular(current, filename);
    if (before ? !current || stamp(before) !== stamp(current) : current) throw new Error('Snapshot output changed before replacement.');
    await rename(temporary, filename); ownsTemporary = false;
    if (process.platform !== 'win32') { const directory = await open(path.dirname(filename), 'r'); try { await directory.sync(); } finally { await directory.close(); } }
  } finally { await handle?.close(); if (ownsTemporary) await unlink(temporary).catch(() => {}); }
}
