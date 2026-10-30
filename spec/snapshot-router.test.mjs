import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { build } from 'esbuild';

const directory = await mkdtemp(path.join(tmpdir(), 'delta-snapshot-router-'));
test.after(() => rm(directory, { recursive: true, force: true }));
const bundle = path.join(directory, 'router.mjs');
await build({ entryPoints: ['src/platform/snapshots.ts'], outfile: bundle, bundle: true, platform: 'node', target: 'node24', format: 'esm', logLevel: 'silent' });
const { createSnapshotSourceProvider, attachSnapshotSourceSession } = await import(pathToFileURL(bundle).href);
const sources = [{ id: 'source_a', path: 'C:\\Data', label: 'Source' }];
const task = { snapshot: { mode: 'snapshot-only', fallback: 'fail', lvmCowSizeBytes: 8 * 1024 ** 3 }, sources, symlinks: 'preserve' };
const lease = { schemaVersion: 1, mode: 'snapshot-only', consistentSnapshot: true, helperElevated: true, clientUnelevated: true, sourceAccess: 'worker-token', volumes: [{ root: 'C:\\', guid: '\\\\?\\Volume{01234567-89ab-cdef-0123-456789abcdef}\\', device: '\\\\?\\GLOBALROOT\\Device\\HarddiskVolumeShadowCopy42', snapshotId: '{12345678-90ab-cdef-0123-456789abcdef}' }] };
function frame(opcode, document) { const payload = Buffer.from(JSON.stringify(document)), result = Buffer.alloc(12 + payload.length); result.write('DV02'); result[4] = opcode; result.writeUInt32LE(payload.length, 8); payload.copy(result, 12); return result; }
function client(mode) {
  const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); let exited = false;
  const exit = code => { if (exited) return; exited = true; child.stdout.end(); child.stderr.end(); child.emit('exit', code, null); };
  child.kill = () => { child.stdin.destroy(); exit(1); return true; };
  void (async () => { let buffered = Buffer.alloc(0); for await (const chunk of child.stdin) { buffered = Buffer.concat([buffered, chunk]); while (buffered.length >= 12 && buffered.length >= 12 + buffered.readUInt32LE(8)) { const opcode = buffered[4], length = buffered.readUInt32LE(8); buffered = buffered.subarray(12 + length); if (opcode === 1) child.stdout.write(frame(0x81, { ...lease, mode })); else if (opcode === 2 || opcode === 4) { child.stdout.write(frame(0x82, { cleanupVerified: true, ownedSnapshotsDeleted: true })); exit(0); } else assert.equal(opcode, 3); } } exit(0); })().catch(error => { child.stderr.write(String(error)); exit(1); });
  return child;
}

test('snapshot router reports unsupported platforms before launching any helper', async () => {
  let launched = false; const provider = createSnapshotSourceProvider({ platform: 'freebsd', launch() { launched = true; throw new Error('unexpected launch'); } });
  await assert.rejects(provider.prepare(task, { sources }), error => error.code === 'SNAPSHOT_UNSUPPORTED_PLATFORM' && error.cleanupVerified === true); assert.equal(launched, false); await provider.shutdown();
});
for (const mode of ['snapshot-only', 'writers']) test(`snapshot router retains Windows VSS while labelling ${mode} guarantees`, async () => {
  const provider = createSnapshotSourceProvider({ platform: 'win32', helperPath: process.execPath, timeoutMs: 1000, launch: () => client(mode) });
  const session = await provider.prepare({ ...task, snapshot: { ...task.snapshot, mode } }, { sources });
  assert.equal(session.sourceConsistency, mode === 'writers' ? 'application-snapshot' : 'filesystem-snapshot'); assert.equal(session.atomicSet, true); assert.equal(session.consistentSnapshot, true);
  await session.release({ success: true }); await provider.shutdown();
});
test('closed snapshot router rejects new work without launching a helper', async () => {
  let launched = false; const provider = createSnapshotSourceProvider({ platform: 'linux', launch() { launched = true; throw new Error('unexpected launch'); } }); await provider.shutdown();
  await assert.rejects(provider.prepare(task, { sources }), error => error.code === 'SNAPSHOT_PROVIDER_CLOSED' && error.cleanupVerified === true); assert.equal(launched, false);
});
test('worker attachment preserves Windows source mode, set atomicity and parent health callback', { skip: process.platform !== 'win32' }, async () => {
  let checks = 0, releases = 0; const session = attachSnapshotSourceSession(task, sources, lease, async () => { releases++; }, undefined, async () => { checks++; });
  assert.equal(session.sourceConsistency, 'filesystem-snapshot'); assert.equal(session.atomicSet, true); await session.verify(); await session.release(); assert.equal(checks, 1); assert.equal(releases, 1);
});
