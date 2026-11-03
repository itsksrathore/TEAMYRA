const { WebContentsView } = require('electron');

// Google Vids lives in Docs; vids.new creates a new Vids file and redirects
// there. Sign-in pages stay reachable for the shared Google Media session.
const VIDS_HOSTS = new Set([
  'vids.new', 'docs.google.com', 'drive.google.com', 'accounts.google.com', 'myaccount.google.com',
  'workspace.google.com', 'support.google.com'
]);
const VIDS_WORK_BOUNDS = { x: 0, y: 0, width: 1600, height: 1000 };

function safeVidsUrl(value) {
  if (value === 'about:blank') return true;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && (VIDS_HOSTS.has(url.hostname) || /\.googleusercontent\.com$/.test(url.hostname));
  } catch { return false; }
}

// One hidden Vids tab in a Google Media account's own session (same login as
// that account's Flow tabs).
class GoogleVidsProvider {
  constructor({ window, sessionManager, bounds = VIDS_WORK_BOUNDS }) {
    this.window = window;
    this.sessionManager = sessionManager;
    this.bounds = bounds;
    this.view = null;
  }

  ensureView() {
    if (this.view && !this.view.webContents.isDestroyed()) return this.view;
    this.view = new WebContentsView({
      webPreferences: {
        session: this.sessionManager.getSession(),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        backgroundThrottling: false
      }
    });
    this.view.webContents.setAudioMuted(true);
    this.view.setBounds(this.bounds);
    this.view.setVisible(false);
    this.window.contentView.addChildView(this.view);
    const guard = (event, url) => { if (!safeVidsUrl(url)) event.preventDefault(); };
    this.view.webContents.on('will-navigate', guard);
    this.view.webContents.on('will-redirect', guard);
    this.view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    return this.view;
  }

  async load(url) {
    if (!safeVidsUrl(url)) throw new Error('Google Vids URL is not allowed: ' + url);
    const view = this.ensureView();
    // Docs pages may never report a finished load (and redirects from vids.new
    // abort the first navigation): start it, then wait for the page itself.
    view.webContents.loadURL(url).catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 1500));
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const ready = await view.webContents.executeJavaScript('document.readyState', true).catch(() => '');
      if (ready === 'complete' && !view.webContents.isLoading()) break;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    return view.webContents.getURL();
  }

  // Closing a tab while a DevTools command or page load is still pending
  // crashed the whole desktop (twice, after a Vids page hung). Detach and
  // stop first, and keep a tab whose page calls have not returned yet.
  destroy({ force = false } = {}) {
    if (!force && this.adapter?.pending > 0) return false;
    if (this.view && !this.view.webContents.isDestroyed()) {
      const wc = this.view.webContents;
      try { if (wc.debugger.isAttached()) wc.debugger.detach(); } catch {}
      try { wc.stop(); } catch {}
      try { this.window.contentView.removeChildView(this.view); } catch {}
      try { wc.close(); } catch {}
    }
    this.view = null;
    this.adapter = null;
    return true;
  }
}

module.exports = { GoogleVidsProvider, safeVidsUrl, VIDS_HOSTS, VIDS_WORK_BOUNDS };
