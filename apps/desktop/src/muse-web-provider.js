const { ChatGPTWebProvider, userActions } = require('./chatgpt-web-provider');
const { ChatGPTSessionManager, DEFAULT_CHATGPT_PROFILE_ID } = require('./chatgpt-session-manager');
const { MuseAutomationAdapter, MUSE_HOME } = require('./muse-automation-adapter');

// Muse (Meta's personal agent, https://muse.ai) as a TEAMYRA web-chat worker.
// Same job loop, tool protocol, recovery and reporting as ChatGPT Normal; see
// docs/MUSE_WEB_AGENT.md.
// Every page load passes Meta's account check: muse.ai -> auth.muse.ai ->
// www.facebook.com -> www.instagram.com -> auth.meta.com -> auth.muse.ai ->
// muse.ai (seen 2026-11-06). Blocking any hop fails the load with ERR_FAILED,
// so these sites are allowed with their subdomains.
const MUSE_DOMAINS = ['muse.ai', 'meta.com', 'facebook.com', 'instagram.com'];
const MUSE_EXTRA_HOSTS = new Set(['accounts.google.com', 'appleid.apple.com']);
const MUSE_HOSTS = {
  has: host => MUSE_EXTRA_HOSTS.has(host) || MUSE_DOMAINS.some(domain => host === domain || String(host).endsWith('.' + domain))
};

const MUSE_SITE = {
  id: 'muse',
  name: 'Muse',
  provider: 'muse-web',
  stateDir: 'muse',
  home: MUSE_HOME,
  hosts: MUSE_HOSTS,
  conversationHost: 'muse.ai',
  workerId: profileId => profileId === DEFAULT_CHATGPT_PROFILE_ID ? 'muse-normal' : 'muse-' + profileId,
  conversationUrl: id => MUSE_HOME + 'thread/' + id,
  sessionManager: profileId => new ChatGPTSessionManager(profileId, {
    partitionBase: 'persist:teamyra-muse-profile', cookieUrl: 'https://muse.ai'
  }),
  adapter: (webContents, options) => new MuseAutomationAdapter(webContents, options),
  // Muse has its own computer in Meta's cloud and does tasks there by default.
  promptRules: [
    'The project is on the user\'s Windows PC, not in your cloud computer. Do not use your Secure VM, its browser or terminal, ' +
      'connected apps, scheduled tasks or any built-in tool for this job; TEAMYRA_TOOL_REQUEST is the only way to reach the project.',
    'Do not ask for approvals or start background tasks: do the work here, step by step, through TEAMYRA tools.',
    // TEAMYRA reads Muse's answer from the page, which drops backslashes,
    // Markdown characters and anything that looks like an HTML tag ("<id>"):
    // long file contents then broke as JSON (2026-11-07). \u escapes survive.
    'This page changes some characters in your answer. Inside the JSON of a TEAMYRA_TOOL_REQUEST, write every backslash as \\u005c, ' +
      'every double quote inside a string as \\u0022, < and > as \\u003c and \\u003e, and * _ ` $ inside strings as ' +
      '\\u002a \\u005f \\u0060 \\u0024. Line breaks stay \\n. Keep each tool request under about 4000 characters: write a long file with filesystem.create holding ' +
      'the first part and a last line TEAMYRA_CONTINUE, add each next part with filesystem.patch (find TEAMYRA_CONTINUE, ' +
      'replace with the part plus a new TEAMYRA_CONTINUE line), and finally replace the marker with the last part.'
  ]
};

class MuseWebProvider extends ChatGPTWebProvider {
  constructor(options = {}) {
    super({ ...options, site: MUSE_SITE });
  }
}
MuseWebProvider.prototype.site = MUSE_SITE;
MuseWebProvider.prototype.userActions = userActions(MUSE_SITE);

module.exports = { MuseWebProvider, MUSE_SITE, MUSE_HOSTS };
