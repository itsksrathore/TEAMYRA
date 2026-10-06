const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ChatGPTWebProvider } = require('../src/chatgpt-web-provider');
const { ChatGPTAutomationAdapter } = require('../src/chatgpt-automation-adapter');

// DOM-free fake of the embedded ChatGPT page. Each sendTask() consumes one
// scripted reply: a string, or { text, generating, challenge: { snaps, probes, lose } }.
class FakeChat extends ChatGPTAutomationAdapter {
  constructor(script) {
    super(null);
    this.script = [...script];
    this.sent = [];
    this.users = [];
    this.turn = 0;
    this.current = { count: 0, text: '', messageId: '' };
    this.pending = null;
    this.genTicks = 0;
    this.challengeSnaps = 0;
    this.challengeProbes = 0;
  }

  async probe() {
    if (this.challengeProbes > 0) {
      this.challengeProbes -= 1;
      return { promptFound: false, challenged: true, loginVisible: false };
    }
    return { promptFound: true, challenged: false, loginVisible: false };
  }

  async sendTask(text) {
    this.sent.push(text);
    this.users.push(text);
    const item = this.script.shift();
    this.pending = typeof item === 'string' ? { text: item } : { ...item };
    if (this.pending.challenge) {
      this.challengeSnaps = this.pending.challenge.snaps ?? 1;
      this.challengeProbes = this.pending.challenge.probes ?? 2;
      if (this.pending.challenge.lose) {
        this.users.pop();
        this.pending = null;
      }
    }
    return { ok: true };
  }

  async assistantSnapshot() {
    if (this.challengeSnaps > 0) {
      this.challengeSnaps -= 1;
      return { ...this.current, generating: false, challenged: true };
    }
    if (this.pending) {
      this.turn += 1;
      this.current = { count: this.turn, text: this.pending.text, messageId: 'turn-' + this.turn };
      this.genTicks = this.pending.generating || 0;
      this.pending = null;
    }
    if (this.genTicks > 0) {
      this.genTicks -= 1;
      return { ...this.current, generating: true, challenged: false };
    }
    return { ...this.current, generating: false, challenged: false };
  }

  async lastUserMessage() { return this.users.at(-1) || ''; }
  async stopGeneration() { return { ok: true }; }
}

let root;
let seq = 0;

function makeProvider(fake, { permissions } = {}) {
  const provider = Object.create(ChatGPTWebProvider.prototype);
  provider.runtimeRoot = root;
  provider.stateRoot = path.join(root, 'chatgpt');
  provider.workerConversationFile = path.join(provider.stateRoot, 'worker-conversation.json');
  provider.activeProfileId = 'web';
  provider.loaded = true;
  provider.view = { webContents: { isDestroyed: () => false } };
  provider.automation = fake;
  provider.replyPollMs = 1;
  provider.challengePollMs = 1;
  provider.resumePollMs = 1;
  provider.progressIntervalMs = 1;
  provider.ensureView = () => provider.view;
  provider.setInteractionLocked = async () => {};
  provider.refreshStatus = async () => ({ workerReady: true });
  provider.createConversation = async () => {};
  provider.opened = [];
  provider.openConversation = async url => { provider.opened.push(url); };
  provider.conversation = { url: 'https://chatgpt.com/c/conv1', conversationId: 'conv1' };
  provider.getCurrentConversation = async () => provider.conversation;
  provider.saveWorkerConversation = () => {};
  provider.notes = [];
  provider.notifyUser = title => { provider.notes.push(title); return true; };
  provider.toolCalls = [];
  provider.workspaceBridge = {
    status: async () => ({ permissions: permissions || { read: true, write: true } }),
    executeInWorkspace: async (workspace, tool, args, perms) => {
      provider.toolCalls.push({ workspace, tool, args, perms });
      return { ok: true, tool };
    }
  };
  provider.metaHistory = [];
  const writeJobMeta = ChatGPTWebProvider.prototype.writeJobMeta;
  provider.writeJobMeta = function (dir, patch) {
    this.metaHistory.push({ ...patch });
    return writeJobMeta.call(this, dir, patch);
  };
  return provider;
}

function makeJob(spec = {}, meta = {}) {
  const dir = path.join(root, 'jobs', 'job-' + (++seq));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'spec.json'), JSON.stringify({ cwd: root, timeout: 60, ...spec }));
  fs.writeFileSync(path.join(dir, 'task.txt'), 'Do the thing');
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({
    provider: 'chatgpt-web', profile_id: 'web', state: 'waiting_for_desktop', created: seq, ...meta
  }));
  return dir;
}

const readMeta = dir => JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));

async function testHappyPathWithWindowsPath() {
  const fake = new FakeChat([
    { text: 'Reading it.\nTEAMYRA_TOOL_REQUEST {"tool":"filesystem.read","args":{"path":"D:\\new\\a.txt"}}', generating: 3 },
    'Finished: all good.'
  ]);
  const provider = makeProvider(fake);
  const dir = makeJob();
  await provider.runDelegatedJob(dir);
  const meta = readMeta(dir);
  assert.equal(meta.state, 'done');
  assert.equal(meta.exit_code, 0);
  assert.equal(meta.reason, null);
  assert.equal(meta.attention, null);
  assert.deepEqual(provider.toolCalls.map(call => call.args), [{ path: 'D:/new/a.txt' }]);
  assert.equal(fs.readFileSync(path.join(dir, 'final.txt'), 'utf8'), 'Finished: all good.');
  assert.equal(meta.usage.turns, 2);
  assert.equal(meta.usage.chars_sent, fake.sent.join('').length);
  assert.ok(meta.usage.chars_received > 0);
  assert.ok(fake.sent[1].startsWith('TEAMYRA_TOOL_RESULT '));
  assert.ok(provider.metaHistory.some(patch => /^chatgpt generating \d+ s$/.test(patch.last_event || '')),
    'live progress must be written to last_event');
  assert.equal(provider.busy, false);
}

async function testParseErrorIsSentBackAndJobContinues() {
  const fake = new FakeChat([
    'TEAMYRA_TOOL_REQUEST {"tool":"filesystem.read","args":{"path":"a"}',
    'TEAMYRA_TOOL_REQUEST {"tool":"filesystem.read","args":{"path":"a"}}',
    'The file says hello.'
  ]);
  const provider = makeProvider(fake);
  const dir = makeJob();
  await provider.runDelegatedJob(dir);
  assert.equal(readMeta(dir).state, 'done');
  assert.ok(fake.sent[1].startsWith('TEAMYRA_TOOL_ERROR '));
  const payload = JSON.parse(fake.sent[1].slice('TEAMYRA_TOOL_ERROR '.length));
  assert.ok(payload.error && /forward slashes/.test(payload.hint));
  assert.equal(provider.toolCalls.length, 1);
}

async function testThreeParseFailuresFailTheJob() {
  const bad = 'TEAMYRA_TOOL_REQUEST {"tool": broken';
  const fake = new FakeChat([bad, bad, bad, 'never reached']);
  const provider = makeProvider(fake);
  const dir = makeJob();
  await provider.runDelegatedJob(dir);
  const meta = readMeta(dir);
  assert.equal(meta.state, 'failed');
  assert.equal(meta.reason, 'tool_parse_error');
  assert.equal(meta.exit_code, 1);
  assert.equal(fake.sent.filter(text => text.startsWith('TEAMYRA_TOOL_ERROR')).length, 2);
  assert.equal(fs.readFileSync(path.join(dir, 'DONE'), 'utf8'), 'failed');
}

async function testChallengeWhileWaitingPausesAndResendsLostMessage() {
  const fake = new FakeChat([
    { text: 'lost', challenge: { snaps: 1, probes: 3, lose: true } },
    'Final after verification.'
  ]);
  const provider = makeProvider(fake);
  provider.conversation = { url: 'https://chatgpt.com/', conversationId: null };
  const dir = makeJob();
  await provider.runDelegatedJob(dir);
  const meta = readMeta(dir);
  assert.equal(meta.state, 'done');
  assert.equal(meta.exit_code, 0);
  assert.equal(meta.attention, null);
  const states = provider.metaHistory.map(patch => patch.state).filter(Boolean);
  assert.deepEqual(states, ['running', 'needs_user', 'running', 'done']);
  const paused = provider.metaHistory.find(patch => patch.state === 'needs_user');
  assert.equal(paused.reason, 'chatgpt_verification');
  assert.equal(paused.attention.kind, 'chatgpt_verification');
  assert.equal(typeof paused.attention.since, 'number');
  assert.equal(provider.notes.length, 1, 'a desktop notification must be shown');
  assert.equal(fake.sent.length, 2, 'the lost bootstrap message must be sent again');
  assert.equal(fake.sent[0], fake.sent[1]);
}

async function testChallengeWithDeliveredMessageDoesNotResend() {
  const fake = new FakeChat([{ text: 'Done without resend.', challenge: { snaps: 2, probes: 1 } }]);
  const provider = makeProvider(fake);
  const dir = makeJob();
  await provider.runDelegatedJob(dir);
  assert.equal(readMeta(dir).state, 'done');
  assert.equal(fake.sent.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, 'final.txt'), 'utf8'), 'Done without resend.');
}

async function testChallengeBeforeSending() {
  const fake = new FakeChat(['Final.']);
  fake.challengeProbes = 2;
  const provider = makeProvider(fake);
  const dir = makeJob();
  await provider.runDelegatedJob(dir);
  assert.equal(readMeta(dir).state, 'done');
  assert.ok(provider.metaHistory.some(patch => patch.state === 'needs_user'));
  assert.equal(fake.sent.length, 1);
}

async function testDeadlineWhilePausedFailsWithTimeout() {
  const fake = new FakeChat(['never']);
  fake.challengeProbes = Number.MAX_SAFE_INTEGER;
  const provider = makeProvider(fake);
  const dir = makeJob({ timeout: 0.05 });
  await provider.runDelegatedJob(dir);
  const meta = readMeta(dir);
  assert.equal(meta.state, 'failed');
  assert.equal(meta.reason, 'timeout');
  assert.equal(meta.exit_code, 1);
  assert.equal(meta.attention, null);
  assert.equal(provider.awaitingUser, false);
}

async function testCancelSetsExitCode() {
  const fake = new FakeChat([{ text: 'slow', generating: 1000000 }]);
  const provider = makeProvider(fake);
  const dir = makeJob();
  setTimeout(() => fs.writeFileSync(path.join(dir, 'CANCEL'), 'cancel'), 20);
  await provider.runDelegatedJob(dir);
  const meta = readMeta(dir);
  assert.equal(meta.state, 'cancelled');
  assert.equal(meta.reason, 'cancelled');
  assert.equal(meta.exit_code, 1);
}

async function testWorkerChallengedBeforePickupMarksWaitingJobs() {
  const provider = makeProvider(new FakeChat([]));
  const dir = makeJob();
  const otherProfile = makeJob({}, { profile_id: 'account2' });
  let ran = [];
  provider.runDelegatedJob = async jobDir => { ran.push(jobDir); };
  provider.refreshStatus = async () => ({ workerReady: false, challenged: true });
  await provider.processPendingJobsOnce();
  await provider.processPendingJobsOnce();
  let meta = readMeta(dir);
  assert.equal(meta.state, 'waiting_for_desktop');
  assert.equal(meta.attention.kind, 'chatgpt_verification');
  assert.equal(readMeta(otherProfile).attention, undefined);
  assert.equal(provider.notes.length, 1, 'notify once, not on every scan');
  assert.deepEqual(ran, []);

  provider.refreshStatus = async () => ({ workerReady: false, challenged: false, loginVisible: true });
  await provider.processPendingJobsOnce();
  meta = readMeta(dir);
  assert.equal(meta.attention, null);
  assert.match(meta.last_event, /sign-in/);

  provider.refreshStatus = async () => ({ workerReady: true });
  await provider.processPendingJobsOnce();
  assert.deepEqual(ran, [dir]);
  fs.writeFileSync(path.join(dir, 'DONE'), 'done');
}

async function main() {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamyra-chatgpt-loop-'));
  try {
    await testHappyPathWithWindowsPath();
    await testParseErrorIsSentBackAndJobContinues();
    await testThreeParseFailuresFailTheJob();
    await testChallengeWhileWaitingPausesAndResendsLostMessage();
    await testChallengeWithDeliveredMessageDoesNotResend();
    await testChallengeBeforeSending();
    await testDeadlineWhilePausedFailsWithTimeout();
    await testCancelSetsExitCode();
    await testWorkerChallengedBeforePickupMarksWaitingJobs();
    console.log('chatgpt job loop tests passed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
