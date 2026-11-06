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

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamyra-chat-sites-'));
  try {
    const adapter = qwenSiteTests();
    await adapterTests(adapter);
    await jobLoopTests(root, QwenWebProvider, QWEN_SITE, 'qwen-web');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log('chat site (Qwen) settings, send, exact reply and job loop tests passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
