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

  coreOptions(extra = {}) {
    return {
      ...extra,
      env: {
        ...(extra.env || {}),
        TEAMYRA_LOCAL_AGENT_TOKEN: this.token
      }
    };
  }

  configure(workspace, permissions = {}) {
    return callCore('chatgpt.workspace.configure', {
      workspace: String(workspace || ''),
      permissions
    }, this.coreOptions());
  }

  status() {
    return callCore('chatgpt.workspace.status', {}, this.coreOptions());
  }

  execute(tool, args = {}, confirm = false) {
    return callCore('chatgpt.tool.execute', {
      tool: String(tool || ''),
      args: args || {},
      confirm: confirm === true
    }, this.coreOptions({
      timeout: tool === 'terminal.run' ? 135000 : 45000,
      maxBuffer: 12 * 1024 * 1024
    }));
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
