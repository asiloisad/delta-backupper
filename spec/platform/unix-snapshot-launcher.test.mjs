import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { resolveTaskSources } from '../../src/domain/source-identity.mjs';

const directory = await mkdtemp(path.join(tmpdir(), 'delta-unix-launcher-')); test.after(() => rm(directory, { recursive: true, force: true }));
const bundle = path.join(directory, 'launcher.mjs');
await build({ stdin: { contents: 'export { quoteSnapshotShellArgument, macSnapshotAuthorizationScript, createUnixSnapshotSourceProvider, snapshotSourceRoots } from "./src/platform/unix-snapshots.ts"; export { parseSnapshotHelperArguments, validateSnapshotSourceRoots } from "./src/platform/linux-snapshot-helper.ts"; export { trustedSnapshotCommand, runSnapshotCommand } from "./src/platform/snapshot-commands.ts";', resolveDir: process.cwd(), sourcefile: 'launcher-test-entry.mjs' }, outfile: bundle, bundle: true, platform: 'node', target: 'node24', format: 'esm', logLevel: 'silent' });
const { quoteSnapshotShellArgument, macSnapshotAuthorizationScript, createUnixSnapshotSourceProvider, snapshotSourceRoots, parseSnapshotHelperArguments, validateSnapshotSourceRoots, trustedSnapshotCommand, runSnapshotCommand } = await import(pathToFileURL(bundle).href);

test('privileged source wire contains exactly id and path while original scanner filters remain unchanged', () => {
  const task = { id: '12345678-1234-4234-8234-123456789abc', sources: [{ path: '/data/source', filters: { include: ['**/*.txt'], exclude: ['**/private/**'] } }] }, configured = structuredClone(task.sources);
  const sources = resolveTaskSources(task), original = structuredClone(sources);
  const wire = snapshotSourceRoots(sources); assert.deepEqual(wire, [{ id: sources[0].id, path: sources[0].path }]); assert.deepEqual(validateSnapshotSourceRoots(wire), wire); assert.deepEqual(sources, original); assert.deepEqual(task.sources, configured); assert(!Object.hasOwn(task.sources[0], 'id'));
  for (const extra of [{ filters: sources[0].filters }, { label: 'unsupported source name' }, { sourceFile: '/private' }]) assert.throws(() => validateSnapshotSourceRoots([{ ...wire[0], ...extra }]), /Invalid snapshot source/);
});

function argumentsFromQuotedShell(text) {
  const result = []; let value = '', quoted = false, active = false;
  for (let index = 0; index < text.length; index++) { const character = text[index]; if (character === "'") { quoted = !quoted; active = true; } else if (!quoted && character === '\\') { assert.ok(index + 1 < text.length); value += text[++index]; active = true; } else if (!quoted && character === ' ') { if (active) { result.push(value); value = ''; active = false; } } else { assert.ok(quoted, `unexpected unquoted shell token ${character}`); value += character; active = true; } }
  assert.equal(quoted, false); if (active) result.push(value); return result;
}
test('snapshot authorization quotes every shell argument without executing substitutions', () => {
  const values = ['', 'ordinary', '/path with spaces/Delta', "single'quote", 'double"quote', '$(touch /never-create)', '`command`', '; rm -rf /never', 'a\nb\rc\td', 'zażółć Δ 日本語 🔐', '--option=value', '\\slashes\\'];
  assert.deepEqual(argumentsFromQuotedShell(values.map(quoteSnapshotShellArgument).join(' ')), values);
  for (const value of ['nul\0value', '\ud800', '\udfff']) assert.throws(() => quoteSnapshotShellArgument(value), /Invalid/);
});
test('macOS authorization encloses the entire quoted command in one AppleScript string', () => {
  const executable = "/Applications/Delta 'quoted' \\\" app/delta-snapshot", values = ['--socket', '/private/tmp/with spaces/control.sock', '--nonce', "'; do shell script \"injected\"; '", 'Δ日本語'];
  const script = macSnapshotAuthorizationScript(executable, values), prefix = 'do shell script ', suffix = ' with administrator privileges'; assert.ok(script.startsWith(prefix)); assert.ok(script.endsWith(suffix));
  const command = JSON.parse(script.slice(prefix.length, -suffix.length)); assert.deepEqual(argumentsFromQuotedShell(command), [executable, ...values]);
});
test('Unix source provider rejects an unsupported OS without launching authorization', async () => {
  let launched = false; const provider = createUnixSnapshotSourceProvider({ platform: 'freebsd', launch() { launched = true; throw new Error('unexpected'); } });
  await assert.rejects(provider.prepare({ snapshot: { mode: 'snapshot-only' } }), error => error.cleanupVerified === true && error.code === 'SNAPSHOT_UNSUPPORTED'); assert.equal(launched, false); await provider.shutdown();
});
test('Unix snapshots reject disabled and Windows writer modes before authorization', async () => {
  for (const mode of ['off', 'writers']) { let launched = false; const provider = createUnixSnapshotSourceProvider({ platform: 'linux', launch() { launched = true; throw new Error('unexpected'); } }); await assert.rejects(provider.prepare({ snapshot: { mode } }), error => error.cleanupVerified === true && error.code === 'SNAPSHOT_UNSUPPORTED_MODE'); assert.equal(launched, false); await provider.shutdown(); }
});
test('Unix source provider refuses root or a host without ordinary Unix user identity', { skip: process.getuid?.() > 0 }, async () => {
  let launched = false; const provider = createUnixSnapshotSourceProvider({ platform: 'linux', launch() { launched = true; throw new Error('unexpected'); } });
  await assert.rejects(provider.prepare({ snapshot: { mode: 'snapshot-only' } }, { sources: [{ id: 'a', path: '/source' }] }), error => error.cleanupVerified === true && error.code === 'SNAPSHOT_NORMAL_USER_REQUIRED'); assert.equal(launched, false); await provider.shutdown();
});
test('Unix source provider rejects malformed source requests before authorization', async () => {
  for (const sources of [[], [{ id: 'source', path: 'relative' }], [{ id: 'source', path: '/source\0bad' }], Array.from({ length: 65 }, (_, index) => ({ id: `source-${index}`, path: '/source' }))]) {
    let launched = false; const provider = createUnixSnapshotSourceProvider({ platform: 'linux', launch() { launched = true; throw new Error('unexpected'); } }); await assert.rejects(provider.prepare({ snapshot: { mode: 'snapshot-only' } }, { sources }), error => error.cleanupVerified === true && error.code === 'SNAPSHOT_INVALID_SOURCE'); assert.equal(launched, false); await provider.shutdown();
  }
});
const arguments_ = ['--socket', '/tmp/delta-snapshot-Abc123/control.sock', '--nonce', 'a'.repeat(64), '--uid', '1000', '--gid', '1000'];
test('Linux helper parsing accepts only the exact bounded control identity', () => {
  assert.deepEqual(parseSnapshotHelperArguments(arguments_), { socket: arguments_[1], nonce: arguments_[3], uid: 1000, gid: 1000 });
  assert.equal(parseSnapshotHelperArguments([...arguments_.slice(0, 6), '--gid', '0']).gid, 0);
});
test('Linux helper argument parser rejects control-path, identity and duplicated-option substitutions', () => {
  const invalid = [arguments_.slice(0, -1), [...arguments_, '--extra', 'x'], ['--socket', '/tmp/arbitrary.sock', ...arguments_.slice(2)], ['--socket', '/tmp/delta-snapshot-A/../B/control.sock', ...arguments_.slice(2)], ['--socket', '/tmp/delta-snapshot-A/control.sock/extra', ...arguments_.slice(2)], ['--socket', '/tmp/delta-snapshot-A/control.sock\0', ...arguments_.slice(2)], [...arguments_.slice(0, 2), '--nonce', 'a'.repeat(63), ...arguments_.slice(4)], [...arguments_.slice(0, 2), '--nonce', 'A'.repeat(64), ...arguments_.slice(4)], [...arguments_.slice(0, 4), '--uid', '0', '--gid', '1000'], [...arguments_.slice(0, 4), '--uid', '01', '--gid', '1000'], [...arguments_.slice(0, 4), '--uid', '4294967296', '--gid', '1000'], [...arguments_.slice(0, 4), '--uid', '-1', '--gid', '1000'], [...arguments_.slice(0, 4), '--uid', '1000', '--uid', '1000']];
  for (const value of invalid) assert.throws(() => parseSnapshotHelperArguments(value), /Invalid|requires|outside/);
});
test('privileged snapshot command selection rejects arbitrary executables and malformed arguments before spawn', async () => {
  for (const name of ['sh', 'sudo', '/usr/bin/zfs', 'zfs;id', 'powershell', '../mount', '']) await assert.rejects(trustedSnapshotCommand(name), /unknown command/);
  for (const values of [['/source\0bad'], [1], new Array(1025).fill('a'), ['x'.repeat(32769)]]) await assert.rejects(runSnapshotCommand('mount', values), /Invalid snapshot command arguments/);
});
