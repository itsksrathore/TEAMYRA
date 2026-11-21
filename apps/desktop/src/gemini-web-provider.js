const fs = require('node:fs');
const path = require('node:path');
const { session } = require('electron');
const { ChatGPTWebProvider, userActions } = require('./chatgpt-web-provider');
const { DEFAULT_CHATGPT_PROFILE_ID } = require('./chatgpt-session-manager');
const { ChatSiteAdapter, COMMON_CHALLENGE_JS } = require('./chat-site-adapter');
const { challengeScript } = require('./challenge-detect');

// Google Gemini (https://gemini.google.com/app) as a TEAMYRA web-chat worker;
// see docs/GEMINI_WEB_AGENT.md.
//
// Gemini has no accounts of its own in TEAMYRA. Each Google Media account is
// one Gemini worker and runs in that account's own browser profile (Electron
// partition), so it is signed in already:
//   Gemini profile 'web'  -> Google Media 'google' -> persist:teamyra-google-media-profile
//   Gemini profile '<id>' -> Google Media '<id>'   -> persist:teamyra-google-media-<id>
// TEAMYRA never signs these accounts in or out from here and installs nothing
// on the shared session (no permission, download or cookie handlers: those
// belong to the Google Media engine). An account that is not signed in shows
// as not ready; it is signed in under Google Media.
//
// Page checked 2026-11-21 (signed out): message box [role=textbox] "Enter a
// prompt for Gemini" (Quill editor), "Send message" / "Stop response"
// buttons, a mode picker ("Open mode picker, currently Auto") with Auto,
// 4 Hydrogen, 4 Neon, 4 Carbon, and a Chat / Task toggle under the box on a
// new chat. Replies are <model-response> elements; the answer is in
// <message-content id="message-content-id-r_<id>">. The reply's "Copy"
// button gives its Markdown exactly as written.
const GEMINI_HOME = 'https://gemini.google.com/app';
const GEMINI_ORIGIN = 'https://gemini.google.com';
const GOOGLE_MEDIA_BASE_PARTITION = 'persist:teamyra-google-media-profile';
const GEMINI_HOSTS = {
  // gemini.google.com, Google's own session refresh pages and its "unusual
  // traffic" check (www.google.com/sorry); Google sign-in hosts are allowed
  // by the shared guard (googleSignInHost).
  has: host => ['gemini.google.com', 'accounts.google.com', 'myaccount.google.com', 'www.google.com'].includes(host)
};

// Models in order of preference when neither the job (model=) nor the
// account (gemini_model in its Google Media profile file) names one.
// TEAMYRA_GEMINI_MODELS (comma separated names) overrides the default.
const GEMINI_DEFAULT_MODELS = ['4 Carbon', '4 Neon', 'Auto'];
// The model menu's "Thinking level" (Low / Medium / High, signed in). The
// owner wants High (2026-11-21); an account's gemini_thinking or
// TEAMYRA_GEMINI_THINKING can name another level.
const GEMINI_DEFAULT_THINKING = 'High';
function thinkingLevel(account = {}) {
  const value = String(account.gemini_thinking || process.env.TEAMYRA_GEMINI_THINKING || GEMINI_DEFAULT_THINKING).trim();
  return /^(low|medium|high)$/i.test(value) ? value[0].toUpperCase() + value.slice(1).toLowerCase() : GEMINI_DEFAULT_THINKING;
}
function defaultModelOrder() {
  const env = String(process.env.TEAMYRA_GEMINI_MODELS || process.env.TEAMYRA_GEMINI_MODEL || '').trim();
  return env ? env.split(',').map(item => item.trim()).filter(Boolean) : [...GEMINI_DEFAULT_MODELS];
}

// "gemini-4-carbon", "Gemini 4 Carbon", "4_carbon" -> "4 carbon".
function normalizeModelName(value) {
  return String(value || '').toLowerCase().replace(/[-_]+/g, ' ').replace(/^\s*gemini\s+/, '').replace(/\s+/g, ' ').trim();
}

function modelPreference({ jobModel = '', accountModel = '', defaults = defaultModelOrder() } = {}) {
  const seen = new Set();
  const order = [];
  for (const name of [jobModel, accountModel, ...defaults]) {
    const value = String(name || '').trim();
    const key = normalizeModelName(value);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    order.push(value);
  }
  return order;
}

// The Google Media account behind a Gemini profile.
function mediaProfileId(profileId) {
  const id = String(profileId || DEFAULT_CHATGPT_PROFILE_ID);
  return id === DEFAULT_CHATGPT_PROFILE_ID ? 'google' : id;
}

function safeMediaId(value) {
  return String(value || 'google').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'google';
}

// Same names as media/google-media-session-manager.js partitionForProfile
// (kept here so the media modules are not loaded by this site).
function geminiPartition(profileId) {
  const id = safeMediaId(mediaProfileId(profileId));
  return id === 'google' ? GOOGLE_MEDIA_BASE_PARTITION : 'persist:teamyra-google-media-' + id;
}

// The Google Media profile file that holds an account's name and its
// optional Gemini settings (read only).
function mediaProfileFile(runtimeRoot, profileId) {
  const media = path.join(runtimeRoot, 'profiles', 'google-media');
  const id = mediaProfileId(profileId);
  return id === 'google' ? path.join(media, 'builtin-google.json') : path.join(media, id, 'teamyra-profile.json');
}

function readMediaProfile(runtimeRoot, profileId) {
  if (!runtimeRoot) return {};
  try {
    const data = JSON.parse(fs.readFileSync(mediaProfileFile(runtimeRoot, profileId), 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

// The Google Media accounts, as Gemini profile ids ('web' first). Folders
// only: profiles/google-media also holds files (builtin-google.json, ...).
function geminiProfileIds(profilesRoot) {
  const ids = [DEFAULT_CHATGPT_PROFILE_ID];
  try {
    for (const entry of fs.readdirSync(path.join(profilesRoot, 'google-media'), { withFileTypes: true })) {
      if (entry.isDirectory()) ids.push(entry.name);
    }
  } catch {}
  return ids;
}

const GOOGLE_SESSION_COOKIE = /^(?:SID|__Secure-1PSID|__Secure-3PSID)$/;

// Uses the Google Media account's session as it is: no handlers are set on
// it (the media engine owns them), nothing is written to it.
class GeminiSessionManager {
  constructor(profileId = DEFAULT_CHATGPT_PROFILE_ID) {
    this.profileId = String(profileId || DEFAULT_CHATGPT_PROFILE_ID);
    this.mediaProfileId = mediaProfileId(this.profileId);
    this.partition = geminiPartition(this.profileId);
    this.cookieUrl = GEMINI_ORIGIN;
    this.sessionCookie = GOOGLE_SESSION_COOKIE;
    this.session = null;
  }

  initialize() {
    if (!this.session) this.session = session.fromPartition(this.partition, { cache: true });
    return this.session;
  }

  getSession() { return this.initialize(); }

  async cookieSummary() {
    const cookies = await this.initialize().cookies.get({ url: this.cookieUrl });
    return { count: cookies.length, hasSessionCookies: cookies.some(cookie => this.sessionCookie.test(cookie.name)) };
  }
}

// Picks Chat (not Task) on a new chat, then the first usable model of
// `preferred` in the mode picker, matched by name against each menu item
// (its label and its description: "Code & complex work | 4 Carbon").
// Disabled items (signed out, or a model at its limit) are skipped. Returns
// { mode, model, modelName, choices }; 'missing' makes the adapter retry.
const geminiSettingsJs = (preferred, thinking = GEMINI_DEFAULT_THINKING) => `(async () => {
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const shown = node => { if (!node) return false; const r = node.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const norm = value => String(value || '').toLowerCase().replace(/[-_]+/g, ' ').replace(/^\\s*gemini\\s+/, '').replace(/\\s+/g, ' ').trim();
  const escape = value => value.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&');
  const state = {};
  // Task mode on a new chat shows its own start screen ("Hand off tasks to
  // Gemini", Get started / Not now) instead of the Chat toggle and the model
  // picker: "Not now" goes back to Chat.
  const inTasks = node => { for (let up = node.parentElement; up; up = up.parentElement) if (up.tagName.toLowerCase().includes('tasks')) return true; return false; };
  const notNow = [...document.querySelectorAll('button')].find(node => shown(node) && /^not now$/i.test((node.innerText || '').trim()) && inTasks(node));
  if (notNow) { notNow.click(); await sleep(1000); }
  const toggles = [...document.querySelectorAll('chat-spark-toggle button, gem-segmented-button-row button')].filter(shown);
  if (!toggles.length) state.mode = 'none';
  else {
    const chat = toggles.find(node => /^chat$/i.test((node.innerText || '').trim()));
    if (chat && chat.getAttribute('aria-pressed') !== 'true') { chat.click(); await sleep(300); }
    state.mode = chat && chat.getAttribute('aria-pressed') === 'true' ? 'chat' : 'missing';
  }
  const trigger = () => document.querySelector('button[aria-label^="Open mode picker"], bard-mode-switcher button');
  const opener = trigger();
  if (!opener) { state.model = 'missing'; return state; }
  const anyMenu = () => [...document.querySelectorAll('gem-menu[role=menu], [role=menu]')].find(shown);
  // The mode picker's menu has model radio items (another open menu, such as
  // Upload & tools, must not be read as the model list).
  const menu = () => [...document.querySelectorAll('gem-menu[role=menu], [role=menu]')]
    .find(node => shown(node) && node.querySelector('[role=menuitemradio]'));
  const close = async () => {
    const open = menu();
    if (!open) return;
    open.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
    await sleep(300);
    if (menu()) { trigger()?.click(); await sleep(300); }
  };
  // Start from a closed menu: a menu or submenu left open (Upload & tools,
  // Thinking level) would be read as the model list.
  for (let i = 0; i < 5 && anyMenu(); i += 1) {
    anyMenu().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
    await sleep(300);
  }
  if (!menu()) {
    trigger()?.click();
    for (let i = 0; i < 12 && !menu(); i += 1) await sleep(200);
  }
  const items = menu() ? [...menu().querySelectorAll('[role=menuitemradio], [role=menuitem]')]
    .filter(item => !/sign in|get more access|upgrade/i.test(item.innerText || '')) : [];
  const label = item => ((item.querySelector('.label') || {}).innerText || '').trim();
  const text = item => norm((item.innerText || '').replace(/\\n+/g, ' '));
  const usable = item => item.getAttribute('aria-disabled') !== 'true' && !item.querySelector('.disabled');
  const name = item => label(item) || (item.innerText || '').trim().split('\\n').pop().trim();
  // A line of the item that is the name ("4 Carbon") first; else the name
  // as whole words in it ("Carbon" in "4 Carbon"), so "4 Carbon" never
  // picks a "4 Carbon Ultra" listed before it.
  const exact = (item, key) => norm(label(item)) === key || (item.innerText || '').split('\\n').some(line => norm(line) === key);
  const loose = (item, key) => new RegExp('(^|\\\\s)' + escape(key) + '($|\\\\s)').test(text(item));
  const preferred = ${JSON.stringify(preferred)};
  state.choices = items.map(item => (item.innerText || '').trim().replace(/\\s*\\n+\\s*/g, ' / ')).join('; ');
  let pick = null; let wanted = '';
  for (const candidate of preferred) {
    const key = norm(candidate);
    if (!key) continue;
    pick = items.find(item => exact(item, key) && usable(item)) || items.find(item => loose(item, key) && usable(item));
    if (pick) { wanted = candidate; break; }
  }
  // "Thinking level" submenu: Low / Medium / High. 'none' when the page has
  // no such item (signed out); 'missing' when the wanted level did not stick.
  const setThinking = async () => {
    const wantedLevel = ${JSON.stringify(thinking)};
    const findEntry = () => [...document.querySelectorAll('gem-menu[role=menu] [role=menuitem], [role=menu] [role=menuitem]')]
      .find(item => shown(item) && /thinking level/i.test(item.innerText || ''));
    if (!findEntry()) {
      trigger()?.click();
      for (let i = 0; i < 12 && !findEntry(); i += 1) await sleep(200);
    }
    const entry = findEntry();
    if (!entry) { state.thinking = 'none'; return; }
    entry.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    entry.click();
    await sleep(700);
    const levels = [...document.querySelectorAll('[role=menuitemradio]')].filter(shown)
      .filter(item => /^(low|medium|high)\\b/i.test((item.innerText || '').trim()));
    const level = levels.find(item => (item.innerText || '').trim().toLowerCase().startsWith(wantedLevel.toLowerCase()));
    if (!level) { state.thinking = 'missing'; return; }
    if (level.getAttribute('aria-checked') !== 'true') { level.click(); await sleep(500); }
    state.thinking = level.isConnected && level.getAttribute('aria-checked') !== 'true' ? 'missing' : wantedLevel.toLowerCase();
    state.thinkingChoices = levels.map(item => (item.innerText || '').trim().split('\\n')[0]).join(', ');
  };
  if (!pick) {
    if (items.length) await setThinking();
    await close();
    state.model = items.length ? 'kept' : 'missing';
    state.modelName = (((trigger() || {}).getAttribute?.('aria-label') || '').match(/currently (.+)$/i) || [])[1] || '';
    return state;
  }
  state.modelName = wanted;
  if (pick.getAttribute('aria-checked') !== 'true') { pick.click(); await sleep(600); }
  const checked = pick.isConnected ? pick.getAttribute('aria-checked') === 'true' : false;
  await setThinking();
  await close();
  const current = norm((((trigger() || {}).getAttribute?.('aria-label') || '').match(/currently (.+)$/i) || [])[1] || (trigger() || {}).innerText || '');
  state.model = checked || current === norm(wanted) || current === norm(name(pick)) || current.includes(norm(wanted)) ? 'on' : 'missing';
  return state;
})()`;

// Signed out: no Google account button, and a visible "Sign in" link or
// button (the page still shows a message box when signed out).
const GEMINI_LOGIN_JS = `(() => {
  if (/(^|\\.)accounts\\.google\\.com$/.test(location.hostname)) return true;
  if (document.querySelector('[aria-label^="Google Account"]')) return false;
  const shown = node => { const r = node.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  return [...document.querySelectorAll('a, button')].some(node => shown(node) && /^sign in$/i.test((node.innerText || '').trim()));
})()`;

// The answer as Markdown-like text, from the page: code blocks as fences
// (the page shows a "Python" header and hides the fence), lists with "- ".
const GEMINI_HELPERS = `
  const gmShown = node => { if (!node) return false; const r = node.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const gmReplies = () => [...document.querySelectorAll('model-response')];
  const gmContent = reply => reply.querySelector('message-content');
  const gmReplyId = reply => { const node = gmContent(reply); return node && node.id ? node.id.replace(/^message-content-id-/, '') : ''; };
  const gmText = node => {
    if (!node) return '';
    if (node.nodeType === 3) return node.nodeValue;
    if (node.nodeType !== 1) return '';
    const tag = node.tagName.toLowerCase();
    if (tag === 'code-block') {
      const code = node.querySelector('code');
      const lang = ((node.querySelector('.code-block-decoration span') || {}).innerText || '').trim().toLowerCase();
      return '\\n\`\`\`' + lang + '\\n' + String(code ? code.textContent : node.innerText || '').replace(/\\n$/, '') + '\\n\`\`\`\\n';
    }
    if (tag === 'pre') return '\\n\`\`\`\\n' + String(node.textContent || '').replace(/\\n$/, '') + '\\n\`\`\`\\n';
    if (tag === 'code') return '\`' + node.textContent + '\`';
    if (tag === 'br') return '\\n';
    if (/^(button|mat-icon|gem-icon|model-thoughts|sources-list|script|style)$/.test(tag)) return '';
    const inner = [...node.childNodes].map(gmText).join('');
    if (tag === 'li') return '- ' + inner.trim() + '\\n';
    if (/^(p|h[1-6]|div|ul|ol|blockquote|table|tr|response-element)$/.test(tag)) return inner + '\\n';
    if (/^(td|th)$/.test(tag)) return inner.trim() + ' | ';
    return inner;
  };
  const gmAnswer = reply => {
    const content = gmContent(reply);
    const markdown = content && (content.querySelector('.markdown') || content);
    return markdown ? gmText(markdown).replace(/\\n{3,}/g, '\\n\\n').trim() : '';
  };
  const gmGenerating = () => [...document.querySelectorAll('button[aria-label="Stop response"]')].some(gmShown);
`;

// The reply exactly as written: its "Copy" button, with the page's
// clipboard calls caught for this one click (nothing reaches the clipboard).
const GEMINI_RAW_REPLY_JS = idJson => `(async () => {${GEMINI_HELPERS}
  const reply = gmReplies().find(node => gmReplyId(node) === ${idJson});
  if (!reply || gmGenerating()) return '';
  const button = [...reply.querySelectorAll('copy-button button, button[aria-label="Copy"]')]
    .find(node => !node.closest('code-block')) || null;
  if (!button) return '';
  const clip = navigator.clipboard;
  const saved = clip ? { writeText: clip.writeText, write: clip.write } : null;
  const savedExec = document.execCommand;
  let text = null;
  try {
    if (clip) {
      clip.writeText = async value => { text = String(value); };
      clip.write = async items => {
        for (const item of items || []) {
          if ((item.types || []).includes('text/plain')) text = await (await item.getType('text/plain')).text();
        }
        if (text === null) text = '';
      };
    }
    document.execCommand = function (command, ...rest) {
      if (String(command).toLowerCase() === 'copy') { text = String(getSelection() || ''); return true; }
      return savedExec.call(document, command, ...rest);
    };
    button.click();
    for (let i = 0; i < 30 && text === null; i += 1) await new Promise(resolve => setTimeout(resolve, 100));
  } catch (error) {
    text = null;
  } finally {
    if (clip && saved) { clip.writeText = saved.writeText; clip.write = saved.write; }
    document.execCommand = savedExec;
  }
  return typeof text === 'string' ? text : '';
})()`;

class GeminiAutomationAdapter extends ChatSiteAdapter {
  // The models to try, best first: the job's model=, the account's
  // gemini_model, then the default order.
  preferredModels() {
    const options = this.pageOptions || {};
    const jobModel = typeof options.jobModel === 'function' ? options.jobModel() : options.jobModel;
    const account = readMediaProfile(options.runtimeRoot, options.profileId);
    return modelPreference({ jobModel, accountModel: typeof account.gemini_model === 'string' ? account.gemini_model : '' });
  }

  // The thinking level to pick: the account's gemini_thinking, else High.
  thinkingLevel() {
    const options = this.pageOptions || {};
    return thinkingLevel(readMediaProfile(options.runtimeRoot, options.profileId));
  }

  // Gemini shows its message box when signed out too: sign-in is read from
  // the page itself, not from a missing box.
  async probe() {
    const site = this.chatSite;
    return this.evaluate(`(() => {
      const prompt = document.querySelector(${JSON.stringify(site.prompt)});
      let challenged = false; let loginVisible = false;
      try { challenged = Boolean(${site.challengeJs}); } catch {}
      try { loginVisible = !challenged && Boolean(${GEMINI_LOGIN_JS}); } catch {}
      return { promptFound: !!prompt && !loginVisible, challenged, loginVisible, url: location.href, title: document.title };
    })()`);
  }

  async lastUserMessage() {
    return this.evaluate(`(() => {
      const last = [...document.querySelectorAll('user-query')].at(-1);
      if (!last) return '';
      const lines = [...last.querySelectorAll('.query-text-line')];
      if (lines.length) return lines.map(node => (node.innerText || node.textContent || '').trim()).join('\\n');
      return (last.innerText || '').replace(/^\\s*You said\\s*/i, '').trim();
    })()`);
  }

  async assistantSnapshot() {
    const site = this.chatSite;
    return this.evaluate(`(() => {${GEMINI_HELPERS}
      const replies = gmReplies();
      const last = replies.at(-1) || null;
      let challenged = false;
      try { challenged = Boolean(${site.challengeJs}); } catch {}
      return {
        count: replies.length,
        text: last ? gmAnswer(last) : '',
        messageId: last ? (gmReplyId(last) || String(replies.length)) : '',
        generating: gmGenerating(),
        challenged,
        images: 0,
        activity: replies.length + ':' + (last ? last.innerHTML.length : 0)
      };
    })()`);
  }

  async stopGeneration() {
    return this.evaluate(`(() => {${GEMINI_HELPERS}
      const stop = [...document.querySelectorAll('button[aria-label="Stop response"]')].find(gmShown);
      if (!stop) return { ok: false, reason: 'stop-button-not-found' };
      stop.click();
      return { ok: true };
    })()`);
  }

  async rawReplyText(messageId = '') {
    if (!messageId) return '';
    const text = await this.evaluate(GEMINI_RAW_REPLY_JS(JSON.stringify(String(messageId))));
    return typeof text === 'string' ? text : '';
  }
}

const GEMINI_PROMPT = 'rich-textarea .ql-editor[role=textbox], [role=textbox][aria-label*="prompt" i]';

const GEMINI_SITE = {
  id: 'gemini',
  name: 'Gemini',
  provider: 'gemini-web',
  stateDir: 'gemini',
  home: GEMINI_HOME,
  hosts: GEMINI_HOSTS,
  conversationHost: 'gemini.google.com',
  workerId: profileId => profileId === DEFAULT_CHATGPT_PROFILE_ID ? 'gemini-normal' : 'gemini-' + profileId,
  conversationUrl: id => GEMINI_HOME + '/' + id,
  sessionManager: profileId => new GeminiSessionManager(profileId),
  page: {
    name: 'Gemini',
    home: GEMINI_HOME,
    newChatUrl: GEMINI_HOME,
    conversationPattern: /gemini\.google\.com\/(?:u\/\d+\/)?app\/([0-9a-f]{8,})/i,
    prompt: GEMINI_PROMPT,
    editor: 'rich',
    send: 'button[aria-label="Send message"]',
    stop: 'button[aria-label="Stop response"]',
    user: 'user-query',
    reply: 'model-response',
    answer: 'message-content .markdown',
    replyId: "((node.querySelector('message-content') || {}).id || '').replace('message-content-id-', '')",
    loginJs: GEMINI_LOGIN_JS,
    challengeJs: `(${COMMON_CHALLENGE_JS} || Boolean(${challengeScript(GEMINI_PROMPT)}))`,
    settingsJs: adapter => geminiSettingsJs(adapter.preferredModels(), adapter.thinkingLevel())
  },
  adapter: (webContents, options) => new GeminiAutomationAdapter(webContents, options, GEMINI_SITE.page),
  promptRules: [
    'Do not use Gemini\'s Canvas, Deep Research, Task mode, code execution, apps/extensions or any built-in tool for this job; ' +
      'TEAMYRA_TOOL_REQUEST is the only way to reach the project.',
    'Your thinking is not shown to TEAMYRA: put the TEAMYRA_TOOL_REQUEST line in your answer.',
    'Never call filesystem.*, terminal.*, git.* or any TEAMYRA tool through the built-in function calling of this site: it does not have them. ' +
      'Write the TEAMYRA_TOOL_REQUEST line as plain text in your answer.',
    'This page shows your answer as formatted Markdown. Put each TEAMYRA_TOOL_REQUEST line inside a fenced code block ' +
      '(a line with ```text, the request line, a line with ```), and write normal JSON inside it.'
  ]
};

function geminiUserActions(site) {
  const actions = userActions(site);
  actions.sign_in = {
    ...actions.sign_in,
    message: 'This Google account is not signed in to Gemini. Gemini uses the Google Media accounts: sign the account in ' +
      'under Google Media in TEAMYRA Desktop; the job resumes automatically.',
    waiting: 'waiting: Google account not signed in (sign it in under Google Media)',
    paused: 'needs_user: Google account not signed in (Google Media)'
  };
  return actions;
}

class GeminiWebProvider extends ChatGPTWebProvider {
  constructor(options = {}) {
    super({ ...options, site: GEMINI_SITE });
    this.userActions = geminiUserActions(GEMINI_SITE);
  }
}
GeminiWebProvider.prototype.site = GEMINI_SITE;
GeminiWebProvider.prototype.userActions = geminiUserActions(GEMINI_SITE);

module.exports = {
  GeminiWebProvider,
  GeminiAutomationAdapter,
  GeminiSessionManager,
  GEMINI_SITE,
  GEMINI_HOSTS,
  GEMINI_DEFAULT_MODELS,
  GEMINI_DEFAULT_THINKING,
  thinkingLevel,
  geminiPartition,
  geminiProfileIds,
  geminiSettingsJs,
  mediaProfileId,
  mediaProfileFile,
  readMediaProfile,
  modelPreference,
  normalizeModelName
};
