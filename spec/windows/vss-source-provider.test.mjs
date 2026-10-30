import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createVssSourceProvider, mapVssSources } from '../../src/platform/vss.ts';

const guid = '\\\\?\\Volume{01234567-89ab-cdef-0123-456789abcdef}\\';
const snapshotId = '{12345678-90ab-cdef-0123-456789abcdef}';
const device = '\\\\?\\GLOBALROOT\\Device\\HarddiskVolumeShadowCopy42';
const sources = [{ id: 'source_a', path: 'C:\\Data\\zażółć' }];
const task = { id: 'task_a', snapshot: { mode: 'snapshot-only', fallback: 'fail' }, sources };
function evidence(patch = {}) { return { schemaVersion: 1, mode: 'snapshot-only', consistentSnapshot: true, helperElevated: true, clientUnelevated: true, sourceAccess: 'worker-token', volumes: [{ root: 'C:\\', guid, device, snapshotId }], ...patch }; }
function encoded(opcode, value) { const payload = Buffer.from(JSON.stringify(value)); const result = Buffer.alloc(12 + payload.length); result.write('DV02'); result[4] = opcode; result.writeUInt32LE(payload.length, 8); payload.copy(result, 12); return result; }
function fakeClient({ prepared = evidence(), cleanup = true, invalidHeader = false, persistent = false, prepareErrorAt = 0 } = {}) {
  const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.killed = false; child.requests = [];
  let exited = false;
  const exit = code => { if (exited) return; exited = true; child.stdout.end(); child.stderr.end(); child.emit('exit', code, null); };
  child.kill = () => { child.killed = true; child.stdin.destroy(); exit(1); return true; };
  const serving = (async () => {
    let buffered = Buffer.alloc(0);
    for await (const chunk of child.stdin) {
      buffered = Buffer.concat([buffered, chunk]);
      while (buffered.length >= 12 && buffered.length >= 12 + buffered.readUInt32LE(8)) {
        assert.equal(buffered.subarray(0, 4).toString(), 'DV02'); assert.equal(buffered[5], 0); assert.equal(buffered.readUInt16LE(6), 0);
        const length = buffered.readUInt32LE(8); assert.ok(length <= 65536);
        const opcode = buffered[4]; child.requests.push({ opcode, payload: Buffer.from(buffered.subarray(12, 12 + length)) }); buffered = buffered.subarray(12 + length);
        if (opcode === 1) {
          if (child.requests.filter(item => item.opcode === 1).length === prepareErrorAt) child.stdout.write(encoded(0xff, { message: 'Writer unavailable', code: 'WRITER_FAILED', cleanupVerified: true }));
          else { const frame = encoded(0x81, prepared); if (invalidHeader) frame.writeUInt32LE(65537, 8); child.stdout.write(frame); }
        }
        else if (opcode === 2) { child.stdout.write(encoded(0x82, { cleanupVerified: cleanup, ownedSnapshotsDeleted: cleanup })); if (!persistent || !cleanup) exit(cleanup ? 0 : 1); }
        else if (opcode === 4) { child.stdout.write(encoded(0x82, { cleanupVerified: cleanup, ownedSnapshotsDeleted: cleanup })); exit(cleanup ? 0 : 1); }
        else assert.equal(opcode, 3);
      }
    }
    exit(0);
  })();
  void serving.catch(error => { child.stderr.write(String(error)); exit(1); });
  return child;
}
function provider(child) { return createVssSourceProvider({ helperPath: process.execPath, platform: 'win32', timeoutMs: 1000, launch: () => child }); }

test('VSS maps an attested volume to snapshot paths while retaining source IDs', () => {
  assert.deepEqual(mapVssSources(sources, evidence(), 'snapshot-only'), [{ ...sources[0], path: `${device}\\Data\\zażółć` }]);
});
test('VSS resolves the longest volume mount prefix, including its root itself', () => {
  const nestedDevice = device.replace('42', '43');
  const value = evidence({ volumes: [evidence().volumes[0], { root: 'C:\\Data\\', guid: guid.replace('01234567', '11234567'), device: nestedDevice, snapshotId: snapshotId.replace('12345678', '22345678') }] });
  assert.equal(mapVssSources(sources, value, 'snapshot-only')[0].path, `${nestedDevice}\\zażółć`);
  assert.equal(mapVssSources([{ ...sources[0], path: 'C:\\Data' }], value, 'snapshot-only')[0].path, `${nestedDevice}\\`);
});
test('VSS source mapping never confuses a case-distinct directory with an attested nested mount', () => {
  const nested = { root: 'C:\\Mount\\', guid: guid.replace('01234567', '11234567'), device: device.replace('42', '43'), snapshotId: snapshotId.replace('12345678', '22345678') };
  const value = evidence({ volumes: [evidence().volumes[0], nested] });
  assert.equal(mapVssSources([{ id: 'ordinary', path: 'C:\\mount\\file' }], value, 'snapshot-only')[0].path, `${device}\\mount\\file`);
  assert.equal(mapVssSources([{ id: 'mounted', path: 'c:\\Mount\\file' }], value, 'snapshot-only')[0].path, `${nested.device}\\file`);
  assert.throws(() => mapVssSources([{ id: 'unattested', path: 'C:\\mount\\file' }], evidence({ volumes: [nested] }), 'snapshot-only'), /outside the snapshot lease/);
});
for (const [name, patch] of [
  ['unprivileged helper', { helperElevated: false }], ['elevated worker', { clientUnelevated: false }], ['missing snapshot', { consistentSnapshot: false }],
  ['wrong context', { mode: 'writers' }], ['privileged file reading', { sourceAccess: 'helper-token' }],
  ['arbitrary device path', { volumes: [{ ...evidence().volumes[0], device: 'C:\\Windows' }] }],
  ['device traversal', { volumes: [{ ...evidence().volumes[0], device: `${device}\\..\\Windows` }] }],
  ['mount traversal', { volumes: [{ ...evidence().volumes[0], root: 'C:\\Data\\..\\' }] }],
  ['duplicate root', { volumes: [evidence().volumes[0], evidence().volumes[0]] }],
  ['inconsistent volume snapshot', { volumes: [evidence().volumes[0], { ...evidence().volumes[0], root: 'D:\\', device: device.replace('42', '43') }] }],
  ['inconsistent snapshot ID', { volumes: [evidence().volumes[0], { ...evidence().volumes[0], root: 'D:\\', guid: guid.replace('01234567', '11234567') }] }],
]) test(`VSS rejects ${name}`, () => { assert.throws(() => mapVssSources(sources, evidence(patch), 'snapshot-only')); });
test('VSS allows two mount roots of the same attested snapshot volume', () => {
  const value = evidence({ volumes: [evidence().volumes[0], { ...evidence().volumes[0], root: 'D:\\' }] }); assert.equal(mapVssSources([{ ...sources[0], path: 'D:\\Data\\zażółć' }], value, 'snapshot-only')[0].path, `${device}\\Data\\zażółć`);
});
test('VSS requires a mapping for every source volume', () => { assert.throws(() => mapVssSources([{ ...sources[0], path: 'D:\\Data' }], evidence(), 'snapshot-only')); });
test('VSS rejects alternate data streams in a source suffix', () => { assert.throws(() => mapVssSources([{ ...sources[0], path: 'C:\\Data\\file:secret' }], evidence(), 'snapshot-only')); });
test('VSS provider exchanges bounded prepare and verified cleanup messages', async () => {
  const child = fakeClient(); const session = await provider(child).prepare(task, { sources });
  assert.equal(session.consistentSnapshot, true); assert.equal(session.sources[0].path, `${device}\\Data\\zażółć`);
  const request = child.requests[0].payload; assert.equal(request.readUInt32LE(0), 0); assert.equal(request.readUInt32LE(4), 1);
  assert.equal(request.subarray(12).toString('utf8'), sources[0].path);
  await Promise.all([session.release(), session.release()]); assert.equal(child.requests.filter(item => item.opcode === 2).length, 1); assert.equal(child.killed, false);
});
test('VSS cleanup failure remains rejected on repeated release', async () => {
  const child = fakeClient({ cleanup: false }); const session = await provider(child).prepare(task, { sources });
  await assert.rejects(session.release(), /deletion/); await assert.rejects(session.release(), /deletion/);
});
test('VSS provider rejects oversized native frames and closes its ordinary client', async () => {
  const child = fakeClient({ invalidHeader: true }); await assert.rejects(provider(child).prepare(task, { sources }), /Oversized/); assert.ok(child.stdin.writableEnded || child.stdin.destroyed);
});
test('VSS is unavailable on other OS and never launches the helper there', async () => {
  let launched = false; const adapter = createVssSourceProvider({ platform: 'linux', launch() { launched = true; throw new Error('unexpected'); } });
  await assert.rejects(adapter.prepare(task), /only on Windows/); assert.equal(launched, false);
});
test('Persistent VSS session serializes leases and reuses one native client until shutdown', async () => {
  const child = fakeClient({ persistent: true }); let launches = 0;
  const adapter = createVssSourceProvider({ helperPath: process.execPath, platform: 'win32', persistent: true, timeoutMs: 1000, launch(_file, args) { launches++; assert.deepEqual(args, ['--session']); return child; } });
  const first = await adapter.prepare(task, { sources }); const secondPromise = adapter.prepare(task, { sources });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(child.requests.filter(item => item.opcode === 1).length, 1);
  await first.release(); const second = await secondPromise; await second.release(); assert.equal(launches, 1);
  assert.equal(child.requests.filter(item => item.opcode === 1).length, 2); assert.equal(child.requests.filter(item => item.opcode === 2).length, 2);
  await adapter.shutdown(); assert.equal(child.requests.filter(item => item.opcode === 4).length, 1);
  await assert.rejects(adapter.prepare(task, { sources }), /shutting down/);
});
test('Persistent VSS preserves the queue when a waiting task is aborted', async () => {
  const child = fakeClient({ persistent: true }); const adapter = createVssSourceProvider({ helperPath: process.execPath, platform: 'win32', persistent: true, timeoutMs: 1000, launch: () => child });
  const first = await adapter.prepare(task, { sources }); const cancellation = new AbortController();
  const cancelled = adapter.prepare(task, { sources, signal: cancellation.signal }); cancellation.abort(); await assert.rejects(cancelled, { name: 'AbortError' });
  const thirdPromise = adapter.prepare(task, { sources }); await new Promise(resolve => setImmediate(resolve)); assert.equal(child.requests.length, 1);
  await first.release(); const third = await thirdPromise; await third.release(); await adapter.shutdown();
  assert.equal(child.requests.filter(item => item.opcode === 1).length, 2);
});
test('Persistent VSS can recover after a prepare failure only with verified cleanup', async () => {
  const child = fakeClient({ persistent: true, prepareErrorAt: 1 }); let launches = 0;
  const adapter = createVssSourceProvider({ helperPath: process.execPath, platform: 'win32', persistent: true, timeoutMs: 1000, launch() { launches++; return child; } });
  await assert.rejects(adapter.prepare(task, { sources }), /Writer unavailable/);
  const session = await adapter.prepare(task, { sources }); await session.release(); await adapter.shutdown(); assert.equal(launches, 1);
});
test('Persistent VSS invalidates an unsafe session after cleanup failure', async () => {
  const clients = [fakeClient({ persistent: true, cleanup: false }), fakeClient({ persistent: true })]; let launches = 0;
  const adapter = createVssSourceProvider({ helperPath: process.execPath, platform: 'win32', persistent: true, timeoutMs: 1000, launch() { return clients[launches++]; } });
  const failed = await adapter.prepare(task, { sources }); await assert.rejects(failed.release(), /deletion/);
  const session = await adapter.prepare(task, { sources }); await session.release(); await adapter.shutdown(); assert.equal(launches, 2);
});
test('Persistent VSS abort closes its elevated session instead of reporting BackupComplete', async () => {
  const child = fakeClient({ persistent: true }); const adapter = createVssSourceProvider({ helperPath: process.execPath, platform: 'win32', persistent: true, timeoutMs: 1000, launch: () => child });
  const cancellation = new AbortController(); const session = await adapter.prepare(task, { sources, signal: cancellation.signal }); cancellation.abort();
  await session.release(); assert.equal(child.requests.filter(item => item.opcode === 2).length, 0); assert.equal(child.requests.filter(item => item.opcode === 4).length, 1); await adapter.shutdown();
});
test('Incomplete VSS copy uses AbortBackup even without an aborted signal', async () => {
  const child = fakeClient({ persistent: true }); const adapter = createVssSourceProvider({ helperPath: process.execPath, platform: 'win32', persistent: true, timeoutMs: 1000, launch: () => child });
  const session = await adapter.prepare(task, { sources }); await session.release({ success: false });
  assert.equal(child.requests.filter(item => item.opcode === 2).length, 0); assert.equal(child.requests.filter(item => item.opcode === 4).length, 1); await adapter.shutdown();
});
test('VSS attaches its bounded snapshot scanner and serializable lease for link following', async () => {
  const child = fakeClient(); const session = await provider(child).prepare({ ...task, symlinks: 'follow' }, { sources });
  assert.equal(session.followsLinksInSnapshot, true); assert.equal(typeof session.scan, 'function'); assert.equal(typeof session.validateSources, 'function');
  assert.deepEqual(session.snapshotLease, evidence()); await session.release();
});
