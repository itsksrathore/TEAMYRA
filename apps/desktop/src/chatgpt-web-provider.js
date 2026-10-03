const fs = require('node:fs');
const path = require('node:path');
const { WebContentsView } = require('electron');
const { ChatGPTSessionManager } = require('./chatgpt-session-manager');
const { ChatGPTAutomationAdapter } = require('./chatgpt-automation-adapter');
const { WorkspaceBridge } = require('./workspace-bridge');

const CHATGPT_HOME = 'https://chatgpt.com/';
const ALLOWED_HOSTS = new Set([
  'chatgpt.com', 'www.chatgpt.com', 'auth.openai.com', 'openai.com', 'www.openai.com',
  'accounts.google.com', 'login.microsoftonline.com', 'appleid.apple.com'
]);

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function safeHttps(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && ALLOWED_HOSTS.has(parsed.hostname);
  } catch {
    return false;
  }
}

class ChatGPTWebProvider {
  constructor({ window, runtimeRoot }) {
    this.window = window;
    this.runtimeRoot = runtimeRoot;
    this.stateRoot = path.join(runtimeRoot, 'chatgpt');
    this.statusFile = path.join(this.stateRoot, 'status.json');
    this.sessionManager = new ChatGPTSessionManager();
    this.workspaceBridge = new WorkspaceBridge();
    this.view = null;
    this.automation = null;
    this.bounds = { x: 220, y: 96, width: 1000, height: 700 };
    this.visible = false;
    this.loaded = false;
    this.busy = false;
    this.lastProbe = null;
    this.jobTimer = null;
    this.heartbeatTimer = null;
    fs.mkdirSync(this.stateRoot, { recursive: true });
    this.writeStatus({ detail: 'Embedded ChatGPT available; open it to initialize the session.' });
  }

  initialize() {
    this.sessionManager.initialize();
    if (!this.heartbeatTimer) {
      this.heartbeatTimer = setInterval(() => this.refreshStatus().catch(() => {}), 5000);
      this.heartbeatTimer.unref?.();
    }
    if (!this.jobTimer) {
      this.jobTimer = setInterval(() => this.processPendingJobs().catch(() => {}), 2000);
      this.jobTimer.unref?.();
    }
    return this.getStatus();
  }

  ensureView() {
    if (this.view && !this.view.webContents.isDestroyed()) return this.view;
    const ses = this.sessionManager.getSession();
    this.view = new WebContentsView({
      webPreferences: {
        session: ses,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        devTools: true
      }
    });
    this.view.setBackgroundColor('#0b0e14');
    this.view.setBounds(this.bounds);
    this.view.setVisible(this.visible);
    this.window.contentView.addChildView(this.view);
    this.automation = new ChatGPTAutomationAdapter(this.view.webContents);

    this.view.webContents.setWindowOpenHandler(({ url }) => {
      if (safeHttps(url)) {
        setImmediate(() => this.view?.webContents.loadURL(url).catch(() => {}));
      }
      return { action: 'deny' };
    });
    this.view.webContents.on('will-navigate', event => {
      const url = event.url;
      if (!safeHttps(url)) event.preventDefault();
    });
    this.view.webContents.on('did-finish-load', () => {
      this.loaded = true;
      this.refreshStatus().catch(() => {});
    });
    this.view.webContents.on('did-fail-load', (_event, code, description) => {
      this.loaded = false;
      this.writeStatus({ detail: `ChatGPT page failed to load (${code}): ${description}` });
    });
    this.view.webContents.on('render-process-gone', (_event, details) => {
      this.loaded = false;
      this.writeStatus({ detail: 'ChatGPT renderer stopped: ' + (details?.reason || 'unknown') });
    });
    return this.view;
  }

  async open() {
    const view = this.ensureView();
    this.visible = true;
    view.setVisible(true);
    view.setBounds(this.bounds);
    const url = view.webContents.getURL();
    if (!url || url === 'about:blank') {
      await view.webContents.loadURL(CHATGPT_HOME);
    }
    await this.refreshStatus();
    return this.getStatus();
  }

  close() {
    this.visible = false;
    if (this.view && !this.view.webContents.isDestroyed()) this.view.setVisible(false);
    return this.getStatus();
  }

  async reload() {
    const view = this.ensureView();
    if (!view.webContents.getURL()) await view.webContents.loadURL(CHATGPT_HOME);
    else view.webContents.reload();
    return { ok: true };
  }

  setVisible(value) {
    this.visible = value === true;
    if (this.view && !this.view.webContents.isDestroyed()) {
      this.view.setVisible(this.visible);
      if (this.visible) this.view.setBounds(this.bounds);
    }
  }

  setBounds(bounds = {}) {
    const next = {
      x: Math.max(0, Math.round(Number(bounds.x) || 0)),
      y: Math.max(0, Math.round(Number(bounds.y) || 0)),
      width: Math.max(320, Math.round(Number(bounds.width) || 320)),
      height: Math.max(240, Math.round(Number(bounds.height) || 240))
    };
    this.bounds = next;
    if (this.view && !this.view.webContents.isDestroyed() && this.visible) this.view.setBounds(next);
    return next;
  }

  async getStatus() {
    let workspace = null;
    try { workspace = await this.workspaceBridge.status(); } catch {}
    return {
      id: 'chatgpt-normal',
      provider: 'chatgpt-web',
      connected: Boolean(this.view && !this.view.webContents.isDestroyed() && this.loaded),
      visible: this.visible,
      loaded: this.loaded,
      automationReady: Boolean(this.lastProbe?.promptFound && !this.lastProbe?.challenged),
      loginVisible: Boolean(this.lastProbe?.loginVisible),
      challenged: Boolean(this.lastProbe?.challenged),
      url: this.view && !this.view.webContents.isDestroyed() ? this.view.webContents.getURL() : '',
      title: this.view && !this.view.webContents.isDestroyed() ? this.view.webContents.getTitle() : '',
      busy: this.busy,
      workspace
    };
  }

  async refreshStatus() {
    if (this.view && !this.view.webContents.isDestroyed() && this.loaded && this.automation) {
      try {
        this.lastProbe = await this.automation.probe();
      } catch {
        this.lastProbe = null;
      }
    }
    const status = await this.getStatus();
    this.writeStatus({
      automation_ready: status.automationReady,
      connected: status.connected,
      login_visible: status.loginVisible,
      challenged: status.challenged,
      busy: status.busy,
      url: status.url,
      detail: status.challenged
        ? 'ChatGPT requires user verification in the embedded view.'
        : status.automationReady
          ? 'Embedded ChatGPT session is active.'
          : status.loginVisible
            ? 'ChatGPT sign-in is required in the embedded view.'
            : status.connected
              ? 'ChatGPT page loaded; waiting for an interactive prompt.'
              : 'Embedded ChatGPT is not currently loaded.'
    });
    return status;
  }

  writeStatus(patch = {}) {
    let current = {};
    try { current = JSON.parse(fs.readFileSync(this.statusFile, 'utf8')); } catch {}
    const data = {
      ...current,
      provider: 'chatgpt-web',
      worker: 'chatgpt-normal',
      heartbeat_at: Date.now() / 1000,
      ...patch
    };
    const temp = this.statusFile + '.tmp-' + process.pid;
    fs.writeFileSync(temp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(temp, this.statusFile);
    return data;
  }

  async getCurrentConversation() {
    if (!this.automation) return { url: '', conversationId: null, title: '' };
    return this.automation.getCurrentConversation();
  }

  async createConversation() {
    this.ensureView();
    await this.automation.newChat();
    return this.refreshStatus();
  }

  async openConversation(value) {
    const view = this.ensureView();
    const url = String(value || '').startsWith('https://')
      ? String(value)
      : `https://chatgpt.com/c/${String(value || '')}`;
    if (!safeHttps(url) || !new URL(url).hostname.endsWith('chatgpt.com')) {
      throw new Error('Invalid ChatGPT conversation URL');
    }
    await view.webContents.loadURL(url);
    return this.refreshStatus();
  }

  async sendTask(text) {
    this.ensureView();
    if (!this.loaded) await this.open();
    const probe = await this.automation.probe();
    if (probe.challenged) throw new Error('ChatGPT requires user verification in the embedded view');
    if (!probe.promptFound) throw new Error(probe.loginVisible ? 'ChatGPT sign-in is required' : 'ChatGPT prompt is unavailable');
    return this.automation.sendTask(text);
  }

  async stopGeneration() {
    if (!this.automation) return { ok: false, reason: 'view-not-initialized' };
    return this.automation.stopGeneration();
  }

  async attachFile(filePath) {
    const status = await this.workspaceBridge.status();
    if (!status?.available) throw new Error('Select a workspace first');
    await this.workspaceBridge.execute('filesystem.stat', { path: filePath });
    const view = this.ensureView();
    await view.webContents.executeJavaScript(`(() => {
      const button = document.querySelector('button[aria-label*="Attach"], button[aria-label*="attach"], button[data-testid*="attach"]');
      if (button) button.click();
      return !!button;
    })()`, true);
    await sleep(350);
    const debuggerApi = view.webContents.debugger;
    let attachedHere = false;
    try {
      if (!debuggerApi.isAttached()) {
        debuggerApi.attach('1.3');
        attachedHere = true;
      }
      const { root } = await debuggerApi.sendCommand('DOM.getDocument', { depth: -1, pierce: true });
      const { nodeId } = await debuggerApi.sendCommand('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type="file"]' });
      if (!nodeId) throw new Error('ChatGPT file input was not found');
      await debuggerApi.sendCommand('DOM.setFileInputFiles', { nodeId, files: [path.resolve(filePath)] });
      return { ok: true, path: path.resolve(filePath) };
    } finally {
      if (attachedHere && debuggerApi.isAttached()) debuggerApi.detach();
    }
  }

  async processPendingJobs() {
    if (this.busy) return;
    const jobsRoot = path.join(this.runtimeRoot, 'jobs');
    if (!fs.existsSync(jobsRoot)) return;
    const candidates = [];
    for (const entry of fs.readdirSync(jobsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(jobsRoot, entry.name);
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
        if (meta.provider === 'chatgpt-web' && meta.state === 'waiting_for_desktop' && !fs.existsSync(path.join(dir, 'DONE'))) {
          candidates.push({ dir, meta });
        }
      } catch {}
    }
    candidates.sort((a, b) => (a.meta.created || 0) - (b.meta.created || 0));
    if (!candidates.length) return;
    const status = await this.refreshStatus();
    if (!status.automationReady) return;
    await this.runDelegatedJob(candidates[0].dir);
  }

  writeJobMeta(jobDir, patch) {
    const file = path.join(jobDir, 'meta.json');
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    Object.assign(data, patch, { updated: Date.now() / 1000 });
    const temp = file + '.tmp-' + process.pid;
    fs.writeFileSync(temp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(temp, file);
    return data;
  }

  appendJobEvent(jobDir, kind, text) {
    const ts = Date.now() / 1000;
    fs.appendFileSync(path.join(jobDir, 'events.jsonl'), JSON.stringify({ ts, kind, text: String(text || '').slice(0, 4000) }) + '\n', 'utf8');
    fs.appendFileSync(path.join(jobDir, 'transcript.md'), `[${new Date().toLocaleTimeString()}] ${kind}: ${String(text || '')}\n`, 'utf8');
  }

  async runDelegatedJob(jobDir) {
    this.busy = true;
    let state = 'failed';
    try {
      const spec = JSON.parse(fs.readFileSync(path.join(jobDir, 'spec.json'), 'utf8'));
      const task = fs.readFileSync(path.join(jobDir, 'task.txt'), 'utf8');
      await this.workspaceBridge.configure(spec.cwd, undefined);
      this.writeJobMeta(jobDir, { state: 'running', started: Date.now() / 1000, runner_pid: null });
      this.appendJobEvent(jobDir, 'info', 'embedded ChatGPT worker started');

      const bootstrap = [
        'You are Teamyra Worker — ChatGPT, operating on a local project through controlled TEAMYRA tools.',
        'Do not claim you changed/read local files unless TEAMYRA returned the tool result.',
        'When you need a local tool, reply with exactly one line and nothing else:',
        'TEAMYRA_TOOL_REQUEST {"tool":"filesystem.read","args":{"path":"relative/path"}}',
        'Available tools: filesystem.list, filesystem.stat, filesystem.read, filesystem.search, filesystem.create, filesystem.write, filesystem.patch, filesystem.move, filesystem.rename, filesystem.delete, terminal.run, git.status, git.diff, git.log, git.add, git.commit, git.restore.',
        'Destructive operations may be denied pending explicit user confirmation. Never try to bypass that denial.',
        'When the task is complete, reply normally with the final result and do not emit a tool request.',
        '',
        'WORKSPACE: ' + spec.cwd,
        'TASK:',
        task
      ].join('\n');

      let snap = await this.automation.assistantSnapshot();
      await this.sendTask(bootstrap);
      let reply = await this.automation.waitForAssistantReply({ previousCount: snap.count, timeoutMs: Math.min(spec.timeout * 1000, 300000) });

      for (let step = 0; step < 16; step += 1) {
        if (fs.existsSync(path.join(jobDir, 'CANCEL'))) {
          await this.stopGeneration().catch(() => {});
          state = 'cancelled';
          throw new Error('TEAMYRA job cancelled');
        }
        const request = this.automation.parseToolRequest(reply.text);
        if (!request) {
          const conversation = await this.getCurrentConversation();
          fs.writeFileSync(path.join(jobDir, 'final.txt'), reply.text || '', 'utf8');
          this.appendJobEvent(jobDir, 'message', reply.text || '');
          this.writeJobMeta(jobDir, {
            state: 'done',
            ended: Date.now() / 1000,
            session_id: conversation.conversationId,
            chatgpt_url: conversation.url,
            last_event: 'done: embedded ChatGPT completed'
          });
          fs.writeFileSync(path.join(jobDir, 'DONE'), 'done', 'utf8');
          state = 'done';
          return;
        }

        this.appendJobEvent(jobDir, 'command', request.tool + ' ' + JSON.stringify(request.args).slice(0, 1000));
        let toolResult;
        try {
          toolResult = await this.workspaceBridge.execute(request.tool, request.args, false);
        } catch (error) {
          toolResult = { ok: false, error: String(error?.message || error) };
        }
        this.appendJobEvent(jobDir, 'result', JSON.stringify(toolResult).slice(0, 3000));
        snap = await this.automation.assistantSnapshot();
        await this.sendTask('TEAMYRA_TOOL_RESULT ' + JSON.stringify({ tool: request.tool, result: toolResult }) + '\nContinue the task.');
        reply = await this.automation.waitForAssistantReply({ previousCount: snap.count, timeoutMs: Math.min(spec.timeout * 1000, 300000) });
      }
      throw new Error('ChatGPT exceeded the maximum TEAMYRA tool-call loop');
    } catch (error) {
      if (state !== 'cancelled') state = 'failed';
      this.appendJobEvent(jobDir, 'error', String(error?.message || error));
      this.writeJobMeta(jobDir, {
        state,
        reason: state === 'cancelled' ? 'cancelled' : 'worker_error',
        ended: Date.now() / 1000,
        last_event: 'error: ' + String(error?.message || error).slice(0, 180)
      });
      fs.writeFileSync(path.join(jobDir, 'DONE'), state, 'utf8');
    } finally {
      this.busy = false;
      await this.refreshStatus().catch(() => {});
    }
  }

  destroy() {
    clearInterval(this.jobTimer);
    clearInterval(this.heartbeatTimer);
    this.jobTimer = null;
    this.heartbeatTimer = null;
    if (this.view && !this.view.webContents.isDestroyed()) {
      this.window.contentView.removeChildView(this.view);
      this.view.webContents.close();
    }
    this.view = null;
    this.automation = null;
  }
}

module.exports = { ChatGPTWebProvider, CHATGPT_HOME };
