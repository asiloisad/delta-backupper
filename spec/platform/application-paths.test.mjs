import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, lstat, rm, symlink, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runtimeDirectory, ensureRuntimeDirectory } from '../../src/platform/application-paths.mjs';

test('application state uses OS-standard roots and an isolated configuration hash without creating files', () => {
  const variants = [
    ['win32', 'C:\\config\\delta', { LOCALAPPDATA: 'C:\\local-state' }, 'C:\\home', 'C:\\local-state\\Delta Backupper\\profiles\\'],
    ['darwin', '/config/delta', {}, '/home/user', '/home/user/Library/Application Support/DeltaBackupper/profiles/'],
    ['linux', '/config/delta', { XDG_STATE_HOME: '/local-state' }, '/home/user', '/local-state/delta-backupper/profiles/'],
    ['linux', '/config/delta', {}, '/home/user', '/home/user/.local/state/delta-backupper/profiles/'],
  ];
  for (const [platform, configuration, environment, homeDirectory, prefix] of variants) { const options = { platform, environment, homeDirectory }; const actual = runtimeDirectory(configuration, options); assert(actual.startsWith(prefix)); assert.match(actual.slice(prefix.length), /^[a-f0-9]{64}$/); assert.equal(runtimeDirectory(configuration, options), actual); assert.notEqual(runtimeDirectory(`${configuration}-other`, options), actual); }
  assert.throws(() => runtimeDirectory('C:\\config', { platform: 'win32', environment: { LOCALAPPDATA: 'relative' } }), /absolute path/);
  assert.throws(() => runtimeDirectory('/config', { platform: 'linux', environment: { XDG_STATE_HOME: 'relative' } }), /absolute path/);
});

test('runtime directories are private, separate from configuration, and stable across configuration aliases', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'delta-runtime-paths-')); t.after(() => rm(root, { recursive: true, force: true })); const configuration = path.join(root, 'config'); await mkdir(configuration);
  const originalLocal = process.env.LOCALAPPDATA, originalState = process.env.XDG_STATE_HOME; process.env.LOCALAPPDATA = path.join(root, 'state'); process.env.XDG_STATE_HOME = path.join(root, 'state'); t.after(() => { if (originalLocal === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = originalLocal; if (originalState === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = originalState; });
  const resolved = runtimeDirectory(configuration); await assert.rejects(lstat(resolved), { code: 'ENOENT' }); assert.equal(await ensureRuntimeDirectory(configuration), resolved); assert.deepEqual(await readdir(configuration), []); const info = await lstat(resolved); assert(info.isDirectory()); assert(!info.isSymbolicLink()); if (process.platform !== 'win32') assert.equal(info.mode & 0o777, 0o700);
  const alias = path.join(root, 'alias'); try { await symlink(configuration, alias, process.platform === 'win32' ? 'junction' : 'dir'); } catch (error) { if (error.code === 'EPERM') { t.skip('OS does not permit a directory alias'); return; } throw error; } assert.equal(runtimeDirectory(alias), resolved);
});

test('a runtime application directory replaced by a link cannot receive authentication state', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'delta-runtime-link-')); t.after(() => rm(root, { recursive: true, force: true })); const configuration = path.join(root, 'config'), foreign = path.join(root, 'foreign'), state = path.join(root, 'state'); await Promise.all([mkdir(configuration), mkdir(foreign), mkdir(state)]); await writeFile(path.join(foreign, 'keep'), 'preserve');
  const originalLocal = process.env.LOCALAPPDATA, originalState = process.env.XDG_STATE_HOME; process.env.LOCALAPPDATA = state; process.env.XDG_STATE_HOME = state; t.after(() => { if (originalLocal === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = originalLocal; if (originalState === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = originalState; });
  if (process.platform === 'darwin') { t.skip('This fixture overrides the Windows/Linux state root'); return; }
  const app = path.dirname(path.dirname(runtimeDirectory(configuration))); try { await symlink(foreign, app, process.platform === 'win32' ? 'junction' : 'dir'); } catch (error) { if (error.code === 'EPERM') { t.skip('OS does not permit a directory alias'); return; } throw error; }
  await assert.rejects(ensureRuntimeDirectory(configuration)); assert.deepEqual(await readdir(foreign), ['keep']); assert.equal(await readFile(path.join(foreign, 'keep'), 'utf8'), 'preserve');
});
