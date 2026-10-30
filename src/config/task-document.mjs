import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readFile, rename, unlink } from 'node:fs/promises';
import { hostname } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { parser } from 'stream-json';
import Assembler from 'stream-json/assembler.js';
import { portablePath, portableGlob } from '../domain/source-identity.mjs';
import { sequenceFromString, sequenceToString } from './sequence.mjs';

const HEADER_LIMIT = 16 * 1024 ** 2, SCALAR_LIMIT = 1024 ** 2, MAX_DEPTH = 128, CHUNK_SIZE = 64 * 1024;
const zipName = /^[^/\\\0]+\.zip$/i;
export class ConfigurationConflictError extends Error {
  code = 'CONFIGURATION_CONFLICT';
  constructor(message = 'Configuration changed on disk. Reload it before saving.') { super(message); this.name = 'ConfigurationConflictError'; }
}
const abort = signal => signal?.throwIfAborted();
const plain = value => value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const stamp = stat => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
function regular(stat, filename) { if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Task configuration must be a regular file: ${filename}`); }
async function openTask(filename, signal) {
  abort(signal); const before = await lstat(filename, { bigint: true }); regular(before, filename);
  const handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try { const actual = await handle.stat({ bigint: true }); regular(actual, filename); if (stamp(before) !== stamp(actual)) throw new ConfigurationConflictError('Task configuration changed while opening it.'); return { handle, before }; }
  catch (error) { await handle.close(); throw error; }
}
async function verifyTask(filename, handle, before) {
  const current = await lstat(filename, { bigint: true }); regular(current, filename);
  if (stamp(before) !== stamp(current) || stamp(before) !== stamp(await handle.stat({ bigint: true }))) throw new ConfigurationConflictError('Task configuration changed while reading it.');
}
function scalar(value, kind) {
  if (typeof value !== 'string' || Buffer.byteLength(value) > SCALAR_LIMIT) throw new Error(`Task ${kind} exceeds the 1 MiB limit or is not a string.`);
  return value;
}
function dataKey(value) { scalar(value, 'data key'); if (!value || value.includes('\0') || !value.isWellFormed()) throw new Error('Invalid task data filename key.'); return value; }
function dataValue(value) { if (value !== null) { scalar(value, 'data fingerprint'); if (!value.isWellFormed()) throw new Error('Invalid task data fingerprint.'); } return value; }
function validateHistory(value) {
  if (!Array.isArray(value)) throw new Error('Task hist must be an array of ZIP filenames.');
  const seen = new Set();
  for (const filename of value) { if (typeof filename !== 'string' || !zipName.test(filename) || seen.has(filename)) throw new Error('Task hist must contain unique ZIP filenames without paths.'); seen.add(filename); }
  return value;
}
function headerTree(value, depth = 1) {
  if (typeof value === 'string') { scalar(value, 'metadata scalar'); return; }
  if (!value || typeof value !== 'object') return;
  if (depth > MAX_DEPTH) throw new Error('Task document exceeds the nesting limit.');
  for (const [key, child] of Object.entries(value)) { scalar(key, 'metadata key'); headerTree(child, depth + 1); }
}

/** The package parser validates grammar; this reducer bounds and validates our document shape. */
async function* scan(filename, { signal } = {}) {
  const { handle, before } = await openTask(filename, signal), hash = createHash('sha256'), decoder = new TextDecoder('utf-8', { fatal: true });
  let input, tokens, failure;
  try {
    async function* text() {
      const buffer = Buffer.allocUnsafe(CHUNK_SIZE);
      for (;;) {
        abort(signal); const { bytesRead } = await handle.read(buffer, 0, buffer.length, null); if (!bytesRead) break;
        const bytes = buffer.subarray(0, bytesRead); hash.update(bytes); const value = decoder.decode(bytes, { stream: true }); if (value) yield value;
      }
      const tail = decoder.decode(); if (tail) yield tail;
    }
    input = Readable.from(text(), { objectMode: false, highWaterMark: CHUNK_SIZE });
    tokens = parser.asStream({ packValues: false, streamValues: true }); input.on('error', error => tokens.destroy(error)); input.pipe(tokens);
    const assembler = new Assembler(), rootKeys = new Set();
    let depth = 0, rootKey, inData = false, inHist = false, pendingDataKey, scalarKind, scalarParts, scalarBytes = 0, headerBytes = 0, rootEnded = false;
    for await (const raw of tokens) {
      abort(signal); let token = raw;
      if (['startKey', 'startString', 'startNumber'].includes(raw.name)) { scalarKind = raw.name; scalarParts = []; scalarBytes = 0; continue; }
      if (raw.name === 'stringChunk' || raw.name === 'numberChunk') {
        scalarBytes += Buffer.byteLength(raw.value); if (scalarBytes > SCALAR_LIMIT) throw new Error('Task key or scalar exceeds the 1 MiB limit.'); scalarParts.push(raw.value); continue;
      }
      if (['endKey', 'endString', 'endNumber'].includes(raw.name)) {
        token = { name: scalarKind === 'startKey' ? 'keyValue' : scalarKind === 'startString' ? 'stringValue' : 'numberValue', value: scalarParts.join('') }; scalarKind = undefined; scalarParts = undefined;
      }
      if (depth === 0) {
        if (rootEnded || token.name !== 'startObject') throw new Error('Task document must contain one root object.');
        depth = 1; assembler.consume(token); continue;
      }
      if (token.name === 'keyValue' && depth === 1) {
        rootKey = token.value; if (rootKeys.has(rootKey)) throw new Error(`Duplicate task field: ${rootKey}`); rootKeys.add(rootKey);
        if (['wdir', 'proj', 'srcs', 'mode', 'hist', 'data', 'filters'].includes(rootKey)) throw new Error(`Unknown task field: ${rootKey}`);
        if (rootKey === 'files') continue;
      }
      if (inData) {
        if (token.name === 'endObject') { inData = false; depth--; rootKey = undefined; continue; }
        if (token.name === 'keyValue') { pendingDataKey = dataKey(token.value); continue; }
        if ((token.name === 'stringValue' || token.name === 'nullValue') && pendingDataKey !== undefined) { yield { type: 'data', entry: [pendingDataKey, dataValue(token.name === 'nullValue' ? null : token.value)] }; pendingDataKey = undefined; continue; }
        throw new Error('Task data must be an object of string or null fingerprints.');
      }
      if (rootKey === 'files') {
        if (token.name !== 'startObject') throw new Error('Task data must be an object.');
        inData = true; depth++; continue;
      }
      if (rootKey === 'history' && depth === 1 && token.name !== 'keyValue' && token.name !== 'startArray') throw new Error('Task history must be an array.');
      if (rootKey === 'history' && depth === 1 && token.name === 'startArray') inHist = true;
      else if (inHist && depth === 2 && token.name !== 'stringValue' && token.name !== 'endArray') throw new Error('Task hist must contain ZIP filename strings.');
      if (inHist && token.name === 'stringValue' && !zipName.test(token.value)) throw new Error('Task hist contains an invalid ZIP filename.');
      if (inHist && token.name === 'endArray' && depth === 2) inHist = false;
      headerBytes += token.value === undefined ? 1 : Buffer.byteLength(JSON.stringify(token.value)) + 2;
      if (headerBytes > HEADER_LIMIT) throw new Error('Task settings and hist exceed the 16 MiB limit.');
      assembler.consume(token);
      if (token.name === 'startObject' || token.name === 'startArray') { depth++; if (depth > MAX_DEPTH) throw new Error('Task document exceeds the nesting limit.'); }
      else if (token.name === 'endObject' || token.name === 'endArray') { depth--; if (depth === 0) rootEnded = true; }
      if (depth === 1 && token.name !== 'keyValue') rootKey = undefined;
    }
    if (!rootEnded || !assembler.done) throw new Error('Incomplete task document.');
    const { history: hist = [], pinned = [], ...wire } = assembler.current;
    const names = { workingDirectory: 'wdir', backupDirectory: 'proj', sources: 'srcs', pathMode: 'mode', sourceFilters: 'filters' };
    const value = Object.fromEntries(Object.entries(wire).map(([key, child]) => [names[key] ?? key, child]));
    if (Object.hasOwn(value, 'sequence')) value.sequence = sequenceFromString(value.sequence);
    yield { type: 'document', value, hist: validateHistory(hist), pinned: validateHistory(pinned), revision: hash.digest('hex') };
  } catch (error) { failure = error; throw error; }
  finally {
    input?.destroy(); tokens?.destroy();
    try { await verifyTask(filename, handle, before); } catch (error) { if (!failure) throw error; }
    finally { await handle.close(); }
  }
}

export async function readTaskDocument(filename, options = {}) {
  let document; for await (const event of scan(filename, options)) if (event.type === 'document') document = event;
  if (!document) throw new Error('Incomplete task document.'); const { type, ...result } = document; return result;
}
export async function* iterateTaskData(filename, options = {}) { for await (const event of scan(filename, options)) if (event.type === 'data') yield event.entry; }
async function revisionAt(filename, signal) {
  let opened;
  try { opened = await openTask(filename, signal); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const { handle, before } = opened, hash = createHash('sha256'), buffer = Buffer.allocUnsafe(CHUNK_SIZE);
  try { for (;;) { abort(signal); const { bytesRead } = await handle.read(buffer, 0, buffer.length, null); if (!bytesRead) break; hash.update(buffer.subarray(0, bytesRead)); } await verifyTask(filename, handle, before); return hash.digest('hex'); }
  finally { await handle.close(); }
}
async function acquireLock(filename, signal) {
  const lockPath = `${filename}.delta-write-lock`, content = JSON.stringify({ hostname: hostname(), pid: process.pid, token: randomUUID() });
  for (let attempt = 0; attempt < 100; attempt++) {
    abort(signal);
    try {
      const handle = await open(lockPath, 'wx', 0o600); try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
      return async () => { if (await readFile(lockPath, 'utf8').catch(() => '') === content) await unlink(lockPath); };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const bytes = await readFile(lockPath, 'utf8'), owner = JSON.parse(bytes);
        if (owner.hostname === hostname() && Number.isInteger(owner.pid) && owner.pid > 0) try { process.kill(owner.pid, 0); } catch (dead) { if (dead.code === 'ESRCH' && await readFile(lockPath, 'utf8') === bytes) { await unlink(lockPath); continue; } }
      } catch { /* Unknown and remote owners are never reclaimed. */ }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  throw new ConfigurationConflictError('Another process is saving this configuration, or its lock owner cannot be safely identified.');
}

export async function saveTaskDocument(filename, settings, expectedRevision, { guard, catalog, pinned: selectedPins, signal } = {}) {
  if (!plain(settings) || Object.hasOwn(settings, 'hist') || Object.hasOwn(settings, 'data') || Object.hasOwn(settings, 'pinned')) throw new Error('Task settings must be an object without hist or data.');
  if (catalog !== undefined && (!plain(catalog) || !Array.isArray(catalog.hist) || !catalog.data || typeof catalog.data[Symbol.asyncIterator] !== 'function' && typeof catalog.data[Symbol.iterator] !== 'function')) throw new Error('Task catalog requires hist and an iterable of data pairs.');
  const { sources, ...stored } = settings;
  if (typeof stored.wdir === 'string') stored.wdir = portablePath(stored.wdir);
  if (typeof stored.proj === 'string') stored.proj = portablePath(stored.proj);
  if (stored.srcs) stored.srcs = stored.srcs.map(source => typeof source === 'string' ? portablePath(source) : source.map((value, index) => index === 0 ? portablePath(value) : index === 1 && typeof value === 'string' ? portableGlob(value) : value));
  const normalizeFilters = filters => ({ ...filters, ...(filters?.include ? { include: filters.include.map(portableGlob) } : {}), ...(filters?.exclude ? { exclude: filters.exclude.map(portableGlob) } : {}) });
  if (sources !== undefined) {
    const normalizedSources = sources.map(source => ({ ...source, path: portablePath(source.path) }));
    stored.srcs = normalizedSources.map(source => structuredClone(stored.srcs?.find(item => (typeof item === 'string' ? item : item[0]) === source.path) ?? source.path));
    const filters = Object.fromEntries(normalizedSources.filter(source => source.filters?.include?.length || source.filters?.exclude?.length).map(source => [source.path, normalizeFilters(source.filters)]));
    if (Object.keys(filters).length) stored.filters = filters; else delete stored.filters;
  } else if (stored.filters) stored.filters = Object.fromEntries(Object.entries(stored.filters).map(([sourcePath, value]) => [portablePath(sourcePath), normalizeFilters(value)]));
  const ordered = Object.fromEntries([...['wdir', 'proj', 'srcs', 'mode'].filter(key => Object.hasOwn(stored, key)), ...Object.keys(stored).filter(key => !['wdir', 'proj', 'srcs', 'mode'].includes(key))].map(key => [key, stored[key]]));
  const names = { wdir: 'workingDirectory', proj: 'backupDirectory', srcs: 'sources', mode: 'pathMode', filters: 'sourceFilters' };
  const wire = Object.fromEntries(Object.entries(ordered).map(([key, value]) => [names[key] ?? key, value]));
  if (Object.hasOwn(wire, 'sequence')) wire.sequence = sequenceToString(wire.sequence);
  const settingsText = JSON.stringify(wire, null, 2); if (Buffer.byteLength(settingsText) > HEADER_LIMIT) throw new Error('Task settings exceed the 16 MiB limit.');
  headerTree(ordered);
  abort(signal); await guard?.(); const release = await acquireLock(filename, signal), temporary = path.join(path.dirname(filename), `.${path.basename(filename)}.${randomUUID()}.tmp`); let ownsTemporary = false, handle;
  try {
    await guard?.(); if (expectedRevision === null && await revisionAt(filename, signal) !== null) throw new ConfigurationConflictError();
    const previous = expectedRevision === null ? undefined : await readTaskDocument(filename, { signal }).catch(error => { if (error.code === 'ENOENT') throw new ConfigurationConflictError(); throw error; });
    if (previous && previous.revision !== expectedRevision) throw new ConfigurationConflictError();
    const hist = validateHistory(catalog?.hist ?? previous?.hist ?? []), histText = JSON.stringify(hist), pinned = validateHistory(selectedPins ?? previous?.pinned ?? []);
    if (Buffer.byteLength(settingsText) + Buffer.byteLength(histText) > HEADER_LIMIT) throw new Error('Task settings and hist exceed the 16 MiB limit.');
    const data = catalog ? catalog.data : previous ? iterateTaskData(filename, { signal }) : [];
    const hash = createHash('sha256'); handle = await open(temporary, 'wx', 0o600); ownsTemporary = true;
    const write = async text => { const bytes = Buffer.from(text); hash.update(bytes); for (let offset = 0; offset < bytes.length;) { abort(signal); const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, null); if (!bytesWritten) throw new Error('Task document write made no progress.'); offset += bytesWritten; } };
    await write(`${settingsText.slice(0, -1).trimEnd()}${Object.keys(ordered).length ? ',' : ''}\n  "history": ${histText},${pinned.length ? `\n  "pinned": ${JSON.stringify(pinned)},` : ''}\n  "files": {`);
    let first = true, parts = [], size = 0;
    for await (const entry of data) {
      abort(signal); if (!Array.isArray(entry) || entry.length !== 2) throw new Error('Task data must yield [filename, fingerprint] pairs.');
      const key = dataKey(entry[0]), value = dataValue(entry[1]), text = `${first ? '' : ','}\n    ${JSON.stringify(key)}: ${JSON.stringify(value)}`; first = false; parts.push(text); size += Buffer.byteLength(text);
      if (size >= CHUNK_SIZE) { await write(parts.join('')); parts = []; size = 0; }
    }
    if (parts.length) await write(parts.join('')); await write('\n  }\n}\n'); await handle.sync(); await handle.close(); handle = undefined;
    abort(signal); await guard?.(); if (await revisionAt(filename, signal) !== expectedRevision) throw new ConfigurationConflictError();
    await rename(temporary, filename); ownsTemporary = false;
    if (process.platform !== 'win32') { const directory = await open(path.dirname(filename), 'r'); try { await directory.sync(); } finally { await directory.close(); } }
    return { value: structuredClone(ordered), hist: structuredClone(hist), pinned: structuredClone(pinned), revision: hash.digest('hex') };
  } finally { await handle?.close(); if (ownsTemporary) await unlink(temporary).catch(() => {}); await release(); }
}
