const { ChatGPTWebProvider, userActions } = require('./chatgpt-web-provider');
const { ChatGPTSessionManager, DEFAULT_CHATGPT_PROFILE_ID } = require('./chatgpt-session-manager');
const { ChatSiteAdapter } = require('./chat-site-adapter');

// Grok (https://grok.com) as a TEAMYRA web-chat worker, in Build mode; see
// docs/QWEN_GROK_WEB_AGENTS.md. Page checked 2026-11-06: the model menu
// ("Model: Fast") offers Fast, Build, Auto, Expert and Heavy; a new chat
// starts on Fast. The menu ignores scripted clicks, so it is opened with a
// real mouse click (sendInputEvent) and Build is picked from it.
const GROK_HOME = 'https://grok.com/';
// Build by default; TEAMYRA_GROK_MODE picks another (Expert, Heavy, Auto, Fast).
const GROK_MODE = process.env.TEAMYRA_GROK_MODE || 'Build';
const GROK_DOMAINS = ['grok.com', 'x.ai', 'x.com', 'twitter.com'];
const GROK_EXTRA_HOSTS = new Set(['accounts.google.com', 'appleid.apple.com', 'challenges.cloudflare.com']);
const GROK_HOSTS = {
  has: host => GROK_EXTRA_HOSTS.has(host) || GROK_DOMAINS.some(domain => host === domain || String(host).endsWith('.' + domain))
};
const MODEL_TRIGGER = `[...document.querySelectorAll('button[aria-haspopup="menu"]')].find(node => /^Model:/.test(node.getAttribute('aria-label') || ''))`;

const GROK_RAW_REPLY_JS = idJson => `(async () => {
  try {
    const match = location.pathname.match(new RegExp('/c/([0-9a-f-]{36})', 'i'));
    if (!match) return '';
    const response = await fetch('/rest/app-chat/conversations/' + match[1] + '/responses?includeThreads=true', { credentials: 'include', signal: AbortSignal.timeout(7000) });
    if (!response.ok) return '';
    const data = await response.json();
    const reply = (data.responses || []).find(item => item.responseId === ${idJson} && item.sender === 'assistant');
    if (!reply || reply.partial) return '';
    return String(reply.message || '');
  } catch (error) { return ''; }
})()`;

class GrokAutomationAdapter extends ChatSiteAdapter {
  // Build mode for every message: open the model menu with a real click,
  // then pick Build (menu items take scripted clicks).
  async ensureSettings() {
    const mode = JSON.stringify(GROK_MODE);
    const current = await this.evaluate(`(() => {
      const trigger = ${MODEL_TRIGGER};
      if (!trigger) return { found: false };
      trigger.scrollIntoView({ block: 'nearest' });
      const rect = trigger.getBoundingClientRect();
      return { found: true, label: trigger.getAttribute('aria-label'), x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`);
    if (!current?.found) return { mode: 'missing' };
    if (current.label === 'Model: ' + GROK_MODE) return { mode: 'on' };
    await this.trustedClick(current.x, current.y);
    await new Promise(resolve => setTimeout(resolve, 600));
    const picked = await this.evaluate(`(async () => {
      const item = [...document.querySelectorAll('[role=menu] [role^=menuitem]')]
        .find(node => (node.innerText || '').trim().split('\\n')[0] === ${mode});
      if (!item) return false;
      item.click();
      await new Promise(resolve => setTimeout(resolve, 500));
      return true;
    })()`);
    const after = await this.evaluate(`(${MODEL_TRIGGER} || { getAttribute: () => '' }).getAttribute('aria-label')`);
    return { mode: picked && after === 'Model: ' + GROK_MODE ? 'on' : 'missing' };
  }

  // A reply that ends empty because of a server error ("Service temporarily
  // unavailable") shows nothing on the page; the error is only in Grok's
  // conversation data. It becomes a busy reply, which is asked again.
  async assistantSnapshot() {
    const snap = await super.assistantSnapshot();
    if (!snap || snap.generating || snap.text || !snap.messageId) return snap;
    const error = await this.evaluate(`(async () => {
      try {
        const match = location.pathname.match(new RegExp('/c/([0-9a-f-]{36})', 'i'));
        if (!match) return '';
        const response = await fetch('/rest/app-chat/conversations/' + match[1] + '/responses?includeThreads=true', { credentials: 'include', signal: AbortSignal.timeout(7000) });
        if (!response.ok) return '';
        const reply = ((await response.json()).responses || []).find(item => item.responseId === ${JSON.stringify(snap.messageId)});
        if (!reply || reply.partial || reply.message) return '';
        return (reply.streamErrors || []).map(item => String(item.message || '')).filter(Boolean).join(' ');
      } catch (error) { return ''; }
    })()`).catch(() => '');
    return error ? { ...snap, text: GROK_BUSY_PREFIX + error } : snap;
  }

  isTransientReply(text) {
    return String(text || '').startsWith(GROK_BUSY_PREFIX);
  }
}
const GROK_BUSY_PREFIX = 'TEAMYRA_SITE_BUSY: ';

const GROK_SITE = {
  id: 'grok',
  name: 'Grok',
  provider: 'grok-web',
  stateDir: 'grok',
  home: GROK_HOME,
  hosts: GROK_HOSTS,
  conversationHost: 'grok.com',
  workerId: profileId => profileId === DEFAULT_CHATGPT_PROFILE_ID ? 'grok-normal' : 'grok-' + profileId,
  conversationUrl: id => GROK_HOME + 'c/' + id,
  // Grok's login cookies are named sso / sso-rw.
  sessionManager: profileId => new ChatGPTSessionManager(profileId, {
    partitionBase: 'persist:teamyra-grok-profile', cookieUrl: 'https://grok.com', sessionCookie: /^sso(-rw)?$/
  }),
  page: {
    name: 'Grok',
    home: GROK_HOME,
    newChatUrl: GROK_HOME,
    conversationPattern: /\/c\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i,
    prompt: '[contenteditable="true"][aria-label="Message Grok"]',
    editor: 'rich',
    send: 'button[data-testid="chat-submit"]',
    stop: 'button[data-testid="composer-stop"]',
    user: '[data-testid="user-message"]',
    userPrefix: 'You',
    reply: '[id^="response-"]:has([data-testid="assistant-message"])',
    answer: '[data-testid="assistant-message"] .response-content-markdown',
    replyId: "node.id.replace('response-', '')",
    loginJs: "[...document.querySelectorAll('a, button')].some(b => /^(sign in|log in|sign up)$/i.test((b.innerText || '').trim()))",
    challengeJs: "!!document.querySelector('iframe[src*=\"challenges.cloudflare.com\"]')",
    rawReplyJs: GROK_RAW_REPLY_JS
  },
  adapter: (webContents, options) => new GrokAutomationAdapter(webContents, options, GROK_SITE.page),
  promptRules: [
    'Build mode is on, but the project is on the user\'s PC: do not build it in your own preview or sandbox. ' +
      'TEAMYRA_TOOL_REQUEST is the only way to read, change, run or test the project.'
  ]
};

class GrokWebProvider extends ChatGPTWebProvider {
  constructor(options = {}) {
    super({ ...options, site: GROK_SITE });
  }
}
GrokWebProvider.prototype.site = GROK_SITE;
GrokWebProvider.prototype.userActions = userActions(GROK_SITE);

module.exports = { GrokWebProvider, GrokAutomationAdapter, GROK_SITE, GROK_HOSTS, GROK_MODE, GROK_BUSY_PREFIX };
