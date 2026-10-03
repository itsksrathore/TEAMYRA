const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { detectProviders, providerById, profileRoot, PROFILES_ROOT } = require('./provider-registry');

let pty = null;
try { pty = require('@lydell/node-pty'); } catch {}
const TERMINALS = new Map();

const ROOT = path.resolve(__dirname, '..', '..', '..');
const JOBS = path.join(ROOT, 'jobs');

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

ipcMain.handle('teamyra:providers', () => detectProviders());
ipcMain.handle('teamyra:jobs', () => listJobs());
ipcMain.handle('teamyra:transcript', (_event, jobId, offset) => readTranscript(jobId, offset));

ipcMain.handle('teamyra:terminal-open', (event, options = {}) => {
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
    launchCommand = provider.bin;

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

function safeProfileSlug(value) {
  return String(value || 'account')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'account';
}

ipcMain.handle('teamyra:add-account', async (_event, providerId, requestedName) => {
  const provider = providerById(providerId);
  if (!provider) throw new Error('Unknown provider');
  if (!provider.managed?.verified || !provider.managed.env || !provider.managed.loginArgv) {
    return { ok: false, reason: 'profile-isolation-not-verified' };
  }

  const name = String(requestedName || '').trim() || (provider.name + ' account');
  const profileId = safeProfileSlug(name) + '-' + crypto.randomBytes(2).toString('hex');
  const dir = path.join(profileRoot(provider.id), profileId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'teamyra-profile.json'),
    JSON.stringify({ name, provider: provider.id, createdAt: new Date().toISOString() }, null, 2),
    'utf8'
  );

  const env = { ...process.env, [provider.managed.env]: dir };
  const child = spawn(provider.bin, provider.managed.loginArgv, {
    env,
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
    shell: process.platform === 'win32'
  });
  child.unref();

  return { ok: true, provider: provider.id, profileId, name };
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
