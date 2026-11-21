const { WebContentsView } = require('electron');

// Google Gemini (gemini.google.com) in a Google Media account's own session:
// the same partition and sign-in as that account's Flow and Vids tabs. No
// profile, partition or sign-in flow of its own.
const GEMINI_HOME = 'https://gemini.google.com/app';
const GEMINI_HOSTS = new Set([
  'gemini.google.com', 'accounts.google.com', 'myaccount.google.com', 'support.google.com',
  'docs.google.com', 'drive.google.com', 'www.google.com'
]);
const GEMINI_WORK_BOUNDS = { x: 0, y: 0, width: 1400, height: 1000 };

function safeGeminiUrl(value) {
  if (value === 'about:blank') return true;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && (GEMINI_HOSTS.has(url.hostname) || /\.googleusercontent\.com$/.test(url.hostname) ||
      /\.gstatic\.com$/.test(url.hostname));
  } catch { return false; }
}

function geminiChatUrl(value) {
  const match = String(value || '').match(/^https:\/\/gemini\.google\.com\/(?:u\/\d+\/)?app\/([A-Za-z0-9_-]{6,})/);
  return match ? match[0] : null;
}

class GoogleGeminiProvider {
  constructor({ window, sessionManager, bounds = GEMINI_WORK_BOUNDS }) {
    this.window = window;
    this.sessionManager = sessionManager;
    this.bounds = bounds;
    this.view = null;
    this.adapter = null;
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
    const guard = (event, url) => { if (!safeGeminiUrl(url)) event.preventDefault(); };
    this.view.webContents.on('will-navigate', guard);
    this.view.webContents.on('will-redirect', guard);
    this.view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    return this.view;
  }

  async load(url = GEMINI_HOME) {
    if (!safeGeminiUrl(url)) throw new Error('Google Gemini URL is not allowed: ' + url);
    const view = this.ensureView();
    view.webContents.loadURL(url).catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 1200));
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const ready = await view.webContents.executeJavaScript('document.readyState', true).catch(() => '');
      if (ready === 'complete' && !view.webContents.isLoading()) break;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    return view.webContents.getURL();
  }

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

module.exports = { GoogleGeminiProvider, safeGeminiUrl, geminiChatUrl, GEMINI_HOME, GEMINI_HOSTS };
