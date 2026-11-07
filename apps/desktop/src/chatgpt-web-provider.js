const fs = require('node:fs');
const path = require('node:path');
const { WebContentsView, Notification } = require('electron');
const { ChatGPTSessionManager, DEFAULT_CHATGPT_PROFILE_ID } = require('./chatgpt-session-manager');
const { ChatGPTAutomationAdapter, teamyraError, boundedPageCall, pageTimeoutMs } = require('./chatgpt-automation-adapter');
const { WorkspaceBridge } = require('./workspace-bridge');
const { JobProcesses, jobProcesses } = require('./job-processes');
const { JobInspector } = require('./job-inspect');
const { callCore } = require('./core-api');
const { limitNotice, replyLimitNotice, limitScript } = require('./limit-detect');
// A reply overdue this long with nothing being written: look for a usage-limit
// notice on the page (limit-detect.js).
const LIMIT_CHECK_AFTER_MS = 30000;
// While a job is paused for the user (a check, a sign-in), ask the core this
// often whether another agent should take it over (bridge/job_transfer.py).
const HANDOVER_CHECK_MS = 60000;

const CHATGPT_HOME = 'https://chatgpt.com/';
// One tool result per message. ChatGPT never answered messages of 120-132k
// characters (four jobs hung on them on 2026-11-06), so results are kept
// well below that.
const MAX_TOOL_RESULT_CHARS = 40000;
const MAX_TOOL_STEPS = 256;
const MAX_TOOL_PARSE_FAILURES = 3;
const MAX_PROTOCOL_RECOVERIES = 2;
// A reply without a tool request while the job's output files are still
// missing is not a result: ChatGPT stopped early ("the TEAMYRA bridge is not
// available") or a status line was read while it was still thinking. It is
// told what is missing and continues, at most this many times per job.
const MAX_OUTPUT_NUDGES = 2;
const MAX_TRANSIENT_RETRIES = 3;
const SETTLE_RECHECK_MS = 6000;
const CHALLENGE_POLL_MS = 3000;
const PROGRESS_INTERVAL_MS = 30000;
// A page recovery reloads the job conversation. A long job may need several
// over hours, so the limit is on recoveries in a row (reset by every reply)
// plus a generous total, not a fixed two per job.
const MAX_CONSECUTIVE_PAGE_RECOVERIES = 3;
const MAX_PAGE_RECOVERIES = 12;
const PAGE_RECOVERY_BACKOFF_MS = 5000;
// A job interrupted by a desktop restart continues in its own conversation.
const MAX_DESKTOP_RESUMES = 3;
// Waiting jobs: a worker that stays not-ready this long is reloaded, at most
// once per HEAL_INTERVAL_MS, instead of leaving the jobs waiting for hours.
const NOT_READY_HEAL_MS = 45000;
const MAX_NOT_READY_RELOADS = 3;
const RELOAD_INTERVAL_MS = 60000;
const LANE_START_GAP_MS = 15000;
// When an account's extra tab last opened the site.
const LANE_STARTS = new Map();
const HEAL_INTERVAL_MS = 60000;
const QUEUE_NUDGE_MS = 30000;
const PROMPT_WAIT_MS = 30000;
const RENDER_WAIT_MS = 25000;
const JOB_STATE_FILE = 'chatgpt-state.json';
const UNKNOWN_TOOL_OUTCOME = 'TEAMYRA Desktop restarted while this tool was running, so its outcome is unknown. ' +
  'Check the current state first (read the file, list the folder or run git status) and repeat the step only if it did not happen.';
// What a human has to do in the embedded view, worded for the site.
function userActions({ name, id }) {
  return {
    verification: { kind: id + '_verification',
      message: `${name} asks for human verification. Open TEAMYRA Desktop, select the ${name} worker and complete the check; the job resumes automatically.`,
      title: `TEAMYRA: ${name} verification needed`,
      waiting: `waiting: ${name} verification required in TEAMYRA Desktop`, paused: `needs_user: ${name} verification required`,
      resumed: `${name} verification cleared; resuming the same conversation` },
    sign_in: { kind: id + '_sign_in',
      message: `This ${name} account is signed out. Open TEAMYRA Desktop, select the ${name} worker and sign in; the job resumes automatically.`,
      title: `TEAMYRA: ${name} sign-in needed`,
      waiting: `waiting: ${name} sign-in required in TEAMYRA Desktop`, paused: `needs_user: ${name} sign-in required`,
      resumed: `${name} signed in again; resuming the same conversation` },
    stuck: { kind: id + '_stuck',
      message: `The ${name} page in TEAMYRA is not responding. Open the task's chat in TEAMYRA Desktop and check the page; the job continues once it works.`,
      title: `TEAMYRA: ${name} page needs a look`,
      waiting: `waiting: ${name} page not responding; open it in TEAMYRA Desktop`, paused: `needs_user: ${name} page not responding`,
      resumed: `${name} page works again` }
  };
}
const TOOL_ERROR_HINT = 'Reply with one line: TEAMYRA_TOOL_REQUEST {"tool":"<name>","args":{...}} using valid JSON and forward slashes in paths (D:/dir/file). If the task is complete, reply with the final answer without the TEAMYRA_TOOL_REQUEST marker.';
const READ_ONLY_BLOCKED_TOOLS = new Set([
  'process.start', 'process.write',
  'filesystem.create', 'filesystem.write', 'filesystem.patch', 'filesystem.move',
  'filesystem.rename', 'filesystem.delete', 'terminal.run', 'git.add', 'git.commit', 'git.restore'
]);
const ALLOWED_HOSTS = new Set([
  'chatgpt.com', 'www.chatgpt.com', 'auth.openai.com', 'auth0.openai.com', 'openai.com', 'www.openai.com',
  'accounts.google.com', 'login.microsoftonline.com', 'login.live.com', 'appleid.apple.com'
]);

// Everything that differs between web-chat sites. ChatGPT is the default;
// another site (muse-web-provider.js) passes its own.
const CHATGPT_SITE = {
  id: 'chatgpt',
  name: 'ChatGPT',
  provider: 'chatgpt-web',
  stateDir: 'chatgpt',
  home: CHATGPT_HOME,
  hosts: ALLOWED_HOSTS,
  conversationHost: 'chatgpt.com',
  workerId: profileId => profileId === DEFAULT_CHATGPT_PROFILE_ID ? 'chatgpt-normal' : 'chatgpt-' + profileId,
  conversationUrl: id => CHATGPT_HOME + 'c/' + id,
  sessionManager: profileId => new ChatGPTSessionManager(profileId),
  adapter: (webContents, options) => new ChatGPTAutomationAdapter(webContents, options),
  // Extra lines for the job prompt, after the tool protocol.
  promptRules: []
};

// Jobs a tab of this desktop has taken. An account runs several tabs (lanes)
// that all see the same waiting jobs; a tab takes a job only by adding it
// here, synchronously, so two tabs never run one job.
const CLAIMED_JOBS = new Set();

// Unfinished jobs, read once for every tab of every account. Each tab used to
// read every job's meta.json (about a thousand) every 2 s on the desktop's
// main thread; with several accounts and five tabs each that was thousands
// of file reads a second and froze the app. Finished jobs (DONE, which is
// never removed) are remembered and skipped without touching the disk.
const JOB_SCAN = { root: null, at: 0, jobs: [], done: new Set() };

function unfinishedJobs(runtimeRoot, maxAgeMs = 1000) {
  const now = Date.now();
  if (JOB_SCAN.root === runtimeRoot && now - JOB_SCAN.at < maxAgeMs) return JOB_SCAN.jobs;
  if (JOB_SCAN.root !== runtimeRoot) {
    JOB_SCAN.root = runtimeRoot;
    JOB_SCAN.done = new Set();
  }
  const jobsRoot = path.join(runtimeRoot, 'jobs');
  const jobs = [];
  let entries = [];
  try { entries = fs.readdirSync(jobsRoot, { withFileTypes: true }); } catch {}
  for (const entry of entries) {
    if (!entry.isDirectory() || JOB_SCAN.done.has(entry.name)) continue;
    const dir = path.join(jobsRoot, entry.name);
    if (fs.existsSync(path.join(dir, 'DONE'))) {
      JOB_SCAN.done.add(entry.name);
      continue;
    }
    try { jobs.push({ dir, meta: JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')) }); } catch {}
  }
  JOB_SCAN.at = now;
  JOB_SCAN.jobs = jobs;
  return jobs;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// "Sign in with Google" passes through Google's own sites after the account
// is chosen (country domains such as accounts.google.co.in, and
// accounts.youtube.com to set its cookies). Blocking a hop left the sign-in
// stuck on Google's account chooser.
function googleSignInHost(host) {
  return /^accounts\.google\.[a-z]{2,3}(\.[a-z]{2})?$/.test(host) ||
    ['accounts.youtube.com', 'myaccount.google.com', 'gds.google.com', 'ogs.google.com'].includes(host);
}

function safeHttps(url, hosts = ALLOWED_HOSTS) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && (hosts.has(parsed.hostname) || googleSignInHost(parsed.hostname));
  } catch {
    return false;
  }
}

function safePopupUrl(url, hosts = ALLOWED_HOSTS) {
  return url === 'about:blank' || safeHttps(url, hosts);
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

// Fits a tool result into `limit` characters of JSON by shortening its long
// text fields (file content, command output), so what is kept stays readable
// instead of becoming an escaped slice of the whole JSON. Says what was cut.
function boundToolResult(result, limit = MAX_TOOL_RESULT_CHARS) {
  const raw = JSON.stringify(result);
  if (raw.length <= limit) return result;
  const copy = JSON.parse(raw);
  const fields = [];
  const collect = (node, depth) => {
    if (!node || typeof node !== 'object' || depth > 4) return;
    for (const key of Object.keys(node)) {
      if (typeof node[key] === 'string' && node[key].length > 2000) fields.push([node, key, node[key].length]);
      else collect(node[key], depth + 1);
    }
  };
  collect(copy, 0);
  const clippedFields = [];
  for (let round = 0; round < 24 && JSON.stringify(copy).length > limit && fields.length; round += 1) {
    fields.sort((a, b) => b[0][b[1]].length - a[0][a[1]].length);
    const [node, key, original] = fields[0];
    const keep = Math.max(1000, Math.floor(node[key].length / 2));
    if (keep >= node[key].length) break;
    node[key] = node[key].slice(0, keep);
    if (!clippedFields.includes(key)) clippedFields.push(key);
    node[key + '_clipped'] = `kept the first ${keep} of ${original} characters`;
  }
  const note = 'TEAMYRA clipped this tool result to fit one message. Ask for less: a narrower path/query, ' +
    'filesystem.read with offset and a smaller max_bytes (about 30000), or a command that prints only the lines you need.';
  if (copy && typeof copy === 'object' && !Array.isArray(copy) && JSON.stringify(copy).length <= limit) {
    // A read's next_offset no longer matches what was kept.
    if (clippedFields.includes('content') && 'next_offset' in copy) copy.next_offset = null;
    return { ...copy, clipped: true, note };
  }
  // Quotes in the preview are escaped again, so shrink it until it fits.
  let size = limit - 400;
  let bounded = { clipped: true, preview: raw.slice(0, size), note };
  while (JSON.stringify(bounded).length > limit && size > 1000) {
    size = Math.floor(size * 0.8);
    bounded = { clipped: true, preview: raw.slice(0, size), note };
  }
  return bounded;
}

function looksLikeProtocolLoss(text, successfulTools) {
  const reply = String(text || '').replace(/[’‘]/g, "'");
  const refusal = /\b(?:I|we)\s+(?:(?:do not|don't)\s+have\s+access|(?:can(?:not|'t)|am unable to|are unable to)\s+(?:directly\s+)?(?:access|read|write|edit|modify|inspect|open|use))\b[^.!?\n]*(?:files?|filesystem|workspace|repository|repo|local|tools?|TEAMYRA)/i.test(reply);
  const unavailable = /\b(?:TEAMYRA(?:\s+(?:local[- ])?tool)?\s+(?:interface|tools?|bridge)|TEAMYRA(?:\s+local)?[- ]tool[- ]bridge|local[- ]tools?(?:\s+bridge)?|tool\s+(?:interface|bridge))\b[^.!?\n]*(?:not\s+(?:available|accessible|enabled)|unavailable|missing|disabled|don't\s+have|do\s+not\s+have)/i.test(reply) ||
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

// 'verification' / 'sign_in' when the error means a human must act in the
// embedded view, else null.
function userActionKind(error) {
  if (error?.code === 'TEAMYRA_CHALLENGED') return 'verification';
  if (error?.code === 'TEAMYRA_SIGNED_OUT') return 'sign_in';
  return null;
}

function snapBaseline(snap) {
  return snap ? { count: snap.count || 0, text: snap.text || '', messageId: snap.messageId || '' } : null;
}

class ChatGPTWebProvider {
  // `lane`: this tab's index for the account (0 is the one shown in the
  // panel); `laneCount`: how many tabs the account runs at once.
  constructor({ window, runtimeRoot, profileId = DEFAULT_CHATGPT_PROFILE_ID, pageCallTimeoutMs, site = CHATGPT_SITE,
    lane = 0, laneCount = 1 }) {
    this.site = site;
    this.lane = Math.max(0, Number(lane) || 0);
    this.laneCount = Math.max(1, Number(laneCount) || 1);
    this.userActions = userActions(site);
    this.window = window;
    this.runtimeRoot = runtimeRoot;
    this.stateRoot = path.join(runtimeRoot, site.stateDir);
    this.statusFile = path.join(this.stateRoot, 'status.json');
    this.activeProfileId = String(profileId || DEFAULT_CHATGPT_PROFILE_ID);
    this.fixedProfileId = this.activeProfileId;
    this.workerConversationFile = this.profileConversationFile(this.activeProfileId);
    this.sessionManager = site.sessionManager(this.activeProfileId);
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
    this.pageCallTimeoutMs = pageTimeoutMs(pageCallTimeoutMs);
    this.pageUnresponsiveSince = null;
    this.pageGeneration = 0;
    this.statusTimer = null;
    fs.mkdirSync(this.stateRoot, { recursive: true });
    this.writeStatus({
      profile_update: false,
      detail: `Embedded ${this.site.name} available; open it to initialize the session.`,
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
    // The account's first tab reconciles jobs from a previous desktop; the
    // resumed jobs then go to whichever tab is free.
    if (this.lane === 0) this.recoverInterruptedJobs();
    this.sessionManager.initialize();
    this.profileSessionStatus(this.activeProfileId).then(profile => {
      // Cookies can outlive the login: if the page last showed a sign-in form
      // or a human check, keep saying so (the core does not route jobs there).
      let last = {};
      try { last = JSON.parse(fs.readFileSync(this.statusFile, 'utf8')).profiles?.[this.activeProfileId] || {}; } catch {}
      this.writeStatus({
        session_present: profile.signedIn === true,
        // Replaces "worker is closed" left by the previous desktop's exit.
        detail: last.login_visible === true
          ? `${this.site.name} sign-in is required: open this account in TEAMYRA and sign in.`
          : last.challenged === true
            ? `${this.site.name} requires user verification: open this account in TEAMYRA.`
            : profile.signedIn === true
              ? `${this.site.name} account signed in; its worker view loads when a job arrives.`
              : `Open this ${this.site.name} account in TEAMYRA and sign in.`,
        profile_update: true
      });
    }).catch(() => {});
    if (!this.heartbeatTimer) {
      this.heartbeatTimer = setInterval(() => {
        try { this.publishHeartbeat(); } catch {}
      }, 5000);
      this.heartbeatTimer.unref?.();
    }
    if (!this.statusTimer) {
      this.statusTimer = setInterval(() => {
        if (this.view) this.refreshStatus().catch(() => {});
      }, 5000);
      this.statusTimer.unref?.();
    }
    if (!this.jobTimer) {
      this.jobTimer = setInterval(() => this.processPendingJobs().catch(() => {}), 2000);
      this.jobTimer.unref?.();
    }
    return this.getStatus();
  }

  pageCall(operation, label) {
    const generation = this.pageGeneration;
    return boundedPageCall(operation, {
      timeoutMs: this.pageCallTimeoutMs, label,
      onTimeout: () => { if (generation === this.pageGeneration) this.markPageUnresponsive(); }
    });
  }

  markPageUnresponsive() {
    this.pageUnresponsiveSince ||= Date.now();
    this.publishHeartbeat();
  }

  publishHeartbeat() {
    const since = this.pageUnresponsiveSince;
    this.writeStatus({
      busy: this.busy,
      page_unresponsive_since: since ? since / 1000 : null,
      ...(since ? {
        automation_ready: false, worker_ready: false,
        detail: 'page unresponsive since ' + new Date(since).toISOString()
      } : {})
    });
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
      if (meta.provider !== this.site.provider || !['running', 'needs_user'].includes(meta.state) ||
          String(meta.profile_id || DEFAULT_CHATGPT_PROFILE_ID) !== this.activeProfileId ||
          fs.existsSync(path.join(dir, 'DONE'))) continue;
      const saved = this.loadJobState(dir);
      const resumes = Number(meta.desktop_resumes) || 0;
      // Resumable: under the resume limit, and either nothing ran yet or the
      // conversation is known (tools ran in it, so it must be the same one).
      const resumable = resumes < MAX_DESKTOP_RESUMES && !fs.existsSync(path.join(dir, 'CANCEL')) &&
        (saved?.conversation_url || !(Number(saved?.successful_tools) > 0 || saved?.phase === 'tool'));
      if (resumable) {
        const note = `TEAMYRA Desktop restarted; resuming the job in the same ${this.site.name} conversation (${resumes + 1}/${MAX_DESKTOP_RESUMES})`;
        this.appendJobEvent(dir, 'info', note);
        this.writeJobMeta(dir, {
          state: 'waiting_for_desktop', reason: null, attention: null, resume_requested: true,
          desktop_resumes: resumes + 1, dispatched_at: Date.now() / 1000, last_event: note
        });
        continue;
      }
      const detail = resumes >= MAX_DESKTOP_RESUMES
        ? `${this.site.name} desktop restarted ${resumes + 1} times during this job; partial workspace changes are preserved. Resume with a new job.`
        : `${this.site.name} desktop restarted; partial workspace changes are preserved. Resume with a new job.`;
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
      : this.site.sessionManager(profileId);
    if (this.site.sessionFromPage) {
      // The login is kept in the page's own storage (DeepSeek), not in a
      // cookie: use what the account's page showed when it was last loaded.
      let last = {};
      try { last = JSON.parse(fs.readFileSync(this.statusFile, 'utf8')).profiles?.[profileId] || {}; } catch {}
      return { profileId, signedIn: last.session_present === true, cookieCount: 0 };
    }
    const summary = await manager.cookieSummary().catch(() => ({ count: 0, hasSessionCookies: false }));
    return {
      profileId,
      signedIn: summary.hasSessionCookies === true,
      cookieCount: summary.count
    };
  }

  async switchProfile(profileId = DEFAULT_CHATGPT_PROFILE_ID) {
    const next = String(profileId || DEFAULT_CHATGPT_PROFILE_ID).trim() || DEFAULT_CHATGPT_PROFILE_ID;
    if (next !== this.fixedProfileId) throw new Error(`This ${this.site.name} worker is bound to a different account`);
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
        devTools: true,
        backgroundThrottling: false
      }
    });
    this.view.setBackgroundColor('#0b0e14');
    this.view.setBounds(this.bounds);
    this.view.setVisible(this.visible);
    this.window.contentView.addChildView(this.view);
    const generation = this.pageGeneration;
    this.automation = this.site.adapter(this.view.webContents, {
      isVisible: () => this.visible === true,
      timeoutMs: this.pageCallTimeoutMs,
      onTimeout: () => { if (generation === this.pageGeneration) this.markPageUnresponsive(); }
    });

    this.view.webContents.setWindowOpenHandler(({ url }) => {
      if (!safePopupUrl(url, this.site.hosts)) return { action: 'deny' };
      return {
        action: 'allow',
        createWindow: options => this.createEmbeddedPopup(options)
      };
    });
    const guardTopLevelNavigation = event => {
      if (safeHttps(event.url, this.site.hosts)) return;
      event.preventDefault();
      this.noteBlockedNavigation(event.url);
    };
    this.view.webContents.on('will-navigate', guardTopLevelNavigation);
    this.view.webContents.on('will-redirect', guardTopLevelNavigation);
    this.view.webContents.on('did-finish-load', () => {
      this.loaded = true;
      this.refreshStatus().catch(() => {});
    });
    this.view.webContents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
      // A failed iframe (analytics, a challenge widget) or an aborted
      // navigation (-3, superseded by a redirect) leaves the page usable.
      // Treating them as an unloaded page stopped every probe, and waiting
      // jobs then waited for hours for a worker that never became ready.
      if (isMainFrame === false || Number(code) === -3) return;
      this.loaded = false;
      this.writeStatus({ detail: `${this.site.name} page failed to load (${code}): ${description}` });
    });
    this.view.webContents.on('render-process-gone', (_event, details) => {
      this.loaded = false;
      this.markPageUnresponsive();
      this.writeStatus({ detail: `${this.site.name} renderer stopped: ` + (details?.reason || 'unknown') });
    });
    this.view.webContents.on('unresponsive', () => this.markPageUnresponsive());
    this.view.webContents.on('before-input-event', event => {
      if (this.busy && !this.awaitingUser) event.preventDefault();
    });
    return this.view;
  }

  // A page load outside the site's allowed hosts was stopped. Recorded so a
  // stuck sign-in can be traced (logs/web-blocked-navigation.log).
  noteBlockedNavigation(url) {
    let host = '';
    try { host = new URL(url).hostname; } catch {}
    try {
      const file = path.join(this.runtimeRoot, 'logs', 'web-blocked-navigation.log');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, `${new Date().toISOString()} ${this.site.id} ${this.activeProfileId} ${host} ${String(url).slice(0, 300)}\n`);
    } catch {}
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
        devTools: true,
        backgroundThrottling: false
      }
    });
    this.popupView = popup;
    popup.setBackgroundColor('#0b0e14');
    popup.setBounds(this.bounds);
    popup.setVisible(this.visible);
    this.window.contentView.addChildView(popup);

    const guardTopLevelNavigation = event => {
      if (safeHttps(event.url, this.site.hosts)) return;
      event.preventDefault();
      this.noteBlockedNavigation(event.url);
    };
    popup.webContents.on('will-navigate', guardTopLevelNavigation);
    popup.webContents.on('will-redirect', guardTopLevelNavigation);
    popup.webContents.setWindowOpenHandler(({ url }) => {
      if (safePopupUrl(url, this.site.hosts)) {
        setImmediate(() => {
          if (this.popupView === popup && !popup.webContents.isDestroyed()) {
            this.pageCall(() => popup.webContents.loadURL(url), 'popup navigation').catch(() => {});
          }
        });
      }
      return { action: 'deny' };
    });
    popup.webContents.on('destroyed', () => {
      if (this.popupView === popup) this.popupView = null;
      // Its layer must go too, or an empty view stays over the page.
      try { this.window.contentView.removeChildView(popup); } catch {}
      if (!this.busy && this.view && !this.view.webContents.isDestroyed()) {
        this.view.webContents.reload();
      }
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
      await this.pageCall(() => view.webContents.loadURL(this.site.home), 'navigation');
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
          await this.pageCall(() => view.webContents.loadURL(this.site.home), 'navigation');
        }
        await this.pageCall(async () => {
          while (view.webContents.isLoading()) await sleep(120);
        }, 'navigation wait');
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
      // A tab with work waiting would only be loaded again a moment later.
      if (this.busy || this.visible || this.hasPendingWork()) return;
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
    // Control callers acknowledge immediately. Navigation is bounded in its
    // own task and cannot hold up another control request.
    void this.reconnect().catch(() => {});
    return { ok: true };
  }

  async reconnect() {
    const view = this.ensureView();
    this.pageGeneration += 1;
    const generation = this.pageGeneration;
    this.statusRefresh = null;
    this.automation = this.site.adapter(view.webContents, {
      isVisible: () => this.visible === true,
      timeoutMs: this.pageCallTimeoutMs,
      onTimeout: () => { if (generation === this.pageGeneration) this.markPageUnresponsive(); }
    });
    this.loaded = false;
    this.lastProbe = null;
    const current = view.webContents.getURL();
    const target = safeHttps(current, this.site.hosts) ? current : this.site.home;
    await this.pageCall(() => view.webContents.loadURL(target), 'reconnect');
    if (generation !== this.pageGeneration) throw teamyraError(`${this.site.name} navigation superseded`, 'TEAMYRA_PAGE_UNRESPONSIVE', 'page_unresponsive');
    this.loaded = true;
    const probe = await this.automation.probe();
    this.lastProbe = probe;
    this.pageUnresponsiveSince = null;
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
        await this.pageCall(() => this.view.webContents.removeInsertedCSS(key), 'remove CSS').catch(() => {});
      }
      return;
    }
    const view = this.ensureView();
    if (!this.interactionCssKey) {
      this.interactionCssKey = await this.pageCall(() => view.webContents.insertCSS(
        'html { pointer-events: none !important; }'
      ), 'insert CSS');
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
    const workspace = this.workspaceBridge.statusCache?.value || null;
    return {
      id: this.site.workerId(this.activeProfileId),
      provider: this.site.provider,
      profileId: this.activeProfileId,
      connected: Boolean(this.view && !this.view.webContents.isDestroyed() && this.loaded),
      visible: this.visible,
      loaded: this.loaded,
      automationReady: Boolean(!this.pageUnresponsiveSince && this.lastProbe?.promptFound && !this.lastProbe?.challenged),
      workerReady: Boolean(!this.pageUnresponsiveSince && this.lastProbe?.promptFound && !this.lastProbe?.challenged &&
        !this.lastProbe?.loginVisible),
      pageUnresponsiveSince: this.pageUnresponsiveSince,
      detail: this.pageUnresponsiveSince ? 'page unresponsive since ' + new Date(this.pageUnresponsiveSince).toISOString() : '',
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
    const pending = this.refreshStatusOnce().finally(() => { if (this.statusRefresh === pending) this.statusRefresh = null; });
    this.statusRefresh = pending;
    return this.statusRefresh;
  }

  async refreshStatusOnce() {
    // Refresh workspace data separately; a core subprocess cannot delay page
    // status publication or the independent heartbeat.
    Promise.resolve().then(() => this.workspaceBridge.status()).catch(() => {});
    const generation = this.pageGeneration;
    if (this.view && !this.view.webContents.isDestroyed() && this.loaded && this.automation) {
      try {
        const probe = await this.automation.probe();
        if (generation !== this.pageGeneration) return this.getStatus();
        this.lastProbe = probe;
      } catch {
        if (generation === this.pageGeneration) this.lastProbe = null;
      }
    }
    const status = await this.getStatus();
    // A site without a login cookie records what its loaded page shows.
    const pageSession = this.site.sessionFromPage && this.loaded && this.lastProbe
      ? { session_present: Boolean(this.lastProbe.promptFound && !this.lastProbe.loginVisible) } : {};
    this.writeStatus({
      ...pageSession,
      automation_ready: status.automationReady,
      worker_ready: status.workerReady,
      workspace: status.workspace?.workspace || '',
      connected: status.connected,
      login_visible: status.loginVisible,
      challenged: status.challenged,
      busy: status.busy,
      url: status.url,
      detail: status.pageUnresponsiveSince ? status.detail : status.challenged
        ? `${this.site.name} requires user verification in the embedded view.`
        : status.automationReady && !status.workspace?.available
          ? `Embedded ${this.site.name} session is active; select a workspace to enable worker routing.`
          : status.automationReady
            ? `Embedded ${this.site.name} session is active.`
          : status.loginVisible
            ? `${this.site.name} sign-in is required in the embedded view.`
            : status.connected
              ? `${this.site.name} page loaded; waiting for an interactive prompt.`
              : `Embedded ${this.site.name} is not currently loaded.`
    });
    return status;
  }

  writeStatus(patch = {}) {
    // The account's first tab owns its status entry; extra tabs would
    // overwrite it with their own (often unloaded) page state.
    if (this.lane > 0) return {};
    let current = {};
    try { current = JSON.parse(fs.readFileSync(this.statusFile, 'utf8')); } catch {}
    const profileId = patch.active_profile_id || this.activeProfileId || DEFAULT_CHATGPT_PROFILE_ID;
    const workerId = this.site.workerId(profileId);
    const statusPatch = { ...patch };
    const updateProfile = statusPatch.profile_update !== false;
    delete statusPatch.profile_update;

    // `lanes` tells the core how many jobs this account can run at once.
    const profilePatch = { heartbeat_at: Date.now() / 1000, lanes: this.laneCount };
    for (const key of [
      'automation_ready', 'worker_ready', 'connected', 'login_visible',
      'challenged', 'busy', 'url', 'detail', 'session_present', 'page_unresponsive_since'
    ]) {
      if (Object.prototype.hasOwnProperty.call(statusPatch, key)) profilePatch[key] = statusPatch[key];
    }

    const profiles = { ...(current.profiles || {}) };
    if (updateProfile) {
      profiles[profileId] = { ...(profiles[profileId] || {}), ...profilePatch };
    }
    const data = {
      ...current,
      provider: this.site.provider,
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
      : this.site.conversationUrl(String(value || ''));
    if (!safeHttps(url, this.site.hosts) || !new URL(url).hostname.endsWith(this.site.conversationHost)) {
      throw new Error(`Invalid ${this.site.name} conversation URL`);
    }
    await this.pageCall(() => view.webContents.loadURL(url), 'conversation navigation');
    this.loaded = true;
    return this.refreshStatus();
  }

  async sendTask(text) {
    this.ensureView();
    if (!this.loaded) await this.ensureLoaded({ visible: this.visible });

    let probe = null;
    const deadline = Date.now() + (this.promptWaitMs ?? PROMPT_WAIT_MS);
    while (Date.now() < deadline) {
      probe = await this.automation.probe();
      if (probe.challenged) {
        throw teamyraError(`${this.site.name} requires user verification in the embedded view`, 'TEAMYRA_CHALLENGED', this.site.id + '_verification');
      }
      if (probe.loginVisible) throw teamyraError(`${this.site.name} sign-in is required`, 'TEAMYRA_SIGNED_OUT', this.site.id + '_sign_in');
      if (probe.promptFound) break;
      await sleep(250);
    }

    // A prompt that never appears is a page problem (still hydrating, a
    // stuck overlay): the job loop reloads the conversation and checks
    // whether the message arrived, instead of failing the job.
    if (!probe?.promptFound) throw teamyraError(`${this.site.name} prompt is unavailable`, 'TEAMYRA_PAGE_UNRESPONSIVE', 'page_unresponsive');
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
    return this.attachApprovedFile(approvedPath);
  }

  // A screenshot TEAMYRA took for the running job (inside its job folder).
  // Waits until the page shows the image in the message box, so the next
  // message carries it.
  async attachScreenshot(filePath) {
    const jobsRoot = path.resolve(this.runtimeRoot || '', 'jobs');
    const resolved = path.resolve(String(filePath || ''));
    if (!resolved.startsWith(jobsRoot + path.sep) || !fs.existsSync(resolved)) throw new Error('not a TEAMYRA job screenshot');
    await this.attachApprovedFile(resolved);
    const deadline = Date.now() + (this.attachWaitMs ?? 20000);
    while (Date.now() < deadline) {
      const ready = await this.automation.evaluate(`(() => {
        const box = document.querySelector('form') || document;
        const preview = box.querySelector('img[src^="blob:"], img[alt*="Uploaded"], [data-testid*="attachment"] img, [class*="attachment"] img');
        const busy = box.querySelector('[role="progressbar"], [aria-busy="true"]');
        return Boolean(preview && !busy);
      })()`).catch(() => false);
      if (ready) return { ok: true };
      await sleep(500);
    }
    throw new Error(`${this.site.name} did not show the uploaded image`);
  }

  async attachApprovedFile(approvedPath) {
    const view = this.ensureView();
    await this.automation.evaluate(`(() => {
      const button = document.querySelector('button[aria-label*="Attach"], button[aria-label*="attach"], button[data-testid*="attach"]');
      if (button) button.click();
      return !!button;
    })()`);
    await sleep(350);
    const debuggerApi = view.webContents.debugger;
    let attachedHere = false;
    try {
      if (!debuggerApi.isAttached()) {
        debuggerApi.attach('1.3');
        attachedHere = true;
      }
      const { root } = await this.pageCall(() => debuggerApi.sendCommand('DOM.getDocument', { depth: -1, pierce: true }), 'DOM.getDocument');
      const { nodeId } = await this.pageCall(() => debuggerApi.sendCommand('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type="file"]' }), 'DOM.querySelector');
      if (!nodeId) throw new Error(`${this.site.name} file input was not found`);
      await this.pageCall(() => debuggerApi.sendCommand('DOM.setFileInputFiles', { nodeId, files: [approvedPath] }), 'DOM.setFileInputFiles');
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

  // Jobs this profile owns and has not finished: { waiting, owned } plus
  // whether any ChatGPT job anywhere is still queued.
  scanJobs() {
    const waiting = [];
    let owned = 0;
    let queued = 0;
    for (const { dir, meta } of unfinishedJobs(this.runtimeRoot, this.jobScanMaxAgeMs ?? 1000)) {
      if (meta.provider !== this.site.provider) continue;
      if (meta.state === 'queued') { queued += 1; continue; }
      if (String(meta.profile_id || DEFAULT_CHATGPT_PROFILE_ID) !== this.activeProfileId) continue;
      if (['waiting_for_desktop', 'running', 'needs_user'].includes(meta.state)) owned += 1;
      if (meta.state === 'waiting_for_desktop') waiting.push({ dir, meta });
    }
    // A job resumed after a desktop restart goes first; then oldest first.
    waiting.sort((a, b) => (b.meta.resume_requested ? 1 : 0) - (a.meta.resume_requested ? 1 : 0) ||
      (a.meta.created || 0) - (b.meta.created || 0));
    return { waiting, owned, queued };
  }

  // True while this profile has unfinished ChatGPT work; the desktop must not
  // idle-exit then, however long the jobs have been waiting.
  hasPendingWork() {
    return this.busy || (this.pendingJobCount || 0) > 0;
  }

  // Fails a waiting job whose time budget ran out while the worker was not
  // ready, with the reason it waited, so it never sits for hours unnoticed.
  expireWaitingJob({ dir, meta }) {
    const start = Number(meta.dispatched_at || meta.created || 0);
    const timeout = Number(meta.timeout_s || 0);
    if (!start || !timeout || Date.now() / 1000 <= start + timeout) return false;
    const detail = `timed out waiting for the embedded ${this.site.name} worker` +
      (meta.last_event && /^waiting: /.test(meta.last_event) ? ' (' + meta.last_event.slice(9) + ')' : '');
    this.appendJobEvent(dir, 'error', detail);
    this.writeJobMeta(dir, {
      state: 'failed', reason: 'timeout', exit_code: 1, attention: null, ended: Date.now() / 1000,
      last_event: detail, recovery_state: 'timed_out_waiting_for_desktop'
    });
    fs.writeFileSync(path.join(dir, 'DONE'), 'failed', 'utf8');
    return true;
  }

  async processPendingJobsOnce() {
    if (this.busy) return;
    const scan = this.scanJobs();
    this.pendingJobCount = scan.owned;
    // Only jobs no other tab of this account has taken.
    let candidates = scan.waiting.filter(job => !CLAIMED_JOBS.has(job.dir));
    if (this.lane === 0 && candidates.some(job => this.expireWaitingJob(job))) {
      candidates = candidates.filter(job => !fs.existsSync(path.join(job.dir, 'DONE')));
      this.dispatchQueuedJobs();
    }
    if (!candidates.length) {
      this.notReadySince = null;
      // Queued ChatGPT jobs normally start from the core's scheduler. If the
      // core is not running, an idle worker asks for the next job itself.
      if (this.lane === 0 && scan.queued && scan.owned < this.laneCount &&
          Date.now() - (this.lastQueueNudge || 0) >= QUEUE_NUDGE_MS) {
        this.lastQueueNudge = Date.now();
        this.dispatchQueuedJobs();
      }
      return;
    }
    // Extra tabs open the site only once the account's first tab is ready:
    // five tabs loading a page that is not (a human check, a sign-in) made
    // more human checks (Qwen showed its captcha again and again).
    if (this.lane > 0 && !this.accountReady()) return;
    if (this.pageUnresponsiveSince && this.mayReloadNow()) {
      this.noteReload();
      await this.reconnect().catch(() => {});
    }
    if (!this.view || this.view.webContents.isDestroyed()) {
      // Extra tabs of one account open the site at least LANE_START_GAP_MS
      // apart, not all in the same moment.
      if (this.lane > 0) {
        const account = this.site.id + ':' + this.activeProfileId;
        if (Date.now() - (LANE_STARTS.get(account) || 0) < (this.laneStartGapMs ?? LANE_START_GAP_MS)) return;
        LANE_STARTS.set(account, Date.now());
      }
      await this.wakeBackground();
    }
    let status = await this.refreshStatus();
    if (!status.workerReady && !status.challenged && !status.loginVisible) {
      status = await this.healNotReady(status);
    } else if (status.workerReady) {
      this.notReadySince = null;
      this.heals = 0;
    }
    if (!status.workerReady) {
      // Keep the jobs waiting, but explain on each of them why they wait
      // (the first tab speaks for the account).
      if (this.lane === 0) this.markWaitingJobs(candidates, status);
      return;
    }
    if (this.lane === 0) this.markWaitingJobs(candidates, null);
    // Another tab may have taken a job while this one loaded. Check and
    // claim with no await in between.
    const next = candidates.find(job => !CLAIMED_JOBS.has(job.dir) && this.stillWaiting(job.dir));
    if (!next) return;
    CLAIMED_JOBS.add(next.dir);
    try {
      await this.runDelegatedJob(next.dir);
    } finally {
      CLAIMED_JOBS.delete(next.dir);
      // An extra tab gives its page back once it has been idle a while.
      if (this.lane > 0) this.scheduleUnload(60000);
    }
  }

  stillWaiting(jobDir) {
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(jobDir, 'meta.json'), 'utf8'));
      return meta.state === 'waiting_for_desktop' && !fs.existsSync(path.join(jobDir, 'DONE'));
    } catch { return false; }
  }

  // The page is loaded (or should be) but has no usable prompt: still
  // hydrating, an error page, a stuck overlay. Reload it after a grace period.
  // Background reloads (a page that is not ready or does not answer): never
  // of a page the user is looking at, at most one a minute, and at most
  // MAX_NOT_READY_RELOADS in a row until the page works again. A page that
  // answered slowly (a human check loading) was reloaded every few seconds,
  // and each reload brought a new check.
  mayReloadNow() {
    if (this.visible) return false;
    if ((this.heals || 0) >= (this.maxHeals ?? MAX_NOT_READY_RELOADS)) return false;
    return Date.now() - (this.lastReloadAt || 0) >= (this.reloadIntervalMs ?? RELOAD_INTERVAL_MS);
  }

  noteReload() {
    this.lastReloadAt = Date.now();
    this.heals = (this.heals || 0) + 1;
  }

  // The account's first tab reported a usable page in the last minute.
  accountReady() {
    try {
      const profile = JSON.parse(fs.readFileSync(this.statusFile, 'utf8')).profiles?.[this.activeProfileId] || {};
      return profile.automation_ready === true && Date.now() / 1000 - Number(profile.heartbeat_at || 0) < 60;
    } catch {
      return false;
    }
  }

  async healNotReady(status) {
    // Never reload a page the user is looking at (solving a check, signing
    // in), and stop after a few reloads in a row: each reload of a site with
    // a human check brought a new check.
    if (this.visible) return status;
    if ((this.heals || 0) >= (this.maxHeals ?? MAX_NOT_READY_RELOADS)) {
      return { ...status, detail: `${this.site.name} page did not become usable after ${this.heals} reloads; open it in TEAMYRA (it may be showing a check)` };
    }
    if (!this.mayReloadNow()) return status;
    const now = Date.now();
    this.notReadySince ||= now;
    const graceMs = this.notReadyHealMs ?? NOT_READY_HEAL_MS;
    const unloaded = this.view && !this.loaded;
    if ((now - this.notReadySince < graceMs && !unloaded) ||
        now - (this.lastHealAt || 0) < (this.healIntervalMs ?? HEAL_INTERVAL_MS)) return status;
    this.lastHealAt = now;
    this.noteReload();
    try { await this.reconnect(); } catch {}
    return this.refreshStatus();
  }

  // Writes attention / last_event on jobs that wait for this worker. `status`
  // is the not-ready worker status, or null when the worker is ready again.
  markWaitingJobs(candidates, status) {
    const stuck = status && !status.challenged && !status.loginVisible &&
      (this.heals || 0) >= (this.maxHeals ?? MAX_NOT_READY_RELOADS);
    const action = status?.challenged ? this.userActions.verification : status?.loginVisible ? this.userActions.sign_in
      : stuck ? this.userActions.stuck : null;
    let notify = false;
    for (const { dir, meta } of candidates) {
      const userKinds = [this.userActions.verification.kind, this.userActions.sign_in.kind, this.userActions.stuck.kind];
      const current = userKinds.includes(meta.attention?.kind) ? meta.attention.kind : null;
      const patch = {};
      if (action) {
        if (current !== action.kind) {
          patch.attention = { kind: action.kind, since: Date.now() / 1000, message: action.message };
          patch.last_event = action.waiting;
          notify = true;
        }
      } else {
        if (current) patch.attention = null;
        if (status) {
          const seconds = this.notReadySince ? Math.round((Date.now() - this.notReadySince) / 1000) : 0;
          const detail = `waiting: embedded ${this.site.name} worker is not ready` +
            (this.heals ? ` (reloaded ${this.heals}x)` : '') + (status.detail ? ': ' + status.detail : '');
          if (meta.last_event !== detail) patch.last_event = detail;
          if (seconds && !meta.not_ready_since) patch.not_ready_since = this.notReadySince / 1000;
        } else if (meta.not_ready_since) {
          patch.not_ready_since = null;
        }
      }
      if (!Object.keys(patch).length) continue;
      try {
        const updated = this.writeJobMeta(dir, patch);
        Object.assign(meta, updated);
      } catch {}
    }
    if (notify) this.notifyUser(action.title, action.message);
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
    if (Date.now() >= job.deadline) throw teamyraError(`${this.site.name} job timed out`, 'TEAMYRA_TIMEOUT', 'timeout');
  }

  recordJobUsage(job) {
    try { this.writeJobMeta(job.dir, { usage: { ...job.usage } }); } catch {}
  }

  // Looks once for a usage-limit notice on the page (limit-detect.js) and
  // remembers it on the job. Returns the notice or ''. Never throws.
  async checkLimit(job) {
    if (job.limitNotice) return job.limitNotice;
    const view = this.view;
    if (this.limitCheckRunning || !view?.webContents || view.webContents.isDestroyed?.()) return '';
    this.limitCheckRunning = true;
    try {
      const text = await this.pageCall(() => view.webContents.executeJavaScript(limitScript(), true), 'limit check');
      const notice = limitNotice(text);
      if (notice) job.limitNotice = notice;
      return notice;
    } catch {
      return '';
    } finally {
      this.limitCheckRunning = false;
    }
  }

  // The job ends with reason usage_or_rate_limit: the core cools this account
  // down and hands the job to another agent (bridge/job_transfer.py).
  limitError(job) {
    return teamyraError(`${this.site.name} usage limit: ${job.limitNotice}`, 'TEAMYRA_LIMIT', 'usage_or_rate_limit');
  }

  // Pauses the job as needs_user until the ChatGPT verification is gone. The
  // job keeps its conversation; it fails only on cancel or deadline.
  // Pauses the job as needs_user until the user acted (verification passed,
  // or signed in again). The job keeps its conversation; it fails only on
  // cancel or deadline. `kind` is 'verification' or 'sign_in'.
  async waitForChallengeResolution(job, kind = 'verification') {
    const action = this.userActions[kind] || this.userActions.verification;
    const since = Date.now() / 1000;
    this.appendJobEvent(job.dir, 'attention', action.message);
    this.writeJobMeta(job.dir, {
      state: 'needs_user',
      reason: action.kind,
      attention: { kind: action.kind, since, message: action.message },
      last_event: action.paused
    });
    this.notifyUser(action.title, action.message);
    this.awaitingUser = true;
    await this.setInteractionLocked(false).catch(() => {});
    let nextHandoverCheck = Date.now() + (this.handoverCheckMs ?? HANDOVER_CHECK_MS);
    try {
      for (;;) {
        this.checkJobActive(job);
        // Nobody did the check in time and another agent is ready: end here,
        // and the core continues the job there with everything done so far.
        // Not while the user has this chat open (they may be solving it).
        if (Date.now() >= nextHandoverCheck) {
          nextHandoverCheck = Date.now() + (this.handoverCheckMs ?? HANDOVER_CHECK_MS);
          if (!this.visible) {
            const check = await callCore('transfer.check', { job_id: path.basename(job.dir) }).catch(() => null);
            if (check?.handover) {
              const to = (check.to || []).slice(0, 1).join('');
              throw teamyraError(`${action.paused}; nobody completed it, so the task moves to another agent` +
                (to ? ` (${to})` : ''), 'TEAMYRA_HANDOVER', 'needs_user_timeout');
            }
          }
        }
        let probe = null;
        try { probe = await this.automation.probe(); } catch (error) {
          if (error?.code === 'TEAMYRA_PAGE_UNRESPONSIVE') throw error;
        }
        if (probe && !probe.challenged && !probe.loginVisible && probe.promptFound) break;
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
      last_event: kind === 'sign_in' ? `resumed after ${this.site.name} sign-in` : `resumed after ${this.site.name} verification`
    });
    this.appendJobEvent(job.dir, 'info', action.resumed);
    // A sign-in may land on a new page; go back to the job conversation.
    if (job.conversationUrl) {
      const current = await this.getCurrentConversation().catch(() => null);
      if (current?.conversationId !== job.conversationId) await this.openConversation(job.conversationUrl).catch(() => {});
    }
    await this.refreshStatus().catch(() => {});
  }

  async sendJobMessage(job, text) {
    let sendRetries = 0;
    for (;;) {
      this.checkJobActive(job);
      try {
        const snap = await this.automation.assistantSnapshot();
        if (snap?.challenged) {
          throw teamyraError(`${this.site.name} requires user verification in the embedded view`, 'TEAMYRA_CHALLENGED', this.site.id + '_verification');
        }
        await this.sendTask(text);
        job.usage.chars_sent += String(text || '').length;
        job.usage.turns += 1;
        this.recordJobUsage(job);
        return snap;
      } catch (error) {
        const kind = userActionKind(error);
        // The Send button can stay disabled for a while (an image still
        // uploading): nothing was sent, so wait and send again.
        if (!kind && /send-button-unavailable/.test(String(error?.message)) && sendRetries < 3) {
          sendRetries += 1;
          this.appendJobEvent(job.dir, 'info', `${this.site.name} Send button not available; sending again (${sendRetries}/3)`);
          await sleep(this.sendRetryMs ?? 5000);
          continue;
        }
        // A site at its limit can block the message box or the Send button.
        if (!kind && await this.checkLimit(job)) throw this.limitError(job);
        if (!kind) throw error;
        await this.waitForChallengeResolution(job, kind);
      }
    }
  }

  // Is `text` the last user message of the open conversation? Right after a
  // reload or a cold desktop start the conversation can take many seconds to
  // render; "no user message yet" is not an answer, so wait for the render
  // (up to RENDER_WAIT_MS) and only then compare. Deciding too early made a
  // live resume send an already delivered tool result a second time.
  async lastUserMessageMatches(text) {
    const expected = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 160);
    const deadline = Date.now() + (this.renderWaitMs ?? RENDER_WAIT_MS);
    let differing = 0;
    for (;;) {
      const last = String(await this.automation.lastUserMessage().catch(() => '') || '').replace(/\s+/g, ' ').trim();
      if (last && expected && last.startsWith(expected)) return true;
      // A rendered conversation whose last user message is another one,
      // seen a few times in a row: the message was not delivered.
      if (last) differing += 1;
      if (differing >= 3 || Date.now() >= deadline) return false;
      await sleep(this.resumePollMs ?? 1000);
    }
  }

  // After a pause, reload or desktop restart: back in the job conversation,
  // was the last message delivered? If not, it has to be sent again. This
  // check is what keeps a recovery from submitting the same message twice.
  async lastMessageDelivered(job, text) {
    const current = await this.getCurrentConversation();
    if (job.conversationUrl && current?.conversationId !== job.conversationId) {
      await this.openConversation(job.conversationUrl);
    }
    if (await this.lastUserMessageMatches(text)) return true;
    if (job.conversationUrl || typeof this.automation.latestConversationUrl !== 'function') return false;
    // The conversation URL was never seen (the page hung right after Send).
    // This profile runs one job at a time, so a delivered first message is
    // the newest conversation in the sidebar; adopt it only if it matches.
    const latest = await this.automation.latestConversationUrl().catch(() => '');
    if (!latest || latest === current?.url) return false;
    await this.openConversation(latest);
    if (await this.lastUserMessageMatches(text)) {
      const conversation = await this.getCurrentConversation();
      this.rememberConversation(job, conversation);
      return true;
    }
    await this.createConversation();
    return false;
  }

  rememberConversation(job, conversation) {
    if (!conversation?.conversationId || conversation.conversationId === job.conversationId) return;
    job.conversationId = conversation.conversationId;
    job.conversationUrl = conversation.url;
    this.saveJobState(job, { conversation_id: job.conversationId, conversation_url: job.conversationUrl });
    try { this.writeJobMeta(job.dir, { session_id: job.conversationId, chatgpt_url: job.conversationUrl }); } catch {}
  }

  // Durable per-job progress (jobs/<id>/chatgpt-state.json): the
  // conversation, the message being exchanged, the reply being processed and
  // the tool being run. A desktop restart resumes the job from it.
  loadJobState(jobDir) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(jobDir, JOB_STATE_FILE), 'utf8'));
      return data && typeof data === 'object' ? data : null;
    } catch { return null; }
  }

  saveJobState(job, patch) {
    try {
      const file = path.join(job.dir, JOB_STATE_FILE);
      job.state = { ...(job.state || this.loadJobState(job.dir) || {}), ...patch, updated: Date.now() / 1000 };
      const temp = file + '.tmp-' + process.pid;
      fs.writeFileSync(temp, JSON.stringify(job.state), 'utf8');
      fs.renameSync(temp, file);
    } catch {}
  }

  // Sends one message and waits for its reply, surviving verification pauses
  // and page recoveries. With `resumeSnap` the message was already delivered
  // (desktop restart) and only its reply is awaited.
  // A reply that would end the job early gets a second look: ChatGPT can show
  // a short status line ("Checked shell readiness") that sits still for a few
  // seconds while it is still thinking. Returns a newer reply, or `reply`.
  async settleReply(job, reply) {
    await sleep(this.settleRecheckMs ?? SETTLE_RECHECK_MS);
    let snap = null;
    try { snap = await this.automation.assistantSnapshot(); } catch { return reply; }
    if (!snap || (!snap.generating && snap.text === reply.text)) return reply;
    this.appendJobEvent(job.dir, 'info',
      `${this.site.name} was still working after "${String(reply.text || '').slice(0, 80)}"; waiting for its reply`);
    // Nothing is sent here, so a hang or error just keeps the first reply;
    // the caller then asks to continue or ends the job as before.
    try {
      const next = await this.automation.waitForAssistantReply({
        previousCount: snap.count, previousText: reply.text, previousMessageId: '',
        deadline: job.deadline, shouldCancel: job.isCancelled, detectChallenge: false,
        noProgressMs: this.noProgressMs ?? 300000, pollMs: this.replyPollMs
      });
      job.usage.chars_received += String(next.text || '').length;
      this.recordJobUsage(job);
      this.saveJobState(job, { phase: 'reply', reply: next.text || '', message: null, baseline: null });
      return next;
    } catch (error) {
      if (error?.code === 'TEAMYRA_CANCELLED') throw error;
      return reply;
    }
  }

  async jobExchange(job, text, resumeSnap = null) {
    let snap = resumeSnap;
    for (;;) {
      this.checkJobActive(job);
      try {
        if (!snap) {
          // Keep the baseline even if sending hangs after clicking Send.
          snap = await this.automation.assistantSnapshot();
          this.saveJobState(job, { phase: 'sending', message: text, baseline: snapBaseline(snap) });
          await this.sendJobMessage(job, text);
          this.saveJobState(job, { phase: 'awaiting' });
        }
        const current = await this.getCurrentConversation();
        this.rememberConversation(job, current);
        const reply = await this.automation.waitForAssistantReply({
          previousCount: snap.count,
          previousText: snap.text,
          previousMessageId: snap.messageId,
          deadline: job.deadline,
          // A usage-limit notice ends the wait too (handled in the catch below).
          shouldCancel: () => job.isCancelled() || Boolean(job.limitNotice),
          detectChallenge: true,
          noProgressMs: this.noProgressMs ?? 300000,
          shouldRecover: () => Boolean(this.pageUnresponsiveSince),
          pollMs: this.replyPollMs,
          progressIntervalMs: this.progressIntervalMs ?? PROGRESS_INTERVAL_MS,
          onProgress: ({ elapsedMs, generating }) => {
            if (!generating && elapsedMs >= (this.limitCheckAfterMs ?? LIMIT_CHECK_AFTER_MS)) this.checkLimit(job);
            const seconds = Math.round(elapsedMs / 1000);
            this.writeJobMeta(job.dir, {
              last_event: generating ? `${this.site.id} generating ${seconds} s` : `waiting for ${this.site.id} reply ${seconds} s`
            });
          }
        });
        job.usage.chars_received += String(reply.text || '').length;
        this.recordJobUsage(job);
        const conversation = await this.getCurrentConversation().catch(() => null);
        this.rememberConversation(job, conversation);
        // The "reply" is the site's limit message, not an answer.
        const limitReply = replyLimitNotice(reply.text);
        if (limitReply) {
          job.limitNotice = limitReply;
          throw this.limitError(job);
        }
        // A reply arrived: the page works again, so a later hang gets a fresh
        // set of recoveries.
        job.consecutiveRecoveries = 0;
        this.saveJobState(job, { phase: 'reply', reply: reply.text || '', message: null, baseline: null });
        return reply;
      } catch (caught) {
        let error = caught;
        if (error?.code === 'TEAMYRA_LIMIT') throw error;
        if (job.limitNotice && !job.isCancelled()) throw this.limitError(job);
        // A page that stopped answering may be showing a usage limit.
        if (error?.code === 'TEAMYRA_PAGE_UNRESPONSIVE' && await this.checkLimit(job)) throw this.limitError(job);
        if (error?.code === 'TEAMYRA_PAGE_UNRESPONSIVE') {
          try {
            const delivered = await this.recoverJobPage(job, () => snap ? this.lastMessageDelivered(job, text) : false);
            if (!delivered) {
              if (snap) this.appendJobEvent(job.dir, 'info', `the last message did not reach ${this.site.name} before the page hung; sending it again`);
              snap = null;
            }
            continue;
          } catch (recoveryError) {
            // The reload showed a verification or sign-in page: pause below.
            if (!userActionKind(recoveryError)) throw recoveryError;
            error = recoveryError;
          }
        }
        const kind = userActionKind(error);
        if (!kind) throw error;
        await this.waitForChallengeResolution(job, kind);
        if (!await this.lastMessageDelivered(job, text)) {
          this.appendJobEvent(job.dir, 'info', 'last message was lost during the pause; sending it again');
          snap = await this.sendJobMessage(job, text);
          this.saveJobState(job, { phase: 'awaiting', message: text, baseline: snapBaseline(snap) });
        }
      }
    }
  }

  async recoverJobPage(job, afterReload = null) {
    this.markPageUnresponsive();
    const limit = this.maxConsecutiveRecoveries ?? MAX_CONSECUTIVE_PAGE_RECOVERIES;
    const total = this.maxPageRecoveries ?? MAX_PAGE_RECOVERIES;
    while ((job.consecutiveRecoveries || 0) < limit && (job.pageRecoveries || 0) < total) {
      this.checkJobActive(job);
      job.pageRecoveries = (job.pageRecoveries || 0) + 1;
      job.consecutiveRecoveries = (job.consecutiveRecoveries || 0) + 1;
      this.writeJobMeta(job.dir, { page_recoveries: job.pageRecoveries, last_event: `recovering unresponsive ${this.site.name} page` });
      this.appendJobEvent(job.dir, 'page_recovery',
        `reloading the job conversation (attempt ${job.consecutiveRecoveries}/${limit}, ${job.pageRecoveries} this job)`);
      if (job.consecutiveRecoveries > 1) {
        await sleep(Math.min((this.recoveryBackoffMs ?? PAGE_RECOVERY_BACKOFF_MS) * (job.consecutiveRecoveries - 1),
          Math.max(1, job.deadline - Date.now())));
      }
      try {
        const current = await this.getCurrentConversation();
        if (!job.conversationUrl) this.rememberConversation(job, current);
        await this.reconnect();
        if (job.conversationUrl) await this.openConversation(job.conversationUrl);
        this.checkJobActive(job);
        await this.setInteractionLocked(true);
        const result = afterReload ? await afterReload() : true;
        this.pageUnresponsiveSince = null;
        return result;
      } catch (error) {
        this.checkJobActive(job);
        if (userActionKind(error)) throw error;
      }
    }
    throw teamyraError(`${this.site.name} page unresponsive after ${job.consecutiveRecoveries || 0} reloads in a row` +
      ` (${job.pageRecoveries || 0} this job)`, 'TEAMYRA_PAGE_UNRESPONSIVE', 'page_unresponsive');
  }

  // First exchange of a job resumed after a desktop restart, from its saved
  // state. Nothing that already happened is repeated: a delivered message is
  // not sent again, a received reply is processed as is, and a tool that was
  // running is reported to ChatGPT as having an unknown outcome.
  async resumeExchange(job, saved, bootstrap) {
    if (saved.phase === 'reply' && typeof saved.reply === 'string' && saved.reply) {
      this.appendJobEvent(job.dir, 'info', 'resume: processing the reply received before the restart');
      return { text: saved.reply };
    }
    if (saved.phase === 'tool' && saved.request?.tool) {
      this.appendJobEvent(job.dir, 'info', `resume: ${saved.request.tool} was running during the restart; reporting an unknown outcome`);
      return this.jobExchange(job, 'TEAMYRA_TOOL_RESULT ' + JSON.stringify({
        tool: saved.request.tool, result: { ok: false, error: UNKNOWN_TOOL_OUTCOME }
      }) + '\nContinue the task.');
    }
    if ((saved.phase === 'sending' || saved.phase === 'awaiting') && saved.message) {
      if (await this.lastMessageDelivered(job, saved.message)) {
        this.appendJobEvent(job.dir, 'info', 'resume: the last message was delivered; waiting for its reply');
        return this.jobExchange(job, saved.message, saved.baseline || { count: 0, text: '', messageId: '' });
      }
      this.appendJobEvent(job.dir, 'info', 'resume: the last message was not delivered; sending it again');
      return this.jobExchange(job, saved.message);
    }
    return this.jobExchange(job, bootstrap);
  }

  dispatchQueuedJobs() {
    // Job completion must never wait for (or fail because of) queue dispatch.
    Promise.resolve().then(() => callCore('scheduler.dispatch')).catch(error => {
      console.error(`${this.site.name} queue dispatch failed:`, error);
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
      conversationUrl: null,
      state: {},
      pageRecoveries: 0,
      consecutiveRecoveries: 0
    };
    try {
      const spec = JSON.parse(fs.readFileSync(path.join(jobDir, 'spec.json'), 'utf8'));
      const task = fs.readFileSync(path.join(jobDir, 'task.txt'), 'utf8');
      let startMeta = {};
      try { startMeta = JSON.parse(fs.readFileSync(path.join(jobDir, 'meta.json'), 'utf8')); } catch {}
      // A job interrupted by a desktop restart continues where it stopped,
      // in the same conversation and within its original time budget.
      const resume = startMeta.resume_requested === true ? this.loadJobState(jobDir) : null;
      if (resume) job.state = resume;
      job.usage = { ...job.usage, ...(resume && startMeta.usage ? startMeta.usage : {}) };
      const startedMs = resume && Number(startMeta.started) ? Number(startMeta.started) * 1000 : Date.now();
      job.deadline = startedMs + Number(spec.timeout || 3600) * 1000;
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

      const requestedConversation = resume?.conversation_id
        ? { conversationId: resume.conversation_id, url: resume.conversation_url }
        : spec.session_id ? { conversationId: spec.session_id } : null;
      job.conversationId = requestedConversation?.conversationId || null;
      job.conversationUrl = requestedConversation?.url ||
        (job.conversationId ? this.site.conversationUrl(job.conversationId) : null);
      if (job.conversationId) this.saveJobState(job, { conversation_id: job.conversationId, conversation_url: job.conversationUrl });
      try {
        if (job.conversationUrl) await this.openConversation(job.conversationUrl);
        else await this.createConversation();
        await this.setInteractionLocked(true);
      } catch (error) {
        if (error?.code !== 'TEAMYRA_PAGE_UNRESPONSIVE') throw error;
        await this.recoverJobPage(job);
      }
      this.writeJobMeta(jobDir, {
        state: 'running', ...(resume ? {} : { started: Date.now() / 1000 }), runner_pid: null, attention: null,
        resume_requested: false, not_ready_since: null, usage: { ...job.usage },
        last_event: resume ? 'running: resumed after a desktop restart' : `running: embedded ${this.site.name} worker started`
      });
      this.appendJobEvent(jobDir, 'info', resume
        ? `embedded ${this.site.name} worker resumed the job in its conversation after a desktop restart`
        : `embedded ${this.site.name} worker started`);

      const bootstrap = [
        `You are Teamyra Worker — ${this.site.name}, operating on a local project through controlled TEAMYRA tools.`,
        'Do not claim you changed/read local files unless TEAMYRA returned the tool result.',
        'When you need a local tool, reply with exactly one line and nothing else (no code fence):',
        'TEAMYRA_TOOL_REQUEST {"tool":"filesystem.read","args":{"path":"relative/path"}}',
        'Send one tool request per reply and wait for its TEAMYRA_TOOL_RESULT. The JSON must be valid; write paths with forward slashes (D:/project/file.txt), never backslashes.',
        'Available tools: filesystem.list, filesystem.stat, filesystem.read, filesystem.search, filesystem.create, filesystem.write, filesystem.patch, filesystem.move, filesystem.rename, filesystem.delete, terminal.run, process.start, process.read, process.write, process.stop, process.list, page.check, screen.capture, git.status, git.diff, git.log, git.add, git.commit, git.restore.',
        'terminal.run waits for its command to finish. For a program that keeps running (dev server, the app, a watcher, an interactive program) use process.start {"command":"<PowerShell command>","cwd":"...","wait_for":"<regex of a ready line>","wait_seconds":30}: it returns a session_id and the output so far, and the program keeps running. Then process.read {"session_id","wait_for","wait_seconds"} for new output, process.write {"session_id","input"} to type into it, process.stop {"session_id"}; process.list shows them. They stop when the job ends.',
        'To see what you built: page.check {"url":"http://localhost:<port>/","wait_for":"<text or CSS selector>"} opens a local page and returns its text, controls, console errors, failed requests and a screenshot; screen.capture {"window":"<part of a window title>"} screenshots an open window. A screenshot is attached to the next message when it can be. Test changes this way (start the server, check the page, read the errors) instead of guessing.',
        'filesystem.read is paged: use offset and max_bytes (at most 30000) for large files, then next_offset when clipped. Keep command output short (filter it); a tool result is cut to about 40000 characters.',
        fullAccess
          ? 'The user granted full PC access: absolute paths anywhere on this PC are allowed; relative paths resolve inside the workspace.'
          : 'Use relative paths inside the workspace.',
        'git.diff supports base/head commit refs and stat:true. An unknown argument is an error that lists the allowed keys.',
        'If TEAMYRA answers TEAMYRA_TOOL_ERROR, your request could not be parsed: send a corrected request.',
        'This text bridge is your local tool interface: emit TEAMYRA_TOOL_REQUEST even if task files mention calling native tools.',
        'filesystem.delete of a workspace file or folder (recursive:true) moves it to TEAMYRA\'s trash, where it can be restored; use it instead of shell delete commands. Deletes outside the workspace and git.restore may be denied pending explicit user confirmation. Never try to bypass that denial.',
        'When the task is complete, reply normally with the final result and do not include the TEAMYRA_TOOL_REQUEST marker.',
        ...this.site.promptRules,
        '',
        'WORKSPACE: ' + spec.cwd,
        'EXPECTED OUTPUT FILES (must exist and be non-empty): ' + JSON.stringify(spec.expect_files || []),
        'TASK:',
        task
      ].join('\n');

      let parseFailures = Number(resume?.parse_failures) || 0;
      let protocolRecoveries = Number(resume?.protocol_recoveries) || 0;
      let successfulTools = Number(resume?.successful_tools) || 0;
      let outputNudges = Number(resume?.output_nudges) || 0;
      let transientRetries = 0;
      const firstStep = Number(resume?.step) || 0;
      const counters = step => ({
        step, parse_failures: parseFailures, protocol_recoveries: protocolRecoveries, successful_tools: successfulTools,
        output_nudges: outputNudges
      });
      let reply = resume?.phase
        ? await this.resumeExchange(job, resume, bootstrap)
        : await this.jobExchange(job, bootstrap);

      for (let step = firstStep; step < MAX_TOOL_STEPS; step += 1) {
        this.saveJobState(job, counters(step));
        if (job.isCancelled()) {
          await this.stopGeneration().catch(() => {});
          state = 'cancelled';
          throw new Error('TEAMYRA job cancelled');
        }
        // "The server is busy" (DeepSeek) is not an answer: wait, ask again.
        if (this.automation.isTransientReply?.(reply.text) && transientRetries < MAX_TRANSIENT_RETRIES) {
          transientRetries += 1;
          this.appendJobEvent(jobDir, 'info', `${this.site.name} was busy; asking again in a moment (${transientRetries}/${MAX_TRANSIENT_RETRIES})`);
          this.writeJobMeta(jobDir, { last_event: `${this.site.name} busy; retrying` });
          await sleep((this.transientRetryMs ?? 15000) * transientRetries);
          this.checkJobActive(job);
          reply = await this.jobExchange(job, 'Please answer my previous message again.');
          continue;
        }
        let parsed = this.automation.parseToolRequestDetailed(reply.text);
        if (parsed.marker && typeof this.automation.rawReplyText === 'function') {
          // Parse the reply as written, not as rendered on the page.
          const raw = await this.automation.rawReplyText(reply.messageId).catch(() => '');
          const exact = raw && raw.includes('TEAMYRA_TOOL_REQUEST') ? this.automation.parseToolRequestDetailed(raw) : null;
          if (exact?.request) parsed = exact;
        }
        if (!parsed.marker) {
          if (looksLikeProtocolLoss(reply.text, successfulTools)) {
            if (protocolRecoveries >= MAX_PROTOCOL_RECOVERIES) {
              reason = 'protocol_lost';
              throw new Error(`${this.site.name} lost the TEAMYRA tool protocol after two reminders`);
            }
            protocolRecoveries += 1;
            this.appendJobEvent(jobDir, 'protocol_recovery', `protocol reminder ${protocolRecoveries}/${MAX_PROTOCOL_RECOVERIES}: ${reply.text}`);
            this.writeJobMeta(jobDir, { protocol_recoveries: protocolRecoveries, last_event: 'restoring TEAMYRA tool protocol' });
            reply = await this.jobExchange(job, 'TEAMYRA protocol reminder: the task is not finished. The text tool bridge is available. Continue through TEAMYRA_TOOL_REQUEST.\n\n' + bootstrap);
            continue;
          }
          this.checkJobActive(job);
          let missing = missingExpectedOutputs(assignedWorkspace, spec.expect_files);
          if (missing.length || !successfulTools) {
            const settled = await this.settleReply(job, reply);
            if (settled !== reply) {
              reply = settled;
              continue;
            }
          }
          if (missing.length && outputNudges < MAX_OUTPUT_NUDGES) {
            outputNudges += 1;
            this.appendJobEvent(jobDir, 'protocol_recovery',
              `reply without the expected outputs (${missing.join(', ')}); asking ${this.site.name} to continue ` +
              `${outputNudges}/${MAX_OUTPUT_NUDGES}: ${String(reply.text || '').slice(0, 500)}`);
            this.writeJobMeta(jobDir, { output_nudges: outputNudges, last_event: 'expected outputs missing; asking to continue' });
            reply = await this.jobExchange(job, [
              'TEAMYRA: the task is not finished. These expected output files do not exist yet or are empty: ' + JSON.stringify(missing) + '.',
              'The TEAMYRA tool bridge is available in this chat: send TEAMYRA_TOOL_REQUEST lines (one per reply) to read, run commands and write the files, then give the final result.',
              'Reply now with your next TEAMYRA_TOOL_REQUEST.'
            ].join('\n'));
            continue;
          }
          missing = missingExpectedOutputs(assignedWorkspace, spec.expect_files);
          if (missing.length) {
            reason = 'missing_output';
            this.writeJobMeta(jobDir, { missing_outputs: missing });
            throw new Error('Expected outputs missing or empty: ' + missing.join(', '));
          }
          const conversation = await this.getCurrentConversation();
          this.saveWorkerConversation(conversation);
          // The report as written: the page text also carries labels such as a
          // code block's "Copy" / "Download" buttons and rendered Markdown.
          let finalText = reply.text || '';
          if (reply.messageId && typeof this.automation.rawReplyText === 'function') {
            const raw = await this.automation.rawReplyText(reply.messageId).catch(() => '');
            if (raw && raw.trim()) finalText = raw.trim();
          }
          fs.writeFileSync(path.join(jobDir, 'final.txt'), finalText, 'utf8');
          this.appendJobEvent(jobDir, 'message', finalText);
          this.writeJobMeta(jobDir, {
            state: 'done',
            reason: null,
            exit_code: 0,
            attention: null,
            usage: { ...job.usage },
            ended: Date.now() / 1000,
            session_id: conversation.conversationId,
            chatgpt_url: conversation.url,
            last_event: `done: embedded ${this.site.name} completed`
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
            throw new Error(`${this.site.name} sent ${parseFailures} unparseable TEAMYRA tool requests in a row: ${parsed.error}`);
          }
          reply = await this.jobExchange(job, 'TEAMYRA_TOOL_ERROR ' + JSON.stringify({ error: parsed.error, hint: TOOL_ERROR_HINT }));
          continue;
        }
        parseFailures = 0;
        const request = parsed.request;

        this.appendJobEvent(jobDir, 'command', request.tool + ' ' + JSON.stringify(request.args).slice(0, 1000));
        // Recorded before the tool runs: a restart mid-tool must not run it
        // a second time; ChatGPT is told its outcome is unknown instead.
        this.saveJobState(job, { phase: 'tool', request, reply: null });
        let toolResult;
        try {
          if (spec.write === false && READ_ONLY_BLOCKED_TOOLS.has(request.tool)) {
            throw new Error('This delegated job is read-only; write, terminal, and mutating Git tools are disabled');
          }
          if (JobProcesses.handles(request.tool)) {
            toolResult = await jobProcesses.call(jobDir, request.tool, request.args, {
              authorize: (command, cwd) => this.workspaceBridge.authorizeProcess(
                assignedWorkspace, command, cwd, taskPermissions, this.site.workerId(this.activeProfileId || 'web'))
            });
          } else if (JobInspector.handles(request.tool)) {
            toolResult = await this.inspector.call(jobDir, request.tool, request.args, { workspace: assignedWorkspace });
          } else {
            toolResult = await this.workspaceBridge.executeInWorkspace(
              assignedWorkspace,
              request.tool,
              request.args,
              taskPermissions,
              false
            );
          }
        } catch (error) {
          toolResult = { ok: false, error: String(error?.message || error) };
        }
        let attachNote = '';
        if (toolResult?.screenshot && request.args?.attach !== false) {
          attachNote = await this.attachScreenshot(toolResult.screenshot)
            .then(() => '\nThe screenshot is attached to this message.')
            .catch(error => `\nThe screenshot could not be attached (${String(error?.message || error).slice(0, 160)}); it is saved at ${toolResult.screenshot}.`);
        }
        if (toolResult?.ok !== false) successfulTools += 1;
        const rawToolResult = JSON.stringify(toolResult);
        const boundedToolResult = boundToolResult(toolResult);
        this.appendJobEvent(jobDir, 'result', rawToolResult.slice(0, 3000));
        reply = await this.jobExchange(job, 'TEAMYRA_TOOL_RESULT ' + JSON.stringify({ tool: request.tool, result: boundedToolResult }) + attachNote + '\nContinue the task.');
      }
      throw new Error(`${this.site.name} exceeded the maximum TEAMYRA tool-call loop`);
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
      jobProcesses.stopJob(jobDir).catch(() => {});
      this.awaitingUser = false;
      this.activeJobDir = null;
      this.busy = false;
      // Release ownership before any renderer cleanup, even if it hangs.
      this.setInteractionLocked(false).catch(() => {});
      this.dispatchQueuedJobs();
      try { this.publishHeartbeat(); } catch {}
      this.refreshStatus().catch(() => {});
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
        detail: `TEAMYRA Desktop ${this.site.name} worker is closed.`
      });
    } catch {}
    clearInterval(this.jobTimer);
    clearInterval(this.heartbeatTimer);
    clearInterval(this.statusTimer);
    this.jobTimer = null;
    this.heartbeatTimer = null;
    this.statusTimer = null;
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

// Defaults for instances made without the constructor (tests, subclasses).
ChatGPTWebProvider.prototype.site = CHATGPT_SITE;
ChatGPTWebProvider.prototype.lane = 0;
ChatGPTWebProvider.prototype.laneCount = 1;
// One page checker for every tab: its checks run one at a time.
ChatGPTWebProvider.prototype.inspector = new JobInspector();
ChatGPTWebProvider.prototype.userActions = userActions(CHATGPT_SITE);

module.exports = { boundToolResult, googleSignInHost, ChatGPTWebProvider, CHATGPT_HOME, CHATGPT_SITE, ALLOWED_HOSTS, userActions, CLAIMED_JOBS };
