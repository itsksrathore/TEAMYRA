const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('teamyra', {
  providers: () => ipcRenderer.invoke('teamyra:providers'),
  jobs: () => ipcRenderer.invoke('teamyra:jobs')
});
