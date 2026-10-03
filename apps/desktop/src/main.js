const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { detectProviders, providerById, profileRoot, PROFILES_ROOT, whereBinary } = require('./provider-registry');
const { callCore } = require('./core-api');

let pty = null;
try { pty = require('@lydell/node-pty'); } catch {}
const TERMINALS = new Map();

const ROOT = path.resolve(__dirname, '..', '..', '..');
const JOBS = path.join(ROOT, 'jobs');
let PROVIDER_CACHE = { at: 0, data: null, pending: null };
const PROVIDER_CACHE_MS = 30000;

async function providersCached(force = false) {
  const now = Date.now();
  if (!force && PROVIDER_CACHE.data && now - PROVIDER_CACHE.at < PROVIDER_CACHE_MS) {
    return PROVIDER_CACHE.data;
  }
  if (PROVIDER_CACHE.pending) return PROVIDER_CACHE.pending;
  PROVIDER_CACHE.pending = detectProviders()
    .then(data => {
      PROVIDER_CACHE = { at: Date.now(), data, pending: null };
      return data;
    })
    .catch(error => {
      PROVIDER_CACHE.pending = null;
      throw error;
    });
  return PROVIDER_CACHE.pending;
}

function safeWorkerPart(value) {
  const cleaned = String(value || '').trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[._-]+|[._-]+$/g, '');
  return (cleaned || 'account').slice(0, 48);
}

function workerIdForProfile(providerId, profileId) {
  if (providerId === 'claude') return profileId === 'native' ? 'claude1' : 'claude-' + safeWorkerPart(profileId);
  if (providerId === 'codex') {
    if (profileId === 'native') return 'codex1';
    if (profileId === 'codex2') return 'codex2';
    return 'codex-' + safeWorkerPart(profileId);
  }
  if (providerId === 'antigravity' && profileId === 'native') return 'antigravity';
  return '';
}

function mergeUsageProviderState(snapshot, providers) {
  const rows = Array.isArray(snapshot?.workers) ? snapshot.workers : [];
  const byWorker = new Map(rows.map(row => [row.worker, row]));
  for (const provider of providers || []) {
    for (const profile of provider.profiles || []) {
      const workerId = workerIdForProfile(provider.id, profile.id);
      if (!workerId) continue;
      const row = byWorker.get(workerId);
      if (!row) continue;
      row.provider = provider.id || row.provider;
      row.ready = Boolean(provider.installed && profile.signedIn && profile.enabled !== false);
    }
  }
  snapshot.provider_status_at = PROVIDER_CACHE.at / 1000;
  snapshot.provider_status_age_s = PROVIDER_CACHE.at ? Math.max(0, Math.round((Date.now() - PROVIDER_CACHE.at) / 1000)) : null;
  return snapshot;
}

function listJobs(limit = 30) {
  if (!fs.existsSync(JOBS)) return [];
  return fs.readdirSync(JOBS, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => {
      const meta = path.join(JOBS, entry.name, 'meta.json');
      try {
        const data = JSON.parse(fs.readFileSync(meta, 'utf8'));
        return {
          id: data.id || entry.name,
          label: data.label || entry.name,
          worker: data.worker || 'unknown',
          state: data.state || 'unknown',
          reason: data.reason || '',
          branch: data.branch || '',
          cwd: data.cwd || '',
          created: data.created || 0,
          started: data.started || 0,
          ended: data.ended || 0,
          lastEvent: data.last_event || ''
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => (b.created || b.started || 0) - (a.created || a.started || 0))
    .slice(0, limit);
}

function readTranscript(jobId, offset = 0) {
  if (!/^[A-Za-z0-9._-]+$/.test(jobId || '')) throw new Error('Invalid job id');
  const file = path.join(JOBS, jobId, 'transcript.md');
  if (!fs.existsSync(file)) return { text: '', next: 0 };
  const data = fs.readFileSync(file, 'utf8');
  const start = Math.max(0, Math.min(Number(offset) || 0, data.length));
  const end = Math.min(data.length, start + 200000);
  return { text: data.slice(start, end), next: end };
}

function terminalShell() {
  if (process.platform === 'win32') return process.env.COMSPEC || 'cmd.exe';
  return process.env.SHELL || '/bin/bash';
}

function terminalArgs(shell) {
  const base = path.basename(shell).toLowerCase();
  if (base.includes('powershell') || base === 'pwsh' || base === 'pwsh.exe') return ['-NoLogo'];
  return [];
}

function quoteShellArg(value) {
  const text = String(value);
  if (process.platform === 'win32') return '"' + text.replace(/"/g, '""') + '"';
  return "'" + text.replace(/'/g, "'\\''") + "'";
}

function launchLine(binary, args = []) {
  return [quoteShellArg(binary), ...args.map(quoteShellArg)].join(' ');
}

function terminalFor(event, id) {
  const item = TERMINALS.get(id);
  if (!item || item.owner !== event.sender.id) return null;
  return item;
}

function killTerminalsFor(owner) {
  for (const [id, item] of TERMINALS) {
    if (item.owner !== owner) continue;
    try { item.proc.kill(); } catch {}
    TERMINALS.delete(id);
  }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1060,
    minHeight: 680,
    backgroundColor: '#080a0f',
    title: 'TEAMYRA',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  const webContentsId = win.webContents.id;
  win.webContents.on('destroyed', () => killTerminalsFor(webContentsId));
}

ipcMain.handle('teamyra:providers', () => providersCached(true));
ipcMain.handle('teamyra:jobs', () => listJobs());
ipcMain.handle('teamyra:transcript', (_event, jobId, offset) => readTranscript(jobId, offset));

ipcMain.handle('teamyra:timeline', (_event, options = {}) =>
  callCore('observability.timeline', {
    limit: Number(options.limit) || 120,
    project_path: String(options.projectPath || ''),
    worker: String(options.worker || ''),
    sources: Array.isArray(options.sources) ? options.sources : [],
    query: String(options.query || ''),
    since: Number.isFinite(Number(options.since)) ? Number(options.since) : null
  }, { maxBuffer: 12 * 1024 * 1024 })
);
ipcMain.handle('teamyra:logs-search', (_event, options = {}) =>
  callCore('observability.search', {
    query: String(options.query || ''),
    limit: Number(options.limit) || 50,
    project_path: String(options.projectPath || ''),
    worker: String(options.worker || ''),
    kinds: Array.isArray(options.kinds) ? options.kinds : []
  }, { maxBuffer: 12 * 1024 * 1024 })
);
ipcMain.handle('teamyra:usage', async (_event, options = {}) => {
  const projectPath = String(options.projectPath || '');
  const [snapshot, providers] = await Promise.all([
    callCore('observability.usage', {
      project_path: projectPath
    }, { timeout: 30000, maxBuffer: 12 * 1024 * 1024 }),
    providersCached(false)
  ]);
  return mergeUsageProviderState(snapshot, providers);
});

ipcMain.handle('teamyra:memory-list', (_event, options = {}) =>
  callCore('memory.list', {
    project_path: String(options.projectPath || ''),
    kind: String(options.kind || ''),
    status: String(options.status || 'active'),
    tag: String(options.tag || ''),
    limit: Number(options.limit) || 100
  })
);
ipcMain.handle('teamyra:memory-search', (_event, options = {}) =>
  callCore('memory.search', {
    project_path: String(options.projectPath || ''),
    query: String(options.query || ''),
    kinds: Array.isArray(options.kinds) ? options.kinds : [],
    tags: Array.isArray(options.tags) ? options.tags : [],
    status: String(options.status || 'active'),
    limit: Number(options.limit) || 50
  })
);
ipcMain.handle('teamyra:memory-get', (_event, projectPath, memoryId) =>
  callCore('memory.get', { project_path: String(projectPath || ''), memory_id: String(memoryId || '') })
);
ipcMain.handle('teamyra:memory-add', (_event, options = {}) =>
  callCore('memory.add', {
    project_path: String(options.projectPath || ''),
    kind: String(options.kind || 'note'),
    title: String(options.title || ''),
    content: String(options.content || ''),
    tags: Array.isArray(options.tags) ? options.tags : [],
    importance: String(options.importance || 'normal'),
    source_job_id: String(options.sourceJobId || ''),
    source_graph_id: String(options.sourceGraphId || '')
  })
);
ipcMain.handle('teamyra:memory-update', (_event, options = {}) => {
  const payload = {
    project_path: String(options.projectPath || ''),
    memory_id: String(options.memoryId || '')
  };
  for (const key of ['title', 'content', 'importance', 'kind']) {
    if (Object.prototype.hasOwnProperty.call(options, key)) payload[key] = options[key];
  }
  if (Array.isArray(options.tags)) payload.tags = options.tags;
  return callCore('memory.update', payload);
});
ipcMain.handle('teamyra:memory-archive', (_event, projectPath, memoryId, reason = '') =>
  callCore('memory.archive', {
    project_path: String(projectPath || ''),
    memory_id: String(memoryId || ''),
    reason: String(reason || '')
  })
);
ipcMain.handle('teamyra:memory-context', (_event, options = {}) =>
  callCore('memory.context', {
    project_path: String(options.projectPath || ''),
    query: String(options.query || ''),
    kinds: Array.isArray(options.kinds) ? options.kinds : [],
    tags: Array.isArray(options.tags) ? options.tags : [],
    max_chars: Number(options.maxChars) || 8000,
    limit: Number(options.limit) || 40
  }, { maxBuffer: 12 * 1024 * 1024 })
);

ipcMain.handle('teamyra:worktrees', () => callCore('worktree.list'));
ipcMain.handle('teamyra:worktree-status', (_event, worktreeId) =>
  callCore('worktree.status', { worktree_id: worktreeId })
);
ipcMain.handle('teamyra:worktree-diff', (_event, worktreeId, maxChars = 80000) =>
  callCore('worktree.diff', { worktree_id: worktreeId, max_chars: maxChars }, { maxBuffer: 12 * 1024 * 1024 })
);
ipcMain.handle('teamyra:worktree-create', (_event, options = {}) =>
  callCore('worktree.create', {
    project_path: String(options.projectPath || ''),
    label: String(options.label || 'task'),
    base_ref: String(options.baseRef || 'HEAD')
  })
);
ipcMain.handle('teamyra:worktree-rebase', (_event, worktreeId, confirm = false) => {
  if (confirm !== true) throw new Error('Rebase requires explicit confirmation');
  return callCore('worktree.rebase', { worktree_id: worktreeId, confirm: true }, { timeout: 120000 });
});
ipcMain.handle('teamyra:worktree-merge', (_event, worktreeId, confirm = false) => {
  if (confirm !== true) throw new Error('Merge requires explicit confirmation');
  return callCore('worktree.merge', { worktree_id: worktreeId, confirm: true }, { timeout: 120000 });
});
ipcMain.handle('teamyra:worktree-discard', (_event, worktreeId, options = {}) => {
  if (options.confirm !== true) throw new Error('Discard requires explicit confirmation');
  return callCore('worktree.discard', {
    worktree_id: worktreeId,
    confirm: true,
    force: options.force === true
  }, { timeout: 120000 });
});

ipcMain.handle('teamyra:terminal-open', async (event, options = {}) => {
  if (!pty) return { ok: false, reason: 'pty-unavailable' };
  const requested = typeof options.cwd === 'string' ? options.cwd : '';
  const cwd = requested && path.isAbsolute(requested) && fs.existsSync(requested) ? requested : ROOT;
  const shell = terminalShell();
  const id = crypto.randomBytes(8).toString('hex');
  const env = { ...process.env };
  let launchCommand = '';

  if (typeof options.providerId === 'string' && options.providerId) {
    const provider = providerById(options.providerId);
    if (!provider) return { ok: false, reason: 'unknown-provider' };
    const binary = await whereBinary(provider.bin);
    if (!binary) return { ok: false, reason: 'provider-cli-not-found' };
    const args = options.login === true ? (provider.managed?.loginArgv || []) : [];
    launchCommand = launchLine(binary, args);

    const profileId = typeof options.profileId === 'string' ? options.profileId : 'native';
    if (profileId === 'native' && provider.managed?.env) {
      delete env[provider.managed.env];
    }
    if (profileId !== 'native') {
      let home = '';
      if (provider.id === 'codex' && profileId === 'codex2') {
        const legacy = path.join(PROFILES_ROOT, 'codex2');
        if (fs.existsSync(legacy)) home = legacy;
      }
      if (!home && /^[A-Za-z0-9._-]+$/.test(profileId)) {
        const candidate = path.join(profileRoot(provider.id), profileId);
        if (fs.existsSync(candidate)) home = candidate;
      }
      if (!home || !provider.managed?.env) return { ok: false, reason: 'profile-not-available' };
      env[provider.managed.env] = home;
    }
  }

  const proc = pty.spawn(shell, terminalArgs(shell), {
    name: 'xterm-256color',
    cols: 120,
    rows: 30,
    cwd,
    env
  });

  const owner = event.sender.id;
  TERMINALS.set(id, { proc, owner, cwd });
  if (launchCommand) {
    setTimeout(() => {
      try { proc.write(launchCommand + (process.platform === 'win32' ? '\r' : '\n')); } catch {}
    }, 80);
  }
  proc.onData(data => {
    if (!event.sender.isDestroyed()) event.sender.send('teamyra:terminal-data', { id, data });
  });
  proc.onExit(({ exitCode }) => {
    TERMINALS.delete(id);
    if (!event.sender.isDestroyed()) event.sender.send('teamyra:terminal-exit', { id, exitCode });
  });
  return { ok: true, id, cwd, shell, providerId: options.providerId || null, profileId: options.profileId || null };
});

ipcMain.on('teamyra:terminal-input', (event, payload = {}) => {
  const item = terminalFor(event, payload.id);
  if (!item || typeof payload.data !== 'string') return;
  item.proc.write(payload.data.slice(0, 100000));
});

ipcMain.on('teamyra:terminal-resize', (event, payload = {}) => {
  const item = terminalFor(event, payload.id);
  if (!item) return;
  const cols = Math.max(20, Math.min(300, Number(payload.cols) || 80));
  const rows = Math.max(5, Math.min(120, Number(payload.rows) || 24));
  try { item.proc.resize(cols, rows); } catch {}
});

ipcMain.handle('teamyra:terminal-close', (event, id) => {
  const item = terminalFor(event, id);
  if (!item) return { ok: false };
  try { item.proc.kill(); } catch {}
  TERMINALS.delete(id);
  return { ok: true };
});

function managedProfileDir(providerId, profileId) {
  if (!/^[A-Za-z0-9._-]+$/.test(profileId || '') || profileId === 'native') return '';
  if (providerId === 'codex' && profileId === 'codex2') {
    const legacy = path.join(PROFILES_ROOT, 'codex2');
    return fs.existsSync(legacy) ? legacy : '';
  }
  const dir = path.join(profileRoot(providerId), profileId);
  try {
    return fs.existsSync(dir) && fs.statSync(dir).isDirectory() ? dir : '';
  } catch {
    return '';
  }
}

function safeProfileSlug(value) {
  return String(value || 'account')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'account';
}

function safeSettingToken(value, field, maxLength = 120) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  if (text.length > maxLength || !/^[A-Za-z0-9._:/-]+$/.test(text)) {
    throw new Error('Invalid ' + field);
  }
  return text;
}

ipcMain.handle('teamyra:add-account', async (_event, providerId, requestedName) => {
  const provider = providerById(providerId);
  if (!provider) throw new Error('Unknown provider');
  if (!provider.managed?.verified || !provider.managed.env || !provider.managed.loginArgv) {
    return { ok: false, reason: 'profile-isolation-not-verified' };
  }

  const name = String(requestedName || '').trim().slice(0, 80) || (provider.name + ' account');
  const profileId = safeProfileSlug(name) + '-' + crypto.randomBytes(2).toString('hex');
  const dir = path.join(profileRoot(provider.id), profileId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'teamyra-profile.json'),
    JSON.stringify({
      name,
      provider: provider.id,
      enabled: true,
      priority: 100,
      createdAt: new Date().toISOString()
    }, null, 2),
    'utf8'
  );

  return {
    ok: true,
    provider: provider.id,
    profileId,
    name,
    loginReady: true
  };
});

ipcMain.handle('teamyra:update-account', async (_event, providerId, profileId, patch = {}) => {
  const provider = providerById(providerId);
  if (!provider) throw new Error('Unknown provider');
  const dir = managedProfileDir(providerId, profileId);
  if (!dir) return { ok: false, reason: 'managed-profile-not-found' };

  const file = path.join(dir, 'teamyra-profile.json');
  let meta = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) meta = parsed;
  } catch {}

  if ('name' in patch) {
    const name = String(patch.name || '').trim();
    if (!name || name.length > 80) throw new Error('Invalid account name');
    meta.name = name;
  }
  if ('enabled' in patch) meta.enabled = patch.enabled !== false;
  if ('priority' in patch) {
    const priority = Number.parseInt(patch.priority, 10);
    if (!Number.isFinite(priority) || priority < 0 || priority > 10000) throw new Error('Invalid priority');
    meta.priority = priority;
  }

  for (const key of ['model', 'effort']) {
    if (!(key in patch)) continue;
    const value = safeSettingToken(patch[key], key, key === 'model' ? 120 : 32);
    if (value) meta[key] = value;
    else delete meta[key];
  }

  if ('permissionMode' in patch) {
    const value = String(patch.permissionMode || '').trim();
    const allowed = new Set(['', 'acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan']);
    if (!allowed.has(value)) throw new Error('Invalid permission mode');
    if (providerId !== 'claude' || !value) delete meta.permission_mode;
    else meta.permission_mode = value;
  }

  meta.provider = providerId;
  meta.updatedAt = new Date().toISOString();
  if (!meta.createdAt) meta.createdAt = meta.updatedAt;

  const temp = file + '.tmp-' + process.pid + '-' + crypto.randomBytes(2).toString('hex');
  fs.writeFileSync(temp, JSON.stringify(meta, null, 2), 'utf8');
  fs.renameSync(temp, file);

  return {
    ok: true,
    provider: providerId,
    profileId,
    profile: {
      name: meta.name || profileId,
      enabled: meta.enabled !== false,
      priority: Number.isFinite(Number(meta.priority)) ? Number(meta.priority) : 100,
      model: meta.model || '',
      effort: meta.effort || '',
      permissionMode: meta.permission_mode || ''
    }
  };
});

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
