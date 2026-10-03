const { session } = require('electron');

const PARTITION = 'persist:teamyra-chatgpt-profile';

class ChatGPTSessionManager {
  constructor() {
    this.partition = PARTITION;
    this.session = null;
  }

  initialize() {
    if (this.session) return this.session;
    this.session = session.fromPartition(this.partition, { cache: true });
    this.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
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

module.exports = { ChatGPTSessionManager, CHATGPT_PARTITION: PARTITION };
