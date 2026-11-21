const fs = require('node:fs');
const path = require('node:path');
const { callCore } = require('../core-api');
const { verifyMediaOutput } = require('./media-output-validator');
const { SunoAdapter, detectLimit, cooldownSeconds, isRefusal, isDone, isFailed } = require('./suno-adapter');
const { sniffAudio, analyzeAudio, transcribe } = require('./suno-audio');
const { SUNO_HOME, songUrl } = require('./suno-provider');
const { retryCoreUpdate, isCoreTimeout } = require('./media-job-consumer');

// The Suno worker of one account (its hidden tab). It claims surface "suno"
// jobs one at a time:
// - generate: fill the Create page by option names, click Create, follow the
//   two new clips until Suno finishes them, then save each clip's PREVIEW from
//   the audio the page streams for playback (its own service-worker stream,
//   read inside the page; no Download click, no download credit), check it
//   with FFmpeg and register both as preview assets;
// - download (suno_download): open the clip's song page and use Suno's own
//   Download (MP3/WAV) - this uses the account's download allowance - then
//   verify and register the final asset linked to its preview.
// Suno's credit / download-limit / rate-limit messages rest the account and
// hand the job back to the queue (another account for a generation).
const POLL_MS = 2000;
const GENERATION_TIMEOUT_MS = 15 * 60 * 1000;
const STATUS_FALLBACK_MS = 20 * 1000;
const IDLE_STOP_MS = 10 * 60 * 1000;
const MIN_PREVIEW_BYTES = 8 * 1024;

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function moveFile(source, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  try { fs.renameSync(source, destination); }
  catch (error) {
    if (error?.code !== 'EXDEV') throw error;
    fs.copyFileSync(source, destination);
    fs.unlinkSync(source);
  }
}

function category(text) {
  const value = String(text || '');
  for (const name of ['login_required', 'option_unavailable', 'selector_failure', 'browser_failure', 'download_failure',
    'policy_refusal', 'provider_no_result', 'rate_limited', 'core_timeout', 'generation_failure']) {
    if (value.includes(name)) return name;
  }
  return /sign-in|not signed in/i.test(value) ? 'login_required' : 'generation_failure';
}

class SunoJobConsumer {
  constructor({ workerName, provider, profileId = 'suno', downloads = null, onActivity = () => {}, onSignedIn = () => {},
    mayClaim = () => true, pollMs = POLL_MS, generationTimeoutMs = GENERATION_TIMEOUT_MS, statusFallbackMs = STATUS_FALLBACK_MS,
    idleStopMs = IDLE_STOP_MS, core = callCore, verify = verifyMediaOutput, analyze = analyzeAudio, transcriber = transcribe,
    adapterFactory = webContents => new SunoAdapter(webContents) }) {
    this.workerName = workerName;
    this.provider = provider;
    this.profileId = String(profileId || 'suno');
    this.downloads = downloads;
    this.onActivity = onActivity;
    this.onSignedIn = onSignedIn;
    this.mayClaim = mayClaim;
    this.pollMs = pollMs;
    this.generationTimeoutMs = generationTimeoutMs;
    this.statusFallbackMs = statusFallbackMs;
    this.idleStopMs = idleStopMs;
    this.core = core;
    this.verify = verify;
    this.analyze = analyze;
    this.transcriber = transcriber;
    this.adapterFactory = adapterFactory;
    this.running = false;
    this.busy = false;
    this.current = null;
    this.timer = null;
    this.lastWorkAt = Date.now();
  }

  status() {
    return { busy: this.busy, running: this.running, job_id: this.current?.job_id || null, step: this.provider.adapter?.step || null,
      url: this.provider.view?.webContents?.getURL?.() || '' };
  }

  schedule(delay = this.pollMs) {
    if (!this.running) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.tick().catch(() => this.schedule(Math.max(this.pollMs, 5000))), Math.max(100, delay));
    this.timer.unref?.();
  }

  start() { this.lastWorkAt = Date.now(); if (!this.running) { this.running = true; this.schedule(400); } }
  stop() { this.running = false; clearTimeout(this.timer); this.timer = null; }

  update(jobId, state, detail, extra) {
    return retryCoreUpdate(() => this.core('media.update-state', { job_id: jobId, state, detail, extra }, { timeout: 30000 }));
  }

  markBusy(value) {
    this.busy = value;
    if (value) globalThis.__teamyraSunoActiveAt = globalThis.__teamyraVidsActiveAt = Date.now();
  }

  async tick() {
    if (!this.running || this.busy) return;
    const resumeOnly = this.mayClaim() === false;
    const job = await this.core('media.claim', { surface: 'suno', worker: this.workerName, lane: 0, lanes: 1,
      profile_id: this.profileId, main: this.profileId === 'suno', resume_only: resumeOnly }, { timeout: 10000 });
    if (!job) {
      // Idle a while: stop asking (the core may sleep); the next wake starts it again.
      if (Date.now() - this.lastWorkAt > this.idleStopMs) return this.stop();
      return this.schedule(resumeOnly ? Math.max(this.pollMs, 15000) : this.pollMs);
    }
    this.current = job;
    this.lastWorkAt = Date.now();
    this.markBusy(true);
    this.onActivity();
    try { await this.run(job); }
    finally {
      this.current = null;
      this.lastWorkAt = Date.now();
      this.markBusy(false);
      this.onActivity();
      this.schedule(500);
    }
  }

  async adapter() {
    await this.provider.ensureView();
    if (!this.provider.adapter || this.provider.adapter.webContents !== this.provider.view.webContents) {
      this.provider.adapter = this.adapterFactory(this.provider.view.webContents);
    }
    // Idempotent: an adapter made for a sign-in check may not watch the network yet.
    await this.provider.adapter.startCapture?.().catch(() => null);
    return this.provider.adapter;
  }

  async cancelled(jobId) {
    const status = await this.core('media.status-many', { job_ids: [jobId] }, { timeout: 15000 }).catch(() => null);
    return status?.jobs?.[jobId]?.cancel_requested === true;
  }

  async run(job) {
    const jobId = job.job_id;
    const request = job.request || {};
    const download = request.suno_action === 'download';
    let sent = Boolean(job.provider_submission?.submitted_at);
    try {
      const status = await this.core('media.status', { job_id: jobId }, { timeout: 10000 });
      if (status.cancel_requested) return this.update(jobId, 'cancelled', 'Cancelled before browser execution');
      if (download) return await this.runDownload(job);
      const adapter = await this.adapter();
      let submission = job.provider_submission || {};
      if (!sent) {
        await this.update(jobId, 'waiting_for_browser', 'Opening Suno');
        await this.provider.load(SUNO_HOME);
        await adapter.ready({ path: '/create' }).catch(async error => {
          if (/login_required/.test(String(error?.message))) this.onSignedIn(false, error.message);
          throw error;
        });
        this.onSignedIn(true);
        const before = await adapter.state();
        const early = detectLimit(before.notices, 'generate');
        if (early) return this.handOff(job, early);
        await this.update(jobId, 'submitting', 'Filling the Suno Create page');
        const applied = await adapter.fill(request);
        const known = await adapter.clipIds().catch(() => []);
        // From here a crash may leave a created song: recovery never clicks Create blindly.
        await this.core('media.patch', { job_id: jobId, patch: { submission_phase: 'sending' } });
        await adapter.clickCreate();
        sent = true;
        const created = await adapter.newClips(known, { action: 'generate', title: request.suno_title || '' });
        if (!created.ids.length) {
          if (created.limit) return this.handOff(job, created.limit);
          if (created.refusal) throw new Error('policy_refusal: Suno refused the request: ' + created.refusal);
          throw new Error('provider_no_result: Suno showed no new song after Create (step: new clips)');
        }
        submission = { submitted_at: Date.now() / 1000, profile_id: this.profileId, lane: 0, engine: 'suno', clip_ids: created.ids,
          provider_url: songUrl(created.ids[0]), clips_found_via: created.via, applied, model: applied.model || null };
        await this.core('media.patch', { job_id: jobId, patch: {
          provider: 'suno', provider_submission: submission, reconcile_required: false, submission_phase: 'submitted' } });
        await this.update(jobId, 'generating', 'Suno is making ' + created.ids.length + ' clip(s): ' + created.ids.join(', '));
      } else {
        await this.update(jobId, 'generating', 'Following the Suno clips created before the restart');
        await this.core('media.reconcile', { job_id: jobId, provider_submission: submission, resume_state: 'generating' }).catch(() => {});
      }
      const clips = await this.awaitClips(job, adapter, submission.clip_ids || []);
      if (!clips) return;
      await this.savePreviews(job, adapter, submission, clips);
    } catch (error) {
      const text = String(error?.message || error);
      if (!sent && isCoreTimeout(error)) return this.fail(jobId, error, 'core_timeout');
      // Signed out before anything was created: another signed-in account takes it.
      const onlyHere = (request.accounts || []).length > 0 && request.accounts.every(id => id === this.profileId);
      if (!sent && !download && /login_required/.test(text) && !onlyHere) {
        const released = await this.core('media.release', { job_id: jobId, delay: 5,
          reason: 'Suno account ' + this.profileId + ' is not signed in' }, { timeout: 20000 }).then(() => true).catch(() => false);
        if (released) return null;
      }
      await this.fail(jobId, error);
    }
  }

  async handOff(job, limit) {
    const action = job.request?.suno_action === 'download' ? 'download' : 'generate';
    await this.core('media.suno-limit', { job_id: job.job_id, profile_id: this.profileId, seconds: cooldownSeconds(limit.text),
      reason: limit.text, scope: limit.scope === 'action' ? action : (limit.scope || action) }, { timeout: 20000 });
    return null;
  }

  // Follow the clips until Suno finishes them. Status comes from the page's own
  // API responses; when none arrive, from each clip's song page.
  async awaitClips(job, adapter, ids) {
    const jobId = job.job_id;
    if (!ids.length) throw new Error('generation_failure: this Suno job has no clip ids to follow');
    const started = Date.now();
    let lastCheck = 0;
    let lastFallback = Date.now();
    while (Date.now() - started < this.generationTimeoutMs) {
      if (Date.now() - lastCheck > 15000) {
        lastCheck = Date.now();
        if (await this.cancelled(jobId)) {
          await this.update(jobId, 'cancelled', 'Cancellation requested (Suno may still finish the clips in the account)').catch(() => {});
          return null;
        }
      }
      let summaries = ids.map(id => adapter.clips.get(id) || null);
      if (summaries.some(item => !isDone(item) && !isFailed(item)) && Date.now() - lastFallback >= this.statusFallbackMs) {
        lastFallback = Date.now();
        for (const id of ids.filter((id, index) => !isDone(summaries[index]) && !isFailed(summaries[index]))) {
          await this.provider.load(songUrl(id));
          await adapter.embedded([id]);
        }
        summaries = ids.map(id => adapter.clips.get(id) || null);
      }
      if (summaries.every(item => isDone(item) || isFailed(item))) {
        if (summaries.every(isFailed)) {
          const reason = summaries.map(item => item.error).filter(Boolean).join('; ');
          throw new Error((isRefusal(reason) ? 'policy_refusal: ' : 'generation_failure: ') + 'Suno failed both clips' + (reason ? ': ' + reason : ''));
        }
        return summaries;
      }
      const state = await adapter.state().catch(() => null);
      if (state?.signedOut) throw new Error('login_required: this Suno account was signed out');
      await sleep(this.pollMs);
    }
    throw new Error('generation_failure: Suno did not finish the clips within ' + Math.round(this.generationTimeoutMs / 60000) +
      ' minutes (timed out); media_recover follows the same clips again');
  }

  async savePreviews(job, adapter, submission, summaries) {
    const jobId = job.job_id;
    const request = job.request || {};
    await this.update(jobId, 'downloading', 'Saving the Suno previews from the page\'s playback stream (no download credit)');
    const done = summaries.filter(isDone);
    const failed = summaries.filter(isFailed).map(item => ({ clip_id: item.clip_id, error: item.error || item.status }));
    const staging = path.join(require('node:os').tmpdir(), 'teamyra-suno-' + jobId);
    fs.mkdirSync(staging, { recursive: true });
    const captured = [];
    try {
      for (const summary of done) {
        // The song page carries the clip's full data and its play button.
        await this.provider.load(songUrl(summary.clip_id));
        const embedded = (await adapter.embedded([summary.clip_id]))[summary.clip_id] || {};
        const clip = { ...summary, ...Object.fromEntries(Object.entries(embedded).filter(([, value]) => value !== null && !(Array.isArray(value) && !value.length))) };
        const stream = await adapter.captureStream(clip);
        const buffer = Buffer.from(stream.base64, 'base64');
        const kind = sniffAudio(buffer);
        if (!kind) throw new Error('download_failure: the Suno playback stream of clip ' + clip.clip_id + ' is not audio (' + buffer.subarray(0, 8).toString('hex') + ')');
        if (buffer.length < MIN_PREVIEW_BYTES) throw new Error('download_failure: the Suno playback stream of clip ' + clip.clip_id + ' is only ' + buffer.length + ' bytes');
        const raw = path.join(staging, clip.clip_id + '.' + kind.ext);
        fs.writeFileSync(raw, buffer);
        captured.push({ clip, stream, kind, raw });
      }
      if (!captured.length) throw new Error('generation_failure: Suno finished no clip: ' + failed.map(item => item.error).join('; '));
      const { paths } = await this.core('media.suno-preview-paths', { job_id: jobId,
        clips: captured.map(item => ({ clip_id: item.clip.clip_id, title: item.clip.title, ext: item.kind.ext })) }, { timeout: 20000 });
      const register = [];
      for (const item of captured) {
        const destination = paths[item.clip.clip_id];
        moveFile(item.raw, destination);
        await this.verify(destination, { type: 'music' }, { quality: 'source' });
        const report = await this.analyze(destination);
        const hints = [...report.hints];
        if (item.clip.duration && report.duration && report.duration < item.clip.duration - 2) {
          hints.push('partial_preview: the stream holds ' + report.duration + ' s of the ' + item.clip.duration + ' s song');
        }
        if (item.stream.muffle_after) hints.push('muffled_after_' + item.stream.muffle_after + 's: the page streamed this clip muffled after ' + item.stream.muffle_after + ' s');
        if (!request.instrumental && item.clip.instrumental) hints.push('instrumental_mismatch: vocals were asked for but Suno marked the clip instrumental');
        if (request.instrumental && item.clip.instrumental === false && item.clip.lyrics) hints.push('vocals_mismatch: an instrumental was asked for but the clip has lyrics');
        const transcript = await this.transcriber(destination).catch(error => ({ available: true, error: String(error?.message || error) }));
        register.push({
          clip_id: item.clip.clip_id, local_path: destination, title: item.clip.title, provider_url: songUrl(item.clip.clip_id),
          metadata: {
            engine: 'suno', suno_profile_id: this.profileId, batch_id: job.batch_id || null,
            title: item.clip.title, status: item.clip.status, duration: report.duration, suno_duration: item.clip.duration,
            lyrics: item.clip.lyrics, style: item.clip.style, display_tags: item.clip.display_tags, model: item.clip.model,
            model_name: item.clip.model_name, instrumental: item.clip.instrumental, negative_tags: item.clip.negative_tags,
            control_sliders: item.clip.control_sliders, image_url: item.clip.image_url, created_at: item.clip.created_at,
            applied_options: submission.applied || null,
            preview_source: { via: item.stream.via, manifest_source: item.stream.manifest_source || null, segments: item.stream.segments || null,
              playlist_duration: item.stream.playlist_duration || null, complete_playlist: item.stream.endlist ?? null,
              muffle_after: item.stream.muffle_after ?? null, content_type: (item.clip.media_urls || [])[0]?.content_type || null,
              container: item.kind.container, no_download_credit: true },
            bitrate_kbps: report.bitrate_kbps, codec: report.codec, sample_rate: report.sample_rate, channels: report.channels,
            bytes: fs.statSync(destination).size,
            verification: { mean_volume_db: report.mean_volume_db, max_volume_db: report.max_volume_db, silences: report.silences,
              silence_seconds: report.silence_seconds, silence_threshold_db: report.silence_threshold_db, hints },
            transcript: transcript?.text || null, transcript_model: transcript?.text ? transcript.model : null,
            transcript_note: transcript?.available === false ? 'no local whisper found' : transcript?.error || null,
            other_clips_failed: failed.length ? failed : undefined
          }
        });
      }
      await this.update(jobId, 'organizing', 'Registering ' + register.length + ' Suno preview(s)');
      await this.core('media.suno-register-previews', { job_id: jobId, clips: register }, { timeout: 30000 });
    } finally {
      try { fs.rmSync(staging, { recursive: true, force: true }); } catch {}
    }
  }

  async runDownload(job) {
    const jobId = job.job_id;
    const request = job.request || {};
    const format = String(request.format || 'mp3').toLowerCase();
    const clipId = request.suno_clip_id;
    const adapter = await this.adapter();
    const planned = await this.core('media.prepare-output', { job_id: jobId });
    await this.update(jobId, 'waiting_for_browser', 'Opening the Suno song ' + clipId);
    await this.provider.load(songUrl(clipId));
    await adapter.ready({ path: '/song/' }).catch(error => {
      if (/login_required/.test(String(error?.message))) this.onSignedIn(false, error.message);
      throw error;
    });
    this.onSignedIn(true);
    const embedded = (await adapter.embedded([clipId]))[clipId] || {};
    const staging = planned.staging_dir || path.join(path.dirname(planned.path), '.staging-' + jobId);
    fs.mkdirSync(staging, { recursive: true });
    const target = path.join(staging, 'download.' + format);
    if (!this.downloads || !this.provider.webContentsId) throw new Error('browser_failure: the Suno download handler is not ready');
    const arriving = this.downloads.expect({ webContentsId: this.provider.webContentsId, destination: target,
      timeoutMs: format === 'wav' ? 360000 : 150000 });
    arriving.catch(() => {});
    await this.update(jobId, 'downloading', 'Using Suno\'s own Download (' + format.toUpperCase() + '); this uses the account\'s download allowance');
    await this.core('media.patch', { job_id: jobId, patch: { submission_phase: 'sending' } });
    // Nothing will arrive: drop the wait so a later download is not taken for it.
    const drop = () => (this.downloads.expected || []).filter(item => item.destination === path.resolve(target)).forEach(item => item.cancel?.());
    let clicked;
    try { clicked = await adapter.clickDownload(format); }
    catch (error) { drop(); throw error; }
    if (clicked.limit) {
      drop();
      return this.handOff(job, { ...clicked.limit, scope: 'download' });
    }
    await this.core('media.patch', { job_id: jobId, patch: { provider: 'suno', submission_phase: 'submitted', provider_submission: {
      submitted_at: Date.now() / 1000, profile_id: this.profileId, lane: 0, engine: 'suno', clip_ids: [clipId],
      provider_url: songUrl(clipId), download_format: format } } });
    let file;
    if (format === 'wav') {
      // A WAV is prepared first; then its dialog offers the file.
      const confirm = adapter.confirmPreparedDownload(300000).catch(() => false);
      file = await Promise.race([arriving, confirm.then(async result => {
        if (result && result.limit) return { limit: result.limit };
        return arriving;
      })]);
      if (file && file.limit) { drop(); return this.handOff(job, { ...file.limit, scope: 'download' }); }
    } else {
      file = await arriving;
    }
    const buffer = fs.readFileSync(file.path);
    const kind = sniffAudio(buffer.subarray(0, 64));
    if (!kind || kind.ext !== format) {
      throw new Error('download_failure: the Suno ' + format.toUpperCase() + ' download is ' + (kind ? 'a ' + kind.ext + ' file' : 'not audio'));
    }
    await this.verify(file.path, { type: 'music' }, { quality: 'source' });
    const report = await this.analyze(file.path);
    moveFile(file.path, planned.path);
    await this.update(jobId, 'organizing', 'Registering the downloaded Suno song');
    const preview = (job.parent_asset_ids || [])[0] || null;
    await this.core('media.register-asset', {
      job_id: jobId, local_path: planned.path, provider: 'suno', provider_asset_id: clipId, provider_project_id: null,
      provider_url: songUrl(clipId), generation_settings: request.generation_settings || {},
      metadata: { engine: 'suno', official_download: true, download_format: format, suno_clip_id: clipId, suno_profile_id: this.profileId,
        preview_asset_id: preview, title: embedded.title || request.suno_title || null, style: embedded.style || null, model: embedded.model || null,
        lyrics: embedded.lyrics || null, duration: report.duration, suno_duration: embedded.duration || null, bitrate_kbps: report.bitrate_kbps,
        codec: report.codec, sample_rate: report.sample_rate, channels: report.channels, bytes: fs.statSync(planned.path).size,
        downloaded_filename: file.filename || null,
        verification: { mean_volume_db: report.mean_volume_db, max_volume_db: report.max_volume_db, silence_seconds: report.silence_seconds, hints: report.hints } }
    }, { timeout: 20000 });
    try { fs.rmSync(staging, { recursive: true, force: true }); } catch {}
    return null;
  }

  async fail(jobId, error, kind = null) {
    const text = String(error?.message || error || 'generation_failure');
    const name = kind || category(text);
    const state = name === 'login_required' ? 'needs_user_auth' : 'failed';
    await this.update(jobId, state, name + ': ' + text.replace(/^\w+: /, '').slice(0, 1200), {
      failure: { category: name, at: Date.now() / 1000, profile_id: this.profileId }, retry_after: 0 }).catch(() => {});
  }
}

module.exports = { SunoJobConsumer, category };
