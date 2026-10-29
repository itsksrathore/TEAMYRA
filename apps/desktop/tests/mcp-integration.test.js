const assert = require('node:assert/strict');

const {
  MCP_ENDPOINT,
  gatewayIdentityError,
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
const { ROOT, PACKAGED_CORE } = require('../src/core-api');
assert.equal(gatewayIdentityError({ runtime_root: ROOT, core_exe: PACKAGED_CORE }), null);
assert.match(gatewayIdentityError({ runtime_root: '/another-teamyra' }), /another or older/);
assert.match(gatewayIdentityError({ service: 'teamyra-wake-gateway' }), /another or older/);

// A live gateway on Windows may take more than a second to summarize its
// backend. A healthy delayed response must not trigger duplicate startup.
(async () => {
  const http = require('node:http');
  const { EventEmitter } = require('node:events');
  const { gatewayHealth } = require('../src/mcp-integration');
  const original = http.request;
  http.request = (options, callback) => {
    const request = new EventEmitter();
    let slowResponse;
    let deadline;
    request.destroy = () => { clearTimeout(slowResponse); clearTimeout(deadline); };
    request.end = () => {
      deadline = setTimeout(() => request.emit('timeout'), options.timeout);
      slowResponse = setTimeout(() => {
        clearTimeout(deadline);
        const response = new EventEmitter();
        response.statusCode = 200;
        callback(response);
        response.emit('data', Buffer.from(JSON.stringify({ service: 'teamyra-wake-gateway' })));
        response.emit('end');
      }, 1200);
    };
    return request;
  };
  try {
    assert.equal((await gatewayHealth())?.service, 'teamyra-wake-gateway');
    assert.equal(await gatewayHealth(20), null, 'explicit short timeout must still be honored');
    console.log('delayed MCP gateway readiness regression passed');
  } finally { http.request = original; }
})().catch(error => { console.error(error); process.exitCode = 1; });
