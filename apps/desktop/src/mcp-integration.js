const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFile, spawn } = require('node:child_process');

const { whereBinary } = require('./provider-registry');
const { ROOT, SOURCE_ROOT, PACKAGED_CORE, resolvePython } = require('./core-api');

const MCP_HOST = '127.0.0.1';
const MCP_PORT = 8787;
const MCP_ENDPOINT = `http://${MCP_HOST}:${MCP_PORT}/mcp`;
const ANTIGRAVITY_CONFIG = process.env.TEAMYRA_ANTIGRAVITY_MCP_CONFIG ||
  path.join(os.homedir(), '.gemini', 'config', 'mcp_config.json');

let ownedMcpProcess = null;
let startingMcp = null;

function execFilePromise(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    const useShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(file);
    execFile(file, args, {
      windowsHide: true,
      timeout: options.timeout || 20000,
      maxBuffer: options.maxBuffer || 2 * 1024 * 1024,
      encoding: 'utf8',
      shell: useShell,
      ...options
    }, (error, stdout, stderr) => {
      const result = { stdout: stdout || '', stderr: stderr || '' };
      if (error) {
        error.stdout = result.stdout;
        error.stderr = result.stderr;
        reject(error);
        return;
      }
      resolve(result);
    });
  });
}

function mcpRequest(method, params = {}, timeout = 1200) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method,
      params
    }));
    const req = http.request({
      host: MCP_HOST,
      port: MCP_PORT,
      path: '/mcp',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'Content-Length': payload.length
      },
      timeout
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (response.statusCode !== 200) {
          reject(new Error(`TEAMYRA MCP returned HTTP ${response.statusCode}: ${raw.slice(0, 300)}`));
          return;
        }
        try {
          resolve(JSON.parse(raw));
        } catch {
          reject(new Error('TEAMYRA MCP returned invalid JSON'));
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('TEAMYRA MCP readiness timeout')));
    req.on('error', reject);
    req.end(payload);
  });
}

async function isTeamyraMcpReady() {
  try {
    const response = await mcpRequest('ping');
    return response && !response.error;
  } catch {
    return false;
  }
}

async function spawnTeamyraMcp() {
  let file;
  let args;

  if (PACKAGED_CORE && fs.existsSync(PACKAGED_CORE)) {
    file = PACKAGED_CORE;
    args = ['mcp', 'http', '--host', MCP_HOST, '--port', String(MCP_PORT)];
  } else {
    const python = await resolvePython();
    file = python.file;
    args = [
      ...python.prefix,
      path.join(SOURCE_ROOT, 'bridge', 'teamyra_cli.py'),
      'mcp',
      'http',
      '--host',
      MCP_HOST,
      '--port',
      String(MCP_PORT)
    ];
  }

  const child = spawn(file, args, {
    windowsHide: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      TEAMYRA_ROOT: ROOT,
      ...(PACKAGED_CORE && fs.existsSync(PACKAGED_CORE) ? { TEAMYRA_CORE_EXE: PACKAGED_CORE } : {})
    }
  });
  ownedMcpProcess = child;
  child.once('exit', () => {
    if (ownedMcpProcess === child) ownedMcpProcess = null;
  });
  child.once('error', () => {
    if (ownedMcpProcess === child) ownedMcpProcess = null;
  });
  return child;
}

async function ensureTeamyraMcp() {
  if (await isTeamyraMcpReady()) {
    return { ok: true, running: true, endpoint: MCP_ENDPOINT, owned: Boolean(ownedMcpProcess) };
  }
  if (startingMcp) return startingMcp;

  startingMcp = (async () => {
    await spawnTeamyraMcp();
    for (let attempt = 0; attempt < 35; attempt += 1) {
      if (await isTeamyraMcpReady()) {
        return { ok: true, running: true, endpoint: MCP_ENDPOINT, owned: true };
      }
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    throw new Error('TEAMYRA MCP did not become ready on ' + MCP_ENDPOINT);
  })().finally(() => {
    startingMcp = null;
  });

  return startingMcp;
}

function stopOwnedMcp() {
  if (!ownedMcpProcess) return;
  try { ownedMcpProcess.kill(); } catch {}
  ownedMcpProcess = null;
}

function providerBinaryName(providerId) {
  if (providerId === 'claude') return 'claude';
  if (providerId === 'codex') return 'codex';
  if (providerId === 'antigravity') return 'agy';
  return '';
}

function parseCliConnectionOutput(output) {
  const text = String(output || '');
  const hasName = /\bteamyra\b/i.test(text);
  return {
    hasName,
    connected: hasName && text.includes(MCP_ENDPOINT)
  };
}

async function cliConnectionStatus(providerId) {
  const binName = providerBinaryName(providerId);
  const binary = await whereBinary(binName);
  if (!binary) {
    return { providerId, installed: false, connected: false, endpoint: MCP_ENDPOINT, detail: 'CLI not installed' };
  }
  try {
    const { stdout, stderr } = await execFilePromise(binary, ['mcp', 'list'], { timeout: 15000 });
    const parsed = parseCliConnectionOutput(stdout + '\n' + stderr);
    return {
      providerId,
      installed: true,
      connected: parsed.connected,
      existingName: parsed.hasName,
      endpoint: MCP_ENDPOINT,
      detail: parsed.connected ? 'TEAMYRA MCP connected' : parsed.hasName ? 'TEAMYRA name already exists with another endpoint' : 'Not connected'
    };
  } catch (error) {
    return {
      providerId,
      installed: true,
      connected: false,
      endpoint: MCP_ENDPOINT,
      detail: String(error.stderr || error.stdout || error.message || 'Could not read MCP status').trim().slice(0, 500)
    };
  }
}

function readAntigravityConfig() {
  if (!fs.existsSync(ANTIGRAVITY_CONFIG)) return {};
  const raw = fs.readFileSync(ANTIGRAVITY_CONFIG, 'utf8').trim();
  if (!raw) return {};
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Antigravity MCP config must contain a JSON object');
  }
  return parsed;
}

function mergeAntigravityConfigObject(config) {
  const next = { ...(config || {}) };
  const servers = next.mcpServers && typeof next.mcpServers === 'object' && !Array.isArray(next.mcpServers)
    ? { ...next.mcpServers }
    : {};
  servers.teamyra = { serverUrl: MCP_ENDPOINT };
  next.mcpServers = servers;
  return next;
}

function writeAntigravityConfig(config) {
  fs.mkdirSync(path.dirname(ANTIGRAVITY_CONFIG), { recursive: true });
  const temp = ANTIGRAVITY_CONFIG + '.teamyra-' + process.pid + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(config, null, 2) + '\n', 'utf8');
  fs.renameSync(temp, ANTIGRAVITY_CONFIG);
}

async function antigravityConnectionStatus() {
  const binary = await whereBinary('agy');
  if (!binary) {
    return { providerId: 'antigravity', installed: false, connected: false, endpoint: MCP_ENDPOINT, detail: 'CLI not installed' };
  }
  try {
    const config = readAntigravityConfig();
    const entry = config?.mcpServers?.teamyra;
    const connected = Boolean(entry && entry.serverUrl === MCP_ENDPOINT && entry.disabled !== true);
    return {
      providerId: 'antigravity',
      installed: true,
      connected,
      existingName: Boolean(entry),
      endpoint: MCP_ENDPOINT,
      detail: connected ? 'TEAMYRA MCP connected' : entry ? 'TEAMYRA entry uses another endpoint or is disabled' : 'Not connected'
    };
  } catch (error) {
    return {
      providerId: 'antigravity',
      installed: true,
      connected: false,
      endpoint: MCP_ENDPOINT,
      detail: String(error.message || error).slice(0, 500)
    };
  }
}

async function getProviderMcpStatus(providerId) {
  if (providerId === 'antigravity') return antigravityConnectionStatus();
  if (providerId === 'claude' || providerId === 'codex') return cliConnectionStatus(providerId);
  return { providerId, installed: false, connected: false, endpoint: MCP_ENDPOINT, detail: 'Unsupported provider' };
}

async function getMcpConnections() {
  const [serviceRunning, claude, codex, antigravity] = await Promise.all([
    isTeamyraMcpReady(),
    getProviderMcpStatus('claude'),
    getProviderMcpStatus('codex'),
    getProviderMcpStatus('antigravity')
  ]);
  return {
    endpoint: MCP_ENDPOINT,
    service: { running: serviceRunning },
    providers: { claude, codex, antigravity }
  };
}

async function connectTeamyraMcp(providerId) {
  if (!['claude', 'codex', 'antigravity'].includes(providerId)) {
    return { ok: false, providerId, reason: 'unsupported-provider' };
  }

  await ensureTeamyraMcp();
  const before = await getProviderMcpStatus(providerId);
  if (!before.installed) return { ok: false, providerId, reason: 'provider-cli-not-found', status: before };
  if (before.connected) return { ok: true, providerId, alreadyConnected: true, status: before };
  if (before.existingName) {
    return { ok: false, providerId, reason: 'teamyra-name-conflict', status: before };
  }

  if (providerId === 'antigravity') {
    try {
      writeAntigravityConfig(mergeAntigravityConfigObject(readAntigravityConfig()));
    } catch (error) {
      return { ok: false, providerId, reason: 'config-write-failed', error: String(error.message || error) };
    }
  } else {
    const binary = await whereBinary(providerBinaryName(providerId));
    const args = providerId === 'claude'
      ? ['mcp', 'add', '--transport', 'http', '--scope', 'user', 'teamyra', MCP_ENDPOINT]
      : ['mcp', 'add', 'teamyra', '--url', MCP_ENDPOINT];
    try {
      await execFilePromise(binary, args, { timeout: 30000 });
    } catch (error) {
      return {
        ok: false,
        providerId,
        reason: 'provider-command-failed',
        error: String(error.stderr || error.stdout || error.message || error).trim().slice(0, 1000)
      };
    }
  }

  const status = await getProviderMcpStatus(providerId);
  return { ok: status.connected, providerId, status, reason: status.connected ? null : 'verification-failed' };
}

module.exports = {
  MCP_ENDPOINT,
  ANTIGRAVITY_CONFIG,
  ensureTeamyraMcp,
  stopOwnedMcp,
  isTeamyraMcpReady,
  getMcpConnections,
  getProviderMcpStatus,
  connectTeamyraMcp,
  mergeAntigravityConfigObject,
  parseCliConnectionOutput
};
