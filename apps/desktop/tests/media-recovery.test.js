const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { execFileSync } = require('node:child_process');
const { createRequire } = require('node:module');
const { GoogleFlowAutomationAdapter } = require('../src/media/google-flow-automation-adapter');
const { GoogleFlowMusicAutomationAdapter } = require('../src/media/google-flow-music-automation-adapter');
const { MediaDownloadManager } = require('../src/media/media-download-manager');
const { resolveFfmpeg, extractAudio } = require('../src/media/media-audio-processor');
const { verifyMediaOutput, convertImage } = require('../src/media/media-output-validator');
const { MediaBrowserController } = require('../src/media/media-browser-controller');

async function main() {
  const lifecycle = [];
  let attached = false;
  const browser = new MediaBrowserController({ debugger: {
    isAttached: () => attached,
    attach: () => { attached = true; },
    detach: () => { lifecycle.push('detach'); attached = false; },
    sendCommand: async (_name, args) => lifecycle.push(args.enabled)
  } });
  await assert.rejects(browser.withActivePage(async () => { throw new Error('provider error'); }), /provider error/);
  assert.deepEqual(lifecycle, [true, false, 'detach'], 'page lifecycle and debugger ownership are restored after failure');
  let persisted = false;
  let generateClicks = 0;
  const ambiguousFlow = new GoogleFlowAutomationAdapter({ executeJavaScript: async script => {
    if (script.includes('button.click()')) {
      assert.equal(persisted, true, 'submission identity is durable before clicking');
      generateClicks++;
      throw new Error('execution context was destroyed');
    }
    return '[data-teamyra-generate-target="test"]';
  } });
  ambiguousFlow.generationSnapshot = async () => ({ generateDisabled: false, promptText: 'test' });
  await assert.rejects(ambiguousFlow.startGenerationVerified(async () => { persisted = true; }), /execution context/);
  assert.equal(generateClicks, 1, 'transient navigation after Generate never retries the paid action');
  const multiline = new GoogleFlowAutomationAdapter({ getURL: () => 'https://flow.google.com/project/test' });
  let editorText = '';
  multiline.ensureWorkspace = async () => ({});
  multiline.waitForSettingsTrigger = async () => 'Settings trigger';
  multiline.selectIntent = async () => ({ actual_model: 'Omni 1.1 Flash' });
  multiline.uploadReferences = async () => {};
  multiline.waitForPrompt = async () => '#prompt';
  multiline.settingsTriggerText = async () => 'Video 360p x1';
  multiline.resultSnapshot = async () => [];
  multiline.executePageScript = async script => script.includes('flow-loading-page') ? false : editorText;
  multiline.browser.clickSelector = async () => true;
  multiline.browser.clearText = async () => { editorText = ''; };
  multiline.browser.insertText = async (_selector, text) => { editorText = text.replace(/\n/g, '\n\n'); };
  multiline.startGenerationVerified = async checkpoint => { await checkpoint({ mediaCount: 0 }); return { before: { mediaCount: 0 } }; };
  const multilineSubmission = await multiline.submitToWorkspace({ request: { type: 'sound_effect', prompt: 'One clap\nNo music.\nNo vocals.' } }, async () => {});
  assert.equal(multilineSubmission.actual_model, 'Omni 1.1 Flash', 'provider paragraph spacing preserves the full checked prompt');

  // Exercise the worker at its core boundary: every failure must leave durable
  // state, and an uncertain acknowledged click may only reconcile on restart.
  const consumerSource = fs.readFileSync(path.join(__dirname, '../src/media/media-job-consumer.js'), 'utf8');
  const consumerRequire = createRequire(path.join(__dirname, '../src/media/media-job-consumer.js'));
  async function workerFailure(kind, priorSubmission = null) {
    const record = { job_id: 'failure-test', request: { type: kind === 'image-fallback' ? 'image' : 'video', prompt: 'test' }, provider_submission: priorSubmission || {} };
    const calls = [];
    const core = async (name, args) => {
      calls.push({ name, args });
      if (name === 'media.status') return { ...record };
      if (name === 'media.patch') Object.assign(record, args.patch);
      if (name === 'media.update-state') record.state = args.state;
      if (name === 'media.prepare-output') return { path: 'unused.mp4', format: 'mp4' };
      return {};
    };
    const module = { exports: {} };
    vm.runInNewContext(consumerSource, { module, require: name => name === '../core-api' ? { callCore: core } : consumerRequire(name), setTimeout, clearTimeout, console });
    let submissions = 0;
    let reconciliations = 0;
    const downloads = [];
    const adapter = {
      probe: async () => ({ buttonLabels: kind === 'auth' ? ['Sign in'] : [] }),
      classifyProbe: () => ({ signedIn: kind !== 'auth', creditsExhausted: kind === 'credits', rateLimited: kind === 'rate' }),
      capabilities: async () => ({}),
      submit: async (_job, checkpoint) => {
        submissions++;
        if (kind === 'selector') throw new Error('selector_failure: missing Generate');
        await checkpoint({ submitted_at: 1, provider_url: 'https://flow.google.com/project/test' });
        if (kind === 'uncertain') throw new Error('generation_failure: acknowledgement uncertain');
        return record.provider_submission;
      },
      reconcile: async () => { reconciliations++; return { reconciled: true }; },
      generationState: async () => kind === 'restart' ? { state: 'failed', reason: 'selector_failure' } : { state: 'ready_to_download' },
      startDownload: async job => {
        downloads.push(job.request.generation_settings?.download_quality || 'default');
        return { quality: kind === 'image-fallback' ? (downloads.length === 1 ? '4x' : '2x') : '1080p' };
      }
    };
    const consumer = new module.exports.MediaJobConsumer({ surface: 'visual', provider: { ensureLoaded: async () => {}, adapter, view: { webContents: { id: 7 } } }, downloadManager: { expect: () => Promise.reject(new Error('download_failure: interrupted')), cancelJob() {} } });
    await consumer.process(record);
    return { record, submissions, reconciliations, calls, downloads };
  }
  for (const [kind, state] of [['auth', 'needs_user_auth'], ['credits', 'failed'], ['rate', 'rate_limited']]) {
    const run = await workerFailure(kind);
    assert.equal(run.record.state, state);
    assert.equal(run.submissions, 0);
  }
  assert.equal((await workerFailure('selector')).record.state, 'failed');
  assert.equal((await workerFailure('download')).record.state, 'failed');
  const fallback = await workerFailure('image-fallback');
  assert.deepEqual(fallback.downloads, ['default', '2x']);
  assert.equal(fallback.submissions, 1, 'upscale fallback never submits another generation');
  const uncertain = await workerFailure('uncertain');
  assert.equal(uncertain.record.provider_submission.submitted_at, 1);
  const restarted = await workerFailure('restart', uncertain.record.provider_submission);
  assert.equal(restarted.submissions, 0);
  assert.equal(restarted.reconciliations, 1);

  const flow = new GoogleFlowAutomationAdapter({});
  const activations = [];
  flow.openDownloadChoices = async () => [{ text: '1K Original size' }, { text: '2K Upscaled' }, { text: '4K Upscaled' }];
  flow.resultForJob = async () => ({ key: 'new-result' });
  flow.clickDownloadChoice = async choices => { activations.push(choices[0]); return true; };
  assert.equal((await flow.startDownload({ request: { type: 'image' } })).quality, '4x');
  assert.deepEqual(activations, ['4K Upscaled']);
  flow.openDownloadChoices = async () => [{ text: '1K Original size' }, { text: '2K Upscaled' }];
  assert.equal((await flow.startDownload({ request: { type: 'image' } })).quality, '2x');
  flow.openDownloadChoices = async () => [{ text: '1K Original size' }];
  await assert.rejects(flow.startDownload({ request: { type: 'image' } }), /quality is unavailable/);
  flow.openDownloadChoices = async () => [{ text: '360p Original size' }, { text: '1080p Upscaled' }];
  assert.equal((await flow.startDownload({ request: { type: 'video' } })).quality, '1080p');
  assert.equal((await flow.startDownload({ request: { type: 'sound_effect' } })).upscale, false);
  assert.equal(activations.at(-1), '360p Original size');

  const identity = new GoogleFlowAutomationAdapter({});
  identity.resultSnapshot = async () => [
    { key: 'old', type: 'image', ready: true },
    { key: 'pending', type: 'video', ready: false },
    { key: 'fresh', type: 'video', ready: true }
  ];
  identity.resultInfo = async () => ({ prompt: 'own prompt' });
  assert.equal((await identity.resultForJob({ request: { type: 'video', prompt: 'own prompt' }, provider_submission: { baseline_result_keys: ['old'] } })).key, 'fresh');
  assert.equal(await identity.resultForJob({ request: { type: 'video', prompt: 'another prompt' }, provider_submission: { baseline_result_keys: ['old'] } }), null);
  assert.equal(await identity.resultForJob({ request: { type: 'image' }, provider_submission: { baseline_result_keys: ['old'] } }), null);
  const scriptFlow = new GoogleFlowAutomationAdapter({});
  const compiledFlow = new GoogleFlowAutomationAdapter({ executeJavaScript: async script => { new vm.Script(script); return []; } });
  await compiledFlow.resultSnapshot();
  await compiledFlow.downloadChoices();
  await compiledFlow.resultInfo('saved-result');
  scriptFlow.executePageScript = async script => {
    new vm.Script(script);
    return vm.runInNewContext(script, {
      document: { querySelectorAll: () => [{ getBoundingClientRect: () => ({ width: 10, height: 10 }), getAttribute: () => '', innerText: 'Image' }] },
      getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' })
    });
  };
  assert.equal(await scriptFlow.settingsPanelIsOpen(), true, 'word boundaries survive page-script interpolation');
  scriptFlow.openSettingsPanel = async () => ({ opened: true });
  scriptFlow.executePageScript = async script => { new vm.Script(script); return script.includes('const lines') ? { lines: [], controls: [] } : ''; };
  await scriptFlow.settingsOptions();

  const music = new GoogleFlowMusicAutomationAdapter({});
  await assert.rejects(music.submit({ operation: 'music_remix', request: { type: 'music' } }), /transform is unsupported/);
  const submitted = { provider_submission: { baseline_result_labels: ['More options for Old'] } };
  assert.equal(music.newResultLabel({ url: 'https://www.flowmusic.app/', resultLabels: ['More options for Public song'] }, submitted), null);
  assert.equal(music.newResultLabel({ url: 'https://www.flowmusic.app/session/123', resultLabels: ['More options for Old', 'More options for New'] }, submitted), 'More options for New');
  assert.equal(music.newResultLabel({ url: 'https://www.flowmusic.app/session/new', resultEntries: [
    { key: '/song/old', label: 'More options for Untitled' }, { key: '/song/new', label: 'More options for Untitled' }
  ] }, { provider_submission: { baseline_result_labels: ['More options for Untitled'], baseline_result_keys: ['/song/old'] } }), 'More options for Untitled', 'stable song ids disambiguate duplicate titles');
  music.probe = async () => ({ url: 'https://www.flowmusic.app/session/123', labels: ['Download video'], resultLabels: [] });
  await assert.rejects(music.startDownload({ ...submitted, request: { type: 'music' } }), /no new result/);
  assert.deepEqual(await music.reconcile({ provider_submission: { provider_url: 'https://www.flowmusic.app/' } }), { reconciled: false, reason: 'provider_session_identity_missing' });

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'teamyra-media-check-'));
  try {
    const manager = new MediaDownloadManager({ setDownloadHandler() {} });
    const item = new EventEmitter();
    item.cancel = () => { item.cancelled = true; };
    item.setSavePath = target => { item.destination = target; };
    item.getMimeType = () => 'image/png';
    const file = path.join(temp, 'image.png');
    const expected = manager.expect({ jobId: 'j', webContentsId: 7, destination: file, timeoutMs: 500 });
    manager.handleDownload({}, item, { id: 7 });
    assert.equal(manager.active.size, 1);
    fs.writeFileSync(file, 'data');
    item.emit('done', {}, 'completed');
    assert.equal((await expected).bytes, 4);
    assert.equal(manager.active.size, 0);
    const stalled = new EventEmitter();
    stalled.setSavePath = () => {};
    stalled.cancel = () => { stalled.cancelled = true; };
    const timeout = manager.expect({ jobId: 'stalled', webContentsId: 7, destination: file, timeoutMs: 30 });
    const rejected = assert.rejects(timeout, /download completion/);
    manager.handleDownload({}, stalled, { id: 7 });
    await new Promise(resolve => setTimeout(resolve, 60));
    await rejected;
    assert.equal(stalled.cancelled, true);
    const cancelled = manager.expect({ jobId: 'cancel', webContentsId: 7, destination: file });
    const cancellation = assert.rejects(cancelled, /cancelled/);
    manager.cancelJob('cancel');
    await cancellation;
    const unrelated = { cancel() { this.cancelled = true; } };
    manager.handleDownload({}, unrelated, { id: 99 });
    assert.equal(unrelated.cancelled, true);

    const ffmpeg = resolveFfmpeg();
    execFileSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'color=c=blue:s=160x90', '-frames:v', '1', file], { windowsHide: true, stdio: 'ignore' });
    assert.equal((await verifyMediaOutput(file, { type: 'image', aspect_ratio: '16:9' }, { quality: 'source' })).width, 160);
    await assert.rejects(verifyMediaOutput(file, { type: 'image', aspect_ratio: '1:1' }, { quality: 'source' }), /aspect ratio/);
    await assert.rejects(verifyMediaOutput(file, { type: 'image' }, { quality: '4x' }), /upscale size/);
    const jpeg = path.join(temp, 'provider-download');
    execFileSync(ffmpeg, ['-y', '-i', file, '-frames:v', '1', '-c:v', 'mjpeg', '-f', 'image2', jpeg], { windowsHide: true, stdio: 'ignore' });
    await convertImage(jpeg, file, 'png');
    assert.equal(fs.readFileSync(file).subarray(1, 4).toString(), 'PNG', 'JPEG provider bytes are converted to the requested PNG format');
    assert.equal((await verifyMediaOutput(file, { type: 'image', aspect_ratio: '16:9' })).width, 160);
    const video = path.join(temp, 'source.mp4');
    const audio = path.join(temp, 'effect.wav');
    execFileSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'color=s=160x90:d=0.1', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.1', '-shortest', video], { windowsHide: true, stdio: 'ignore' });
    await assert.rejects(verifyMediaOutput(video, { type: 'video' }, { quality: '1080p' }), /1080p/);
    await assert.rejects(verifyMediaOutput(video, { type: 'music' }), /audio-only/);
    await extractAudio(video, audio, 'wav');
    const verified = await verifyMediaOutput(audio, { type: 'sound_effect' });
    assert.equal(verified.audio, true);
    assert.equal(verified.video, false);
    const coverAudio = path.join(temp, 'covered.mp3');
    execFileSync(ffmpeg, ['-y', '-i', audio, '-i', file, '-map', '0:a', '-map', '1:v', '-c:a', 'libmp3lame', '-c:v', 'copy', '-disposition:v', 'attached_pic', coverAudio], { windowsHide: true, stdio: 'ignore' });
    const withCover = await verifyMediaOutput(coverAudio, { type: 'music' });
    assert.equal(withCover.video, false);
    assert.equal(withCover.cover_art, true);
  } finally {
    assert.ok(path.resolve(temp).startsWith(path.join(os.tmpdir(), 'teamyra-media-check-')));
    fs.rmSync(temp, { recursive: true, force: true });
  }
  console.log('media download, identity, recovery and FFmpeg verification tests passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
