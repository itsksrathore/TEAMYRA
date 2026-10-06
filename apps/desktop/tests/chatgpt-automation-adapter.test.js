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
  console.log('chatgpt automation adapter tests passed');
}
replyTests().catch(error => { console.error(error); process.exitCode = 1; });
