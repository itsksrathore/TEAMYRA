const { session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const PARTITION = 'persist:teamyra-chatgpt-profile';
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const ALLOWED_COOKIE_DOMAINS = ['chatgpt.com', 'openai.com'];

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function chromePath() {
  const candidates = [
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env['PROGRAMFILES(X86)'] && path.join(process.env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe')
  ].filter(Boolean);
  return candidates.find(candidate => fs.existsSync(candidate)) || '';
}

function cookieDomainAllowed(domain) {
  const value = String(domain || '').replace(/^\./, '').toLowerCase();
  return ALLOWED_COOKIE_DOMAINS.some(allowed => value === allowed || value.endsWith('.' + allowed));
}

function sameSiteForElectron(value) {
  const normalized = String(value || '').toLowerCase();
  if (normalized === 'strict') return 'strict';
  if (normalized === 'lax') return 'lax';
  if (normalized === 'none') return 'no_restriction';
  return 'unspecified';
}

class CdpClient {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
  }

  async connect() {
    if (typeof WebSocket !== 'function') throw new Error('WebSocket support is unavailable');
    this.ws = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out connecting to Chrome')), 10000);
      this.ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      this.ws.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('Could not connect to Chrome DevTools'));
      }, { once: true });
    });
    this.ws.addEventListener('message', event => {
      let message;
      try { message = JSON.parse(String(event.data || '')); } catch { return; }
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message || 'Chrome DevTools command failed'));
      else pending.resolve(message.result || {});
    });
    this.ws.addEventListener('close', () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error('Chrome DevTools connection closed'));
      }
      this.pending.clear();
    });
    return this;
  }

  send(method, params = {}) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('Chrome DevTools is not connected'));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Chrome DevTools command timed out: ' + method));
      }, 10000);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    try { this.ws?.close(); } catch {}
    this.ws = null;
  }
}

class ChatGPTSessionManager {
  constructor(stateRoot = '') {
    this.partition = PARTITION;
    this.session = null;
    this.stateRoot = stateRoot || '';
    this.externalLoginPromise = null;
    this.activeChromeChild = null;
    this.activeLoginProfile = '';
  }

  initialize() {
    if (this.session) return this.session;
    this.session = session.fromPartition(this.partition, { cache: true });
    this.session.setPermissionCheckHandler(() => false);
    this.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    this.session.on('will-download', (_event, item) => item.cancel());
    return this.session;
  }

  getSession() {
    return this.initialize();
  }

  async cookieSummary() {
    const ses = this.initialize();
    const cookies = await ses.cookies.get({ url: 'https://chatgpt.com' });
    return {
      count: cookies.length,
      hasSessionCookies: cookies.some(cookie => /session|auth|token/i.test(cookie.name))
    };
  }

  async importChromeCookies(cookies = []) {
    const ses = this.initialize();
    let imported = 0;
    for (const cookie of cookies) {
      if (!cookie?.name || !cookieDomainAllowed(cookie.domain)) continue;
      const host = String(cookie.domain || '').replace(/^\./, '');
      if (!host) continue;
      const details = {
        url: (cookie.secure === false ? 'http://' : 'https://') + host + (cookie.path || '/'),
        name: String(cookie.name),
        value: String(cookie.value || ''),
        path: cookie.path || '/',
        secure: cookie.secure !== false,
        httpOnly: cookie.httpOnly === true,
        sameSite: sameSiteForElectron(cookie.sameSite)
      };
      if (String(cookie.domain || '').startsWith('.')) details.domain = String(cookie.domain);
      if (Number(cookie.expires) > 0) details.expirationDate = Number(cookie.expires);
      try {
        await ses.cookies.set(details);
        imported += 1;
      } catch {}
    }
    await ses.cookies.flushStore().catch(() => {});
    return imported;
  }

  async loginWithChrome(initialUrl = 'https://chatgpt.com/auth/login') {
    if (this.externalLoginPromise) return this.externalLoginPromise;
    this.externalLoginPromise = this.loginWithChromeOnce(initialUrl)
      .finally(() => { this.externalLoginPromise = null; });
    return this.externalLoginPromise;
  }

  async loginWithChromeOnce(initialUrl) {
    if (process.platform !== 'win32') throw new Error('External Chrome login is currently available on Windows only');
    const chrome = chromePath();
    if (!chrome) throw new Error('Google Chrome was not found on this PC');

    const root = this.stateRoot || path.join(process.cwd(), 'chatgpt');
    fs.mkdirSync(root, { recursive: true });
    const profileRoot = fs.mkdtempSync(path.join(root, 'chrome-login-'));
    this.activeLoginProfile = profileRoot;
    const portFile = path.join(profileRoot, 'DevToolsActivePort');
    try { fs.rmSync(portFile, { force: true }); } catch {}

    const child = spawn(chrome, [
      '--user-data-dir=' + profileRoot,
      '--remote-debugging-address=127.0.0.1',
      '--remote-debugging-port=0',
      '--remote-allow-origins=*',
      '--no-first-run',
      '--no-default-browser-check',
      '--new-window',
      initialUrl
    ], {
      detached: false,
      stdio: 'ignore',
      windowsHide: false
    });

    this.activeChromeChild = child;

    let port = 0;
    const start = Date.now();
    while (Date.now() - start < 15000) {
      if (child.exitCode !== null) throw new Error('Chrome closed before login started');
      try {
        const lines = fs.readFileSync(portFile, 'utf8').trim().split(/\r?\n/);
        port = Number(lines[0]) || 0;
        if (port) break;
      } catch {}
      await sleep(200);
    }
    if (!port) {
      try { child.kill(); } catch {}
      throw new Error('Chrome login bridge did not start');
    }

    let client = null;
    try {
      const deadline = Date.now() + LOGIN_TIMEOUT_MS;
      while (Date.now() < deadline) {
        if (child.exitCode !== null) throw new Error('Chrome was closed before ChatGPT sign-in completed');
        let targets = [];
        try {
          const response = await fetch('http://127.0.0.1:' + port + '/json/list');
          if (response.ok) targets = await response.json();
        } catch {}
        const target = targets.find(item => {
          try {
            const host = new URL(item.url || '').hostname;
            return host === 'chatgpt.com' || host.endsWith('.chatgpt.com') || host === 'openai.com' || host.endsWith('.openai.com');
          } catch {
            return false;
          }
        });
        if (!target?.webSocketDebuggerUrl) {
          await sleep(750);
          continue;
        }

        client?.close();
        client = await new CdpClient(target.webSocketDebuggerUrl).connect();
        const evaluated = await client.send('Runtime.evaluate', {
          expression: `(() => {
            const prompt = document.querySelector('#prompt-textarea, textarea[data-testid*="prompt"], [contenteditable="true"][data-testid*="prompt"], main [contenteditable="true"]');
            const text = (document.body?.innerText || '').slice(0, 4000).toLowerCase();
            const loginVisible = !!document.querySelector('a[href*="auth"], button[data-testid*="login"]') || /log in|sign up/.test(text);
            return { promptFound: !!prompt, loginVisible, url: location.href, title: document.title };
          })()`,
          returnByValue: true
        });
        const probe = evaluated?.result?.value || {};
        if (probe.promptFound && !probe.loginVisible) {
          await client.send('Network.enable').catch(() => {});
          const result = await client.send('Network.getAllCookies');
          const imported = await this.importChromeCookies(result?.cookies || []);
          if (!imported) throw new Error('ChatGPT login completed but no reusable session cookies were found');
          return { ok: true, imported };
        }
        await sleep(1200);
      }
      throw new Error('Timed out waiting for ChatGPT sign-in in Chrome');
    } finally {
      client?.close();
      try { child.kill(); } catch {}
      if (this.activeChromeChild === child) this.activeChromeChild = null;
      await sleep(300);
      try { fs.rmSync(profileRoot, { recursive: true, force: true }); } catch {}
      if (this.activeLoginProfile === profileRoot) this.activeLoginProfile = '';
    }
  }

  destroy() {
    try { this.activeChromeChild?.kill(); } catch {}
    this.activeChromeChild = null;
    if (this.activeLoginProfile) {
      try { fs.rmSync(this.activeLoginProfile, { recursive: true, force: true }); } catch {}
    }
    this.activeLoginProfile = '';
  }
}

module.exports = { ChatGPTSessionManager, CHATGPT_PARTITION: PARTITION };
