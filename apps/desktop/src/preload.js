const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('teamyra', {
  providers: () => ipcRenderer.invoke('teamyra:providers'),
  jobs: () => ipcRenderer.invoke('teamyra:jobs'),
  transcript: (jobId, offset = 0) => ipcRenderer.invoke('teamyra:transcript', jobId, offset),
  addAccount: (providerId, name) => ipcRenderer.invoke('teamyra:add-account', providerId, name),
  updateAccount: (providerId, profileId, patch) => ipcRenderer.invoke('teamyra:update-account', providerId, profileId, patch || {}),
  worktrees: () => ipcRenderer.invoke('teamyra:worktrees'),
  worktreeStatus: (worktreeId) => ipcRenderer.invoke('teamyra:worktree-status', worktreeId),
  worktreeDiff: (worktreeId, maxChars = 80000) => ipcRenderer.invoke('teamyra:worktree-diff', worktreeId, maxChars),
  createWorktree: (options) => ipcRenderer.invoke('teamyra:worktree-create', options || {}),
  mergeWorktree: (worktreeId, confirm = false) => ipcRenderer.invoke('teamyra:worktree-merge', worktreeId, confirm),
  discardWorktree: (worktreeId, options) => ipcRenderer.invoke('teamyra:worktree-discard', worktreeId, options || {}),
  openTerminal: (options) => ipcRenderer.invoke('teamyra:terminal-open', options || {}),
  writeTerminal: (id, data) => ipcRenderer.send('teamyra:terminal-input', { id, data }),
  resizeTerminal: (id, cols, rows) => ipcRenderer.send('teamyra:terminal-resize', { id, cols, rows }),
  closeTerminal: (id) => ipcRenderer.invoke('teamyra:terminal-close', id),
  onTerminalData: (callback) => ipcRenderer.on('teamyra:terminal-data', (_event, payload) => callback(payload)),
  onTerminalExit: (callback) => ipcRenderer.on('teamyra:terminal-exit', (_event, payload) => callback(payload))
});
