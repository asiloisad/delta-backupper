import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, lstat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { runtimeDirectory } from '../../src/platform/application-paths.mjs';

const root = await mkdtemp(path.join(tmpdir(), 'delta-runtime-service-'));
process.env.LOCALAPPDATA = path.join(root, 'state'); process.env.XDG_STATE_HOME = path.join(root, 'state');
after(() => rm(root, { recursive: true, force: true }));
const bundle = path.join(root, 'service.cjs'); await build({ entryPoints: ['src/service/api.ts'], outfile: bundle, bundle: true, platform: 'node', target: 'node24', format: 'cjs', logLevel: 'silent' });
const { ApplicationService } = createRequire(import.meta.url)(bundle);

test('read-only Home creates no state, while recorded activity persists outside the configuration directory', async () => {
  const configuration = path.join(root, 'configuration'), service = new ApplicationService({ configDirectory: configuration }); await service.ready;
  const state = runtimeDirectory(configuration); const home = await service.request({ action: 'dashboard' }); assert.deepEqual(home.recent, []); await assert.rejects(lstat(state), { code: 'ENOENT' });
  service.reportFailure('task_1', 'run', new Error('Owned runtime fixture failure')); await service.shutdown();
  const activity = JSON.parse(await readFile(path.join(state, 'activity.json'), 'utf8')); assert.equal(activity.entries.length, 1); assert.equal(activity.entries[0].error, 'Owned runtime fixture failure'); assert.deepEqual((await readdir(configuration)).sort(), ['config.json', 'tasks.json']);
  const before = await readFile(path.join(state, 'activity.json')), restarted = new ApplicationService({ configDirectory: configuration }); await restarted.ready; const next = await restarted.request({ action: 'dashboard' }); assert.equal(next.recent.length, 1); await restarted.shutdown(); assert.deepEqual(await readFile(path.join(state, 'activity.json')), before);
});
