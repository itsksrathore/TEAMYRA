const assert = require('node:assert/strict');
const { ChatGPTAutomationAdapter, parseToolRequestDetailed } = require('../src/chatgpt-automation-adapter');

const adapter = new ChatGPTAutomationAdapter(null);

assert.deepEqual(
  adapter.parseToolRequest('TEAMYRA_TOOL_REQUEST {"tool":"filesystem.read","args":{"path":"README.md"}}'),
  { tool: 'filesystem.read', args: { path: 'README.md' } }
);

// After leading text, with trailing text, inside code fences and over several lines.
assert.deepEqual(
  adapter.parseToolRequest('I will read it now.\nTEAMYRA_TOOL_REQUEST {"tool":"filesystem.read","args":{"path":"a"}}'),
  { tool: 'filesystem.read', args: { path: 'a' } }
);
assert.deepEqual(
  adapter.parseToolRequest('TEAMYRA_TOOL_REQUEST {"tool":"filesystem.read","args":{"path":"a"}}\nextra text'),
  { tool: 'filesystem.read', args: { path: 'a' } }
);
assert.deepEqual(
  adapter.parseToolRequest('```json\nTEAMYRA_TOOL_REQUEST {"tool":"git.status","args":{}}\n```'),
  { tool: 'git.status', args: {} }
);
assert.deepEqual(
  adapter.parseToolRequest('Next step:\nTEAMYRA_TOOL_REQUEST\n```json\n{\n  "tool": "filesystem.search",\n  "args": {\n    "query": "a}b",\n    "path": "src"\n  }\n}\n```\nDone.'),
  { tool: 'filesystem.search', args: { query: 'a}b', path: 'src' } }
);

// Invalid escapes are repaired; valid escapes outside path keys keep their meaning.
assert.deepEqual(
  adapter.parseToolRequest('TEAMYRA_TOOL_REQUEST {"tool":"terminal.run","args":{"command":"grep -E \\d+ \\"x\\"\\n"}}'),
  { tool: 'terminal.run', args: { command: 'grep -E \\d+ "x"\n' } }
);

// Windows paths in path-like keys: D:\new must not turn into a newline.
assert.deepEqual(
  adapter.parseToolRequest('TEAMYRA_TOOL_REQUEST {"tool":"filesystem.read","args":{"path":"D:\\new\\table.txt"}}'),
  { tool: 'filesystem.read', args: { path: 'D:/new/table.txt' } }
);
assert.deepEqual(
  adapter.parseToolRequest('TEAMYRA_TOOL_REQUEST {"tool":"filesystem.list","args":{"path":"D:\\AI-Orchestrator\\bridge"}}'),
  { tool: 'filesystem.list', args: { path: 'D:/AI-Orchestrator/bridge' } }
);
// Correctly escaped and mixed backslashes.
assert.deepEqual(
  adapter.parseToolRequest('TEAMYRA_TOOL_REQUEST {"tool":"filesystem.move","args":{"source":"D:\\\\AI\\\\a.txt","destination":"D:\\\\AI\\b.txt"}}'),
  { tool: 'filesystem.move', args: { source: 'D:/AI/a.txt', destination: 'D:/AI/b.txt' } }
);
// Arrays under `paths`, cwd and nested path keys are normalized; other strings are not.
assert.deepEqual(
  adapter.parseToolRequest('TEAMYRA_TOOL_REQUEST {"tool":"git.add","args":{"paths":["src\\new.js","C:\\temp\\x"],"cwd":"D:\\work","message":"a\\tb"}}'),
  { tool: 'git.add', args: { paths: ['src/new.js', 'C:/temp/x'], cwd: 'D:/work', message: 'a\tb' } }
);
assert.deepEqual(
  adapter.parseToolRequest('TEAMYRA_TOOL_REQUEST {"tool":"filesystem.patch","args":{"edits":[{"file":"lib\\run.py","find":"\\n"}]}}'),
  { tool: 'filesystem.patch', args: { edits: [{ file: 'lib/run.py', find: '\n' }] } }
);
// Raw newlines inside a string are repaired.
assert.deepEqual(
  adapter.parseToolRequest('TEAMYRA_TOOL_REQUEST {"tool":"filesystem.write","args":{"path":"a.txt","content":"one\ntwo"}}'),
  { tool: 'filesystem.write', args: { path: 'a.txt', content: 'one\ntwo' } }
);

// Marker without a usable request: not a final answer, but no request either.
for (const text of [
  'TEAMYRA_TOOL_REQUEST {"tool":"filesystem.read","args":[]}',
  'TEAMYRA_TOOL_REQUEST {"tool":"filesystem.read","args":{"path":"a"}',
  'TEAMYRA_TOOL_REQUEST filesystem.read README.md',
  'I would now send TEAMYRA_TOOL_REQUEST but I am done.'
]) {
  const parsed = parseToolRequestDetailed(text);
  assert.equal(parsed.marker, true, text);
  assert.equal(parsed.request, null, text);
  assert.ok(parsed.error, text);
  assert.equal(adapter.parseToolRequest(text), null);
}
assert.deepEqual(adapter.parseToolRequestDetailed('All done. Changed 3 files.'), { marker: false, request: null, error: null });

async function replyTests() {
  for (const [before, after] of [
    [{ count: 5, text: 'old', messageId: 'turn-5' }, { count: 5, text: 'next', messageId: 'turn-6' }],
    [{ count: 5, text: 'same request', messageId: 'turn-5' }, { count: 4, text: 'same request', messageId: 'turn-6' }],
    [{ count: 5, text: 'old' }, { count: 5, text: 'next' }]
  ]) {
    let calls = 0;
    adapter.assistantSnapshot = async () => ({ ...(calls++ === 0 ? before : after), generating: false });
    const result = await adapter.waitForAssistantReply({
      previousCount: before.count, previousText: before.text,
      previousMessageId: before.messageId, timeoutMs: 7000, pollMs: 5
    });
    assert.equal(result.text, after.text);
    assert.ok(calls >= 3, 'must ignore the stale reply and wait for a stable new turn');
  }
  adapter.assistantSnapshot = async () => ({ count: 5, text: 'old', messageId: 'turn-5', generating: false });
  await assert.rejects(adapter.waitForAssistantReply({ previousCount: 5, previousText: 'old', previousMessageId: 'turn-5', timeoutMs: 10 }), /Timed out/);
  await assert.rejects(
    adapter.waitForAssistantReply({ previousMessageId: 'turn-5', deadline: Date.now() + 20, pollMs: 5 }),
    { code: 'TEAMYRA_TIMEOUT', reason: 'timeout' }
  );
  await assert.rejects(adapter.waitForAssistantReply({ shouldCancel: () => true }), { code: 'TEAMYRA_CANCELLED' });

  // Keeps waiting while generating or while the text still grows (no fixed
  // cap) and reports progress.
  let tick = 0;
  const script = [
    { text: 'par', generating: true }, { text: 'part', generating: true }, { text: 'partial', generating: false },
    { text: 'partial answer', generating: false }, { text: 'partial answer', generating: true },
    { text: 'partial answer!', generating: false }, { text: 'partial answer!', generating: false }
  ];
  adapter.assistantSnapshot = async () => ({ count: 6, messageId: 'turn-6', ...script[Math.min(tick++, script.length - 1)] });
  const progress = [];
  const grown = await adapter.waitForAssistantReply({
    previousMessageId: 'turn-5', pollMs: 2, progressIntervalMs: 1,
    onProgress: info => { progress.push(info); }
  });
  assert.equal(grown.text, 'partial answer!');
  assert.ok(tick >= script.length, 'must not return before generation stopped and the text was stable');
  assert.ok(progress.some(item => item.generating), 'progress must report generating');

  // Human verification while waiting.
  adapter.assistantSnapshot = async () => ({ count: 5, text: 'old', messageId: 'turn-5', generating: false, challenged: true });
  await assert.rejects(
    adapter.waitForAssistantReply({ previousMessageId: 'turn-5', timeoutMs: 1000, detectChallenge: true }),
    { code: 'TEAMYRA_CHALLENGED', reason: 'chatgpt_verification' }
  );
  // Regression (job 1027-...-4112): an image being generated changes the DOM
  // but not the text. That is progress, not a hung page.
  let activityTick = 0;
  adapter.assistantSnapshot = async () => {
    activityTick += 1;
    return activityTick < 25
      ? { count: 5, text: 'old', messageId: 'turn-5', generating: false, activity: '6:' + activityTick * 10 }
      : { count: 6, text: '[ChatGPT replied with 1 generated image]', messageId: 'turn-6', generating: false, activity: '6:999' };
  };
  const imageReply = await adapter.waitForAssistantReply({
    previousMessageId: 'turn-5', pollMs: 1, noProgressMs: 200, timeoutMs: 5000
  });
  assert.equal(imageReply.text, '[ChatGPT replied with 1 generated image]');
  // Without any DOM change it is still detected as no progress.
  adapter.assistantSnapshot = async () => ({ count: 5, text: 'old', messageId: 'turn-5', generating: false, activity: '6:1' });
  await assert.rejects(adapter.waitForAssistantReply({ previousMessageId: 'turn-5', pollMs: 1, noProgressMs: 200, timeoutMs: 5000 }),
    { code: 'TEAMYRA_PAGE_UNRESPONSIVE' });
  await domTests();
  console.log('chatgpt automation adapter tests passed');
}

// Regression (Oct 6 tool_parse_error jobs): unescaped quotes inside a value.
assert.deepEqual(
  adapter.parseToolRequest('TEAMYRA_TOOL_REQUEST {"tool":"filesystem.write","args":{"path":"a.md","content":"He said "hi", then left."}}'),
  { tool: 'filesystem.write', args: { path: 'a.md', content: 'He said "hi", then left.' } }
);
assert.deepEqual(
  adapter.parseToolRequest('TEAMYRA_TOOL_REQUEST {"tool":"terminal.run","args":{"command":"node -e "console.log(1)"","cwd":"."}}'),
  { tool: 'terminal.run', args: { command: 'node -e "console.log(1)"', cwd: '.' } }
);
// Valid JSON is untouched by the quote repair.
assert.deepEqual(
  adapter.parseToolRequest('TEAMYRA_TOOL_REQUEST {"tool":"git.commit","args":{"message":"a, \\"b\\"","paths":["x","y"]}}'),
  { tool: 'git.commit', args: { message: 'a, "b"', paths: ['x', 'y'] } }
);

// --- in-page scripts against a minimal fake DOM ------------------------------
const vm = require('node:vm');

function node({ text = '', testid = '', role = '', inContent = false, inHeader = false, visible = true,
  images = [], tag = 'button', children = [] } = {}) {
  const self = {
    tag, testid, role, inHeader, innerText: text, textContent: text, images, children,
    innerHTML: 'x'.repeat(text.length + images.length * 100),
    getAttribute: name => (name === 'data-testid' ? testid : name === 'data-message-id' ? self.messageId || null : null),
    getBoundingClientRect: () => (visible ? { width: 80, height: 30 } : { width: 0, height: 0 }),
    closest: selector => {
      if (/data-message-author-role|conversation-turn|article|markdown/.test(selector) && inContent) return self.turn || self;
      if (/data-message-id/.test(selector)) return self.messageId ? self : null;
      if (/conversation-turn|data-turn-id/.test(selector)) return self.turn || null;
      return null;
    },
    querySelector: () => null,
    querySelectorAll: selector => (selector === 'img' ? images : [])
  };
  return self;
}

// A turn container in ChatGPT's current layout (seen live, Nov 2026):
// <div data-content-search-unit-key="fallback-turn-4:2:assistant"
//      data-chatgpt-search-message-ids="<id> <id>"><h4>ChatGPT said:</h4>
//   <div data-markdown-text-style="assistant-message">…</div></div>
// The markdown body appears only once the reply is rendered.
function unit(role, { ids = '', body = null, text = '', images = [] } = {}) {
  const prefix = role === 'user' ? 'You said:\n' : 'ChatGPT said:\n';
  const bodies = body === null ? [] : [{ innerText: body, textContent: body }];
  const attrs = { 'data-content-search-unit-key': 'fallback-turn-1:0:' + role, 'data-chatgpt-search-message-ids': ids };
  const self = {
    role, images, innerText: prefix + (body ?? text), textContent: prefix + (body ?? text),
    innerHTML: 'x'.repeat(String(body ?? text).length + 50),
    getAttribute: name => attrs[name] ?? null,
    closest: selector => (/data-content-search-unit-key/.test(selector) ? self : null),
    querySelector: () => null,
    querySelectorAll: selector => (selector === 'img' ? images : /data-markdown-text-style/.test(selector) ? bodies : [])
  };
  return self;
}

function fakeDocument({ controls = [], assistants = [], units = [], turns = [], prompt = true, href = 'https://chatgpt.com/c/abc', body = '' }) {
  return {
    title: 'ChatGPT',
    body: { innerText: body },
    querySelector: selector => {
      if (/prompt-textarea/.test(selector)) return prompt ? {} : null;
      return null;
    },
    querySelectorAll: selector => {
      if (/login-button|signup-button/.test(selector)) return controls.filter(item => /login-button|signup-button/.test(item.testid));
      if (/^header button/.test(selector)) return controls.filter(item => item.inHeader || item.role === 'dialog');
      if (selector.includes(':assistant"]')) return [...units.filter(item => item.role === 'assistant'), ...assistants];
      if (selector.includes(':user"]')) return units.filter(item => item.role === 'user');
      if (/conversation-turn-"\], \[data-turn-id\]$/.test(selector)) return turns;
      return [];
    },
    location: { href }
  };
}

function domAdapter(documentValue) {
  return new ChatGPTAutomationAdapter({
    isDestroyed: () => false,
    executeJavaScript: async source => vm.runInNewContext(source, {
      document: documentValue, location: documentValue.location, URL
    })
  });
}

async function domTests() {
  // Regression (8 jobs failed with "ChatGPT sign-in is required" mid-task):
  // conversation text and links that mention logging in are not a sign-out.
  const chatLink = node({ tag: 'a', text: 'Log in', inContent: true });
  const signedIn = fakeDocument({
    controls: [chatLink], body: 'Fix the log in page. Users must sign up first. See https://auth.example.com/oauth'
  });
  let probe = await domAdapter(signedIn).probe();
  assert.equal(probe.loginVisible, false);
  assert.equal(probe.promptFound, true);

  for (const control of [node({ testid: 'login-button', text: 'Log in' }), node({ text: 'Sign up for free', inHeader: true })]) {
    probe = await domAdapter(fakeDocument({ controls: [control] })).probe();
    assert.equal(probe.loginVisible, true, control.text);
  }
  probe = await domAdapter(fakeDocument({ controls: [node({ testid: 'login-button', visible: false })] })).probe();
  assert.equal(probe.loginVisible, false, 'a hidden control is not a sign-out');
  probe = await domAdapter(fakeDocument({ href: 'https://auth.openai.com/log-in' })).probe();
  assert.equal(probe.loginVisible, true);

  // Regression: an image-only reply is a reply (it used to look like silence).
  const turn = node({ tag: 'div', images: [{ naturalWidth: 1024, naturalHeight: 1024, getBoundingClientRect: () => ({ width: 512, height: 512 }) }] });
  const message = node({ tag: 'div', text: '', inContent: true });
  message.turn = turn;
  message.messageId = 'msg-7';
  const snap = await domAdapter(fakeDocument({ assistants: [message], turns: [turn] })).assistantSnapshot();
  assert.equal(snap.count, 1);
  assert.equal(snap.text, '[ChatGPT replied with 1 generated image]');
  assert.equal(snap.images, 1);
  assert.equal(snap.messageId, 'msg-7');
  assert.match(snap.activity, /^1:\d+$/);

  // Regression (live run 1106-093426-...-14ab stalled 5 min, then resent): in
  // the current layout older replies have a markdown body while the reply
  // being written does not yet. The newest turn must win, by its message id.
  const history = [
    unit('user', { text: 'first question' }),
    unit('assistant', { ids: 'a1 a1', body: 'old reply' }),
    unit('user', { text: 'TEAMYRA_TOOL_RESULT {"tool":"x"}' })
  ];
  let snapNow = await domAdapter(fakeDocument({ units: [...history, unit('assistant', { ids: 'a2 a2' })] })).assistantSnapshot();
  assert.equal(snapNow.messageId, 'a1', 'an empty new turn is not a reply yet');
  assert.equal(snapNow.text, 'old reply');
  snapNow = await domAdapter(fakeDocument({ units: [...history, unit('assistant', { ids: 'a2 a2', text: 'partial new' })] })).assistantSnapshot();
  assert.equal(snapNow.messageId, 'a2', 'a streaming reply without markdown body is the newest reply');
  assert.equal(snapNow.text, 'partial new');
  snapNow = await domAdapter(fakeDocument({ units: [...history, unit('assistant', { ids: 'a2 a2', body: 'new reply' })] })).assistantSnapshot();
  assert.equal(snapNow.text, 'new reply');
  assert.equal(snapNow.count, 2);

  // Regression (live run 1106-092925-...-ad0b): the delivered-check read only
  // data-message-author-role, which the current layout no longer has, so a
  // delivered tool result was sent again after a desktop restart.
  const lastUser = await domAdapter(fakeDocument({ units: history })).lastUserMessage();
  assert.equal(lastUser, 'TEAMYRA_TOOL_RESULT {"tool":"x"}');
}
replyTests().catch(error => { console.error(error); process.exitCode = 1; });

// Qwen, 2026-11-07: a tool request in the model's own <tool_call> format was
// taken as the final answer. It is a request when it names a TEAMYRA tool.
{
  const parse = text => new ChatGPTAutomationAdapter(null).parseToolRequestDetailed(text);
  const native = parse('<tool_call>\n{"tool": "filesystem.write", "args": {"path": "D:/x/ops.py", "content": "a = 1\n"}}\n</tool_call>');
  assert.deepEqual(native.request, { tool: 'filesystem.write', args: { path: 'D:/x/ops.py', content: 'a = 1\n' } });
  const named = parse('<tool_call>{"name": "terminal.run", "arguments": {"argv": ["python", "-V"]}}</tool_call>');
  assert.deepEqual(named.request, { tool: 'terminal.run', args: { argv: ['python', '-V'] } });
  const other = parse('Models emit <tool_call>{"name": "get_weather", "arguments": {}}</tool_call> in their template. Done.');
  assert.equal(other.marker, false, 'a reply that only mentions the tag is not a request');
}
