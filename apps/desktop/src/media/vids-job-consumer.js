const fs = require('node:fs');
const path = require('node:path');
const { callCore } = require('../core-api');
const { verifyMediaOutput } = require('./media-output-validator');
const { GoogleVidsAdapter, samePrompt } = require('./google-vids-adapter');

// Google Vids worker for one hidden tab of one Google account. Like a Flow
// tab it claims jobs from the shared queue (surface "vids"), submits several
// at once in its Vids file, watches the result cards and saves each finished
// clip straight from its video URL with the account's session. Vids keeps
// results only in the open tab, so the tab is never reloaded while it works.
const IN_FLIGHT = 3;
const POLL_MS = 4000;
const NO_RESULT_MS = 12 * 60 * 1000;
const MISSING_GRACE_MS = 45 * 1000;
const VIDS_HOME = 'https://vids.new';

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

class Mutex {
  constructor() { this.tail = Promise.resolve(); }
  run(fn, timeoutMs = 4 * 60 * 1000) {
    const result = this.tail.then(() => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('browser_failure: Vids page operation timed out')), timeoutMs);
      timer.unref?.();
      Promise.resolve().then(fn).then(resolve, reject).finally(() => clearTimeout(timer));
    }));
    this.tail = result.catch(() => {});
    return result;
  }
}

function moveFile(source, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  try { fs.renameSync(source, destination); }
  catch (error) {
    if (error?.code !== 'EXDEV') throw error;
    fs.copyFileSync(source, destination);
    fs.unlinkSync(source);
  }
}

// Which Vids file each tab works in, kept across restarts.
class WorkspaceStore {
  constructor(file) { this.file = file; }
  read() { try { return JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { return {}; } }
  get(key) { return this.read()[key] || null; }
  set(key, url) {
    const data = this.read();
    data[key] = url;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(data, null, 2));
  }
}

class VidsJobConsumer {
  constructor({ workerName, provider, profileId = 'google', lane = 0, lanes = 1, ready = null, onActivity = () => {},
    isMain = () => true, mayClaim = () => true, workspaces, pollMs = POLL_MS, inFlightLimit = IN_FLIGHT, fetchVideo = null,
    core = callCore, verify = verifyMediaOutput }) {
    this.workerName = workerName;
    this.provider = provider;
    this.profileId = String(profileId || 'google');
    this.lane = lane;
    this.lanes = lanes;
    this.ready = ready || Promise.resolve();
    this.onActivity = onActivity;
    this.isMain = isMain;
    this.mayClaim = mayClaim;
    this.workspaces = workspaces;
    this.pollMs = pollMs;
    this.inFlightLimit = inFlightLimit;
    this.core = core;
    this.verify = verify;
    this.fetchVideo = fetchVideo || (url => this.provider.sessionManager.getSession().fetch(url));
    this.ui = new Mutex();
    this.inFlight = new Map();
    this.usedSources = new Set();
    this.usedFailures = new Set();
    this.running = false;
    this.submitting = false;
    this.busy = false;
    this.timer = null;
    this.monitorRunning = false;
    this.lastActivityAt = 0;
  }

  get workspaceKey() { return this.profileId + ':tab' + (this.lane + 1); }

  status() {
    return { lane: this.lane, url: this.provider.view?.webContents?.getURL?.() || '', submitting: this.submitting,
      in_flight: this.inFlight.size, limit: this.inFlightLimit };
  }

  refreshBusy() {
    this.busy = this.submitting || this.inFlight.size > 0;
    if (this.busy) {
      this.lastActivityAt = Date.now();
      globalThis.__teamyraVidsActiveAt = Date.now();
    }
  }

  schedule(delay = this.pollMs) {
    if (!this.running) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.tick().catch(() => this.schedule(Math.max(this.pollMs, 5000))), Math.max(150, delay));
    this.timer.unref?.();
  }

  start() { if (!this.running) { this.running = true; this.schedule(300); } }
  stop() { this.running = false; clearTimeout(this.timer); this.timer = null; }

  update(jobId, state, detail, extra) {
    return this.core('media.update-state', { job_id: jobId, state, detail, extra }, { timeout: 15000 });
  }

  async tick() {
    if (!this.running) return;
    await this.ready;
    if (this.submitting || this.inFlight.size >= this.inFlightLimit) return this.schedule();
    const resumeOnly = this.mayClaim() === false;
    const job = await this.core('media.claim', { surface: 'vids', worker: this.workerName, lane: this.lane, lanes: this.lanes,
      profile_id: this.profileId, main: this.isMain() !== false, resume_only: resumeOnly }, { timeout: 10000 });
    if (!job) return this.schedule(resumeOnly ? Math.max(this.pollMs, 15000) : this.pollMs);
    this.submitting = true;
    this.refreshBusy();
    this.onActivity();
    try { await this.admit(job); }
    finally {
      this.submitting = false;
      this.refreshBusy();
      this.schedule(this.inFlight.size ? 200 : 600);
    }
  }

  async adapter() {
    await this.provider.ensureView();
    if (!this.provider.adapter || this.provider.adapter.webContents !== this.provider.view.webContents) {
      this.provider.adapter = new GoogleVidsAdapter(this.provider.view.webContents);
    }
    return this.provider.adapter;
  }

  // Open (or create, once) this tab's Vids file.
  async workspace() {
    const adapter = await this.adapter();
    const saved = this.workspaces?.get(this.workspaceKey);
    const current = this.provider.view.webContents.getURL();
    const target = saved || VIDS_HOME;
    const url = /docs\.google\.com\/videos\/d\//.test(current) && (!saved || current.includes(saved.match(/\/d\/([^/]+)/)?.[1] || '#'))
      ? current : target;
    const remember = address => {
      const base = String(address || '').match(/^(https:\/\/docs\.google\.com\/videos\/d\/[^/?#]+)/)?.[1];
      if (base && base + '/edit' !== this.workspaces?.get(this.workspaceKey)) this.workspaces?.set(this.workspaceKey, base + '/edit');
    };
    // vids.new makes a new Drive file: remember it at once so a later failure
    // does not leave another empty one behind on the next try.
    if (url === VIDS_HOME) remember(await this.provider.load(VIDS_HOME));
    const opened = await adapter.ensureWorkspace(url === VIDS_HOME ? null : url);
    remember(opened);
    return opened;
  }

  async admit(job) {
    const jobId = job.job_id;
    try {
      if (job.provider_submission?.submitted_at) {
        // Vids keeps unfinished clips only in the tab that made them; after a
        // restart that tab is new and the clip cannot be found again.
        await this.update(jobId, 'failed', 'generation_failure: Google Vids keeps clips only in its open tab and this one ' +
          'was lost when TEAMYRA restarted before it finished. Queue it again (Vids generation uses no Flow credits).', {
          failure: { category: 'vids_tab_lost', at: Date.now() / 1000 } });
        return;
      }
      const status = await this.core('media.status', { job_id: jobId }, { timeout: 10000 });
      if (status.cancel_requested) return this.update(jobId, 'cancelled', 'Cancelled before browser execution');
      await this.update(jobId, 'waiting_for_browser', 'Opening Google Vids');
      const planned = await this.core('media.prepare-output', { job_id: jobId });
      const request = job.request || {};
      const images = (job.resolved_references || []).map(item => item.path).filter(Boolean);
      const source = job.resolved_source?.path || null;
      await this.update(jobId, 'submitting', this.inFlight.size
        ? 'Submitting to Google Vids (' + (this.inFlight.size + 1) + ' running in this tab)' : 'Submitting to Google Vids');
      let knownFailures = new Set();
      const submission = await this.ui.run(async () => {
        await this.workspace();
        const adapter = await this.adapter();
        // Failure cards already in the feed belong to earlier clips.
        knownFailures = new Set((await adapter.cards().catch(() => [])).filter(card => card.kind === 'failed').map(card => card.id));
        return adapter.submit({
          prompt: request.provider_prompt || request.prompt,
          images,
          mode: ({ create: 'Create', extend: 'Extend', edit: 'Edit', animate: 'Animate' })[request.vids_mode || 'create'] || 'Create',
          resolution: request.generation_settings?.generation_resolution || '1080p',
          portrait: request.aspect_ratio === '9:16',
          duration: request.duration || null,
          sourceVideo: source
        });
      });
      const providerSubmission = { ...submission, engine: 'google-vids', lane: this.lane, profile_id: this.profileId };
      await this.core('media.patch', { job_id: jobId, patch: {
        provider: 'google-vids', provider_submission: providerSubmission, reconcile_required: false, submission_phase: 'submitted'
      } });
      await this.update(jobId, 'generating', 'Google Vids is generating the clip');
      this.inFlight.set(jobId, { jobId, job, planned, prompt: request.provider_prompt || request.prompt,
        submittedAt: Date.now(), submission: providerSubmission, seenRunning: true, knownFailures });
      this.refreshBusy();
      this.ensureMonitor();
    } catch (error) {
      // Name the step a hung page operation was on.
      const step = this.provider.adapter?.step;
      const text = String(error?.message || error);
      await this.fail(jobId, /timed out/.test(text) && step && !text.includes('step:') ? new Error(text + ' (step: ' + step + ')') : error);
    }
  }

  async fail(jobId, error, category = null) {
    const text = String(error?.message || error || 'generation_failure');
    const kind = category || (/login_required|sign-in/i.test(text) ? 'login_required'
      : /selector_failure/.test(text) ? 'selector_failure' : /browser_failure/.test(text) ? 'browser_failure'
        : /download_failure/.test(text) ? 'download_failure' : /policy_refusal/.test(text) ? 'policy_refusal'
          : /provider_no_result/.test(text) ? 'provider_no_result' : 'generation_failure');
    const state = kind === 'login_required' ? 'needs_user_auth' : 'failed';
    await this.update(jobId, state, kind + ': ' + text.replace(/^\w+: /, '').slice(0, 1200), {
      failure: { category: kind, at: Date.now() / 1000 }, retry_after: 0 }).catch(() => {});
  }

  ensureMonitor() {
    if (this.monitorRunning) return;
    this.monitorRunning = true;
    this.monitor().finally(() => { this.monitorRunning = false; if (this.waiting().length) this.ensureMonitor(); });
  }

  waiting() { return [...this.inFlight.values()].filter(ctx => !ctx.downloading); }

  async monitor() {
    while (this.waiting().length) {
      await sleep(this.pollMs);
      try { await this.pollOnce(); } catch { /* next round */ }
    }
  }

  async pollOnce() {
    const live = this.waiting().sort((a, b) => a.submittedAt - b.submittedAt);
    if (!live.length) return;
    const adapter = await this.adapter();
    const cards = await this.ui.run(() => adapter.cards(), 60000);
    const statuses = (await this.core('media.status-many', { job_ids: live.map(ctx => ctx.jobId) }, { timeout: 15000 }))?.jobs || {};
    // Jobs whose card is gone (neither running nor done) past the grace
    // period. New failure cards go to them only when there are enough for all
    // of them: a failure card does not say which prompt failed.
    const missing = live.filter(ctx => !statuses[ctx.jobId]?.cancel_requested &&
      !cards.some(card => (card.kind === 'running' || (card.kind === 'done' && !this.usedSources.has(card.src))) && samePrompt(card.label, ctx.prompt)) &&
      Date.now() - ctx.submittedAt >= MISSING_GRACE_MS && Date.now() - (ctx.lastRunningAt || ctx.submittedAt) >= MISSING_GRACE_MS);
    const newFailures = cards.filter(card => card.kind === 'failed' && card.id && !this.usedFailures.has(card.id) &&
      missing.every(ctx => !ctx.knownFailures?.has(card.id)));
    const refusals = new Map(missing.length && newFailures.length >= missing.length
      ? missing.map((ctx, index) => [ctx.jobId, newFailures[index]]) : []);
    for (const ctx of live) {
      if (statuses[ctx.jobId]?.cancel_requested) {
        this.finish(ctx);
        await this.update(ctx.jobId, 'cancelled', 'Cancellation requested').catch(() => {});
        continue;
      }
      // Oldest job first takes the oldest matching result (copies share a prompt).
      const done = cards.find(card => card.kind === 'done' && card.src && !this.usedSources.has(card.src) && samePrompt(card.label, ctx.prompt));
      if (done) {
        this.usedSources.add(done.src);
        ctx.downloading = true;
        this.download(ctx, done).catch(() => {});
        continue;
      }
      const running = cards.some(card => card.kind === 'running' && samePrompt(card.label, ctx.prompt));
      const age = Date.now() - ctx.submittedAt;
      if (running) { ctx.lastRunningAt = Date.now(); continue; }
      if (age < MISSING_GRACE_MS || Date.now() - (ctx.lastRunningAt || ctx.submittedAt) < MISSING_GRACE_MS) continue;
      const refusal = refusals.get(ctx.jobId);
      if (refusal) this.usedFailures.add(refusal.id);
      const failure = refusal?.label || await this.ui.run(() => adapter.failureFor(ctx.prompt), 60000).catch(() => null);
      if (failure) {
        this.finish(ctx);
        await this.fail(ctx.jobId, new Error('Google Vids did not make this clip: ' + failure),
          /violat|policy|not allowed|different prompt|against our terms|asking something else/i.test(failure) ? 'policy_refusal' : 'generation_failure');
      } else if (age > NO_RESULT_MS) {
        this.finish(ctx);
        await this.fail(ctx.jobId, new Error('provider_no_result: Google Vids showed no result after ' + Math.round(age / 1000) + ' s'));
      }
    }
  }

  async download(ctx, card) {
    const { jobId, job, planned } = ctx;
    try {
      await this.update(jobId, 'downloading', 'Saving the Google Vids clip');
      const staging = planned.staging_dir || path.join(path.dirname(planned.path), '.staging-' + jobId);
      fs.mkdirSync(staging, { recursive: true });
      const file = path.join(staging, 'download.mp4');
      const response = await this.fetchVideo(card.src);
      if (!response.ok) throw new Error('download_failure: Google Vids clip download returned HTTP ' + response.status);
      fs.writeFileSync(file, Buffer.from(await response.arrayBuffer()));
      const request = job.request || {};
      const quality = request.generation_settings?.generation_resolution === '720p' ? 'source' : '1080p';
      const info = await this.verify(file, request, { quality });
      moveFile(file, planned.path);
      await this.update(jobId, 'organizing', 'Registering generated asset');
      await this.core('media.register-asset', {
        job_id: jobId, local_path: planned.path, provider: 'google-vids',
        provider_asset_id: null, provider_project_id: ctx.submission.provider_url?.match(/\/videos\/d\/([^/?#]+)/)?.[1] || null,
        provider_url: ctx.submission.provider_url, generation_settings: request.generation_settings || {},
        metadata: { engine: 'google-vids', vids_mode: request.vids_mode || 'create', google_profile_id: this.profileId,
          tab: this.lane + 1, verified_output: info, card_label: String(card.label || '').slice(0, 400),
          mime: 'video/mp4', bytes: fs.statSync(planned.path).size, batch_id: job.batch_id || null }
      }, { timeout: 20000 });
      try { fs.rmSync(staging, { recursive: true, force: true }); } catch {}
    } catch (error) {
      await this.fail(jobId, error);
    } finally {
      this.finish(ctx);
    }
  }

  finish(ctx) {
    this.inFlight.delete(ctx.jobId);
    this.refreshBusy();
    this.onActivity();
    this.schedule(200);
  }
}

module.exports = { VidsJobConsumer, WorkspaceStore, IN_FLIGHT };
