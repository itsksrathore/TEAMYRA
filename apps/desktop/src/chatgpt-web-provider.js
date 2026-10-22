const fs = require('node:fs');
const path = require('node:path');
const { WebContentsView, Notification } = require('electron');
const { ChatGPTSessionManager, DEFAULT_CHATGPT_PROFILE_ID } = require('./chatgpt-session-manager');
const { ChatGPTAutomationAdapter, teamyraError } = require('./chatgpt-automation-adapter');
const { WorkspaceBridge } = require('./workspace-bridge');
const { callCore } = require('./core-api');

const CHATGPT_HOME = 'https://chatgpt.com/';
const MAX_TOOL_RESULT_CHARS = 120000;
const MAX_TOOL_STEPS = 256;
const MAX_TOOL_PARSE_FAILURES = 3;
const MAX_PROTOCOL_RECOVERIES = 2;
const CHALLENGE_POLL_MS = 3000;
const PROGRESS_INTERVAL_MS = 30000;
const VERIFICATION_MESSAGE = 'ChatGPT asks for human verification. Open TEAMYRA Desktop, select the ChatGPT worker and complete the check; the job resumes automatically.';
const TOOL_ERROR_HINT = 'Reply with one line: TEAMYRA_TOOL_REQUEST {"tool":"<name>","args":{...}} using valid JSON and forward slashes in paths (D:/dir/file). If the task is complete, reply with the final answer without the TEAMYRA_TOOL_REQUEST marker.';
const READ_ONLY_BLOCKED_TOOLS = new Set([
  'filesystem.create', 'filesystem.write', 'filesystem.patch', 'filesystem.move',
  'filesystem.rename', 'filesystem.delete', 'terminal.run', 'git.add', 'git.commit', 'git.restore'
]);
const ALLOWED_HOSTS = new Set([
  'chatgpt.com', 'www.chatgpt.com', 'auth.openai.com', 'auth0.openai.com', 'openai.com', 'www.openai.com',
  'accounts.google.com', 'login.microsoftonline.com', 'login.live.com', 'appleid.apple.com'
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

function safePopupUrl(url) {
  return url === 'about:blank' || safeHttps(url);
}

function missingExpectedOutputs(workspace, paths = []) {
  if (!Array.isArray(paths)) throw teamyraError('Invalid expect_files contract', 'TEAMYRA_MISSING_OUTPUT', 'missing_output');
  return paths.filter(value => {
    try {
      if (typeof value !== 'string' || !value.trim() || path.win32.parse(value).root ||
          value.replace(/\\/g, '/').split('/').includes('..')) return true;
      const file = path.resolve(workspace, value.replace(/\\/g, '/'));
      const relative = path.relative(fs.realpathSync(workspace), fs.realpathSync(file));
      if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) return true;
      const stat = fs.statSync(file);
      return !stat.isFile() || stat.size === 0;
    } catch { return true; }
  });
}

function looksLikeProtocolLoss(text, successfulTools) {
  const reply = String(text || '').replace(/[’‘]/g, "'");
  const refusal = /\b(?:I|we)\s+(?:(?:do not|don't)\s+have\s+access|(?:can(?:not|'t)|am unable to|are unable to)\s+(?:directly\s+)?(?:access|read|write|edit|modify|inspect|open|use))\b[^.!?\n]*(?:files?|filesystem|workspace|repository|repo|local|tools?|TEAMYRA)/i.test(reply);
  const unavailable = /\b(?:TEAMYRA(?:\s+tool)?\s+(?:interface|tools?)|local\s+tools?|tool\s+interface)\b[^.!?\n]*(?:not\s+(?:available|accessible|enabled)|unavailable|missing|disabled|don't\s+have|do\s+not\s+have)/i.test(reply) ||
    /\b(?:don't|do not)\s+have\b[^.!?\n]*(?:TEAMYRA|local tools|tool interface)/i.test(reply);
  const paste = /\b(?:please\s+)?(?:paste|upload|provide|share)\b[^.!?\n]*(?:files?|file contents|source code|repository|repo|code here)/i.test(reply) &&
    !/\b(?:pasted|uploaded|provided|shared)\b/i.test(reply);
  if (!(refusal || unavailable || paste)) return false;
  // A completed result may discuss a resolved access error. Require actual
  // successful tool work before accepting that kind of completion claim.
  const completed = /(?:^|\n)\s*(?:done\b|finished\b|completed\b|implemented\b|fixed\b|I (?:have |successfully )?(?:completed|implemented|fixed)\b)/i.test(reply);
  const unfinished = /\b(?:cannot|can't|unable to)\s+(?:complete|finish)|\b(?:task|work)\s+(?:is\s+)?(?:unfinished|incomplete)/i.test(reply);
  return unfinished || !successfulTools || !completed;
}

class ChatGPTWebProvider {
  constructor({ window, runtimeRoot, profileId = DEFAULT_CHATGPT_PROFILE_ID }) {
    this.window = window;
    this.runtimeRoot = runtimeRoot;
    this.stateRoot = path.join(runtimeRoot, 'chatgpt');
    this.statusFile = path.join(this.stateRoot, 'status.json');
    this.activeProfileId = String(profileId || DEFAULT_CHATGPT_PROFILE_ID);
    this.fixedProfileId = this.activeProfileId;
    this.workerConversationFile = this.profileConversationFile(this.activeProfileId);
    this.sessionManager = new ChatGPTSessionManager(this.activeProfileId);
    this.workspaceBridge = new WorkspaceBridge();
    this.view = null;
    this.popupView = null;
    this.automation = null;
    this.interactionCssKey = null;
    this.activeJobDir = null;
    this.bounds = { x: 220, y: 96, width: 1000, height: 700 };
    this.visible = false;
    this.loaded = false;
    this.busy = false;
    this.awaitingUser = false;
    this.lastProbe = null;
    this.jobTimer = null;
    this.heartbeatTimer = null;
    this.unloadTimer = null;
    this.statusRefresh = null;
    fs.mkdirSync(this.stateRoot, { recursive: true });
    this.writeStatus({
      profile_update: false,
      detail: 'Embedded ChatGPT available; open it to initialize the session.',
      automation_ready: false,
      worker_ready: false,
      connected: false,
      login_visible: false,
      challenged: false,
      busy: false,
      url: ''
    });
  }

  initialize() {
    this.recoverInterruptedJobs();
    this.sessionManager.initialize();
    this.profileSessionStatus(this.activeProfileId).then(profile => {
      this.writeStatus({
        session_present: profile.signedIn === true,
        profile_update: true
      });
    }).catch(() => {});
    if (!this.heartbeatTimer) {
      this.heartbeatTimer = setInterval(() => {
        if (this.view || this.busy) {
          this.refreshStatus().catch(() => {});
        } else {
          // Keep only the desktop heartbeat fresh while the heavy web view is
          // asleep. A queued job will lazy-open the correct profile.
          this.writeStatus({ profile_update: false });
        }
      }, 5000);
      this.heartbeatTimer.unref?.();
    }
    if (!this.jobTimer) {
      this.jobTimer = setInterval(() => this.processPendingJobs().catch(() => {}), 2000);
      this.jobTimer.unref?.();
    }
    return this.getStatus();
  }

  recoverInterruptedJobs() {
    // Only one desktop owns this runtime. A new provider cannot still own a
    // running browser loop from the previous desktop process.
    const jobsRoot = path.join(this.runtimeRoot, 'jobs');
    if (!fs.existsSync(jobsRoot)) return;
    for (const entry of fs.readdirSync(jobsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(jobsRoot, entry.name);
      let meta;
      try { meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')); } catch { continue; }
      if (meta.provider !== 'chatgpt-web' || !['running', 'needs_user'].includes(meta.state) ||
          String(meta.profile_id || DEFAULT_CHATGPT_PROFILE_ID) !== this.activeProfileId ||
          fs.existsSync(path.join(dir, 'DONE'))) continue;
      const detail = 'ChatGPT desktop restarted; partial workspace changes are preserved. Resume with a new job.';
      this.appendJobEvent(dir, 'error', detail);
      this.writeJobMeta(dir, {
        state: 'failed', reason: 'desktop_interrupted', exit_code: 1, attention: null,
        ended: Date.now() / 1000, last_event: detail
      });
      fs.writeFileSync(path.join(dir, 'DONE'), 'failed', 'utf8');
    }
  }

  profileConversationFile(profileId = this.activeProfileId) {
    return profileId === DEFAULT_CHATGPT_PROFILE_ID
      ? path.join(this.stateRoot, 'worker-conversation.json')
      : path.join(this.stateRoot, 'worker-conversation-' + profileId + '.json');
  }

  async profileSessionStatus(profileId) {
    const manager = profileId === this.activeProfileId
      ? this.sessionManager
      : new ChatGPTSessionManager(profileId);
    const summary = await manager.cookieSummary().catch(() => ({ count: 0, hasSessionCookies: false }));
    return {
      profileId,
      signedIn: summary.hasSessionCookies === true,
      cookieCount: summary.count
    };
  }

  async switchProfile(profileId = DEFAULT_CHATGPT_PROFILE_ID) {
    const next = String(profileId || DEFAULT_CHATGPT_PROFILE_ID).trim() || DEFAULT_CHATGPT_PROFILE_ID;
    if (next !== this.fixedProfileId) throw new Error('This ChatGPT worker is bound to a different account');
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
      if (!safePopupUrl(url)) return { action: 'deny' };
      return {
        action: 'allow',
        createWindow: options => this.createEmbeddedPopup(options)
      };
    });
    const guardTopLevelNavigation = event => {
      if (!safeHttps(event.url)) event.preventDefault();
    };
    this.view.webContents.on('will-navigate', guardTopLevelNavigation);
    this.view.webContents.on('will-redirect', guardTopLevelNavigation);
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
    this.view.webContents.on('before-input-event', event => {
      if (this.busy && !this.awaitingUser) event.preventDefault();
    });
    return this.view;
  }

  createEmbeddedPopup(options = {}) {
    this.closeEmbeddedPopup();
    const ses = this.sessionManager.getSession();
    const popup = new WebContentsView({
      webPreferences: {
        ...(options.webPreferences || {}),
        session: ses,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        devTools: true
      }
    });
    this.popupView = popup;
    popup.setBackgroundColor('#0b0e14');
    popup.setBounds(this.bounds);
    popup.setVisible(this.visible);
    this.window.contentView.addChildView(popup);

    const guardTopLevelNavigation = event => {
      if (!safeHttps(event.url)) event.preventDefault();
    };
    popup.webContents.on('will-navigate', guardTopLevelNavigation);
    popup.webContents.on('will-redirect', guardTopLevelNavigation);
    popup.webContents.setWindowOpenHandler(({ url }) => {
      if (safePopupUrl(url)) {
        setImmediate(() => {
          if (this.popupView === popup && !popup.webContents.isDestroyed()) {
            popup.webContents.loadURL(url).catch(() => {});
          }
        });
      }
      return { action: 'deny' };
    });
    popup.webContents.on('destroyed', () => {
      if (this.popupView === popup) this.popupView = null;
      this.refreshStatus().catch(() => {});
    });
    popup.webContents.on('render-process-gone', () => {
      if (this.popupView === popup) this.closeEmbeddedPopup();
    });
    return popup.webContents;
  }

  closeEmbeddedPopup() {
    const popup = this.popupView;
    this.popupView = null;
    if (!popup) return;
    try { this.window.contentView.removeChildView(popup); } catch {}
    try {
      if (!popup.webContents.isDestroyed()) popup.webContents.close();
    } catch {}
  }

  async ensureLoaded({ visible = false } = {}) {
    const view = this.ensureView();
    this.visible = visible === true;
    view.setVisible(this.visible);
    if (this.visible) view.setBounds(this.bounds);
    const url = view.webContents.getURL();
    if (!url || url === 'about:blank') {
      await view.webContents.loadURL(CHATGPT_HOME);
    }
    await this.refreshStatus();
    return this.getStatus();
  }

  async open() {
    this.cancelUnload();
    const view = this.ensureView();
    this.visible = false;
    view.setVisible(false);
    const current = view.webContents.getURL();
    if (this.loaded && current && current !== 'about:blank' && !view.webContents.isLoading()) {
      this.setVisible(true);
      return this.getStatus();
    }
    void (async () => {
      try {
        if (!current || current === 'about:blank') {
          view.webContents.loadURL(CHATGPT_HOME).catch(() => {});
        }
        const deadline = Date.now() + 20000;
        while (Date.now() < deadline && view.webContents.isLoading()) {
          await sleep(120);
        }
        await this.refreshStatus().catch(() => {});
        this.setVisible(true);
      } catch {
        this.setVisible(false);
      }
    })();
    return this.getStatus();
  }

  async wakeBackground() {
    this.cancelUnload();
    return this.ensureLoaded({ visible: false });
  }

  cancelUnload() {
    if (this.unloadTimer) clearTimeout(this.unloadTimer);
    this.unloadTimer = null;
  }

  scheduleUnload(delayMs = 15000) {
    this.cancelUnload();
    this.unloadTimer = setTimeout(() => {
      this.unloadTimer = null;
      if (this.busy || this.visible) return;
      this.closeEmbeddedPopup();
      if (this.view && !this.view.webContents.isDestroyed()) {
        try { this.window.contentView.removeChildView(this.view); } catch {}
        try { this.view.webContents.close(); } catch {}
      }
      this.view = null;
      this.automation = null;
      this.loaded = false;
      this.lastProbe = null;
    }, Math.max(2000, Number(delayMs) || 15000));
    this.unloadTimer.unref?.();
  }

  close() {
    this.visible = false;
    if (this.view && !this.view.webContents.isDestroyed()) this.view.setVisible(false);
    if (this.popupView && !this.popupView.webContents.isDestroyed()) this.popupView.setVisible(false);
    this.scheduleUnload(3000);
    return this.getStatus();
  }

  async reload() {
    const view = this.ensureView();
    if (!view.webContents.getURL()) await view.webContents.loadURL(CHATGPT_HOME);
    else view.webContents.reload();
    return { ok: true };
  }

  async reconnect() {
    const view = this.ensureView();
    this.loaded = false;
    this.lastProbe = null;
    const current = view.webContents.getURL();
    const target = safeHttps(current) ? current : CHATGPT_HOME;
    await view.webContents.loadURL(target);
    return this.refreshStatus();
  }

  async setInteractionLocked(locked) {
    if (!locked) {
      if (!this.view || this.view.webContents.isDestroyed()) {
        this.interactionCssKey = null;
        return;
      }
      if (this.interactionCssKey) {
        const key = this.interactionCssKey;
        this.interactionCssKey = null;
        await this.view.webContents.removeInsertedCSS(key).catch(() => {});
      }
      return;
    }
    const view = this.ensureView();
    if (!this.interactionCssKey) {
      this.interactionCssKey = await view.webContents.insertCSS(
        'html { pointer-events: none !important; }'
      );
    }
  }

  setVisible(value) {
    this.visible = value === true;
    if (this.visible) this.cancelUnload();
    else this.scheduleUnload(15000);
    if (this.view && !this.view.webContents.isDestroyed()) {
      this.view.setVisible(this.visible);
      if (this.visible) this.view.setBounds(this.bounds);
    }
    if (this.popupView && !this.popupView.webContents.isDestroyed()) {
      this.popupView.setVisible(this.visible);
      if (this.visible) this.popupView.setBounds(this.bounds);
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
    if (this.popupView && !this.popupView.webContents.isDestroyed() && this.visible) this.popupView.setBounds(next);
    return next;
  }

  async getStatus() {
    let workspace = null;
    try { workspace = await this.workspaceBridge.status(); } catch {}
    return {
      id: this.activeProfileId === DEFAULT_CHATGPT_PROFILE_ID ? 'chatgpt-normal' : 'chatgpt-' + this.activeProfileId,
      provider: 'chatgpt-web',
      profileId: this.activeProfileId,
      connected: Boolean(this.view && !this.view.webContents.isDestroyed() && this.loaded),
      visible: this.visible,
      loaded: this.loaded,
      automationReady: Boolean(this.lastProbe?.promptFound && !this.lastProbe?.challenged),
      workerReady: Boolean(this.lastProbe?.promptFound && !this.lastProbe?.challenged),
      loginVisible: Boolean(this.lastProbe?.loginVisible),
      challenged: Boolean(this.lastProbe?.challenged),
      url: this.view && !this.view.webContents.isDestroyed() ? this.view.webContents.getURL() : '',
      title: this.view && !this.view.webContents.isDestroyed() ? this.view.webContents.getTitle() : '',
      busy: this.busy,
      workspace
    };
  }

  refreshStatus() {
    if (this.statusRefresh) return this.statusRefresh;
    this.statusRefresh = this.refreshStatusOnce().finally(() => { this.statusRefresh = null; });
    return this.statusRefresh;
  }

  async refreshStatusOnce() {
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
      worker_ready: status.workerReady,
      workspace: status.workspace?.workspace || '',
      connected: status.connected,
      login_visible: status.loginVisible,
      challenged: status.challenged,
      busy: status.busy,
      url: status.url,
      detail: status.challenged
        ? 'ChatGPT requires user verification in the embedded view.'
        : status.automationReady && !status.workspace?.available
          ? 'Embedded ChatGPT session is active; select a workspace to enable worker routing.'
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
    const profileId = patch.active_profile_id || this.activeProfileId || DEFAULT_CHATGPT_PROFILE_ID;
    const workerId = profileId === DEFAULT_CHATGPT_PROFILE_ID ? 'chatgpt-normal' : 'chatgpt-' + profileId;
    const statusPatch = { ...patch };
    const updateProfile = statusPatch.profile_update !== false;
    delete statusPatch.profile_update;

    const profilePatch = { heartbeat_at: Date.now() / 1000 };
    for (const key of [
      'automation_ready', 'worker_ready', 'connected', 'login_visible',
      'challenged', 'busy', 'url', 'detail', 'session_present'
    ]) {
      if (Object.prototype.hasOwnProperty.call(statusPatch, key)) profilePatch[key] = statusPatch[key];
    }

    const profiles = { ...(current.profiles || {}) };
    if (updateProfile) {
      profiles[profileId] = { ...(profiles[profileId] || {}), ...profilePatch };
    }
    const data = {
      ...current,
      provider: 'chatgpt-web',
      worker: workerId,
      active_profile_id: profileId,
      heartbeat_at: Date.now() / 1000,
      profiles,
      ...statusPatch
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

  loadWorkerConversation() {
    try {
      const data = JSON.parse(fs.readFileSync(this.workerConversationFile, 'utf8'));
      return data && typeof data === 'object' ? data : null;
    } catch {
      return null;
    }
  }

  saveWorkerConversation(conversation) {
    if (!conversation?.conversationId || !conversation?.url) return;
    const temp = this.workerConversationFile + '.tmp-' + process.pid;
    fs.writeFileSync(temp, JSON.stringify({
      conversationId: conversation.conversationId,
      url: conversation.url,
      updatedAt: new Date().toISOString()
    }, null, 2), 'utf8');
    fs.renameSync(temp, this.workerConversationFile);
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
    if (!this.loaded) await this.ensureLoaded({ visible: this.visible });

    let probe = null;
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      probe = await this.automation.probe();
      if (probe.challenged) {
        throw teamyraError('ChatGPT requires user verification in the embedded view', 'TEAMYRA_CHALLENGED', 'chatgpt_verification');
      }
      if (probe.loginVisible) throw new Error('ChatGPT sign-in is required');
      if (probe.promptFound) break;
      await sleep(250);
    }

    if (!probe?.promptFound) throw new Error('ChatGPT prompt is unavailable');
    return this.automation.sendTask(text);
  }

  async stopGeneration() {
    if (this.busy && this.activeJobDir) {
      try {
        fs.writeFileSync(path.join(this.activeJobDir, 'CANCEL'), 'cancel', 'utf8');
      } catch {}
    }
    if (!this.automation) return { ok: false, reason: 'view-not-initialized' };
    const result = await this.automation.stopGeneration();
    return { ...result, jobCancelRequested: Boolean(this.busy && this.activeJobDir) };
  }

  async attachFile(filePath) {
    const status = await this.workspaceBridge.status();
    if (!status?.available) throw new Error('Select a workspace first');
    const verified = await this.workspaceBridge.execute('filesystem.stat', { path: filePath });
    if (verified?.type !== 'file' || !verified?.path) throw new Error('Only workspace files can be attached');
    const approvedPath = fs.realpathSync.native
      ? fs.realpathSync.native(verified.path)
      : fs.realpathSync(verified.path);
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
      await debuggerApi.sendCommand('DOM.setFileInputFiles', { nodeId, files: [approvedPath] });
      return { ok: true, path: approvedPath };
    } finally {
      if (attachedHere && debuggerApi.isAttached()) debuggerApi.detach();
    }
  }

  async processPendingJobs() {
    if (this.pendingJobsPromise) return this.pendingJobsPromise;
    this.pendingJobsPromise = this.processPendingJobsOnce().finally(() => { this.pendingJobsPromise = null; });
    return this.pendingJobsPromise;
  }

  async processPendingJobsOnce() {
    if (this.busy) return;
    const jobsRoot = path.join(this.runtimeRoot, 'jobs');
    if (!fs.existsSync(jobsRoot)) return;
    const candidates = [];
    for (const entry of fs.readdirSync(jobsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(jobsRoot, entry.name);
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
        if (meta.provider === 'chatgpt-web' && meta.state === 'waiting_for_desktop' && !fs.existsSync(path.join(dir, 'DONE')) &&
            String(meta.profile_id || DEFAULT_CHATGPT_PROFILE_ID) === this.activeProfileId) {
          candidates.push({ dir, meta });
        }
      } catch {}
    }
    candidates.sort((a, b) => (a.meta.created || 0) - (b.meta.created || 0));
    if (!candidates.length) return;
    if (!this.view || this.view.webContents.isDestroyed()) {
      await this.wakeBackground();
    }
    const status = await this.refreshStatus();
    if (!status.workerReady) {
      // Keep the jobs waiting, but explain on each of them why they wait.
      this.markWaitingJobs(candidates, status);
      return;
    }
    this.markWaitingJobs(candidates, null);
    await this.runDelegatedJob(candidates[0].dir);
  }

  // Writes attention / last_event on jobs that wait for this worker. `status`
  // is the not-ready worker status, or null when the worker is ready again.
  markWaitingJobs(candidates, status) {
    let newlyChallenged = 0;
    for (const { dir, meta } of candidates) {
      const verification = meta.attention?.kind === 'chatgpt_verification';
      const patch = {};
      if (status?.challenged) {
        if (!verification) {
          patch.attention = { kind: 'chatgpt_verification', since: Date.now() / 1000, message: VERIFICATION_MESSAGE };
          patch.last_event = 'waiting: ChatGPT verification required in TEAMYRA Desktop';
          newlyChallenged += 1;
        }
      } else {
        if (verification) patch.attention = null;
        if (status) {
          const detail = status.loginVisible
            ? 'waiting: ChatGPT sign-in required in TEAMYRA Desktop'
            : 'waiting: embedded ChatGPT worker is not ready';
          if (meta.last_event !== detail) patch.last_event = detail;
        }
      }
      if (!Object.keys(patch).length) continue;
      try {
        const updated = this.writeJobMeta(dir, patch);
        Object.assign(meta, updated);
      } catch {}
    }
    if (newlyChallenged) this.notifyUser('TEAMYRA: ChatGPT verification needed', VERIFICATION_MESSAGE);
  }

  notifyUser(title, body) {
    try {
      if (!Notification || typeof Notification.isSupported !== 'function' || !Notification.isSupported()) return false;
      const notification = new Notification({ title, body });
      notification.on('click', () => {
        try {
          if (this.window && !this.window.isDestroyed?.()) {
            if (this.window.isMinimized?.()) this.window.restore();
            this.window.show();
            this.window.focus();
          }
        } catch {}
      });
      notification.show();
      return true;
    } catch {
      return false;
    }
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

  checkJobActive(job) {
    if (job.isCancelled()) throw teamyraError('TEAMYRA job cancelled', 'TEAMYRA_CANCELLED', 'cancelled');
    if (Date.now() >= job.deadline) throw teamyraError('ChatGPT job timed out', 'TEAMYRA_TIMEOUT', 'timeout');
  }

  recordJobUsage(job) {
    try { this.writeJobMeta(job.dir, { usage: { ...job.usage } }); } catch {}
  }

  // Pauses the job as needs_user until the ChatGPT verification is gone. The
  // job keeps its conversation; it fails only on cancel or deadline.
  async waitForChallengeResolution(job) {
    const since = Date.now() / 1000;
    this.appendJobEvent(job.dir, 'attention', VERIFICATION_MESSAGE);
    this.writeJobMeta(job.dir, {
      state: 'needs_user',
      reason: 'chatgpt_verification',
      attention: { kind: 'chatgpt_verification', since, message: VERIFICATION_MESSAGE },
      last_event: 'needs_user: ChatGPT verification required'
    });
    this.notifyUser('TEAMYRA: ChatGPT verification needed', VERIFICATION_MESSAGE);
    this.awaitingUser = true;
    await this.setInteractionLocked(false).catch(() => {});
    try {
      for (;;) {
        this.checkJobActive(job);
        let probe = null;
        try { probe = await this.automation.probe(); } catch {}
        if (probe && !probe.challenged && probe.promptFound) break;
        await sleep(Math.max(1, Math.min(this.challengePollMs ?? CHALLENGE_POLL_MS, job.deadline - Date.now())));
      }
    } finally {
      this.awaitingUser = false;
    }
    await this.setInteractionLocked(true).catch(() => {});
    this.writeJobMeta(job.dir, {
      state: 'running',
      reason: null,
      attention: null,
      last_event: 'resumed after ChatGPT verification'
    });
    this.appendJobEvent(job.dir, 'info', 'ChatGPT verification cleared; resuming the same conversation');
    await this.refreshStatus().catch(() => {});
  }

  async sendJobMessage(job, text) {
    for (;;) {
      this.checkJobActive(job);
      try {
        const snap = await this.automation.assistantSnapshot();
        if (snap?.challenged) {
          throw teamyraError('ChatGPT requires user verification in the embedded view', 'TEAMYRA_CHALLENGED', 'chatgpt_verification');
        }
        await this.sendTask(text);
        job.usage.chars_sent += String(text || '').length;
        job.usage.turns += 1;
        this.recordJobUsage(job);
        return snap;
      } catch (error) {
        if (error?.code !== 'TEAMYRA_CHALLENGED') throw error;
        await this.waitForChallengeResolution(job);
      }
    }
  }

  // After a verification pause: back in the job conversation, was the last
  // message delivered? If not, it has to be sent again.
  async lastMessageDelivered(job, text) {
    const current = await this.getCurrentConversation().catch(() => null);
    if (job.conversationUrl && current?.conversationId !== job.conversationId) {
      await this.openConversation(job.conversationUrl);
    }
    const expected = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 160);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const last = String(await this.automation.lastUserMessage().catch(() => '') || '').replace(/\s+/g, ' ').trim();
      if (last && expected && last.startsWith(expected)) return true;
      await sleep(this.resumePollMs ?? 1000);
    }
    return false;
  }

  // Sends one message and waits for its reply, surviving verification pauses.
  async jobExchange(job, text) {
    let snap = await this.sendJobMessage(job, text);
    for (;;) {
      this.checkJobActive(job);
      try {
        const reply = await this.automation.waitForAssistantReply({
          previousCount: snap.count,
          previousText: snap.text,
          previousMessageId: snap.messageId,
          deadline: job.deadline,
          shouldCancel: job.isCancelled,
          detectChallenge: true,
          pollMs: this.replyPollMs,
          progressIntervalMs: this.progressIntervalMs ?? PROGRESS_INTERVAL_MS,
          onProgress: ({ elapsedMs, generating }) => {
            const seconds = Math.round(elapsedMs / 1000);
            this.writeJobMeta(job.dir, {
              last_event: generating ? `chatgpt generating ${seconds} s` : `waiting for chatgpt reply ${seconds} s`
            });
          }
        });
        job.usage.chars_received += String(reply.text || '').length;
        this.recordJobUsage(job);
        const conversation = await this.getCurrentConversation().catch(() => null);
        if (conversation?.conversationId) {
          job.conversationId = conversation.conversationId;
          job.conversationUrl = conversation.url;
        }
        return reply;
      } catch (error) {
        if (error?.code !== 'TEAMYRA_CHALLENGED') throw error;
        await this.waitForChallengeResolution(job);
        if (!await this.lastMessageDelivered(job, text)) {
          this.appendJobEvent(job.dir, 'info', 'last message was lost during verification; sending it again');
          snap = await this.sendJobMessage(job, text);
        }
      }
    }
  }

  dispatchQueuedJobs() {
    // Job completion must never wait for (or fail because of) queue dispatch.
    Promise.resolve().then(() => callCore('scheduler.dispatch')).catch(error => {
      console.error('ChatGPT queue dispatch failed:', error);
    });
  }

  async runDelegatedJob(jobDir) {
    this.busy = true;
    this.activeJobDir = jobDir;
    let state = 'failed';
    let reason = null;
    const job = {
      dir: jobDir,
      deadline: Infinity,
      usage: { chars_sent: 0, chars_received: 0, turns: 0 },
      isCancelled: () => fs.existsSync(path.join(jobDir, 'CANCEL')),
      conversationId: null,
      conversationUrl: null
    };
    try {
      const spec = JSON.parse(fs.readFileSync(path.join(jobDir, 'spec.json'), 'utf8'));
      const task = fs.readFileSync(path.join(jobDir, 'task.txt'), 'utf8');
      job.deadline = Date.now() + Number(spec.timeout || 3600) * 1000;
      const workspaceState = await this.workspaceBridge.status().catch(() => null);
      const assignedWorkspace = path.resolve(spec.cwd || '');
      if (!assignedWorkspace || !fs.existsSync(assignedWorkspace) || !fs.statSync(assignedWorkspace).isDirectory()) {
        throw new Error('Delegated task workspace is unavailable: ' + assignedWorkspace);
      }
      const taskPermissions = workspaceState?.permissions || {
        read: true, search: true, create: true, write: true, git: true, terminal: true,
        outside_workspace: false, destructive_without_confirmation: false
      };
      const fullAccess = taskPermissions.full_access === true || workspaceState?.full_access === true;

      const requestedConversation = spec.session_id
        ? { conversationId: spec.session_id }
        : null;
      if (requestedConversation?.conversationId || requestedConversation?.url) {
        await this.openConversation(requestedConversation.url || requestedConversation.conversationId);
      } else {
        // New delegated jobs are isolated by default. Only an explicit resume
        // session may reuse an earlier worker conversation.
        await this.createConversation();
      }
      await this.setInteractionLocked(true);
      this.writeJobMeta(jobDir, {
        state: 'running', started: Date.now() / 1000, runner_pid: null, attention: null, usage: { ...job.usage }
      });
      this.appendJobEvent(jobDir, 'info', 'embedded ChatGPT worker started');

      const bootstrap = [
        'You are Teamyra Worker — ChatGPT, operating on a local project through controlled TEAMYRA tools.',
        'Do not claim you changed/read local files unless TEAMYRA returned the tool result.',
        'When you need a local tool, reply with exactly one line and nothing else (no code fence):',
        'TEAMYRA_TOOL_REQUEST {"tool":"filesystem.read","args":{"path":"relative/path"}}',
        'Send one tool request per reply and wait for its TEAMYRA_TOOL_RESULT. The JSON must be valid; write paths with forward slashes (D:/project/file.txt), never backslashes.',
        'Available tools: filesystem.list, filesystem.stat, filesystem.read, filesystem.search, filesystem.create, filesystem.write, filesystem.patch, filesystem.move, filesystem.rename, filesystem.delete, terminal.run, git.status, git.diff, git.log, git.add, git.commit, git.restore.',
        'filesystem.read is paged: use offset and max_bytes for large files, then next_offset when clipped.',
        fullAccess
          ? 'The user granted full PC access: absolute paths anywhere on this PC are allowed; relative paths resolve inside the workspace.'
          : 'Use relative paths inside the workspace.',
        'git.diff supports base/head commit refs and stat:true. An unknown argument is an error that lists the allowed keys.',
        'If TEAMYRA answers TEAMYRA_TOOL_ERROR, your request could not be parsed: send a corrected request.',
        'This text bridge is your local tool interface: emit TEAMYRA_TOOL_REQUEST even if task files mention calling native tools.',
        'Destructive operations may be denied pending explicit user confirmation. Never try to bypass that denial.',
        'When the task is complete, reply normally with the final result and do not include the TEAMYRA_TOOL_REQUEST marker.',
        '',
        'WORKSPACE: ' + spec.cwd,
        'EXPECTED OUTPUT FILES (must exist and be non-empty): ' + JSON.stringify(spec.expect_files || []),
        'TASK:',
        task
      ].join('\n');

      let reply = await this.jobExchange(job, bootstrap);
      let parseFailures = 0;
      let protocolRecoveries = 0;
      let successfulTools = 0;

      for (let step = 0; step < MAX_TOOL_STEPS; step += 1) {
        if (job.isCancelled()) {
          await this.stopGeneration().catch(() => {});
          state = 'cancelled';
          throw new Error('TEAMYRA job cancelled');
        }
        const parsed = this.automation.parseToolRequestDetailed(reply.text);
        if (!parsed.marker) {
          if (looksLikeProtocolLoss(reply.text, successfulTools)) {
            if (protocolRecoveries >= MAX_PROTOCOL_RECOVERIES) {
              reason = 'protocol_lost';
              throw new Error('ChatGPT lost the TEAMYRA tool protocol after two reminders');
            }
            protocolRecoveries += 1;
            this.appendJobEvent(jobDir, 'protocol_recovery', `protocol reminder ${protocolRecoveries}/${MAX_PROTOCOL_RECOVERIES}: ${reply.text}`);
            this.writeJobMeta(jobDir, { protocol_recoveries: protocolRecoveries, last_event: 'restoring TEAMYRA tool protocol' });
            reply = await this.jobExchange(job, 'TEAMYRA protocol reminder: the task is not finished. The text tool bridge is available. Continue through TEAMYRA_TOOL_REQUEST.\n\n' + bootstrap);
            continue;
          }
          this.checkJobActive(job);
          const missing = missingExpectedOutputs(assignedWorkspace, spec.expect_files);
          if (missing.length) {
            reason = 'missing_output';
            this.writeJobMeta(jobDir, { missing_outputs: missing });
            throw new Error('Expected outputs missing or empty: ' + missing.join(', '));
          }
          const conversation = await this.getCurrentConversation();
          this.saveWorkerConversation(conversation);
          fs.writeFileSync(path.join(jobDir, 'final.txt'), reply.text || '', 'utf8');
          this.appendJobEvent(jobDir, 'message', reply.text || '');
          this.writeJobMeta(jobDir, {
            state: 'done',
            reason: null,
            exit_code: 0,
            attention: null,
            usage: { ...job.usage },
            ended: Date.now() / 1000,
            session_id: conversation.conversationId,
            chatgpt_url: conversation.url,
            last_event: 'done: embedded ChatGPT completed'
          });
          fs.writeFileSync(path.join(jobDir, 'DONE'), 'done', 'utf8');
          state = 'done';
          return;
        }

        if (!parsed.request) {
          parseFailures += 1;
          this.appendJobEvent(jobDir, 'error', `tool request parse error ${parseFailures}/${MAX_TOOL_PARSE_FAILURES}: ${parsed.error}`);
          if (parseFailures >= MAX_TOOL_PARSE_FAILURES) {
            reason = 'tool_parse_error';
            throw new Error(`ChatGPT sent ${parseFailures} unparseable TEAMYRA tool requests in a row: ${parsed.error}`);
          }
          reply = await this.jobExchange(job, 'TEAMYRA_TOOL_ERROR ' + JSON.stringify({ error: parsed.error, hint: TOOL_ERROR_HINT }));
          continue;
        }
        parseFailures = 0;
        const request = parsed.request;

        this.appendJobEvent(jobDir, 'command', request.tool + ' ' + JSON.stringify(request.args).slice(0, 1000));
        let toolResult;
        try {
          if (spec.write === false && READ_ONLY_BLOCKED_TOOLS.has(request.tool)) {
            throw new Error('This delegated job is read-only; write, terminal, and mutating Git tools are disabled');
          }
          toolResult = await this.workspaceBridge.executeInWorkspace(
            assignedWorkspace,
            request.tool,
            request.args,
            taskPermissions,
            false
          );
        } catch (error) {
          toolResult = { ok: false, error: String(error?.message || error) };
        }
        if (toolResult?.ok !== false) successfulTools += 1;
        const rawToolResult = JSON.stringify(toolResult);
        const boundedToolResult = rawToolResult.length <= MAX_TOOL_RESULT_CHARS
          ? toolResult
          : {
              clipped: true,
              preview: rawToolResult.slice(0, MAX_TOOL_RESULT_CHARS),
              note: 'TEAMYRA clipped this tool result. Request a narrower path/query/range or use filesystem.read offset/next_offset.'
            };
        this.appendJobEvent(jobDir, 'result', rawToolResult.slice(0, 3000));
        reply = await this.jobExchange(job, 'TEAMYRA_TOOL_RESULT ' + JSON.stringify({ tool: request.tool, result: boundedToolResult }) + '\nContinue the task.');
      }
      throw new Error('ChatGPT exceeded the maximum TEAMYRA tool-call loop');
    } catch (error) {
      if (error?.code === 'TEAMYRA_CANCELLED') state = 'cancelled';
      else if (state !== 'cancelled') state = 'failed';
      const finalReason = state === 'cancelled' ? 'cancelled' : (reason || error?.reason || 'worker_error');
      this.appendJobEvent(jobDir, 'error', String(error?.message || error));
      this.writeJobMeta(jobDir, {
        state,
        reason: finalReason,
        exit_code: 1,
        attention: null,
        usage: { ...job.usage },
        ended: Date.now() / 1000,
        last_event: 'error: ' + String(error?.message || error).slice(0, 180)
      });
      fs.writeFileSync(path.join(jobDir, 'DONE'), state, 'utf8');
    } finally {
      this.awaitingUser = false;
      await this.setInteractionLocked(false).catch(() => {});
      this.activeJobDir = null;
      this.busy = false;
      this.dispatchQueuedJobs();
      await this.refreshStatus().catch(() => {});
    }
  }

  destroy() {
    this.cancelUnload();
    try {
      this.writeStatus({
        automation_ready: false,
        worker_ready: false,
        connected: false,
        busy: false,
        detail: 'TEAMYRA Desktop ChatGPT worker is closed.'
      });
    } catch {}
    clearInterval(this.jobTimer);
    clearInterval(this.heartbeatTimer);
    this.jobTimer = null;
    this.heartbeatTimer = null;
    this.closeEmbeddedPopup();
    if (this.view && !this.view.webContents.isDestroyed()) {
      this.window.contentView.removeChildView(this.view);
      this.view.webContents.close();
    }
    this.view = null;
    this.automation = null;
    this.interactionCssKey = null;
    this.activeJobDir = null;
    this.busy = false;
  }
}

module.exports = { ChatGPTWebProvider, CHATGPT_HOME };
