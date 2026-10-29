const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { ElevenLabsMcp, serverName, callPoolTool, ELEVENLABS_MCP_URL, CLIENT_METADATA_URL, registerElevenLabsMcp } = require('../src/elevenlabs-mcp');

function fixture(t, impl) {
  const parent = path.resolve(__dirname, '../../../.teamyra-desktop/elevenlabs-mcp-tests');
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'case-'));
  t.after(() => {
    assert(path.resolve(root).startsWith(parent + path.sep));
    fs.rmSync(root, { recursive: true, force: true });
  });
  for (const id of ['account-1', 'account-2', 'account-3']) {
    const folder = path.join(root, 'profiles', 'elevenlabs', id);
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'teamyra-profile.json'), JSON.stringify({ provider: 'elevenlabs', name: id, enabled: true }));
  }
  const calls = [];
  const poolCall = async (name, args) => {
    calls.push({ name, args });
    if (impl) return impl(name, args);
    if (name === 'mcp_pool_list') return { servers: [] };
    if (name === 'mcp_pool_tools') return { tools: [{ name: 'text_to_speech', inputSchema: { type: 'object' } }] };
    if (name === 'mcp_pool_call') return { result: { content: [{ type: 'text', text: 'generated' }] } };
    return {};
  };
  const fetchMetadata = async () => Response.json({ client_id: CLIENT_METADATA_URL, token_endpoint_auth_method: 'none',
    redirect_uris: Array.from({ length: 16 }, (_, i) => `http://127.0.0.1:${47681 + i}/oauth/callback`) });
  return { root, calls, poolCall, service: new ElevenLabsMcp({ root, runtime: process.execPath, adapterPath: '/adapter/proxy.js', poolCall, fetchMetadata }) };
}

test('three accounts register the official hosted endpoint with isolated OAuth stores', async t => {
  const { service, calls } = fixture(t);
  await Promise.all(['account-1', 'account-2', 'account-3'].map(id => service.connect(id)));
  const specs = calls.filter(c => c.name === 'mcp_pool_register').map(c => c.args);
  assert.equal(specs.length, 3);
  assert.equal(new Set(specs.map(s => s.server)).size, 3);
  assert.equal(new Set(specs.map(s => s.env.MCP_REMOTE_CONFIG_DIR)).size, 3);
  assert.equal(new Set(specs.map(s => s.command[3])).size, 3);
  for (const spec of specs) {
    assert(spec.command.includes(ELEVENLABS_MCP_URL));
    assert(spec.command.includes('http-only'));
    assert(spec.command.includes('--client-metadata-url'));
    assert.equal(spec.env.ELECTRON_RUN_AS_NODE, '1');
    assert(!JSON.stringify(spec).includes('API_KEY'));
    assert.equal(spec.timeout_seconds, 20);
  }
  assert.equal(service.getState('account-1').toolCount, 1);
  assert.equal(service.getState('account-1').state, 'connected');
});

test('status check does not trigger OAuth or tool discovery', async t => {
  const { service, calls } = fixture(t);
  assert.equal((await service.status('account-1')).state, 'not_connected');
  assert.deepEqual(calls.map(c => c.name), ['mcp_pool_list']);
});

test('unpublished OAuth identity is reported before starting authentication', async t => {
  const { service, calls } = fixture(t);
  service.fetchMetadata = async () => new Response('Not found', { status: 404 });
  await assert.rejects(service.connect('account-1'), /Publish TEAMYRA OAuth client metadata/);
  assert.equal(calls.filter(c => c.name === 'mcp_pool_tools').length, 0);
});

test('OAuth identity callback and client id must match the published document', async t => {
  const { service } = fixture(t);
  const spec = service.spec('account-1');
  service.fetchMetadata = async () => Response.json({ client_id: 'https://other.example/client.json', token_endpoint_auth_method: 'none', redirect_uris: [] });
  await assert.rejects(service.validateMetadata(spec), /does not match/);
  assert.equal(service.spec('account-1').callbackPort, spec.callbackPort, 'callback allocation survives reconnects');
});

test('rejects text/plain metadata before opening a provider OAuth flow', async t => {
  const { service, calls } = fixture(t);
  service.fetchMetadata = async () => new Response('{}', { headers: { 'content-type': 'text/plain' } });
  await assert.rejects(service.connect('account-1'), /Content-Type application\/json/);
  assert.equal(calls.filter(c => c.name === 'mcp_pool_tools').length, 0);
});

test('concurrent connect clicks share one discovery request', async t => {
  const { service, calls } = fixture(t);
  await Promise.all([service.connect('account-1'), service.connect('account-1')]);
  assert.equal(calls.filter(c => c.name === 'mcp_pool_tools').length, 1);
  assert.equal(service.hasActiveWork(), false);
});

test('failed discovery does not report connected or retry a different account', async t => {
  const { service, calls } = fixture(t, async name => {
    if (name === 'mcp_pool_tools') throw new Error('provider refused access');
    return {};
  });
  await assert.rejects(service.connect('account-1'), /refused/);
  assert.equal(service.getState('account-1').state, 'error');
  assert.equal(service.getState('account-2').state, 'not_connected');
  assert.equal(calls.filter(c => c.name === 'mcp_pool_tools').length, 1);
  assert.equal(service.hasActiveWork(), false);
});

test('foreign existing pool configuration is preserved', async t => {
  const { service, root, calls } = fixture(t);
  const file = path.join(root, 'profiles', 'mcp-pool.json');
  const value = JSON.stringify({ servers: { [serverName('account-1')]: { command: ['other-tool'] } } });
  fs.writeFileSync(file, value);
  await assert.rejects(service.register('account-1'), /preserved/);
  assert.equal(fs.readFileSync(file, 'utf8'), value);
  assert.equal(calls.length, 0);
});

test('matching registration is reused without restarting a shared process', async t => {
  const { service, root, calls } = fixture(t);
  const spec = service.spec('account-1');
  fs.writeFileSync(path.join(root, 'profiles', 'mcp-pool.json'), JSON.stringify({ servers: { [spec.server]: spec } }));
  await service.register('account-1');
  assert.equal(calls.length, 0);
});

test('changing OAuth client identity isolates old tokens and preserves the old store', async t => {
  const { service, root } = fixture(t);
  const first = service.spec('account-1');
  fs.mkdirSync(first.env.MCP_REMOTE_CONFIG_DIR, { recursive: true });
  const marker = path.join(first.env.MCP_REMOTE_CONFIG_DIR, 'old-login-marker');
  fs.writeFileSync(marker, 'preserve');
  fs.writeFileSync(path.join(root, 'profiles', 'mcp-pool.json'), JSON.stringify({ servers: { [first.server]: first } }));
  service.metadataUrl = 'https://client.example.test/new-identity.json';
  const changed = await service.register('account-1');
  assert.notEqual(changed.env.MCP_REMOTE_CONFIG_DIR, first.env.MCP_REMOTE_CONFIG_DIR);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'preserve');
});

test('migrates a legacy OAuth directory even when the command itself already matches', async t => {
  const { service, root, calls } = fixture(t);
  const spec = service.spec('account-1');
  const legacy = { ...spec, env: { ...spec.env, MCP_REMOTE_CONFIG_DIR: path.join(root, 'profiles', 'elevenlabs', 'account-1', 'oauth') } };
  fs.writeFileSync(path.join(root, 'profiles', 'mcp-pool.json'), JSON.stringify({ servers: { [spec.server]: legacy } }));
  await service.register('account-1');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args.env.MCP_REMOTE_CONFIG_DIR, spec.env.MCP_REMOTE_CONFIG_DIR);
});

test('account switching creates a fresh store and preserves other profiles and old credentials', async t => {
  const { service } = fixture(t);
  const first = service.spec('account-1');
  const old = service.spec('account-2');
  fs.mkdirSync(old.env.MCP_REMOTE_CONFIG_DIR, { recursive: true });
  const marker = path.join(old.env.MCP_REMOTE_CONFIG_DIR, 'old-login-marker');
  fs.writeFileSync(marker, 'preserve');
  await service.reauthorize('account-2');
  const changed = service.spec('account-2');
  assert.notEqual(changed.env.MCP_REMOTE_CONFIG_DIR, old.env.MCP_REMOTE_CONFIG_DIR);
  assert.equal(changed.callbackPort, old.callbackPort);
  assert.equal(service.spec('account-1').env.MCP_REMOTE_CONFIG_DIR, first.env.MCP_REMOTE_CONFIG_DIR);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'preserve');
});

test('tool calls target only the selected account and are not automatically retried', async t => {
  const { service, calls } = fixture(t, async name => {
    if (name === 'mcp_pool_call') throw new Error('connection interrupted');
    return {};
  });
  await assert.rejects(service.call('account-2', 'text_to_speech', { text: 'Namaste' }), /interrupted/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args.server, serverName('account-2'));
  assert.equal(service.hasActiveWork(), false);
});

test('duplicate calls are refused while one call is active and idle exit is held', async t => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const { service } = fixture(t, () => pending);
  const first = service.call('account-1', 'text_to_speech', {});
  assert.equal(service.hasActiveWork(), true);
  await assert.rejects(service.call('account-1', 'text_to_speech', {}), /already running/);
  release({ result: {} });
  await first;
  assert.equal(service.hasActiveWork(), false);
});

test('rejects invalid profiles and non-object tool arguments', async t => {
  const { service } = fixture(t);
  for (const id of ['../outside', '', 'Account']) assert.throws(() => serverName(id));
  await assert.rejects(service.connect('missing'), /not found/);
  await assert.rejects(service.call('account-1', 'tool', []), /JSON object/);
});

test('local MCP bridge sends tools/call and decodes nested MCP results', async () => {
  let ready = false;
  const value = await callPoolTool('mcp_pool_tools', { server: 'example' }, {
    ensureMcp: async () => { ready = true; }, endpoint: 'http://127.0.0.1:8787/mcp',
    fetchImpl: async (url, options) => {
      assert(ready);
      assert.equal(url, 'http://127.0.0.1:8787/mcp');
      const message = JSON.parse(options.body);
      assert.equal(message.method, 'tools/call');
      assert.equal(message.params.name, 'mcp_pool_tools');
      return Response.json({ result: { content: [{ type: 'text', text: JSON.stringify({ tools: [] }) }], isError: false } });
    }
  });
  assert.deepEqual(value, { tools: [] });
  await assert.rejects(callPoolTool('mcp_pool_tools', {}, {
    ensureMcp: async () => {}, endpoint: 'http://127.0.0.1:8787/mcp',
    fetchImpl: async () => Response.json({ result: { content: [{ type: 'text', text: '{"error":"no access"}' }], isError: true } })
  }), /no access/);
});

test('remote web contents cannot invoke account connection or tool calls', async t => {
  const { root } = fixture(t);
  const handlers = new Map();
  const owner = { webContents: {} };
  registerElevenLabsMcp({ root, endpoint: 'http://127.0.0.1:8787/mcp', ensureMcp: async () => {},
    getWindow: () => owner, electron: { ipcMain: { handle: (name, fn) => handlers.set(name, fn) } } });
  assert.equal(handlers.size, 4);
  for (const handler of handlers.values()) assert.throws(() => handler({ sender: {} }, 'account-1'), /TEAMYRA window/);
});

function saveOAuthToken(service, id, token = 'local-fixture-token') {
  const folder = path.join(service.spec(id).env.MCP_REMOTE_CONFIG_DIR, 'mcp-remote-v1');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'fixture_tokens.json'), JSON.stringify({ access_token: token }));
}

test('browser authorization followed by a stalled initialize reconnects with the saved login', async t => {
  const { service, calls } = fixture(t);
  let attempts = 0;
  service.poolCall = async (name, args) => {
    calls.push({ name, args });
    if (name !== 'mcp_pool_tools') return {};
    if (++attempts === 1) {
      saveOAuthToken(service, 'account-2');
      throw new Error('pooled MCP request timed out after 20s: elevenlabs-account-2.initialize');
    }
    return { tools: [{ name: 'agents_list' }] };
  };
  const result = await service.connect('account-2');
  assert.equal(result.state, 'connected');
  assert.equal(attempts, 2);
  assert(calls.filter(c => c.name === 'mcp_pool_tools').every(c => c.args.server === 'elevenlabs-account-2'));
  // The dialog shows input schemas, so it must not get the compact listing.
  assert(calls.filter(c => c.name === 'mcp_pool_tools').every(c => c.args.detail === 'full'));
  assert(!calls.some(c => c.name === 'mcp_pool_call'));
});

test('authorization can finish after the first initialize deadline without another Connect click', async t => {
  const { service } = fixture(t);
  service.oauthWaitMs = 300;
  service.oauthPollMs = 5;
  let attempts = 0;
  service.poolCall = async name => {
    if (name !== 'mcp_pool_tools') return {};
    if (++attempts === 1) {
      setTimeout(() => saveOAuthToken(service, 'account-1'), 20);
      throw new Error('pooled MCP request timed out after 20s: elevenlabs-account-1.initialize');
    }
    return { tools: [] };
  };
  assert.equal((await service.connect('account-1')).state, 'connected');
  assert.equal(attempts, 2);
});

test('existing credentials do not turn arbitrary initialization failures into automatic retries', async t => {
  const { service } = fixture(t);
  saveOAuthToken(service, 'account-1');
  let attempts = 0;
  service.poolCall = async name => {
    if (name !== 'mcp_pool_tools') return {};
    attempts++;
    throw new Error('pooled MCP request timed out after 20s: elevenlabs-account-1.initialize');
  };
  await assert.rejects(service.connect('account-1'), /timed out/);
  assert.equal(attempts, 1);
});

test('OAuth recovery is bounded and never retries quota or provider refusal errors', async t => {
  for (const failure of ['quota exhausted', 'pooled MCP request timed out after 20s: elevenlabs-account-1.initialize']) {
    const { service } = fixture(t);
    let attempts = 0;
    service.poolCall = async name => {
      if (name !== 'mcp_pool_tools') return {};
      attempts++;
      saveOAuthToken(service, 'account-1', 'token-' + attempts);
      throw new Error(failure);
    };
    await assert.rejects(service.connect('account-1'), new RegExp(failure.includes('quota') ? 'quota' : 'timed out'));
    assert.equal(attempts, failure.includes('quota') ? 1 : 2);
  }
});

test('status refresh restores existing pooled connections after a desktop restart', async t => {
  const { service, calls } = fixture(t, async name => name === 'mcp_pool_list' ? { servers: [
    { name: 'elevenlabs-account-1', running: true, initialized_at: 123, tool_count: 163 },
    { name: 'elevenlabs-account-2', running: true, initialized_at: null, tool_count: 0 }
  ] } : {});
  await service.syncStatuses(['account-1', 'account-2', 'account-3']);
  assert.equal(service.getState('account-1').state, 'connected');
  assert.equal(service.getState('account-1').toolCount, 163);
  assert.equal(service.getState('account-2').state, 'configured');
  assert.equal(service.getState('account-3').state, 'not_connected');
  assert.deepEqual(calls.map(c => c.name), ['mcp_pool_list']);
});
