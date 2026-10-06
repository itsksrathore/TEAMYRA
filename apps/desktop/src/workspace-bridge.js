const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { app } = require('electron');
const { callCore } = require('./core-api');

class WorkspaceBridge {
  constructor() {
    this.userData = app.getPath('userData');
    this.root = path.join(this.userData, 'security');
    this.tokenFile = path.join(this.root, 'local-agent.token');
    process.env.TEAMYRA_DESKTOP_USER_DATA = this.userData;
    process.env.TEAMYRA_LOCAL_AGENT_TOKEN_FILE = this.tokenFile;
    this.token = this.ensureToken();
    this.statusCache = null;
    this.statusPending = null;
    this.statusGeneration = 0;
  }

  ensureToken() {
    fs.mkdirSync(this.root, { recursive: true });
    try {
      const existing = fs.readFileSync(this.tokenFile, 'utf8').trim();
      if (existing.length >= 32) return existing;
    } catch {}
    const token = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(this.tokenFile, token, { encoding: 'utf8', mode: 0o600 });
    try { fs.chmodSync(this.tokenFile, 0o600); } catch {}
    return token;
  }

  coreOptions(extra = {}) {
    return {
      ...extra,
      env: {
        ...(extra.env || {}),
        TEAMYRA_LOCAL_AGENT_TOKEN: this.token
      }
    };
  }

  async configure(workspace, permissions = {}, access = null) {
    const result = await callCore('chatgpt.workspace.configure', {
      workspace: String(workspace || ''),
      permissions,
      ...(access ? { access, user_confirmed: true } : {})
    }, this.coreOptions());
    this.statusGeneration++;
    this.statusCache = null;
    this.statusPending = null;
    return result;
  }

  status() {
    if (this.statusCache && Date.now() - this.statusCache.at < 30000) return Promise.resolve(this.statusCache.value);
    if (this.statusPending) return this.statusPending;
    const generation = this.statusGeneration;
    const pending = callCore('chatgpt.workspace.status', {}, this.coreOptions()).then(value => {
      if (this.statusGeneration === generation) this.statusCache = { at: Date.now(), value };
      return value;
    }).finally(() => { if (this.statusPending === pending) this.statusPending = null; });
    this.statusPending = pending;
    return pending;
  }

  execute(tool, args = {}, confirm = false) {
    return callCore('chatgpt.tool.execute', {
      tool: String(tool || ''),
      args: args || {},
      confirm: confirm === true
    }, this.coreOptions({
      timeout: this.toolTimeout(tool, args),
      maxBuffer: 12 * 1024 * 1024
    }));
  }

  executeInWorkspace(workspace, tool, args = {}, permissions = null, confirm = false) {
    return callCore('chatgpt.tool.execute-in-workspace', {
      workspace: String(workspace || ''),
      tool: String(tool || ''),
      args: args || {},
      permissions: permissions && typeof permissions === 'object' ? permissions : undefined,
      confirm: confirm === true
    }, this.coreOptions({
      timeout: this.toolTimeout(tool, args),
      maxBuffer: 12 * 1024 * 1024
    }));
  }

  toolTimeout(tool, args) {
    if (tool !== 'terminal.run') return 45000;
    const seconds = Number(args?.timeout_seconds);
    return Number.isFinite(seconds) && seconds > 120
      ? Math.min(seconds, 1800) * 1000 + 15000 : 135000;
  }

  async changes() {
    const [status, diff, stagedDiff] = await Promise.all([
      this.execute('git.status', {}),
      this.execute('git.diff', {}),
      this.execute('git.diff', { staged: true })
    ]);
    return { status, diff, stagedDiff };
  }
}

module.exports = { WorkspaceBridge };
