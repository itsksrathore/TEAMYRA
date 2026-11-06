const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const dispatchCalls = [];
const dispatchErrors = [];
let dispatchResult = () => Promise.resolve({ dispatched: [] });
const providerModule = { exports: {} };
vm.runInNewContext(fs.readFileSync(require.resolve('../src/chatgpt-web-provider'), 'utf8'), {
  module: providerModule, process, Date, URL, setTimeout, clearTimeout, setInterval, clearInterval,
  console: { ...console, error: (...args) => dispatchErrors.push(args) },
  require(name) {
    if (name === './core-api') return { callCore: action => {
      dispatchCalls.push(action);
      return dispatchResult();
    } };
    if (name.startsWith('./')) return require('../src/' + name.slice(2));
    return require(name);
  }
});
const { ChatGPTWebProvider, boundToolResult } = providerModule.exports;
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
    if (this.signedOutProbes > 0) {
      this.signedOutProbes -= 1;
      return { promptFound: true, challenged: false, loginVisible: true };
    }
    if (this.promptMissingProbes > 0) {
      this.promptMissingProbes -= 1;
      return { promptFound: false, challenged: false, loginVisible: false };
    }
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
    // `hang`: the next N page calls after sending time out (a hung page).
    if (this.pending.hang) this.hangSnaps = this.pending.hang;
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
    if (this.hangSnaps > 0) {
      this.hangSnaps -= 1;
      const error = new Error('ChatGPT executeJavaScript timed out');
      error.code = 'TEAMYRA_PAGE_UNRESPONSIVE';
      throw error;
    }
    if (this.challengeSnaps > 0) {
      this.challengeSnaps -= 1;
      return { ...this.current, generating: false, challenged: true };
    }
    if (this.pending) {
      this.turn += 1;
      this.current = { count: this.turn, text: this.pending.text, messageId: 'turn-' + this.turn };
      this.genTicks = this.pending.generating || 0;
      // `later`: the reply text changes after `laterAfter` more reads without
      // a new message (a status line shown while the model still thinks).
      this.later = this.pending.later ? { text: this.pending.later, after: this.pending.laterAfter ?? 2 } : null;
      this.turnSnaps = 0;
      this.pending = null;
    }
    this.turnSnaps = (this.turnSnaps || 0) + 1;
    if (this.later && this.turnSnaps > this.later.after) {
      this.current = { ...this.current, text: this.later.text };
      this.later = null;
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
  // Without this, writeStatus() writes `undefined.tmp-<pid>` into the cwd.
  provider.statusFile = path.join(provider.stateRoot, 'status.json');
  fs.mkdirSync(provider.stateRoot, { recursive: true });
  provider.activeProfileId = 'web';
  provider.loaded = true;
  provider.view = { webContents: { isDestroyed: () => false } };
  provider.automation = fake;
  provider.replyPollMs = 1;
  provider.settleRecheckMs = 1;
  provider.jobScanMaxAgeMs = 0;
  provider.promptWaitMs = 5;
  provider.renderWaitMs = 200;
  provider.recoveryBackoffMs = 1;
  provider.reconnects = 0;
  provider.reconnect = async () => { provider.reconnects += 1; };
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
  provider.runDelegatedJob = async function (dir) {
    const before = dispatchCalls.length;
    await ChatGPTWebProvider.prototype.runDelegatedJob.call(this, dir);
    assert.equal(dispatchCalls.length, before + 1, 'every terminal job must trigger dispatch exactly once');
    assert.equal(dispatchCalls.at(-1), 'scheduler.dispatch');
    assert.ok(fs.existsSync(path.join(dir, 'DONE')), 'dispatch follows a terminal job');
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
  assert.equal(dispatchCalls.at(-1), 'scheduler.dispatch');
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
  assert.equal(dispatchCalls.at(-1), 'scheduler.dispatch');
}

async function testProtocolLossRecoversAndRetriesAreBounded() {
  const refusals = [
    'The TEAMYRA tool interface is not available in this chat. Please paste the files.',
    "I cannot access local files. Please upload the file contents.",
    "I don't have access to the TEAMYRA tool interface or local tools."
  ];
  for (const refusal of refusals) {
    const fake = new FakeChat([refusal,
      'TEAMYRA_TOOL_REQUEST {"tool":"filesystem.read","args":{"path":"a.txt"}}',
      'Finished: the requested file contains hello.']);
    const provider = makeProvider(fake);
    const dir = makeJob();
    await provider.runDelegatedJob(dir);
    assert.equal(readMeta(dir).state, 'done');
    assert.equal(readMeta(dir).protocol_recoveries, 1);
    assert.ok(fake.sent[1].startsWith('TEAMYRA protocol reminder:'));
    assert.ok(fake.sent[1].includes(fake.sent[0]), 'reminder includes original bootstrap and task');
    assert.equal(provider.toolCalls.length, 1);
  }
  const fake = new FakeChat([...refusals, 'never reached']);
  const dir = makeJob();
  await makeProvider(fake).runDelegatedJob(dir);
  const meta = readMeta(dir);
  assert.equal(meta.state, 'failed');
  assert.equal(meta.reason, 'protocol_lost');
  assert.equal(meta.exit_code, 1);
  assert.equal(meta.protocol_recoveries, 2);
  assert.equal(fake.sent.length, 3);
  assert.equal(fs.readFileSync(path.join(dir, 'DONE'), 'utf8'), 'failed');
}

async function testProtocolRecoveryAfterToolsAndGenuineFinalAnswers() {
  const request = 'TEAMYRA_TOOL_REQUEST {"tool":"filesystem.read","args":{"path":"a.txt"}}';
  const fake = new FakeChat([request, 'Local tools are not available. I cannot finish the task.',
    'Finished: the file contains hello.']);
  const dir = makeJob();
  await makeProvider(fake).runDelegatedJob(dir);
  assert.equal(readMeta(dir).state, 'done');
  assert.equal(readMeta(dir).protocol_recoveries, 1);
  for (const script of [['The requested summary is complete.'],
    [request, 'Fixed the error: local tools are not available. Tests passed.']]) {
    const finalFake = new FakeChat(script);
    const finalDir = makeJob();
    await makeProvider(finalFake).runDelegatedJob(finalDir);
    assert.equal(readMeta(finalDir).state, 'done');
    assert.equal(readMeta(finalDir).protocol_recoveries, undefined);
  }
}

async function testExpectedOutputFiles() {
  fs.writeFileSync(path.join(root, 'empty.txt'), '');
  fs.writeFileSync(path.join(root, 'ready.txt'), 'content');
  fs.mkdirSync(path.join(root, 'output-directory'));
  for (const [paths, passed] of [
    [[], true], [['ready.txt'], true], [['missing.txt'], false], [['empty.txt'], false],
    [['output-directory'], false], [['ready.txt', 'missing.txt'], false], [['../outside.txt'], false]
  ]) {
    const dir = makeJob({ expect_files: paths });
    const fake = new FakeChat(['Finished: created all requested outputs.', 'Done.', 'Done again.']);
    await makeProvider(fake).runDelegatedJob(dir);
    const meta = readMeta(dir);
    assert.equal(meta.state, passed ? 'done' : 'failed');
    assert.equal(meta.reason, passed ? null : 'missing_output');
    assert.equal(meta.exit_code, passed ? 0 : 1);
    if (!passed) {
      assert.ok(meta.missing_outputs.length);
      // Asked twice to continue before the job fails.
      assert.equal(meta.output_nudges, 2);
      assert.equal(fake.sent.length, 3);
      assert.ok(fake.sent[1].startsWith('TEAMYRA: the task is not finished.'));
    }
  }
  // ChatGPT said the bridge was unavailable and stopped (1106-141119): told
  // what is missing, it writes the file and the job succeeds.
  const target = path.join(root, 'nudged.md');
  const fake = new FakeChat([
    'I can work on QUA-02, but the TEAMYRA local-tool bridge is not available in this session.',
    'TEAMYRA_TOOL_REQUEST {"tool":"filesystem.write","args":{"path":"nudged.md","content":"x"}}',
    'Finished: wrote nudged.md.'
  ]);
  const provider = makeProvider(fake);
  const run = provider.workspaceBridge.executeInWorkspace;
  provider.workspaceBridge.executeInWorkspace = async (...args) => { fs.writeFileSync(target, 'x'); return run(...args); };
  const dir = makeJob({ expect_files: ['nudged.md'] });
  await provider.runDelegatedJob(dir);
  assert.equal(readMeta(dir).state, 'done');
  assert.equal(provider.toolCalls.length, 1);
}

function testLargeToolResultsFitOneMessage() {
  // ChatGPT never answered tool results of 120-132k characters; the jobs
  // hung until the page-recovery limit failed them.
  const read = boundToolResult({ path: 'a', content: 'x"\\'.repeat(60000), offset: 0, next_offset: 90000 });
  assert.ok(JSON.stringify(read).length <= 40000);
  assert.ok(read.clipped && read.content.length >= 1000 && /of 180000 characters/.test(read.content_clipped));
  assert.equal(read.next_offset, null, 'a clipped read has no valid next_offset');
  const run = boundToolResult({ argv: ['x'], stdout: 'o'.repeat(200000), stderr: 'e'.repeat(50000), exit_code: 3 });
  assert.ok(JSON.stringify(run).length <= 40000);
  assert.equal(run.exit_code, 3);
  assert.ok(run.stdout.startsWith('ooo') && run.stderr.startsWith('eee'));
  const many = boundToolResult({ matches: Array.from({ length: 5000 }, (_, i) => ({ path: 'p' + i, line: i, text: 't'.repeat(30) })) });
  assert.ok(JSON.stringify(many).length <= 40000 && many.preview && many.note);
  const small = { ok: true, content: 'hi' };
  assert.equal(boundToolResult(small), small);
}

async function testToolRequestsAreParsedFromTheReplyAsWritten() {
  // The page shows rendered Markdown: `\"` lost its backslash and `$_.Line`
  // turned into math, so the request broke as JSON (1106-141045). The reply
  // as written comes from the conversation data instead.
  const written = String.raw`TEAMYRA_TOOL_REQUEST {"tool":"terminal.run","args":{"argv":["powershell","-Command","'{0}' -f $_.Line; echo \"a\\b\""]}}`;
  const rendered = 'TEAMYRA_TOOL_REQUEST {"tool":"terminal.run","args":{"argv":["powershell","-Command","\'{0}\' -f \n𝐿\n𝑖\n; echo "a\b""]}}';
  const fake = new FakeChat([rendered, 'Finished: ran it.']);
  fake.rawReplyText = async () => fake.turn === 1 ? written : '';
  const provider = makeProvider(fake);
  const dir = makeJob();
  await provider.runDelegatedJob(dir);
  assert.equal(readMeta(dir).state, 'done');
  assert.deepEqual(provider.toolCalls[0].args.argv, ['powershell', '-Command', String.raw`'{0}' -f $_.Line; echo "a\b"`]);
}

async function testStatusLineIsNotTakenAsTheFinalReply() {
  // "Checked shell readiness" sat still while ChatGPT was still thinking and
  // ended the job (1106-133637). A second look waits for the real reply.
  const fake = new FakeChat([
    { text: 'Checked shell readiness', later: 'TEAMYRA_TOOL_REQUEST {"tool":"filesystem.read","args":{"path":"a.txt"}}' },
    'Finished: the file says hello.'
  ]);
  const provider = makeProvider(fake);
  const dir = makeJob();
  await provider.runDelegatedJob(dir);
  const meta = readMeta(dir);
  assert.equal(meta.state, 'done');
  assert.equal(provider.toolCalls.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, 'final.txt'), 'utf8'), 'Finished: the file says hello.');
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
  assert.equal(dispatchCalls.at(-1), 'scheduler.dispatch');
}

async function testDispatchNeverBlocksAndLogsRejections() {
  const provider = makeProvider(new FakeChat(['done']));
  const before = dispatchCalls.length;
  dispatchResult = () => new Promise(() => {});
  const dir = makeJob();
  let timer;
  try {
    await Promise.race([
      provider.runDelegatedJob(dir),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('dispatch blocked completion')), 1000); })
    ]);
    assert.equal(dispatchCalls.length, before + 1);
    assert.equal(readMeta(dir).state, 'done');
    dispatchResult = () => Promise.reject(new Error('dispatch unavailable'));
    await provider.runDelegatedJob(makeJob());
    await new Promise(resolve => setImmediate(resolve));
    assert.match(String(dispatchErrors.at(-1)), /dispatch unavailable/);
    dispatchResult = () => { throw new Error('sync dispatch error'); };
    provider.dispatchQueuedJobs();
    await new Promise(resolve => setImmediate(resolve));
    assert.match(String(dispatchErrors.at(-1)), /sync dispatch error/);
  } finally {
    clearTimeout(timer);
    dispatchResult = () => Promise.resolve({ dispatched: [] });
  }
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

  // Signed out: a human must act, so the waiting job says so in attention.
  provider.refreshStatus = async () => ({ workerReady: false, challenged: false, loginVisible: true });
  await provider.processPendingJobsOnce();
  meta = readMeta(dir);
  assert.equal(meta.attention.kind, 'chatgpt_sign_in');
  assert.match(meta.last_event, /sign-in/);
  assert.equal(provider.notes.at(-1), 'TEAMYRA: ChatGPT sign-in needed');

  provider.refreshStatus = async () => ({ workerReady: true });
  await provider.processPendingJobsOnce();
  assert.deepEqual(ran, [dir]);
  fs.writeFileSync(path.join(dir, 'DONE'), 'done');
}

// Regression (8 jobs, e.g. 1008-104822-...-c230): a sign-out mid-job used to
// fail the job. Now it pauses as needs_user and resumes in the conversation.
async function testSignOutMidJobPausesAndResumes() {
  const fake = new FakeChat([
    'TEAMYRA_TOOL_REQUEST {"tool":"filesystem.read","args":{"path":"a.txt"}}',
    'Finished after signing in again.'
  ]);
  const provider = makeProvider(fake);
  const exec = provider.workspaceBridge.executeInWorkspace;
  // Signed out exactly when the tool result is about to be sent.
  provider.workspaceBridge.executeInWorkspace = async (...args) => { fake.signedOutProbes = 3; return exec(...args); };
  const dir = makeJob();
  await provider.runDelegatedJob(dir);
  assert.equal(readMeta(dir).state, 'done');
  const paused = provider.metaHistory.find(patch => patch.state === 'needs_user');
  assert.equal(paused.reason, 'chatgpt_sign_in');
  assert.equal(paused.attention.kind, 'chatgpt_sign_in');
  assert.equal(fake.sent.length, 2, 'the tool result is sent once, after sign-in');
  assert.ok(provider.notes.includes('TEAMYRA: ChatGPT sign-in needed'));
}

// Regression (1006-154556-...-7b29, 1007-070442-...-c9c0): "ChatGPT prompt is
// unavailable" 20 s after start failed the job. Now the page is reloaded.
async function testMissingPromptReloadsInsteadOfFailing() {
  const fake = new FakeChat(['Finished.']);
  fake.promptMissingProbes = 1000;
  const provider = makeProvider(fake);
  provider.reconnect = async () => { provider.reconnects += 1; fake.promptMissingProbes = 0; };
  const dir = makeJob();
  await provider.runDelegatedJob(dir);
  assert.equal(readMeta(dir).state, 'done');
  assert.equal(provider.reconnects, 1);
  assert.equal(fake.sent.length, 1, 'the message was not delivered before, so it is sent exactly once');
}

// Regression (1027-183622-...-4112: chars_sent 7179 over 3 turns): a hung page
// after Send must not submit the same message again once it was delivered.
async function testHangAfterDeliveredMessageDoesNotResend() {
  const fake = new FakeChat([{ text: 'Done once.', hang: 2 }]);
  const provider = makeProvider(fake);
  const dir = makeJob();
  await provider.runDelegatedJob(dir);
  const meta = readMeta(dir);
  assert.equal(meta.state, 'done');
  assert.equal(fake.sent.length, 1);
  assert.equal(meta.usage.turns, 1);
  assert.equal(provider.reconnects, 2);
  assert.equal(fs.readFileSync(path.join(dir, 'final.txt'), 'utf8'), 'Done once.');
}

// Regression (4112: "page unresponsive after two recoveries"): the budget is
// per hang streak, so a long job survives several separate hangs ...
async function testRecoveryBudgetResetsAfterEachReply() {
  const request = 'TEAMYRA_TOOL_REQUEST {"tool":"filesystem.read","args":{"path":"a.txt"}}';
  const fake = new FakeChat([{ text: request, hang: 2 }, { text: request, hang: 2 }, { text: 'Finished.', hang: 2 }]);
  const provider = makeProvider(fake);
  const dir = makeJob();
  await provider.runDelegatedJob(dir);
  const meta = readMeta(dir);
  assert.equal(meta.state, 'done');
  assert.equal(meta.page_recoveries, 6);
  assert.equal(fake.sent.length, 3);
  // ... but a page that never comes back still fails honestly.
  const stuck = new FakeChat([{ text: 'never', hang: 1000 }]);
  const stuckDir = makeJob();
  await makeProvider(stuck).runDelegatedJob(stuckDir);
  const failed = readMeta(stuckDir);
  assert.equal(failed.state, 'failed');
  assert.equal(failed.reason, 'page_unresponsive');
  assert.match(failed.last_event, /3 reloads in a row/);
  assert.equal(stuck.sent.length, 1);
}

function interruptedJob(state, meta = {}) {
  const dir = makeJob({}, { state: 'running', started: Date.now() / 1000,
    usage: { chars_sent: 10, chars_received: 5, turns: 1 }, ...meta });
  if (state) fs.writeFileSync(path.join(dir, 'chatgpt-state.json'), JSON.stringify(state));
  return dir;
}

// Regression (desktop_interrupted, e.g. 1006-154557-...-04cc after 11 h): a
// desktop restart now resumes the job in its conversation, without repeating
// a delivered message or a tool that was running.
async function testDesktopRestartResumesTheJob() {
  const conversation = { conversation_id: 'conv1', conversation_url: 'https://chatgpt.com/c/conv1', successful_tools: 2, step: 4 };
  // A tool was running when the desktop died: it is not run again.
  const toolDir = interruptedJob({ ...conversation, phase: 'tool', request: { tool: 'terminal.run', args: { argv: ['npm', 'test'] } } });
  makeProvider(new FakeChat([])).recoverInterruptedJobs();
  let meta = readMeta(toolDir);
  assert.equal(meta.state, 'waiting_for_desktop');
  assert.equal(meta.resume_requested, true);
  assert.equal(meta.desktop_resumes, 1);
  assert.ok(!fs.existsSync(path.join(toolDir, 'DONE')));
  const fake = new FakeChat(['Finished after the restart.']);
  const provider = makeProvider(fake);
  await provider.runDelegatedJob(toolDir);
  meta = readMeta(toolDir);
  assert.equal(meta.state, 'done');
  assert.equal(provider.toolCalls.length, 0, 'the interrupted tool must not run twice');
  assert.ok(fake.sent[0].startsWith('TEAMYRA_TOOL_RESULT '));
  assert.match(fake.sent[0], /outcome is unknown/);
  assert.deepEqual(provider.opened, ['https://chatgpt.com/c/conv1']);
  assert.equal(meta.resume_requested, false);
  assert.equal(meta.usage.turns, 2, 'usage continues from before the restart');

  // The last message was delivered: only its reply is awaited.
  const message = 'TEAMYRA_TOOL_RESULT {"tool":"x"}';
  const sentDir = interruptedJob({ ...conversation, phase: 'awaiting', message,
    baseline: { count: 3, text: 'before', messageId: 'turn-3' } });
  makeProvider(new FakeChat([])).recoverInterruptedJobs();
  const delivered = new FakeChat([]);
  delivered.users.push(message);
  delivered.current = { count: 4, text: 'Reply that arrived during the restart.', messageId: 'turn-4' };
  await makeProvider(delivered).runDelegatedJob(sentDir);
  assert.equal(readMeta(sentDir).state, 'done');
  assert.equal(delivered.sent.length, 0, 'a delivered message is never sent twice');
  assert.equal(fs.readFileSync(path.join(sentDir, 'final.txt'), 'utf8'), 'Reply that arrived during the restart.');

  // Regression (live run 1106-092925-...-ad0b): after a cold desktop start the
  // conversation rendered after the delivered-check gave up, so a delivered
  // tool result was sent twice. An empty conversation is waited for.
  const lateDir = interruptedJob({ ...conversation, phase: 'awaiting', message,
    baseline: { count: 3, text: 'before', messageId: 'turn-3' } });
  makeProvider(new FakeChat([])).recoverInterruptedJobs();
  const late = new FakeChat([]);
  late.users.push(message);
  late.current = { count: 4, text: 'Reply rendered late.', messageId: 'turn-4' };
  let renders = 0;
  const lastUser = late.lastUserMessage.bind(late);
  late.lastUserMessage = async () => (++renders <= 6 ? '' : lastUser());
  const lateProvider = makeProvider(late);
  lateProvider.renderWaitMs = 5000;
  await lateProvider.runDelegatedJob(lateDir);
  assert.equal(readMeta(lateDir).state, 'done');
  assert.equal(late.sent.length, 0, 'a delivered message that renders late is not sent again');
  assert.ok(renders > 6);
  assert.equal(readMeta(lateDir).last_event, 'done: embedded ChatGPT completed');

  // A reply that was received but not processed yet is processed as is.
  const replyDir = interruptedJob({ ...conversation, phase: 'reply',
    reply: 'TEAMYRA_TOOL_REQUEST {"tool":"filesystem.read","args":{"path":"b.txt"}}' });
  makeProvider(new FakeChat([])).recoverInterruptedJobs();
  const replyProvider = makeProvider(new FakeChat(['Finished.']));
  await replyProvider.runDelegatedJob(replyDir);
  assert.equal(readMeta(replyDir).state, 'done');
  assert.deepEqual(replyProvider.toolCalls.map(call => call.args), [{ path: 'b.txt' }]);

  // Tools ran but the conversation is unknown, or too many restarts: fail honestly.
  const lostDir = interruptedJob({ phase: 'tool', successful_tools: 3, request: { tool: 'git.status', args: {} } });
  const limitDir = interruptedJob({ ...conversation, phase: 'reply', reply: 'x' }, { desktop_resumes: 3 });
  makeProvider(new FakeChat([])).recoverInterruptedJobs();
  for (const dir of [lostDir, limitDir]) {
    meta = readMeta(dir);
    assert.equal(meta.state, 'failed');
    assert.equal(meta.reason, 'desktop_interrupted');
    assert.ok(fs.existsSync(path.join(dir, 'DONE')));
  }
}

// Regression (1027-191533-...-e9f9 waited 13 h; 1008-130743-...-0318 7 h): a
// waiting job past its time budget fails with the reason it waited.
async function testWaitingJobPastDeadlineFailsWithReason() {
  const provider = makeProvider(new FakeChat([]));
  provider.refreshStatus = async () => ({ workerReady: false });
  const old = makeJob({}, { dispatched_at: Date.now() / 1000 - 7200, timeout_s: 3600,
    last_event: 'waiting: embedded ChatGPT worker is not ready' });
  await provider.processPendingJobsOnce();
  const meta = readMeta(old);
  assert.equal(meta.state, 'failed');
  assert.equal(meta.reason, 'timeout');
  assert.match(meta.last_event, /timed out waiting for the embedded ChatGPT worker \(embedded ChatGPT worker is not ready\)/);
  assert.ok(fs.existsSync(path.join(old, 'DONE')));
}

// Regression (e9f9): a worker that is loaded but never shows a usable prompt
// is reloaded instead of leaving the jobs waiting; and while jobs wait, the
// provider reports pending work so the desktop does not idle-exit.
async function testNotReadyWorkerIsReloaded() {
  const provider = makeProvider(new FakeChat([]));
  provider.notReadyHealMs = 0;
  provider.healIntervalMs = 0;
  let ready = false;
  provider.reconnect = async () => { provider.reconnects += 1; ready = true; };
  provider.refreshStatus = async () => ({ workerReady: ready, challenged: false, loginVisible: false });
  const ran = [];
  provider.runDelegatedJob = async dir => { ran.push(dir); fs.writeFileSync(path.join(dir, 'DONE'), 'done'); };
  const dir = makeJob({}, { dispatched_at: Date.now() / 1000, timeout_s: 3600 });
  await provider.processPendingJobsOnce();
  assert.equal(provider.reconnects, 1);
  assert.deepEqual(ran, [dir]);

  const waiting = makeProvider(new FakeChat([]));
  waiting.notReadyHealMs = 60000;
  waiting.refreshStatus = async () => ({ workerReady: false, detail: 'still loading' });
  const second = makeJob({}, { dispatched_at: Date.now() / 1000, timeout_s: 3600 });
  await waiting.processPendingJobsOnce();
  assert.equal(waiting.reconnects, 0, 'no reload during the grace period');
  assert.equal(waiting.hasPendingWork(), true);
  assert.match(readMeta(second).last_event, /not ready: still loading/);
  fs.writeFileSync(path.join(second, 'DONE'), 'done');
  await waiting.processPendingJobsOnce();
  assert.equal(waiting.hasPendingWork(), false);
}

// With nothing of its own to do, an idle worker asks the scheduler to start
// queued ChatGPT jobs (the core may not be running), rate-limited.
async function testIdleWorkerNudgesTheQueue() {
  const provider = makeProvider(new FakeChat([]));
  const queued = makeJob({}, { state: 'queued', worker: 'chatgpt-normal' });
  const before = dispatchCalls.length;
  await provider.processPendingJobsOnce();
  await provider.processPendingJobsOnce();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(dispatchCalls.length, before + 1);
  fs.writeFileSync(path.join(queued, 'DONE'), 'cancelled');
}

async function main() {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamyra-chatgpt-loop-'));
  try {
    await testHappyPathWithWindowsPath();
    await testParseErrorIsSentBackAndJobContinues();
    await testThreeParseFailuresFailTheJob();
    await testProtocolLossRecoversAndRetriesAreBounded();
    await testProtocolRecoveryAfterToolsAndGenuineFinalAnswers();
    await testExpectedOutputFiles();
    testLargeToolResultsFitOneMessage();
    await testToolRequestsAreParsedFromTheReplyAsWritten();
    await testStatusLineIsNotTakenAsTheFinalReply();
    await testChallengeWhileWaitingPausesAndResendsLostMessage();
    await testChallengeWithDeliveredMessageDoesNotResend();
    await testChallengeBeforeSending();
    await testDeadlineWhilePausedFailsWithTimeout();
    await testCancelSetsExitCode();
    await testDispatchNeverBlocksAndLogsRejections();
    await testWorkerChallengedBeforePickupMarksWaitingJobs();
    await testSignOutMidJobPausesAndResumes();
    await testMissingPromptReloadsInsteadOfFailing();
    await testHangAfterDeliveredMessageDoesNotResend();
    await testRecoveryBudgetResetsAfterEachReply();
    await testDesktopRestartResumesTheJob();
    await testWaitingJobPastDeadlineFailsWithReason();
    await testNotReadyWorkerIsReloaded();
    await testIdleWorkerNudgesTheQueue();
    assert.ok(!fs.existsSync(path.resolve('undefined.tmp-' + process.pid)), 'status must be written under the test root');
    console.log('chatgpt job loop tests passed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
