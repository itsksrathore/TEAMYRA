const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

// Gemini (gemini.google.com) as a web-chat worker in the Google Media
// accounts: sessions, model choice, page reading and the job loop.
const fromPartitionCalls = [];
const fakeSession = partition => ({
  partition,
  cookies: {
    get: async ({ url }) => url === 'https://gemini.google.com' && partition === 'persist:teamyra-google-media-profile'
      ? [{ name: 'NID' }, { name: '__Secure-1PSID' }] : [{ name: 'NID' }]
  },
  // Gemini must never install handlers on the Google Media session.
  setPermissionCheckHandler: () => { throw new Error('Gemini set a permission handler on the Google session'); },
  setPermissionRequestHandler: () => { throw new Error('Gemini set a permission handler on the Google session'); },
  on: () => { throw new Error('Gemini added a session listener on the Google session'); }
});
const originalLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'electron') {
    return {
      WebContentsView: class {}, Notification: null,
      session: { fromPartition: (partition, options) => { fromPartitionCalls.push([partition, options]); return fakeSession(partition); } }
    };
  }
  if (request === './core-api') return { callCore: () => Promise.resolve({}) };
  return originalLoad.call(this, request, ...rest);
};
const gemini = require('../src/gemini-web-provider');
const { partitionForProfile: mediaPartition } = require('../src/media/google-media-session-manager');
const { ChatSiteAdapter } = require('../src/chat-site-adapter');
Module._load = originalLoad;
const {
  GEMINI_SITE, GeminiWebProvider, GeminiAutomationAdapter, GeminiSessionManager, geminiPartition, geminiProfileIds,
  geminiSettingsJs, modelPreference, normalizeModelName, mediaProfileId, GEMINI_DEFAULT_MODELS
} = gemini;

// --- a small fake DOM, enough for the settings script ----------------------------
class FakeElement {
  constructor(tag, attrs = {}, text = '', children = []) {
    this.tagName = tag.toUpperCase();
    this.attrs = { ...attrs };
    this.ownText = text;
    this.children = [];
    this.parentElement = null;
    this.hidden = false;
    this.onclick = null;
    this.listeners = {};
    for (const child of children) this.append(child);
  }
  append(child) { child.parentElement = this; this.children.push(child); return child; }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(node => node !== this); this.parentElement = null; }
  get isConnected() { let node = this; while (node.parentElement) node = node.parentElement; return node.tagName === 'BODY'; }
  get className() { return this.attrs.class || ''; }
  get classList() { return { contains: name => this.className.split(/\s+/).includes(name) }; }
  get id() { return this.attrs.id || ''; }
  getAttribute(name) { return name in this.attrs ? String(this.attrs[name]) : null; }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  get innerText() { return [this.ownText, ...this.children.map(child => child.innerText)].filter(Boolean).join('\n'); }
  get textContent() { return this.innerText; }
  getBoundingClientRect() {
    let node = this;
    while (node) { if (node.hidden) return { width: 0, height: 0 }; node = node.parentElement; }
    return { width: 100, height: 20 };
  }
  click() { if (this.onclick) this.onclick(); }
  dispatchEvent(event) { (this.listeners[event.type] || []).forEach(fn => fn(event)); let up = this.parentElement; while (up) { (up.listeners[event.type] || []).forEach(fn => fn(event)); up = up.parentElement; } return true; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  descendants() { return this.children.flatMap(child => [child, ...child.descendants()]); }
  matchesSimple(part) {
    const re = /^([a-z0-9-]*)((?:\[[^\]]+\]|\.[\w-]+)*)$/i;
    const match = part.match(re);
    if (!match) throw new Error('fake DOM: unsupported selector ' + part);
    if (match[1] && match[1].toUpperCase() !== this.tagName) return false;
    for (const piece of match[2].match(/\[[^\]]+\]|\.[\w-]+/g) || []) {
      if (piece.startsWith('.')) { if (!this.classList.contains(piece.slice(1))) return false; continue; }
      const attr = piece.slice(1, -1).match(/^([\w-]+)(?:(\^?=)"?([^"]*)"?)?$/);
      const value = this.getAttribute(attr[1]);
      if (value === null) return false;
      if (attr[2] === '=' && value !== attr[3]) return false;
      if (attr[2] === '^=' && !value.startsWith(attr[3])) return false;
    }
    return true;
  }
  matches(selector) {
    return selector.split(',').map(item => item.trim()).some(item => {
      const parts = item.match(/(?:\[[^\]]*\]|[^\s[])+/g);
      if (!this.matchesSimple(parts.at(-1))) return false;
      let node = this.parentElement;
      for (let index = parts.length - 2; index >= 0; index -= 1) {
        while (node && !node.matchesSimple(parts[index])) node = node.parentElement;
        if (!node) return false;
        node = node.parentElement;
      }
      return true;
    });
  }
  querySelectorAll(selector) { return this.descendants().filter(node => node.matches(selector)); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

const el = (tag, attrs, text, children) => new FakeElement(tag, attrs, text, children);

// Gemini's page: the Chat / Task toggle, the mode picker and its menu (built
// when opened, removed on Escape or a pick, like the real page).
function fakeGeminiPage({ models, current = 'Auto', task = false, withToggle = true }) {
  const body = el('body');
  const state = { current, menu: null, clicks: [] };
  const trigger = el('button', { 'aria-label': 'Open mode picker, currently ' + current }, current);
  const closeMenu = () => { if (state.menu) { state.menu.remove(); state.menu = null; } };
  trigger.onclick = () => {
    state.clicks.push('trigger');
    if (state.menu) return closeMenu();
    const items = models.map(model => {
      const item = el('gem-menu-item', { role: 'menuitemradio', 'aria-checked': String(model.name === state.current),
        'aria-disabled': String(model.disabled === true) }, '', [el('span', { class: 'label' }, model.label || model.name), el('div', { class: 'sublabel' }, model.label ? model.name : model.description || '')]);
      item.onclick = () => {
        if (model.disabled) return;
        state.clicks.push(model.name);
        state.current = model.name;
        trigger.setAttribute('aria-label', 'Open mode picker, currently ' + model.name);
        trigger.ownText = model.name;
        closeMenu();
      };
      return item;
    });
    items.push(el('gem-menu-item', { role: 'menuitem' }, 'Sign in\nGet more access'));
    state.menu = body.append(el('gem-menu', { role: 'menu' }, '', items));
    state.menu.addEventListener('keydown', event => { if (event.key === 'Escape') closeMenu(); });
  };
  body.append(el('bard-mode-switcher', {}, '', [trigger]));
  if (withToggle) {
    const chat = el('button', { 'aria-pressed': String(!task) }, 'Chat');
    const taskButton = el('button', { 'aria-pressed': String(task) }, 'Task');
    chat.onclick = () => { state.clicks.push('Chat'); chat.setAttribute('aria-pressed', 'true'); taskButton.setAttribute('aria-pressed', 'false'); };
    body.append(el('chat-spark-toggle', {}, '', [el('gem-segmented-button-row', { role: 'group' }, '', [chat, taskButton])]));
  }
  const document = {
    body,
    querySelectorAll: selector => body.querySelectorAll(selector),
    querySelector: selector => body.querySelector(selector),
    get activeElement() { return body; }
  };
  return { document, state, trigger };
}

class FakeKeyboardEvent { constructor(type, init = {}) { this.type = type; Object.assign(this, init); } }

async function runSettings(page, preferred) {
  const script = geminiSettingsJs(preferred);
  const run = new Function('document', 'KeyboardEvent', 'setTimeout', 'return ' + script);
  return run(page.document, FakeKeyboardEvent, (fn) => setImmediate(fn));
}

const SIGNED_IN_MODELS = [
  { label: 'Auto', name: 'Auto', description: 'Adapts to your needs' },
  { label: 'Everyday help', name: '4 Hydrogen' },
  { label: 'Deeper analysis', name: '4 Neon' },
  { label: 'Code & complex work', name: '4 Carbon' }
];

async function settingsTests() {
  // Default order: 4 Carbon for coding, then 4 Neon, then Auto.
  assert.deepEqual(GEMINI_DEFAULT_MODELS, ['4 Carbon', '4 Neon', 'Auto']);
  let page = fakeGeminiPage({ models: SIGNED_IN_MODELS });
  let state = await runSettings(page, modelPreference({}));
  assert.equal(state.model, 'on', JSON.stringify(state));
  assert.equal(state.modelName, '4 Carbon');
  assert.equal(state.mode, 'chat');
  assert.equal(page.state.current, '4 Carbon');
  assert.equal(page.state.menu, null, 'the menu is closed before the message is sent');
  assert.match(state.choices, /4 Neon/);

  // Carbon disabled (at its limit, or not offered): Neon.
  page = fakeGeminiPage({ models: SIGNED_IN_MODELS.map(model => model.name === '4 Carbon' ? { ...model, disabled: true } : model) });
  state = await runSettings(page, modelPreference({}));
  assert.equal(state.modelName, '4 Neon');
  assert.equal(page.state.current, '4 Neon');

  // Signed out: only Auto usable.
  page = fakeGeminiPage({ models: SIGNED_IN_MODELS.map(model => model.name === 'Auto' ? model : { ...model, disabled: true }) });
  state = await runSettings(page, modelPreference({}));
  assert.equal(state.modelName, 'Auto');
  assert.equal(state.model, 'on');
  assert.ok(!page.state.clicks.includes('Auto'), 'an already chosen model is not clicked again');

  // The job's model= wins, in any spelling; then the account's model.
  page = fakeGeminiPage({ models: SIGNED_IN_MODELS });
  state = await runSettings(page, modelPreference({ jobModel: 'gemini-4-hydrogen', accountModel: '4 Neon' }));
  assert.equal(state.modelName, 'gemini-4-hydrogen');
  assert.equal(page.state.current, '4 Hydrogen');
  page = fakeGeminiPage({ models: SIGNED_IN_MODELS });
  state = await runSettings(page, modelPreference({ jobModel: '', accountModel: '4 Neon' }));
  assert.equal(page.state.current, '4 Neon');

  // A model a signed-in account offers beyond the known ones, picked by name.
  page = fakeGeminiPage({ models: [...SIGNED_IN_MODELS, { label: 'Hardest problems', name: '4 Carbon Ultra' }] });
  state = await runSettings(page, ['4 Carbon Ultra', '4 Carbon']);
  assert.equal(page.state.current, '4 Carbon Ultra');
  // "4 Carbon" does not pick "4 Carbon Ultra" by accident, and vice versa.
  page = fakeGeminiPage({ models: [{ label: 'Hardest problems', name: '4 Carbon Ultra' }, ...SIGNED_IN_MODELS] });
  await runSettings(page, ['4 Carbon']);
  assert.equal(page.state.current, '4 Carbon');

  // No wanted model offered: the page's own choice stays.
  page = fakeGeminiPage({ models: [{ label: 'Auto', name: 'Auto' }] });
  state = await runSettings(page, ['4 Carbon']);
  assert.equal(state.model, 'kept');
  assert.equal(page.state.menu, null);

  // Task mode is switched back to Chat.
  page = fakeGeminiPage({ models: SIGNED_IN_MODELS, task: true });
  state = await runSettings(page, ['Auto']);
  assert.equal(state.mode, 'chat');
  assert.ok(page.state.clicks.includes('Chat'));

  // In a conversation there is no toggle; no picker means "missing" (retried).
  page = fakeGeminiPage({ models: SIGNED_IN_MODELS, withToggle: false });
  state = await runSettings(page, ['Auto']);
  assert.equal(state.mode, 'none');
  page.trigger.remove();
  state = await runSettings(page, ['Auto']);
  assert.equal(state.model, 'missing');

  assert.equal(normalizeModelName('Gemini 4-Carbon'), '4 carbon');
  assert.deepEqual(modelPreference({ jobModel: '4 carbon', accountModel: '', defaults: ['4 Carbon', 'Auto'] }), ['4 carbon', 'Auto']);
}

async function siteTests(root) {
  assert.equal(GEMINI_SITE.provider, 'gemini-web');
  assert.equal(GEMINI_SITE.stateDir, 'gemini');
  assert.equal(GEMINI_SITE.workerId('web'), 'gemini-normal');
  assert.equal(GEMINI_SITE.workerId('google-media-2-479f'), 'gemini-google-media-2-479f');
  assert.equal(GEMINI_SITE.conversationUrl('a8ad685522c4ae0e'), 'https://gemini.google.com/app/a8ad685522c4ae0e');
  assert.equal('https://gemini.google.com/app/a8ad685522c4ae0e'.match(GEMINI_SITE.page.conversationPattern)[1], 'a8ad685522c4ae0e');
  assert.equal('https://gemini.google.com/u/1/app/a8ad685522c4ae0e'.match(GEMINI_SITE.page.conversationPattern)[1], 'a8ad685522c4ae0e');
  assert.equal('https://gemini.google.com/app'.match(GEMINI_SITE.page.conversationPattern), null);
  for (const host of ['gemini.google.com', 'accounts.google.com']) assert.ok(GEMINI_SITE.hosts.has(host), host);
  for (const host of ['evilgemini.google.com.example', 'chatgpt.com', 'flow.google.com']) assert.ok(!GEMINI_SITE.hosts.has(host), host);
  assert.ok(GEMINI_SITE.promptRules.some(rule => /Canvas/.test(rule)));

  // Each Gemini account is a Google Media account, in that account's own
  // partition (the same names the media engine uses).
  assert.equal(mediaProfileId('web'), 'google');
  assert.equal(mediaProfileId('google-media-2-479f'), 'google-media-2-479f');
  assert.equal(geminiPartition('web'), 'persist:teamyra-google-media-profile');
  for (const id of ['web', 'google-media-2-479f', 'google-media-4-4f72']) {
    assert.equal(geminiPartition(id), mediaPartition(mediaProfileId(id)), id);
  }

  // The session is used as it is: no handlers or listeners are installed.
  const manager = GEMINI_SITE.sessionManager('web');
  assert.ok(manager instanceof GeminiSessionManager);
  manager.initialize();
  assert.deepEqual(fromPartitionCalls.at(-1), ['persist:teamyra-google-media-profile', { cache: true }]);
  assert.deepEqual(await manager.cookieSummary(), { count: 2, hasSessionCookies: true });
  assert.deepEqual(await GEMINI_SITE.sessionManager('google-media-3-3207').cookieSummary(), { count: 1, hasSessionCookies: false });

  // The accounts are the Google Media folders ('web' = the built-in account);
  // files next to them are not accounts.
  const profiles = path.join(root, 'profiles');
  fs.mkdirSync(path.join(profiles, 'google-media', 'google-media-2-479f'), { recursive: true });
  fs.mkdirSync(path.join(profiles, 'google-media', 'google-media-3-3207'), { recursive: true });
  fs.writeFileSync(path.join(profiles, 'google-media', 'builtin-google.json'), JSON.stringify({ enabled: true, gemini_model: '4 Neon' }));
  fs.writeFileSync(path.join(profiles, 'google-media', 'vids-workspaces.json'), '{}');
  fs.writeFileSync(path.join(profiles, 'google-media', 'google-media-3-3207', 'teamyra-profile.json'),
    JSON.stringify({ name: 'Google Media 3', gemini_model: 'Auto' }));
  assert.deepEqual(geminiProfileIds(profiles).sort(), ['google-media-2-479f', 'google-media-3-3207', 'web']);
  assert.deepEqual(geminiProfileIds(path.join(root, 'missing')), ['web']);

  // The account's model comes from its Google Media file; a job's model= first.
  let jobModel = '';
  const adapter = GEMINI_SITE.adapter({ isDestroyed: () => false }, { runtimeRoot: root, profileId: 'web', jobModel: () => jobModel });
  assert.ok(adapter instanceof GeminiAutomationAdapter && adapter instanceof ChatSiteAdapter);
  assert.deepEqual(adapter.preferredModels(), ['4 Neon', '4 Carbon', 'Auto']);
  jobModel = '4 Hydrogen';
  assert.deepEqual(adapter.preferredModels(), ['4 Hydrogen', '4 Neon', '4 Carbon', 'Auto']);
  const other = GEMINI_SITE.adapter({ isDestroyed: () => false }, { runtimeRoot: root, profileId: 'google-media-3-3207' });
  assert.deepEqual(other.preferredModels(), ['Auto', '4 Carbon', '4 Neon']);
  assert.match(GEMINI_SITE.page.settingsJs(other), /const preferred = \["Auto","4 Carbon","4 Neon"\]/);

  // Signed out is read from the page (Gemini shows a message box then too).
  adapter.drawFrame = async () => {};
  let asked = '';
  adapter.evaluate = async source => { asked = source; return { promptFound: false, loginVisible: true, challenged: false }; };
  await adapter.probe();
  assert.match(asked, /Google Account/);
  assert.match(asked, /\^sign in\$/);
  assert.match(asked, /promptFound: !!prompt && !loginVisible/);

  // The reply is read from <model-response>/<message-content>, code blocks as fences.
  adapter.evaluate = async source => { asked = source; return {}; };
  await adapter.assistantSnapshot();
  assert.ok(asked.includes("querySelectorAll('model-response')"));
  assert.ok(asked.includes('message-content-id-'));
  assert.ok(asked.includes('button[aria-label="Stop response"]'));
  assert.ok(asked.includes("tag === 'code-block'"));

  // The exact reply: the reply's Copy button, with the clipboard calls caught.
  adapter.evaluate = async source => { asked = source; return '```text\nTEAMYRA_TOOL_REQUEST {}\n```'; };
  assert.equal(await adapter.rawReplyText(''), '');
  assert.equal(await adapter.rawReplyText('r_24fa132ddcec2909'), '```text\nTEAMYRA_TOOL_REQUEST {}\n```');
  assert.ok(asked.includes('gmReplyId(node) === "r_24fa132ddcec2909"'));
  assert.ok(asked.includes('clip.write = async'));
  assert.ok(asked.includes('clip.writeText = saved.writeText'), 'the clipboard functions are put back');

  // Your message is its text lines, without the hidden "You said" label.
  adapter.evaluate = async source => { asked = source; return 'hello'; };
  await adapter.lastUserMessage();
  assert.ok(asked.includes('.query-text-line'));

  // Settings, the Quill message box, then Send.
  const sendAdapter = GEMINI_SITE.adapter({ isDestroyed: () => false }, { runtimeRoot: root, profileId: 'web' });
  sendAdapter.drawFrame = async () => {};
  const steps = [];
  sendAdapter.evaluate = async source => {
    if (source.includes('const preferred =')) { steps.push('settings'); return { mode: 'chat', model: 'on', modelName: '4 Neon' }; }
    if (source.includes("execCommand('insertText'")) { steps.push('fill'); return { ok: true }; }
    if (source.includes("return 'clicked'")) { steps.push('send'); return 'sent'; }
    return null;
  };
  const sent = await sendAdapter.sendTask('line 1\nline 2');
  assert.equal(sent.ok, true);
  assert.deepEqual(sent.settings, { mode: 'chat', model: 'on', modelName: '4 Neon' });
  assert.deepEqual(steps.filter((step, index) => step !== steps[index - 1]), ['settings', 'fill', 'send']);

  // Sign-in help points to Google Media, not to a Gemini sign-in.
  assert.match(GeminiWebProvider.prototype.userActions.sign_in.message, /Google Media/);
  assert.equal(GeminiWebProvider.prototype.userActions.sign_in.kind, 'gemini_sign_in');
}

class FakePage extends ChatSiteAdapter {
  constructor(site, replies, onSend) {
    super(null, {}, site);
    this.replies = [...replies];
    this.sent = [];
    this.onSend = onSend;
    this.current = { count: 0, text: '', messageId: '' };
  }
  async probe() { return { promptFound: true, challenged: false, loginVisible: false }; }
  async sendTask(text) {
    this.sent.push(text);
    this.onSend?.();
    this.current = { count: this.sent.length, text: this.replies.shift(), messageId: 'r_' + this.sent.length };
    return { ok: true };
  }
  async assistantSnapshot() { return { ...this.current, generating: false, challenged: false }; }
  async rawReplyText(id) { return id === this.current.messageId ? this.current.text : ''; }
  async lastUserMessage() { return this.sent.at(-1) || ''; }
  async stopGeneration() { return { ok: true }; }
}

async function jobLoopTests(root) {
  const site = GEMINI_SITE;
  const models = [];
  const provider = Object.create(GeminiWebProvider.prototype);
  const fake = new FakePage(site.page, ['```text\nTEAMYRA_TOOL_REQUEST {"tool":"git.status","args":{}}\n```', 'Clean tree.'],
    () => models.push(provider.jobModel));
  Object.assign(provider, {
    runtimeRoot: root, stateRoot: path.join(root, site.stateDir), activeProfileId: 'web', loaded: true,
    view: { webContents: { isDestroyed: () => false } }, automation: fake, replyPollMs: 1, promptWaitMs: 5, renderWaitMs: 50,
    progressIntervalMs: 1, settleRecheckMs: 1, jobScanMaxAgeMs: 0, ensureView: () => provider.view, setInteractionLocked: async () => {},
    refreshStatus: async () => ({ workerReady: true }), createConversation: async () => {}, openConversation: async () => {},
    getCurrentConversation: async () => ({ url: site.home + '/1', conversationId: '1' }),
    saveWorkerConversation: () => {}, notifyUser: () => true, toolCalls: [],
    workspaceBridge: {
      status: async () => ({ permissions: { read: true } }),
      executeInWorkspace: async (workspace, tool, args) => { provider.toolCalls.push({ tool, args }); return { ok: true }; }
    }
  });
  provider.statusFile = path.join(provider.stateRoot, 'status.json');
  fs.mkdirSync(provider.stateRoot, { recursive: true });
  const dir = path.join(root, 'jobs', 'gemini-job');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'spec.json'), JSON.stringify({ cwd: root, timeout: 60 }));
  fs.writeFileSync(path.join(dir, 'task.txt'), 'Check git');
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ provider: 'gemini-web', profile_id: 'web', state: 'waiting_for_desktop',
    created: 1, model: '4 Neon' }));
  assert.deepEqual(provider.scanJobs().waiting.map(job => path.basename(job.dir)), ['gemini-job']);
  await provider.runDelegatedJob(dir);
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
  assert.equal(meta.state, 'done', meta.last_event);
  assert.equal(meta.last_event, 'done: embedded Gemini completed');
  assert.match(fake.sent[0], /^You are Teamyra Worker — Gemini,/);
  assert.match(fake.sent[0], /fenced code block/);
  assert.deepEqual(provider.toolCalls, [{ tool: 'git.status', args: {} }]);
  assert.deepEqual(models, ['4 Neon', '4 Neon'], "the job's model is known while it runs");
  assert.equal(provider.jobModel, '', 'and forgotten after it');
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamyra-gemini-'));
  try {
    await settingsTests();
    await siteTests(root);
    await jobLoopTests(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log('Gemini web agent (Google Media sessions, model choice, page reading, job loop) tests passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
