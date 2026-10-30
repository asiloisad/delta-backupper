import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const temporary = await mkdtemp(join(tmpdir(), 'delta-shortcuts-')); after(() => rm(temporary, { recursive: true, force: true }));
const filename = join(temporary, 'shortcuts.cjs'); await build({ entryPoints: ['src/platform/window-shortcuts.ts'], outfile: filename, bundle: true, platform: 'node', target: 'node24', format: 'cjs', logLevel: 'silent' });
const { windowShortcut } = createRequire(import.meta.url)(filename);
const key = (name, modifiers = {}) => ({ type: 'keyDown', key: name, ...modifiers });

test('Ctrl+Shift+I opens developer tools and Ctrl+Shift+F5 has no application binding', () => {
  for (const platform of ['win32', 'linux', 'darwin']) { assert.equal(windowShortcut(key('F5', { control: true, shift: true }), platform), undefined); assert.equal(windowShortcut(key('I', { control: true, shift: true }), platform), 'devtools'); }
});

test('plain reload keys and key releases have no application shortcut', () => {
  for (const input of [key('F5'), key('F5', { control: true }), key('F5', { shift: true }), key('F5', { control: true, shift: true, alt: true }), key('F5', { control: true, shift: true, meta: true }), key('r', { control: true }), { type: 'keyUp', key: 'F5', control: true, shift: true }]) assert.equal(windowShortcut(input, 'win32'), undefined);
});

test('F12 and the macOS Cmd+Alt+I alias remain developer tools shortcuts', () => {
  assert.equal(windowShortcut(key('F12'), 'win32'), 'devtools'); assert.equal(windowShortcut(key('i', { meta: true, alt: true }), 'darwin'), 'devtools'); assert.equal(windowShortcut(key('i', { meta: true, alt: true }), 'linux'), undefined);
});
