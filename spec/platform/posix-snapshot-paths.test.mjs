import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createPosixSnapshotPathResolver, createPosixSnapshotScanner } from '../../src/platform/posix-snapshot-paths.mjs';

const mapping = { root: '/live', snapshotPath: '/snapshot', identity: 'snapshot-one' };
const secondMapping = { root: '/other', snapshotPath: '/snapshot-other', identity: 'snapshot-two' };
const task = { symlinks: 'follow' };
const base = () => ({ '/snapshot': { kind: 'directory' }, '/snapshot/src': { kind: 'directory' }, '/snapshot/target': { kind: 'directory' }, '/snapshot/target/a': { kind: 'file' } });
function virtual(entries) {
  const calls = []; const keys = Object.keys(entries);
  function snapshot(value) { assert.ok(value === '/snapshot' || value.startsWith('/snapshot/') || value === '/snapshot-other' || value.startsWith('/snapshot-other/'), `Live filesystem access: ${value}`); }
  return {
    calls,
    async lstat(value) {
      snapshot(value); calls.push(['lstat', value]); const entry = entries[value];
      if (!entry) throw Object.assign(new Error('missing snapshot path'), { code: 'ENOENT' });
      return { dev: 1n, ino: BigInt(keys.indexOf(value) + 1), size: 8n, mtimeNs: 1700000000000000000n, mode: 0o100644n, ...entry, isDirectory: () => entry.kind === 'directory', isFile: () => entry.kind === 'file', isSymbolicLink: () => entry.kind === 'link' };
    },
    async readlink(value) { snapshot(value); calls.push(['readlink', value]); return entries[value].target; },
    async* opendir(value) {
      snapshot(value); calls.push(['opendir', value]);
      for (const key of Object.keys(entries)) if (key.startsWith(`${value}/`) && !key.slice(value.length + 1).includes('/')) yield { name: key.slice(value.length + 1) };
    },
    async realpath(value) { calls.push(['destination-realpath', value]); return value; },
  };
}

test('POSIX mapped source scanners keep per-source filters isolated and relative to each source', async () => {
  const entries = { '/snapshot': { kind: 'directory' } }, sources = [{ id: 'first', path: '/live/first', filters: { include: ['**/*.txt'], exclude: ['**/denied.txt', 'nested/private/**'] } }, { id: 'second', path: '/live/second', filters: { include: ['**/*.log', 'nested/shared.txt'], exclude: ['**/denied.*'] } }];
  for (const root of ['first', 'second']) { entries[`/snapshot/${root}`] = { kind: 'directory' }; entries[`/snapshot/${root}/nested`] = { kind: 'directory' }; entries[`/snapshot/${root}/nested/private`] = { kind: 'directory' }; for (const name of ['shared.txt', 'shared.log', 'denied.txt', 'denied.log', 'nested/shared.txt', 'nested/shared.log', 'nested/private/hidden.txt']) entries[`/snapshot/${root}/${name}`] = { kind: 'file' }; }
  const original = structuredClone(sources), rows = await Array.fromAsync(createPosixSnapshotScanner(sources, [mapping], virtual(entries))(task, '/backup')); assert.deepEqual(sources, original); assert.deepEqual(rows.filter(row => row.kind === 'file').map(row => `${row.sourceId}/${row.path}`).sort(), ['first/nested/shared.txt', 'first/shared.txt', 'second/nested/shared.log', 'second/nested/shared.txt', 'second/shared.log']);
});

for (const target of ['/live/target', '../target', '../target/', '/live//target']) test(`POSIX snapshot resolves ${JSON.stringify(target)} using snapshot components only`, async () => {
  const entries = base(); entries['/snapshot/src/link'] = { kind: 'link', target }; const io = virtual(entries);
  const resolved = await createPosixSnapshotPathResolver([mapping], io).resolve('/live/src/link/a');
  assert.equal(resolved.absolute, '/snapshot/target/a'); assert.equal(resolved.logicalPath, '/live/target/a');
  assert.ok(!io.calls.some(([, value]) => value.startsWith('/snapshot/src/link/')));
});
test('POSIX snapshot link/../ resolves the link before its parent component', async () => {
  const entries = base(); entries['/snapshot/src/link'] = { kind: 'link', target: '/live/target/subdir/../a' }; entries['/snapshot/target/subdir'] = { kind: 'link', target: '/other/nested/dir' }; entries['/snapshot-other'] = { kind: 'directory' }; entries['/snapshot-other/nested'] = { kind: 'directory' }; entries['/snapshot-other/nested/dir'] = { kind: 'directory' }; entries['/snapshot-other/nested/a'] = { kind: 'file' };
  const result = await createPosixSnapshotPathResolver([mapping, secondMapping], virtual(entries)).resolve('/live/src/link');
  assert.equal(result.absolute, '/snapshot-other/nested/a');
});
test('POSIX snapshot permits a repeated link with a shorter remaining suffix', async () => {
  const entries = base(); entries['/snapshot/link'] = { kind: 'link', target: '/live/target' };
  const result = await createPosixSnapshotPathResolver([mapping], virtual(entries)).resolve('/live/link/../link/a');
  assert.equal(result.absolute, '/snapshot/target/a');
});
test('POSIX snapshot crosses only independently leased filesystems', async () => {
  const entries = base(); entries['/snapshot/src/link'] = { kind: 'link', target: '/other/a' }; entries['/snapshot-other'] = { kind: 'directory', dev: 2n }; entries['/snapshot-other/a'] = { kind: 'file', dev: 2n };
  await assert.rejects(createPosixSnapshotPathResolver([mapping], virtual(entries)).resolve('/live/src/link'), /outside the snapshot lease/);
  assert.equal((await createPosixSnapshotPathResolver([mapping, secondMapping], virtual(entries)).resolve('/live/src/link')).absolute, '/snapshot-other/a');
});
test('POSIX snapshot paths use exact components and case-sensitive identities', async () => {
  const entries = base(); entries['/snapshot/src/Link'] = { kind: 'link', target: '/unleased/a' }; entries['/snapshot/src/link'] = { kind: 'directory' }; entries['/snapshot/src/link/a'] = { kind: 'file' };
  const resolver = createPosixSnapshotPathResolver([mapping], virtual(entries));
  assert.equal((await resolver.resolve('/live/src/link/a')).absolute, '/snapshot/src/link/a');
  await assert.rejects(resolver.resolve('/live/src/Link/a'), /outside the snapshot lease/);
  await assert.rejects(resolver.resolve('/live-other/a'), /outside the snapshot lease/);
  await assert.rejects(resolver.resolve('/Live/src/link/a'), /outside the snapshot lease/);
});
test('POSIX snapshot routing folds root aliases only for an attested case-insensitive volume', async () => {
  const entries = { '/snapshot': { kind: 'directory' }, '/snapshot/a': { kind: 'file' } };
  const insensitive = createPosixSnapshotPathResolver([{ ...mapping, root: '/Users', caseSensitive: false }], virtual(entries));
  assert.equal((await insensitive.resolve('/users/a')).absolute, '/snapshot/a');
  await assert.rejects(createPosixSnapshotPathResolver([{ ...mapping, root: '/Users', caseSensitive: true }], virtual(entries)).resolve('/users/a'), /outside the snapshot lease/);
  await assert.rejects(createPosixSnapshotPathResolver([{ ...mapping, root: '/Users', caseSensitive: false, excludedRoots: ['/users/private'] }], virtual(entries)).resolve('/Users/PRIVATE/a'), { code: 'SNAPSHOT_MOUNT_UNAVAILABLE' });
});
test('POSIX snapshot scanner omits only helper-owned infrastructure roots, including followed aliases', async () => {
  const entries = base(); entries['/snapshot/src/internal'] = { kind: 'directory' }; entries['/snapshot/src/internal/pinned'] = { kind: 'file' }; entries['/snapshot/src/alias'] = { kind: 'link', target: '/live/src/internal' }; entries['/snapshot/src/keep'] = { kind: 'file' };
  const scan = createPosixSnapshotScanner([{ id: 'source', path: '/live/src' }], [{ ...mapping, ignoredRoots: ['/live/src/internal'] }], virtual(entries));
  const result = await Array.fromAsync(scan(task, '/backup'));
  assert.deepEqual(result.map(entry => entry.path), ['', 'keep']);
  await assert.rejects(Array.fromAsync(createPosixSnapshotScanner([{ id: 'source', path: '/live/src/internal' }], [{ ...mapping, ignoredRoots: ['/live/src/internal'] }], virtual(entries))(task, '/backup')), { code: 'SNAPSHOT_INTERNAL_PATH' });
});
test('POSIX snapshot selects independently leased nested mount roots without reading parent stubs', async () => {
  const entries = base(); entries['/snapshot-other'] = { kind: 'directory', dev: 9n }; entries['/snapshot-other/a'] = { kind: 'file', dev: 9n };
  const io = virtual(entries); const nested = { ...secondMapping, root: '/live/src/mount' };
  const resolver = createPosixSnapshotPathResolver([{ ...mapping, excludedRoots: ['/live/src/mount'] }, nested], io);
  assert.equal((await resolver.resolve('/live/src/mount/a')).absolute, '/snapshot-other/a');
  assert.ok(!io.calls.some(([, value]) => value === '/snapshot/src/mount'));
});
for (const kind of ['file', 'directory', 'link']) test(`POSIX snapshot rejects an unleased st_dev change at a ${kind}`, async () => {
  const entries = base(); entries['/snapshot/src/mount'] = { kind, dev: 7n, target: '/live/target' }; const io = virtual(entries);
  await assert.rejects(createPosixSnapshotPathResolver([mapping], io).resolve('/live/src/mount'), { code: 'SNAPSHOT_MOUNT_UNAVAILABLE' });
  assert.ok(!io.calls.some(([operation, value]) => operation === 'readlink' && value === '/snapshot/src/mount'));
});
test('POSIX snapshot excludes opaque mounts/subvolumes even when their snapshot stubs share st_dev', async () => {
  const entries = base(); entries['/snapshot/src/opaque'] = { kind: 'directory' }; const io = virtual(entries);
  await assert.rejects(createPosixSnapshotPathResolver([{ ...mapping, excludedRoots: ['/live/src/opaque'] }], io).resolve('/live/src/opaque'), { code: 'SNAPSHOT_MOUNT_UNAVAILABLE' });
  assert.ok(!io.calls.some(([, value]) => value === '/snapshot/src/opaque'));
});
test('POSIX snapshot checks the attested device and rejects symbolic mount roots', async () => {
  await assert.rejects(createPosixSnapshotPathResolver([{ ...mapping, device: '5' }], virtual(base())).resolve('/live/src'), /identity changed/);
  const entries = base(); entries['/snapshot'] = { kind: 'link', target: '/live' };
  await assert.rejects(createPosixSnapshotPathResolver([mapping], virtual(entries)).resolve('/live/src'), /ordinary directory/);
});
test('POSIX snapshot preserves final links but resolves linked parents', async () => {
  const entries = base(); entries['/snapshot/src/link'] = { kind: 'link', target: '/live/target' }; entries['/snapshot/target/final'] = { kind: 'link', target: '/unleased' };
  const result = await createPosixSnapshotPathResolver([mapping], virtual(entries)).resolve('/live/src/link/final', undefined, { followFinal: false });
  assert.equal(result.absolute, '/snapshot/target/final'); assert.equal(result.info.isSymbolicLink(), true);
});
test('POSIX snapshot bounds cyclic and expanding link chains', async () => {
  for (const target of ['/live/src/link', '/live/src/link/another']) {
    const entries = base(); entries['/snapshot/src/link'] = { kind: 'link', target }; const io = virtual(entries);
    await assert.rejects(createPosixSnapshotPathResolver([mapping], io).resolve('/live/src/link'), { code: 'SNAPSHOT_LINK_LOOP' });
    assert.ok(io.calls.length < 270);
  }
});
test('POSIX snapshot handles root leases, trailing slashes and parent traversal without escaping', async () => {
  const entries = base(); const resolver = createPosixSnapshotPathResolver([{ ...mapping, root: '/live/', snapshotPath: '/snapshot/' }], virtual(entries));
  assert.equal((await resolver.resolve('/live/src/../target/a')).absolute, '/snapshot/target/a');
  await assert.rejects(resolver.resolve('/live/../outside'), /outside the snapshot lease/);
  const rootResolver = createPosixSnapshotPathResolver([{ ...mapping, root: '/' }], virtual(entries));
  assert.equal((await rootResolver.resolve('/src/../target/a')).absolute, '/snapshot/target/a');
});
test('POSIX snapshot rejects parent traversal through a regular file', async () => {
  await assert.rejects(createPosixSnapshotPathResolver([mapping], virtual(base())).resolve('/live/target/a/../a'), { code: 'ENOTDIR' });
});
test('POSIX snapshot mappedPath cannot allow an unresolved parent escape', () => {
  const resolver = createPosixSnapshotPathResolver([mapping], virtual(base()));
  assert.equal(resolver.mappedPath('/live/src/a'), '/snapshot/src/a');
  assert.throws(() => resolver.mappedPath('/live/../../secret'), /traversal/);
  assert.throws(() => resolver.mappedPath('/live/./src/a'), /traversal/);
});
for (const mappings of [[], [mapping, mapping], [{ ...mapping, root: 'relative' }], [{ ...mapping, snapshotPath: '/live' }], [{ ...mapping, identity: '' }], [{ ...mapping, excludedRoots: ['/outside'] }]]) test(`POSIX snapshot rejects invalid mappings ${JSON.stringify(mappings)}`, () => {
  assert.throws(() => createPosixSnapshotPathResolver(mappings));
});
for (const value of ['relative', '/live/\0bad', '/live/\ud800bad']) test(`POSIX snapshot rejects invalid source ${JSON.stringify(value)} before IO`, async () => {
  const io = virtual(base()); await assert.rejects(createPosixSnapshotPathResolver([mapping], io).resolve(value)); assert.equal(io.calls.length, 0);
});
test('POSIX snapshot cancellation is observed before filesystem IO', async () => {
  const controller = new AbortController(); controller.abort(); const io = virtual(base());
  await assert.rejects(createPosixSnapshotPathResolver([mapping], io).resolve('/live/src', controller.signal), { name: 'AbortError' }); assert.equal(io.calls.length, 0);
});
test('POSIX snapshot scanner follows only leased links, preserves and skips link objects', async () => {
  const entries = base(); entries['/snapshot/src/link'] = { kind: 'link', target: '/live/target' }; entries['/snapshot/src/outside'] = { kind: 'link', target: '/unleased/a' }; const source = { id: 'source', path: '/live/src' };
  const scan = createPosixSnapshotScanner([source], [mapping], virtual(entries));
  const followed = await Array.fromAsync(scan(task, '/backup')); assert.equal(followed.find(entry => entry.path === 'link/a').kind, 'file'); assert.equal(followed.find(entry => entry.path === 'outside').kind, 'missing');
  const preserved = await Array.fromAsync(scan({ ...task, symlinks: 'preserve' }, '/backup')); assert.equal(preserved.find(entry => entry.path === 'outside').target, '/unleased/a'); assert.ok(!preserved.some(entry => entry.path === 'link/a'));
  assert.deepEqual((await Array.fromAsync(scan({ ...task, symlinks: 'skip' }, '/backup'))).map(entry => entry.path), ['']);
});
test('POSIX snapshot scanner fails source roots and records descendant mount failures explicitly', async () => {
  const entries = base(); entries['/snapshot/src/mount'] = { kind: 'directory' };
  const scan = createPosixSnapshotScanner([{ id: 'source', path: '/live/src' }], [{ ...mapping, excludedRoots: ['/live/src/mount'] }], virtual(entries));
  const result = await Array.fromAsync(scan(task, '/backup')); assert.equal(result.find(entry => entry.path === 'mount').code, 'SNAPSHOT_MOUNT_UNAVAILABLE');
  await assert.rejects(Array.fromAsync(createPosixSnapshotScanner([{ id: 'source', path: '/live/missing' }], [mapping], virtual(entries))(task, '/backup')), { code: 'ENOENT' });
  await assert.rejects(Array.fromAsync(createPosixSnapshotScanner([{ id: 'source', path: '/unleased' }], [mapping], virtual(entries))(task, '/backup')), /outside the snapshot lease/);
});
test('POSIX snapshot scanner excludes destination paths and followed aliases without dropping differently cased data', async () => {
  const entries = base(); entries['/snapshot/src/Backup'] = { kind: 'directory' }; entries['/snapshot/src/Backup/old'] = { kind: 'file' }; entries['/snapshot/src/backup'] = { kind: 'directory' }; entries['/snapshot/src/backup/keep'] = { kind: 'file' }; entries['/snapshot/src/repository'] = { kind: 'link', target: '/live/src/Backup' };
  const result = await Array.fromAsync(createPosixSnapshotScanner([{ id: 'source', path: '/live/src' }], [mapping], virtual(entries))(task, '/live/src/Backup/'));
  assert.ok(result.some(entry => entry.path === 'backup/keep')); assert.ok(!result.some(entry => entry.path === 'Backup' || entry.path.startsWith('Backup/') || entry.path.startsWith('repository')));
});
test('POSIX snapshot scanner excludes a destination alias by observed inode identity', async () => {
  const entries = base(); entries['/snapshot/src/repository'] = { kind: 'directory', ino: 900n }; entries['/snapshot/src/alias'] = { kind: 'directory', ino: 900n }; entries['/snapshot/src/alias/old'] = { kind: 'file' };
  const result = await Array.fromAsync(createPosixSnapshotScanner([{ id: 'source', path: '/live/src' }], [mapping], virtual(entries))(task, '/live/src/repository'));
  assert.deepEqual(result.map(entry => entry.path), ['']);
});
test('POSIX snapshot scanner keeps directory cycles explicit and supports filters', async () => {
  const entries = base(); entries['/snapshot/src/loop'] = { kind: 'link', target: '/live/src' }; entries['/snapshot/src/keep.txt'] = { kind: 'file' }; entries['/snapshot/src/skip.tmp'] = { kind: 'file' };
  const scan = createPosixSnapshotScanner([{ id: 'source', path: '/live/src', filters: { include: ['*.txt'], exclude: ['skip.*'] } }], [mapping], virtual(entries));
  const result = await Array.fromAsync(scan(task, '/backup'));
  assert.equal(result.find(entry => entry.path === 'loop').code, 'SNAPSHOT_LINK_LOOP'); assert.ok(result.some(entry => entry.path === 'keep.txt')); assert.ok(!result.some(entry => entry.path === 'skip.tmp')); assert.ok(result.length < 5);
  const controller = new AbortController(); controller.abort(); await assert.rejects(Array.fromAsync(scan(task, '/backup', { signal: controller.signal })), { name: 'AbortError' });
});
test('POSIX snapshot scanner consumes directory entries incrementally and closes them on cancellation', async () => {
  const entries = base(); entries['/snapshot/src/first'] = { kind: 'file' }; const io = virtual(entries); let consumed = 0; let closed = false;
  io.opendir = async function* () { try { consumed++; yield { name: 'first' }; consumed++; throw new Error('Scanner read beyond requested entry'); } finally { closed = true; } };
  const stream = createPosixSnapshotScanner([{ id: 'source', path: '/live/src' }], [mapping], io)(task, '/backup');
  assert.equal((await stream.next()).value.kind, 'directory'); assert.equal((await stream.next()).value.path, 'first'); assert.equal(consumed, 1); await stream.return(); assert.equal(closed, true);
});
test('POSIX actual snapshot tree reads pinned bytes through absolute and relative links', { skip: process.platform === 'win32' }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'delta-posix-snapshot-')); t.after(() => rm(root, { recursive: true, force: true }));
  const live = join(root, 'live'); const snapshotPath = join(root, 'snapshot'); const backup = join(root, 'backup');
  for (const directory of [join(live, 'src'), join(live, 'target'), join(snapshotPath, 'src'), join(snapshotPath, 'target'), backup]) await mkdir(directory, { recursive: true });
  await writeFile(join(live, 'target', 'a'), 'Changed LIVE bytes'); await writeFile(join(snapshotPath, 'target', 'a'), 'Pinned SNAPSHOT bytes');
  await symlink(join(live, 'target'), join(snapshotPath, 'src', 'absolute')); await symlink('../target', join(snapshotPath, 'src', 'relative'));
  const rows = await Array.fromAsync(createPosixSnapshotScanner([{ id: 'source', path: join(live, 'src') }], [{ root: live, snapshotPath, identity: 'fixture' }])(task, backup));
  const files = rows.filter(entry => entry.kind === 'file'); assert.equal(files.length, 2);
  for (const entry of files) { assert.ok(entry.absolute.startsWith(`${snapshotPath}/`)); assert.equal(await readFile(entry.absolute, 'utf8'), 'Pinned SNAPSHOT bytes'); }
  assert.equal(await readFile(join(live, 'target', 'a'), 'utf8'), 'Changed LIVE bytes');
});
