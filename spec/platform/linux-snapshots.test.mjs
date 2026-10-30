import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, posix as path } from 'node:path';
import { tmpdir } from 'node:os';

const temporary = await mkdtemp(join(tmpdir(), 'delta-linux-snapshots-'));
test.after(() => rm(temporary, { recursive: true, force: true }));
const bundle = join(temporary, 'backend.cjs');
await build({ entryPoints: ['src/platform/linux-snapshots.ts'], outfile: bundle, bundle: true, platform: 'node', target: 'node24', format: 'cjs', logLevel: 'silent' });
const { prepareLinuxSnapshots, recoverLinuxSnapshots, parseLinuxMountInfo, visibleLinuxMounts, parseBtrfsSubvolumes } = createRequire(import.meta.url)(bundle);
const sessionId = '12345678-1234-4234-8234-123456789abc';
const workspace = `/run/delta-backupper/1000/${sessionId}`;
const originUuid = '11111111-1111-4111-8111-111111111111';
const childUuid = '22222222-2222-4222-8222-222222222222';
const fsUuid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const originLvm = '111111-1111-1111-1111-1111-1111-111111';
const snapshotLvm = '222222-2222-2222-2222-2222-2222-222222';
const mounted = (id, point, type, source, root = '/', device = '8:1', parentId = 1, options = ['rw', 'relatime'], superOptions = ['rw']) => ({ id, parentId, point, type, source, root, device, options, superOptions });
const escapeMount = value => value.replaceAll('\\', '\\134').replaceAll(' ', '\\040').replaceAll('\t', '\\011').replaceAll('\n', '\\012');
const mountText = rows => rows.map(value => `${value.id} ${value.parentId} ${value.device} ${escapeMount(value.root)} ${escapeMount(value.point)} ${value.options.join(',')} - ${value.type} ${escapeMount(value.source)} ${value.superOptions.join(',')}`).join('\n');
function stats(kind = 'directory', values = {}) { return { uid: 0n, gid: 0n, mode: 0o755n, dev: 1n, ino: 1n, rdev: 0n, size: 0n, mtimeNs: 1n, ...values, isDirectory: () => kind === 'directory', isSymbolicLink: () => kind === 'link', isBlockDevice: () => kind === 'block', isFile: () => kind === 'file' }; }

function machine(backend = 'btrfs', options = {}) {
  let nextInode = 100n; let nextMount = 100; let state; const journals = []; const calls = []; const directories = new Map(); const files = new Map(); const objects = new Map(); const snapshots = new Map(); const volumes = new Map(); const holds = new Set();
  const root = mounted(1, '/', 'ext4', '/dev/root', '/', '8:9', 0);
  const source = mounted(10, '/data', backend === 'lvm' ? options.type ?? 'ext4' : backend, backend === 'btrfs' ? '/dev/sda1' : backend === 'zfs' ? 'pool/data' : '/dev/dm-0', backend === 'btrfs' ? '/@home' : '/', backend === 'lvm' ? '253:0' : '0:20');
  if (options.bindRoot) source.root = options.bindRoot;
  if (options.id5) source.root = '/';
  const rows = [root, source];
  if (options.nestedMount) rows.push(mounted(11, '/data/nas', 'nfs4', 'server:/share', '/', '0:22', 10));
  if (options.zfsChild) rows.push(mounted(11, '/data/child', 'zfs', 'pool/child', '/', '0:23', 10));
  for (const filename of ['/', '/run', '/run/delta-backupper', '/run/delta-backupper/1000', workspace, '/data', '/data/src', '/data/nested', '/data/child', '/dev']) directories.set(filename, stats('directory', { ino: nextInode++ }));
  const subvolumes = [{ id: '256', uuid: originUuid, fsPath: '/@home' }, ...(options.nestedSubvolume ? [{ id: '257', uuid: childUuid, fsPath: '/@home/nested' }] : [])];
  const origin = { vg_name: 'vg', lv_name: 'data', lv_uuid: originLvm, lv_path: '/dev/vg/data', origin: '', origin_uuid: '', pool_lv: options.thin ? 'pool' : '', lv_attr: options.thin ? 'Vwi-a-tz--' : '-wi-a-----', data_percent: '', metadata_percent: '', snap_percent: '', lv_health_status: '', lv_kernel_major: '253', lv_kernel_minor: '0', lv_tags: '' };
  volumes.set('vg/data', origin);
  function mustIntent(kind, key, value) { assert.ok(state?.actions.some(action => action.kind === kind && action[key] === value), `Missing durable ${kind} intent before mutation ${value}`); }
  function nearest(filename) { return [...rows].filter(row => filename === row.point || filename.startsWith(`${row.point}/`) || row.point === '/').sort((a, b) => b.point.length - a.point.length)[0]; }
  function mountStats(row) { return stats('directory', { dev: BigInt(row.device.split(':')[1]) + 1000n, ino: 256n }); }
  const io = {
    async readFile(filename) { if (filename === '/proc/self/mountinfo') return mountText(rows); assert.ok(files.has(filename), filename); return files.get(filename).data; },
    async realpath(filename) { return filename === '/dev/vg/data' ? '/dev/dm-0' : filename; },
    async lstat(filename) {
      if (filename === '/dev/sda1' || filename === '/dev/dm-0' || filename.startsWith('/dev/vg/delta_')) return stats('block', { rdev: filename === '/dev/sda1' ? 2049n : filename.startsWith('/dev/vg/delta_') ? 64769n : 64768n });
      const mount = rows.find(row => row.point === filename); if (mount && mount.id >= 100) return mountStats(mount);
      if (objects.has(filename)) return stats('directory', { dev: BigInt(objects.get(filename).id), ino: 256n });
      if (files.has(filename)) return stats('file', { mode: 0o600n, size: BigInt(files.get(filename).data.length), ino: files.get(filename).ino });
      const node = directories.get(filename);
      if (node) {
        const view = nearest(filename);
        if (filename.startsWith(`${workspace}/private/btrfs-top-`) && filename.split('/').length > workspace.split('/').length + 2 && view.id < 100) throw Object.assign(new Error('unmounted view'), { code: 'ENOENT' });
        return node;
      }
      const view = nearest(filename);
      if (view.id >= 100 && view.type === 'btrfs' && view.root === '/' && (filename.startsWith(`${view.point}/@home`) || filename === `${view.point}/.delta-backupper-snapshots`)) {
        if (filename === `${view.point}/.delta-backupper-snapshots`) throw Object.assign(new Error('namespace absent'), { code: 'ENOENT' });
        return stats('directory', { dev: mountStats(view).dev, ino: 256n });
      }
      if (view.id >= 100 && view.options.includes('ro') && filename.startsWith(`${view.point}/`)) return stats('directory', { dev: mountStats(view).dev, ino: 2000n });
      throw Object.assign(new Error(`absent ${filename}`), { code: 'ENOENT' });
    },
    async mkdir(filename, { mode }) {
      mustIntent('directory', 'path', filename);
      if (directories.has(filename)) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
      const parent = await io.lstat(path.dirname(filename)); directories.set(filename, stats('directory', { mode: BigInt(mode), dev: parent.dev, ino: nextInode++ }));
    },
    async rmdir(filename) {
      assert.ok(!rows.some(row => row.point === filename), 'Attempted rmdir of a mounted tree');
      const node = directories.get(filename); if (!node) throw Object.assign(new Error('absent'), { code: 'ENOENT' });
      if ([...directories].some(([child, info]) => child.startsWith(`${filename}/`) && info.dev === node.dev) || [...objects.keys()].some(child => child.startsWith(`${filename}/`)) || [...files.keys()].some(child => path.dirname(child) === filename)) throw Object.assign(new Error('nonempty'), { code: 'ENOTEMPTY' });
      directories.delete(filename);
    },
    async readdir(filename) { return [...new Set([...directories.keys(), ...files.keys(), ...objects.keys()].filter(child => path.dirname(child) === filename && child !== filename).map(child => path.basename(child)))]; },
    async unlink(filename) { assert.ok(files.has(filename)); files.delete(filename); },
    async open(filename, flags) {
      if (flags === 'wx') {
        assert.ok(state.actions.some(action => action.kind === 'directory' && action.path === path.dirname(filename) && action.namespaceUuid === fsUuid) || state.actions.some(action => action.kind === 'session-marker' && action.path === filename && action.filesystemUuid === fsUuid));
        assert.ok(!files.has(filename)); files.set(filename, { data: '', ino: nextInode++ });
        return { async writeFile(data) { files.get(filename).data = data; }, async sync() {}, async close() {} };
      }
      assert.equal(flags, 'r'); assert.ok(directories.has(filename)); return { async writeFile() { assert.fail('Cannot write a directory'); }, async sync() {}, async close() {} };
    },
  };
  async function run(executable, args, execution = {}) {
    calls.push([executable, [...args], execution]);
    if (options.fail?.(executable, args)) throw new Error(`Injected ${executable} failure`);
    let stdout = '';
    if (executable === 'mount') {
      const type = args[1], flags = args[3].split(','), target = args.at(-1), from = args.at(-2); mustIntent('mount', 'point', target);
      let rootPath = '/'; let dev = '0:30';
      if (type === 'btrfs') { const id = flags.find(flag => flag.startsWith('subvolid=')).split('=')[1]; if (id !== '5') { const [object] = [...objects].find(([, value]) => value.id === id) ?? []; assert.ok(object, 'Mounted snapshot ID must exist'); rootPath = object.slice(object.indexOf('/.delta-backupper-snapshots')); } dev = `0:${id === '5' ? 20 : id}`; }
      else if (type === 'zfs') assert.ok(snapshots.has(from));
      else dev = '253:1';
      rows.push(mounted(nextMount++, target, type, from, rootPath, dev, 1, flags.filter(flag => ['ro', 'rw', 'nosuid', 'nodev', 'noexec'].includes(flag)), flags));
    } else if (executable === 'umount') {
      const target = args.at(-1); const index = rows.findIndex(row => row.point === target); assert.ok(index >= 0); rows.splice(index, 1);
    } else if (executable === 'btrfs') {
      if (args[0] === 'filesystem') stdout = `Label: none  uuid: ${fsUuid}\n`;
      else if (args[0] === 'inspect-internal') stdout = args.at(-1).startsWith(workspace) || options.id5 ? '5\n' : '256\n';
      else if (args[1] === 'list') stdout = [...subvolumes, ...[...objects].map(([object, value]) => ({ id: value.id, uuid: value.uuid, fsPath: object.slice(object.indexOf('/.delta-backupper-snapshots')) }))].map(row => `ID ${row.id} gen 1 top level 5 uuid ${row.uuid} path ${row.fsPath.slice(1)}`).join('\n');
      else if (args[1] === 'snapshot') {
        const target = args.at(-1), from = args.at(-2); mustIntent('btrfs', 'object', target); const sourceVolume = subvolumes.find(row => from.endsWith(row.fsPath)) ?? (options.id5 && /^btrfs-top-\d+$/.test(path.basename(from)) ? { uuid: '-' } : undefined); assert.ok(sourceVolume);
        objects.set(target, { id: String(300 + objects.size), uuid: `bbbbbbbb-bbbb-4bbb-8bbb-${String(objects.size + 1).padStart(12, '0')}`, parentUuid: sourceVolume.uuid, readOnly: true });
      } else if (args[1] === 'show') {
        const object = objects.get(args.at(-1)); if (!object) throw Object.assign(new Error('absent'), { code: 'ENOENT' });
        stdout = `UUID: ${object.uuid}\nParent UUID: ${object.parentUuid}\nSubvolume ID: ${object.id}\nFlags: ${object.readOnly ? 'readonly' : '-'}\n`;
      } else if (args[1] === 'delete') { assert.ok(args.includes('--commit-after')); assert.ok(!args.includes('-r')); objects.delete(args.at(-1)); }
      else assert.fail(`Unexpected btrfs command ${args.join(' ')}`);
    } else if (executable === 'zfs') {
      const name = args.at(-1);
      if (args[0] === 'list' && args.includes('filesystem')) stdout = `pool/data\t11\t/data\tyes\n${options.zfsChild ? 'pool/child\t12\t/data/child\tyes\n' : ''}`;
      else if (args[0] === 'list') {
        const custom = args.includes('name,guid,org.delta-backupper:session'); const recursive = args.includes('-r');
        stdout = [...snapshots].filter(([key]) => recursive ? key.startsWith(`${name}/`) || key.startsWith(`${name}@`) : key.split('@')[0] === name).map(([key, value]) => `${key}\t${value.guid}${custom ? `\t${value.session}` : ''}`).join('\n');
      } else if (args[0] === 'snapshot') {
        for (const snapshot of args.slice(3)) { mustIntent('zfs', 'name', snapshot); snapshots.set(snapshot, { guid: String(100 + snapshots.size), session: sessionId }); }
      } else if (args[0] === 'get' && args.includes('value')) stdout = `${name === 'pool/child' ? '12' : '11'}\n`;
      else if (args[0] === 'get') { const snapshot = snapshots.get(name); if (!snapshot) throw new Error('absent snapshot'); stdout = `guid\t${snapshot.guid}\norg.delta-backupper:session\t${snapshot.session}\n`; }
      else if (args[0] === 'hold') for (const snapshot of args.slice(2)) holds.add(snapshot);
      else if (args[0] === 'holds') stdout = holds.has(name) ? `${name}\tdelta-backupper-${sessionId}\t123\n` : '';
      else if (args[0] === 'release') holds.delete(name);
      else if (args[0] === 'destroy') { assert.ok(!holds.has(name)); assert.ok(!args.includes('-r')); snapshots.delete(name); }
      else assert.fail(`Unexpected zfs command ${args.join(' ')}`);
    } else if (executable === 'lvs') stdout = JSON.stringify({ report: [{ lv: [...volumes.values()] }] });
    else if (executable === 'lvcreate') {
      const name = args[args.indexOf('--name') + 1], tag = args[args.indexOf('--addtag') + 1]; mustIntent('lvm', 'name', name);
      volumes.set(`vg/${name}`, { ...origin, lv_name: name, lv_uuid: snapshotLvm, lv_path: `/dev/vg/${name}`, origin: 'data', origin_uuid: originLvm, lv_attr: 'sri-a-s---', snap_percent: '0.1', lv_kernel_minor: '1', lv_tags: tag });
    } else if (executable === 'lvremove') { const name = args.at(-1); assert.ok(args.includes(`lv_uuid=${volumes.get(name).lv_uuid}`)); assert.ok(!args.includes('--force')); volumes.delete(name); }
    else assert.fail(`Unexpected command ${executable} ${args.join(' ')}`);
    return { stdout, stderr: '' };
  }
  const context = { sessionId, workspace, fs: io, run, async journal(value) { state = structuredClone(value); journals.push(state); } };
  return { context, rows, source, subvolumes, directories, files, objects, snapshots, volumes, holds, calls, journals, state: () => structuredClone(state), sourceConfig: { id: 'source', path: options.whole ? '/data' : '/data/src' } };
}

test('Linux mountinfo parses escaped roots, custom mounts, filesystem roots and optional fields', () => {
  const rows = parseLinuxMountInfo('36 35 98:0 /source\\040root /target\\040root rw,noatime shared:1 - ext4 /dev/dm-0 rw,errors=continue\n');
  assert.equal(rows[0].root, '/source root'); assert.equal(rows[0].point, '/target root'); assert.equal(rows[0].device, '98:0'); assert.equal(rows[0].parentId, 35);
});
test('Linux mountinfo hides mounts beneath an overmounted parent and handles self-parent roots', () => {
  const rows = [mounted(1, '/', 'ext4', '/dev/root', '/', '8:1', 1), mounted(2, '/data', 'ext4', '/dev/old'), mounted(3, '/data/hidden', 'ext4', '/dev/hidden', '/', '8:2', 2), mounted(4, '/data', 'zfs', 'pool/new', '/', '0:3', 2), mounted(5, '/data/new', 'zfs', 'pool/new/child', '/', '0:4', 4)];
  assert.deepEqual(visibleLinuxMounts(rows).map(row => row.id).sort(), [1, 4, 5]);
});
for (const input of ['1 0 8:1 / / rw - ext4 /dev/root', '1 0 8:1 / /bad\\999 rw - ext4 /dev/root rw', '1 0 8:1 / / rw - ext4 /dev/root rw\n1 0 8:2 / /other rw - ext4 /dev/other rw']) test('Linux mountinfo rejects malformed or ambiguous records', () => assert.throws(() => parseLinuxMountInfo(input)));
test('Btrfs list parser retains spaces while rejecting ambiguous paths and duplicate IDs', () => {
  assert.equal(parseBtrfsSubvolumes(`ID 256 gen 1 top level 5 uuid ${originUuid} path <FS_TREE>/my data`)[0].fsPath, '/my data');
  assert.throws(() => parseBtrfsSubvolumes(`ID 256 gen 1 top level 5 uuid ${originUuid} path ../escape`));
  assert.throws(() => parseBtrfsSubvolumes(`ID 256 gen 1 top level 5 uuid ${originUuid} path a\nID 256 gen 1 top level 5 uuid ${originUuid} path b`));
});
test('Btrfs creates immutable snapshots, mounts by ID, and deletes exact owned subvolumes after unmount', async () => {
  const f = machine(); const lease = await prepareLinuxSnapshots([f.sourceConfig], f.context);
  assert.equal(lease.backend, 'btrfs'); assert.equal(lease.atomicSet, true); assert.equal(lease.mappings[0].root, '/data'); assert.match(lease.mappings[0].identity, /^btrfs:/);
  assert.ok(f.calls.some(([exe, args]) => exe === 'btrfs' && args[1] === 'snapshot' && args.includes('-r')));
  assert.ok(f.calls.some(([exe, args]) => exe === 'mount' && args[3].startsWith('ro,') && args[3].includes('subvolid=300')));
  await lease.verify(); await lease.release(); await lease.release(); assert.equal(f.objects.size, 0); assert.equal(f.rows.length, 2); await assert.rejects(lease.verify(), /released/);
});
test('Btrfs writable top-level mounts stay behind a root-only private ancestor while exported mappings are readonly', async () => {
  const f = machine(); const lease = await prepareLinuxSnapshots([f.sourceConfig], f.context);
  const privateDirectory = `${workspace}/private`; assert.equal(f.directories.get(privateDirectory).uid, 0n); assert.equal(f.directories.get(privateDirectory).mode & 0o777n, 0o700n);
  const top = f.rows.find(row => row.type === 'btrfs' && row.id >= 100 && row.options.includes('rw')); assert.equal(path.dirname(top.point), privateDirectory);
  assert.ok(lease.mappings.every(mapping => !mapping.snapshotPath.startsWith(`${privateDirectory}/`) && f.rows.some(row => row.point === mapping.snapshotPath && row.options.includes('ro'))));
  f.directories.get(privateDirectory).mode = 0o755n; await assert.rejects(lease.verify(), { code: 'SNAPSHOT_IDENTITY_CHANGED' }); f.directories.get(privateDirectory).mode = 0o700n;
  await lease.release(); assert.ok(!f.directories.has(privateDirectory));
});
test('Btrfs ID5 sources retain their logical mount root and omit only the marked internal namespace', async () => {
  const f = machine('btrfs', { id5: true, whole: true }); const lease = await prepareLinuxSnapshots([f.sourceConfig], f.context);
  const root = lease.mappings.find(mapping => mapping.root === '/data'); assert.ok(root); assert.deepEqual(root.ignoredRoots, ['/data/.delta-backupper-snapshots']);
  assert.ok(!root.snapshotPath.includes('/private/')); assert.ok(lease.mappings.some(mapping => mapping.root === '/data/@home')); await lease.release();
});
test('Btrfs separately snapshots nested subvolumes and records unleased mount barriers', async () => {
  const f = machine('btrfs', { nestedSubvolume: true, nestedMount: true, whole: true }); const lease = await prepareLinuxSnapshots([f.sourceConfig], f.context);
  assert.equal(lease.atomicSet, false); assert.deepEqual(lease.mappings.map(row => row.root).sort(), ['/data', '/data/nested']);
  assert.ok(lease.mappings.find(row => row.root === '/data').excludedRoots.includes('/data/nested')); assert.ok(lease.mappings[0].excludedRoots.includes('/data/nas'));
  await lease.release(); assert.equal(f.objects.size, 0);
});
test('Btrfs refuses writable or user-owned filesystem root namespaces before snapshot creation', async () => {
  const f = machine(); const oldStat = f.context.fs.lstat; f.context.fs.lstat = async filename => { const result = await oldStat(filename); return /^.*\/btrfs-top-\d+$/.test(filename) && f.rows.some(row => row.point === filename) ? { ...result, uid: 1000n } : result; };
  await assert.rejects(prepareLinuxSnapshots([f.sourceConfig], f.context), error => error.cleanupVerified === true && /protected/.test(error.message));
  assert.equal(f.objects.size, 0); assert.equal(f.rows.length, 2);
});
test('Btrfs foreign UUID replacement blocks deletion and reports unverified cleanup', async () => {
  const f = machine(); const lease = await prepareLinuxSnapshots([f.sourceConfig], f.context); const object = [...f.objects.values()][0]; object.uuid = childUuid;
  await assert.rejects(lease.verify(), /identity changed/); await assert.rejects(lease.release(), { code: 'SNAPSHOT_CLEANUP_UNVERIFIED', cleanupVerified: false });
  assert.equal(f.objects.size, 1); assert.ok(!f.calls.some(([exe, args]) => exe === 'btrfs' && args[1] === 'delete'));
});
test('Btrfs failure after snapshot creation still removes only its owned object', async () => {
  let fail = false; const f = machine('btrfs', { fail: (exe, args) => exe === 'mount' && args[3].startsWith('ro,') && !fail && (fail = true) });
  await assert.rejects(prepareLinuxSnapshots([f.sourceConfig], f.context), error => error.cleanupVerified === true);
  assert.equal(f.objects.size, 0); assert.equal(f.rows.length, 2);
});
test('Btrfs bind mounts map only their filesystem-root suffix inside the readonly snapshot', async () => {
  const f = machine('btrfs', { bindRoot: '/@home/src' }); const lease = await prepareLinuxSnapshots([f.sourceConfig], f.context);
  assert.equal(lease.mappings[0].root, '/data'); assert.ok(lease.mappings[0].snapshotPath.endsWith('/src')); await lease.release();
});
test('Btrfs rejects an existing unmarked namespace and never hides foreign root-owned contents', async () => {
  const f = machine(); const namespace = `${workspace}/private/btrfs-top-0/.delta-backupper-snapshots`;
  f.directories.set(namespace, stats('directory', { mode: 0o700n, dev: 1020n, ino: 700n })); f.files.set(`${namespace}/precious`, { data: 'Foreign root-owned data', ino: 701n });
  await assert.rejects(prepareLinuxSnapshots([f.sourceConfig], f.context), error => error.cleanupVerified === true);
  assert.equal(f.objects.size, 0); assert.ok(f.files.has(`${namespace}/precious`)); assert.ok(!f.files.has(`${namespace}/.delta-namespace.json`));
});
test('Btrfs namespace verification preserves valid other sessions and rejects unrelated entries', async () => {
  const f = machine(); const lease = await prepareLinuxSnapshots([f.sourceConfig], f.context); const namespace = `${workspace}/private/btrfs-top-0/.delta-backupper-snapshots`; const otherSession = '99999999-9999-4999-8999-999999999999'; const other = `${namespace}/${otherSession}`;
  f.directories.set(other, stats('directory', { mode: 0o700n, dev: 1020n, ino: 700n })); f.files.set(`${other}/.delta-session.json`, { data: JSON.stringify({ schemaVersion: 1, kind: 'delta-backupper-btrfs-session', filesystemUuid: fsUuid, sessionId: otherSession }), ino: 701n });
  await lease.verify(); await lease.release(); assert.ok(f.directories.has(other)); assert.ok(f.files.has(`${other}/.delta-session.json`));
  const g = machine(); const second = await prepareLinuxSnapshots([g.sourceConfig], g.context); g.files.set(`${namespace}/precious`, { data: 'foreign', ino: 702n }); await assert.rejects(second.verify(), /foreign entries/); await assert.rejects(second.release(), { code: 'SNAPSHOT_CLEANUP_UNVERIFIED' }); assert.ok(g.files.has(`${namespace}/precious`));
});
test('Btrfs rejects new unmounted nested subvolumes instead of accepting an empty snapshot stub', async () => {
  const f = machine(); const lease = await prepareLinuxSnapshots([f.sourceConfig], f.context); f.subvolumes.push({ id: '900', uuid: childUuid, fsPath: '/@home/src/new-subvolume' });
  await assert.rejects(lease.verify(), { code: 'SNAPSHOT_TOPOLOGY_CHANGED' }); await lease.release();
});
test('ZFS batches same-pool datasets atomically and guards snapshots with session property, GUID and holds', async () => {
  const f = machine('zfs', { zfsChild: true, whole: true }); const lease = await prepareLinuxSnapshots([f.sourceConfig], f.context);
  assert.equal(lease.backend, 'zfs'); assert.equal(lease.atomicSet, true); assert.equal(lease.mappings.length, 2);
  const create = f.calls.filter(([exe, args]) => exe === 'zfs' && args[0] === 'snapshot'); assert.equal(create.length, 1); assert.equal(create[0][1].filter(value => value.includes('@delta-backupper-')).length, 2); assert.equal(f.holds.size, 2);
  await lease.release(); assert.equal(f.holds.size, 0); assert.equal(f.snapshots.size, 0); assert.equal(f.rows.length, 3);
});
test('ZFS foreign GUID/session replacement prevents recursive or forced destruction', async () => {
  const f = machine('zfs'); const lease = await prepareLinuxSnapshots([f.sourceConfig], f.context); [...f.snapshots.values()][0].session = 'foreign';
  await assert.rejects(lease.verify(), /identity changed/); await assert.rejects(lease.release(), { code: 'SNAPSHOT_CLEANUP_UNVERIFIED' });
  assert.equal(f.snapshots.size, 1); assert.ok(!f.calls.some(([exe, args]) => exe === 'zfs' && args[0] === 'destroy'));
});
for (const type of ['ext4', 'xfs']) test(`LVM ${type} uses readonly COW snapshot and safe mount options without explicit fsfreeze`, async () => {
  const f = machine('lvm', { type }); const lease = await prepareLinuxSnapshots([f.sourceConfig], f.context);
  assert.equal(lease.backend, 'lvm'); const create = f.calls.find(([exe]) => exe === 'lvcreate')[1]; assert.equal(create[create.indexOf('--permission') + 1], 'r'); assert.ok(create.includes('8589934592B'));
  const flags = f.calls.find(([exe]) => exe === 'mount')[1][3]; assert.match(flags, /^ro,/); assert.ok(flags.includes(type === 'ext4' ? 'noload' : 'norecovery')); if (type === 'xfs') assert.ok(flags.includes('nouuid'));
  assert.ok(!f.calls.some(([exe]) => exe === 'fsfreeze')); await lease.release(); assert.equal(f.volumes.size, 1);
});
test('LVM rejects unsupported thin pools before creating snapshots', async () => {
  const f = machine('lvm', { thin: true }); await assert.rejects(prepareLinuxSnapshots([f.sourceConfig], f.context), error => error.cleanupVerified === true && /thin-pool/.test(error.message)); assert.ok(!f.calls.some(([exe]) => exe === 'lvcreate'));
});
test('LVM rejects stale udev snapshot nodes that still point to the live origin', async () => {
  const f = machine('lvm'); const original = f.context.fs.lstat; f.context.fs.lstat = async filename => { const info = await original(filename); return filename.startsWith('/dev/vg/delta_') ? { ...info, rdev: 64768n } : info; };
  await assert.rejects(prepareLinuxSnapshots([f.sourceConfig], f.context), error => error.cleanupVerified === true && /device node/.test(error.message)); assert.equal(f.volumes.size, 1); assert.ok(!f.calls.some(([exe]) => exe === 'mount'));
});
test('LVM snapshot health/COW overflow aborts verification while cleanup remains UUID-guarded', async () => {
  const f = machine('lvm'); const lease = await prepareLinuxSnapshots([f.sourceConfig], f.context); [...f.volumes.values()].find(row => row.origin_uuid).snap_percent = '99.9';
  await assert.rejects(lease.verify(), { code: 'SNAPSHOT_INVALIDATED' }); await lease.release(); assert.equal(f.volumes.size, 1);
});
test('LVM foreign UUID replacement is preserved and reported instead of deleted', async () => {
  const f = machine('lvm'); const lease = await prepareLinuxSnapshots([f.sourceConfig], f.context); [...f.volumes.values()].find(row => row.origin_uuid).lv_uuid = originLvm;
  await assert.rejects(lease.release(), { code: 'SNAPSHOT_CLEANUP_UNVERIFIED' }); assert.equal(f.volumes.size, 2); assert.ok(!f.calls.some(([exe]) => exe === 'lvremove'));
});
test('New or replaced live mounts invalidate a lease instead of silently omitting mounted data', async () => {
  const f = machine('zfs'); const lease = await prepareLinuxSnapshots([f.sourceConfig], f.context); f.rows.push(mounted(20, '/data/src/usb', 'vfat', '/dev/sdb1', '/', '8:17', 10)); await assert.rejects(lease.verify(), { code: 'SNAPSHOT_TOPOLOGY_CHANGED' }); await lease.release();
});
for (const backend of ['btrfs', 'zfs', 'lvm']) test(`${backend} orphan recovery replays durable intents and confirms exact snapshot removal`, async () => {
  const f = machine(backend); await prepareLinuxSnapshots([f.sourceConfig], f.context); const state = f.state();
  assert.ok(state.actions.some(action => action.kind === backend)); await recoverLinuxSnapshots(state, f.context);
  assert.equal(f.objects.size + f.snapshots.size + (f.volumes.size - 1), 0); assert.equal(f.rows.length, 2);
});
test('Btrfs recovery remounts a lost helper namespace and journals the new mount identity before cleanup', async () => {
  const f = machine(); await prepareLinuxSnapshots([f.sourceConfig], f.context); const state = f.state();
  for (let index = f.rows.length - 1; index >= 0; index--) if (f.rows[index].id >= 100) f.rows.splice(index, 1);
  await recoverLinuxSnapshots(state, f.context); assert.equal(f.objects.size, 0); assert.equal(f.rows.length, 2); assert.ok(f.calls.filter(([exe, args]) => exe === 'mount' && args[3].includes('subvolid=5')).length >= 2);
});
test('Recovery validates the full journal before issuing any command or touching paths', async () => {
  const f = machine(); const state = { schemaVersion: 1, platform: 'linux', sessionId, workspace, actions: [{ kind: 'directory', path: '/data/precious' }] };
  await assert.rejects(recoverLinuxSnapshots(state, f.context), { code: 'SNAPSHOT_CLEANUP_UNVERIFIED' }); assert.equal(f.calls.length, 0); assert.ok(f.directories.has('/data'));
});
test('Recovery refuses changed mount IDs and preserves the foreign mount', async () => {
  const f = machine('zfs'); await prepareLinuxSnapshots([f.sourceConfig], f.context); const state = f.state(); f.rows.find(row => row.id >= 100).id = 999;
  await assert.rejects(recoverLinuxSnapshots(state, f.context), { code: 'SNAPSHOT_CLEANUP_UNVERIFIED' }); assert.ok(f.rows.some(row => row.id === 999));
});
test('ZFS recovery tolerates an absent member of a partially created batch while cleaning known peers', async () => {
  const f = machine('zfs', { zfsChild: true, whole: true }); await prepareLinuxSnapshots([f.sourceConfig], f.context); const state = f.state();
  const missingName = [...f.snapshots.keys()][1]; f.snapshots.delete(missingName); f.holds.delete(missingName);
  await recoverLinuxSnapshots(state, f.context); assert.equal(f.snapshots.size, 0); assert.equal(f.rows.length, 3);
});
test('Cancellation prevents snapshot creation and cleanup commands never inherit the aborted signal', async () => {
  const f = machine('zfs'); const controller = new AbortController(); f.context.signal = controller.signal; const lease = await prepareLinuxSnapshots([f.sourceConfig], f.context); controller.abort(); await assert.rejects(lease.verify(), { name: 'AbortError' }); await lease.release();
  for (const [exe, args, options] of f.calls.filter(([exe, args]) => exe === 'umount' || (exe === 'zfs' && ['destroy', 'release'].includes(args[0])))) assert.equal(options.signal, undefined, `${exe} ${args.join(' ')}`);
});
