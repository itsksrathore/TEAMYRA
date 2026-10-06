const assert = require('node:assert/strict');
const { ChatGPTAutomationAdapter } = require('../src/chatgpt-automation-adapter');

const adapter = new ChatGPTAutomationAdapter(null);

assert.deepEqual(
  adapter.parseToolRequest('TEAMYRA_TOOL_REQUEST {"tool":"filesystem.read","args":{"path":"README.md"}}'),
  { tool: 'filesystem.read', args: { path: 'README.md' } }
);

assert.equal(
  adapter.parseToolRequest('Here is an example:\nTEAMYRA_TOOL_REQUEST {"tool":"filesystem.delete","args":{"path":"x"}}'),
  null
);

assert.equal(
  adapter.parseToolRequest('TEAMYRA_TOOL_REQUEST {"tool":"filesystem.read","args":{"path":"a"}}\nextra text'),
  null
);

assert.equal(
  adapter.parseToolRequest('TEAMYRA_TOOL_REQUEST {"tool":"filesystem.read","args":[]}'),
  null
);

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
      previousMessageId: before.messageId, timeoutMs: 7000
    });
    assert.equal(result.text, after.text);
    assert.ok(calls >= 3, 'must ignore the stale reply and wait for a stable new turn');
  }
  adapter.assistantSnapshot = async () => ({ count: 5, text: 'old', messageId: 'turn-5', generating: false });
  await assert.rejects(adapter.waitForAssistantReply({ previousCount: 5, previousText: 'old', previousMessageId: 'turn-5', timeoutMs: 10 }), /Timed out/);
  await assert.rejects(adapter.waitForAssistantReply({ shouldCancel: () => true }), { code: 'TEAMYRA_CANCELLED' });
  console.log('chatgpt automation adapter tests passed');
}
replyTests().catch(error => { console.error(error); process.exitCode = 1; });
