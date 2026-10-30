import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, open, readFile, readdir, rm, stat, truncate, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TextReader, TextWriter, Uint8ArrayWriter } from '@zip.js/zip.js';
import { createBoundedArchive } from '../../src/archive/bounded-writer.mjs';
import { external7zip, find7zip, withArchive } from '../helpers/archive/support.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'delta-bounded-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, path: join(directory, 'backup.zip') };
}

test('removed encryption options reject before archive creation and per-entry requests never publish plain data', async t => {
  const { directory, path } = await fixture(t);
  for (const options of [{ password: 'not-supported' }, { rawPassword: new Uint8Array([1]) }, { password: undefined }, { encryptionStrength: 3 }, { zipCrypto: true }]) { await assert.rejects(createBoundedArchive(path, options), /Unsupported ZIP encryption option/); assert.deepEqual(await readdir(directory), []); }
  const archive = await createBoundedArchive(path); await assert.rejects(archive.writer.add('secret.txt', new TextReader('must not become plain'), { password: 'not-supported' }), /Unsupported ZIP encryption option/); await assert.rejects(archive.writer.close(), /Unsupported ZIP encryption option/); await archive.closeHandle(); assert.deepEqual(await readdir(directory), []);
});

async function faultFixture(t) {
  const value = await fixture(t);
  const sentinel = join(value.directory, 'keep.txt');
  await writeFile(sentinel, 'An unrelated existing file.');
  const probePath = join(value.directory, 'handle-prototype');
  const handle = await open(probePath, 'wx');
  const prototype = Object.getPrototypeOf(handle);
  await handle.close();
  await unlink(probePath);
  return {
    ...value, prototype,
    async assertClean() {
      assert.deepEqual(await readdir(value.directory), ['keep.txt']);
      assert.equal(await readFile(sentinel, 'utf8'), 'An unrelated existing file.');
    },
  };
}

function writeSignature([data, offset = 0, length = data?.byteLength - offset]) {
  if (!ArrayBuffer.isView(data) || length < 4) return undefined;
  return new DataView(data.buffer, data.byteOffset + offset, length).getUint32(0, true);
}

function injectedError(code, operation) {
  return Object.assign(new Error(`Injected ${code}: ${operation}`), { code });
}

for (const level of [0, 1]) {

    test(`single archive roundtrip: level=${level}, plain ZIP`, async (t) => {
      const { directory, path } = await fixture(t);
      const archive = await createBoundedArchive(path, { level, zip64: true });
      try {
        await archive.writer.add('Zażółć/日本語/🗂️.txt', new TextReader('Treść pliku.\n'.repeat(300)));
        await archive.writer.add('empty.txt', new TextReader(''));
        await archive.writer.add('folder', undefined, { directory: true });
        await archive.writer.add('last.txt', new TextReader('Last entry verifies a later local-header offset.'));
        await archive.writer.close();
        await archive.writer.close();
        await assert.rejects(archive.writer.add('too-late.txt', new TextReader('x')), /closed/);
      } finally { await archive.closeHandle(); }
      await withArchive(path, async (reader) => {
        const entries = await reader.getEntries();
        assert.deepEqual(entries.map((entry) => entry.filename), ['Zażółć/日本語/🗂️.txt', 'empty.txt', 'folder/', 'last.txt']);
        for (const [index, expected] of [[0, 'Treść pliku.\n'.repeat(300)], [1, ''], [3, 'Last entry verifies a later local-header offset.']]) {
          const entry = entries[index];
          assert.equal(entry.encrypted, false);
          assert.equal(await entry.getData(new TextWriter(), { checkCrc32: true }), expected);
        }
        assert.equal(entries[2].directory, true);
        assert.ok(entries[3].offset > entries[0].offset);
        assert.deepEqual(reader.warnings, []);
      });
      const sevenZip = await find7zip();
      if (sevenZip) {
        const result = await external7zip(sevenZip, path, { test: true });
        assert.equal(result.exitCode, 0, result.output);
      } else t.diagnostic('7-Zip is unavailable; external compatibility is covered by the stage-0 archive probe.');
      assert.deepEqual(await readdir(directory), ['backup.zip']);
      assert.equal(archive.diagnostics.outputBytes, (await stat(path)).size);
      assert.equal(archive.diagnostics.entries, 4);
      assert.ok(archive.diagnostics.maxCapturedDirectoryBytes < 1024);
    });
}

test('classic ZIP and empty ZIP are valid without forcing ZIP64', async (t) => {
  const { directory, path } = await fixture(t);
  for (const count of [0, 2]) {
    const target = join(directory, `${count}.zip`);
    const archive = await createBoundedArchive(target, { zip64: false });
    try {
      for (let index = 0; index < count; index++) await archive.writer.add(`${index}.txt`, new TextReader(`${index}`));
      await archive.writer.close();
    } finally { await archive.closeHandle(); }
    await withArchive(target, async (reader) => assert.equal((await reader.getEntries()).length, count));
    const data = await readFile(target);
    assert.equal(data.readUInt32LE(data.length - 22), 0x06054b50);
    assert.equal(data.readUInt16LE(data.length - 12), count);
  }
});

test('many entries spool metadata without retaining a directory array', async (t) => {
  const { directory, path } = await fixture(t);
  const archive = await createBoundedArchive(path, { level: 0, zip64: true });
  try {
    for (let index = 0; index < 500; index++) await archive.writer.add(`files/${index}.txt`, new TextReader('tiny'));
    assert.equal(archive.diagnostics.entries, 500);
    assert.ok(archive.diagnostics.spoolBytes > 40 * 1024);
    assert.ok(archive.diagnostics.maxCapturedDirectoryBytes < 1024);
    assert.equal(archive.diagnostics.namesDatabaseCacheBytes, 1024 * 1024);
    assert.equal((await readdir(directory)).filter((name) => name.startsWith('.delta-zip-')).length, 1);
    await archive.writer.close();
  } finally { await archive.closeHandle(); }
  await withArchive(path, async (reader) => assert.equal((await reader.getEntries()).length, 500));
  assert.deepEqual(await readdir(directory), ['backup.zip']);
});

test('large directory metadata and embedded ZIP signatures are parsed by lengths', async (t) => {
  const { path } = await fixture(t);
  const archive = await createBoundedArchive(path, { level: 0, zip64: true });
  const name = 'n'.repeat(65535);
  const comment = `PK\u0005\u0006PK\u0006\u0006${'c'.repeat(65523)}`;
  try {
    await archive.writer.add(name, new TextReader('content'), {
      comment, extraField: new Map([[0xcafe, new Uint8Array(60000)]]),
    });
    await archive.writer.close();
  } finally { await archive.closeHandle(); }
  assert.ok(archive.diagnostics.maxCapturedDirectoryBytes > 190000);
  assert.ok(archive.diagnostics.maxCapturedDirectoryBytes < 256 * 1024);
  await withArchive(path, async (reader) => {
    const [entry] = await reader.getEntries();
    assert.equal(entry.filename, name);
    assert.equal(entry.comment, comment);
    assert.equal(await entry.getData(new TextWriter()), 'content');
    assert.deepEqual(reader.warnings, []);
  });
});







test('duplicate detection includes normalized directory slash and makes failure terminal', async (t) => {
  const { directory, path } = await fixture(t);
  const archive = await createBoundedArchive(path);
  await archive.writer.add('folder', undefined, { directory: true });
  await assert.rejects(archive.writer.add('folder/', undefined, { directory: true }), /Duplicate ZIP entry/);
  await assert.rejects(archive.writer.close(), /Duplicate ZIP entry/);
  await archive.closeHandle();
  assert.deepEqual(await readdir(directory), []);
});

test('invalid UTF-16 names are rejected before two names can encode to the same bytes', async (t) => {
  const { directory, path } = await fixture(t);
  const archive = await createBoundedArchive(path);
  await assert.rejects(archive.writer.add('\ud800.txt', new TextReader('x')), /well-formed/);
  await assert.rejects(archive.writer.close(), /well-formed/);
  await archive.closeHandle();
  assert.deepEqual(await readdir(directory), []);
});

test('reader failure removes unfinished output and close does not finalize it', async (t) => {
  const { directory, path } = await fixture(t);
  const archive = await createBoundedArchive(path);
  await archive.writer.add('good.txt', new TextReader('good'));
  const reader = new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(128)); },
    pull(controller) { controller.error(new Error('Fixture read failure')); },
  });
  await assert.rejects(archive.writer.add('bad.txt', reader), /Fixture read failure/);
  await assert.rejects(archive.writer.close(), /Fixture read failure/);
  await archive.closeHandle();
  assert.deepEqual(await readdir(directory), []);
});

for (const level of [0, 1]) test(`recoverable source errors discard only the unfinished entry: level=${level}`, async t => {
  const { directory, path } = await fixture(t), archive = await createBoundedArchive(path, { level, zip64: true, recoverSourceErrors: true });
  const unreadable = () => {
    let chunks = 0;
    return new ReadableStream({
      pull(controller) {
        if (chunks++ === 4) controller.error(Object.assign(new Error('Source disconnected during read'), { sourceReadError: true }));
        else controller.enqueue(new Uint8Array(64 * 1024).fill(chunks));
      },
    }, { highWaterMark: 1 });
  };
  try {
    await archive.writer.add('before.txt', new TextReader('Before the failed entry.'));
    const checkpoint = archive.diagnostics;
    await assert.rejects(archive.writer.add('skip.bin', unreadable()), error => error.message === 'Source disconnected during read' && error.sourceReadErrorRecovered === true);
    assert.equal(archive.diagnostics.outputBytes, checkpoint.outputBytes);
    assert.equal((await stat(path)).size, checkpoint.outputBytes);
    assert.equal(archive.diagnostics.entries, checkpoint.entries);
    assert.equal(archive.diagnostics.spoolBytes, checkpoint.spoolBytes);
    await archive.writer.add('after.txt', new TextReader('After the failed entry.'));
    await assert.rejects(archive.writer.add('retry.txt', unreadable()), /Source disconnected during read/);
    await archive.writer.add('retry.txt', new TextReader('The same name can be retried.'));
    await archive.writer.close();
  } finally { await archive.closeHandle(); }
  await withArchive(path, async reader => {
    const entries = await reader.getEntries();
    assert.deepEqual(entries.map(entry => entry.filename), ['before.txt', 'after.txt', 'retry.txt']);
    for (const [index, text] of ['Before the failed entry.', 'After the failed entry.', 'The same name can be retried.'].entries()) assert.equal(await entries[index].getData(new TextWriter(), { checkCrc32: true }), text);
    assert.deepEqual(reader.warnings, []);
  });
  assert.deepEqual(await readdir(directory), ['backup.zip']);
  assert.equal(archive.diagnostics.outputBytes, (await stat(path)).size);
});

test('recoverable source mode does not recover a failing archive output even when the error is tagged', async t => {
  const { path, prototype, assertClean } = await faultFixture(t), originalWrite = prototype.write;
  let outputFd, injected = false;
  t.mock.method(prototype, 'write', async function (...args) {
    if (writeSignature(args) === 0x04034b50) outputFd ??= this.fd;
    else if (this.fd === outputFd && !injected) {
      injected = true;
      throw Object.assign(injectedError('ENOSPC', 'tagged output failure'), { sourceReadError: true });
    }
    return Reflect.apply(originalWrite, this, args);
  });
  const archive = await createBoundedArchive(path, { level: 0, recoverSourceErrors: true });
  try {
    await assert.rejects(archive.writer.add('bad.txt', new TextReader('Output errors remain terminal.')), { code: 'ENOSPC' });
    await assert.rejects(archive.writer.add('later.txt', new TextReader('Cannot continue.')), { code: 'ENOSPC' });
    await assert.rejects(archive.writer.close(), { code: 'ENOSPC' });
  } finally { await archive.closeHandle(); }
  assert(injected); await assertClean();
});

test('failure to truncate an unreadable entry makes the archive terminal', async t => {
  const { path, prototype, assertClean } = await faultFixture(t);
  t.mock.method(prototype, 'truncate', async function () { throw injectedError('EIO', 'discard unreadable entry'); });
  const archive = await createBoundedArchive(path, { recoverSourceErrors: true });
  const reader = new ReadableStream({ pull(controller) { controller.error(Object.assign(new Error('Source read failed'), { sourceReadError: true })); } });
  try {
    await assert.rejects(archive.writer.add('bad.txt', reader), /Could not discard the unreadable ZIP entry/);
    await assert.rejects(archive.writer.close(), /Could not discard the unreadable ZIP entry/);
  } finally { await archive.closeHandle(); }
  await assertClean();
});

test('source recovery never continues an aborted archive', async t => {
  const { directory, path } = await fixture(t), controller = new AbortController();
  const archive = await createBoundedArchive(path, { recoverSourceErrors: true, signal: controller.signal });
  let chunks = 0;
  const reader = new ReadableStream({
    pull(stream) {
      if (chunks++ === 4) {
        const error = Object.assign(new Error('Cancelled while source failed'), { sourceReadError: true });
        controller.abort(error); stream.error(error);
      } else stream.enqueue(new Uint8Array(64 * 1024));
    },
  });
  await assert.rejects(archive.writer.add('bad.bin', reader), /Cancelled while source failed/);
  await assert.rejects(archive.writer.close(), /Cancelled while source failed/);
  await archive.closeHandle(); assert.deepEqual(await readdir(directory), []);
});

test('a truncated central-directory spool cannot publish a complete archive', async (t) => {
  const { directory, path } = await fixture(t);
  const archive = await createBoundedArchive(path);
  await archive.writer.add('good.txt', new TextReader('good'));
  const temporary = (await readdir(directory)).find((name) => name.startsWith('.delta-zip-'));
  await truncate(join(directory, temporary, 'central-directory'), 0);
  await assert.rejects(archive.writer.close(), /Unexpected end of central-directory spool/);
  await archive.closeHandle();
  assert.deepEqual(await readdir(directory), []);
});

test('ENOSPC during archive payload write removes unfinished output and preserves foreign files', async (t) => {
  const { path, prototype, assertClean } = await faultFixture(t);
  const write = prototype.write;
  let outputFd;
  let injected = false;
  t.mock.method(prototype, 'write', async function (...args) {
    if (writeSignature(args) === 0x04034b50) outputFd ??= this.fd;
    else if (this.fd === outputFd && !injected) {
      injected = true;
      throw injectedError('ENOSPC', 'archive payload write');
    }
    return Reflect.apply(write, this, args);
  });
  const archive = await createBoundedArchive(path, { level: 0 });
  try {
    await assert.rejects(archive.writer.add('file.txt', new TextReader('Payload is written after its local header.')), { code: 'ENOSPC' });
    await assert.rejects(archive.writer.close(), { code: 'ENOSPC' });
    assert.equal(injected, true);
  } finally { await archive.closeHandle(); }
  await assertClean();
});

test('central-directory spool write failure is terminal and preserves foreign files', async (t) => {
  const { path, prototype, assertClean } = await faultFixture(t);
  const write = prototype.write;
  let outputFd;
  let injected = false;
  t.mock.method(prototype, 'write', async function (...args) {
    const signature = writeSignature(args);
    if (signature === 0x04034b50) outputFd ??= this.fd;
    if (signature === 0x02014b50 && this.fd !== outputFd && !injected) {
      injected = true;
      throw injectedError('EIO', 'central-directory spool write');
    }
    return Reflect.apply(write, this, args);
  });
  const archive = await createBoundedArchive(path);
  try {
    await assert.rejects(archive.writer.add('file.txt', new TextReader('good content')), /Injected EIO: central-directory spool write/);
    await assert.rejects(archive.writer.close(), /Injected EIO: central-directory spool write/);
    assert.equal(injected, true);
  } finally { await archive.closeHandle(); }
  await assertClean();
});

test('abort during final central-directory copy removes output and preserves foreign files', async (t) => {
  const { path, prototype, assertClean } = await faultFixture(t);
  const abort = new AbortController();
  const write = prototype.write;
  let outputFd;
  let finishing = false;
  let injected = false;
  t.mock.method(prototype, 'write', async function (...args) {
    const signature = writeSignature(args);
    if (signature === 0x04034b50) outputFd ??= this.fd;
    const result = await Reflect.apply(write, this, args);
    if (finishing && signature === 0x02014b50 && this.fd === outputFd) {
      injected = true;
      abort.abort(new Error('Injected abort during final directory copy'));
    }
    return result;
  });
  const archive = await createBoundedArchive(path, { signal: abort.signal });
  try {
    await archive.writer.add('file.txt', new TextReader('good content'));
    finishing = true;
    await assert.rejects(archive.writer.close(), /Injected abort during final directory copy/);
    assert.equal(injected, true);
  } finally { await archive.closeHandle(); }
  await assertClean();
});

test('sync failure after writing EOCD removes a structurally complete output and preserves foreign files', async (t) => {
  const { path, prototype, assertClean } = await faultFixture(t);
  const write = prototype.write;
  const sync = prototype.sync;
  let outputFd;
  let injected = false;
  t.mock.method(prototype, 'write', function (...args) {
    if (writeSignature(args) === 0x04034b50) outputFd ??= this.fd;
    return Reflect.apply(write, this, args);
  });
  t.mock.method(prototype, 'sync', async function (...args) {
    if (this.fd === outputFd) {
      const bytes = await readFile(path);
      assert.equal(bytes.readUInt32LE(bytes.length - 22), 0x06054b50, 'The injected sync failure must occur after writing EOCD');
      injected = true;
      throw injectedError('EIO', 'archive sync after EOCD');
    }
    return Reflect.apply(sync, this, args);
  });
  const archive = await createBoundedArchive(path);
  try {
    await archive.writer.add('file.txt', new TextReader('good content'));
    await assert.rejects(archive.writer.close(), /Injected EIO: archive sync after EOCD/);
    assert.equal(injected, true);
  } finally { await archive.closeHandle(); }
  await assertClean();
});

test('abort while streaming cancels source and cleans only owned files', async (t) => {
  const { directory, path } = await fixture(t);
  const sentinel = join(directory, 'keep.txt');
  await writeFile(sentinel, 'keep');
  const abort = new AbortController();
  const archive = await createBoundedArchive(path);
  let produced = 0;
  let cancelled = false;
  const reader = new ReadableStream({
    pull(controller) {
      produced++;
      controller.enqueue(new Uint8Array(64 * 1024));
      if (produced === 10) abort.abort(new Error('Fixture cancellation'));
    },
    cancel() { cancelled = true; },
  }, { highWaterMark: 1 });
  await assert.rejects(archive.writer.add('cancel.bin', reader, { signal: abort.signal, level: 0 }), /Fixture cancellation/);
  await assert.rejects(archive.writer.close(), /Fixture cancellation/);
  await archive.closeHandle();
  assert.equal(cancelled, true);
  assert.deepEqual(await readdir(directory), ['keep.txt']);
  assert.equal(await readFile(sentinel, 'utf8'), 'keep');
});

test('already-aborted creation and exclusive creation preserve existing files', async (t) => {
  const { directory, path } = await fixture(t);
  await writeFile(path, 'existing archive');
  await assert.rejects(createBoundedArchive(path), { code: 'EEXIST' });
  await assert.rejects(createBoundedArchive(join(directory, 'aborted.zip'), { signal: AbortSignal.abort() }), { name: 'AbortError' });
  assert.equal(await readFile(path, 'utf8'), 'existing archive');
  assert.deepEqual(await readdir(directory), ['backup.zip']);
});

test('disposal cancels a STORE source waiting for its first chunk', async (t) => {
  const { directory, path } = await fixture(t);
  const archive = await createBoundedArchive(path, { level: 0 });
  let started;
  const pulling = new Promise((resolve) => { started = resolve; });
  let cancelled = false;
  const pending = archive.writer.add('waiting.bin', new ReadableStream({
    pull() { started(); },
    cancel() { cancelled = true; },
  }));
  await pulling;
  const disposing = archive.closeHandle();
  await assert.rejects(pending, /disposed/);
  await disposing;
  assert.equal(cancelled, true);
  assert.deepEqual(await readdir(directory), []);
});

test('concurrent calls cancel the active write instead of queueing readers', async (t) => {
  const { directory, path } = await fixture(t);
  const archive = await createBoundedArchive(path);
  const pending = archive.writer.add('first.txt', new TextReader('one'));
  await assert.rejects(archive.writer.add('second.txt', new TextReader('two')), /strictly sequential/);
  await assert.rejects(pending, /strictly sequential/);
  await assert.rejects(archive.writer.close(), /strictly sequential/);
  await archive.closeHandle();
  assert.deepEqual(await readdir(directory), []);
});
