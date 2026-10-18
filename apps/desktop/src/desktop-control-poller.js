const fs = require('node:fs');
const path = require('node:path');

// Scanning and dispatch are separate: one stuck request cannot stop scanning,
// runtime heartbeat publication, or a status/reload request for another page.
class DesktopControlPoller {
  constructor({ directory, dispatch, onTick = () => {}, timeoutMs = 60000, intervalMs = 100 }) {
    Object.assign(this, { directory, dispatch, onTick, timeoutMs, intervalMs });
    this.inFlight = new Set();
    this.timer = null;
  }

  poll() {
    this.onTick();
    fs.mkdirSync(this.directory, { recursive: true });
    const files = fs.readdirSync(this.directory)
      .filter(name => name.endsWith('.request.json') && !this.inFlight.has(name)).slice(0, 20);
    for (const name of files) {
      const requestPath = path.join(this.directory, name);
      let req;
      try { req = JSON.parse(fs.readFileSync(requestPath, 'utf8')); } catch {}
      if (!req?.id || !req?.action) {
        try { fs.unlinkSync(requestPath); } catch {}
        continue;
      }
      this.inFlight.add(name);
      let timeout;
      const respond = response => {
        fs.writeFileSync(requestPath.replace(/\.request\.json$/, '.response.json'), JSON.stringify({ id: req.id, ...response }), 'utf8');
      };
      Promise.race([
        Promise.resolve().then(() => this.dispatch(String(req.action), req.payload || {})),
        new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error('Desktop control request timed out')), this.timeoutMs);
        })
      ]).then(result => respond({ ok: true, result }), error => respond({ ok: false, error: String(error?.message || error) }))
        .catch(() => {})
        .finally(() => {
          clearTimeout(timeout);
          try { fs.unlinkSync(requestPath); } catch {}
          this.inFlight.delete(name);
        });
    }
    return files.length;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => { try { this.poll(); } catch {} }, this.intervalMs);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }
}

module.exports = { DesktopControlPoller };
