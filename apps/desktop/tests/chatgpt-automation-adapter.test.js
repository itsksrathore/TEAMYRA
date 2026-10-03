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

console.log('chatgpt automation adapter tests passed');
