const fs = require('node:fs');
const { callCore } = require('../core-api');
const { extractAudio } = require('./media-audio-processor');
const { convertImage, verifyMediaOutput } = require('./media-output-validator');

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function classifyError(error) {
  const text = String(error?.message || error || '').toLowerCase();
  if (text.includes('human_verification') || text.includes('captcha')) return { state: 'needs_user_auth', category: 'human_verification' };
  if (text.includes('login_required') || text.includes('sign-in') || text.includes('sign in')) return { state: 'needs_user_auth', category: 'login_required' };
  if (text.includes('rate_limited') || text.includes('rate limit')) return { state: 'rate_limited', category: 'rate_limited' };
  if (text.includes('credits_exhausted') || text.includes('credits')) return { state: 'failed', category: 'credits_exhausted' };
  if (text.includes('policy_refusal') || text.includes('policy')) return { state: 'failed', category: 'policy_refusal' };
  if (text.includes('selector_failure')) return { state: 'failed', category: 'selector_failure' };
  if (text.includes('download')) return { state: 'failed', category: 'download_failure' };
  if (text.includes('ffmpeg') || text.includes('audio')) return { state: 'failed', category: 'audio_extraction_failure' };
  return { state: 'failed', category: 'generation_failure' };
}

class MediaJobConsumer {
  constructor({ surface, workerName, provider, downloadManager, profileId = 'google', pollMs = 3500 }) {
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
  }

  schedule(delayMs = this.pollMs) {
    if (!this.running) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.tick().catch(() => {
      this.schedule(Math.max(this.pollMs, 5000));
    }), Math.max(250, Number(delayMs) || this.pollMs));
    this.timer.unref?.();
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.schedule(100);
  }

  stop() {
    this.running = false;
    clearTimeout(this.timer);
    this.timer = null;
  }

  async tick() {
    if (!this.running) return;
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
    try { await this.process(job); }
    finally {
      this.currentJobId = null;
      this.busy = false;
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

  async process(job) {
    const jobId = job.job_id;
    let planned = null;
    try {
      const current = await callCore('media.status', { job_id: jobId }, { timeout: 10000 });
      if (current.cancel_requested) return this.update(jobId, 'cancelled', 'Cancelled before browser execution');
      await this.update(jobId, 'waiting_for_browser', 'Preparing Google media browser worker');
      await this.provider.ensureLoaded();
      const adapter = this.provider.adapter;
      const probe = await this.stableProbe(adapter);
      const classified = adapter.classifyProbe(probe);
      if (classified.challenged) {
        await callCore('media.connection-update', { patch: { connected: false, challenged: true, needs_user_auth: true, detail: 'Google requires human verification' } });
        return this.update(jobId, 'needs_user_auth', 'human_verification');
      }
      if (!classified.signedIn) {
        await callCore('media.connection-update', { patch: { connected: false, needs_user_auth: true, detail: 'Google Media sign-in is required' } });
        return this.update(jobId, 'needs_user_auth', 'login_required');
      }
      if (classified.rateLimited) {
        return this.update(jobId, 'rate_limited', 'rate_limited_before_submission', {
          retry_after: Date.now() / 1000 + 60
        });
      }
      if (classified.creditsExhausted) return this.update(jobId, 'failed', 'credits_exhausted_before_submission');

      const capabilities = await adapter.capabilities(probe);
      await callCore('media.patch', { job_id: jobId, patch: { capabilities } });
      planned = await callCore('media.prepare-output', { job_id: jobId });

      let submission = job.provider_submission || {};
      const submittedBeforeClaim = Boolean(submission.submitted_at);
      const shouldReconcile = submittedBeforeClaim;

      if (job.reconcile_required && !submittedBeforeClaim) {
        throw new Error('generation_failure: possible submission lacks provider identity; manual reconciliation required');
      }

      if (shouldReconcile) {
        const reconciled = await adapter.reconcile(job);
        if (!reconciled?.reconciled) {
          throw new Error('generation_failure: provider reconciliation could not identify the submitted job');
        }
        await callCore('media.reconcile', {
          job_id: jobId,
          provider_submission: submission,
          resume_state: 'generating'
        }, { timeout: 15000 });
      } else {
        await this.update(jobId, 'submitting', 'Submitting generation request');
        submission = await adapter.submit(job, async pendingSubmission => {
          submission = pendingSubmission;
          await callCore('media.patch', { job_id: jobId, patch: {
            provider_submission: pendingSubmission, reconcile_required: true
          }});
        });
        await callCore('media.patch', { job_id: jobId, patch: {
          provider: this.surface === 'music' ? 'google-flow-music' : 'google-flow',
          provider_submission: submission, reconcile_required: false
        }});
        await this.update(jobId, 'generating', 'Provider generation is in progress');
      }

      const deadline = Date.now() + 20 * 60 * 1000;
      let state;
      while (Date.now() < deadline) {
        const status = await callCore('media.status', { job_id: jobId }, { timeout: 10000 });
        if (status.cancel_requested) {
          this.downloadManager.cancelJob(jobId);
          return this.update(jobId, 'cancelled', 'Cancellation requested');
        }
        state = await adapter.generationState({ ...job, ...status, request: job.request });
        if (state.result_key) {
          submission = { ...status.provider_submission, result_key: state.result_key };
          await callCore('media.patch', { job_id: jobId, patch: { provider_submission: submission } });
        }
        if (state.state === 'ready_to_download') break;
        if (state.state === 'rate_limited') {
          return this.update(jobId, 'rate_limited', state.reason, {
            retry_after: Date.now() / 1000 + 60,
            reconcile_required: true
          });
        }
        if (state.state === 'needs_user_auth' || state.state === 'failed') {
          return this.update(jobId, state.state, state.reason);
        }
        await sleep(2500);
      }
      if (state?.state !== 'ready_to_download') throw new Error('generation_failure: timed out waiting for provider result');

      const request = job.request;
      const isSfx = request.type === 'sound_effect';
      const isImage = request.type === 'image';
      const downloadPath = isSfx ? planned.temporary_video_path : isImage ? planned.path + '.provider-download' : planned.path;
      const downloadJob = { ...job, ...await callCore('media.status', { job_id: jobId }, { timeout: 10000 }), request };
      if (downloadJob.cancel_requested) return this.update(jobId, 'cancelled', 'Cancelled before download');
      await this.update(jobId, 'downloading', 'Downloading generated media');
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
            timeoutMs: waitsForUpscale ? 600000 : 180000
          });
          // Observe rejection immediately while the adapter waits on an upscale.
          downloadPromise.catch(() => {});
          try {
            downloadAction = await adapter.startDownload(targetJob);
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
        provider_asset_id: providerSubmission.provider_asset_id,
        provider_project_id: providerSubmission.provider_project_id,
        provider_url: providerSubmission.provider_url,
        generation_settings: request.generation_settings || {},
        metadata: { mime: isImage ? 'image/' + (['jpg', 'jpeg'].includes(planned.format) ? 'jpeg' : planned.format) : isSfx ? (planned.format === 'wav' ? 'audio/wav' : 'audio/' + planned.format) : downloaded.mime || '', bytes: fs.statSync(finalPath).size, google_profile_id: this.profileId, download_action: downloadAction || null, verified_output: outputInfo, selected_settings: providerSubmission.selected_settings || null, actual_model: providerSubmission.actual_model || null }
      }, { timeout: 20000 });
      if (isSfx) await callCore('media.cleanup-staging', { job_id: jobId });
      if (isImage) { try { fs.unlinkSync(downloadPath); } catch {} }
      return asset;
    } catch (error) {
      this.downloadManager.cancelJob(jobId);
      const mapped = classifyError(error);
      // Retain a downloaded SFX source when extraction fails so recovery can reuse it.
      await this.update(jobId, mapped.state, mapped.category + ': ' + String(error?.message || error).slice(0, 1200)).catch(() => {});
      return null;
    }
  }
}

module.exports = { MediaJobConsumer, classifyError };
