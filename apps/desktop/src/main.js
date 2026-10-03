const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { detectProviders } = require('./provider-registry');

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
}

ipcMain.handle('teamyra:providers', () => detectProviders());
ipcMain.handle('teamyra:jobs', () => listJobs());

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
