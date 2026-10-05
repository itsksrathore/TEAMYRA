const fs = require('node:fs');
const path = require('node:path');

class MediaDownloadManager {
  constructor(sessionManager) {
    this.sessionManager = sessionManager;
    this.expected = [];
    this.active = new Set();
    this.sessionManager.setDownloadHandler((event, item, webContents) => this.handleDownload(event, item, webContents));
  }

  expect({ jobId, webContentsId, destination, timeoutMs = 180000 }) {
    const target = path.resolve(destination);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    return new Promise((resolve, reject) => {
      const record = {
        jobId: String(jobId),
        webContentsId: Number(webContentsId),
        destination: target,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.expected = this.expected.filter(item => item !== record);
          this.active.delete(record);
          record.item?.cancel();
          reject(new Error('download_failure: Timed out waiting for Google media download completion'));
        }, timeoutMs)
      };
      record.timer.unref?.();
      this.expected.push(record);
    });
  }

  handleDownload(event, item, webContents) {
    const id = Number(webContents?.id);
    const record = this.expected.find(entry => entry.webContentsId === id);
    if (!record) {
      item.cancel();
      return;
    }
    this.expected = this.expected.filter(entry => entry !== record);
    record.item = item;
    this.active.add(record);
    item.setSavePath(record.destination);
    item.once('done', (_doneEvent, state) => {
      clearTimeout(record.timer);
      this.active.delete(record);
      if (state !== 'completed') {
        record.reject(new Error('Media download ended with state: ' + state));
        return;
      }
      try {
        const stat = fs.statSync(record.destination);
        if (!stat.isFile() || stat.size <= 0) throw new Error('Downloaded media file is empty');
        record.resolve({
          jobId: record.jobId,
          path: record.destination,
          bytes: stat.size,
          mime: item.getMimeType?.() || '',
          url: item.getURL?.() || ''
        });
      } catch (error) {
        record.reject(error);
      }
    });
  }

  cancelJob(jobId) {
    const matches = [...this.expected, ...this.active].filter(entry => entry.jobId === String(jobId));
    this.expected = this.expected.filter(entry => entry.jobId !== String(jobId));
    for (const record of matches) {
      clearTimeout(record.timer);
      this.active.delete(record);
      record.item?.cancel();
      record.reject(new Error('Media download cancelled'));
    }
  }
}

module.exports = { MediaDownloadManager };
