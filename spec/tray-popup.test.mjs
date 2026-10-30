import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const temporary = await mkdtemp(join(tmpdir(), 'delta-tray-popup-')); after(() => rm(temporary, { recursive: true, force: true }));
const filename = join(temporary, 'tray.cjs'); await build({ entryPoints: ['src/platform/tray-popup.ts'], outfile: filename, bundle: true, platform: 'node', target: 'node24', format: 'cjs', logLevel: 'silent' });
const { TrayPopup, createTraySnapshot, trayPopupBounds, validateTrayRequest } = createRequire(import.meta.url)(filename);
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const deferred = () => { let resolve; const promise = new Promise(value => { resolve = value; }); return { promise, resolve }; };
const operation = (index, changes = {}) => ({ id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`, taskId: 'task-1', action: 'run', status: 'running', startedAt: '2026-10-29T12:00:00.000Z', ...changes });
const app = { theme: 'dark', themeFamily: 'one', schedulerPaused: false };
const anchor = { x: 800, y: 780, width: 24, height: 20 };
function fixture(t, options = {}) {
  const requests = new Map(), windows = [], actions = [], failures = []; let reads = 0;
  const snapshot = createTraySnapshot(app, [{ id: 'task-1', name: 'Documents' }], [operation(1)], Date.parse('2026-10-29T12:00:30Z'));
  class Window extends EventEmitter {
    constructor(settings) {
      super(); this.settings = settings; this.visible = false; this.focused = false; this.destroyed = false; this.shows = 0; this.focuses = 0; this.messages = []; this.css = []; this.removedCss = [];
      this.webContents = Object.assign(new EventEmitter(), { mainFrame: { url: pathToFileURL(join(temporary, 'tray.html')).href }, setWindowOpenHandler: handler => { this.openHandler = handler; }, send: (...args) => this.messages.push(args), isLoadingMainFrame: () => false, insertCSS: async css => { if (options.cssGate) await options.cssGate.promise; const key = `css-${this.css.length}`; this.css.push({ css, key }); return key; }, removeInsertedCSS: async key => { this.removedCss.push(key); } });
    }
    isDestroyed() { return this.destroyed; }
    isVisible() { return this.visible; }
    isFocused() { return this.focused; }
    setBounds(value) { this.bounds = value; }
    getBounds() { return this.bounds ?? { x: 0, y: 0, width: this.settings.width, height: this.settings.height }; }
    setBackgroundColor(value) { this.background = value; }
    async loadFile() { if (options.loadGate) await options.loadGate.promise; this.webContents.emit('did-finish-load'); }
    show() { assert(!this.destroyed); this.visible = true; this.shows++; }
    focus() { assert(!this.destroyed); this.focuses++; this.focused = true; }
    hide() { const wasVisible = this.visible; this.visible = false; this.focused = false; if (wasVisible) this.emit('blur'); }
    destroy() { this.destroyed = true; this.visible = false; this.emit('closed'); }
  }
  const controller = new TrayPopup({ createWindow: settings => { const window = new Window(settings); windows.push(window); return window; }, ipc: { handle: (name, handler) => requests.set(name, handler), removeHandler: name => requests.delete(name) }, workArea: () => ({ x: 0, y: 0, width: 1000, height: 780 }), snapshot: async () => { reads++; return snapshot; }, action: async request => { actions.push(request); }, background: () => '#282c34', report: error => failures.push(error), file: join(temporary, 'tray.html'), preload: join(temporary, 'tray-preload.cjs'), throttleMs: 15 });
  t.after(() => controller.close());
  const invoke = request => { const window = controller.window; return requests.get('delta:tray-request')({ sender: window.webContents, senderFrame: window.webContents.mainFrame }, request); };
  return { controller, windows, requests, actions, failures, snapshot, invoke, reads: () => reads };
}

test('tray snapshot exposes actual progress and bounded recent history without operation results or task settings', () => {
  const values = [operation(1, { progress: { phase: 'backup', files: 4, bytes: 100, completedFiles: 4, completedBytes: 150, totalBytes: 1000, path: 'source/document', token: 'SECRET', errors: NaN }, result: { password: 'SECRET' } }), ...Array.from({ length: 9 }, (_, index) => operation(index + 2, { status: 'complete', finishedAt: `2026-10-29T12:00:${String(index).padStart(2, '0')}.000Z` }))];
  const snapshot = createTraySnapshot({ ...app, updates: { repository: 'private' } }, [{ id: 'task-1', name: 'Documents', directory: 'PRIVATE' }], values, 123);
  assert.equal(snapshot.operations.length, 6); assert.equal(snapshot.now, 123); assert.deepEqual(snapshot.tasks, [{ id: 'task-1', name: 'Documents' }]);
  assert.deepEqual(snapshot.operations[0].progress, { phase: 'backup', path: 'source/document', files: 4, bytes: 100, completedFiles: 4, completedBytes: 150, totalBytes: 1000 }); assert.equal(snapshot.operations[1].id, operation(10).id);
  assert(!JSON.stringify(snapshot).includes('SECRET')); assert(!JSON.stringify(snapshot).includes('PRIVATE')); assert(!Object.hasOwn(snapshot.app, 'updates'));
});

test('tray popup bounds fit every display edge, negative coordinates and small work areas', () => {
  for (const area of [{ x: 0, y: 0, width: 1920, height: 1040 }, { x: -1920, y: -100, width: 1920, height: 1040 }, { x: 0, y: 0, width: 300, height: 200 }, { x: 0, y: 0, width: 5, height: 5 }]) {
    for (const point of [{ x: area.x - 20, y: area.y }, { x: area.x + area.width, y: area.y }, { x: area.x, y: area.y - 20 }, { x: area.x + area.width - 20, y: area.y + area.height }]) {
      const bounds = trayPopupBounds({ ...point, width: 20, height: 20 }, area);
      assert(bounds.x >= area.x && bounds.y >= area.y); assert(bounds.x + bounds.width <= area.x + area.width && bounds.y + bounds.height <= area.y + area.height); assert(bounds.width > 0 && bounds.height > 0);
    }
  }
});

test('tray requests allow only explicit menu actions and a valid cancellation operation ID', () => {
  for (const value of [null, [], {}, { action: 'run' }, { action: ['open'] }, { action: { toString: () => 'open' } }, { action: 'open', path: 'C:\\private' }, { action: 'snapshot', operationId: operation(1).id }, { action: 'cancel' }, { action: 'cancel', operationId: 'unknown' }, { action: 'open', taskId: '../task' }, { action: 'open', taskId: undefined }, { action: 'pause', taskId: operation(1).id }, { action: 'cancel', operationId: operation(1).id, taskId: operation(1).id }, { action: 'resize', height: 119 }, { action: 'resize', height: 561 }, { action: 'resize', height: '132' }, { action: 'resize', height: 120.5 }, { action: 'resize', height: 132, width: 1000 }]) assert.throws(() => validateTrayRequest(value));
  assert.deepEqual(validateTrayRequest({ action: 'cancel', operationId: operation(1).id }), { action: 'cancel', operationId: operation(1).id }); assert.deepEqual(validateTrayRequest({ action: 'snapshot' }), { action: 'snapshot' });
  assert.deepEqual(validateTrayRequest({ action: 'open', taskId: operation(1).id }), { action: 'open', taskId: operation(1).id }); assert.deepEqual(validateTrayRequest({ action: 'resize', height: 120 }), { action: 'resize', height: 120 });
});

test('only the popup own exact main frame can read its projection or invoke actions', async t => {
  const f = fixture(t); await f.controller.show(anchor); const window = f.controller.window, handle = f.requests.get('delta:tray-request');
  for (const event of [{ sender: {}, senderFrame: window.webContents.mainFrame }, { sender: window.webContents, senderFrame: { ...window.webContents.mainFrame } }]) await assert.rejects(handle(event, { action: 'snapshot' }), /Untrusted/);
  const url = window.webContents.mainFrame.url; window.webContents.mainFrame.url = 'file:///foreign.html'; await assert.rejects(f.invoke({ action: 'open' }), /Untrusted/); window.webContents.mainFrame.url = url;
  assert.deepEqual(await f.invoke({ action: 'snapshot' }), f.snapshot); await f.invoke({ action: 'pause' }); assert.deepEqual(f.actions, [{ action: 'pause' }]);
  assert.equal(window.settings.webPreferences.sandbox, true); assert.equal(window.settings.webPreferences.contextIsolation, true); assert.equal(window.settings.webPreferences.nodeIntegration, false); assert.equal(window.settings.frame, false); assert.equal(window.settings.skipTaskbar, true);
  assert.deepEqual(window.openHandler({ url: 'https://example.com' }), { action: 'deny' }); let prevented = false; window.webContents.emit('will-navigate', { preventDefault() { prevented = true; } }); assert(prevented);
});

test('progress notifications coalesce without reopening or refocusing, and hidden popups stop refreshes', async t => {
  const f = fixture(t); await f.controller.show(anchor); const window = f.controller.window;
  for (let index = 0; index < 100; index++) f.controller.update(); await pause(40);
  assert.equal(window.shows, 1); assert.equal(window.focuses, 1); assert(f.reads() <= 3); assert.equal(window.messages.at(-1)[0], 'delta:tray-update');
  f.controller.hide(); const reads = f.reads(); for (let index = 0; index < 20; index++) f.controller.update(); await pause(30); assert.equal(f.reads(), reads); assert.equal(window.isVisible(), false); assert.deepEqual(f.failures, []);
});

test('compact menu fits its real content height without exposing width or position control and keeps its anchor', async t => {
  const f = fixture(t); await f.controller.show(anchor); const window = f.controller.window;
  assert.equal(window.settings.width, 340); assert.equal(window.settings.height, 132);
  await f.invoke({ action: 'resize', height: 180 }); assert.equal(window.bounds.width, 340); assert.equal(window.bounds.height, 180); assert(window.bounds.y + window.bounds.height < anchor.y);
  await f.invoke({ action: 'resize', height: 560 }); assert.equal(window.bounds.height, 560); assert.equal(window.shows, 1); assert.equal(window.focuses, 1); assert.deepEqual(f.actions, []);
  await assert.rejects(f.invoke({ action: 'resize', height: 800 }), /height/); assert.equal(window.bounds.height, 560);
  await f.invoke({ action: 'open', taskId: operation(1).id }); assert.deepEqual(f.actions, [{ action: 'open', taskId: operation(1).id }]); assert(!window.isVisible());
});

test('Escape, blur and dismiss close the popup without quitting the app', async t => {
  const f = fixture(t); await f.controller.show(anchor); const window = f.controller.window; let prevented = false;
  window.webContents.emit('before-input-event', { preventDefault() { prevented = true; } }, { type: 'keyDown', key: 'Escape' }); assert(prevented); assert(!window.isVisible());
  await f.controller.show(anchor); window.focused = false; window.emit('blur'); await pause(70); assert(!window.isVisible()); await f.controller.show(anchor); await f.invoke({ action: 'dismiss' }); assert(!window.isVisible()); assert(!window.isDestroyed()); assert.deepEqual(f.actions, []);
});

test('a stale native blur after rapid hide and reopen cannot hide the newly focused popup', async t => {
  const f = fixture(t); await f.controller.show(anchor); const window = f.controller.window;
  f.controller.hide(); await f.controller.show(anchor);
  window.focused = false; window.emit('blur'); await pause(10); window.focused = true; window.emit('focus'); await pause(65);
  assert(window.isVisible()); assert.equal(window.shows, 2); assert.equal(window.focuses, 2, 'blur handling must not silently focus the popup');
  window.focused = false; window.emit('blur'); f.controller.hide(); await pause(65); assert(!window.isVisible()); assert.equal(window.shows, 2);
});

test('user CSS is retained before creation, replaced live and never steals focus', async t => {
  const f = fixture(t); await f.controller.setUserStyles('body { color: red; }'); await f.controller.show(anchor); const window = f.controller.window;
  assert.equal(window.css[0].css, 'body { color: red; }'); await f.controller.setUserStyles('body { color: blue; }'); assert.equal(window.css.at(-1).css, 'body { color: blue; }'); assert.deepEqual(window.removedCss, ['css-0']); assert.equal(window.focuses, 1);
  await f.controller.setUserStyles(''); assert.deepEqual(window.removedCss, ['css-0', 'css-1']);
});

test('dismiss while loading cancels the pending show instead of stealing focus later', async t => {
  const loadGate = deferred(), f = fixture(t, { loadGate }), showing = f.controller.show(anchor); f.controller.hide(); loadGate.resolve(); await showing;
  assert.equal(f.windows[0].shows, 0); assert.equal(f.windows[0].focuses, 0);
});

test('close while CSS insertion is pending never shows a destroyed window and removes IPC', async t => {
  const cssGate = deferred(), f = fixture(t, { cssGate }); await f.controller.setUserStyles('body { color: red; }'); const showing = f.controller.show(anchor); await pause(0); f.controller.close(); cssGate.resolve(); await showing;
  assert.equal(f.windows[0].shows, 0); assert(f.windows[0].isDestroyed()); assert.equal(f.requests.size, 0); f.controller.close();
});
