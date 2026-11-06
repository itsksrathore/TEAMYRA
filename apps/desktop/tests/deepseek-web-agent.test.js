const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

// No Electron or TEAMYRA Core in tests.
const dispatchCalls = [];
const originalLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'electron') return { WebContentsView: class {}, Notification: null, session: {} };
  if (request === './core-api') return { callCore: action => { dispatchCalls.push(action); return Promise.resolve({}); } };
  return originalLoad.call(this, request, ...rest);
};
const { DeepSeekWebProvider, DEEPSEEK_SITE } = require('../src/deepseek-web-provider');
const { DeepSeekAutomationAdapter } = require('../src/deepseek-automation-adapter');
Module._load = originalLoad;

function siteTests() {
  assert.equal(DEEPSEEK_SITE.provider, 'deepseek-web');
  assert.equal(DEEPSEEK_SITE.workerId('web'), 'deepseek-normal');
  assert.equal(DEEPSEEK_SITE.workerId('ds-2-ab12'), 'deepseek-ds-2-ab12');
  assert.equal(DEEPSEEK_SITE.conversationUrl('ac38c89e-6e17-4580-b1d0-e32a0ad2843f'),
    'https://chat.deepseek.com/a/chat/s/ac38c89e-6e17-4580-b1d0-e32a0ad2843f');
  for (const host of ['chat.deepseek.com', 'cdn.deepseek.com', 'abc.token.awswaf.com', 'accounts.google.com']) {
    assert.ok(DEEPSEEK_SITE.hosts.has(host), host + ' must stay reachable');
  }
  for (const host of ['chatgpt.com', 'evildeepseek.com', 'deepseek.com.example.org']) assert.ok(!DEEPSEEK_SITE.hosts.has(host), host);
  // Its only token-like cookie is AWS's human check, so the page decides.
  assert.equal(DEEPSEEK_SITE.sessionFromPage, true);
  assert.ok(DEEPSEEK_SITE.promptRules.some(rule => /reference:N/.test(rule)));
  assert.equal(DeepSeekWebProvider.prototype.userActions.sign_in.kind, 'deepseek_sign_in');
}

async function adapterTests() {
  const adapter = new DeepSeekAutomationAdapter({
    getURL: () => 'https://chat.deepseek.com/a/chat/s/ac38c89e-6e17-4580-b1d0-e32a0ad2843f', getTitle: () => 'DeepSeek', isDestroyed: () => false
  });
  adapter.drawFrame = async () => {};
  assert.equal((await adapter.getCurrentConversation()).conversationId, 'ac38c89e-6e17-4580-b1d0-e32a0ad2843f');

  // Sending: DeepThink and Search are switched on first, the task goes in
  // with plain \n, and "sent" means the box emptied.
  const scripts = [];
  adapter.evaluate = async source => {
    scripts.push(source);
    if (source.includes('ds-toggle-button')) return { think: 'on', search: 'on' };
    return source.includes('setter.call(prompt') ? { ok: true } : 'sent';
  };
  const sent = await adapter.sendTask('one\r\ntwo');
  assert.deepEqual(sent.modes, { think: 'on', search: 'on' });
  assert.ok(scripts.findIndex(item => item.includes('ds-toggle-button')) < scripts.findIndex(item => item.includes('setter.call(prompt')));
  assert.ok(scripts.some(item => item.includes(JSON.stringify('one\ntwo'))));
  adapter.evaluate = async source => source.includes('ds-toggle-button') ? {} : { ok: false };
  await assert.rejects(adapter.sendTask('x'), error => error.code === 'TEAMYRA_PAGE_UNRESPONSIVE');

  // The exact reply is read by message id; no id, no read.
  let asked = '';
  adapter.evaluate = async source => { asked = source; return 'TEAMYRA_TOOL_REQUEST {}'; };
  assert.equal(await adapter.rawReplyText(''), '');
  assert.equal(asked, '');
  assert.equal(await adapter.rawReplyText('4'), 'TEAMYRA_TOOL_REQUEST {}');
  assert.match(asked, /item\.message_id === 4 && item\.role === 'ASSISTANT'/);
  assert.match(asked, /status !== 'FINISHED'/);

  assert.ok(adapter.isTransientReply('The server is busy. Please try again later.'));
  assert.ok(adapter.isTransientReply('服务器繁忙，请稍后再试。'));
  assert.ok(!adapter.isTransientReply('The server is busy today, so I used a cache.'));
}

// DOM-free DeepSeek page: each message gets one scripted reply. The page
// text is rendered Markdown; rawReplyText gives the reply as written.
class FakeDeepSeek extends DeepSeekAutomationAdapter {
  constructor(replies) {
    super(null);
    this.replies = [...replies];
    this.sent = [];
    this.current = { count: 0, text: '', messageId: '', raw: '' };
  }
  async probe() { return { promptFound: true, challenged: false, loginVisible: false }; }
  async sendTask(text) {
    this.sent.push(text);
    const next = this.replies.shift();
    const turn = this.sent.length;
    this.current = typeof next === 'string'
      ? { count: turn, text: next, raw: next, messageId: String(turn * 2) }
      : { count: turn, text: next.page, raw: next.raw, messageId: String(turn * 2) };
    return { ok: true };
  }
  async assistantSnapshot() {
    const { raw, ...snap } = this.current;
    return { ...snap, generating: false, challenged: false };
  }
  async rawReplyText(messageId) { return messageId === this.current.messageId ? this.current.raw : ''; }
  async lastUserMessage() { return this.sent.at(-1) || ''; }
  async stopGeneration() { return { ok: true }; }
}

async function jobLoopTests(root) {
  const request = 'TEAMYRA_TOOL_REQUEST {"tool":"filesystem.write","args":{"path":"a.txt","content":"x = \\"a\\\\\\\\b\\""}}';
  const fake = new FakeDeepSeek([
    'The server is busy. Please try again later.',
    // Rendered Markdown dropped a backslash; the reply as written has both.
    { page: request.replace(/\\\\\\\\/g, '\\\\'), raw: request },
    'Wrote a.txt.'
  ]);
  const provider = Object.create(DeepSeekWebProvider.prototype);
  Object.assign(provider, {
    runtimeRoot: root, stateRoot: path.join(root, 'deepseek'), activeProfileId: 'web', loaded: true,
    view: { webContents: { isDestroyed: () => false } }, automation: fake, replyPollMs: 1, promptWaitMs: 5, renderWaitMs: 50,
    progressIntervalMs: 1, settleRecheckMs: 1, transientRetryMs: 1, jobScanMaxAgeMs: 0,
    ensureView: () => provider.view, setInteractionLocked: async () => {},
    refreshStatus: async () => ({ workerReady: true }), createConversation: async () => {}, openConversation: async () => {},
    getCurrentConversation: async () => ({ url: 'https://chat.deepseek.com/a/chat/s/11111111-2222-3333-4444-555555555555', conversationId: '11111111-2222-3333-4444-555555555555' }),
    saveWorkerConversation: () => {}, notifyUser: () => true, toolCalls: [],
    workspaceBridge: {
      status: async () => ({ permissions: { read: true, write: true } }),
      executeInWorkspace: async (workspace, tool, args) => { provider.toolCalls.push({ tool, args }); return { ok: true }; }
    }
  });
  provider.statusFile = path.join(provider.stateRoot, 'status.json');
  fs.mkdirSync(provider.stateRoot, { recursive: true });
  const dir = path.join(root, 'jobs', 'deepseek-job');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'spec.json'), JSON.stringify({ cwd: root, timeout: 60 }));
  fs.writeFileSync(path.join(dir, 'task.txt'), 'Write a.txt');
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ provider: 'deepseek-web', profile_id: 'web', state: 'waiting_for_desktop', created: 1 }));
  const other = path.join(root, 'jobs', 'muse-job');
  fs.mkdirSync(other, { recursive: true });
  fs.writeFileSync(path.join(other, 'meta.json'), JSON.stringify({ provider: 'muse-web', profile_id: 'web', state: 'waiting_for_desktop', created: 1 }));
  assert.deepEqual(provider.scanJobs().waiting.map(job => path.basename(job.dir)), ['deepseek-job'], 'a DeepSeek worker takes only DeepSeek jobs');

  await provider.runDelegatedJob(dir);
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
  assert.equal(meta.state, 'done', meta.last_event);
  assert.equal(meta.last_event, 'done: embedded DeepSeek completed');
  assert.match(fake.sent[0], /^You are Teamyra Worker — DeepSeek,/);
  assert.equal(fake.sent[1], 'Please answer my previous message again.', 'a busy reply is asked again');
  assert.deepEqual(provider.toolCalls, [{ tool: 'filesystem.write', args: { path: 'a.txt', content: 'x = "a\\\\b"' } }]);
  assert.ok(dispatchCalls.includes('scheduler.dispatch'));

  // "Signed in" comes from what the page showed, not from cookies.
  fs.writeFileSync(provider.statusFile, JSON.stringify({ profiles: { web: { session_present: true }, other: { session_present: false } } }));
  assert.equal((await provider.profileSessionStatus('web')).signedIn, true);
  assert.equal((await provider.profileSessionStatus('other')).signedIn, false);
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamyra-deepseek-'));
  try {
    siteTests();
    await adapterTests();
    await jobLoopTests(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log('deepseek web agent site, send, exact reply, busy retry and job loop tests passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
