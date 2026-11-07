const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');

const SOURCE_ROOT = path.resolve(__dirname, '..', '..', '..');
const ROOT = path.resolve(process.env.TEAMYRA_ROOT || SOURCE_ROOT);
const DESKTOP_API = path.join(SOURCE_ROOT, 'bridge', 'desktop_api.py');
const PACKAGED_CORE = process.env.TEAMYRA_CORE_EXE ||
  (process.resourcesPath ? path.join(process.resourcesPath, 'teamyra-core', 'teamyra-core.exe') : '');
let cachedPython = null;

function execFilePromise(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, {
      windowsHide: true,
      timeout: options.timeout || 30000,
      maxBuffer: options.maxBuffer || 4 * 1024 * 1024,
      encoding: 'utf8',
      ...options
    }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout || '';
        error.stderr = stderr || '';
        reject(error);
        return;
      }
      resolve({ stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

function windowsPythonCandidates() {
  const candidates = [];
  const add = value => {
    if (value && !candidates.some(item => item.file === value)) {
      candidates.push({ file: value, prefix: [] });
    }
  };

  add(process.env.TEAMYRA_PYTHON);

  const local = process.env.LOCALAPPDATA;
  if (local) {
    const base = path.join(local, 'Programs', 'Python');
    try {
      const dirs = fs.readdirSync(base, { withFileTypes: true })
        .filter(entry => entry.isDirectory() && /^Python/i.test(entry.name))
        .sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }));
      for (const dir of dirs) add(path.join(base, dir.name, 'python.exe'));
    } catch {}
  }

  return candidates.filter(item => {
    try { return fs.existsSync(item.file); } catch { return false; }
  });
}

async function resolvePython() {
  if (cachedPython) return cachedPython;

  const direct = [];
  if (process.env.TEAMYRA_PYTHON) {
    direct.push({ file: process.env.TEAMYRA_PYTHON, prefix: [] });
  }
  direct.push(
    { file: process.platform === 'win32' ? 'python.exe' : 'python3', prefix: [] },
    { file: 'python', prefix: [] }
  );
  if (process.platform === 'win32') {
    direct.push({ file: 'py.exe', prefix: ['-3'] }, ...windowsPythonCandidates());
  }

  for (const candidate of direct) {
    try {
      await execFilePromise(candidate.file, [...candidate.prefix, '--version'], { timeout: 5000 });
      cachedPython = candidate;
      return candidate;
    } catch {}
  }
  throw new Error('Python 3 was not found. Set TEAMYRA_PYTHON to the Python executable.');
}

// "media state is busy" means the job-state lock could not be taken: nothing
// was done, so the call is safe to repeat. Under heavy bulk load (many Flow and
// Vids tabs) a single wait of 15 s sometimes failed a job before Generate.
const BUSY_RETRIES = 3;

// Requests that only read, or check, and are safe to send again when the
// core process stopped before it answered. Anything that changes state (a
// tool run, a job start, a merge) is never repeated.
const SAFE_RETRY_ACTIONS = new Set([
  'chatgpt.process.authorize', 'chatgpt.workspace.status', 'transfer.check', 'scheduler.dispatch',
  'media.status', 'media.status-many', 'media.connection-status', 'media.claimed-keys',
  'worktree.status', 'worktree.list', 'worktree.diff', 'worktree.conflict.detail',
  'observability.usage', 'observability.timeline', 'observability.search',
  'memory.search', 'memory.list', 'memory.get', 'memory.context'
]);

async function callCore(action, payload = {}, options = {}) {
  let restarted = false;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await callCoreOnce(action, payload, options);
    } catch (error) {
      const message = String(error?.message || error);
      if (!restarted && /TEAMYRA Core stopped while answering/.test(message) && SAFE_RETRY_ACTIONS.has(action)) {
        restarted = true;
        continue;
      }
      if (attempt >= BUSY_RETRIES || !/media state is busy/i.test(message)) throw error;
      await new Promise(resolve => setTimeout(resolve, 500 + attempt * 1000 + Math.random() * 500));
    }
  }
}

// One long-lived TEAMYRA Core process answers the desktop's calls (one JSON
// line per request and reply). A new Python process per call cost 100-300 ms
// of CPU each, and media tabs and web-chat tabs made several such calls a
// second even with nothing to do. If this process cannot start, or stopped
// just now, calls fall back to one process each.
const SERVER_RECYCLE_CALLS = 5000;
const SERVER_RETRY_MS = 30000;

class CoreServer {
  constructor() {
    this.child = null;
    this.pending = new Map();
    this.seq = 0;
    this.calls = 0;
    this.failedAt = 0;
    this.starting = null;
  }

  async ensure() {
    if (this.child) return this.child;
    if (process.env.TEAMYRA_CORE_PER_CALL === '1' || Date.now() - this.failedAt < SERVER_RETRY_MS) return null;
    if (!this.starting) {
      this.starting = this.start().catch(() => {
        this.failedAt = Date.now();
        return null;
      }).finally(() => { this.starting = null; });
    }
    return this.starting;
  }

  async start() {
    const { file, args } = await coreCommand();
    const child = spawn(file, [...args, '--serve'], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: coreEnv()
    });
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => this.onData(child, chunk));
    // Keep the end of the core's error output: if it stops, the reason is in
    // logs/core-exits.log (it used to be thrown away).
    child.teamyraStderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { child.teamyraStderr = (child.teamyraStderr + chunk).slice(-4000); });
    child.stdin.on('error', () => {});
    child.on('exit', (code, signal) => this.onExit(child, code, signal));
    this.child = child;
    this.calls = 0;
    return child;
  }

  call(child, action, payload, options) {
    const id = ++this.seq;
    this.calls += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`TEAMYRA Core did not answer ${action} in ${Math.round((options.timeout || 45000) / 1000)} s`));
      }, options.timeout || 45000);
      this.pending.set(id, { resolve, reject, timer, child });
      const line = JSON.stringify({ id, action, payload: payload || {}, env: options.env || {} }) + '\n';
      child.stdin.write(line, error => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  onData(child, chunk) {
    // Each process has its own buffer: a recycled one still answers its
    // last requests while the new one starts.
    child.teamyraBuffer = (child.teamyraBuffer || '') + chunk;
    let index;
    while ((index = child.teamyraBuffer.indexOf('\n')) >= 0) {
      const line = child.teamyraBuffer.slice(0, index);
      child.teamyraBuffer = child.teamyraBuffer.slice(index + 1);
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      const entry = this.pending.get(message.id);
      if (!entry) continue;
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.ok === true) entry.resolve(message.result);
      else entry.reject(new Error(message.error || 'TEAMYRA Core request failed'));
    }
    this.maybeRecycle();
  }

  // Start a fresh process now and then; the old one ends once idle.
  maybeRecycle() {
    if (this.calls < SERVER_RECYCLE_CALLS || !this.child) return;
    const old = this.child;
    if ([...this.pending.values()].some(entry => entry.child === old)) return;
    this.child = null;
    try { old.stdin.end(); } catch {}
  }

  onExit(child, code = null, signal = null) {
    const open = [...this.pending.values()].filter(entry => entry.child === child).length;
    // A recycled process ends on purpose (code 0, nothing open); log the rest.
    if (code !== 0 || open || this.child === child) {
      try {
        const file = path.join(ROOT, 'logs', 'core-exits.log');
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.appendFileSync(file, `${new Date().toISOString()} pid=${child.pid} code=${code} signal=${signal} ` +
          `open_requests=${open} calls=${this.calls}\n${String(child.teamyraStderr || '').trim().slice(-2000)}\n---\n`);
      } catch {}
    }
    for (const [id, entry] of this.pending) {
      if (entry.child !== child) continue;
      this.pending.delete(id);
      clearTimeout(entry.timer);
      entry.reject(new Error('TEAMYRA Core stopped while answering this request'));
    }
    if (this.child === child) {
      this.child = null;
      this.failedAt = Date.now();
    }
  }

  stop() {
    const child = this.child;
    this.child = null;
    if (child) { try { child.stdin.end(); } catch {} }
  }
}

const coreServer = new CoreServer();

function coreEnv(extra = {}) {
  return {
    ...process.env,
    TEAMYRA_ROOT: ROOT,
    ...(PACKAGED_CORE && fs.existsSync(PACKAGED_CORE) ? { TEAMYRA_CORE_EXE: PACKAGED_CORE } : {}),
    ...extra
  };
}

async function coreCommand() {
  if (process.env.TEAMYRA_CORE_EXE) {
    if (!PACKAGED_CORE || !fs.existsSync(PACKAGED_CORE)) {
      throw new Error('Bundled TEAMYRA Core is missing: ' + String(PACKAGED_CORE || process.env.TEAMYRA_CORE_EXE));
    }
    return { file: PACKAGED_CORE, args: ['__desktop-api'] };
  }
  if (PACKAGED_CORE && fs.existsSync(PACKAGED_CORE)) return { file: PACKAGED_CORE, args: ['__desktop-api'] };
  const python = await resolvePython();
  return { file: python.file, args: [...python.prefix, DESKTOP_API] };
}

async function callCoreOnce(action, payload = {}, options = {}) {
  if (!/^[a-z0-9.-]+$/i.test(String(action || ''))) {
    throw new Error('Invalid core action');
  }
  const server = await coreServer.ensure().catch(() => null);
  if (server) return coreServer.call(server, action, payload, options);
  return callCoreProcess(action, payload, options);
}

async function callCoreProcess(action, payload = {}, options = {}) {
  let file;
  let args;
  if (process.env.TEAMYRA_CORE_EXE) {
    if (!PACKAGED_CORE || !fs.existsSync(PACKAGED_CORE)) {
      throw new Error('Bundled TEAMYRA Core is missing: ' + String(PACKAGED_CORE || process.env.TEAMYRA_CORE_EXE));
    }
    file = PACKAGED_CORE;
    args = ['__desktop-api', action, JSON.stringify(payload || {})];
  } else if (PACKAGED_CORE && fs.existsSync(PACKAGED_CORE)) {
    file = PACKAGED_CORE;
    args = ['__desktop-api', action, JSON.stringify(payload || {})];
  } else {
    const python = await resolvePython();
    file = python.file;
    args = [
      ...python.prefix,
      DESKTOP_API,
      action,
      JSON.stringify(payload || {})
    ];
  }

  const { stdout, stderr } = await execFilePromise(file, args, {
    timeout: options.timeout || 45000,
    maxBuffer: options.maxBuffer || 8 * 1024 * 1024,
    env: {
      ...process.env,
      TEAMYRA_ROOT: ROOT,
      ...(PACKAGED_CORE && fs.existsSync(PACKAGED_CORE) ? { TEAMYRA_CORE_EXE: PACKAGED_CORE } : {}),
      ...(options.env || {})
    }
  });

  let response;
  try {
    response = JSON.parse(stdout);
  } catch {
    throw new Error('TEAMYRA Core returned invalid JSON' + (stderr ? ': ' + stderr.trim() : ''));
  }
  if (!response || response.ok !== true) {
    throw new Error(response?.error || stderr.trim() || 'TEAMYRA Core request failed');
  }
  return response.result;
}

module.exports = { ROOT, SOURCE_ROOT, PACKAGED_CORE, callCore, resolvePython, coreServer, CoreServer };
