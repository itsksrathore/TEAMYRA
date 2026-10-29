const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// The public api.elevenlabs.io alias advertises OAuth metadata for api.us.
// Use that canonical origin so the MCP client's resource validation agrees.
const ELEVENLABS_MCP_URL = 'https://api.us.elevenlabs.io/v1/mcp';
const CLIENT_METADATA_URL = 'https://cdn.jsdelivr.net/gh/itsksrathore/TEAMYRA@main/docs/oauth/elevenlabs-client.json';
const FIRST_CALLBACK_PORT = 47681;
const LAST_CALLBACK_PORT = 47696;
const PROFILE_ID = /^[a-z0-9][a-z0-9_-]{0,52}$/;

function serverName(id) {
  if (!PROFILE_ID.test(String(id || ''))) throw new Error('Invalid ElevenLabs account profile');
  return 'elevenlabs-' + id;
}

async function callPoolTool(name, args, { ensureMcp, endpoint, fetchImpl = globalThis.fetch, timeout = 300000 }) {
  await ensureMcp();
  const response = await fetchImpl(endpoint, {
    method: 'POST', redirect: 'error',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-06-18' },
    body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method: 'tools/call', params: { name, arguments: args } }),
    signal: AbortSignal.timeout(timeout + 15000)
  });
  if (!response.ok) throw new Error('TEAMYRA MCP pool request failed (HTTP ' + response.status + ')');
  const message = await response.json();
  if (message.error) throw new Error(message.error.message || 'TEAMYRA MCP request failed');
  const content = message.result?.content?.find(block => block.type === 'text')?.text;
  let value;
  try { value = JSON.parse(content); }
  catch { throw new Error('TEAMYRA MCP pool returned an invalid response'); }
  if (message.result.isError) throw new Error(value.error || 'TEAMYRA MCP tool failed');
  return value;
}

class ElevenLabsMcp {
  constructor({ root, runtime, adapterPath, poolCall, invalidate = () => {}, onState = () => {}, metadataUrl = CLIENT_METADATA_URL, fetchMetadata = globalThis.fetch }) {
    Object.assign(this, { root, runtime, adapterPath, poolCall, invalidate, onState, metadataUrl, fetchMetadata });
    this.states = new Map();
    this.pending = new Map();
    this.calls = new Set();
    this.registration = Promise.resolve();
    this.oauthWaitMs = 240000;
    this.oauthPollMs = 500;
  }

  profile(id) {
    serverName(id);
    let value;
    try { value = JSON.parse(fs.readFileSync(path.join(this.root, 'profiles', 'elevenlabs', id, 'teamyra-profile.json'), 'utf8')); }
    catch { throw new Error('ElevenLabs account profile not found'); }
    if (value.provider !== 'elevenlabs' || value.enabled === false) throw new Error('ElevenLabs profile is disabled or invalid');
    return value;
  }

  writeProfile(id, profile) {
    serverName(id);
    const file = path.join(this.root, 'profiles', 'elevenlabs', id, 'teamyra-profile.json');
    const temporary = file + '.' + crypto.randomUUID() + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify(profile, null, 2));
    fs.renameSync(temporary, file);
  }

  spec(id) {
    const profile = this.profile(id);
    let port = profile.oauth_callback_port;
    if (!Number.isInteger(port) || port < FIRST_CALLBACK_PORT || port > LAST_CALLBACK_PORT) {
      const folder = path.join(this.root, 'profiles', 'elevenlabs');
      const used = new Set(fs.readdirSync(folder, { withFileTypes: true }).filter(e => e.isDirectory()).flatMap(e => {
        try { return [JSON.parse(fs.readFileSync(path.join(folder, e.name, 'teamyra-profile.json'), 'utf8')).oauth_callback_port]; }
        catch { return []; }
      }));
      port = FIRST_CALLBACK_PORT;
      while (used.has(port) && port <= LAST_CALLBACK_PORT) port++;
      if (port > LAST_CALLBACK_PORT) throw new Error('All 16 published OAuth callback slots are allocated');
      this.writeProfile(id, { ...profile, oauth_callback_port: port });
    }
    const revision = Number.isSafeInteger(profile.oauth_login_revision) && profile.oauth_login_revision > 0 ? profile.oauth_login_revision : 0;
    const identity = this.metadataUrl + (revision ? '\nlogin:' + revision : '');
    return {
      server: serverName(id),
      command: [this.runtime, this.adapterPath, ELEVENLABS_MCP_URL, String(port),
        '--host', '127.0.0.1', '--client-metadata-url', this.metadataUrl,
        '--transport', 'http-only', '--auth-timeout', '240', '--silent'],
      cwd: this.root,
      env: { ELECTRON_RUN_AS_NODE: '1', MCP_REMOTE_CONFIG_DIR: path.join(this.root, 'profiles', 'elevenlabs', id, 'oauth',
        crypto.createHash('sha256').update(identity).digest('hex').slice(0, 16)) },
      // Keep the browser callback alive for 240s, but do not let a stalled
      // initialize hide a completed authorization for five minutes.
      enabled: true, timeout_seconds: 20, confirm: true,
      accountName: String(profile.name || id), callbackPort: port
    };
  }

  getState(id) {
    return { profileId: id, server: serverName(id), endpoint: ELEVENLABS_MCP_URL,
      state: 'not_connected', toolCount: 0, ...this.states.get(id) };
  }

  setState(id, patch) {
    const before = this.getState(id);
    this.states.set(id, { ...before, ...patch });
    if (['state', 'phase', 'error', 'toolCount'].some(key => before[key] !== patch[key] && key in patch)) {
      this.invalidate();
      this.onState(this.getState(id));
    }
    return this.getState(id);
  }

  credentialVersion(spec) {
    // Inspect only this profile's adapter store. Never return token contents to
    // the renderer or infer account identity from a local profile name.
    const folder = spec.env.MCP_REMOTE_CONFIG_DIR;
    try {
      const hashes = [];
      for (const version of fs.readdirSync(folder, { withFileTypes: true })) {
        if (!version.isDirectory() || !version.name.startsWith('mcp-remote-v')) continue;
        const directory = path.join(folder, version.name);
        for (const file of fs.readdirSync(directory).sort()) {
          if (!file.endsWith('_tokens.json')) continue;
          const raw = fs.readFileSync(path.join(directory, file), 'utf8');
          const token = JSON.parse(raw);
          if (typeof token.access_token === 'string' && token.access_token) {
            hashes.push(crypto.createHash('sha256').update(raw).digest('hex'));
          }
        }
      }
      return hashes.sort().join(':');
    } catch { return ''; }
  }

  async discover(id, spec) {
    const before = this.credentialVersion(spec);
    const deadline = Date.now() + this.oauthWaitMs;
    const list = () => this.poolCall('mcp_pool_tools', { server: spec.server, refresh: true, detail: 'full' });
    try { return await list(); }
    catch (error) {
      // Only recover an initial handshake after new OAuth credentials arrived.
      // Tool calls, quota errors and other provider failures are never retried.
      if (!/pooled MCP request timed out.*\.initialize\b/.test(String(error?.message))) throw error;
      let after = this.credentialVersion(spec);
      if (before && after === before) throw error;
      this.setState(id, { phase: 'authorizing' });
      while ((!after || after === before) && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, this.oauthPollMs));
        after = this.credentialVersion(spec);
      }
      if (!after || after === before) throw error;
      this.setState(id, { phase: 'loading_tools' });
      // The first initialize has settled, so the pool can restart its
      // uninitialized adapter using the saved login. At most one recovery.
      return list();
    }
  }

  async register(id) {
    // Serialize read/modify/write of the shared pool config across account connects.
    const task = this.registration.catch(() => {}).then(async () => {
      const spec = this.spec(id);
      let config = { servers: {} };
      const file = path.join(this.root, 'profiles', 'mcp-pool.json');
      if (fs.existsSync(file)) config = JSON.parse(fs.readFileSync(file, 'utf8'));
      const previous = config.servers?.[spec.server];
      if (previous) {
        const oauthRoot = path.join(this.root, 'profiles', 'elevenlabs', id, 'oauth');
        const relativeStore = typeof previous.env?.MCP_REMOTE_CONFIG_DIR === 'string'
          ? path.relative(oauthRoot, previous.env.MCP_REMOTE_CONFIG_DIR) : '..';
        const ours = (previous.command?.includes(ELEVENLABS_MCP_URL) || previous.command?.includes('https://api.elevenlabs.io/v1/mcp')) &&
          (relativeStore === '' || /^[a-f0-9]{16}$/.test(relativeStore));
        if (!ours) throw new Error('A different MCP server already uses this profile name; its configuration was preserved');
        if (JSON.stringify(previous.command) === JSON.stringify(spec.command) && previous.enabled !== false &&
            previous.env?.MCP_REMOTE_CONFIG_DIR === spec.env.MCP_REMOTE_CONFIG_DIR &&
            previous.env?.ELECTRON_RUN_AS_NODE === spec.env.ELECTRON_RUN_AS_NODE &&
            previous.cwd === spec.cwd && previous.timeout_seconds === spec.timeout_seconds) return spec;
      }
      const { accountName, callbackPort, ...registration } = spec;
      await this.poolCall('mcp_pool_register', registration);
      return spec;
    });
    this.registration = task;
    return task;
  }

  async connect(id) {
    if (this.pending.has(id)) return this.pending.get(id);
    this.setState(id, { state: 'connecting', phase: 'authorizing', error: null });
    const task = (async () => {
      try {
        const spec = await this.register(id);
        await this.validateMetadata(spec);
        const listing = await this.discover(id, spec);
        if (!Array.isArray(listing.tools)) throw new Error('ElevenLabs MCP returned an invalid tool catalog');
        this.setState(id, { state: 'connected', phase: null, toolCount: listing.tools.length, checkedAt: new Date().toISOString(), error: null });
        return { ...this.getState(id), tools: listing.tools };
      } catch (error) {
        this.setState(id, { state: 'error', phase: null, error: 'MCP connection failed. Complete browser sign-in or check network access, then retry.' });
        throw error;
      }
    })().finally(() => this.pending.delete(id));
    this.pending.set(id, task);
    return task;
  }

  async validateMetadata(spec) {
    let metadata;
    try {
      const url = new URL(this.metadataUrl);
      if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('Invalid OAuth metadata URL');
      const response = await this.fetchMetadata(this.metadataUrl, { redirect: 'error', signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error('OAuth metadata is not published');
      if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') || '')) {
        const error = new Error('OAuth client metadata must be served with Content-Type application/json. A raw GitHub URL serving text/plain cannot authorize ElevenLabs.');
        error.code = 'OAUTH_METADATA_CONTENT_TYPE';
        throw error;
      }
      metadata = await response.json();
    } catch (error) {
      if (error.code === 'OAUTH_METADATA_CONTENT_TYPE') throw error;
      throw new Error('Publish TEAMYRA OAuth client metadata at ' + this.metadataUrl + ' before connecting ElevenLabs. See docs/ELEVENLABS_MCP.md.');
    }
    const callback = 'http://127.0.0.1:' + spec.callbackPort + '/oauth/callback';
    if (metadata.client_id !== this.metadataUrl || metadata.token_endpoint_auth_method !== 'none' || !metadata.redirect_uris?.includes(callback)) {
      throw new Error('Published OAuth client metadata does not match TEAMYRA or its localhost callback');
    }
  }

  async reauthorize(id) {
    if (this.pending.has(id) || this.calls.has(id)) throw new Error('Wait for this profile\'s current MCP operation to finish');
    const profile = this.profile(id);
    const previous = Number.isSafeInteger(profile.oauth_login_revision) && profile.oauth_login_revision >= 0 ? profile.oauth_login_revision : 0;
    if (previous >= 1000000) throw new Error('OAuth sign-in revision limit reached');
    // Retain the previous credentials in their own ignored adapter store. A new
    // store starts OAuth again without revoking another profile's grant.
    this.writeProfile(id, { ...profile, oauth_login_revision: previous + 1 });
    this.setState(id, { state: 'not_connected', toolCount: 0, error: null });
    return this.connect(id);
  }

  async status(id) {
    this.profile(id);
    if (this.pending.has(id)) return this.getState(id);
    await this.syncStatuses([id]);
    return this.getState(id);
  }

  async syncStatuses(ids) {
    if (!ids.length) return;
    const result = await this.poolCall('mcp_pool_list', {});
    for (const id of ids) {
      if (this.pending.has(id)) continue;
      const entry = result.servers?.find(item => item.name === serverName(id));
      this.setState(id, { state: entry?.running && entry.initialized_at ? 'connected' : entry ? 'configured' : 'not_connected',
        phase: null, toolCount: entry?.tool_count || 0, checkedAt: new Date().toISOString(), error: null });
    }
  }

  async call(id, toolName, args) {
    this.profile(id);
    if (this.pending.has(id)) throw new Error('This account is still connecting');
    if (this.calls.has(id)) throw new Error('An ElevenLabs MCP tool call is already running for this account');
    if (!toolName || typeof toolName !== 'string' || toolName.length > 200) throw new Error('Choose an MCP tool');
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Tool arguments must be a JSON object');
    this.calls.add(id);
    try {
      return await this.poolCall('mcp_pool_call', { server: serverName(id), tool_name: toolName, arguments: args, timeout_seconds: 300 });
    } finally { this.calls.delete(id); }
  }

  hasActiveWork() { return this.pending.size > 0 || this.calls.size > 0; }
}

function registerElevenLabsMcp({ electron, root, ensureMcp, endpoint, getWindow, invalidate }) {
  const adapterPackage = require.resolve('mcp-remote/package.json');
  const service = new ElevenLabsMcp({
    root, runtime: process.execPath, adapterPath: path.join(path.dirname(adapterPackage), 'dist', 'proxy.js'),
    poolCall: (name, args) => callPoolTool(name, args, { ensureMcp, endpoint }), invalidate,
    onState: state => {
      const window = getWindow();
      if (window && !window.isDestroyed?.()) window.webContents.send('teamyra:elevenlabs-mcp-state', state);
    }
  });
  for (const [action, handler] of Object.entries({
    status: id => service.status(id), connect: id => service.connect(id),
    reauthorize: id => service.reauthorize(id),
    call: options => service.call(options?.profileId, options?.toolName, options?.arguments)
  })) {
    electron.ipcMain.handle('teamyra:elevenlabs-mcp-' + action, (event, options) => {
      if (!getWindow() || event.sender !== getWindow().webContents) throw new Error('Use ElevenLabs MCP from the TEAMYRA window');
      return handler(options);
    });
  }
  return service;
}

module.exports = { ElevenLabsMcp, registerElevenLabsMcp, serverName, callPoolTool, ELEVENLABS_MCP_URL, CLIENT_METADATA_URL };
