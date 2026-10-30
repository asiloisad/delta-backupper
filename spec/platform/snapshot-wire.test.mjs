import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer, connect } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const directory = await mkdtemp(path.join(tmpdir(), 'delta-snapshot-wire-')); test.after(() => rm(directory, { recursive: true, force: true }));
const bundle = path.join(directory, 'wire.mjs'); await build({ entryPoints: ['src/platform/snapshot-wire.ts'], outfile: bundle, bundle: true, platform: 'node', target: 'node24', format: 'esm', logLevel: 'silent' });
const { SnapshotWire, SNAPSHOT_FRAME_LIMIT, snapshotFailure } = await import(pathToFileURL(bundle).href);

class Socket extends EventEmitter {
  destroyed = false; writableEnded = false; writes = []; delayed = false; callbacks = [];
  write(bytes, callback) { this.writes.push(Buffer.from(bytes)); if (this.delayed) this.callbacks.push(callback); else queueMicrotask(() => callback()); return true; }
  destroy() { if (!this.destroyed) { this.destroyed = true; queueMicrotask(() => this.emit('close')); } }
  end() { this.writableEnded = true; }
}
function fixture() { const socket = new Socket(); return { socket, wire: new SnapshotWire(socket) }; }
const encoded = value => Buffer.from(`${JSON.stringify(value)}\n`);
const bounded = promise => Promise.race([promise.then(() => 'resolved', error => error.message), new Promise(resolve => setTimeout(() => resolve('did not settle promptly'), 50))]);

test('snapshot wire reconstructs arbitrarily split Unicode frames and preserves complete message order', async () => {
  const { socket, wire } = fixture(), messages = [{ id: 'a', text: 'zażółć Δ 日本語 🔐' }, { id: 'b', healthy: true }];
  const first = wire.read(); for (const byte of Buffer.concat(messages.map(encoded))) socket.emit('data', Buffer.from([byte]));
  assert.deepEqual(await first, messages[0]); assert.deepEqual(await wire.read(), messages[1]); wire.close(); assert.equal(socket.writableEnded, true);
});
for (const [label, bytes, pattern] of [
  ['invalid UTF-8', Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d, 0x0a]), /UTF-8/],
  ['non-object JSON', Buffer.from('null\n'), /document/], ['array JSON', Buffer.from('[]\n'), /document/], ['invalid JSON', Buffer.from('{broken}\n'), /JSON|property/i],
  ['oversized unterminated frame', Buffer.alloc(SNAPSHOT_FRAME_LIMIT + 1, 0x61), /Oversized/],
  ['oversized terminated frame', Buffer.concat([Buffer.alloc(SNAPSHOT_FRAME_LIMIT, 0x61), Buffer.from('\n')]), /Oversized/],
]) test(`snapshot wire fails closed on ${label}`, async () => {
  const { socket, wire } = fixture(), pending = wire.read(); socket.emit('data', bytes); await assert.rejects(pending, pattern); await assert.rejects(wire.read(), pattern); assert.equal(socket.destroyed, true);
});
test('snapshot protocol failure invalidates queued healthy replies rather than delivering stale success', async () => {
  const { socket, wire } = fixture(); socket.emit('data', Buffer.concat([encoded({ healthy: true }), Buffer.from('not JSON\n')])); await assert.rejects(wire.read()); assert.equal(socket.destroyed, true);
});
test('snapshot wire bounds unsolicited replies and discards them after queue overflow', async () => {
  const { socket, wire } = fixture(); socket.emit('data', Buffer.concat(Array.from({ length: 9 }, (_, id) => encoded({ id })))); await assert.rejects(wire.read(), /queue overflow/); assert.equal(socket.destroyed, true);
});
test('snapshot wire rejects concurrent readers without replacing the outstanding read', async () => {
  const { socket, wire } = fixture(), pending = wire.read(); await assert.rejects(wire.read(), /Concurrent/); socket.emit('data', encoded({ healthy: true })); assert.deepEqual(await pending, { healthy: true }); wire.close();
});
test('snapshot read timeout closes the connection and rejects later reads', async () => {
  const { socket, wire } = fixture(); await assert.rejects(wire.read(5), /timed out/); assert.equal(socket.destroyed, true); await assert.rejects(wire.read(), /timed out/);
});
for (const event of ['error', 'close', 'end']) test(`snapshot wire settles an outstanding read on socket ${event}`, async () => {
  const { socket, wire } = fixture(), pending = wire.read(); socket.emit(event, ...(event === 'error' ? [new Error('socket failed')] : [])); await assert.rejects(pending, /socket failed|connection|disconnected|closed/); assert.equal(socket.destroyed, true);
});
test('snapshot wire encodes bounded UTF-8 messages and rejects oversized outgoing frames', async () => {
  const { socket, wire } = fixture(), value = { id: 'a', text: 'Δ 🔐' }; await wire.send(value); assert.deepEqual(socket.writes[0], encoded(value));
  await assert.rejects(wire.send({ text: 'x'.repeat(SNAPSHOT_FRAME_LIMIT) }), /limit/); assert.equal(socket.writes.length, 1); wire.close();
});
test('snapshot write callbacks propagate their error and invalidate the connection', async () => {
  const { socket, wire } = fixture(); socket.delayed = true; const pending = wire.send({ id: 'a' }); socket.callbacks.shift()(new Error('write failed')); await assert.rejects(pending, /write failed/); assert.equal(socket.destroyed, true); await assert.rejects(wire.read(), /write failed/);
});
for (const event of ['error', 'close', 'end']) test(`snapshot wire promptly settles a pending write on socket ${event}`, async () => {
  const { socket, wire } = fixture(); socket.delayed = true; const pending = wire.send({ id: 'a' }); socket.emit(event, ...(event === 'error' ? [new Error('write socket failed')] : []));
  assert.match(await bounded(pending), /write socket failed|connection|disconnected|closed/); assert.equal(socket.destroyed, true);
});
test('snapshot write timeout is fatal and does not leave an unsettled write timer', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const { socket, wire } = fixture(); socket.delayed = true; const pending = wire.send({ id: 'a' }); t.mock.timers.tick(15001);
  await assert.rejects(pending, /write timed out/); assert.equal(socket.destroyed, true); await assert.rejects(wire.read(), /write timed out/);
});
test('snapshot close rejects pending operations and disallows new writes', { timeout: 500 }, async () => {
  const { socket, wire } = fixture(); const pending = wire.read(); wire.close(); const outcome = await bounded(pending); socket.emit('close'); assert.match(outcome, /closed/); await assert.rejects(wire.send({ id: 'after-close' }), /closed/); assert.equal(socket.writableEnded || socket.destroyed, true);
});
test('snapshot failure metadata preserves the cleanup boundary', () => {
  const error = snapshotFailure('cleanup failed', 'SNAPSHOT_CLEANUP_UNVERIFIED', false); assert.equal(error.code, 'SNAPSHOT_CLEANUP_UNVERIFIED'); assert.equal(error.cleanupVerified, false); assert.equal(error.message, 'cleanup failed');
});
test('snapshot wire exchanges real loopback socket messages without native snapshot privileges', async t => {
  const server = createServer(); t.after(() => server.close()); const accepted = new Promise(resolve => server.once('connection', resolve));
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const client = connect(server.address().port, '127.0.0.1'); t.after(() => client.destroy()); await new Promise((resolve, reject) => { client.once('connect', resolve); client.once('error', reject); });
  const peer = await accepted; t.after(() => peer.destroy()); const left = new SnapshotWire(client), right = new SnapshotWire(peer);
  await left.send({ id: '1', command: 'verify' }); assert.deepEqual(await right.read(), { id: '1', command: 'verify' }); await right.send({ id: '1', ok: true, value: { healthy: true } }); assert.deepEqual(await left.read(), { id: '1', ok: true, value: { healthy: true } });
  const pending = left.read(); right.close(); await assert.rejects(pending, /closed|disconnected/); left.close();
});
