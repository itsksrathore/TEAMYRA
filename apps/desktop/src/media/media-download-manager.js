const fs = require('node:fs');
const path = require('node:path');
const { mediaFingerprints, hammingDistance } = require('./media-output-validator');

// A downloaded file is attributed to a job only when its frames are clearly
// closer to that job's tile thumbnail than to any other pending job.
const MATCH_MAX_DISTANCE = 14;
const MATCH_MARGIN = 6;

function moveFile(source, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  try { fs.renameSync(source, destination); }
  catch (error) {
    if (error?.code !== 'EXDEV') throw error;
    fs.copyFileSync(source, destination);
    fs.unlinkSync(source);
  }
}

function bestDistance(fingerprint, hashes) {
  if (!fingerprint || !Array.isArray(hashes) || !hashes.length) return Infinity;
  return Math.min(...hashes.map(hash => hammingDistance(fingerprint, hash)));
}

class MediaDownloadManager {
  constructor(sessionManager, { fingerprint = mediaFingerprints } = {}) {
    this.sessionManager = sessionManager;
    this.fingerprint = fingerprint;
    this.expected = [];
    this.active = new Set();
    // Concurrent downloads arrive as anonymous blob URLs. While more than one
    // job may own the next download, files land in a neutral path first.
    this.inbox = new Set();
    this.held = [];
    this.sequence = 0;
    this.sessionManager.setDownloadHandler((event, item, webContents) => this.handleDownload(event, item, webContents));
  }

  expect({ jobId, webContentsId, destination, timeoutMs = 180000, fingerprint = null, signature = '' }) {
    const target = path.resolve(destination);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    return new Promise((resolve, reject) => {
      const record = {
        jobId: String(jobId),
        webContentsId: Number(webContentsId),
        destination: target,
        fingerprint: fingerprint || null,
        signature: String(signature || ''),
        order: ++this.sequence,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.expected = this.expected.filter(item => item !== record);
          this.active.delete(record);
          record.item?.cancel();
          reject(new Error('download_failure: Timed out waiting for Google media download completion'));
          this.settleHeld(record.webContentsId);
        }, timeoutMs)
      };
      record.timer.unref?.();
      this.expected.push(record);
    });
  }

  pendingFor(webContentsId) {
    return this.expected.filter(entry => entry.webContentsId === webContentsId);
  }

  handleDownload(event, item, webContents) {
    const id = Number(webContents?.id);
    const candidates = this.pendingFor(id);
    if (!candidates.length) {
      item.cancel();
      return;
    }
    const unresolved = [...this.inbox].some(entry => entry.webContentsId === id) ||
      this.held.some(entry => entry.webContentsId === id);
    if (candidates.length === 1 && !unresolved) {
      this.assignDirect(candidates[0], item);
      return;
    }
    this.receiveToInbox(item, id, candidates[0].destination);
  }

  assignDirect(record, item) {
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
          url: item.getURL?.() || '',
          attribution: 'single'
        });
      } catch (error) {
        record.reject(error);
      }
    });
  }

  receiveToInbox(item, webContentsId, nearPath) {
    const temp = path.join(path.dirname(nearPath),
      '.teamyra-download-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8) + '.part');
    const entry = { item, webContentsId, path: temp };
    this.inbox.add(entry);
    item.setSavePath(temp);
    item.once('done', async (_doneEvent, state) => {
      if (state !== 'completed') {
        this.inbox.delete(entry);
        try { fs.unlinkSync(temp); } catch {}
        // The owner is unknown; its expectation fails by timeout or recovery.
        this.settleHeld(webContentsId);
        return;
      }
      let bytes = 0;
      try { bytes = fs.statSync(temp).size; } catch {}
      const hashes = bytes > 0 ? await Promise.resolve(this.fingerprint(temp)).catch(() => []) : [];
      this.inbox.delete(entry);
      if (bytes <= 0) {
        try { fs.unlinkSync(temp); } catch {}
        this.settleHeld(webContentsId);
        return;
      }
      this.held.push({
        path: temp, webContentsId, bytes, hashes: hashes || [],
        mime: item.getMimeType?.() || '', url: item.getURL?.() || ''
      });
      this.settleHeld(webContentsId);
    });
  }

  // Pick the most confident (file, job) pair, or null when content does not decide.
  choosePair(files, pending) {
    let best = null;
    for (const file of files) {
      for (const record of pending) {
        const distance = bestDistance(record.fingerprint, file.hashes);
        if (!best || distance < best.distance) best = { file, record, distance };
      }
    }
    if (!best || best.distance > MATCH_MAX_DISTANCE) return null;
    // A competitor without a usable fingerprint could be the owner: no margin.
    const otherJobs = pending.filter(record => record !== best.record)
      .map(record => record.fingerprint ? bestDistance(record.fingerprint, best.file.hashes) : -Infinity);
    const otherFiles = files.filter(file => file !== best.file)
      .map(file => file.hashes?.length ? bestDistance(best.record.fingerprint, file.hashes) : -Infinity);
    const margin = Math.min(Infinity, ...otherJobs, ...otherFiles) - best.distance;
    return margin >= MATCH_MARGIN ? { ...best, attribution: 'fingerprint' } : null;
  }

  settleHeld(webContentsId) {
    for (;;) {
      const files = this.held.filter(entry => entry.webContentsId === webContentsId);
      if (!files.length) return;
      const pending = this.pendingFor(webContentsId);
      const arriving = [...this.inbox].some(entry => entry.webContentsId === webContentsId);
      if (!pending.length) {
        if (!arriving) for (const file of files) this.discard(file);
        return;
      }
      let choice = this.choosePair(files, pending);
      if (!choice && pending.length === 1 && files.length === 1 && !arriving) {
        choice = { file: files[0], record: pending[0], attribution: 'only_candidate' };
      }
      if (!choice) {
        const signatures = new Set(pending.map(record => record.signature));
        if (signatures.size === 1 && pending[0].signature) {
          // Identical requests (bulk copies) are interchangeable.
          const oldest = [...pending].sort((a, b) => a.order - b.order)[0];
          choice = { file: files[0], record: oldest, attribution: 'identical_request' };
        }
      }
      if (choice) {
        this.assignHeld(choice);
        continue;
      }
      if (!arriving && files.length >= pending.length) {
        // Every expected file is here and content still cannot tell them apart.
        // Fail these downloads rather than risk a prompt/file mismatch; recovery
        // downloads the existing results again one at a time.
        for (const record of pending) this.rejectRecord(record, new Error('download_failure: concurrent downloads could not be attributed to their results'));
        for (const file of files) this.discard(file);
      }
      return;
    }
  }

  assignHeld({ file, record, attribution, distance }) {
    this.held = this.held.filter(entry => entry !== file);
    this.expected = this.expected.filter(entry => entry !== record);
    clearTimeout(record.timer);
    try {
      moveFile(file.path, record.destination);
      record.resolve({
        jobId: record.jobId, path: record.destination, bytes: file.bytes,
        mime: file.mime, url: file.url, attribution,
        ...(Number.isFinite(distance) ? { fingerprint_distance: distance } : {})
      });
    } catch (error) {
      try { fs.unlinkSync(file.path); } catch {}
      record.reject(new Error('download_failure: ' + String(error?.message || error)));
    }
  }

  discard(file) {
    this.held = this.held.filter(entry => entry !== file);
    try { fs.unlinkSync(file.path); } catch {}
  }

  rejectRecord(record, error) {
    clearTimeout(record.timer);
    this.expected = this.expected.filter(entry => entry !== record);
    this.active.delete(record);
    record.item?.cancel();
    record.reject(error);
  }

  cancelJob(jobId) {
    const matches = [...this.expected, ...this.active].filter(entry => entry.jobId === String(jobId));
    for (const record of matches) this.rejectRecord(record, new Error('Media download cancelled'));
    for (const id of new Set(matches.map(record => record.webContentsId))) this.settleHeld(id);
  }
}

module.exports = { MediaDownloadManager, MATCH_MAX_DISTANCE, MATCH_MARGIN };
