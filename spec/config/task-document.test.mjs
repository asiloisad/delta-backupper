import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { portablePath } from '../../src/domain/source-identity.mjs';
import { sequenceToString } from '../../src/config/sequence.mjs';


function onDisk(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !['wdir','proj','srcs'].some(key=>Object.hasOwn(value,key))) return value;
  value = { ...value, ...(value.sequence && typeof value.sequence === 'object' ? { sequence: sequenceToString(value.sequence) } : {}) };
  const {sources,...result}=value;
  if(sources) {
    result.srcs=sources.map(source=>value.srcs?.find(item=>(typeof item==='string'?item:item[0])===source.path)??source.path);
    const filters=Object.fromEntries(sources.filter(source=>source.filters?.include?.length||source.filters?.exclude?.length).map(source=>[source.path,source.filters]));
    if(Object.keys(filters).length)result.filters=filters;else delete result.filters;
  }
  const names={wdir:'workingDirectory',proj:'backupDirectory',srcs:'sources',mode:'pathMode',filters:'sourceFilters',hist:'history',data:'files'};
  return Object.fromEntries(Object.entries(result).map(([key,child])=>[names[key]??key,child]));
}
const json=value=>JSON.stringify(onDisk(value));

const temporary = await mkdtemp(path.join(tmpdir(), 'delta-task-document-'));
after(() => { assert.equal(path.dirname(temporary), path.resolve(tmpdir())); return rm(temporary, { recursive: true, force: true }); });
const bundle = path.join(temporary, 'task-document.mjs');
await build({ stdin: { contents: 'export { ConfigurationStore, builtInSettings } from "./src/config/index.ts"; export * from "./src/config/task-document.mjs";', resolveDir: process.cwd(), loader: 'ts' }, outfile: bundle, bundle: true, platform: 'node', target: 'node24', format: 'esm', logLevel: 'silent' });
const { ConfigurationStore, builtInSettings, ConfigurationConflictError, readTaskDocument, iterateTaskData, saveTaskDocument } = await import(pathToFileURL(bundle).href);
const settings = (patch = {}) => { const {sources,...settings}=builtInSettings(); return {...settings,wdir:portablePath(temporary),proj:portablePath(temporary),srcs:['../source'],name:'Documents',...patch}; };
const catalog = (entries = [], hist = ['20261030010000.zip']) => ({ hist, data: (async function* () { yield* entries; })() });
async function fixture() { const directory = await mkdtemp(path.join(temporary, 'case-')); return { directory, filename: path.join(directory, '.delta.json') }; }
async function revision(filename) { const hash = createHash('sha256'); for await (const bytes of createReadStream(filename)) hash.update(bytes); return hash.digest('hex'); }
async function entries(filename) { const result = []; for await (const entry of iterateTaskData(filename)) result.push(entry); return result; }

test('streamed documents separate full settings from hist/data and preserve prototype-like filenames', async () => {
  const { filename } = await fixture(), value = settings(), data = [['__proto__', 'fingerprint'], ['constructor', null], ['źródło/żółć😀.txt', 'mtime:size']];
  const saved = await saveTaskDocument(filename, value, null, { catalog: catalog(data) }), loaded = await readTaskDocument(filename);
  assert.deepEqual(loaded, saved); assert.deepEqual(loaded.value, value); assert.deepEqual(loaded.hist, ['20261030010000.zip']); assert(!Object.hasOwn(loaded.value, 'data')); assert(!Object.hasOwn(loaded.value, 'hist')); assert.deepEqual(await entries(filename), data); assert.equal(loaded.revision, await revision(filename));
  const disk = JSON.parse(await readFile(filename, 'utf8')); assert.equal(Object.keys(disk)[0], 'workingDirectory'); for (const key of ['schemaVersion', 'id', 'destination', 'hist', 'data', 'wdir', 'proj', 'srcs', 'mode']) assert(!Object.hasOwn(disk,key)); assert.equal(Object.getPrototypeOf(disk.files), Object.prototype); assert.equal(Object.getOwnPropertyDescriptor(disk.files, '__proto__').value, 'fingerprint'); assert.equal({}.fingerprint, undefined); const text=await readFile(filename,'utf8'); assert(text.includes('źródło/żółć😀.txt')); assert(!text.includes('\\u017a')); assert(!text.includes('\\ud83d'));
  const plain = await fixture(); await writeFile(plain.filename, json(value)); assert.deepEqual((await readTaskDocument(plain.filename)).hist, []); assert.deepEqual(await entries(plain.filename), []);
});

test('the document writer normalizes source and filter paths but preserves regex escapes and Unicode', async () => {
  const source = String.raw`folder\żółć😀`, glob = String.raw`**\*.txt`, regex = String.raw`private/\d+\.txt`, filters = { include: [String.raw`**\*.txt`], exclude: [String.raw`cache\**`] };
  for (const derived of [false, true]) {
    const { filename } = await fixture(), value = settings({ srcs: [[source, glob, regex]], ...(derived ? { sources: [{ path: source, filters }] } : { filters: { [source]: filters } }) });
    await saveTaskDocument(filename, value, null); const text = await readFile(filename, 'utf8'), disk = JSON.parse(text);
    assert.deepEqual(disk.sources, [[portablePath(source), '**/*.txt', regex]]); assert.deepEqual(disk.sourceFilters, { [portablePath(source)]: { include: ['**/*.txt'], exclude: ['cache/**'] } });
    assert(text.includes('żółć😀')); assert(!text.includes('\\u017c')); assert(!text.includes('\\ud83d'));
  }
});

test('a catalog larger than 16 MiB streams through metadata reads and survives settings-only saves', { timeout: 60000 }, async () => {
  const { filename } = await fixture(), value = settings(), fingerprint = 'f'.repeat(1024), count = 20000;
  const data = async function* () { for (let index = 0; index < count; index++) yield [`source/file-${index}.txt`, index % 5 ? fingerprint : null]; };
  const saved = await saveTaskDocument(filename, value, null, { catalog: { hist: ['20261030010000.zip', '20261030010001.zip'], data: data() } });
  assert((await lstat(filename)).size > 16 * 1024 ** 2); const loaded = await readTaskDocument(filename); assert.deepEqual(loaded.value, value); assert.equal(loaded.revision, saved.revision);
  const changed = await saveTaskDocument(filename, { ...loaded.value, name: 'Renamed', schedulesPaused: true }, loaded.revision);
  assert.deepEqual(changed.hist, saved.hist); assert.equal(changed.value.schedulesPaused, true); assert.equal((await readTaskDocument(filename)).value.name, 'Renamed');
  let seen = 0; for await (const [key, value] of iterateTaskData(filename)) { assert.equal(key, `source/file-${seen}.txt`); assert.equal(value, seen % 5 ? fingerprint : null); seen++; } assert.equal(seen, count); assert.equal(changed.revision, await revision(filename));
});

test('ConfigurationStore exposes settings only and preserves an existing catalog while editing', async () => {
  const { directory } = await fixture(), backup = path.join(directory, 'backup'); await mkdir(backup); const store = new ConfigurationStore({ configDirectory: path.join(directory, 'profile') });
  let task = await store.createTask({ directory: backup, name: 'Original', sources: [{ path: '../source' }] }); const filename = path.join(backup, '.delta.json');
  const updated = await saveTaskDocument(filename, task.value, task.revision, { catalog: catalog([['source/file.txt', 'abc'], ['source/missing.txt', null]]) }); task = await store.loadTask(backup);
  assert.equal(task.revision, updated.revision); assert(!Object.hasOwn(task.value, 'data')); assert(!Object.hasOwn(task.value, 'hist'));
  task = await store.saveTask(task, { name: 'Edited', retention: { keepCycles: 0 } }); assert.equal(task.value.name, 'Edited'); assert.deepEqual(await entries(filename), [['source/file.txt', 'abc'], ['source/missing.txt', null]]); assert.deepEqual((await readTaskDocument(filename)).hist, ['20261030010000.zip']);
  const raw = JSON.parse(await readFile(filename, 'utf8')); raw.unrecognizedSetting = true; const bytes = json(raw); await writeFile(filename, bytes); await assert.rejects(store.loadTask(backup), /unknown field/); assert.equal(await readFile(filename, 'utf8'), bytes);
});

test('shared conflict errors protect stale, concurrent and externally changed revisions', async () => {
  const { filename, directory } = await fixture(), value = settings(), original = await saveTaskDocument(filename, value, null);
  const results = await Promise.allSettled(['first', 'second'].map(name => saveTaskDocument(filename, { ...value, name }, original.revision)));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1); assert(results.find(result => result.status === 'rejected').reason instanceof ConfigurationConflictError);
  const loaded = await readTaskDocument(filename), foreign = json({ ...loaded.value, name: 'External', hist: [], data: {} }); let calls = 0;
  await assert.rejects(saveTaskDocument(filename, { ...loaded.value, name: 'Must not win' }, loaded.revision, { guard: async () => { if (++calls === 3) await writeFile(filename, foreign); } }), ConfigurationConflictError);
  assert.equal(await readFile(filename, 'utf8'), foreign); assert.deepEqual((await readdir(directory)).sort(), ['.delta.json']);
  const missing = await fixture(); await assert.rejects(saveTaskDocument(missing.filename, value, loaded.revision), ConfigurationConflictError); assert.deepEqual(await readdir(missing.directory), []);
});

test('aborted and failing catalog generators leave the committed file and no temporary lock behind', async () => {
  const { filename, directory } = await fixture(), value = settings(), saved = await saveTaskDocument(filename, value, null), before = await readFile(filename);
  const controller = new AbortController(); let closed = false;
  async function* data() { try { yield ['first', 'ok']; controller.abort(new Error('stop catalog')); yield ['second', 'never']; } finally { closed = true; } }
  await assert.rejects(saveTaskDocument(filename, value, saved.revision, { signal: controller.signal, catalog: { hist: [], data: data() } }), /stop catalog/); assert(closed); assert.deepEqual(await readFile(filename), before); assert.deepEqual(await readdir(directory), ['.delta.json']);
  await assert.rejects(readTaskDocument(filename, { signal: AbortSignal.abort() }), { name: 'AbortError' });
  await assert.rejects(saveTaskDocument(filename, value, saved.revision, { catalog: catalog([['invalid', 3]]) }), /fingerprint/); assert.deepEqual(await readFile(filename), before);
});

test('catalog shape, duplicate top-level fields and malformed JSON tails are rejected', async () => {
  const { filename } = await fixture(), base = json(settings()).slice(0, -1);
  for (const tail of ['"history":null', '"history":{}', '"history":[1]', '"history":["../20261030010000.zip"]', '"history":["20261030010000.zip","20261030010000.zip"]', '"files":[]', '"files":null', '"files":{"file":1}', '"files":{"file":{}}', '"files":{"file":[]}', '"files":{"\\u0000":"x"}', '"files":{},"files":{}', '"history":[],"history":[]', '"name":"duplicate"']) {
    await writeFile(filename, `${base},${tail}}`); await assert.rejects(readTaskDocument(filename));
  }
  await writeFile(filename, `${base},"files":{"file":"${'x'.repeat(128 * 1024)}"}}BROKEN`); await assert.rejects(readTaskDocument(filename)); await assert.rejects(async () => { for await (const _entry of iterateTaskData(filename)) {} });
});

test('UTF-8 validation spans input chunks and rejects invalid or truncated bytes', async () => {
  const { filename } = await fixture(), prefix = `${json(settings()).slice(0, -1)},"files":{"file":"`, padding = 'a'.repeat(65535 - Buffer.byteLength(prefix));
  await writeFile(filename, Buffer.concat([Buffer.from(prefix + padding), Buffer.from('żółć'), Buffer.from('"}}')])); assert.equal((await entries(filename))[0][1], padding + 'żółć');
  for (const invalid of [Buffer.from([0xc3, 0x28]), Buffer.from([0xe2, 0x82])]) { await writeFile(filename, Buffer.concat([Buffer.from(prefix + padding), invalid, Buffer.from('"}}')])); await assert.rejects(readTaskDocument(filename), /encoded data|encoding|UTF-8/i); }
});

test('keys, scalar values, metadata and nesting are explicitly bounded before assembly', async () => {
  const { filename } = await fixture(), base = json(settings()).slice(0, -1), oversized = 'x'.repeat(1024 ** 2 + 1);
  for (const data of [`{"${oversized}":null}`, `{"file":"${oversized}"}`]) { await writeFile(filename, `${base},"files":${data}}`); await assert.rejects(readTaskDocument(filename), /1 MiB/); }
  const largeMetadata = Array.from({ length: 18 }, () => 'x'.repeat(950000)); await writeFile(filename, json({ ...settings(), extra: largeMetadata, hist: [], data: {} })); await assert.rejects(readTaskDocument(filename), /16 MiB/);
  await writeFile(filename, `${base},"nested":${'['.repeat(129)}0${']'.repeat(129)}}`); await assert.rejects(readTaskDocument(filename), /nesting/);
});

test('ordinary-file checks reject symlinks and detect path replacement while data is being consumed', async t => {
  const { filename, directory } = await fixture(), value = settings(); await saveTaskDocument(filename, value, null, { catalog: catalog([['first', 'a'], ['second', 'b']]) });
  const iterator = iterateTaskData(filename); assert.deepEqual((await iterator.next()).value, ['first', 'a']); await rename(filename, path.join(directory, 'old.json')); await writeFile(filename, json({ ...value, hist: [], data: {} })); await assert.rejects(async () => { for await (const _entry of iterator) {} }, /changed while reading/);
  const link = path.join(directory, 'link.json'); try { await symlink(filename, link); } catch (error) { if (error.code === 'EPERM' || error.code === 'EACCES') { t.diagnostic('File symlink privilege is unavailable; regular-file and replacement checks still ran.'); return; } throw error; }
  await assert.rejects(readTaskDocument(link), /regular file/); await assert.rejects(saveTaskDocument(link, value, null), /regular file/);
});


test('pin metadata is an optional GUI extension and survives configuration/catalog edits', async () => {
  const {filename}=await fixture(), value=settings();
  let document=await saveTaskDocument(filename,value,null,{catalog:catalog([['file','123:4']],['older-backup.zip']),pinned:['older-backup.zip']});
  assert.deepEqual(document.pinned,['older-backup.zip']); assert(!Object.hasOwn(document.value,'pinned'));
  document=await saveTaskDocument(filename,{...document.value,name:'Renamed'},document.revision); assert.deepEqual(document.pinned,['older-backup.zip']); assert.deepEqual(await entries(filename),[['file','123:4']]);
  document=await saveTaskDocument(filename,document.value,document.revision,{pinned:[]}); assert.deepEqual(document.pinned,[]); assert(!Object.hasOwn(JSON.parse(await readFile(filename,'utf8')),'pinned'));
});
