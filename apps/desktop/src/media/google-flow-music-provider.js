const { WebContentsView } = require('electron');
const { GoogleFlowMusicAutomationAdapter, FLOW_MUSIC_HOME } = require('./google-flow-music-automation-adapter');

const ALLOWED_MUSIC_HOSTS = new Set([
  'flowmusic.google', 'www.flowmusic.google', 'flowmusic.app', 'www.flowmusic.app', 'labs.google', 'accounts.google.com', 'myaccount.google.com'
]);

function safeMusicUrl(value) {
  if (value === 'about:blank') return true;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && ALLOWED_MUSIC_HOSTS.has(url.hostname);
  } catch { return false; }
}

class GoogleFlowMusicProvider {
  constructor({ window, sessionManager }) {
    this.window = window;
    this.sessionManager = sessionManager;
    this.view = null;
    this.adapter = null;
    this.visible = false;
    this.loadingPromise = null;
    this.childWindows = new Set();
    this.bounds = { x: 220, y: 96, width: 1000, height: 700 };
  }
  ensureView() {
    if (this.view && !this.view.webContents.isDestroyed()) return this.view;
    this.view = new WebContentsView({
      webPreferences: {
        session: this.sessionManager.getSession(),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        devTools: true,
        backgroundThrottling: false
      }
    });
    this.view.setBackgroundColor('#0b0e14');
    this.view.setBounds(this.bounds);
    this.view.setVisible(this.visible);
    this.window.contentView.addChildView(this.view);
    this.adapter = new GoogleFlowMusicAutomationAdapter(this.view.webContents);
    const guard = (event, url) => {
      if (safeMusicUrl(url)) return;
      try {
        const parsed = new URL(url);
        console.warn('[google-media] blocked music navigation', parsed.protocol + '//' + parsed.hostname + parsed.pathname);
      } catch {
        console.warn('[google-media] blocked music navigation', '<invalid>');
      }
      event.preventDefault();
    };
    this.view.webContents.on('will-navigate', guard);
    this.view.webContents.on('will-redirect', guard);
    this.view.webContents.setWindowOpenHandler(({ url }) => {
      let authPopup = false;
      try {
        const parsed = new URL(url);
        authPopup = parsed.protocol === 'https:' && ['accounts.google.com', 'myaccount.google.com'].includes(parsed.hostname);
      } catch {}
      if (!authPopup) return { action: 'deny' };
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          parent: this.window,
          modal: false,
          title: 'Google Sign in',
          width: 520,
          height: 720,
          autoHideMenuBar: true,
          webPreferences: {
            session: this.sessionManager.getSession(),
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            devTools: true
          }
        }
      };
    });
    this.view.webContents.on('did-create-window', child => {
      this.childWindows.add(child);
      child.once('closed', () => this.childWindows.delete(child));
      const childGuard = (event, url) => {
        let allowed = false;
        try {
          const parsed = new URL(url);
          allowed = parsed.protocol === 'https:' && [
            'accounts.google.com', 'myaccount.google.com', 'flowmusic.app', 'www.flowmusic.app'
          ].includes(parsed.hostname);
        } catch {}
        if (!allowed) event.preventDefault();
      };
      child.webContents.on('will-navigate', childGuard);
      child.webContents.on('will-redirect', childGuard);
      child.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    });
    return this.view;
  }
  async ensureLoaded() {
    const view = this.ensureView();
    const current = view.webContents.getURL();
    if (current && current !== 'about:blank' && safeMusicUrl(current)) return view;
    if (this.loadingPromise) return this.loadingPromise;
    this.loadingPromise = (async () => {
      let navigationError = null;
      const ready = new Promise(resolve => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          view.webContents.removeListener('dom-ready', finish);
          view.webContents.removeListener('did-stop-loading', finish);
          resolve();
        };
        const timer = setTimeout(finish, 20000);
        timer.unref?.();
        view.webContents.once('dom-ready', finish);
        view.webContents.once('did-stop-loading', finish);
      });
      view.webContents.loadURL(FLOW_MUSIC_HOME).catch(error => { navigationError = error; });
      await ready;
      const finalUrl = view.webContents.getURL();
      if (!finalUrl || finalUrl === 'about:blank' || !safeMusicUrl(finalUrl)) {
        throw navigationError || new Error('Flow Music did not reach an allowed page');
      }
      return view;
    })();
    try {
      return await this.loadingPromise;
    } finally {
      this.loadingPromise = null;
    }
  }
  async open() { this.setVisible(true); await this.ensureLoaded(); return this.status(); }
  closeChildWindows() {
    for (const child of [...this.childWindows]) {
      try { if (!child.isDestroyed()) child.close(); } catch {}
    }
    this.childWindows.clear();
  }
  close() {
    this.setVisible(false);
    this.closeChildWindows();
    return this.status();
  }
  setVisible(value) {
    this.visible = value === true;
    if (this.view && !this.view.webContents.isDestroyed()) {
      this.view.setVisible(this.visible);
      if (this.visible) this.view.setBounds(this.bounds);
    }
  }
  setBounds(bounds = {}) {
    this.bounds = {
      x: Math.max(0, Math.round(Number(bounds.x) || 0)),
      y: Math.max(0, Math.round(Number(bounds.y) || 0)),
      width: Math.max(320, Math.round(Number(bounds.width) || 320)),
      height: Math.max(240, Math.round(Number(bounds.height) || 240))
    };
    if (this.view && !this.view.webContents.isDestroyed() && this.visible) this.view.setBounds(this.bounds);
    return this.bounds;
  }
  async status() {
    if (!this.view || this.view.webContents.isDestroyed()) return { loaded: false, visible: false, url: '' };
    const probe = await this.adapter.probe().catch(() => null);
    const classified = probe ? this.adapter.classifyProbe(probe) : {};
    return { loaded: true, visible: this.visible, url: this.view.webContents.getURL(), ...classified };
  }
  destroy() {
    this.closeChildWindows();
    if (this.view && !this.view.webContents.isDestroyed()) {
      try { this.window.contentView.removeChildView(this.view); } catch {}
      try { this.view.webContents.close(); } catch {}
    }
    this.view = null; this.adapter = null;
  }
}

module.exports = { GoogleFlowMusicProvider, safeMusicUrl, ALLOWED_MUSIC_HOSTS };
