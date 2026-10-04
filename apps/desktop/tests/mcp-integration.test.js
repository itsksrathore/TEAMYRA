const assert = require('node:assert/strict');

const {
  MCP_ENDPOINT,
  mergeAntigravityConfigObject,
  parseCliConnectionOutput
} = require('../src/mcp-integration');

const source = {
  keepMe: true,
  mcpServers: {
    existing: { serverUrl: 'https://example.invalid/mcp' }
  }
};
const merged = mergeAntigravityConfigObject(source);

assert.equal(merged.keepMe, true);
assert.deepEqual(merged.mcpServers.existing, source.mcpServers.existing);
assert.deepEqual(merged.mcpServers.teamyra, { serverUrl: MCP_ENDPOINT });
assert.equal(source.mcpServers.teamyra, undefined);

assert.equal(
  parseCliConnectionOutput(`teamyra  ${MCP_ENDPOINT}`).connected,
  true
);
assert.equal(
  parseCliConnectionOutput('teamyra  http://127.0.0.1:9999/mcp').connected,
  false
);
assert.equal(
  parseCliConnectionOutput('other  http://127.0.0.1:8787/mcp').hasName,
  false
);

console.log('mcp integration helper tests passed');
