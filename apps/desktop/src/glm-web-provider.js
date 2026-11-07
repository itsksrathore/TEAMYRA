const { ChatGPTWebProvider, userActions } = require('./chatgpt-web-provider');
const { ChatGPTSessionManager, DEFAULT_CHATGPT_PROFILE_ID } = require('./chatgpt-session-manager');
const { ChatSiteAdapter } = require('./chat-site-adapter');

// GLM on Z.ai (https://chat.z.ai) as a TEAMYRA web-chat worker; see
// docs/QWEN_GROK_WEB_AGENTS.md. Page checked 2026-11-06 (free plan):
// models GLM-5.3-Flash, GLM-5.3, GLM-5.2, with Effort (Max). TEAMYRA picks
// the strongest full model (highest version, not Flash/Air); when Z.ai says
// "Currently in peak hours" or "Model is currently at capacity", that model is
// set aside for 30 minutes and the next one is used (GLM-5.2, then Flash).
// Z.ai shows an Alibaba Cloud slider captcha often (in the test, for every
// message); the job then waits for the user, who solves it in TEAMYRA.
const GLM_HOME = 'https://chat.z.ai/';
const GLM_DOMAINS = ['z.ai', 'chatglm.cn', 'bigmodel.cn'];
const GLM_EXTRA_HOSTS = new Set(['github.com', 'appleid.apple.com']);
const GLM_HOSTS = {
  has: host => GLM_EXTRA_HOSTS.has(host) || GLM_DOMAINS.some(domain => host === domain || String(host).endsWith('.' + domain))
};
const AVOID_MS = 30 * 60 * 1000;
const CAPACITY_REPLY = /model is currently at capacity|switch to another model/i;
const MODEL_TRIGGER = "document.querySelector('.modelSelectorButton, [aria-label=\"Select a model\"]')";

// Z.ai's home page starts new chats in a "scene" (Web Site by default; also
// Full-Stack, Writing, Data Insight, slides): its own builder agent then
// answered with "Todos / Explored 1 files / Find File" instead of TEAMYRA
// tool requests (2026-11-07). The scene shows as a chip in the message box;
// clicking it exits the scene ("Click to exit the scene").
const GLM_SCENES = /^(?:web ?site|full[- ]?stack|writing|data insight|ppt|slides|ai slides|deep research|design|poster|image|video)$/i;

const glmSettingsJs = adapter => `(async () => {
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const sceneChip = () => {
    const input = document.querySelector('#chat-input');
    let box = input;
    for (let i = 0; i < 6 && box && box.parentElement && !box.querySelector('#send-message-button'); i += 1) box = box.parentElement;
    if (!box) return null;
    return [...box.querySelectorAll('button, [role=button], span, div')].find(node => {
      const text = (node.innerText || '').trim();
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && node.querySelector('svg') && ${GLM_SCENES}.test(text);
    }) || null;
  };
  let scene = 'off';
  for (let attempt = 0; attempt < 3 && sceneChip(); attempt += 1) {
    const chip = sceneChip();
    (chip.closest('button, [role=button]') || chip).click();
    await sleep(400);
  }
  if (sceneChip()) scene = 'on';
  const avoid = ${JSON.stringify(adapter.avoidedModels())};
  const trigger = () => ${MODEL_TRIGGER};
  const opener = trigger();
  if (!opener) return { model: 'missing', scene };
  opener.click();
  await sleep(500);
  const pattern = /^GLM-(\\d+(?:\\.\\d+)?)(?:-([A-Za-z]+))?$/;
  const items = [...document.querySelectorAll('button')].filter(node => node !== opener && pattern.test((node.innerText || '').trim()));
  // Full models first (Flash, Air and similar are the light ones), newest first.
  const rank = name => { const match = name.match(pattern) || []; return (/flash|air|lite|mini/i.test(match[2] || '') ? 0 : 1000) + Number(match[1] || 0); };
  const names = [...new Set(items.map(node => node.innerText.trim()))].sort((a, b) => rank(b) - rank(a));
  const name = names.find(item => !avoid.includes(item)) || names[0] || '';
  const item = items.find(node => node.innerText.trim() === name);
  if (item) { item.click(); await sleep(500); }
  const now = ((trigger() || {}).innerText || '').trim();
  return { model: name && now === name ? 'on' : 'missing', modelName: name, choices: names.join(', '), scene };
})()`;

class GlmAutomationAdapter extends ChatSiteAdapter {
  avoidedModels() {
    const now = Date.now();
    this.avoid = this.avoid || new Map();
    for (const [name, at] of this.avoid) if (now - at > AVOID_MS) this.avoid.delete(name);
    return [...this.avoid.keys()];
  }

  avoidCurrentModel() {
    const name = this.lastSettings?.modelName;
    if (!name) return;
    this.avoid = this.avoid || new Map();
    this.avoid.set(name, Date.now());
  }

  // "Currently in peak hours": the message was not sent. Close the dialog,
  // set this model aside, pick the next one; the send goes on.
  async onBlocked() {
    await this.evaluate(`(() => {
      const cancel = [...document.querySelectorAll('button')].find(node => (node.innerText || '').trim() === 'Cancel');
      if (cancel) cancel.click();
      return !!cancel;
    })()`).catch(() => false);
    this.avoidCurrentModel();
    this.lastSettings = await this.ensureSettings().catch(() => this.lastSettings);
  }

  // "Model is currently at capacity" is not an answer: the model is set
  // aside and the job loop asks again (on the next model).
  isTransientReply(text) {
    const value = String(text || '').trim();
    if (CAPACITY_REPLY.test(value) && value.length < 300) {
      this.avoidCurrentModel();
      return true;
    }
    return false;
  }
}

const GLM_SITE = {
  id: 'glm',
  name: 'GLM',
  provider: 'glm-web',
  stateDir: 'glm',
  home: GLM_HOME,
  hosts: GLM_HOSTS,
  conversationHost: 'chat.z.ai',
  workerId: profileId => profileId === DEFAULT_CHATGPT_PROFILE_ID ? 'glm-normal' : 'glm-' + profileId,
  conversationUrl: id => GLM_HOME + 'c/' + id,
  // The login token is kept in the page's storage.
  sessionFromPage: true,
  sessionManager: profileId => new ChatGPTSessionManager(profileId, {
    partitionBase: 'persist:teamyra-glm-profile', cookieUrl: 'https://chat.z.ai', sessionCookie: null
  }),
  page: {
    name: 'GLM',
    home: GLM_HOME,
    newChatUrl: GLM_HOME,
    conversationPattern: /\/c\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i,
    prompt: '#chat-input',
    send: '#send-message-button',
    // While GLM writes, the round button is a Stop square (no send id).
    stop: 'form button[type="submit"]:not(#send-message-button) span.rounded-xs',
    user: '#messages-container .user-message',
    reply: '#messages-container [id^="message-"]:not(.user-message):not([id$="-start"])',
    // The answer, without the "Thought Process" block; an error ("at
    // capacity") is shown in a red box instead of an answer.
    answer: '#response-content-container > .markdown-prose, #response-content-container > [class*="border-red"]',
    answerExclude: '.thinking-chain-container',
    replyId: "node.id.replace('message-', '')",
    loginJs: "/\\/auth/.test(location.pathname) || [...document.querySelectorAll('button, a')].some(b => /^(sign in|log in|sign up)$/i.test((b.innerText || '').trim()))",
    challengeJs: "!!document.querySelector('#aliyunCaptcha-window-popup.window-show')",
    blockedJs: "/Currently in peak hours/i.test(document.body.innerText) && [...document.querySelectorAll('button')].some(b => (b.innerText || '').trim() === 'Cancel')",
    settingsJs: glmSettingsJs
  },
  adapter: (webContents, options) => new GlmAutomationAdapter(webContents, options, GLM_SITE.page),
  // Z.ai drops the message behind a busy reply: send it again, not "answer again".
  resendAfterBusy: true,
  promptRules: [
    'Do not use Z.ai agents, Full-Stack, Web Site, PPT or any built-in tool for this job; TEAMYRA_TOOL_REQUEST is the only way to reach the project.',
    'Your thinking is not shown to TEAMYRA: put the TEAMYRA_TOOL_REQUEST line in your answer.',
    // The page drops backslashes and Markdown characters, and Z.ai keeps no
    // copy of the reply as written; JSON \\u escapes pass through unchanged.
    'This page changes some characters in your answer. Inside the JSON of a TEAMYRA_TOOL_REQUEST, write every backslash as \\u005c, ' +
      'every double quote inside a string as \\u0022, < and > as \\u003c and \\u003e, and * _ ` $ inside strings as \\u002a \\u005f \\u0060 \\u0024. Line breaks stay \\n.'
  ]
};

class GlmWebProvider extends ChatGPTWebProvider {
  constructor(options = {}) {
    super({ ...options, site: GLM_SITE });
  }
}
GlmWebProvider.prototype.site = GLM_SITE;
GlmWebProvider.prototype.userActions = userActions(GLM_SITE);

module.exports = { GlmWebProvider, GlmAutomationAdapter, GLM_SITE, GLM_HOSTS };
