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
const { MuseWebProvider, MUSE_SITE } = require('../src/muse-web-provider');
const { MuseAutomationAdapter } = require('../src/muse-automation-adapter');
const { ChatGPTWebProvider } = require('../src/chatgpt-web-provider');
Module._load = originalLoad;

function siteTests() {
  assert.equal(MUSE_SITE.provider, 'muse-web');
  assert.equal(MUSE_SITE.workerId('web'), 'muse-normal');
  assert.equal(MUSE_SITE.workerId('team-1a2b'), 'muse-team-1a2b');
  assert.equal(MUSE_SITE.conversationUrl('e1314c4b-a0bf-4eaa-8422-fedcdc5e4e20'), 'https://muse.ai/thread/e1314c4b-a0bf-4eaa-8422-fedcdc5e4e20');
  // Meta's account check on every load passes through all of these.
  for (const host of ['muse.ai', 'auth.muse.ai', 'www.facebook.com', 'www.instagram.com', 'auth.meta.com']) {
    assert.ok(MUSE_SITE.hosts.has(host), host + ' must stay reachable');
  }
  for (const host of ['chatgpt.com', 'evilmuse.ai', 'muse.ai.example.com']) assert.ok(!MUSE_SITE.hosts.has(host), host);
  assert.ok(MUSE_SITE.promptRules.some(rule => /Secure VM/.test(rule)), 'Muse is told not to use its cloud computer');
  // ChatGPT keeps its own site and wording.
  assert.equal(ChatGPTWebProvider.prototype.site.provider, 'chatgpt-web');
  assert.equal(ChatGPTWebProvider.prototype.userActions.sign_in.kind, 'chatgpt_sign_in');
  assert.equal(MuseWebProvider.prototype.userActions.sign_in.kind, 'muse_sign_in');
  assert.match(MuseWebProvider.prototype.userActions.sign_in.message, /^This Muse account is signed out/);
}

// Ojas tasks are written on Windows (\r\n). The text box reads them back with
// \n, so the "is the text in?" check never matched, the job failed and the
// prompt sat unsent in the box.
async function sendTests() {
  const scripts = [];
  const adapter = new MuseAutomationAdapter({ isDestroyed: () => false });
  adapter.drawFrame = async () => {};
  adapter.evaluate = async source => {
    scripts.push(source);
    return source.includes('setter.call(prompt') ? { ok: true } : 'sent';
  };
  await adapter.sendTask('line one\r\nline two\rline three');
  assert.ok(scripts[0].includes(JSON.stringify('line one\nline two\nline three')), 'typed with plain \\n');
  assert.ok(!scripts[0].includes('\\r'), 'no \\r reaches the box');

  // A box that will not take the text is a page problem the job loop recovers
  // from (reload, check delivery, resend), not a failed job.
  adapter.evaluate = async () => ({ ok: false });
  await assert.rejects(adapter.sendTask('x'), error => error.code === 'TEAMYRA_PAGE_UNRESPONSIVE');
}

async function frameTests() {
  // A background view draws no frames, so Muse's message box stayed 0 px wide
  // and Send never appeared: every page call first draws a 1x1 frame.
  const calls = [];
  const webContents = {
    isDestroyed: () => false,
    executeJavaScript: async () => { calls.push('script'); return 1; },
    debugger: { isAttached: () => calls.includes('attach'), attach: () => calls.push('attach'),
      sendCommand: async (method, params) => { calls.push(method + ':' + params.clip.width + 'x' + params.clip.height); return {}; } }
  };
  const adapter = new MuseAutomationAdapter(webContents, { timeoutMs: 1000 });
  await adapter.evaluate('1');
  await adapter.evaluate('2');
  assert.deepEqual(calls, ['attach', 'Page.captureScreenshot:1x1', 'script', 'Page.captureScreenshot:1x1', 'script']);
  // A capture that never answers does not hold up the page call.
  webContents.debugger.sendCommand = () => new Promise(() => {});
  const started = Date.now();
  assert.equal(await adapter.evaluate('3'), 1);
  assert.ok(Date.now() - started < 4500);
}

async function adapterTests() {
  const adapter = new MuseAutomationAdapter({ getURL: () => 'https://muse.ai/thread/e1314c4b-a0bf-4eaa-8422-fedcdc5e4e20', getTitle: () => 'Muse' });
  assert.deepEqual(await adapter.getCurrentConversation(), {
    url: 'https://muse.ai/thread/e1314c4b-a0bf-4eaa-8422-fedcdc5e4e20', conversationId: 'e1314c4b-a0bf-4eaa-8422-fedcdc5e4e20', title: 'Muse'
  });
  const fresh = new MuseAutomationAdapter({ getURL: () => 'https://muse.ai/thread/new', getTitle: () => 'Muse' });
  assert.equal((await fresh.getCurrentConversation()).conversationId, null, 'an unsent side chat has no id yet');

  // The reply wait: right after Send the old reply is still the newest one
  // (the new user message has not rendered); it must never be taken as the
  // answer. Then the new user message shows with no reply, then the reply.
  const snaps = [
    { count: 1, text: 'old reply', messageId: 'user-1:1', generating: false },
    { count: 1, text: 'old reply', messageId: 'user-1:1', generating: false },
    { count: 1, text: '', messageId: '', generating: true },
    { count: 2, text: 'TEAMYRA_TOOL_REQUEST {"tool":"git.status","args":{}}', messageId: 'user-2:1', generating: true },
    { count: 2, text: 'TEAMYRA_TOOL_REQUEST {"tool":"git.status","args":{}}', messageId: 'user-2:1', generating: false }
  ];
  adapter.assistantSnapshot = async () => ({ challenged: false, ...(snaps.length > 1 ? snaps.shift() : snaps[0]) });
  const reply = await adapter.waitForAssistantReply({ previousCount: 1, previousText: 'old reply', previousMessageId: 'user-1:1',
    timeoutMs: 5000, pollMs: 1 });
  assert.equal(reply.text, 'TEAMYRA_TOOL_REQUEST {"tool":"git.status","args":{}}');
  assert.deepEqual(adapter.parseToolRequest(reply.text), { tool: 'git.status', args: {} });
}

// DOM-free Muse page: each message gets one scripted reply.
class FakeMuse extends MuseAutomationAdapter {
  constructor(replies) {
    super(null);
    this.replies = [...replies];
    this.sent = [];
    this.current = { count: 0, text: '', messageId: '' };
  }
  async probe() { return { promptFound: true, challenged: false, loginVisible: false }; }
  async sendTask(text) {
    this.sent.push(text);
    const turn = this.sent.length;
    this.current = { count: turn, text: this.replies.shift(), messageId: 'user-' + turn + ':1' };
    return { ok: true };
  }
  async assistantSnapshot() { return { ...this.current, generating: false, challenged: false }; }
  async lastUserMessage() { return this.sent.at(-1) || ''; }
  async stopGeneration() { return { ok: true }; }
}

async function jobLoopTests(root) {
  const fake = new FakeMuse(['TEAMYRA_TOOL_REQUEST {"tool":"filesystem.list","args":{"path":"."}}', 'The workspace has 3 entries.']);
  const provider = Object.create(MuseWebProvider.prototype);
  Object.assign(provider, {
    runtimeRoot: root, stateRoot: path.join(root, 'muse'), activeProfileId: 'web', loaded: true,
    view: { webContents: { isDestroyed: () => false } }, automation: fake, replyPollMs: 1, promptWaitMs: 5, renderWaitMs: 50,
    progressIntervalMs: 1, ensureView: () => provider.view, setInteractionLocked: async () => {},
    refreshStatus: async () => ({ workerReady: true }), createConversation: async () => {}, openConversation: async () => {},
    getCurrentConversation: async () => ({ url: 'https://muse.ai/thread/11111111-2222-3333-4444-555555555555', conversationId: '11111111-2222-3333-4444-555555555555' }),
    saveWorkerConversation: () => {}, notifyUser: () => true, toolCalls: [],
    workspaceBridge: {
      status: async () => ({ permissions: { read: true, write: true } }),
      executeInWorkspace: async (workspace, tool, args) => { provider.toolCalls.push({ tool, args }); return { ok: true, items: ['a', 'b', 'c'] }; }
    }
  });
  provider.statusFile = path.join(provider.stateRoot, 'status.json');
  fs.mkdirSync(provider.stateRoot, { recursive: true });
  const jobDir = (id, jobProvider) => {
    const dir = path.join(root, 'jobs', id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'spec.json'), JSON.stringify({ cwd: root, timeout: 60 }));
    fs.writeFileSync(path.join(dir, 'task.txt'), 'Count the workspace entries');
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ provider: jobProvider, profile_id: 'web', state: 'waiting_for_desktop', created: 1 }));
    return dir;
  };
  const muse = jobDir('muse-job', 'muse-web');
  jobDir('chatgpt-job', 'chatgpt-web');
  const scan = provider.scanJobs();
  assert.deepEqual(scan.waiting.map(job => path.basename(job.dir)), ['muse-job'], 'a Muse worker takes only Muse jobs');

  await provider.runDelegatedJob(muse);
  const meta = JSON.parse(fs.readFileSync(path.join(muse, 'meta.json'), 'utf8'));
  assert.equal(meta.state, 'done', meta.last_event);
  assert.equal(meta.last_event, 'done: embedded Muse completed');
  assert.equal(fs.readFileSync(path.join(muse, 'final.txt'), 'utf8'), 'The workspace has 3 entries.');
  assert.deepEqual(provider.toolCalls, [{ tool: 'filesystem.list', args: { path: '.' } }]);
  assert.match(fake.sent[0], /^You are Teamyra Worker — Muse,/);
  assert.match(fake.sent[0], /not in your cloud computer/);
  assert.ok(fake.sent[1].startsWith('TEAMYRA_TOOL_RESULT {"tool":"filesystem.list"'));
  assert.ok(dispatchCalls.includes('scheduler.dispatch'), 'a finished job lets the queue move on');
}

// Several tabs (lanes) of one account run that account's jobs at once, each
// job in exactly one tab.
async function laneTests(root) {
  const makeTab = lane => {
    const fake = new FakeMuse(['Done one.', 'Done two.', 'Done three.']);
    const tab = Object.create(MuseWebProvider.prototype);
    Object.assign(tab, {
      lane, laneCount: 2, runtimeRoot: root, stateRoot: path.join(root, 'muse'), activeProfileId: 'web', loaded: true,
      view: { webContents: { isDestroyed: () => false } }, automation: fake, replyPollMs: 1, promptWaitMs: 5, renderWaitMs: 50,
      progressIntervalMs: 1, ensureView: () => tab.view, setInteractionLocked: async () => {}, scheduleUnload: () => {},
      refreshStatus: async () => { await new Promise(resolve => setTimeout(resolve, 5)); return { workerReady: true }; },
      createConversation: async () => {}, openConversation: async () => {},
      getCurrentConversation: async () => ({ url: 'https://muse.ai/thread/' + lane, conversationId: String(lane) }),
      saveWorkerConversation: () => {}, notifyUser: () => true,
      workspaceBridge: { status: async () => ({ permissions: { read: true } }), executeInWorkspace: async () => ({ ok: true }) }
    });
    tab.statusFile = path.join(tab.stateRoot, 'status.json');
    return { tab, fake };
  };
  fs.mkdirSync(path.join(root, 'muse'), { recursive: true });
  const job = (id, task) => {
    const dir = path.join(root, 'jobs', id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'spec.json'), JSON.stringify({ cwd: root, timeout: 60 }));
    fs.writeFileSync(path.join(dir, 'task.txt'), task);
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ provider: 'muse-web', profile_id: 'web', state: 'waiting_for_desktop', created: Date.now() }));
    return dir;
  };
  const read = dir => JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
  const first = makeTab(0);
  const second = makeTab(1);
  const a = job('lane-a', 'task A');
  const b = job('lane-b', 'task B');
  await Promise.all([first.tab.processPendingJobsOnce(), second.tab.processPendingJobsOnce()]);
  assert.equal(read(a).state, 'done');
  assert.equal(read(b).state, 'done');
  const ran = [first, second].map(({ fake }) => fake.sent.map(text => /task ([AB])$/.exec(text)?.[1]).filter(Boolean));
  assert.deepEqual(ran.flat().sort(), ['A', 'B'], 'each job ran once');
  assert.ok(ran[0].length === 1 && ran[1].length === 1, 'the two tabs ran one job each, at the same time');

  // One waiting job and two free tabs: only one tab runs it.
  const c = job('lane-c', 'task C');
  await Promise.all([first.tab.processPendingJobsOnce(), second.tab.processPendingJobsOnce()]);
  assert.equal(read(c).state, 'done');
  const runs = [first, second].map(({ fake }) => fake.sent.filter(text => /task C$/.test(text)).length);
  assert.deepEqual(runs.sort(), [0, 1]);
  // Only the first tab writes the account's status (with its tab count).
  second.tab.writeStatus({ detail: 'from tab 2' });
  assert.ok(!fs.existsSync(second.tab.statusFile) || !/from tab 2/.test(fs.readFileSync(second.tab.statusFile, 'utf8')));
  first.tab.writeStatus({ detail: 'from tab 1' });
  assert.equal(JSON.parse(fs.readFileSync(first.tab.statusFile, 'utf8')).profiles.web.lanes, 2);
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamyra-muse-'));
  try {
    siteTests();
    await frameTests();
    await sendTests();
    await adapterTests();
    await jobLoopTests(root);
    await laneTests(fs.mkdtempSync(path.join(os.tmpdir(), 'teamyra-muse-lanes-')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log('muse web agent site, reply detection and job loop tests passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
