const fs = require('node:fs');
const { callCore } = require('../core-api');
const { extractAudio } = require('./media-audio-processor');

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
  constructor({ surface, workerName, provider, downloadManager, profileId = 'google', pollMs = 1500 }) {
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

  start() {
    if (this.running) return;
    this.running = true;
    this.timer = setInterval(() => this.tick().catch(() => {}), this.pollMs);
    this.timer.unref?.();
    setImmediate(() => this.tick().catch(() => {}));
  }

  stop() {
    this.running = false;
    clearInterval(this.timer);
    this.timer = null;
  }

  async tick() {
    if (!this.running || this.busy) return;
    const job = await callCore('media.claim', { surface: this.surface, worker: this.workerName }, { timeout: 10000 });
    if (!job) return;
    this.busy = true;
    this.currentJobId = job.job_id;
    try { await this.process(job); }
    finally { this.currentJobId = null; this.busy = false; }
  }

  async update(jobId, state, detail, extra) {
    return callCore('media.update-state', { job_id: jobId, state, detail, extra }, { timeout: 15000 });
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
      const probe = await adapter.probe();
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

      const capabilities = await adapter.capabilities();
      await callCore('media.patch', { job_id: jobId, patch: { capabilities } });
      planned = await callCore('media.prepare-output', { job_id: jobId });

      let submission = job.provider_submission || {};
      const submittedBeforeClaim = Boolean(submission.submitted_at);
      const shouldReconcile = job.reconcile_required === true && submittedBeforeClaim;

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
        submission = await adapter.submit(job);
        await callCore('media.patch', { job_id: jobId, patch: {
          provider: this.surface === 'music' ? 'google-flow-music' : 'google-flow',
          provider_submission: submission
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
        state = await adapter.generationState({ provider_submission: status.provider_submission || submission });
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
      const downloadPath = isSfx ? planned.temporary_video_path : planned.path;
      await this.update(jobId, 'downloading', 'Downloading generated media');
      const downloadPromise = this.downloadManager.expect({
        jobId,
        webContentsId: this.provider.view.webContents.id,
        destination: downloadPath,
        timeoutMs: 180000
      });
      await adapter.startDownload();
      const downloaded = await downloadPromise;

      let finalPath = downloaded.path;
      if (isSfx) {
        await this.update(jobId, 'extracting_audio', 'Extracting sound effect audio');
        await extractAudio(downloaded.path, planned.path, planned.format);
        finalPath = planned.path;
        try { fs.unlinkSync(downloaded.path); } catch {}
      }

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
        metadata: { mime: downloaded.mime || '', bytes: fs.statSync(finalPath).size, google_profile_id: this.profileId }
      }, { timeout: 20000 });
      if (isSfx) await callCore('media.cleanup-staging', { job_id: jobId });
      return asset;
    } catch (error) {
      const mapped = classifyError(error);
      if (planned?.temporary_video_path) {
        try { fs.unlinkSync(planned.temporary_video_path); } catch {}
        await callCore('media.cleanup-staging', { job_id: jobId }).catch(() => {});
      }
      await this.update(jobId, mapped.state, mapped.category + ': ' + String(error?.message || error).slice(0, 1200)).catch(() => {});
      return null;
    }
  }
}

module.exports = { MediaJobConsumer, classifyError };
