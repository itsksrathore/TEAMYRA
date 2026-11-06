const { ChatGPTWebProvider, userActions } = require('./chatgpt-web-provider');
const { ChatGPTSessionManager, DEFAULT_CHATGPT_PROFILE_ID } = require('./chatgpt-session-manager');
const { DeepSeekAutomationAdapter, DEEPSEEK_HOME } = require('./deepseek-automation-adapter');

// DeepSeek (https://chat.deepseek.com) as a TEAMYRA web-chat worker. Same job
// loop, tool protocol, recovery, lanes and reporting as ChatGPT Normal; see
// docs/DEEPSEEK_WEB_AGENT.md. DeepThink and Search stay on for every message.
// The page loads from deepseek.com; its human check comes from AWS WAF.
const DEEPSEEK_DOMAINS = ['deepseek.com', 'awswaf.com'];
const DEEPSEEK_EXTRA_HOSTS = new Set(['accounts.google.com', 'appleid.apple.com']);
const DEEPSEEK_HOSTS = {
  has: host => DEEPSEEK_EXTRA_HOSTS.has(host) ||
    DEEPSEEK_DOMAINS.some(domain => host === domain || String(host).endsWith('.' + domain))
};

const DEEPSEEK_SITE = {
  id: 'deepseek',
  name: 'DeepSeek',
  provider: 'deepseek-web',
  stateDir: 'deepseek',
  home: DEEPSEEK_HOME,
  hosts: DEEPSEEK_HOSTS,
  conversationHost: 'chat.deepseek.com',
  workerId: profileId => profileId === DEFAULT_CHATGPT_PROFILE_ID ? 'deepseek-normal' : 'deepseek-' + profileId,
  conversationUrl: id => DEEPSEEK_HOME + 'a/chat/s/' + id,
  // The login lives in the page's storage (its only token-like cookie is the
  // AWS human-check one), so "signed in" comes from what the page shows.
  sessionFromPage: true,
  sessionManager: profileId => new ChatGPTSessionManager(profileId, {
    partitionBase: 'persist:teamyra-deepseek-profile', cookieUrl: 'https://chat.deepseek.com', sessionCookie: null
  }),
  adapter: (webContents, options) => new DeepSeekAutomationAdapter(webContents, options),
  promptRules: [
    'Search is on for your own research. Never put citations or [reference:N] markers in a TEAMYRA_TOOL_REQUEST line ' +
      'or in file contents you write.',
    'Your thinking is not shown to TEAMYRA: put the TEAMYRA_TOOL_REQUEST line in your answer, not in your thinking.'
  ]
};

class DeepSeekWebProvider extends ChatGPTWebProvider {
  constructor(options = {}) {
    super({ ...options, site: DEEPSEEK_SITE });
  }
}
DeepSeekWebProvider.prototype.site = DEEPSEEK_SITE;
DeepSeekWebProvider.prototype.userActions = userActions(DEEPSEEK_SITE);

module.exports = { DeepSeekWebProvider, DEEPSEEK_SITE, DEEPSEEK_HOSTS };
