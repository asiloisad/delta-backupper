import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const directory = await mkdtemp(path.join(tmpdir(), 'delta-tray-tooltip-'));
after(() => { assert.equal(path.dirname(directory), path.resolve(tmpdir())); return rm(directory, { recursive: true, force: true }); });
const bundle = path.join(directory, 'tooltip.cjs');
await build({ entryPoints: ['src/platform/tray-tooltip.ts'], outfile: bundle, bundle: true, platform: 'node', target: 'node24', format: 'cjs', logLevel: 'silent' });
const { createTrayTooltip } = createRequire(import.meta.url)(bundle);
const tasks = [{ id: 'documents', name: 'Documents' }, { id: 'photos', name: 'Photos' }];
const operation = (overrides = {}) => ({ id: 'operation', taskId: 'documents', action: 'run', status: 'running', startedAt: '2026-10-30T00:00:00Z', ...overrides });

test('idle tooltip clears completed work and active work uses cached names', () => {
  assert.equal(createTrayTooltip(tasks, []), 'Delta Backupper');
  assert.equal(createTrayTooltip(tasks, [operation({ status: 'complete' }), operation({ status: 'failed' })]), 'Delta Backupper');
  assert.match(createTrayTooltip(tasks, [operation()]), /Documents: Backing up/);
  assert.match(createTrayTooltip([{ id: 'documents', name: 'Renamed task' }], [operation()]), /Renamed task:/);
  assert.match(createTrayTooltip([], [operation({ taskId: 'private/path/task' })]), /Task: Backing up/);
  assert(!createTrayTooltip([], [operation({ taskId: 'private/path/task' })]).includes('private/path'));
});

test('in-flight bytes determine percentage before any file is finished', () => {
  const tooltip = createTrayTooltip(tasks, [operation({ progress: { phase: 'backup', files: 0, bytes: 0, completedFiles: 0, completedBytes: 512 * 1024 ** 2, totalBytes: 1024 ** 3, totalFiles: 1 } })]);
  assert.match(tooltip, /Documents: 50%/); assert.match(tooltip, /512 MiB/); assert.match(tooltip, /0 files/);
});

test('zero-byte file operations use real file totals while unknown work stays indeterminate', () => {
  assert.match(createTrayTooltip(tasks, [operation({ progress: { files: 2, totalFiles: 8, bytes: 0, totalBytes: 0 } })]), /25%/);
  const scan = createTrayTooltip(tasks, [operation({ progress: { phase: 'scan', files: 15, bytes: 2048 } })]);
  assert.match(scan, /Scanning/); assert.match(scan, /15 files/); assert.match(scan, /2 KiB/); assert(!scan.includes('%'));
  assert.match(createTrayTooltip(tasks, [operation({ progress: { phase: 'finalizing' } })]), /Finalizing/);
});

test('paused and queued labels override stale phases and queue percentages', () => {
  assert.match(createTrayTooltip(tasks, [operation({ paused: true, progress: { completedBytes: 3, totalBytes: 10 } })]), /Paused · 30%/);
  const queued = createTrayTooltip(tasks, [operation({ status: 'queued', progress: { completedBytes: 10, totalBytes: 10, phase: 'backup' } })]);
  assert.match(queued, /Queued/); assert(!queued.includes('%'));
  assert.match(createTrayTooltip(tasks, [operation({ status: 'queued', paused: true })]), /Paused \(queued\)/);
});

test('multiple tasks retain statuses, prioritize running work and summarize overflow', () => {
  const values = [operation({ taskId: 'photos', id: 'q', status: 'queued' }), operation({ id: 'p', paused: true, progress: { files: 2, totalFiles: 10 } }), operation({ id: 'r', progress: { files: 1, totalFiles: 10 } }), operation({ id: 'more', status: 'queued' })];
  const tooltip = createTrayTooltip(tasks, values, 'win32');
  assert(tooltip.length <= 127); assert.match(tooltip, /4 active/); assert.match(tooltip.split('\n')[1], /10%/);
  assert.match(tooltip, /Paused/); assert.match(tooltip, /Queued/); assert.match(tooltip, /\+1 more/);
  assert.equal(createTrayTooltip(tasks, values, 'linux').includes('+1 more'), false);
});

test('long Unicode names cannot consume statuses or break native tooltip limits', () => {
  const names = [{ id: 'documents', name: 'żółć 🌍'.repeat(100) + '\ud800\n\u0000Injected line' }];
  for (const length of [1, 2, 3, 10, 100]) {
    const values = Array.from({ length }, (_, index) => operation({ id: String(index), progress: { completedBytes: index + 1, totalBytes: length * 100 } }));
    const tooltip = createTrayTooltip(names, values, 'win32');
    assert(tooltip.length <= 127); assert(tooltip.isWellFormed()); assert(!tooltip.includes('\u0000')); assert.match(tooltip, /%/);
    assert(tooltip.split('\n').length <= 5);
  }
});

test('invalid, unsafe or overshot counters never become fabricated percentages', () => {
  for (const progress of [{ bytes: 11, totalBytes: 10 }, { bytes: NaN, totalBytes: 10 }, { bytes: 1, totalBytes: Infinity }, { files: -1, totalFiles: 10 }, { files: 2, totalFiles: 1 }, { bytes: 2 ** 54, totalBytes: 2 ** 54 }, { bytes: 1.5, totalBytes: 10 }]) {
    const tooltip = createTrayTooltip(tasks, [operation({ progress })]);
    assert(!tooltip.includes('%')); assert(!/NaN|Infinity/.test(tooltip));
  }
});
