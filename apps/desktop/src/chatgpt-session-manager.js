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

function partitionForProfile(profileId = DEFAULT_PROFILE_ID) {
  const id = safeProfileId(profileId);
  return id === DEFAULT_PROFILE_ID
    ? DEFAULT_PARTITION
    : DEFAULT_PARTITION + '-' + id;
}

class ChatGPTSessionManager {
  constructor(profileId = DEFAULT_PROFILE_ID) {
    this.profileId = safeProfileId(profileId);
    this.partition = partitionForProfile(this.profileId);
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
    const cookies = await ses.cookies.get({ url: 'https://chatgpt.com' });
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
