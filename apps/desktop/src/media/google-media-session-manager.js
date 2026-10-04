const { session } = require('electron');

const GOOGLE_MEDIA_BASE_PARTITION = 'persist:teamyra-google-media-profile';
const AUTH_HOSTS = new Set([
  'accounts.google.com',
  'myaccount.google.com',
  'flow.google.com',
  'www.flow.google.com',
  'flowmusic.app',
  'www.flowmusic.app'
]);
const AUTH_STORAGE_PERMISSIONS = new Set([
  'storage-access',
  'top-level-storage-access'
]);

function safeProfileId(value) {
  return String(value || 'google')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'google';
}

function partitionForProfile(profileId) {
  const id = safeProfileId(profileId);
  return id === 'google'
    ? GOOGLE_MEDIA_BASE_PARTITION
    : 'persist:teamyra-google-media-' + id;
}

function hostnameFrom(value) {
  try { return new URL(String(value || '')).hostname; } catch { return ''; }
}

function isTrustedGoogleOrigin(value) {
  return AUTH_HOSTS.has(hostnameFrom(value));
}

class GoogleMediaSessionManager {
  constructor(profileId = 'google') {
    this.profileId = safeProfileId(profileId);
    this.partition = partitionForProfile(this.profileId);
    this.session = null;
    this.downloadHandler = null;
    this._downloadListenerInstalled = false;
    this._authHandlersInstalled = false;
  }

  initialize() {
    if (this.session) return this.session;
    this.session = session.fromPartition(this.partition, { cache: true });
    this.installAuthHandlers();
    return this.session;
  }

  installAuthHandlers() {
    const ses = this.session;
    if (!ses || this._authHandlersInstalled) return;
    this._authHandlersInstalled = true;

    ses.setPermissionCheckHandler((_webContents, permission, requestingOrigin, details = {}) => {
      const origin = details.requestingUrl || requestingOrigin || details.embeddingOrigin || '';
      return isTrustedGoogleOrigin(origin) && AUTH_STORAGE_PERMISSIONS.has(permission);
    });

    ses.setPermissionRequestHandler((webContents, permission, callback, details = {}) => {
      const origin = details.requestingUrl || webContents?.getURL?.() || '';
      callback(isTrustedGoogleOrigin(origin) && AUTH_STORAGE_PERMISSIONS.has(permission));
    });

    ses.on('select-webauthn-account', (_event, details, callback) => {
      let selected = null;
      try {
        const rp = String(details?.relyingPartyId || '').toLowerCase();
        const accounts = Array.isArray(details?.accounts) ? details.accounts : [];
        const trustedRp = rp === 'google.com' || rp.endsWith('.google.com');
        if (trustedRp && accounts.length === 1) selected = accounts[0]?.credentialId || null;
      } finally {
        callback(selected);
      }
    });
  }

  getSession() { return this.initialize(); }

  setDownloadHandler(handler) {
    const ses = this.initialize();
    this.downloadHandler = handler;
    if (this._downloadListenerInstalled) return;
    this._downloadListenerInstalled = true;
    ses.on('will-download', (event, item, webContents) => {
      if (!this.downloadHandler) {
        item.cancel();
        return;
      }
      this.downloadHandler(event, item, webContents);
    });
  }

  async cookieSummary() {
    const ses = this.initialize();
    const [googleCookies, flowCookies] = await Promise.all([
      ses.cookies.get({ domain: '.google.com' }).catch(() => []),
      ses.cookies.get({ domain: 'flow.google.com' }).catch(() => [])
    ]);
    const cookies = [...googleCookies, ...flowCookies];
    return {
      count: cookies.length,
      hasSessionCookies: cookies.some(cookie => /SID|SAPISID|SSID|ACCOUNT|__Secure/i.test(cookie.name))
    };
  }
}

module.exports = {
  GoogleMediaSessionManager,
  GOOGLE_MEDIA_BASE_PARTITION,
  AUTH_HOSTS,
  AUTH_STORAGE_PERMISSIONS,
  partitionForProfile,
  safeProfileId,
  isTrustedGoogleOrigin
};
