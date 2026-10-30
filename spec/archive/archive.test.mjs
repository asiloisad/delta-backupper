import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { smoke, cancellation } from '../helpers/archive/cases.mjs';
import { find7zip } from '../helpers/archive/support.mjs';

const base = resolve('.dev/stage0/archive-tests');
async function fixture(name) {
  await mkdir(base, { recursive: true });
  return mkdtemp(join(base, `${name}-`));
}

test('plain ZIP64 round-trip preserves Unicode and empty files', async () => {
  const result = await smoke({ directory: await fixture('smoke'), tool: await find7zip() });
  assert.equal(result.unicodeNames, true);
  assert.equal(result.trailer.zip64End, true);
});

test('cancellation stops source consumption and leaves an unfinished part', async () => {
  const result = await cancellation({ directory: await fixture('cancel') });
  assert.ok(result.consumedBytes < result.expectedBytes);
  assert.equal(result.finalized, false);
  assert.equal(result.unfinishedOutput.zip64End, false);
});
