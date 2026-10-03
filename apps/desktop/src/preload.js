const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('teamyra', {
  providers: () => ipcRenderer.invoke('teamyra:providers'),
  jobs: () => ipcRenderer.invoke('teamyra:jobs'),
  transcript: (jobId, offset = 0) => ipcRenderer.invoke('teamyra:transcript', jobId, offset),
  addAccount: (providerId, name) => ipcRenderer.invoke('teamyra:add-account', providerId, name)
});
