const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { app } = require('electron');
const { callCore } = require('./core-api');

class WorkspaceBridge {
  constructor() {
    this.root = path.join(app.getPath('userData'), 'security');
    this.tokenFile = path.join(this.root, 'local-agent.token');
    process.env.TEAMYRA_LOCAL_AGENT_TOKEN_FILE = this.tokenFile;
    this.token = this.ensureToken();
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

  configure(workspace, permissions = {}) {
    return callCore('chatgpt.workspace.configure', {
      bridge_token: this.token,
      workspace: String(workspace || ''),
      permissions
    });
  }

  status() {
    return callCore('chatgpt.workspace.status', { bridge_token: this.token });
  }

  execute(tool, args = {}, confirm = false) {
    return callCore('chatgpt.tool.execute', {
      bridge_token: this.token,
      tool: String(tool || ''),
      args: args || {},
      confirm: confirm === true
    }, { timeout: tool === 'terminal.run' ? 135000 : 45000, maxBuffer: 12 * 1024 * 1024 });
  }

  async changes() {
    const [status, diff] = await Promise.all([
      this.execute('git.status', {}),
      this.execute('git.diff', {})
    ]);
    return { status, diff };
  }
}

module.exports = { WorkspaceBridge };
