const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { loadDesktopWindow } = require('../src/startup-diagnostics');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const renderer = fs.mkdtempSync(path.join(os.tmpdir(), 'teamyra-startup-test-'));
for (const name of ['index.html', 'bundle.js', 'bundle.css', 'styles.css']) fs.writeFileSync(path.join(renderer, name), 'test');

function fixture(loadFile = () => Promise.resolve(), extra = {}) {
  const win = new EventEmitter();
  win.webContents = new EventEmitter();
  win.webContents.getURL = () => 'file:///test/index.html';
  win.isDestroyed = () => false;
  win.loadFile = loadFile;
  win.shown = 0;
  win.show = () => win.shown++;
  const errors = [];
  loadDesktopWindow(win, {
    entry: path.join(renderer, 'index.html'),
    log() {}, onFailure: e => errors.push(e), ...extra
  });
  return { win, errors };
}

(async () => {
  const normal = fixture();
  assert.equal(normal.win.shown, 0);
  normal.win.webContents.emit('did-finish-load');
  assert.equal(normal.win.shown, 0);
  normal.win.webContents.emit('ipc-message', {}, 'teamyra:renderer-ready');
  assert.equal(normal.win.shown, 1);
  normal.win.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
  assert.match(normal.errors[0], /crashed/);
  const hidden = fixture(undefined, { show: false });
  hidden.win.webContents.emit('did-finish-load');
  hidden.win.webContents.emit('ipc-message', {}, 'teamyra:renderer-ready');
  assert.equal(hidden.win.shown, 0);
  const rejection = fixture(() => Promise.reject(new Error('ERR_FILE_NOT_FOUND')));
  await new Promise(resolve => setImmediate(resolve));
  assert.match(rejection.errors[0], /ERR_FILE_NOT_FOUND/);
  rejection.win.webContents.emit('did-fail-load', {}, -6, 'missing', 'file:///test', true);
  assert.equal(rejection.errors.length, 1);
  const missing = fixture(() => { throw new Error('must not load'); }, { entry: '/nonexistent/index.html' });
  assert.match(missing.errors[0], /Missing renderer resource/);
  const preload = fixture();
  preload.win.webContents.emit('preload-error', {}, 'preload.js', new Error('failed'));
  assert.match(preload.errors[0], /preload/);
  const stalled = fixture(() => new Promise(() => {}), { timeoutMs: 10 });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(stalled.errors.length, 1);
  for (const item of [normal, hidden, rejection, missing, preload, stalled]) item.win.emit('closed');
  console.log('startup failure/recovery tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => fs.rmSync(renderer, { recursive: true, force: true }));
