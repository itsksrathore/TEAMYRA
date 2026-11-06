const { session } = require('electron');

const DEFAULT_PROFILE_ID = 'web';
const DEFAULT_PARTITION = 'persist:teamyra-chatgpt-profile';

function safeProfileId(value) {
  return String(value || DEFAULT_PROFILE_ID)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || DEFAULT_PROFILE_ID;
}

function partitionForProfile(profileId = DEFAULT_PROFILE_ID, base = DEFAULT_PARTITION) {
  const id = safeProfileId(profileId);
  return id === DEFAULT_PROFILE_ID
    ? base
    : base + '-' + id;
}

// One persistent browser profile per web-chat account. Another site (Muse)
// passes its own partition base and the origin whose cookies mean signed in.
class ChatGPTSessionManager {
  constructor(profileId = DEFAULT_PROFILE_ID, { partitionBase = DEFAULT_PARTITION, cookieUrl = 'https://chatgpt.com' } = {}) {
    this.profileId = safeProfileId(profileId);
    this.partition = partitionForProfile(this.profileId, partitionBase);
    this.cookieUrl = cookieUrl;
    this.session = null;
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
    const cookies = await ses.cookies.get({ url: this.cookieUrl });
    return {
      count: cookies.length,
      hasSessionCookies: cookies.some(cookie => /session|auth|token/i.test(cookie.name))
    };
  }
}

module.exports = {
  ChatGPTSessionManager,
  CHATGPT_PARTITION: DEFAULT_PARTITION,
  DEFAULT_CHATGPT_PROFILE_ID: DEFAULT_PROFILE_ID,
  partitionForProfile
};
