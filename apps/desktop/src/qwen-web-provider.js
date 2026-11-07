const { ChatGPTWebProvider, userActions } = require('./chatgpt-web-provider');
const { ChatGPTSessionManager, DEFAULT_CHATGPT_PROFILE_ID } = require('./chatgpt-session-manager');
const { ChatSiteAdapter } = require('./chat-site-adapter');

// Qwen (https://chat.qwen.ai) as a TEAMYRA web-chat worker; see
// docs/QWEN_GROK_WEB_AGENTS.md. Page checked 2026-11-06 (free plan):
// models Qwen3.7-Plus, Qwen3.8-Max ("The flagship of Qwen3.8"),
// Qwen3.8-Omni-Flash; thinking Auto / Thinking / Fast. TEAMYRA picks the
// flagship (or else the newest -Max) and Thinking for every message. Agent
// Mode is left off: it works with Qwen's own tools, not the project.
const QWEN_HOME = 'https://chat.qwen.ai/';
const QWEN_DOMAINS = ['qwen.ai', 'qwen.com', 'aliyun.com', 'alibabacloud.com', 'aliyuncs.com', 'alicdn.com'];
const QWEN_EXTRA_HOSTS = new Set(['accounts.google.com', 'appleid.apple.com', 'github.com']);
const QWEN_HOSTS = {
  has: host => QWEN_EXTRA_HOSTS.has(host) || QWEN_DOMAINS.some(domain => host === domain || String(host).endsWith('.' + domain))
};

// Model order (2026-11-07): Qwen3.8-Max, the flagship, kept hitting its usage
// limit on the free plan, so TEAMYRA uses Qwen3.7-Plus, then
// Qwen3.8-Omni-Flash, then any other Plus; Max only if none of those is
// offered. TEAMYRA_QWEN_MODEL (a name such as "Qwen3.8-Max") overrides.
const QWEN_MODEL_ORDER = process.env.TEAMYRA_QWEN_MODEL
  ? [process.env.TEAMYRA_QWEN_MODEL]
  : ['Qwen3.7-Plus', 'Qwen3.8-Omni-Flash'];

const QWEN_SETTINGS_JS = `(async () => {
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const state = {};
  const preferred = ${JSON.stringify(QWEN_MODEL_ORDER)};
  const modelTrigger = () => document.querySelector('[aria-label="Select Model"]');
  const trigger = modelTrigger();
  if (!trigger) state.model = 'missing';
  else {
    trigger.click();
    await sleep(500);
    const items = [...document.querySelectorAll('.wms-list__item')];
    const version = text => Number((text.match(/Qwen(\\d+(?:\\.\\d+)?)/i) || [])[1] || 0);
    const named = item => item.innerText.trim().split('\\n')[0].trim();
    const newest = pattern => items.filter(item => pattern.test(named(item))).sort((a, b) => version(named(b)) - version(named(a)))[0];
    const best = preferred.map(name => items.find(item => named(item).toLowerCase() === name.toLowerCase())).find(Boolean) ||
      newest(/-Plus\\b/i) || newest(/Omni-Flash/i) || items.find(item => /flagship/i.test(item.innerText)) || newest(/-Max\\b/i);
    const name = best ? best.innerText.trim().split('\\n')[0] : '';
    if (best && !String(best.className).includes('selected')) { best.click(); await sleep(400); }
    // Close the list with a click beside it (toggling the trigger reopened it).
    if ([...document.querySelectorAll('.wms-list__item')].some(node => node.getBoundingClientRect().width > 0)) {
      const outside = document.querySelector('main') || document.body;
      for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
        outside.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: 5, clientY: 400 }));
      }
      await sleep(400);
    }
    state.model = name && (modelTrigger()?.innerText || '').trim().startsWith(name) ? 'on' : 'missing';
    state.modelName = name;
  }
  const label = () => [...document.querySelectorAll('.qwen-chat-v2-dropdown-menu-select-label')]
    .find(node => /^(Auto|Thinking|Fast)$/.test(node.innerText.trim()));
  const current = label();
  if (!current) state.thinking = 'missing';
  else if (current.innerText.trim() === 'Thinking') state.thinking = 'on';
  else {
    current.closest('.qwen-chat-v2-dropdown-menu-trigger')?.click();
    await sleep(500);
    const item = [...document.querySelectorAll('.qwen-chat-v2-dropdown-menu-popup .qwen-chat-v2-dropdown-menu-item')]
      .find(node => node.innerText.trim().split('\\n')[0] === 'Thinking');
    if (item) { item.click(); await sleep(400); }
    state.thinking = label()?.innerText.trim() === 'Thinking' ? 'on' : 'missing';
  }
  return state;
})()`;

const QWEN_RAW_REPLY_JS = idJson => `(async () => {
  try {
    const match = location.pathname.match(new RegExp('/c/([0-9a-f-]{36})', 'i'));
    if (!match) return '';
    const response = await fetch('/api/v2/chats/' + match[1], {
      credentials: 'include', signal: AbortSignal.timeout(7000), headers: { Authorization: 'Bearer ' + (localStorage.getItem('token') || '') }
    });
    if (!response.ok) return '';
    const data = await response.json();
    const messages = ((((data || {}).data || {}).chat || {}).history || {}).messages || {};
    const message = messages[${idJson}];
    if (!message || message.role !== 'assistant') return '';
    const parts = (message.content_list || []).filter(part => part.phase === 'answer');
    if (!parts.length || parts.some(part => part.status !== 'finished')) return '';
    return parts.map(part => String(part.content || '')).join('');
  } catch (error) { return ''; }
})()`;

const QWEN_SITE = {
  id: 'qwen',
  name: 'Qwen',
  provider: 'qwen-web',
  stateDir: 'qwen',
  home: QWEN_HOME,
  hosts: QWEN_HOSTS,
  conversationHost: 'chat.qwen.ai',
  workerId: profileId => profileId === DEFAULT_CHATGPT_PROFILE_ID ? 'qwen-normal' : 'qwen-' + profileId,
  conversationUrl: id => QWEN_HOME + 'c/' + id,
  // The login token is kept in the page's storage.
  sessionFromPage: true,
  sessionManager: profileId => new ChatGPTSessionManager(profileId, {
    partitionBase: 'persist:teamyra-qwen-profile', cookieUrl: 'https://chat.qwen.ai', sessionCookie: null
  }),
  page: {
    name: 'Qwen',
    home: QWEN_HOME,
    newChatUrl: QWEN_HOME,
    conversationPattern: /\/c\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i,
    prompt: 'textarea.message-input-textarea, textarea#chat-input',
    send: 'button.send-button',
    stop: 'button.stop-button',
    user: '.qwen-chat-message-user',
    reply: '.qwen-chat-message-assistant',
    answer: '.response-message-content.phase-answer',
    replyId: "(node.querySelector('[id^=\"chat-response-message-\"]') || {}).id?.replace('chat-response-message-', '')",
    loginJs: "/\\/auth/.test(location.pathname) || [...document.querySelectorAll('button')].some(b => /^(log in|sign in)$/i.test((b.innerText || '').trim()))",
    challengeJs: "!!document.querySelector('#aliyunCaptcha-window-popup.window-show, #aliyunCaptcha-mask.mask-show')",
    settingsJs: QWEN_SETTINGS_JS,
    rawReplyJs: QWEN_RAW_REPLY_JS
  },
  adapter: (webContents, options) => new ChatSiteAdapter(webContents, options, QWEN_SITE.page),
  promptRules: [
    'Do not use Agent Mode, web dev previews or any built-in tool for this job; TEAMYRA_TOOL_REQUEST is the only way to reach the project.',
    'Your thinking is not shown to TEAMYRA: put the TEAMYRA_TOOL_REQUEST line in your answer.',
    'Never call filesystem.*, terminal.*, git.* or any TEAMYRA tool through the built-in function calling of this site: it does not have them. Write the TEAMYRA_TOOL_REQUEST line as plain text in your answer.'
  ]
};

class QwenWebProvider extends ChatGPTWebProvider {
  constructor(options = {}) {
    super({ ...options, site: QWEN_SITE });
  }
}
QwenWebProvider.prototype.site = QWEN_SITE;
QwenWebProvider.prototype.userActions = userActions(QWEN_SITE);

module.exports = { QwenWebProvider, QWEN_SITE, QWEN_HOSTS };
