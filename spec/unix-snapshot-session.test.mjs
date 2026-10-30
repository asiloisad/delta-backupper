import test from 'node:test';
import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { attachPosixSnapshotSourceSession, validatePosixSnapshotLease } from '../src/platform/unix-snapshot-session.ts';

const clientUid = process.getuid?.() ?? 1000;
const sessionId = '12345678-1234-4234-8234-123456789abc';
const namespace = `/run/delta-backupper/${clientUid}/${sessionId}`;
const sources = [{ id: 'source_a', path: '/data/source', filters: { include: [], exclude: [] } }];
const task = { snapshot: { mode: 'snapshot-only', fallback: 'fail', lvmCowSizeBytes: 8 * 1024 ** 3 }, sources, symlinks: 'follow' };
function evidence(patch = {}) { return { schemaVersion: 1, platform: 'linux', backend: 'btrfs', consistentSnapshot: true, sessionId, clientUid, helperElevated: true, readOnly: true, consistency: 'filesystem', atomicSet: false, mappings: [{ root: '/data', snapshotPath: `${namespace}/fs`, identity: 'btrfs:pinned', device: '7' }], ...patch }; }
function metadata(kind, inode, contents = '') { return { dev: 7n, ino: BigInt(inode), mode: kind === 'directory' ? 0o40755n : 0o100644n, size: BigInt(Buffer.byteLength(contents)), mtimeNs: 1700000000000000000n, isDirectory: () => kind === 'directory', isFile: () => kind === 'file', isSymbolicLink: () => kind === 'symlink' }; }
function fixture() {
  const contents = Buffer.from('PINNED snapshot bytes'); const entries = new Map([[`${namespace}/fs`, metadata('directory', 1)], [`${namespace}/fs/source`, metadata('directory', 2)], [`${namespace}/fs/source/file.txt`, metadata('file', 3, contents.toString())]]);
  const calls = []; let closed = 0;
  const io = {
    async lstat(value) { calls.push(['lstat', value]); assert.ok(value.startsWith(`${namespace}/`), `unexpected live read ${value}`); if (!entries.has(value)) throw Object.assign(new Error('missing snapshot file'), { code: 'ENOENT' }); return entries.get(value); },
    async readlink() { throw new Error('unexpected link read'); },
    async opendir(value) { assert.equal(value, `${namespace}/fs/source`); return (async function* () { yield { name: 'file.txt' }; })(); },
    async realpath(value) { assert.equal(value, '/backup'); return value; },
    async open(value, flags) {
      calls.push(['open', value]); assert.equal(value, `${namespace}/fs/source/file.txt`); assert.equal(flags & constants.O_NOFOLLOW, constants.O_NOFOLLOW); let offset = 0;
      return { async stat() { return entries.get(value); }, async read(buffer, start, length) { const amount = Math.min(length, contents.length - offset); contents.copy(buffer, start, offset, offset + amount); offset += amount; return { bytesRead: amount, buffer }; }, async close() { closed++; } };
    },
  };
  return { io, entries, calls, contents, closed: () => closed };
}

test('POSIX attestation accepts bounded platform-specific, read-only mappings and root filesystem snapshots', () => {
  const linux = validatePosixSnapshotLease(evidence(), 'linux'); assert.equal(linux.backend, 'btrfs'); assert.equal(linux.atomicSet, false);
  assert.equal(validatePosixSnapshotLease(evidence({ mappings: [{ ...evidence().mappings[0], root: '/' }] }), 'linux').mappings[0].root, '/');
  const darwin = evidence({ platform: 'darwin', backend: 'apfs', mappings: [{ ...evidence().mappings[0], snapshotPath: `/private/var/run/delta-backupper/${clientUid}/${sessionId}/fs` }] });
  assert.equal(validatePosixSnapshotLease(darwin, 'darwin').platform, 'darwin');
  const aliases = evidence({ mappings: [evidence().mappings[0], { ...evidence().mappings[0], root: '/alias' }] }); assert.equal(validatePosixSnapshotLease(aliases, 'linux').mappings.length, 2);
  assert.equal(linux.mappings[0].caseSensitive, true); assert.equal(validatePosixSnapshotLease(evidence({ mappings: [{ ...evidence().mappings[0], caseSensitive: false }] }), 'linux').mappings[0].caseSensitive, false);
});
for (const [label, patch] of [
  ['wrong platform', { platform: 'darwin' }], ['unprivileged helper', { helperElevated: false }], ['writable mount', { readOnly: false }], ['unconfirmed snapshot', { consistentSnapshot: false }], ['application consistency', { consistency: 'application' }], ['missing atomicity', { atomicSet: undefined }], ['invalid session UUID', { sessionId: '../session' }], ['invalid UID', { clientUid: -1 }], ['wrong backend', { backend: 'apfs' }], ['empty mappings', { mappings: [] }],
  ['foreign namespace', { mappings: [{ ...evidence().mappings[0], snapshotPath: '/tmp/arbitrary' }] }], ['namespace prefix confusion', { mappings: [{ ...evidence().mappings[0], snapshotPath: `${namespace}-other/fs` }] }], ['namespace root', { mappings: [{ ...evidence().mappings[0], snapshotPath: namespace }] }], ['logical workspace root', { mappings: [{ ...evidence().mappings[0], root: `${namespace}/live` }] }], ['traversal', { mappings: [{ ...evidence().mappings[0], root: '/data/../data' }] }], ['numeric device', { mappings: [{ ...evidence().mappings[0], device: 7 }] }], ['duplicate logical root', { mappings: [evidence().mappings[0], evidence().mappings[0]] }], ['foreign exclusion', { mappings: [{ ...evidence().mappings[0], excludedRoots: ['/outside'] }] }], ['ignored entire source', { mappings: [{ ...evidence().mappings[0], ignoredRoots: ['/data'] }] }],
  ['invalid case sensitivity', { mappings: [{ ...evidence().mappings[0], caseSensitive: 'false' }] }],
]) test(`POSIX attestation rejects ${label} before filesystem access`, () => assert.throws(() => validatePosixSnapshotLease(evidence(patch), 'linux')));

test('POSIX source session requires authenticated health checks and does not invent writer coordination', () => {
  assert.throws(() => attachPosixSnapshotSourceSession(task, sources, evidence(), async () => {}, undefined, undefined, { platform: 'linux' }), /health check/);
  assert.throws(() => attachPosixSnapshotSourceSession({ ...task, snapshot: { ...task.snapshot, mode: 'writers' } }, sources, evidence(), async () => {}, undefined, async () => {}, { platform: 'linux' }), /file-system snapshot mode/);
});
test('POSIX scanning emits only logical bounded file identities and final verification rechecks mount devices', async () => {
  const f = fixture(); let checks = 0;
  const session = attachPosixSnapshotSourceSession(task, sources, evidence(), async () => {}, undefined, async () => { checks++; }, { platform: 'linux', io: f.io });
  assert.deepEqual(session.sources[0].filters, sources[0].filters); assert.equal(session.sources[0].path, `${namespace}/fs/source`);
  await session.validateSources(); const entries = []; for await (const entry of session.scan(task, '/backup', {})) entries.push(entry);
  const file = entries.find(entry => entry.kind === 'file'); assert.equal(file.path, 'file.txt'); const identity = JSON.parse(file.providerEntryId); assert.equal(identity.logical, '/data/source/file.txt'); assert.ok(!file.providerEntryId.includes(namespace)); assert.equal(identity.device, '7'); assert.equal(identity.inode, '3');
  assert.equal(session.sourceConsistency, 'filesystem-snapshot'); assert.equal(session.atomicSet, false); await session.verify(); assert.equal(checks, 2);
  f.entries.set(`${namespace}/fs`, { ...metadata('directory', 1), dev: 8n }); await assert.rejects(session.verify(), /mount identity changed/);
});

test('POSIX source-session mapping preserves source filters and applies them in the ordinary snapshot scanner', async () => {
  const f = fixture(), filtered = [{ ...sources[0], filters: { include: ['**/*.txt'], exclude: ['file.txt'] } }], original = structuredClone(filtered);
  const session = attachPosixSnapshotSourceSession({ ...task, sources: filtered }, filtered, evidence(), async () => {}, undefined, async () => {}, { platform: 'linux', io: f.io });
  assert.deepEqual(session.sources[0].filters, filtered[0].filters); assert.deepEqual((await Array.fromAsync(session.scan(task, '/backup', {}))).map(entry => entry.path), ['']); assert.deepEqual(filtered, original);
});
test('POSIX file open checks its scanned inode and health before opening any file', async () => {
  const f = fixture(); let invalid = false;
  const session = attachPosixSnapshotSourceSession(task, sources, evidence(), async () => {}, undefined, async () => { if (invalid) throw new Error('LVM snapshot became invalid'); }, { platform: 'linux', io: f.io });
  const entries = []; for await (const entry of session.scan(task, '/backup', {})) entries.push(entry); const file = entries.find(entry => entry.kind === 'file');
  await assert.rejects(session.openFile({ ...file, providerEntryId: undefined }, {}), /entry identity/);
  f.entries.set(file.absolute, metadata('file', 99, f.contents.toString())); await assert.rejects(session.openFile(file, {}), /identity changed/);
  invalid = true; await assert.rejects(session.openFile(file, {}), /became invalid/); assert.equal(f.calls.filter(call => call[0] === 'open').length, 0);
});
test('POSIX cached health avoids rechecking every mount while publication always requests fresh verification', async () => {
  const f = fixture(), checks = [];
  const session = attachPosixSnapshotSourceSession(task, sources, evidence(), async () => {}, undefined, async options => { checks.push(options); }, { platform: 'linux', io: f.io });
  await session.verify({ fresh: false }); assert.deepEqual(checks, [{ fresh: false }]); assert.equal(f.calls.length, 0);
  await session.verify(); assert.deepEqual(checks.at(-1), { fresh: true }); assert.ok(f.calls.some(call => call[1] === `${namespace}/fs`));
  f.calls.length = 0; await session.validateSources(); assert.deepEqual(checks.at(-1), { fresh: true }); assert.ok(f.calls.length > 0);
  const entries = []; for await (const entry of session.scan(task, '/backup', {})) entries.push(entry); const file = entries.find(entry => entry.kind === 'file');
  await session.openFile({ ...file, providerEntryId: undefined }, {}).catch(() => {}); assert.deepEqual(checks.at(-1), { fresh: false });
});
test('POSIX ordinary reader requires native O_NOFOLLOW and returns the exact bounded content hash', { skip: process.platform === 'win32' }, async () => {
  const f = fixture(); const session = attachPosixSnapshotSourceSession(task, sources, evidence(), async () => {}, undefined, async () => {}, { platform: 'linux', io: f.io });
  const entries = []; for await (const entry of session.scan(task, '/backup', {})) entries.push(entry); const input = await session.openFile(entries.find(entry => entry.kind === 'file'), {});
  const reader = input.reader.readable.getReader(), chunks = []; for (;;) { const value = await reader.read(); if (value.done) break; chunks.push(value.value); } reader.releaseLock(); await input.close();
  assert.deepEqual(Buffer.concat(chunks), f.contents); assert.equal(input.digest(), createHash('sha256').update(f.contents).digest('hex')); assert.equal(f.closed(), 1);
});
test('a platform without O_NOFOLLOW never opens the snapshot through a weaker fallback', { skip: typeof constants.O_NOFOLLOW === 'number' }, async () => {
  const f = fixture(); const session = attachPosixSnapshotSourceSession(task, sources, evidence(), async () => {}, undefined, async () => {}, { platform: 'linux', io: f.io });
  const entries = []; for await (const entry of session.scan(task, '/backup', {})) entries.push(entry); await assert.rejects(session.openFile(entries.find(entry => entry.kind === 'file'), {}), /cannot safely open/); assert.equal(f.calls.filter(call => call[0] === 'open').length, 0);
});
