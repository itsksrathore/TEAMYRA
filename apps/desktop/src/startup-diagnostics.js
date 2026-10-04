const fs = require('node:fs');
const path = require('node:path');

function createStartupLog(directory) {
  const file = path.join(directory, 'desktop-startup.log');
  return function log(event, detail = {}) {
    try {
      fs.mkdirSync(directory, { recursive: true });
      if (fs.existsSync(file) && fs.statSync(file).size > 1024 * 1024) {
        fs.renameSync(file, file + '.previous');
      }
      fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), pid: process.pid, event, ...detail }) + '\n');
    } catch { /* Diagnostics must never prevent the UI from loading. */ }
  };
}

function loadDesktopWindow(win, { entry, log, onFailure, show = true, timeoutMs = 60000 }) {
  let failed = false;
  let disposed = false;
  let loaded = false;
  let ready = false;
  const finish = () => {
    if (!loaded || !ready || failed || disposed) return;
    clearTimeout(timer);
    if (show && !win.isDestroyed()) win.show();
  };
  const fail = (reason) => {
    if (failed || disposed || win.isDestroyed()) return;
    failed = true;
    clearTimeout(timer);
    log('renderer-failed', { reason });
    onFailure(reason);
  };
  const timer = setTimeout(() => fail('The desktop renderer did not become ready. Its startup may have been interrupted.'), timeoutMs);
  timer.unref?.();
  win.once('closed', () => { disposed = true; clearTimeout(timer); });
  win.webContents.on('preload-error', (_event, preloadPath, error) => {
    log('preload-error', { preloadPath, error: String(error?.stack || error) });
    fail('The desktop preload could not start.');
  });
  win.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    log('did-fail-load', { code, description, url, isMainFrame });
    if (isMainFrame && code !== -3) fail(`Renderer load failed (${code}): ${description}`);
  });
  win.webContents.on('render-process-gone', (_event, details) => {
    log('render-process-gone', details);
    fail(`Renderer stopped: ${details.reason}`);
  });
  win.webContents.on('console-message', details => {
    // Never log embedded web content, prompts or account data; this is the local shell only.
    if (details.level === 'error') log('renderer-console-error', { message: String(details.message).slice(0, 2000), line: details.lineNumber });
  });
  win.webContents.on('did-finish-load', () => {
    loaded = true;
    log('renderer-loaded', { url: win.webContents.getURL() });
    finish();
  });
  win.webContents.on('ipc-message', (event, channel) => {
    if (channel !== 'teamyra:renderer-ready' || event.senderFrame !== win.webContents.mainFrame) return;
    ready = true;
    log('renderer-ready');
    finish();
  });
  try {
    for (const name of ['index.html', 'bundle.js', 'bundle.css', 'styles.css']) {
      if (!fs.existsSync(path.join(path.dirname(entry), name))) throw new Error(`Missing renderer resource: ${name}`);
    }
    log('renderer-loading', { entry });
    Promise.resolve(win.loadFile(entry)).catch(error => fail(String(error.message || error)));
  } catch (error) { fail(String(error.message || error)); }
}

module.exports = { createStartupLog, loadDesktopWindow };
