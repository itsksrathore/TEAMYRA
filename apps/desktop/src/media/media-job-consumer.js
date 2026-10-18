const fs = require('node:fs');
const { callCore } = require('../core-api');
const { extractAudio } = require('./media-audio-processor');
const { convertImage, verifyMediaOutput } = require('./media-output-validator');
const { mediaId } = require('./flow-reference-controller');

// Visual jobs are pipelined: each one is submitted as soon as the composer is
// free, then every in-flight generation is watched by one shared monitor.
const DEFAULT_PARALLEL = 10;
const MAX_PARALLEL = 30;
const DOWNLOAD_PARALLEL = 4;
const GENERATION_TIMEOUT_MS = 20 * 60 * 1000;
const MONITOR_MS = 2500;
const MONITOR_MAX_ERRORS = 12;
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function classifyError(error) {
  const text = String(error?.message || error || '').toLowerCase();
  if (text.includes('human_verification') || text.includes('captcha')) return { state: 'needs_user_auth', category: 'human_verification' };
  if (text.includes('login_required') || text.includes('sign-in') || text.includes('sign in')) return { state: 'needs_user_auth', category: 'login_required' };
  if (text.includes('rate_limited') || text.includes('rate limit') || text.includes('capacity_limited')) return { state: 'rate_limited', category: 'rate_limited' };
  if (text.includes('credits_exhausted') || text.includes('credits')) return { state: 'failed', category: 'credits_exhausted' };
  if (text.includes('policy_refusal') || text.includes('policy')) return { state: 'failed', category: 'policy_refusal' };
  if (text.includes('browser_probe_failed')) return { state: 'failed', category: 'browser_probe_failed' };
  if (/execution context was destroyed|frame was detached|webcontents.*destroyed|err_(?:connection|internet|network)|browser_failure/.test(text)) return { state: 'failed', category: 'browser_failure' };
  if (text.includes('selector_failure')) return { state: 'failed', category: 'selector_failure' };
  // A wrong-shaped result is the provider's output, not a transfer problem;
  // downloading it again cannot fix it.
  if (text.includes('does not match request')) return { state: 'failed', category: 'output_mismatch' };
  if (text.includes('download')) return { state: 'failed', category: 'download_failure' };
  if (text.includes('ffmpeg') || text.includes('audio')) return { state: 'failed', category: 'audio_extraction_failure' };
  return { state: 'failed', category: 'generation_failure' };
}

// Requests with the same signature produce interchangeable results (bulk copies).
function requestSignature(job) {
  const request = job?.request || {};
  return JSON.stringify([
    request.type, request.provider_prompt || request.prompt, request.aspect_ratio || null,
    request.duration || null, request.model_preference || null, request.generation_settings || {},
    (job?.resolved_references || []).map(item => item.asset_id || item.path)
  ]);
}

function clampParallel(value, fallback) {
  const number = Math.round(Number(value));
  return Number.isFinite(number) && number > 0 ? Math.min(MAX_PARALLEL, number) : fallback;
}

// Serializes page interaction: one composer, one menu, one info panel at a time.
class Mutex {
  constructor() { this.tail = Promise.resolve(); }
  run(fn) {
    const result = this.tail.then(() => fn());
    this.tail = result.catch(() => {});
    return result;
  }
}

class MediaJobConsumer {
  constructor({ surface, workerName, provider, downloadManager, profileId = 'google', pollMs = 3500, onActivity = () => {}, maxParallel = null, monitorMs = MONITOR_MS }) {
    this.surface = surface;
    this.workerName = workerName;
    this.provider = provider;
    this.downloadManager = downloadManager;
    this.profileId = String(profileId || 'google');
    this.pollMs = pollMs;
    this.running = false;
    this.busy = false;
    this.timer = null;
    this.currentJobId = null;
    this.onActivity = onActivity;
    // Flow Music keeps its one-song-at-a-time flow.
    this.pipeline = surface === 'visual';
    this.defaultParallel = clampParallel(maxParallel, this.pipeline ? DEFAULT_PARALLEL : 1);
    this.requestedParallel = this.defaultParallel;
    this.adaptiveLimit = null;
    this.pausedUntil = 0;
    this.pauseReason = '';
    this.submitting = false;
    this.inFlight = new Map();
    this.downloadQueue = [];
    this.activeDownloads = new Set();
    this.monitorRunning = false;
    this.monitorErrors = 0;
    this.monitorMs = monitorMs;
    this.capabilitiesSignature = '';
    // Result tiles already given to a job in this session (bulk copies share a prompt).
    this.assignedKeys = new Map();
    this.ui = new Mutex();
  }

  get parallelLimit() {
    return Math.max(1, Math.min(MAX_PARALLEL, this.adaptiveLimit ?? this.requestedParallel));
  }

  pipelineStatus() {
    const phases = {};
    for (const ctx of this.inFlight.values()) phases[ctx.phase] = (phases[ctx.phase] || 0) + 1;
    return {
      pipelined: this.pipeline,
      in_flight: this.inFlight.size,
      phases,
      parallel_limit: this.parallelLimit,
      requested_parallel: this.requestedParallel,
      downloads_active: this.activeDownloads.size,
      downloads_waiting: this.downloadQueue.length,
      paused_until: this.pausedUntil > Date.now() ? this.pausedUntil / 1000 : null,
      pause_reason: this.pausedUntil > Date.now() ? this.pauseReason : ''
    };
  }

  refreshBusy() {
    this.busy = this.submitting || this.inFlight.size > 0;
    if (this.pipeline) this.currentJobId = this.inFlight.keys().next().value || null;
  }

  schedule(delayMs = this.pollMs) {
    if (!this.running) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.tick().catch(() => {
      this.schedule(Math.max(this.pollMs, 5000));
    }), Math.max(150, Number(delayMs) || this.pollMs));
    this.timer.unref?.();
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.schedule(100);
  }

  stop() {
    // In-flight generations keep being watched and downloaded; only new claims stop.
    this.running = false;
    clearTimeout(this.timer);
    this.timer = null;
  }

  async tick() {
    if (!this.running) return;
    if (!this.pipeline) return this.serialTick();
    if (this.submitting || this.inFlight.size >= this.parallelLimit || Date.now() < this.pausedUntil) {
      this.schedule(Date.now() < this.pausedUntil ? Math.min(this.pollMs, this.pausedUntil - Date.now() + 50) : this.pollMs);
      return;
    }
    const job = await callCore('media.claim', { surface: this.surface, worker: this.workerName }, { timeout: 10000 });
    if (!job) {
      this.schedule(this.pollMs);
      return;
    }
    this.requestedParallel = clampParallel(job.request?.max_parallel, this.defaultParallel);
    this.submitting = true;
    this.refreshBusy();
    this.onActivity();
    try { await this.admit(job); }
    finally {
      this.submitting = false;
      this.refreshBusy();
      this.onActivity();
      // Claim the next queued job right away while slots remain.
      this.schedule(this.inFlight.size ? 150 : 500);
    }
  }

  async serialTick() {
    if (this.busy) {
      this.schedule(this.pollMs);
      return;
    }
    const job = await callCore('media.claim', { surface: this.surface, worker: this.workerName }, { timeout: 10000 });
    if (!job) {
      this.schedule(this.pollMs);
      return;
    }
    this.busy = true;
    this.currentJobId = job.job_id;
    this.onActivity();
    try { await this.process(job); }
    finally {
      this.currentJobId = null;
      this.busy = false;
      this.onActivity();
      this.schedule(500);
    }
  }

  async update(jobId, state, detail, extra) {
    return callCore('media.update-state', { job_id: jobId, state, detail, extra }, { timeout: 15000 });
  }

  async stableProbe(adapter, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    let lastError = null;
    while (Date.now() < deadline) {
      try {
        const probe = await adapter.probe();
        const state = adapter.classifyProbe(probe);
        if (state.signedIn || state.challenged || state.rateLimited || state.creditsExhausted ||
            /accounts\.google\.com\//i.test(probe.url || '') ||
            [...(probe.labels || []), ...(probe.buttonLabels || [])].some(label => /^(?:sign in|log in|choose an account|continue with google)$/i.test(label.trim()))) return probe;
        lastError = new Error('Provider application is still loading');
        await sleep(250);
      } catch (error) {
        lastError = error;
        await sleep(250);
      }
    }
    throw new Error('browser_probe_failed: ' + String(lastError?.message || lastError || 'provider page was not stable').slice(0, 1200));
  }

  // Everything up to an acknowledged (or reconciled) provider submission.
  // Returns the in-flight context, or null once a terminal state was written.
  async prepareAndSubmit(job, ctx = { checkpointed: false }) {
    const jobId = job.job_id;
    const current = await callCore('media.status', { job_id: jobId }, { timeout: 10000 });
    if (current.cancel_requested) {
      await this.update(jobId, 'cancelled', 'Cancelled before browser execution');
      return null;
    }
    await this.update(jobId, 'waiting_for_browser', 'Preparing Google media browser worker');
    if (job.recovery?.reset_browser) {
      // Recreate only this worker's view; retain the session and durable result
      // identity. Never tear down a view other in-flight jobs are using.
      if (!this.inFlight.size && !this.activeDownloads.size) this.provider.destroy();
      await callCore('media.patch', { job_id: jobId, patch: {
        recovery: { ...job.recovery, reset_browser: false }
      } });
    }
    const { adapter, probe } = await this.ui.run(async () => {
      await this.provider.ensureLoaded();
      const loaded = this.provider.adapter;
      return { adapter: loaded, probe: await this.stableProbe(loaded) };
    });
    const classified = adapter.classifyProbe(probe);
    if (classified.challenged) {
      await callCore('media.connection-update', { patch: { connected: false, challenged: true, needs_user_auth: true, detail: 'Google requires human verification' } });
      await this.update(jobId, 'needs_user_auth', 'human_verification');
      return null;
    }
    if (!classified.signedIn) {
      await callCore('media.connection-update', { patch: { connected: false, needs_user_auth: true, detail: 'Google Media sign-in is required' } });
      await this.update(jobId, 'needs_user_auth', 'login_required');
      return null;
    }
    if (classified.rateLimited) {
      throw new Error('rate_limited_before_submission');
    }
    if (classified.creditsExhausted) {
      await this.update(jobId, 'failed', 'credits_exhausted_before_submission');
      return null;
    }

    const capabilities = await adapter.capabilities(probe);
    const capabilitiesSignature = JSON.stringify(capabilities);
    // Bulk jobs share one page; record capabilities when they change.
    if (!this.pipeline || capabilitiesSignature !== this.capabilitiesSignature || !this.inFlight.size) {
      await callCore('media.patch', { job_id: jobId, patch: { capabilities } });
      this.capabilitiesSignature = capabilitiesSignature;
    }
    const planned = await callCore('media.prepare-output', { job_id: jobId });

    let submission = job.provider_submission || {};
    const submittedBeforeClaim = Boolean(submission.submitted_at);

    if (job.reconcile_required && !submittedBeforeClaim) {
      throw new Error('generation_failure: possible submission lacks provider identity; manual reconciliation required');
    }

    if (submittedBeforeClaim) {
      const reconciled = await this.ui.run(() => adapter.reconcile(job, { allowNavigation: !this.activeDownloads.size }));
      if (!reconciled?.reconciled) {
        throw new Error('generation_failure: provider reconciliation could not identify the submitted job');
      }
      ctx.checkpointed = true;
      await callCore('media.reconcile', {
        job_id: jobId,
        provider_submission: submission,
        resume_state: 'generating'
      }, { timeout: 15000 });
    } else {
      await callCore('media.patch', { job_id: jobId, patch: { submission_phase: 'preparing' } });
      await this.update(jobId, 'submitting', this.inFlight.size
        ? 'Submitting generation request (' + (this.inFlight.size + 1) + ' running in parallel)'
        : 'Submitting generation request');
      submission = await this.ui.run(() => adapter.submit(job, async pendingSubmission => {
        submission = pendingSubmission;
        ctx.checkpointed = true;
        await callCore('media.patch', { job_id: jobId, patch: {
          provider_submission: pendingSubmission, reconcile_required: true, submission_phase: 'may_have_submitted'
        }});
      }));
      await callCore('media.patch', { job_id: jobId, patch: {
        provider: this.surface === 'music' ? 'google-flow-music' : 'google-flow',
        provider_submission: submission, reconcile_required: false, submission_phase: 'submitted'
      }});
      await this.update(jobId, 'generating', 'Provider generation is in progress');
    }
    const baseline = Number(submission.baseline_failure_signals);
    this.assignKey(jobId, submission.result_key);
    return Object.assign(ctx, {
      job, jobId, planned, submission,
      phase: 'generating',
      submittedAt: Date.now(),
      baselineFailures: Number.isFinite(baseline) && submission.baseline_failure_signals !== null ? baseline : null,
      resultKey: submission.result_key || null,
      fingerprint: null
    });
  }

  // Serial wait for a single job; bulk jobs use the shared monitor instead.
  async awaitResult(ctx) {
    const { job, jobId } = ctx;
    const adapter = this.provider.adapter;
    const deadline = Date.now() + GENERATION_TIMEOUT_MS;
    let state;
    while (Date.now() < deadline) {
      const status = await callCore('media.status', { job_id: jobId }, { timeout: 10000 });
      if (status.cancel_requested) {
        this.downloadManager.cancelJob(jobId);
        await this.update(jobId, 'cancelled', 'Cancellation requested');
        return false;
      }
      state = await this.ui.run(() => adapter.generationState({ ...job, ...status, request: job.request }));
      if (state.result_key) {
        ctx.submission = { ...status.provider_submission, result_key: state.result_key };
        ctx.resultKey = state.result_key;
        await callCore('media.patch', { job_id: jobId, patch: { provider_submission: ctx.submission } });
      }
      if (state.state === 'ready_to_download') break;
      if (state.state === 'rate_limited') {
        throw new Error('rate_limited: ' + state.reason);
      }
      if (state.state === 'failed') throw new Error(state.reason || 'generation_failure');
      if (state.state === 'needs_user_auth') {
        await this.update(jobId, state.state, state.reason);
        return false;
      }
      await sleep(2500);
    }
    if (state?.state !== 'ready_to_download') throw new Error('generation_failure: timed out waiting for provider result');
    return true;
  }

  async downloadAndRegister(ctx) {
    const { job, jobId, planned } = ctx;
    let submission = ctx.submission || {};
    const adapter = this.provider.adapter;
    const request = job.request;
    const isSfx = request.type === 'sound_effect';
    const isImage = request.type === 'image';
    const downloadPath = isSfx ? planned.temporary_video_path : isImage ? planned.path + '.provider-download' : planned.path;
    const downloadJob = { ...job, ...await callCore('media.status', { job_id: jobId }, { timeout: 10000 }), request };
    if (ctx.resultKey) downloadJob.provider_submission = { ...downloadJob.provider_submission, result_key: ctx.resultKey };
    const excludeKeys = this.otherAssignedKeys(jobId);
    if (downloadJob.cancel_requested) return this.update(jobId, 'cancelled', 'Cancelled before download');
    await this.update(jobId, 'downloading', this.activeDownloads.size > 1
      ? 'Downloading generated media (' + this.activeDownloads.size + ' downloads in parallel)'
      : 'Downloading generated media');
    const waitsForUpscale = request.type === 'image' || request.type === 'video';
    let downloaded;
    let downloadAction;
    const savedDownload = job.download;
    if (savedDownload?.completed && savedDownload.path === downloadPath &&
        fs.existsSync(downloadPath) && fs.statSync(downloadPath).size === savedDownload.bytes) {
      downloaded = savedDownload;
      downloadAction = savedDownload.action;
    } else {
      const attemptDownload = async targetJob => {
        const downloadPromise = this.downloadManager.expect({
          jobId,
          webContentsId: this.provider.view.webContents.id,
          destination: downloadPath,
          timeoutMs: waitsForUpscale ? 600000 : 180000,
          fingerprint: ctx.fingerprint || null,
          signature: requestSignature(job)
        });
        // Observe rejection immediately while the adapter waits on an upscale.
        downloadPromise.catch(() => {});
        try {
          // Only the menu activation holds the page; the upscale wait does not.
          downloadAction = await this.ui.run(() => adapter.startDownload(targetJob, { excludeKeys }));
          return await downloadPromise;
        } catch (error) {
          this.downloadManager.cancelJob(jobId);
          throw error;
        }
      };
      try { downloaded = await attemptDownload(downloadJob); }
      catch (error) {
        if ((await callCore('media.status', { job_id: jobId })).cancel_requested) return this.update(jobId, 'cancelled', 'Cancelled during download');
        const preferFour = (request.generation_settings?.download_quality || 'prefer_4x_then_2x') === 'prefer_4x_then_2x';
        if (!isImage || !preferFour || downloadAction?.quality !== '4x' || classifyError(error).category !== 'download_failure') throw error;
        await this.update(jobId, 'downloading', '4x download failed; trying 2x upscale of the same result');
        downloaded = await attemptDownload({ ...downloadJob, request: { ...request,
          generation_settings: { ...request.generation_settings, download_quality: '2x' }
        } });
      }
      await callCore('media.patch', { job_id: jobId, patch: {
        download: { ...downloaded, action: downloadAction, completed: true }
      }});
    }

    let finalPath = downloaded.path;
    if ((await callCore('media.status', { job_id: jobId })).cancel_requested) return this.update(jobId, 'cancelled', 'Cancelled after download');
    if (isImage) {
      await convertImage(downloaded.path, planned.path, planned.format);
      finalPath = planned.path;
    }
    if (isSfx) {
      await this.update(jobId, 'extracting_audio', 'Extracting sound effect audio');
      await extractAudio(downloaded.path, planned.path, planned.format);
      finalPath = planned.path;
    }

    const outputInfo = await verifyMediaOutput(finalPath, request, downloadAction);

    await this.update(jobId, 'organizing', 'Registering generated asset');
    const latestJob = await callCore('media.status', { job_id: jobId });
    const providerSubmission = latestJob.provider_submission || submission;
    const asset = await callCore('media.register-asset', {
      job_id: jobId,
      local_path: finalPath,
      provider: this.surface === 'music' ? 'google-flow-music' : 'google-flow',
      provider_asset_id: providerSubmission.provider_asset_id || mediaId(providerSubmission.result_key),
      provider_project_id: providerSubmission.provider_project_id || providerSubmission.provider_url?.match(/\/project\/([^/?#]+)/)?.[1],
      provider_url: providerSubmission.provider_url,
      generation_settings: request.generation_settings || {},
      metadata: { reference_attachments: providerSubmission.reference_attachments || [], reference_mode: providerSubmission.reference_mode || 'ingredients', mime: isImage ? 'image/' + (['jpg', 'jpeg'].includes(planned.format) ? 'jpeg' : planned.format) : isSfx ? (planned.format === 'wav' ? 'audio/wav' : 'audio/' + planned.format) : downloaded.mime || '', bytes: fs.statSync(finalPath).size, google_profile_id: this.profileId, download_action: downloadAction || null, download_attribution: downloaded.attribution || null, verified_output: outputInfo, selected_settings: providerSubmission.selected_settings || null, actual_model: providerSubmission.actual_model || null, batch_id: job.batch_id || null }
    }, { timeout: 20000 });
    if (isSfx) await callCore('media.cleanup-staging', { job_id: jobId });
    if (isImage) { try { fs.unlinkSync(downloadPath); } catch {} }
    return asset;
  }

  async handleFailure(jobId, error) {
    this.downloadManager.cancelJob(jobId);
    const mapped = classifyError(error);
    // Retain a downloaded SFX source when extraction fails so recovery can reuse it.
    try {
      await this.update(jobId, mapped.state, mapped.category + ': ' + String(error?.message || error).slice(0, 1200), {
        failure: { category: mapped.category, at: Date.now() / 1000 }, retry_after: 0
      });
      await callCore('media.recover', { job_id: jobId, automatic: true });
    } catch { /* Keep the durable failure if core recovery is unavailable. */ }
    return null;
  }

  async process(job) {
    const ctx = { checkpointed: false };
    try {
      if (!await this.prepareAndSubmit(job, ctx)) return null;
      if (!await this.awaitResult(ctx)) return null;
      return await this.downloadAndRegister(ctx);
    } catch (error) {
      return this.handleFailure(job.job_id, error);
    }
  }

  // --- Bulk pipeline ---------------------------------------------------------

  async admit(job) {
    const ctx = { checkpointed: false };
    try {
      if (!await this.prepareAndSubmit(job, ctx)) return;
      this.inFlight.set(job.job_id, ctx);
      this.refreshBusy();
      this.ensureMonitor();
    } catch (error) {
      if (await this.tryRelease(job, ctx, error)) return;
      await this.handleFailure(job.job_id, error);
    }
  }

  // Flow refused another concurrent generation before the paid click: put the
  // job back in the queue and run with fewer parallel slots for a while.
  async tryRelease(job, ctx, error) {
    if (!this.pipeline || ctx.checkpointed) return false;
    const text = String(error?.message || error || '');
    const capacity = /capacity_limited/i.test(text);
    const category = classifyError(error).category;
    const running = this.inFlight.size;
    if (!capacity && !(running && ['selector_failure', 'rate_limited'].includes(category))) return false;
    try {
      await callCore('media.release', { job_id: job.job_id, delay: capacity || category === 'rate_limited' ? 30 : 15, reason: text.slice(0, 300) }, { timeout: 15000 });
    } catch { return false; }
    this.backoff(capacity ? 'Flow is busy with other generations' : 'Flow did not accept another generation yet',
      category === 'rate_limited' ? 60000 : capacity ? 30000 : 15000);
    return true;
  }

  backoff(reason, ms) {
    this.adaptiveLimit = Math.max(1, Math.min(this.parallelLimit, this.inFlight.size || 1));
    this.pausedUntil = Math.max(this.pausedUntil, Date.now() + ms);
    this.pauseReason = reason;
  }

  ensureMonitor() {
    if (this.monitorRunning) return;
    this.monitorRunning = true;
    this.monitor().finally(() => {
      this.monitorRunning = false;
      if (this.waiting().length) this.ensureMonitor();
    });
  }

  assignKey(jobId, key) {
    if (!key) return;
    this.assignedKeys.delete(key);
    this.assignedKeys.set(key, jobId);
    if (this.assignedKeys.size > 2000) this.assignedKeys.delete(this.assignedKeys.keys().next().value);
  }

  otherAssignedKeys(jobId) {
    return new Set([...this.assignedKeys].filter(([, owner]) => owner !== jobId).map(([key]) => key));
  }

  waiting() {
    return [...this.inFlight.values()].filter(ctx => ctx.phase === 'generating');
  }

  async monitor() {
    while (this.waiting().length) {
      await sleep(this.monitorMs);
      try {
        await this.pollOnce();
        this.monitorErrors = 0;
      } catch (error) {
        this.monitorErrors += 1;
        if (this.monitorErrors >= MONITOR_MAX_ERRORS) {
          this.monitorErrors = 0;
          for (const ctx of this.waiting()) {
            await this.failJob(ctx, new Error('browser_failure: bulk monitor could not read Google Flow: ' + String(error?.message || error).slice(0, 600)));
          }
        }
      }
    }
  }

  finish(ctx, { success = false } = {}) {
    if (!this.inFlight.delete(ctx.jobId)) return;
    if (success && this.adaptiveLimit !== null) {
      this.adaptiveLimit += 1;
      if (this.adaptiveLimit >= this.requestedParallel) this.adaptiveLimit = null;
    }
    this.refreshBusy();
    this.onActivity();
    this.schedule(150);
  }

  async failJob(ctx, error) {
    this.finish(ctx);
    await this.handleFailure(ctx.jobId, error);
  }

  async pollOnce() {
    const waiting = this.waiting();
    if (!waiting.length) return;
    const statuses = (await callCore('media.status-many', { job_ids: waiting.map(ctx => ctx.jobId) }, { timeout: 15000 }))?.jobs || {};
    for (const ctx of waiting) {
      const status = statuses[ctx.jobId] || {};
      if (status.missing || TERMINAL.has(status.state)) { this.finish(ctx); continue; }
      if (status.cancel_requested) {
        this.downloadManager.cancelJob(ctx.jobId);
        this.finish(ctx);
        await this.update(ctx.jobId, 'cancelled', 'Cancellation requested').catch(() => {});
        continue;
      }
      if (status.provider_submission) ctx.submission = { ...ctx.submission, ...status.provider_submission };
      if (Date.now() - ctx.submittedAt > GENERATION_TIMEOUT_MS) {
        await this.failJob(ctx, new Error('generation_failure: timed out waiting for provider result'));
      }
    }
    const live = this.waiting();
    if (!live.length) return;
    const adapter = this.provider.adapter;
    if (!adapter) throw new Error('browser_failure: Google Flow view is unavailable');
    const claimedKeys = [...this.assignedKeys.keys()];
    const { page, states } = await this.ui.run(() => adapter.generationStates(
      live.map(ctx => ({ ...ctx.job, provider_submission: ctx.submission, request: ctx.job.request })),
      { claimedKeys, allowNavigation: !this.activeDownloads.size }));
    if (page.state === 'needs_user_auth') {
      await callCore('media.connection-update', { patch: { connected: false, needs_user_auth: true,
        challenged: page.reason === 'human_verification', detail: 'Google Media sign-in is required' } }).catch(() => {});
      for (const ctx of live) {
        this.finish(ctx);
        await this.update(ctx.jobId, 'needs_user_auth', page.reason).catch(() => {});
      }
      return;
    }
    if (page.state !== 'ok') return;
    if (page.rate_limited) this.backoff('Flow reported a rate limit', 60000);
    // Credits ran out for new work; accepted generations may still finish.
    if (page.credits_exhausted) this.backoff('Flow reported exhausted credits', 5 * 60 * 1000);

    for (const ctx of live) {
      const state = states.get(ctx.jobId);
      if (state?.state !== 'ready_to_download') continue;
      ctx.resultKey = state.result_key;
      this.assignKey(ctx.jobId, ctx.resultKey);
      ctx.submission = { ...ctx.submission, result_key: state.result_key };
      ctx.phase = 'ready';
      // A re-download after an attribution failure runs alone.
      const exclusive = /could not be attributed/i.test(String(ctx.job.recovery?.last_error || ''));
      ctx.fingerprint = exclusive ? null : await this.ui.run(() => adapter.resultFingerprint?.(ctx.resultKey)).catch(() => null) || null;
      const diagnostic = exclusive ? { reason: 'exclusive_redownload' } : adapter.lastFingerprint || {};
      const waitingFor = this.downloadQueue.length + this.activeDownloads.size;
      await this.update(ctx.jobId, 'downloading', waitingFor
        ? 'Result ready; waiting for a download slot (' + waitingFor + ' ahead)'
        : 'Result ready; starting download', {
        provider_submission: ctx.submission,
        processing: { fingerprint: Boolean(ctx.fingerprint), fingerprint_source: diagnostic.source || null,
          fingerprint_reason: diagnostic.reason || '' }
      }).catch(() => {});
      this.enqueueDownload(ctx);
    }
    await this.attributeFailures(page.failure_signals);
  }

  // Flow's refusal text is page-wide, not per tile. New failure signals are
  // assigned only when they account for every unresolved job that could have
  // produced them; otherwise wait until the other jobs resolve.
  async attributeFailures(signals) {
    const count = Number(signals);
    if (!Number.isFinite(count)) return;
    for (const ctx of this.waiting()) {
      if (ctx.baselineFailures === null) ctx.baselineFailures = count;
    }
    const candidates = this.waiting().filter(ctx => ctx.baselineFailures < count);
    if (!candidates.length) return;
    const fresh = count - Math.min(...candidates.map(ctx => ctx.baselineFailures));
    if (fresh < candidates.length) return;
    for (const ctx of candidates) {
      await this.failJob(ctx, new Error('policy_refusal: Google Flow refused or failed this generation'));
    }
  }

  enqueueDownload(ctx) {
    this.downloadQueue.push(ctx);
    this.pumpDownloads();
  }

  canStartDownload(ctx) {
    if (!this.activeDownloads.size) return true;
    // Without a thumbnail fingerprint a download cannot be told apart from
    // another concurrent one, so it runs alone.
    if (!ctx.fingerprint || [...this.activeDownloads].some(active => !active.fingerprint)) return false;
    return this.activeDownloads.size < DOWNLOAD_PARALLEL;
  }

  pumpDownloads() {
    while (this.downloadQueue.length && this.canStartDownload(this.downloadQueue[0])) {
      const ctx = this.downloadQueue.shift();
      ctx.phase = 'downloading';
      this.activeDownloads.add(ctx);
      this.runDownload(ctx).finally(() => {
        this.activeDownloads.delete(ctx);
        this.pumpDownloads();
      });
    }
  }

  async runDownload(ctx) {
    try {
      const asset = await this.downloadAndRegister(ctx);
      this.finish(ctx, { success: Boolean(asset?.asset_id) });
    } catch (error) {
      await this.failJob(ctx, error);
    }
  }
}

module.exports = { MediaJobConsumer, classifyError, requestSignature, DEFAULT_PARALLEL, MAX_PARALLEL, DOWNLOAD_PARALLEL };
