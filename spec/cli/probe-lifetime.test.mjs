import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { executeTestCommand } from '../helpers/application.mjs';

test('CLI probe timeout settles only after the owned process close event', { timeout: 10_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'delta-probe-lifetime-')); t.after(() => rm(root, { recursive: true, force: true })); const ownerFile = join(root, 'owner-pid');
  const owner = `require('node:fs').writeFileSync(${JSON.stringify(ownerFile)},String(process.pid));setInterval(()=>{},1000);`; let closed = false;
  await assert.rejects(executeTestCommand(process.execPath, ['-e', owner], [], { cwd: root, timeout: 1000, onSpawn(child) { child.once('close', () => { closed = true; }); } }), /timed out/);
  assert.equal(closed, true, 'The helper rejected before observing the owned process close event'); const ownerPid = Number(await readFile(ownerFile, 'utf8')); assert.throws(() => process.kill(ownerPid, 0), e => e.code === 'ESRCH');
});
test('CLI probe reports EXECUTION_UNSETTLED when termination cannot close its owned process', { timeout: 10_000 }, async () => {
  let owned, originalKill;
  try {
    await assert.rejects(executeTestCommand(process.execPath, ['-e', 'setInterval(()=>{},1000)'], [], { timeout: 100, onSpawn(child) { owned = child; originalKill = child.kill.bind(child); child.kill = () => false; } }), e => e.code === 'EXECUTION_UNSETTLED');
    assert.doesNotThrow(() => process.kill(owned.pid, 0), 'The test must leave a genuinely unsettled owned process for the caller to handle');
  } finally { if (owned && originalKill) await new Promise(resolve => { owned.once('close', resolve); originalKill(); }); }
});
