import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { EventEmitter } from 'node:events';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const root = await mkdtemp(path.join(tmpdir(), 'delta-wakeups-')); after(() => rm(root, { recursive: true, force: true }));
const filename = path.join(root, 'wakeups.cjs'); await build({ entryPoints: ['src/core/scheduler-wakeups.ts'], outfile: filename, bundle: true, platform: 'node', target: 'node24', format: 'cjs', logLevel: 'silent' });
const { SchedulerWakeups } = createRequire(import.meta.url)(filename);
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
test('sleep suppresses new checks and resume immediately checks missed work once', async t => {
  const power = new EventEmitter(); let calls = 0;
  const scheduler = new SchedulerWakeups({ power, check: async () => { calls++; }, report: assert.fail, intervalMs: 60000 }); t.after(() => scheduler.close());
  power.emit('suspend'); await scheduler.check(); assert.equal(calls, 0); assert.equal(scheduler.suspended, true);
  power.emit('resume'); await scheduler.check(); assert.equal(calls, 1); assert.equal(scheduler.suspended, false);
  scheduler.close(); power.emit('resume'); await scheduler.check(); assert.equal(calls, 1);
  assert.equal(power.listenerCount('resume'), 0); assert.equal(power.listenerCount('suspend'), 0);
});
test('overlapping timer or wake requests never overlap work and coalesce to one recheck', async t => {
  const power = new EventEmitter(), gate = deferred(); let calls = 0, active = 0, peak = 0;
  const scheduler = new SchedulerWakeups({ power, check: async () => { calls++; active++; peak = Math.max(peak, active); if (calls === 1) await gate.promise; active--; }, report: assert.fail, intervalMs: 60000 }); t.after(() => scheduler.close());
  const first = scheduler.check(); await Promise.resolve();
  const requests = Array.from({ length: 20 }, () => scheduler.check()); power.emit('suspend'); power.emit('resume');
  gate.resolve(); await Promise.all([first, ...requests]); assert.equal(calls, 2); assert.equal(peak, 1);
});
test('a failed check reports the error and the next wake can retry', async t => {
  const power = new EventEmitter(), errors = []; let calls = 0;
  const scheduler = new SchedulerWakeups({ power, check: async () => { if (++calls === 1) throw new Error('Destination is temporarily unavailable'); }, report: error => errors.push(error.message), intervalMs: 60000 }); t.after(() => scheduler.close());
  await scheduler.check(); assert.equal(errors.length, 1); await scheduler.check(); assert.equal(calls, 2);
});
test('closing while a check is in flight removes wake listeners and cancels queued rechecks', async () => {
  const power = new EventEmitter(), gate = deferred(); let calls = 0;
  const scheduler = new SchedulerWakeups({ power, check: async () => { calls++; await gate.promise; }, report: assert.fail, intervalMs: 60000 });
  const first = scheduler.check(); await Promise.resolve(); scheduler.check(); scheduler.close(); scheduler.close(); gate.resolve(); await first;
  power.emit('resume'); await scheduler.check(); assert.equal(calls, 1); assert.equal(power.listenerCount('resume'), 0);
});
