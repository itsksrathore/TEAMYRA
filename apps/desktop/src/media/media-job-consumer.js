const fs = require('node:fs');
const path = require('node:path');
const { callCore } = require('../core-api');
const { extractAudio } = require('./media-audio-processor');
const { convertImage, verifyMediaOutput, hammingDistance } = require('./media-output-validator');
const { mediaId } = require('./flow-reference-controller');

// Visual jobs are pipelined: each one is submitted as soon as the composer is
// free, then every in-flight generation is watched by one shared monitor.
const DEFAULT_PARALLEL = 10;
const MAX_PARALLEL = 30;
const DOWNLOAD_PARALLEL = 8;
// Concurrent downloads are attributed by thumbnail; only look-alike results
// closer than this (of 64 bits) wait for each other.
const DOWNLOAD_SEPARATION = 22;
const GENERATION_TIMEOUT_MS = 20 * 60 * 1000;
// Flow usually finishes in 1-2 minutes. Past these ages a job is searched for
// across the whole grid, and if it is still absent, failed instead of holding
// its slot for the full timeout (silent moderation returns no tile at all).
const OVERDUE_MIN_MS = 150 * 1000;
const NO_RESULT_MIN_MS = 6 * 60 * 1000;
const DEEP_SEARCH_EVERY_MS = 60 * 1000;
const MONITOR_MS = 2500;
// Upscaled downloads land within ~2 minutes (p97 105 s, max ~210 s). One that
// has not arrived by then is usually lost on Flow's side; clicking Download
// again is faster than waiting out a long timeout and full recovery.
const DOWNLOAD_WAIT_MS = 150 * 1000;
const DOWNLOAD_RETRY_WAIT_MS = 240 * 1000;
const MONITOR_MAX_ERRORS = 12;
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function classifyError(error) {
  const text = String(error?.message || error || '').toLowerCase();
  if (text.includes('human_verification') || text.includes('captcha')) return { state: 'needs_user_auth', category: 'human_verification' };
  if (text.includes('upload_terms_required')) return { state: 'needs_user_auth', category: 'upload_terms_required' };
  if (text.includes('login_required') || text.includes('sign-in') || text.includes('sign in')) return { state: 'needs_user_auth', category: 'login_required' };
  if (text.includes('rate_limited') || text.includes('rate limit') || text.includes('capacity_limited')) return { state: 'rate_limited', category: 'rate_limited' };
  // Explicit categories first: their messages mention credits/policy in passing.
  if (text.includes('result_match_failed')) return { state: 'failed', category: 'result_match_failed' };
  if (text.includes('provider_no_result')) return { state: 'failed', category: 'provider_no_result' };
  if (text.includes('credits_exhausted') || text.includes('credits')) return { state: 'failed', category: 'credits_exhausted' };
  if (text.includes('policy_refusal') || text.includes('policy')) return { state: 'failed', category: 'policy_refusal' };
  if (text.includes('browser_probe_failed')) return { state: 'failed', category: 'browser_probe_failed' };
  if (/execution context was destroyed|frame was detached|webcontents.*destroyed|err_(?:connection|internet|network|name_not_resolved|address_unreachable|timed_out)|browser_failure/.test(text)) return { state: 'failed', category: 'browser_failure' };
  // Reference attachment happens before Generate; its errors are UI failures.
  if (text.includes('selector_failure') || text.startsWith('references:') || text.includes('upload media control')) return { state: 'failed', category: 'selector_failure' };
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

function moveFile(source, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  try { fs.renameSync(source, destination); }
  catch (error) {
    if (error?.code !== 'EXDEV') throw error;
    fs.copyFileSync(source, destination);
    fs.unlinkSync(source);
  }
}

function clampParallel(value, fallback) {
  const number = Math.round(Number(value));
  return Number.isFinite(number) && number > 0 ? Math.min(MAX_PARALLEL, number) : fallback;
}

// Serializes page interaction: one composer, one menu, one info panel at a time.
// A hung page operation must not hold the page forever: after timeoutMs the
// caller gets an error and the next operation may run.
class Mutex {
  constructor(timeoutMs = 3 * 60 * 1000) { this.tail = Promise.resolve(); this.timeoutMs = timeoutMs; }
  run(fn, timeoutMs = this.timeoutMs) {
    const result = this.tail.then(() => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('browser_failure: page operation timed out after ' +
        Math.round(timeoutMs / 1000) + ' s')), timeoutMs);
      timer.unref?.();
      Promise.resolve().then(fn).then(resolve, reject).finally(() => clearTimeout(timer));
    }));
    this.tail = result.catch(() => {});
    return result;
  }
}

class MediaJobConsumer {
  constructor({ surface, workerName, provider, downloadManager, profileId = 'google', pollMs = 3500, onActivity = () => {}, maxParallel = null, monitorMs = MONITOR_MS, ready = null, lane = 0, lanes = 1, isMain = () => true, onAccountProblem = null, mayClaim = () => true, onSubmitResult = null }) {
    this.surface = surface;
    this.workerName = workerName;
    // Several Flow tabs (lanes) may work one queue; each has its own page and
    // its own Flow project per folder.
    this.lane = Math.max(0, Number(lane) || 0);
    this.lanes = Math.max(1, Number(lanes) || 1);
    this.lastRefsKey = '';
    this.laneProjects = new Map();
    this.provider = provider;
    this.downloadManager = downloadManager;
    this.profileId = String(profileId || 'google');
    // Several Google accounts may work the same queue. The main account takes
    // single jobs; an account that stops working hands its unsubmitted jobs on
    // (onAccountProblem returns true when another account can take them).
    this.isMain = isMain;
    this.onAccountProblem = onAccountProblem;
    // mayClaim: the account is enabled, signed in, unchallenged and not parked.
    // onSubmitResult(ok): tells the account whether Generate could be clicked.
    this.mayClaim = mayClaim;
    this.onSubmitResult = onSubmitResult;
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
    this.ready = ready || Promise.resolve();
    this.capabilitiesSignature = '';
    // Result tiles already given to a job in this session (bulk copies share a prompt).
    this.assignedKeys = new Map();
    // Recent submit-to-result times; they set how long a job may stay unseen.
    this.generationTimes = [];
    this.ui = new Mutex();
  }

  get parallelLimit() {
    return Math.max(1, Math.min(MAX_PARALLEL, this.adaptiveLimit ?? this.requestedParallel));
  }

  pipelineStatus() {
    const phases = {};
    for (const ctx of this.inFlight.values()) phases[ctx.phase] = (phases[ctx.phase] || 0) + 1;
    return {
      lane: this.lane,
      url: this.provider.view?.webContents?.getURL?.() || '',
      submitting: this.submitting,
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
    await this.ready;
    if (!this.pipeline) return this.serialTick();
    if (this.submitting || this.inFlight.size >= this.parallelLimit) {
      this.schedule(this.pollMs);
      return;
    }
    // Paused, parked or disabled: only finish jobs this tab already submitted
    // (reconcile and download, never a new Generate).
    const resumeOnly = Date.now() < this.pausedUntil || this.mayClaim() === false;
    const job = await callCore('media.claim', { surface: this.surface, worker: this.workerName,
      lane: this.lane, lanes: this.lanes, refs_key: this.lastRefsKey,
      profile_id: this.profileId, main: this.isMain() !== false, resume_only: resumeOnly }, { timeout: 10000 });
    if (!job) {
      this.schedule(resumeOnly ? Math.max(this.pollMs, 15000) : this.pollMs);
      return;
    }
    if (typeof job.refs_key === 'string') this.lastRefsKey = job.refs_key;
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
    // An account that may not take new work still finishes what it submitted.
    const resumeOnly = this.mayClaim() === false;
    const job = await callCore('media.claim', { surface: this.surface, worker: this.workerName,
      profile_id: this.profileId, main: this.isMain() !== false, resume_only: resumeOnly }, { timeout: 10000 });
    if (!job) {
      this.schedule(resumeOnly ? Math.max(this.pollMs, 15000) : this.pollMs);
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

  // This account cannot take new work (signed out, challenged, out of
  // credits). With another account working, the unsubmitted job goes back to
  // the queue for it instead of failing or waiting for this one.
  async handOff(job, kind, reason) {
    if (job.provider_submission?.submitted_at || job.reconcile_required) return false;
    if (!this.onAccountProblem || this.onAccountProblem(kind, reason) !== true) return false;
    try {
      await callCore('media.handoff', { job_id: job.job_id, reason: this.profileId + ': ' + reason }, { timeout: 15000 });
      return true;
    } catch { return false; }
  }

  // An account-level refusal found before Generate (upload terms not accepted)
  // is not the job's fault: another account takes the job.
  async handOffAfterError(job, ctx, error) {
    const text = String(error?.message || error || '');
    if (ctx.checkpointed) return false;
    if (/upload_terms_required/.test(text)) return this.handOff(job, 'upload_terms', 'Flow upload terms are not accepted in this account');
    if (/credits_exhausted/.test(text)) return this.handOff(job, 'credits', 'Flow credits are exhausted');
    // Generate disabled before the click, again and again, is how Flow shows
    // an account with no credits left; the account decides when that is so.
    if (/generate control (?:is unavailable or disabled|did not become ready)/i.test(text) &&
        this.onSubmitResult?.(false) === 'parked') {
      return this.handOff(job, 'credits', 'Flow keeps Generate disabled in this account (usually no credits left)');
    }
    return false;
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
      await callCore('media.connection-update', { profile_id: this.profileId, patch: { connected: false, challenged: true, needs_user_auth: true, detail: 'Google requires human verification' } });
      if (await this.handOff(job, 'challenged', 'Google requires human verification')) return null;
      await this.update(jobId, 'needs_user_auth', 'human_verification');
      return null;
    }
    if (!classified.signedIn) {
      await callCore('media.connection-update', { profile_id: this.profileId, patch: { connected: false, needs_user_auth: true, detail: 'Google Media sign-in is required' } });
      if (await this.handOff(job, 'signed_out', 'Google Media sign-in is required')) return null;
      await this.update(jobId, 'needs_user_auth', 'login_required');
      return null;
    }
    if (classified.rateLimited) {
      throw new Error('rate_limited_before_submission');
    }
    if (classified.creditsExhausted) {
      if (await this.handOff(job, 'credits', 'Flow credits are exhausted')) return null;
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
      const folder = String(job.request?.project_path || '');
      const preferred = await callCore('media.flow-project', { project_path: job.request?.project_path, lane: this.lane,
        profile_id: this.profileId }, { timeout: 15000 })
        .catch(() => null);
      // A tab of an account with no project for the folder yet creates its own
      // (also the first tab: "the most recent project" may be a sibling tab's
      // brand-new one, and two tabs in one project confuse result attribution).
      const remembered = this.laneProjects.get(folder);
      const taken = Array.isArray(preferred?.taken) ? preferred.taken : [];
      const preferredUrl = preferred?.provider_url || (remembered && !taken.includes(remembered) ? remembered : null) || null;
      const submitJob = { ...job, preferred_project_url: preferredUrl,
        // An extra tab starts its own project only when core confirmed it has none.
        create_new_project: !preferredUrl && Boolean(preferred) && (this.lane > 0 || Boolean(folder)),
        allow_navigation: !this.activeDownloads.size };
      try {
        submission = await this.ui.run(() => adapter.submit(submitJob, async pendingSubmission => {
          submission = { ...pendingSubmission, lane: this.lane, profile_id: this.profileId };
          ctx.checkpointed = true;
          await callCore('media.patch', { job_id: jobId, patch: {
            provider_submission: submission, reconcile_required: true, submission_phase: 'may_have_submitted'
          }});
        }));
      } finally {
        // Remember the tab's project even if this submission failed, so the
        // next job does not create yet another one.
        const project = String(this.provider.view?.webContents?.getURL?.() || '').match(/^(https:\/\/flow\.google\.com\/project\/[^/?#]+)/i)?.[1];
        if (project) this.laneProjects.set(folder, project);
      }
      submission = { ...submission, lane: this.lane, profile_id: this.profileId };
      this.onSubmitResult?.(true);
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
      // A reconciled job keeps its original submission time for overdue checks;
      // its watch (timeout) starts now so a resumed job is searched first.
      submittedAt: Number(submission.submitted_at) > 0 ? Math.min(Date.now(), Number(submission.submitted_at) * 1000) : Date.now(),
      watchStartedAt: Date.now(),
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
    const staging = planned.staging_dir || path.join(path.dirname(planned.path), '.staging-' + jobId);
    const downloadPath = isSfx ? planned.temporary_video_path
      : path.join(staging, isImage ? 'provider-download' : 'download' + (path.extname(planned.path) || '.mp4'));
    const downloadJob = { ...job, ...await callCore('media.status', { job_id: jobId }, { timeout: 10000 }), request };
    if (ctx.resultKey) downloadJob.provider_submission = { ...downloadJob.provider_submission, result_key: ctx.resultKey };
    const excludeKeys = this.otherAssignedKeys(jobId, await this.durableClaims());
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
          // Upscaled downloads usually land within 1-2 minutes; a stuck one is
          // re-downloaded by automatic recovery instead of blocking for 10.
          timeoutMs: waitsForUpscale ? (targetJob.downloadRetry ? DOWNLOAD_RETRY_WAIT_MS : DOWNLOAD_WAIT_MS) : 180000,
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
        if (isImage && preferFour && downloadAction?.quality === '4x' && classifyError(error).category === 'download_failure') {
          await this.update(jobId, 'downloading', '4x download failed; trying 2x upscale of the same result');
          downloaded = await attemptDownload({ ...downloadJob, request: { ...request,
            generation_settings: { ...request.generation_settings, download_quality: '2x' }
          } });
        } else if (waitsForUpscale && /timed out waiting for google media download/i.test(String(error?.message || error))) {
          await this.update(jobId, 'downloading', 'Download did not arrive; requesting it again');
          downloaded = await attemptDownload({ ...downloadJob, downloadRetry: true });
        } else {
          throw error;
        }
      }
      await callCore('media.patch', { job_id: jobId, patch: {
        download: { ...downloaded, action: downloadAction, completed: true }
      }});
    }

    let stagedPath = downloaded.path;
    if ((await callCore('media.status', { job_id: jobId })).cancel_requested) return this.update(jobId, 'cancelled', 'Cancelled after download');
    if (isImage || isSfx) stagedPath = path.join(path.dirname(downloadPath), 'output.' + planned.format);
    if (isImage) await convertImage(downloaded.path, stagedPath, planned.format);
    if (isSfx) {
      await this.update(jobId, 'extracting_audio', 'Extracting sound effect audio');
      await extractAudio(downloaded.path, stagedPath, planned.format);
    }

    const outputInfo = await verifyMediaOutput(stagedPath, request, downloadAction);
    // Verified in staging; a single move places it at the (possibly long) project path.
    const finalPath = planned.path;
    if (path.resolve(stagedPath) !== path.resolve(finalPath)) moveFile(stagedPath, finalPath);

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
    else { try { fs.unlinkSync(downloadPath); } catch {} }
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
      if (await this.handOffAfterError(job, ctx, error)) return null;
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
      if (await this.handOffAfterError(job, ctx, error)) return;
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

  otherAssignedKeys(jobId, durable = {}) {
    const owners = new Map([...Object.entries(durable), ...this.assignedKeys]);
    return new Set([...owners].filter(([, owner]) => owner !== jobId).map(([key]) => key));
  }

  // Tiles owned by jobs persisted in core (survives desktop restarts).
  async durableClaims() {
    const result = await callCore('media.claimed-keys', {}, { timeout: 15000 }).catch(() => null);
    return result?.claimed && typeof result.claimed === 'object' ? result.claimed : {};
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
      if (Date.now() - (ctx.watchStartedAt || ctx.submittedAt) > GENERATION_TIMEOUT_MS) {
        await this.failJob(ctx, new Error('generation_failure: timed out waiting for provider result'));
      }
    }
    const live = this.waiting();
    if (!live.length) return;
    const adapter = this.provider.adapter;
    if (!adapter) throw new Error('browser_failure: Google Flow view is unavailable');
    const claimedKeys = [...new Set([...this.assignedKeys.keys(), ...Object.keys(await this.durableClaims())])];
    const now = Date.now();
    const { overdueMs } = this.patience();
    const deepJobIds = live.filter(ctx => now - ctx.submittedAt > overdueMs &&
      now - (ctx.lastDeepSearch || 0) > DEEP_SEARCH_EVERY_MS).map(ctx => ctx.jobId);
    for (const ctx of live) if (deepJobIds.includes(ctx.jobId)) ctx.lastDeepSearch = now;
    const { page, states } = await this.ui.run(() => adapter.generationStates(
      live.map(ctx => ({ ...ctx.job, provider_submission: ctx.submission, request: ctx.job.request })),
      { claimedKeys, allowNavigation: !this.activeDownloads.size, deepJobIds }));
    if (page.state === 'needs_user_auth') {
      await callCore('media.connection-update', { profile_id: this.profileId, patch: { connected: false, needs_user_auth: true,
        challenged: page.reason === 'human_verification', detail: 'Google Media sign-in is required' } }).catch(() => {});
      // Submitted jobs wait for this account; new work goes to the others.
      this.onAccountProblem?.(page.reason === 'human_verification' ? 'challenged' : 'signed_out', 'Google Media sign-in is required');
      for (const ctx of live) {
        this.finish(ctx);
        await this.update(ctx.jobId, 'needs_user_auth', page.reason).catch(() => {});
      }
      return;
    }
    if (page.state !== 'ok') return;
    if (page.rate_limited) this.backoff('Flow reported a rate limit', 60000);
    // Credits ran out for new work; accepted generations may still finish.
    if (page.credits_exhausted) {
      this.backoff('Flow reported exhausted credits', 5 * 60 * 1000);
      this.onAccountProblem?.('credits', 'Flow reported exhausted credits');
    }

    for (const ctx of live) {
      const state = states.get(ctx.jobId);
      if (state?.state !== 'ready_to_download') continue;
      ctx.resultKey = state.result_key;
      this.assignKey(ctx.jobId, ctx.resultKey);
      this.generationTimes = [...this.generationTimes.slice(-49), Date.now() - ctx.submittedAt];
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
    await this.attributeRegionFailures(states);
    const { noResultMs } = this.patience();
    for (const ctx of this.waiting()) {
      const age = Date.now() - ctx.submittedAt;
      const state = states.get(ctx.jobId);
      if (!state?.searched || age < noResultMs) continue;
      // A resumed job gets at least one full search before it is given up.
      if (Date.now() - (ctx.watchStartedAt || ctx.submittedAt) < 20000) continue;
      const freshFailures = state.region && !state.region.pending_seen ? Number(ctx.regionFresh) : 0;
      if (Number.isFinite(freshFailures) && freshFailures > 0) {
        // A Failed tile appeared after this submission and no result did: the
        // deferred attribution never got to decide while other jobs ran.
        await this.failJob(ctx, new Error('policy_refusal: Google Flow marked a generation submitted with this job Failed ' +
          '(the prompt might violate its policies) and no result appeared; reword the prompt and queue a new job'));
        continue;
      }
      if (state.unmatched_results > 0) {
        // Flow did produce results; only the attribution failed. Rewording and
        // resubmitting would pay for the same output again.
        await this.failJob(ctx, new Error('result_match_failed: Flow shows ' + state.unmatched_results + ' finished ' +
          (ctx.job.request?.type || 'media') + ' result(s) newer than this submission that TEAMYRA could not match to its prompt. ' +
          'Do not resubmit (credits were already used); report it with teamyra.media_report_issue.'));
        continue;
      }
      await this.failJob(ctx, new Error('provider_no_result: Flow accepted this generation but no result appeared after ' +
        Math.round(age / 1000) + 's, and a full search of the project found none. This is usually a silent moderation refusal; reword the prompt and queue a new job.'));
    }
  }

  // Waiting limits scale with how fast Flow has been this session.
  patience() {
    const times = [...this.generationTimes].sort((a, b) => a - b);
    const typical = times.length >= 3 ? times[Math.floor(times.length * 0.75)] : 0;
    return {
      overdueMs: Math.max(OVERDUE_MIN_MS, 2 * typical),
      noResultMs: Math.min(GENERATION_TIMEOUT_MS - 60000, Math.max(NO_RESULT_MIN_MS, 4 * typical))
    };
  }

  // Failed tiles carry no identity. Each job only counts failed tiles above the
  // newest tile at its submission (minus those already there), so failures that
  // scroll into view later never land on new jobs; jobs whose own in-progress
  // tile is visible are excluded. Jobs sharing a region use the deferred rule.
  async attributeRegionFailures(states) {
    const groups = new Map();
    for (const ctx of this.waiting()) {
      const region = states.get(ctx.jobId)?.region;
      if (!region || region.pending_seen) continue;
      const baseline = Number(ctx.submission?.baseline_failed_above);
      ctx.regionBaseline = Number.isFinite(baseline) ? baseline : (ctx.regionBaseline ?? region.failed);
      ctx.regionFresh = region.failed - ctx.regionBaseline;
      if (!groups.has(region.top)) groups.set(region.top, { count: region.failed, jobs: [] });
      groups.get(region.top).jobs.push(ctx);
    }
    for (const group of groups.values()) {
      const candidates = group.jobs.filter(ctx => ctx.regionBaseline < group.count);
      if (!candidates.length) continue;
      const fresh = group.count - Math.min(...candidates.map(ctx => ctx.regionBaseline));
      if (fresh < candidates.length) continue;
      for (const ctx of candidates) {
        await this.failJob(ctx, new Error('policy_refusal: Google Flow marked this generation Failed (the prompt might violate its policies or third-party content rules); reword the prompt and queue a new job'));
      }
    }
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
      await this.failJob(ctx, new Error('policy_refusal: Google Flow marked this generation Failed (the prompt might violate its policies); reword the prompt and queue a new job'));
    }
  }

  enqueueDownload(ctx) {
    this.downloadQueue.push(ctx);
    this.pumpDownloads();
  }

  canStartDownload(ctx) {
    if (!this.activeDownloads.size) return true;
    if (this.activeDownloads.size >= DOWNLOAD_PARALLEL) return false;
    // Without a thumbnail fingerprint a download cannot be told apart from
    // another concurrent one, so it runs alone. Look-alike results (e.g. shots
    // of one battlefield) also wait, so every overlapping download stays
    // clearly attributable by content.
    if (!ctx.fingerprint) return false;
    return [...this.activeDownloads].every(active => active.fingerprint &&
      hammingDistance(active.fingerprint, ctx.fingerprint) >= DOWNLOAD_SEPARATION);
  }

  pumpDownloads() {
    for (;;) {
      // Oldest first, but a look-alike waiting its turn does not block others.
      const index = this.downloadQueue.findIndex(ctx => this.canStartDownload(ctx));
      if (index < 0) return;
      const [ctx] = this.downloadQueue.splice(index, 1);
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

module.exports = { MediaJobConsumer, classifyError, requestSignature, DEFAULT_PARALLEL, MAX_PARALLEL, DOWNLOAD_PARALLEL, DOWNLOAD_SEPARATION };
