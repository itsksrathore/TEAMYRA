const { WebContentsView } = require('electron');
const { GoogleFlowAutomationAdapter, FLOW_HOME } = require('./google-flow-automation-adapter');

const ALLOWED_GOOGLE_HOSTS = new Set([
  'flow.google', 'www.flow.google', 'flow.google.com', 'www.flow.google.com', 'labs.google', 'accounts.google.com', 'myaccount.google.com'
]);

function safeGoogleUrl(value) {
  if (value === 'about:blank') return true;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && ALLOWED_GOOGLE_HOSTS.has(url.hostname);
  } catch { return false; }
}

class GoogleFlowProvider {
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
    this.adapter = new GoogleFlowAutomationAdapter(this.view.webContents);
    const guard = (event, url) => { if (!safeGoogleUrl(url)) event.preventDefault(); };
    this.view.webContents.on('will-navigate', guard);
    this.view.webContents.on('will-redirect', guard);
    this.view.webContents.setWindowOpenHandler(({ url }) => {
      let authPopup = false;
      try {
        const parsed = new URL(url);
        authPopup = parsed.protocol === 'https:' && ['accounts.google.com', 'myaccount.google.com'].includes(parsed.hostname);
      } catch {}
      if (!authPopup) {
        try {
          const parsed = new URL(url);
          console.warn('[google-media] blocked Flow popup', parsed.protocol + '//' + parsed.hostname + parsed.pathname);
        } catch {}
        return { action: 'deny' };
      }
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
            'accounts.google.com', 'myaccount.google.com', 'flow.google.com', 'www.flow.google.com'
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
    if (this.loadingPromise) return this.loadingPromise;
    this.loadingPromise = (async () => {
      let navigationError = null;
      const startUrl = view.webContents.getURL();
      if (!startUrl || startUrl === 'about:blank' || !safeGoogleUrl(startUrl)) {
        view.webContents.loadURL(FLOW_HOME).catch(error => { navigationError = error; });
      }
      const deadline = Date.now() + 20000;
      let stableUrl = '';
      let stableSince = 0;
      while (Date.now() < deadline) {
        const url = view.webContents.getURL();
        if (url !== stableUrl) {
          stableUrl = url;
          stableSince = Date.now();
        }
        if (url && url !== 'about:blank' && safeGoogleUrl(url)) {
          const readyState = await view.webContents.executeJavaScript('document.readyState', true).catch(() => '');
          const ready = readyState === 'interactive' || readyState === 'complete';
          if (ready && Date.now() - stableSince >= 600) return view;
        }
        await new Promise(resolve => setTimeout(resolve, 120));
      }
      const finalUrl = view.webContents.getURL();
      if (!finalUrl || finalUrl === 'about:blank' || !safeGoogleUrl(finalUrl)) {
        throw navigationError || new Error('Google Flow did not reach an allowed page');
      }
      return view;
    })();
    try {
      return await this.loadingPromise;
    } finally {
      this.loadingPromise = null;
    }
  }

  async open() { this.setVisible(false); await this.ensureLoaded(); this.setVisible(true); return this.status(); }
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
  async inspect(timeoutMs = 15000) {
    if (!this.view || this.view.webContents.isDestroyed()) {
      return {
        status: { loaded: false, visible: false, url: '' },
        capabilities: {}
      };
    }
    const deadline = Date.now() + timeoutMs;
    let probe = null;
    let lastProbeError = null;
    while (Date.now() < deadline && !probe) {
      try {
        probe = await this.adapter.probe();
      } catch (error) {
        lastProbeError = error;
      }
      if (!probe) await new Promise(resolve => setTimeout(resolve, 250));
    }
    const classified = probe ? this.adapter.classifyProbe(probe) : {};
    const capabilities = probe ? await this.adapter.capabilities(probe).catch(() => ({})) : {};
    return {
      status: {
        loaded: true,
        visible: this.visible,
        url: this.view.webContents.getURL(),
        probe_ok: Boolean(probe),
        probe_error: probe ? '' : String(lastProbeError?.message || lastProbeError || '').slice(0, 800),
        ...classified
      },
      capabilities
    };
  }

  async status() {
    return (await this.inspect()).status;
  }
  destroy() {
    this.closeChildWindows();
    if (this.view && !this.view.webContents.isDestroyed()) {
      try { this.window.contentView.removeChildView(this.view); } catch {}
      try { this.view.webContents.close(); } catch {}
    }
    this.view = null; this.adapter = null; this.loadingPromise = null;
  }
}

module.exports = { GoogleFlowProvider, safeGoogleUrl, ALLOWED_GOOGLE_HOSTS };
