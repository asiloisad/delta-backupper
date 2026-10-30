import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm, unlink, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir, hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolveTaskSources } from '../../src/domain/source-identity.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
function execute(binary, prefix, args, { cwd, input, timeout = 30_000, onSpawn, environment } = {}) {
  return new Promise((accept, reject) => {
    const child = spawn(binary, [...prefix, ...args], { cwd, windowsHide: true, env: environment ?? process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', failure, terminationTimer, settled = false;
    const fail = error => { if (settled) return; settled = true; clearTimeout(timer); clearTimeout(terminationTimer); reject(error); };
    const stopOwnedChild = error => {
      if (settled || failure) return; failure = error; clearTimeout(timer);
      try { child.kill(); } catch { /* Await close or report an unsettled owner. */ }
      terminationTimer = setTimeout(() => { const unsettled = new Error('Owned CLI process did not close within 5 seconds after termination was requested'); unsettled.code = 'EXECUTION_UNSETTLED'; unsettled.cause = failure; fail(unsettled); }, 5000);
    };
    const timer = setTimeout(() => stopOwnedChild(new Error(`Command timed out: ${args.slice(0, 3).join(' ')}`)), timeout);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8'); child.stdout.on('data', data => { if (settled || failure) return; stdout += data; if (stdout.length > 4 * 1024 ** 2) stopOwnedChild(new Error('Command output exceeded limit')); }); child.stderr.on('data', data => { if (settled || failure) return; stderr += data; if (stderr.length > 1024 ** 2) stopOwnedChild(new Error('Command error output exceeded limit')); });
    child.once('error', e => { if (child.pid === undefined) fail(e); else stopOwnedChild(e); }); child.once('close', (code, signal) => { if (settled) return; if (failure) { fail(failure); return; } settled = true; clearTimeout(timer); clearTimeout(terminationTimer); let value; if (stdout.trim()) { try { value = JSON.parse(stdout); } catch { /* Caller reports exact output on failure. */ } } accept({ code, signal, stdout, stderr, value }); }); child.stdin.on('error', e => { if (e.code !== 'EPIPE') stopOwnedChild(e); }); child.stdin.end(input);
    try { onSpawn?.(child); } catch (e) { stopOwnedChild(e); }
  });
}
export { execute as executeTestCommand };
export async function exerciseApplication() {
  const binary = process.execPath, prefix = [join(root, '.dev/build/cli.cjs')];
  const fixture = await mkdtemp(join(tmpdir(), 'delta-cli-żółć-')); const config = join(fixture, 'catalog'); const source = join(fixture, 'źródło'); const destination = join(fixture, 'backup'); const duplicate = join(fixture, 'duplicate'); const results = [];
  await Promise.all([mkdir(source), mkdir(destination), mkdir(duplicate)]);
  const call = (args, extra = {}) => execute(binary, prefix, [...args, '--config-dir', config, '--json'], { cwd: fixture, ...extra });
  async function command(name, args, { code = 0, input, validate } = {}) {
    const start = Date.now(); const output = await call(args, { input });
    assert.equal(output.code, code, `${name}: ${output.stderr || output.stdout}`); if (code === 0) assert.notEqual(output.value, undefined, `${name}: invalid JSON ${output.stdout}`); if (validate) await validate(output.value, output); results.push({ name, status: 'passed', exitCode: output.code, milliseconds: Date.now() - start }); return output.value;
  }
  const patch = async (name, value) => { const path = join(fixture, `${name}.json`); await writeFile(path, JSON.stringify(value)); return path; };
  const unwrap = value => value?.result ?? value;
  let task, first, increment, differential;
  try {
    await writeFile(join(source, 'a.txt'), 'alpha'.repeat(300)); await writeFile(join(source, 'gone.txt'), 'delete later'); await mkdir(join(source, 'empty'));
    const settings = await patch('settings', { sequence: { types: ['full', 'incremental', 'differential'] }, archive: { level: 1 } });
    const loaded = await command('task-create-full-settings', ['task', 'create', '--name', 'Kopia żółć', '--destination', destination, '--source', source, '--settings', settings]); task = loaded.value; const taskId = loaded.id;
    assert.equal(JSON.parse(await readFile(join(destination, '.delta.json'), 'utf8')).sequence, 'FID', 'The task stores the same compact sequence string shown in the UI');
    assert.deepEqual(task.archive, { level: 1 }); assert.equal(task.snapshot.mode, 'off'); assert.deepEqual(Object.keys(task.sources[0]).sort(), ['filters', 'path']); const sourceId = resolveTaskSources(task)[0].id;
    await writeFile(join(source, 'ignored.txt'), 'This file is excluded only for this source.');
    const sourceRules = await patch('source-filters', { sources: task.sources.map(item => ({ ...item, filters: { include: ['*.txt'], exclude: ['ignored.txt'] } })) });
    const editedSources = await command('task-edit-per-source-filters', ['task', 'edit', taskId, '--file', sourceRules]); task = editedSources.value; assert.deepEqual(task.sources[0].filters, { include: ['*.txt'], exclude: ['ignored.txt'] }); assert(!Object.hasOwn(task, 'filters')); assert.equal(resolveTaskSources(task)[0].id, sourceId);
    await command('tasks-list', ['tasks', 'list'], { validate: value => assert.ok(value.some(row => row.task?.id === taskId || row.id === taskId || row.value?.id === taskId)) });
    await command('task-show', ['task', 'show', taskId], { validate: value => assert.equal(value.id, taskId) }); await command('task-validate', ['task', 'validate', destination]);
    const app = await command('settings-app-read', ['settings', 'app'], { validate: value => assert.equal(value.value.language, 'en', 'Application configuration exposes the English-only interface') }); const appFile = await patch('app', { ...app.value, theme: 'dark' }); await command('settings-app-save', ['settings', 'app', '--file', appFile], { validate: value => assert.equal(value.value.language, 'en') });
    const defaults = await command('settings-defaults-read', ['settings', 'defaults'], { validate: value => { assert(!Object.hasOwn(value.value.settings, 'sources')); assert(!Object.hasOwn(value.value.settings, 'filters')); assert.equal(value.value.settings.wdir, ''); assert.equal(value.value.settings.mode, 0); assert.deepEqual(value.value.settings.archive, { level: 6 }); } }); const defaultsFile = await patch('defaults', { ...defaults.value, settings: { ...defaults.value.settings, detection: 'hash' } }); await command('settings-defaults-save', ['settings', 'defaults', '--file', defaultsFile]); await command('task-explicit-settings-stable', ['task', 'show', taskId], { validate: value => assert.equal(value.value.detection, 'fast') });
    const globalConfig = JSON.parse(await readFile(join(config, 'config.json'), 'utf8'));
    assert.deepEqual(Object.keys(globalConfig).sort(), ['application', 'schemaVersion', 'task']); assert.equal(globalConfig.application.theme, 'dark'); assert.equal(globalConfig.task.detection, 'hash'); assert.equal(globalConfig.task.workingDirectory, ''); assert.equal(globalConfig.task.pathMode, 0); assert.deepEqual(globalConfig.task.archive, { level: 6 }); assert(!Object.hasOwn(globalConfig.task, 'wdir')); assert(!Object.hasOwn(globalConfig.task, 'mode')); assert.deepEqual((await readdir(config)).filter(name => name.endsWith('.json')).sort(), ['config.json', 'tasks.json']); results.push({ name: 'combined-config-with-independent-sections', status: 'passed' });
    first = unwrap(await command('backup-full-one-zip', ['task', 'run', taskId])); assert.equal(first.status, 'complete'); assert.equal(first.type, 'full'); assert.equal(first.parts.length, 1); assert.equal(first.files, 2, 'The source-specific exclusion must omit ignored.txt');
    assert.match(first.id, /^\d{20}$/); assert.equal(first.parts[0].name, `${first.id}.zip`); assert(!Object.hasOwn(JSON.parse(await readFile(join(destination, '.delta.json'), 'utf8')), 'encryption')); const zipHeader = await readFile(join(destination, first.parts[0].name)); assert.equal(zipHeader.readUInt16LE(6) & 1, 0, 'ZIP entries are ordinary unencrypted entries'); assert(!(await readdir(destination)).includes('runs'), 'Backups live directly beside .delta.json');
    await writeFile(join(source, 'a.txt'), 'changed alpha'.repeat(200)); await writeFile(join(source, 'new.txt'), 'new'); await unlink(join(source, 'gone.txt'));
    increment = unwrap(await command('backup-incremental-deletion', ['task', 'run', taskId])); assert.equal(increment.type, 'incremental');
    await writeFile(join(source, 'latest.txt'), 'latest point'); differential = unwrap(await command('backup-differential', ['task', 'run', taskId])); assert.equal(differential.type, 'differential');
    await command('history', ['history', taskId], { validate: value => assert.deepEqual(value.map(r => r.type), ['full', 'incremental', 'differential']) });
    await command('files-paginated-query', ['files', taskId, '--run', differential.id, '--query', '.txt', '--limit', '1'], { validate: value => { assert.equal(value.entries.length, 1); assert.equal(value.total, 3); assert.equal(value.nextOffset, 1); } });
    await command('verify-explicit-point', ['verify', taskId, '--run', differential.id], { validate: value => assert.equal(unwrap(value).status, 'complete') });
    const output = join(fixture, 'restore-latest'); await command('restore-default-latest', ['restore', taskId, '--to', output]); const restored = output; assert.equal(await readFile(join(restored, 'latest.txt'), 'utf8'), 'latest point'); assert.ok(!(await readdir(restored)).includes('gone.txt')); assert.equal(await readFile(join(restored, 'a.txt'), 'utf8'), await readFile(join(source, 'a.txt'), 'utf8'));
    await command('restore-collision-incomplete', ['restore', taskId, '--run', differential.id, '--to', output], { code: 4 }); await command('restore-explicit-skip', ['restore', taskId, '--run', differential.id, '--to', output, '--overwrite', 'skip']);
    const selection = join(fixture, 'selected'); await command('restore-selected-file', ['restore', taskId, '--run', differential.id, '--to', selection, '--path', 'new.txt']); assert.deepEqual(await readdir(selection), ['new.txt']);
    await command('pin', ['pin', taskId, '--run', first.id], { validate: value => assert.equal(value.pinned, true) }); await command('unpin', ['pin', taskId, '--run', first.id, '--unpin']);
    await command('task-status', ['task', 'status', taskId], { validate: value => { assert.equal(value.lock, null); assert.equal(value.lastRun.id, differential.id); assert.equal(value.checkpoint.runId, increment.id); } });
    const copied = await command('task-duplicate-independent-target', ['task', 'duplicate', taskId, '--to', duplicate, '--name', 'USB']); assert.notEqual(copied.id, taskId); assert.deepEqual(copied.value.sources[0].filters, task.sources[0].filters); assert.deepEqual(await command('duplicate-history-independent', ['history', copied.id]), []);
    const catalogueBeforeRejectedGroup = await readFile(join(config, 'tasks.json')); await command('removed-groups-command-rejected', ['groups', 'set', '--name', 'Linked view'], { code: 2, validate: (_value, output) => assert.match(output.stderr, /Unknown command: groups/) }); assert.deepEqual(await readFile(join(config, 'tasks.json')), catalogueBeforeRejectedGroup);
    const resumed = unwrap(await command('task-resume-revalidates-files', ['task', 'resume', taskId, '--run', differential.id])); assert.equal(resumed.resumedFrom, differential.id); await command('task-retry', ['task', 'retry', taskId, '--run', resumed.id]);
    const lock = join(destination, '.delta-lock'); await mkdir(lock); const token = randomUUID(); const owner = { schemaVersion: 1, token, host: hostname(), pid: process.pid, createdAt: new Date().toISOString() }; await writeFile(join(lock, 'owner.json'), JSON.stringify(owner));
    await command('busy-cross-process-task-lock', ['task', 'run', taskId], { code: 3 });
    await writeFile(join(lock, 'owner.json'), JSON.stringify({ ...owner, pid: 2147483647 })); await command('explicit-dead-owner-unlock', ['unlock', taskId, '--token', token]);
    const editFile = await patch('edit', { retention: { when: 'after', keepCycles: 1 } }); await command('task-edit-retention', ['task', 'edit', taskId, '--file', editFile]); await command('retention-real-cycles', ['retention', taskId]);
    await command('task-forget', ['task', 'forget', copied.id]); await command('task-discover', ['task', 'discover', duplicate]);
    // A new empty catalogue must restore from the destination's portable files.
    const retainedPoint = (await command('history-after-retention', ['history', taskId])).at(-1); assert(retainedPoint); const freshConfig = join(fixture, 'fresh-catalog'); const fresh = await execute(binary, prefix, ['restore', destination, '--run', retainedPoint.id, '--to', join(fixture, 'fresh-restore'), '--config-dir', freshConfig, '--json'], { cwd: fixture }); assert.equal(fresh.code, 0, fresh.stderr || fresh.stdout); assert.equal(await readFile(join(fixture, 'fresh-restore', 'latest.txt'), 'utf8'), 'latest point'); results.push({ name: 'restore-empty-global-catalog', status: 'passed', exitCode: fresh.code });
    await command('snapshot-delete-requires-explicit-run', ['delete', copied.id], { code: 2 });
    const disposable = unwrap(await command('snapshot-delete-fixture', ['task', 'run', copied.id]));
    await command('snapshot-delete-selected-point', ['delete', copied.id, '--run', disposable.id]);
    await command('snapshot-delete-history-empty', ['history', copied.id], { validate: value => assert.deepEqual(value, []) });
    assert.deepEqual((await readdir(duplicate)).filter(name => name.endsWith('.zip')), [], 'Deleting a snapshot removes its root ZIP archives');
    const unchangedTask = await readFile(join(destination, '.delta.json'));
    await command('removed-password-stdin-rejected', ['task', 'run', taskId, '--password-stdin'], { code: 2, validate: (_value, output) => assert.match(output.stderr, /Unknown option: --password-stdin/) });
    await command('removed-password-file-rejected', ['task', 'run', taskId, '--password-file', join(fixture, 'not-read-password.txt')], { code: 2, validate: (_value, output) => assert.match(output.stderr, /Unknown option: --password-file/) });
    await command('removed-credentials-command-rejected', ['credentials', 'clear', taskId], { code: 2, validate: (_value, output) => assert.match(output.stderr, /Unknown command: credentials/) });
    const removedEncryption = await patch('removed-encryption', { encryption: { enabled: false } }); await command('removed-encryption-setting-rejected', ['task', 'edit', taskId, '--file', removedEncryption], { code: 2, validate: (_value, output) => assert.match(output.stderr, /encryption/) }); assert.deepEqual(await readFile(join(destination, '.delta.json')), unchangedTask);
    return { status: 'passed', checks: results };
  } finally { await rm(fixture, { recursive: true, force: true }); }
}
