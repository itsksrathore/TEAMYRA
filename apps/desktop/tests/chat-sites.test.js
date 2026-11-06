const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

// Sites driven by the settings-based page driver (chat-site-adapter.js).
const dispatchCalls = [];
const originalLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'electron') return { WebContentsView: class {}, Notification: null, session: {} };
  if (request === './core-api') return { callCore: action => { dispatchCalls.push(action); return Promise.resolve({}); } };
  return originalLoad.call(this, request, ...rest);
};
const { QwenWebProvider, QWEN_SITE } = require('../src/qwen-web-provider');
const { ChatSiteAdapter } = require('../src/chat-site-adapter');
const { googleSignInHost } = require('../src/chatgpt-web-provider');
const { MuseAutomationAdapter } = require('../src/muse-automation-adapter');
const { GrokWebProvider, GROK_SITE, GROK_BUSY_PREFIX } = require('../src/grok-web-provider');
Module._load = originalLoad;

function qwenSiteTests() {
  assert.equal(QWEN_SITE.provider, 'qwen-web');
  assert.equal(QWEN_SITE.workerId('web'), 'qwen-normal');
  assert.equal(QWEN_SITE.workerId('q2'), 'qwen-q2');
  assert.equal(QWEN_SITE.conversationUrl('c97d913d-fb2c-4c58-b39d-0102645addd9'), 'https://chat.qwen.ai/c/c97d913d-fb2c-4c58-b39d-0102645addd9');
  for (const host of ['chat.qwen.ai', 'auth.qwen.ai', 'sg-member.qwen.com', 'g.alicdn.com', 'static-captcha-sgp.aliyuncs.com', 'accounts.google.com']) {
    assert.ok(QWEN_SITE.hosts.has(host), host);
  }
  for (const host of ['chatgpt.com', 'evilqwen.ai', 'qwen.ai.example.com']) assert.ok(!QWEN_SITE.hosts.has(host), host);
  assert.equal(QWEN_SITE.sessionFromPage, true);
  // The best model is the one Qwen calls its flagship (else the newest Max),
  // and thinking is set to Thinking.
  assert.match(QWEN_SITE.page.settingsJs, /flagship/);
  assert.match(QWEN_SITE.page.settingsJs, /-Max/);
  assert.match(QWEN_SITE.page.settingsJs, /'Thinking'/);
  assert.equal(QwenWebProvider.prototype.userActions.sign_in.kind, 'qwen_sign_in');
  const adapter = QWEN_SITE.adapter({ getURL: () => 'https://chat.qwen.ai/c/c97d913d-fb2c-4c58-b39d-0102645addd9', getTitle: () => 'Qwen' }, {});
  assert.ok(adapter instanceof ChatSiteAdapter);
  assert.equal(adapter.siteName, 'Qwen');
  return adapter;
}

async function adapterTests(adapter) {
  assert.equal((await adapter.getCurrentConversation()).conversationId, 'c97d913d-fb2c-4c58-b39d-0102645addd9');
  adapter.drawFrame = async () => {};
  // Settings first (two passes when one did not take), then the text with
  // plain \n, then Send until the box is empty.
  const scripts = [];
  let settingsRuns = 0;
  adapter.evaluate = async source => {
    scripts.push(source);
    if (source === QWEN_SITE.page.settingsJs) {
      settingsRuns += 1;
      return settingsRuns === 1 ? { model: 'missing', thinking: 'on' } : { model: 'on', thinking: 'on' };
    }
    if (source.includes('setter.call(prompt')) return { ok: true };
    return 'sent';
  };
  const sent = await adapter.sendTask('a\r\nb');
  assert.equal(settingsRuns, 2);
  assert.deepEqual(sent.settings, { model: 'on', thinking: 'on' });
  assert.ok(scripts.some(source => source.includes(JSON.stringify('a\nb'))));
  adapter.evaluate = async source => source === QWEN_SITE.page.settingsJs ? { model: 'on', thinking: 'on' } : { ok: false };
  await assert.rejects(adapter.sendTask('x'), error => error.code === 'TEAMYRA_PAGE_UNRESPONSIVE');

  // The exact reply comes from Qwen's chat data, by reply id.
  let asked = '';
  adapter.evaluate = async source => { asked = source; return 'exact'; };
  assert.equal(await adapter.rawReplyText(''), '');
  assert.equal(await adapter.rawReplyText('e3f95ca4-311e-4ef9-b21a-5f8b3dac8f49'), 'exact');
  assert.match(asked, /messages\["e3f95ca4-311e-4ef9-b21a-5f8b3dac8f49"\]/);
  assert.match(asked, /part\.phase === 'answer'/);

  // The snapshot script reads the answer only and the reply id.
  adapter.evaluate = async source => { asked = source; return {}; };
  await adapter.assistantSnapshot();
  assert.ok(asked.includes('.response-message-content.phase-answer'));
  assert.ok(asked.includes('chat-response-message-'));
  assert.ok(asked.includes('button.stop-button'));
}

class FakePage extends ChatSiteAdapter {
  constructor(site, replies) {
    super(null, {}, site);
    this.replies = [...replies];
    this.sent = [];
    this.current = { count: 0, text: '', messageId: '', raw: '' };
  }
  async probe() { return { promptFound: true, challenged: false, loginVisible: false }; }
  async sendTask(text) {
    this.sent.push(text);
    const next = this.replies.shift();
    this.current = { count: this.sent.length, text: next, raw: next, messageId: 'r' + this.sent.length };
    return { ok: true };
  }
  async assistantSnapshot() {
    const { raw, ...snap } = this.current;
    return { ...snap, generating: false, challenged: false };
  }
  async rawReplyText(id) { return id === this.current.messageId ? this.current.raw : ''; }
  async lastUserMessage() { return this.sent.at(-1) || ''; }
  async stopGeneration() { return { ok: true }; }
}

async function jobLoopTests(root, Provider, site, providerId) {
  const fake = new FakePage(site.page, ['TEAMYRA_TOOL_REQUEST {"tool":"git.status","args":{}}', 'Clean tree.']);
  const provider = Object.create(Provider.prototype);
  Object.assign(provider, {
    runtimeRoot: root, stateRoot: path.join(root, site.stateDir), activeProfileId: 'web', loaded: true,
    view: { webContents: { isDestroyed: () => false } }, automation: fake, replyPollMs: 1, promptWaitMs: 5, renderWaitMs: 50,
    progressIntervalMs: 1, settleRecheckMs: 1, jobScanMaxAgeMs: 0, ensureView: () => provider.view, setInteractionLocked: async () => {},
    refreshStatus: async () => ({ workerReady: true }), createConversation: async () => {}, openConversation: async () => {},
    getCurrentConversation: async () => ({ url: site.home + 'c/1', conversationId: '1' }),
    saveWorkerConversation: () => {}, notifyUser: () => true, toolCalls: [],
    workspaceBridge: {
      status: async () => ({ permissions: { read: true } }),
      executeInWorkspace: async (workspace, tool, args) => { provider.toolCalls.push({ tool, args }); return { ok: true }; }
    }
  });
  provider.statusFile = path.join(provider.stateRoot, 'status.json');
  fs.mkdirSync(provider.stateRoot, { recursive: true });
  const dir = path.join(root, 'jobs', providerId + '-job');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'spec.json'), JSON.stringify({ cwd: root, timeout: 60 }));
  fs.writeFileSync(path.join(dir, 'task.txt'), 'Check git');
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ provider: providerId, profile_id: 'web', state: 'waiting_for_desktop', created: 1 }));
  assert.deepEqual(provider.scanJobs().waiting.map(job => path.basename(job.dir)), [providerId + '-job']);
  await provider.runDelegatedJob(dir);
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
  assert.equal(meta.state, 'done', meta.last_event);
  assert.equal(meta.last_event, `done: embedded ${site.name} completed`);
  assert.match(fake.sent[0], new RegExp(`^You are Teamyra Worker — ${site.name},`));
  assert.deepEqual(provider.toolCalls, [{ tool: 'git.status', args: {} }]);
}

async function grokTests(root) {
  assert.equal(GROK_SITE.provider, 'grok-web');
  assert.equal(GROK_SITE.workerId('web'), 'grok-normal');
  for (const host of ['grok.com', 'accounts.x.ai', 'x.com', 'accounts.google.com']) assert.ok(GROK_SITE.hosts.has(host), host);
  assert.ok(!GROK_SITE.hosts.has('evilgrok.com'));
  // Grok's login cookies are sso / sso-rw.
  const manager = GROK_SITE.sessionManager('web');
  assert.ok(manager.sessionCookie.test('sso') && manager.sessionCookie.test('sso-rw') && !manager.sessionCookie.test('session'));

  // Build mode: the menu is opened with a real click, then Build is picked.
  const adapter = GROK_SITE.adapter({ isDestroyed: () => false }, {});
  adapter.drawFrame = async () => {};
  const clicks = [];
  adapter.trustedClick = async (x, y) => { clicks.push([x, y]); };
  let label = 'Model: Fast';
  adapter.evaluate = async source => {
    if (source.includes('getBoundingClientRect')) return { found: true, label, x: 10, y: 20 };
    if (source.includes("[role=menu] [role^=menuitem]")) { label = 'Model: Build'; return true; }
    return label;
  };
  assert.deepEqual(await adapter.ensureSettings(), { mode: 'on' });
  assert.deepEqual(clicks, [[10, 20]]);
  assert.deepEqual(await adapter.ensureSettings(), { mode: 'on' }, 'already on: no click');
  assert.equal(clicks.length, 1);

  // An empty reply whose data holds a server error is a busy reply.
  adapter.evaluate = async source => source.includes('streamErrors')
    ? 'Service temporarily unavailable. Please try again later.'
    : { count: 1, text: '', messageId: 'r1', generating: false, challenged: false };
  const snap = await adapter.assistantSnapshot();
  assert.equal(snap.text, GROK_BUSY_PREFIX + 'Service temporarily unavailable. Please try again later.');
  assert.ok(adapter.isTransientReply(snap.text));
  assert.ok(!adapter.isTransientReply('TEAMYRA_TOOL_REQUEST {}'));

  // The "You" label before a user message is not part of it.
  let asked = '';
  adapter.evaluate = async source => { asked = source; return ''; };
  await adapter.lastUserMessage();
  assert.ok(asked.includes('const prefix = "You"'));

  await jobLoopTests(root, GrokWebProvider, GROK_SITE, 'grok-web');
}

async function signInAndFrameTests() {
  // "Sign in with Google" passes through Google's country domain and
  // accounts.youtube.com; blocking them left DeepSeek's sign-in stuck.
  for (const host of ['accounts.google.com', 'accounts.google.co.in', 'accounts.google.de', 'accounts.youtube.com']) {
    assert.ok(googleSignInHost(host), host);
  }
  for (const host of ['accounts.google.com.evil.com', 'google.com', 'evil-accounts.google.com', 'youtube.com']) {
    assert.ok(!googleSignInHost(host), host);
  }
  // A view the user is looking at draws its own frames: no capture there.
  let captures = 0;
  const contents = { isDestroyed: () => false, debugger: { isAttached: () => true, sendCommand: async () => { captures += 1; } } };
  let shown = true;
  const adapter = new MuseAutomationAdapter(contents, { isVisible: () => shown });
  await adapter.drawFrame();
  assert.equal(captures, 0);
  shown = false;
  await adapter.drawFrame();
  assert.equal(captures, 1);
}

// Qwen's captcha came back again and again: TEAMYRA reloaded the page about
// once a minute while it was not ready, and every reload brought a check.
async function reloadRuleTests(root) {
  const provider = Object.create(QwenWebProvider.prototype);
  let reloads = 0;
  Object.assign(provider, {
    statusFile: path.join(root, 'qwen-status.json'), activeProfileId: 'web', notReadyHealMs: 0, healIntervalMs: 0, reloadIntervalMs: 0,
    reconnect: async () => { reloads += 1; }, refreshStatus: async () => ({ workerReady: false })
  });
  provider.visible = true;
  await provider.healNotReady({ workerReady: false });
  assert.equal(reloads, 0, 'a page the user is looking at is never reloaded');
  provider.visible = false;
  for (let attempt = 0; attempt < 6; attempt += 1) await provider.healNotReady({ workerReady: false });
  assert.equal(reloads, 3, 'at most three reloads in a row');
  const stopped = await provider.healNotReady({ workerReady: false });
  assert.match(stopped.detail, /did not become usable after 3 reloads/);

  // Between reloads at least a minute passes (the page may just be slow).
  provider.heals = 0;
  provider.reloadIntervalMs = 60000;
  provider.lastReloadAt = 0;
  reloads = 0;
  await provider.healNotReady({ workerReady: false });
  await provider.healNotReady({ workerReady: false });
  assert.equal(reloads, 1, 'one reload a minute');
  provider.reloadIntervalMs = 0;

  // Extra tabs wait until the account's first tab has a usable page.
  fs.writeFileSync(provider.statusFile, JSON.stringify({ profiles: { web: { automation_ready: false, heartbeat_at: Date.now() / 1000 } } }));
  assert.equal(provider.accountReady(), false);
  fs.writeFileSync(provider.statusFile, JSON.stringify({ profiles: { web: { automation_ready: true, heartbeat_at: Date.now() / 1000 } } }));
  assert.equal(provider.accountReady(), true);
  fs.writeFileSync(provider.statusFile, JSON.stringify({ profiles: { web: { automation_ready: true, heartbeat_at: Date.now() / 1000 - 600 } } }));
  assert.equal(provider.accountReady(), false, 'an old report does not count');
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamyra-chat-sites-'));
  try {
    const adapter = qwenSiteTests();
    await adapterTests(adapter);
    await jobLoopTests(root, QwenWebProvider, QWEN_SITE, 'qwen-web');
    await grokTests(root);
    await signInAndFrameTests();
    await reloadRuleTests(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log('chat site (Qwen, Grok) settings, send, exact reply, busy and job loop tests passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
