const fs = require('node:fs');
const path = require('node:path');

// Lets a ChatGPT or Muse job look at what it built, the way a developer opens
// the app after a change:
// - page.check opens a local page (a dev server, a built HTML file) in a
//   hidden TEAMYRA window with no logins, and reports its title, visible
//   text, console errors, failed requests and a screenshot;
// - screen.capture takes a screenshot of an open window (for example the app
//   the job started with process.start).
// Screenshots are saved in the job folder; the job loop attaches them to the
// next message so the model can see them.

const INSPECT_TOOLS = new Set(['page.check', 'screen.capture']);
const MAX_TEXT_CHARS = 12000;
const MAX_CONSOLE = 60;
const MAX_FAILED = 40;
const LOCAL_HOSTS = /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)$|\.localhost$/i;

function electron() {
  // Loaded lazily: unit tests run this module outside Electron.
  return require('electron');
}

function screenshotPath(jobDir, label) {
  const dir = path.join(jobDir, 'screens');
  fs.mkdirSync(dir, { recursive: true });
  const safe = String(label || 'shot').replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 40) || 'shot';
  return path.join(dir, `${Date.now()}-${safe}.png`);
}

function isInside(child, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

// Only pages on this PC: a local dev server or a file in the workspace.
function checkUrl(raw, workspace) {
  let url;
  try { url = new URL(String(raw || '')); } catch { throw new Error('page.check needs a full "url", e.g. http://localhost:5173/'); }
  if (url.protocol === 'http:' || url.protocol === 'https:') {
    if (!LOCAL_HOSTS.test(url.hostname)) {
      throw new Error('page.check opens only local pages (localhost, 127.0.0.1, *.localhost) or workspace files');
    }
    return url.href;
  }
  if (url.protocol === 'file:') {
    const file = decodeURIComponent(url.pathname.replace(/^\/([A-Za-z]:)/, '$1'));
    if (!isInside(file, workspace)) throw new Error('page.check opens only files inside the workspace');
    return url.href;
  }
  throw new Error('page.check supports http(s) and file URLs only');
}

function bounded(text, limit) {
  const value = String(text || '');
  return value.length > limit ? value.slice(0, limit) + `\n[TEAMYRA: ${value.length - limit} more characters not shown]` : value;
}

class JobInspector {
  static handles(tool) {
    return INSPECT_TOOLS.has(String(tool || ''));
  }

  async call(jobDir, tool, args = {}, ctx = {}) {
    args = args && typeof args === 'object' ? args : {};
    if (tool === 'page.check') {
      // One at a time: the check window's network listeners are per session.
      const run = (this.pageQueue || Promise.resolve()).then(() => this.pageCheck(jobDir, args, ctx));
      this.pageQueue = run.catch(() => {});
      return run;
    }
    if (tool === 'screen.capture') return this.screenCapture(jobDir, args);
    throw new Error('unsupported inspect tool: ' + tool);
  }

  async pageCheck(jobDir, args, ctx) {
    const href = checkUrl(args.url, ctx.workspace || '');
    const width = Math.max(320, Math.min(2560, Number(args.width) || 1280));
    const height = Math.max(240, Math.min(1600, Number(args.height) || 800));
    const waitSeconds = Math.max(0, Math.min(60, Number(args.wait_seconds ?? 3)));
    const { BrowserWindow, session } = electron();
    const partition = 'teamyra-page-check';
    const consoleLines = [];
    const failed = [];
    const win = new BrowserWindow({
      show: false, width, height, paintWhenInitiallyHidden: true,
      webPreferences: { partition, sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: true }
    });
    const contents = win.webContents;
    const requests = session.fromPartition(partition).webRequest;
    const filter = { urls: ['<all_urls>'] };
    requests.onCompleted(filter, details => {
      if (details.webContentsId === contents.id && details.statusCode >= 400 && failed.length < MAX_FAILED) {
        failed.push({ url: details.url.slice(0, 300), status: details.statusCode });
      }
    });
    requests.onErrorOccurred(filter, details => {
      if (details.webContentsId === contents.id && failed.length < MAX_FAILED) {
        failed.push({ url: details.url.slice(0, 300), error: details.error });
      }
    });
    contents.on('console-message', (...params) => {
      // Electron passes one details object; older versions passed arguments.
      const details = params[0] && typeof params[0] === 'object' && 'message' in params[0]
        ? params[0] : { level: params[1], message: params[2], lineNumber: params[3], sourceId: params[4] };
      if (consoleLines.length >= MAX_CONSOLE) return;
      const level = typeof details.level === 'number' ? ['verbose', 'info', 'warning', 'error'][details.level] || 'info' : details.level;
      consoleLines.push({ level, message: String(details.message || '').slice(0, 1000),
        source: details.sourceId ? `${String(details.sourceId).slice(-120)}:${details.lineNumber}` : undefined });
    });
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    let loadError = null;
    try {
      await Promise.race([
        contents.loadURL(href),
        new Promise((_, reject) => setTimeout(() => reject(new Error('the page did not finish loading in 45 s')), 45000))
      ]).catch(error => { loadError = String(error?.message || error); });
      if (args.wait_for) {
        const deadline = Date.now() + Math.max(waitSeconds, 10) * 1000;
        const needle = JSON.stringify(String(args.wait_for));
        while (Date.now() < deadline) {
          const found = await contents.executeJavaScript(`(() => { const n = ${needle};
            try { if (document.querySelector(n)) return true; } catch {}
            return (document.body?.innerText || '').includes(n); })()`, true).catch(() => false);
          if (found) break;
          await new Promise(resolve => setTimeout(resolve, 300));
        }
      } else if (waitSeconds) {
        await new Promise(resolve => setTimeout(resolve, waitSeconds * 1000));
      }
      const page = await contents.executeJavaScript(`(() => ({
        title: document.title, url: location.href,
        text: document.body ? document.body.innerText : '',
        buttons: [...document.querySelectorAll('button, [role=button], a[href], input, select, textarea')].slice(0, 80)
          .map(node => (node.getAttribute('aria-label') || node.innerText || node.value || node.placeholder || node.name || node.tagName).trim().slice(0, 60))
          .filter(Boolean)
      }))()`, true).catch(error => ({ title: '', url: href, text: '', buttons: [], error: String(error?.message || error) }));
      let screenshot = null;
      if (args.screenshot !== false) {
        const image = await contents.capturePage();
        if (!image.isEmpty()) {
          screenshot = screenshotPath(jobDir, 'page');
          fs.writeFileSync(screenshot, image.toPNG());
        }
      }
      const errors = consoleLines.filter(line => line.level === 'error').length;
      return {
        url: page.url, title: page.title, ...(loadError ? { load_error: loadError } : {}),
        console_errors: errors, console: consoleLines, failed_requests: failed,
        controls: page.buttons, text: bounded(page.text, MAX_TEXT_CHARS),
        ...(page.error ? { script_error: page.error } : {}),
        ...(screenshot ? { screenshot } : { screenshot: null, screenshot_note: 'the page drew nothing to capture' })
      };
    } finally {
      requests.onCompleted(filter, null);
      requests.onErrorOccurred(filter, null);
      if (!win.isDestroyed()) win.destroy();
    }
  }

  async screenCapture(jobDir, args) {
    const { desktopCapturer } = electron();
    const sources = await desktopCapturer.getSources({ types: ['window', 'screen'], thumbnailSize: { width: 1600, height: 1000 } });
    const windows = sources.filter(source => source.id.startsWith('window:'));
    const wanted = String(args.window || '').trim().toLowerCase();
    let source = null;
    if (wanted) source = windows.find(item => item.name.toLowerCase().includes(wanted));
    else if (args.screen !== undefined || !windows.length) {
      const screens = sources.filter(item => item.id.startsWith('screen:'));
      source = screens[Math.max(0, Math.min(screens.length - 1, Number(args.screen) || 0))];
    }
    if (!source) {
      return { screenshot: null, windows: windows.map(item => item.name).filter(Boolean).slice(0, 60),
        note: wanted ? `no open window title contains "${args.window}"; pick one from "windows"`
          : 'pass "window" (part of a window title from "windows") or "screen": 0' };
    }
    if (source.thumbnail.isEmpty()) {
      return { screenshot: null, name: source.name, note: 'the window drew nothing (minimized?); restore it and try again' };
    }
    const file = screenshotPath(jobDir, source.name);
    fs.writeFileSync(file, source.thumbnail.toPNG());
    const size = source.thumbnail.getSize();
    return { screenshot: file, name: source.name, width: size.width, height: size.height };
  }
}

module.exports = { JobInspector, INSPECT_TOOLS, checkUrl };
