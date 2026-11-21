const fs = require('node:fs');
const path = require('node:path');
const { callCore } = require('../core-api');
const { verifyMediaOutput, convertImage } = require('./media-output-validator');
const { GoogleGeminiAdapter, detectLimit, cooldownSeconds, isRefusal, sniffMedia } = require('./google-gemini-adapter');
const { geminiChatUrl, GEMINI_HOME } = require('./google-gemini-provider');
const { retryCoreUpdate, isCoreTimeout } = require('./media-job-consumer');

// Google Gemini worker for one hidden Gemini tab of one signed-in Google Media
// account (its existing session; no sign-in of its own). It claims jobs of
// surface "gemini" from the shared queue one at a time: a new chat, the chosen
// model, mode and tool, uploaded references, the prompt; then it waits for the
// answer and saves the generated image/video, or the whole answer as Markdown.
// A usage-limit message rests this account's Gemini and hands the job to
// another account. A chat sent before a restart is reopened by its URL.
const POLL_MS = 3000;
const TIMEOUTS_MS = {
  none: 15 * 60 * 1000, canvas: 20 * 60 * 1000, image: 10 * 60 * 1000, video: 20 * 60 * 1000,
  deep_research: 90 * 60 * 1000, other: 20 * 60 * 1000
};
// An answer must stay unchanged this long before it counts as finished.
const SETTLE_MS = 4000;
const MIN_BYTES = { image: 1024, video: 16 * 1024 };

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
  for (const name of ['login_required', 'option_unavailable', 'reference_attach_failed', 'selector_failure', 'browser_failure',
    'download_failure', 'policy_refusal', 'provider_no_result', 'rate_limited', 'core_timeout']) {
    if (value.includes(name)) return name;
  }
  return /sign-in|not signed in/i.test(value) ? 'login_required' : 'generation_failure';
}

class GeminiJobConsumer {
  constructor({ workerName, provider, profileId = 'google', lane = 0, lanes = 1, ready = null, onActivity = () => {},
    isMain = () => true, mayClaim = () => true, pollMs = POLL_MS, settleMs = SETTLE_MS, timeouts = TIMEOUTS_MS,
    core = callCore, verify = verifyMediaOutput, convert = convertImage, fetchUrl = null, downloadManager = null }) {
    this.workerName = workerName;
    this.provider = provider;
    this.profileId = String(profileId || 'google');
    this.lane = lane;
    this.lanes = lanes;
    this.ready = ready || Promise.resolve();
    this.onActivity = onActivity;
    this.isMain = isMain;
    this.mayClaim = mayClaim;
    this.pollMs = pollMs;
    this.settleMs = settleMs;
    this.timeouts = timeouts;
    this.core = core;
    this.verify = verify;
    this.convert = convert;
    this.downloadManager = downloadManager;
    this.fetchUrl = fetchUrl || (url => this.provider.sessionManager.getSession().fetch(url));
    this.running = false;
    this.busy = false;
    this.current = null;
    this.timer = null;
  }

  status() {
    return { lane: this.lane, url: this.provider.view?.webContents?.getURL?.() || '', busy: this.busy,
      job_id: this.current?.job_id || null, step: this.provider.adapter?.step || null };
  }

  schedule(delay = this.pollMs) {
    if (!this.running) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.tick().catch(() => this.schedule(Math.max(this.pollMs, 5000))), Math.max(100, delay));
    this.timer.unref?.();
  }

  start() { if (!this.running) { this.running = true; this.schedule(400); } }
  stop() { this.running = false; clearTimeout(this.timer); this.timer = null; }

  update(jobId, state, detail, extra) {
    return retryCoreUpdate(() => this.core('media.update-state', { job_id: jobId, state, detail, extra }, { timeout: 30000 }));
  }

  markBusy(value) {
    this.busy = value;
    // Keeps the hidden desktop awake while Gemini works (main.js watches this).
    if (value) globalThis.__teamyraVidsActiveAt = globalThis.__teamyraGeminiActiveAt = Date.now();
  }

  async tick() {
    if (!this.running || this.busy) return;
    await this.ready;
    const resumeOnly = this.mayClaim() === false;
    const job = await this.core('media.claim', { surface: 'gemini', worker: this.workerName, lane: this.lane, lanes: this.lanes,
      profile_id: this.profileId, main: this.isMain() !== false, resume_only: resumeOnly }, { timeout: 10000 });
    if (!job) return this.schedule(resumeOnly ? Math.max(this.pollMs, 15000) : this.pollMs);
    this.current = job;
    this.markBusy(true);
    this.onActivity();
    try { await this.run(job); }
    finally {
      this.current = null;
      this.markBusy(false);
      this.onActivity();
      this.schedule(500);
    }
  }

  async adapter() {
    await this.provider.ensureView();
    if (!this.provider.adapter || this.provider.adapter.webContents !== this.provider.view.webContents) {
      this.provider.adapter = new GoogleGeminiAdapter(this.provider.view.webContents);
    }
    return this.provider.adapter;
  }

  async run(job) {
    const jobId = job.job_id;
    let sent = Boolean(job.provider_submission?.submitted_at);
    try {
      const status = await this.core('media.status', { job_id: jobId }, { timeout: 10000 });
      if (status.cancel_requested) return this.update(jobId, 'cancelled', 'Cancelled before browser execution');
      const planned = await this.core('media.prepare-output', { job_id: jobId });
      const request = job.request || {};
      let submission = job.provider_submission || {};
      const adapter = await this.adapter();
      if (sent) {
        // Sent before a restart: reopen the same chat in the same account.
        const url = geminiChatUrl(submission.provider_url);
        if (!url) throw new Error('generation_failure: the Gemini chat of this job has no saved address; queue it again');
        await this.update(jobId, 'generating', 'Reopening the Gemini chat sent before the restart');
        await this.provider.load(url);
        await adapter.ready();
        await this.core('media.reconcile', { job_id: jobId, provider_submission: submission, resume_state: 'generating' }).catch(() => {});
      } else {
        await this.update(jobId, 'waiting_for_browser', 'Opening Google Gemini');
        await this.provider.load(GEMINI_HOME);
        await adapter.ready();
        await this.update(jobId, 'submitting', 'Preparing the Gemini chat');
        const files = (job.resolved_references || []).map(item => item.path).filter(Boolean);
        const model = await adapter.chooseModel(request.gemini_model || 'Auto');
        await adapter.chooseThinking(request.gemini_thinking || 'high');
        const mode = await adapter.chooseMode(request.gemini_mode || 'chat');
        const tool = await adapter.chooseTool(request.gemini_tool || 'none');
        await adapter.attach(files);
        let prompt = request.provider_prompt || request.prompt;
        if (request.aspect_ratio && ['image', 'video'].includes(request.type)) prompt += '\n\nAspect ratio: ' + request.aspect_ratio + '.';
        await adapter.typePrompt(prompt);
        // From here a crash may leave a sent prompt: recovery reconciles, never resends blindly.
        await this.core('media.patch', { job_id: jobId, patch: { submission_phase: 'sending' } });
        const before = await adapter.send();
        sent = true;
        const chatUrl = await adapter.wait(async () => geminiChatUrl(this.provider.view.webContents.getURL()), 'chat address', 60000, 500)
          .catch(() => this.provider.view.webContents.getURL());
        submission = { submitted_at: Date.now() / 1000, provider_url: chatUrl, engine: 'google-gemini', profile_id: this.profileId,
          lane: this.lane, responses_before: before, model: model?.model || request.gemini_model, model_description: model?.description || null,
          mode, tool: tool?.tool || null, tool_confirmed: tool ? tool.confirmed : null, references: files.length };
        await this.core('media.patch', { job_id: jobId, patch: {
          provider: 'google-gemini', provider_submission: submission, reconcile_required: false, submission_phase: 'submitted' } });
        await this.update(jobId, 'generating', 'Gemini is answering' + (tool?.tool ? ' (' + tool.tool + ')' : ''));
      }
      const answer = await this.awaitAnswer(job, adapter, submission);
      if (!answer) return;
      await this.save(job, adapter, planned, submission, answer);
    } catch (error) {
      const text = String(error?.message || error);
      if (!sent && isCoreTimeout(error)) return this.fail(jobId, error, 'core_timeout');
      const step = this.provider.adapter?.step;
      await this.fail(jobId, /timed out/.test(text) && step && !text.includes('step:') ? new Error(text + ' (step: ' + step + ')') : error);
    }
  }

  // Wait for a finished answer; null when the job was handed off or cancelled.
  async awaitAnswer(job, adapter, submission) {
    const jobId = job.job_id;
    const tool = job.request?.gemini_tool || 'none';
    const limitMs = this.timeouts[tool] || this.timeouts.other;
    const started = Date.now();
    let lastText = null;
    let stableSince = 0;
    let researchStarted = false;
    let lastStatusAt = 0;
    while (Date.now() - started < limitMs) {
      if (Date.now() - lastStatusAt > 15000) {
        lastStatusAt = Date.now();
        const status = await this.core('media.status-many', { job_ids: [jobId] }, { timeout: 15000 }).catch(() => null);
        if (status?.jobs?.[jobId]?.cancel_requested) {
          await this.update(jobId, 'cancelled', 'Cancellation requested').catch(() => {});
          return null;
        }
      }
      const state = await adapter.state().catch(() => null);
      const response = await adapter.lastResponse().catch(() => null);
      if (state?.signedOut) throw new Error('login_required: this Google account was signed out of Gemini');
      const fresh = response && response.count > (submission.responses_before ?? 0) ? response : null;
      // A limit notice, or a short answer that is only a limit message (a long
      // answer may merely talk about limits).
      const limit = detectLimit(state?.notices) || (fresh?.done && String(fresh.text || '').length < 700 && detectLimit(fresh.text));
      if (limit && !(fresh?.media?.length)) {
        await this.handOff(job, limit);
        return null;
      }
      if (fresh?.startResearch && !researchStarted && tool === 'deep_research') {
        // Deep Research shows its plan first; start it once.
        researchStarted = await adapter.startResearch().catch(() => false);
        if (researchStarted) await this.update(jobId, 'generating', 'Gemini Deep Research is running').catch(() => {});
      }
      const researching = tool === 'deep_research' && (fresh?.startResearch || (researchStarted && !fresh?.immersive && !fresh?.media?.length &&
        Date.now() - started < 3 * 60 * 1000));
      if (fresh?.done && !researching) {
        const wantsMedia = tool === 'image' || tool === 'video';
        const key = fresh.text + '|' + (fresh.media || []).map(item => item.src).join(',');
        if (key !== lastText) { lastText = key; stableSince = Date.now(); }
        const mediaReady = !wantsMedia || (fresh.media || []).some(item => item.kind === tool);
        if (Date.now() - stableSince >= this.settleMs && (mediaReady || Date.now() - stableSince >= Math.max(this.settleMs, 20000))) return fresh;
      } else {
        lastText = null;
      }
      await sleep(this.pollMs);
    }
    throw new Error('generation_failure: Gemini did not finish the answer within ' + Math.round(limitMs / 60000) + ' minutes (timed out); ' +
      'media_recover reopens the same chat');
  }

  async handOff(job, limitText) {
    const tool = job.request?.gemini_tool || 'none';
    await this.core('media.gemini-limit', { job_id: job.job_id, profile_id: this.profileId,
      seconds: cooldownSeconds(limitText), reason: limitText, scope: tool === 'none' ? 'all' : tool }, { timeout: 20000 });
  }

  async save(job, adapter, planned, submission, answer) {
    const jobId = job.job_id;
    const request = job.request || {};
    const tool = request.gemini_tool || 'none';
    const common = { engine: 'google-gemini', gemini_model: submission.model || request.gemini_model,
      gemini_mode: submission.mode || request.gemini_mode, gemini_tool: tool, google_profile_id: this.profileId,
      tab: this.lane + 1, batch_id: job.batch_id || null, chat_url: submission.provider_url || null,
      links: (answer.links || []).slice(0, 100), doc_links: (answer.links || []).filter(link => /docs\.google\.com/.test(link)).slice(0, 20) };
    if (request.type === 'image' || request.type === 'video') {
      const item = (answer.media || []).find(entry => entry.kind === request.type);
      if (!item) {
        const excerpt = String(answer.text || '').replace(/\s+/g, ' ').slice(0, 600);
        throw new Error((isRefusal(answer.text) ? 'policy_refusal: ' : 'provider_no_result: ') +
          'Gemini answered without ' + (request.type === 'image' ? 'an image' : 'a video') + (excerpt ? ': ' + excerpt : ''));
      }
      await this.update(jobId, 'downloading', 'Saving the Gemini ' + request.type);
      const staging = planned.staging_dir || path.join(path.dirname(planned.path), '.staging-' + jobId);
      fs.mkdirSync(staging, { recursive: true });
      const { buffer, via } = await this.fetchMedia(adapter, item, staging, request.type, answer.downloads > 0);
      const kind = sniffMedia(buffer);
      if (!kind || kind.kind !== request.type) {
        throw new Error('download_failure: the Gemini ' + request.type + ' download is not a ' + request.type + ' file (' + (kind?.ext || 'unknown type') + ')');
      }
      if (buffer.length < MIN_BYTES[request.type]) throw new Error('download_failure: the Gemini ' + request.type + ' download is only ' + buffer.length + ' bytes');
      const raw = path.join(staging, 'download.' + kind.ext);
      fs.writeFileSync(raw, buffer);
      const wanted = String(planned.format || path.extname(planned.path).slice(1) || kind.ext).toLowerCase();
      const same = wanted === kind.ext || (wanted === 'jpeg' && kind.ext === 'jpg');
      let file = raw;
      if (!same) {
        if (request.type !== 'image') throw new Error('download_failure: Gemini made a ' + kind.ext + ' video; request format ' + kind.ext);
        file = path.join(staging, 'converted.' + wanted);
        await this.convert(raw, file, wanted);
      }
      // Gemini picks the pixels; the aspect ratio was asked for in the prompt.
      const info = await this.verify(file, { ...request, aspect_ratio: null }, { quality: 'source' });
      moveFile(file, planned.path);
      await this.update(jobId, 'organizing', 'Registering generated asset');
      await this.core('media.register-asset', {
        job_id: jobId, local_path: planned.path, provider: 'google-gemini', provider_asset_id: null,
        provider_project_id: submission.provider_url?.match(/\/app\/([^/?#]+)/)?.[1] || null, provider_url: submission.provider_url,
        generation_settings: request.generation_settings || {},
        metadata: { ...common, verified_output: info, source_type: kind.ext, downloaded_via: via, bytes: fs.statSync(planned.path).size,
          answer_text: String(answer.text || '').slice(0, 2000) }
      }, { timeout: 20000 });
      try { fs.rmSync(staging, { recursive: true, force: true }); } catch {}
      return;
    }
    // Text: the whole answer (or the Deep Research / Canvas document) as Markdown.
    await this.update(jobId, 'downloading', 'Saving the Gemini answer');
    let markdown = '';
    if (tool !== 'none' && answer.immersive) markdown = await adapter.markdown({ immersive: true }).catch(() => '');
    const chat = await adapter.markdown({ immersive: false }).catch(() => '');
    if (!markdown.trim()) markdown = chat;
    else if (chat.trim() && !markdown.includes(chat.trim().slice(0, 200))) markdown = markdown.trimEnd() + '\n\n---\n\n' + chat;
    if (!markdown.trim()) markdown = String(answer.text || '').trim() + '\n';
    if (!markdown.trim()) throw new Error('provider_no_result: Gemini returned an empty answer');
    if (String(planned.format || '').toLowerCase() === 'txt') markdown = String(answer.text || markdown).trim() + '\n';
    const header = String(planned.format || 'md').toLowerCase() === 'md'
      ? '<!-- Google Gemini · ' + [common.gemini_model, common.gemini_mode, tool !== 'none' ? tool : null].filter(Boolean).join(' · ') +
        (common.chat_url ? ' · ' + common.chat_url : '') + ' -->\n\n' : '';
    fs.mkdirSync(path.dirname(planned.path), { recursive: true });
    const temp = planned.path + '.part';
    fs.writeFileSync(temp, header + markdown, 'utf8');
    moveFile(temp, planned.path);
    await this.update(jobId, 'organizing', 'Registering generated document');
    await this.core('media.register-asset', {
      job_id: jobId, local_path: planned.path, provider: 'google-gemini', provider_asset_id: null,
      provider_project_id: submission.provider_url?.match(/\/app\/([^/?#]+)/)?.[1] || null, provider_url: submission.provider_url,
      generation_settings: request.generation_settings || {},
      metadata: { ...common, chars: markdown.length, mime: planned.format === 'txt' ? 'text/plain' : 'text/markdown',
        bytes: fs.statSync(planned.path).size, document_panel: Boolean(answer.immersive) }
    }, { timeout: 20000 });
  }

  // The generated file: the page's own download control (full size), else the
  // element's URL fetched in the account's session (or inside the page).
  async fetchMedia(adapter, item, staging, type, hasButton = false) {
    const manager = this.downloadManager;
    if (hasButton && manager && this.provider.view?.webContents?.id) {
      const target = path.join(staging, 'page-download');
      const tag = 'gemini-' + this.profileId + '-' + this.lane + '-' + Date.now();
      const waiting = manager.expect({ jobId: tag, webContentsId: this.provider.view.webContents.id,
        destination: target, timeoutMs: type === 'video' ? 180000 : 90000 });
      waiting.catch(() => {});
      const clicked = await adapter.clickDownload(0).catch(() => false);
      if (clicked) {
        try {
          const done = await waiting;
          return { buffer: fs.readFileSync(done.path), via: 'download_button' };
        } catch { /* fall back to the element URL */ }
      } else if (Array.isArray(manager.expected)) {
        // Nothing will arrive: drop the wait so a later download is not taken for it.
        for (const record of manager.expected.filter(entry => entry.jobId === tag)) clearTimeout(record.timer);
        manager.expected = manager.expected.filter(entry => entry.jobId !== tag);
      }
    }
    if (/^https:/.test(item.src)) {
      const response = await this.fetchUrl(item.src);
      if (response.ok) return { buffer: Buffer.from(await response.arrayBuffer()), via: 'session_fetch' };
    }
    const read = await adapter.readMedia(item.src).catch(error => ({ ok: false, error: String(error?.message || error) }));
    if (!read?.ok) throw new Error('download_failure: could not read the Gemini ' + type + ' (' + (read?.status || read?.error || 'no response') + ')');
    return { buffer: Buffer.from(read.base64, 'base64'), via: 'page_fetch' };
  }

  async fail(jobId, error, kind = null) {
    const text = String(error?.message || error || 'generation_failure');
    const name = kind || category(text);
    const state = name === 'login_required' ? 'needs_user_auth' : 'failed';
    await this.update(jobId, state, name + ': ' + text.replace(/^\w+: /, '').slice(0, 1200), {
      failure: { category: name, at: Date.now() / 1000, profile_id: this.profileId }, retry_after: 0 }).catch(() => {});
  }
}

module.exports = { GeminiJobConsumer, TIMEOUTS_MS, category };
