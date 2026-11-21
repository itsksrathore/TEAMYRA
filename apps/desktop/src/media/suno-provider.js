const fs = require('node:fs');
const path = require('node:path');

// Suno accounts: each has its own persistent Chromium session
// (persist:teamyra-suno for the built-in account, persist:teamyra-suno-<id>
// for the others). The user signs in by opening the account in the Agents
// panel; TEAMYRA never types credentials. A hidden worker view runs jobs, a
// display view shows the account to the user; both share the session.
const SUNO_HOME = 'https://suno.com/create';
const SUNO_LIBRARY = 'https://suno.com/me';
const BUILTIN_PROFILE = 'suno';
const SUNO_WORK_BOUNDS = { x: 0, y: 0, width: 1440, height: 1000 };
// Suno's own hosts, its CDN/streams and the sign-in providers Suno offers.
const SIGN_IN_HOSTS = new Set([
  'accounts.google.com', 'myaccount.google.com', 'appleid.apple.com', 'discord.com', 'www.facebook.com', 'm.facebook.com',
  'login.microsoftonline.com', 'login.live.com', 'account.live.com', 'challenges.cloudflare.com'
]);

function safeProfileId(value) {
  return String(value || BUILTIN_PROFILE).trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || BUILTIN_PROFILE;
}

function partitionForSuno(profileId) {
  const id = safeProfileId(profileId);
  return id === BUILTIN_PROFILE ? 'persist:teamyra-suno' : 'persist:teamyra-suno-' + id;
}

function hostOf(value) {
  try { return new URL(String(value || '')).hostname.toLowerCase(); } catch { return ''; }
}

function isSunoHost(host) {
  return host === 'suno.com' || host.endsWith('.suno.com') || host === 'suno.ai' || host.endsWith('.suno.ai') || host.endsWith('.cloudfront.net');
}

// Sign-in providers hop across several of their own hosts: after choosing a
// Google account the page passes accounts.youtube.com, a country domain
// (accounts.google.co.in) or gstatic; a refused hop left the sign-in stuck
// (2026-11-21). Their whole domains are allowed while signing in.
const SIGN_IN_DOMAINS = [
  /(^|\.)google\.com$/, /(^|\.)google\.[a-z]{2,3}(\.[a-z]{2})?$/, /(^|\.)gstatic\.com$/, /(^|\.)googleusercontent\.com$/,
  /(^|\.)googleapis\.com$/, /^accounts\.youtube\.com$/,
  /(^|\.)apple\.com$/, /(^|\.)discord\.com$/, /(^|\.)discordapp\.com$/,
  /(^|\.)microsoftonline\.com$/, /(^|\.)live\.com$/, /(^|\.)microsoft\.com$/,
  /(^|\.)facebook\.com$/, /(^|\.)clerk\.com$/, /(^|\.)clerk\.accounts\.dev$/, /(^|\.)hcaptcha\.com$/
];

function isSignInHost(host) {
  return SIGN_IN_HOSTS.has(host) || SIGN_IN_DOMAINS.some(pattern => pattern.test(host));
}

function safeSunoUrl(value, { signIn = true } = {}) {
  if (value === 'about:blank') return true;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return false;
    return isSunoHost(url.hostname) || (signIn && isSignInHost(url.hostname));
  } catch { return false; }
}

// A refused address is written to logs/suno-blocked.log, so a sign-in hop
// that is still missing shows up at once.
function logBlocked(kind, url) {
  try {
    const file = path.resolve(__dirname, '..', '..', '..', '..', 'logs', 'suno-blocked.log');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, new Date().toISOString() + ' ' + kind + ' ' + String(url).slice(0, 300) + '\n');
  } catch {}
}

function songUrl(clipId) { return 'https://suno.com/song/' + String(clipId).toLowerCase(); }

// Official downloads of one account's session, attributed to the waiting job.
class SunoDownloads {
  constructor(session, { isUserView = () => false } = {}) {
    this.session = session;
    this.isUserView = isUserView;
    this.expected = [];
    session.on('will-download', (event, item, webContents) => this.handle(event, item, webContents));
  }

  expect({ webContentsId, destination, timeoutMs = 180000 }) {
    const target = path.resolve(destination);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    return new Promise((resolve, reject) => {
      const record = { webContentsId: Number(webContentsId), destination: target, resolve, reject };
      record.cancel = () => { this.expected = this.expected.filter(item => item !== record); clearTimeout(record.timer); };
      record.timer = setTimeout(() => {
        this.expected = this.expected.filter(item => item !== record);
        record.item?.cancel?.();
        reject(new Error('download_failure: the Suno download did not arrive in time'));
      }, timeoutMs);
      record.timer.unref?.();
      this.expected.push(record);
    });
  }

  handle(_event, item, webContents) {
    const id = Number(webContents?.id);
    const record = this.expected.find(entry => entry.webContentsId === id);
    if (!record) {
      // The user downloading in the Open view keeps the normal Save dialog.
      if (this.isUserView(id)) return;
      item.cancel();
      return;
    }
    this.expected = this.expected.filter(entry => entry !== record);
    record.item = item;
    item.setSavePath(record.destination);
    item.once('done', (_done, state) => {
      clearTimeout(record.timer);
      if (state !== 'completed') return record.reject(new Error('download_failure: the Suno download ended ' + state));
      try {
        const stat = fs.statSync(record.destination);
        if (!stat.isFile() || stat.size <= 0) throw new Error('empty file');
        record.resolve({ path: record.destination, bytes: stat.size, mime: item.getMimeType?.() || '', url: item.getURL?.() || '',
          filename: item.getFilename?.() || '' });
      } catch (error) {
        record.reject(new Error('download_failure: the Suno download is empty (' + error.message + ')'));
      }
    });
  }
}

class SunoView {
  constructor({ window, session, bounds = SUNO_WORK_BOUNDS, visible = false, signIn = false }) {
    this.window = window;
    this.session = session;
    this.bounds = bounds;
    this.visibleView = visible;
    this.signIn = signIn;
    this.view = null;
    this.adapter = null;
  }

  ensureView() {
    if (this.view && !this.view.webContents.isDestroyed()) return this.view;
    const { WebContentsView } = require('electron');
    this.view = new WebContentsView({
      // The worker presses Play (muted) so the page requests its own playback stream.
      webPreferences: { session: this.session, nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false,
        autoplayPolicy: 'no-user-gesture-required' }
    });
    // The worker never plays sound aloud; the user's view may.
    if (!this.visibleView) this.view.webContents.setAudioMuted(true);
    this.view.setBounds(this.bounds);
    this.view.setVisible(false);
    this.window.contentView.addChildView(this.view);
    const guard = kind => (event, url) => {
      if (!safeSunoUrl(url, { signIn: true })) { event.preventDefault(); logBlocked(kind, url); }
    };
    this.view.webContents.on('will-navigate', guard('navigate'));
    this.view.webContents.on('will-redirect', guard('redirect'));
    // Sign-in popups (Google, Apple, Discord...) open in the same session; anything else is refused.
    this.view.webContents.setWindowOpenHandler(({ url }) => {
      if (this.signIn && safeSunoUrl(url, { signIn: true })) {
        return { action: 'allow', overrideBrowserWindowOptions: { width: 520, height: 720, autoHideMenuBar: true, webPreferences: { session: this.session } } };
      }
      logBlocked('popup', url);
      return { action: 'deny' };
    });
    // A sign-in popup finishes back on Suno: reload the account's view so it
    // shows the signed-in page instead of the old sign-in screen.
    this.view.webContents.on('did-create-window', popup => {
      popup.webContents.on('will-redirect', guard('popup-redirect'));
      popup.webContents.on('will-navigate', guard('popup-navigate'));
      popup.on('closed', () => {
        if (this.view && !this.view.webContents.isDestroyed()) this.view.webContents.loadURL(SUNO_HOME).catch(() => {});
      });
    });
    return this.view;
  }

  async load(url = SUNO_HOME, { settleMs = 1200, timeoutMs = 30000 } = {}) {
    if (!safeSunoUrl(url, { signIn: false })) throw new Error('Suno URL is not allowed: ' + url);
    const view = this.ensureView();
    view.webContents.loadURL(url).catch(() => {});
    await new Promise(resolve => setTimeout(resolve, settleMs));
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const ready = await view.webContents.executeJavaScript('document.readyState', true).catch(() => '');
      if (ready === 'complete' && !view.webContents.isLoading()) break;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    return view.webContents.getURL();
  }

  setVisible(value) {
    if (!this.view || this.view.webContents.isDestroyed()) return;
    this.view.setVisible(value === true);
    if (value === true) {
      try { this.window.contentView.removeChildView(this.view); this.window.contentView.addChildView(this.view); } catch {}
    }
  }

  setBounds(bounds) {
    this.bounds = { ...bounds };
    if (this.view && !this.view.webContents.isDestroyed()) this.view.setBounds(this.bounds);
  }

  get webContentsId() { return this.view && !this.view.webContents.isDestroyed() ? this.view.webContents.id : null; }

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

// Accounts as the Agents panel lists them: built-in "suno" + profiles/suno/<id>.
function sunoProfiles(root, builtinFile) {
  let builtin = {};
  try { builtin = JSON.parse(fs.readFileSync(builtinFile, 'utf8')) || {}; } catch {}
  const profiles = [{ id: BUILTIN_PROFILE, name: builtin.name || 'Suno Account 1', enabled: builtin.enabled !== false }];
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch {}
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === BUILTIN_PROFILE || safeProfileId(entry.name) !== entry.name) continue;
    let meta = {};
    try { meta = JSON.parse(fs.readFileSync(path.join(root, entry.name, 'teamyra-profile.json'), 'utf8')) || {}; } catch {}
    profiles.push({ id: entry.name, name: meta.name || entry.name, enabled: meta.enabled !== false });
  }
  return profiles;
}

module.exports = {
  isSignInHost, SunoView, SunoDownloads, safeSunoUrl, partitionForSuno, safeProfileId, songUrl, sunoProfiles,
  SUNO_HOME, SUNO_LIBRARY, BUILTIN_PROFILE, SIGN_IN_HOSTS };
