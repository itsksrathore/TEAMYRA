const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const { autoUpdater } = require('electron-updater');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createStartupLog, loadDesktopWindow } = require('./startup-diagnostics');
const startupLog = createStartupLog(path.join(app.getPath('userData'), 'logs'));
process.on('uncaughtExceptionMonitor', error => startupLog('uncaught-exception', { error: String(error.stack || error) }));
process.on('unhandledRejection', error => startupLog('unhandled-rejection', { error: String(error?.stack || error) }));
startupLog('starting', { packaged: app.isPackaged, resources: process.resourcesPath, version: app.getVersion() });

const SOURCE_ROOT = path.resolve(__dirname, '..', '..', '..');
const RUNTIME_ROOT = path.resolve(
  process.env.TEAMYRA_ROOT ||
  (app.isPackaged ? path.join(app.getPath('userData'), 'runtime') : SOURCE_ROOT)
);
process.env.TEAMYRA_ROOT = RUNTIME_ROOT;
if (app.isPackaged && !process.env.TEAMYRA_CORE_EXE) {
  process.env.TEAMYRA_CORE_EXE = path.join(process.resourcesPath, 'teamyra-core', 'teamyra-core.exe');
}
fs.mkdirSync(RUNTIME_ROOT, { recursive: true });

const { detectProviders, providerById, profileRoot, PROFILES_ROOT, whereBinary } = require('./provider-registry');
const { callCore } = require('./core-api');
const { ChatGPTWebProvider } = require('./chatgpt-web-provider');
const {
  ensureTeamyraMcp,
  stopOwnedMcp,
  getMcpConnections,
  connectTeamyraMcp
} = require('./mcp-integration');

let pty = null;
try { pty = require('@lydell/node-pty'); } catch (error) { startupLog('pty-unavailable', { error: String(error.message || error) }); }
const TERMINALS = new Map();
let chatgptProvider = null;
let mainWindow = null;
let isQuitting = false;
let mcpBootError = null;
let desktopIdleTimer = null;

const DESKTOP_IDLE_SECONDS = Math.max(30, Number(process.env.TEAMYRA_DESKTOP_IDLE_SECONDS) || 600);
const ROOT = RUNTIME_ROOT;
const JOBS = path.join(ROOT, 'jobs');
const APP_ICON = app.isPackaged
  ? path.join(process.resourcesPath, 'teamyra-icon.ico')
  : path.join(__dirname, '..', 'assets', 'teamyra-icon.ico');
let PROVIDER_CACHE = { at: 0, data: null, pending: null };
const PROVIDER_CACHE_MS = 30000;
let UPDATE_STATE = {
  status: app.isPackaged ? 'idle' : 'disabled-dev',
  currentVersion: app.getVersion(),
  availableVersion: null,
  progress: null,
  checkedAt: null,
  error: null
};

function updateState(patch = {}) {
  UPDATE_STATE = { ...UPDATE_STATE, ...patch };
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.webContents.isDestroyed()) win.webContents.send('teamyra:update-state', { ...UPDATE_STATE });
  }
  return { ...UPDATE_STATE };
}

function setupAutoUpdates() {
  if (!app.isPackaged || process.env.TEAMYRA_DISABLE_UPDATES === '1') {
    return updateState({ status: app.isPackaged ? 'disabled' : 'disabled-dev' });
  }

  autoUpdater.autoDownload = true;
  // Idle sleep is not consent to replace files used by a wake gateway or jobs.
  // The existing Update ready action installs after checking active work.
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.on('checking-for-update', () => updateState({ status: 'checking', error: null }));
  autoUpdater.on('update-available', info => updateState({
    status: 'available',
    availableVersion: info?.version || null,
    checkedAt: Date.now()
  }));
  autoUpdater.on('update-not-available', info => updateState({
    status: 'up-to-date',
    availableVersion: info?.version || null,
    checkedAt: Date.now(),
    progress: null
  }));
  autoUpdater.on('download-progress', progress => updateState({
    status: 'downloading',
    progress: Math.max(0, Math.min(100, Number(progress?.percent) || 0))
  }));
  autoUpdater.on('update-downloaded', info => updateState({
    status: 'downloaded',
    availableVersion: info?.version || UPDATE_STATE.availableVersion,
    progress: 100
  }));
  autoUpdater.on('error', error => updateState({
    status: 'error',
    error: String(error?.message || error || 'Update error')
  }));

  const timer = setTimeout(() => {
    autoUpdater.checkForUpdates().catch(error => updateState({
      status: 'error',
      error: String(error?.message || error)
    }));
  }, 5000);
  timer.unref?.();
  return updateState({ status: 'scheduled' });
}

async function providersCached(force = false) {
  const now = Date.now();
  if (!force && PROVIDER_CACHE.data && now - PROVIDER_CACHE.at < PROVIDER_CACHE_MS) {
    return PROVIDER_CACHE.data;
  }
  if (PROVIDER_CACHE.pending) return PROVIDER_CACHE.pending;
  PROVIDER_CACHE.pending = detectProviders()
    .then(async data => {
      if (chatgptProvider) {
        try {
          const chatStatus = await chatgptProvider.getStatus();
          const provider = data.find(item => item.id === 'chatgpt-web');
          if (provider) {
            provider.signedIn = chatStatus.automationReady === true;
            provider.workerReady = chatStatus.workerReady === true;
            provider.status = chatStatus.challenged
              ? 'User verification required'
              : chatStatus.automationReady
                ? 'Embedded session active'
                : chatStatus.loginVisible
                  ? 'Sign-in required'
                  : chatStatus.connected
                    ? 'Embedded page connected'
                    : 'Open inside TEAMYRA to connect';
            provider.profiles = (provider.profiles || []).map(profile => ({
              ...profile,
              signedIn: provider.signedIn
            }));
          }
        } catch {}
      }
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
  if (providerId === 'chatgpt-web' && profileId === 'web') return 'chatgpt-normal';
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
      const providerReady = provider.id === 'chatgpt-web' ? provider.workerReady === true : true;
      row.ready = Boolean(provider.installed && profile.signedIn && profile.enabled !== false && providerReady);
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
          updated: data.updated || 0,
          heartbeatAt: data.heartbeat_at || 0,
          runnerPid: data.runner_pid || 0,
          workerPid: data.worker_pid || 0,
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

function pidAlive(pid) {
  const value = Number(pid) || 0;
  if (value <= 0) return false;
  try {
    process.kill(value, 0);
    return true;
  } catch {
    return false;
  }
}

function jobBlocksDesktopSleep(job) {
  const activeStates = new Set(['queued', 'starting', 'running', 'waiting_for_desktop', 'waiting']);
  if (!activeStates.has(job?.state)) return false;
  if (pidAlive(job.runnerPid) || pidAlive(job.workerPid)) return true;
  const stamp = Number(job.heartbeatAt || job.updated || job.started || job.created) || 0;
  return stamp > 0 && (Date.now() / 1000 - stamp) <= DESKTOP_IDLE_SECONDS;
}

function hasActiveDesktopWork() {
  if (TERMINALS.size > 0) return true;
  if (currentJobsSafe().some(jobBlocksDesktopSleep)) return true;
  if (chatgptProvider?.busy === true) return true;
  return false;
}

function currentJobsSafe() {
  try { return listJobs(100); } catch { return []; }
}

function clearDesktopIdleExit() {
  if (desktopIdleTimer) clearTimeout(desktopIdleTimer);
  desktopIdleTimer = null;
}

function scheduleDesktopIdleExit(delayMs = DESKTOP_IDLE_SECONDS * 1000) {
  clearDesktopIdleExit();
  desktopIdleTimer = setTimeout(() => {
    desktopIdleTimer = null;
    if (isQuitting) return;
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) return;
    if (hasActiveDesktopWork()) {
      scheduleDesktopIdleExit(30000);
      return;
    }
    isQuitting = true;
    app.quit();
  }, Math.max(1000, Number(delayMs) || DESKTOP_IDLE_SECONDS * 1000));
  desktopIdleTimer.unref?.();
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

function shouldUseWindowsAppUserModelId() {
  return process.platform === 'win32' && app.isPackaged;
}

function ensureWindowsShortcutIdentity() {
  if (process.platform !== 'win32' || !app.isPackaged) return;
  const appData = process.env.APPDATA || app.getPath('appData');
  const shortcut = path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'TEAMYRA.lnk');
  try {
    fs.mkdirSync(path.dirname(shortcut), { recursive: true });
    shell.writeShortcutLink(shortcut, 'replace', {
      target: process.execPath,
      cwd: path.dirname(process.execPath),
      description: 'TEAMYRA',
      icon: process.execPath,
      iconIndex: 0,
      appUserModelId: 'com.teamyra.desktop'
    });
    startupLog('windows-shortcut-ready', { shortcut, target: process.execPath });
  } catch (error) {
    startupLog('windows-shortcut-failed', { shortcut, error: String(error?.message || error) });
  }
}

function windowChrome() {
  if (process.platform === 'win32') {
    return {
      titleBarStyle: 'hidden',
      titleBarOverlay: {
        color: '#00000000',
        symbolColor: '#2f2b26',
        height: 28
      }
    };
  }
  if (process.platform === 'darwin') {
    return {
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 16, y: 11 }
    };
  }
  return {};
}

function showMainWindow() {
  clearDesktopIdleExit();
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createWindow(background = false) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    showMainWindow();
    return mainWindow;
  }

  const win = new BrowserWindow({
    show: false,
    width: 1360,
    height: 900,
    minWidth: 560,
    minHeight: 480,
    ...windowChrome(),
    backgroundColor: '#e9e9ef',
    title: 'TEAMYRA',
    icon: APP_ICON,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  mainWindow = win;
  if (process.platform === 'win32' && fs.existsSync(APP_ICON)) {
    try {
      win.setIcon(APP_ICON);
      win.setAppDetails({
        appId: 'com.teamyra.desktop',
        appIconPath: APP_ICON,
        appIconIndex: 0,
        relaunchCommand: '"' + process.execPath + '"',
        relaunchDisplayName: 'TEAMYRA'
      });
    } catch (error) {
      startupLog('window-icon-failed', { icon: APP_ICON, error: String(error?.message || error) });
    }
  }
  loadDesktopWindow(win, {
    entry: path.join(__dirname, '..', 'renderer', 'index.html'),
    log: startupLog,
    show: !background,
    onFailure: async reason => {
      const { response } = await dialog.showMessageBox({
        type: 'error', title: 'TEAMYRA could not load',
        message: reason,
        detail: 'See desktop-startup.log in the application user data logs folder. Restart TEAMYRA or reinstall if a resource is missing.',
        buttons: ['Restart', 'Quit'], defaultId: 0, cancelId: 1
      });
      if (response === 0) app.relaunch();
      app.quit();
    }
  });
  // Optional providers must never gate creation/loading of the desktop shell.
  setImmediate(async () => {
    if (win.isDestroyed()) return;
    try {
      chatgptProvider?.destroy();
      chatgptProvider = new ChatGPTWebProvider({ window: win, runtimeRoot: ROOT });
      await chatgptProvider.initialize();
    } catch (error) {
      startupLog('chatgpt-start-failed', { error: String(error?.stack || error) });
      chatgptProvider?.destroy();
      chatgptProvider = null;
    }
  });
  const webContentsId = win.webContents.id;
  win.on('close', event => {
    if (isQuitting) return;
    event.preventDefault();
    chatgptProvider?.setVisible(false);
    win.hide();
    scheduleDesktopIdleExit();
  });
  win.webContents.on('destroyed', () => {
    killTerminalsFor(webContentsId);
    chatgptProvider?.destroy();
    chatgptProvider = null;
    if (mainWindow === win) mainWindow = null;
  });
  return win;
}

ipcMain.handle('teamyra:update-status', () => ({ ...UPDATE_STATE }));
ipcMain.handle('teamyra:update-check', async () => {
  if (!app.isPackaged) return updateState({ status: 'disabled-dev' });
  try {
    updateState({ status: 'checking', error: null });
    await autoUpdater.checkForUpdates();
  } catch (error) {
    updateState({ status: 'error', error: String(error?.message || error) });
  }
  return { ...UPDATE_STATE };
});
ipcMain.handle('teamyra:update-install', () => {
  if (UPDATE_STATE.status !== 'downloaded') return { ok: false, reason: 'update-not-downloaded' };
  if (hasActiveDesktopWork()) return { ok: false, reason: 'active-work' };
  setImmediate(() => autoUpdater.quitAndInstall(false, true));
  return { ok: true };
});

ipcMain.handle('teamyra:providers', () => providersCached(true));
ipcMain.handle('teamyra:mcp-connections', async () => {
  const state = await getMcpConnections();
  if (state?.service?.running) mcpBootError = null;
  return { ...state, bootError: mcpBootError };
});
ipcMain.handle('teamyra:mcp-connect', async (_event, providerId) => {
  const result = await connectTeamyraMcp(String(providerId || ''));
  if (result?.ok) mcpBootError = null;
  PROVIDER_CACHE = { at: 0, data: null, pending: null };
  return result;
});
ipcMain.handle('teamyra:jobs', () => listJobs());
ipcMain.handle('teamyra:transcript', (_event, jobId, offset) => readTranscript(jobId, offset));
ipcMain.handle('teamyra:task-start', (_event, options = {}) =>
  callCore('task.start', {
    task: String(options.task || ''),
    project_path: String(options.projectPath || ''),
    worker: String(options.worker || 'auto'),
    write: options.write !== false,
    timeout_minutes: Number(options.timeoutMinutes) || 180,
    auto_failover: options.autoFailover !== false
  }, { timeout: 30000 })
);
ipcMain.handle('teamyra:task-cancel', (_event, jobId) =>
  callCore('task.cancel', { job_id: String(jobId || '') })
);
ipcMain.handle('teamyra:pick-project', async () => {
  const focused = BrowserWindow.getFocusedWindow();
  const options = { title: 'Choose a Teamyra workspace', properties: ['openDirectory', 'createDirectory'] };
  const result = focused ? await dialog.showOpenDialog(focused, options) : await dialog.showOpenDialog(options);
  return result.canceled || !result.filePaths[0]
    ? { cancelled: true, path: '' }
    : { cancelled: false, path: result.filePaths[0] };
});

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

ipcMain.handle('teamyra:chatgpt-status', () => chatgptProvider?.refreshStatus() || { connected: false });
ipcMain.handle('teamyra:chatgpt-open', () => {
  if (!chatgptProvider) throw new Error('ChatGPT provider is unavailable');
  return chatgptProvider.open();
});
ipcMain.handle('teamyra:chatgpt-close', () => chatgptProvider?.close() || { connected: false });
ipcMain.handle('teamyra:chatgpt-reload', () => {
  if (!chatgptProvider) throw new Error('ChatGPT provider is unavailable');
  return chatgptProvider.reload();
});
ipcMain.handle('teamyra:chatgpt-reconnect', () => {
  if (!chatgptProvider) throw new Error('ChatGPT provider is unavailable');
  return chatgptProvider.reconnect();
});
ipcMain.handle('teamyra:chatgpt-new-chat', () => {
  if (!chatgptProvider) throw new Error('ChatGPT provider is unavailable');
  return chatgptProvider.createConversation();
});
ipcMain.handle('teamyra:chatgpt-stop', () => chatgptProvider?.stopGeneration() || { ok: false });
ipcMain.handle('teamyra:chatgpt-send', (_event, text) => {
  if (!chatgptProvider) throw new Error('ChatGPT provider is unavailable');
  return chatgptProvider.sendTask(String(text || ''));
});
ipcMain.handle('teamyra:chatgpt-conversation', () => chatgptProvider?.getCurrentConversation() || {});
ipcMain.handle('teamyra:chatgpt-open-conversation', (_event, value) => {
  if (!chatgptProvider) throw new Error('ChatGPT provider is unavailable');
  return chatgptProvider.openConversation(value);
});
ipcMain.handle('teamyra:chatgpt-visible', (_event, visible) => {
  chatgptProvider?.setVisible(visible === true);
  return { ok: true };
});
ipcMain.handle('teamyra:chatgpt-bounds', (_event, bounds = {}) => {
  if (!chatgptProvider) return null;
  return chatgptProvider.setBounds(bounds);
});
ipcMain.handle('teamyra:chatgpt-workspace-status', () => {
  if (!chatgptProvider) throw new Error('ChatGPT provider is unavailable');
  return chatgptProvider.workspaceBridge.status();
});
ipcMain.handle('teamyra:chatgpt-workspace-configure', (_event, workspace, permissions = {}) => {
  if (!chatgptProvider) throw new Error('ChatGPT provider is unavailable');
  return chatgptProvider.workspaceBridge.configure(String(workspace || ''), permissions || {});
});
ipcMain.handle('teamyra:chatgpt-select-workspace', async () => {
  if (!chatgptProvider) throw new Error('ChatGPT provider is unavailable');
  const dialogOptions = {
    title: 'Select ChatGPT workspace',
    properties: ['openDirectory', 'createDirectory']
  };
  const focused = BrowserWindow.getFocusedWindow();
  const result = focused
    ? await dialog.showOpenDialog(focused, dialogOptions)
    : await dialog.showOpenDialog(dialogOptions);
  if (result.canceled || !result.filePaths[0]) return { cancelled: true };
  const configured = await chatgptProvider.workspaceBridge.configure(
    result.filePaths[0],
    {}
  );
  return { cancelled: false, ...configured };
});
ipcMain.handle('teamyra:chatgpt-changes', () => {
  if (!chatgptProvider) throw new Error('ChatGPT provider is unavailable');
  return chatgptProvider.workspaceBridge.changes();
});
ipcMain.handle('teamyra:chatgpt-revert', (_event, paths = ['.'], confirm = false) => {
  if (!chatgptProvider) throw new Error('ChatGPT provider is unavailable');
  if (confirm !== true) throw new Error('Revert requires explicit confirmation');
  return chatgptProvider.workspaceBridge.execute('git.restore', {
    paths: Array.isArray(paths) ? paths : ['.'],
    staged: true
  }, true);
});
ipcMain.handle('teamyra:chatgpt-attach-file', (_event, filePath) => {
  if (!chatgptProvider) throw new Error('ChatGPT provider is unavailable');
  return chatgptProvider.attachFile(String(filePath || ''));
});

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
ipcMain.handle('teamyra:conflict-begin', (_event, worktreeId, confirm = false) => {
  if (confirm !== true) throw new Error('Interactive rebase requires explicit confirmation');
  return callCore('worktree.conflict.begin', { worktree_id: worktreeId, confirm: true }, { timeout: 120000 });
});
ipcMain.handle('teamyra:conflict-detail', (_event, worktreeId, conflictPath) =>
  callCore('worktree.conflict.detail', {
    worktree_id: worktreeId,
    path: String(conflictPath || ''),
    max_chars: 300000
  }, { maxBuffer: 4 * 1024 * 1024 })
);
ipcMain.handle('teamyra:conflict-resolve', (_event, worktreeId, conflictPath, options = {}) => {
  if (options.confirm !== true) throw new Error('Conflict resolution requires explicit confirmation');
  return callCore('worktree.conflict.resolve', {
    worktree_id: worktreeId,
    path: String(conflictPath || ''),
    strategy: String(options.strategy || 'manual'),
    content: options.content,
    confirm: true
  }, { timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
});
ipcMain.handle('teamyra:conflict-continue', (_event, worktreeId, confirm = false) => {
  if (confirm !== true) throw new Error('Continue rebase requires explicit confirmation');
  return callCore('worktree.conflict.continue', { worktree_id: worktreeId, confirm: true }, { timeout: 120000 });
});
ipcMain.handle('teamyra:conflict-abort', (_event, worktreeId, confirm = false) => {
  if (confirm !== true) throw new Error('Abort rebase requires explicit confirmation');
  return callCore('worktree.conflict.abort', { worktree_id: worktreeId, confirm: true }, { timeout: 120000 });
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

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => showMainWindow());

  app.whenReady().then(() => {
    if (process.platform === 'win32') app.setAppUserModelId('com.teamyra.desktop');
    const background = process.argv.includes('--background');
    createWindow(background);
    if (background) scheduleDesktopIdleExit();
    ensureTeamyraMcp().then(() => {
      mcpBootError = null;
      startupLog('mcp-ready');
    }).catch(error => {
      mcpBootError = String(error?.message || error || 'TEAMYRA MCP failed to start');
      startupLog('mcp-start-failed', { error: mcpBootError });
    });
    setupAutoUpdates();
    app.on('activate', () => showMainWindow());
  }).catch(error => {
    startupLog('startup-failed', { error: String(error.stack || error) });
    dialog.showErrorBox('TEAMYRA could not start', String(error.message || error));
    app.quit();
  });
}

app.on('before-quit', () => {
  isQuitting = true;
  clearDesktopIdleExit();
  stopOwnedMcp();
});

app.on('window-all-closed', () => {
  // The lightweight wake gateway survives independently. The desktop UI exits
  // after its hidden idle window once no local jobs/terminals/ChatGPT work remain.
});
