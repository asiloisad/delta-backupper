import test from 'node:test';
import assert from 'node:assert/strict';
import { exerciseApplication } from '../helpers/application.mjs';

test('actual CLI creates, backs up, verifies and restores public application operations', { timeout: 120_000 }, async () => {
  const report = await exerciseApplication(); assert.equal(report.status, 'passed'); assert.ok(report.checks.length >= 35);
});
