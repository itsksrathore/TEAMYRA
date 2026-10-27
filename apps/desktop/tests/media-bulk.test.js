const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
const { MediaDownloadManager } = require('../src/media/media-download-manager');
const { GoogleFlowAutomationAdapter, failureSignalCount, capacitySignal, promptSimilarity } = require('../src/media/google-flow-automation-adapter');
const { hammingDistance } = require('../src/media/media-output-validator');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(condition, label, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await sleep(10);
  }
  throw new Error('timed out waiting for ' + label);
}

function fakeItem() {
  const item = new EventEmitter();
  item.setSavePath = target => { item.savePath = target; };
  item.cancel = () => { item.cancelled = true; };
  item.getMimeType = () => 'video/mp4';
  item.getURL = () => 'blob:https://flow.google.com/' + Math.random().toString(16).slice(2);
  return item;
}

const HASH = { A: '0000000000000000', B: 'ffffffffffffffff', C: '00000000ffffffff' };
const DISTINCT = ['0000000000000000', 'ffffffffffffffff', '00000000ffffffff', 'ffffffff00000000', '0f0f0f0f0f0f0f0f', 'f0f0f0f0f0f0f0f0'];

async function downloadManagerTests(temp) {
  // Content decides ownership when two downloads are in flight.
  const fingerprint = file => [HASH[fs.readFileSync(file, 'utf8')]].filter(Boolean);
  const manager = new MediaDownloadManager({ setDownloadHandler() {} }, { fingerprint });
  const destA = path.join(temp, 'a.mp4');
  const destB = path.join(temp, 'b.mp4');
  const a = manager.expect({ jobId: 'a', webContentsId: 1, destination: destA, fingerprint: HASH.A, signature: 'a' });
  const b = manager.expect({ jobId: 'b', webContentsId: 1, destination: destB, fingerprint: HASH.B, signature: 'b' });
  const first = fakeItem();
  const second = fakeItem();
  manager.handleDownload({}, first, { id: 1 });
  manager.handleDownload({}, second, { id: 1 });
  assert.notEqual(first.savePath, destA, 'ambiguous downloads land in a neutral path first');
  fs.writeFileSync(first.savePath, 'B');
  fs.writeFileSync(second.savePath, 'A');
  first.emit('done', {}, 'completed');
  second.emit('done', {}, 'completed');
  const [gotA, gotB] = await Promise.all([a, b]);
  assert.equal(fs.readFileSync(gotA.path, 'utf8'), 'A', 'reversed completion order still reaches the right job');
  assert.equal(fs.readFileSync(gotB.path, 'utf8'), 'B');
  assert.equal(gotA.attribution, 'fingerprint');
  assert.equal(manager.held.length, 0);
  assert.equal(fs.readdirSync(temp).some(name => name.startsWith('.teamyra-download-')), false);

  // Content that cannot tell two different requests apart fails safely.
  const x = manager.expect({ jobId: 'x', webContentsId: 2, destination: path.join(temp, 'x.mp4'), fingerprint: HASH.A, signature: 'x' });
  const y = manager.expect({ jobId: 'y', webContentsId: 2, destination: path.join(temp, 'y.mp4'), fingerprint: HASH.A, signature: 'y' });
  const xr = assert.rejects(x, /could not be attributed/);
  const yr = assert.rejects(y, /could not be attributed/);
  for (const content of ['A', 'A']) {
    const item = fakeItem();
    manager.handleDownload({}, item, { id: 2 });
    fs.writeFileSync(item.savePath, content);
    item.emit('done', {}, 'completed');
  }
  await Promise.all([xr, yr]);
  assert.equal(fs.existsSync(path.join(temp, 'x.mp4')), false, 'no file is guessed onto a job');

  // Bulk copies of one request are interchangeable, even without fingerprints.
  const c1 = manager.expect({ jobId: 'c1', webContentsId: 3, destination: path.join(temp, 'c1.mp4'), signature: 'same' });
  const c2 = manager.expect({ jobId: 'c2', webContentsId: 3, destination: path.join(temp, 'c2.mp4'), signature: 'same' });
  for (const content of ['one', 'two']) {
    const item = fakeItem();
    manager.handleDownload({}, item, { id: 3 });
    fs.writeFileSync(item.savePath, content);
    item.emit('done', {}, 'completed');
  }
  const copies = await Promise.all([c1, c2]);
  assert.equal(copies[0].attribution, 'identical_request');
  assert.deepEqual(copies.map(item => fs.readFileSync(item.path, 'utf8')), ['one', 'two']);

  // A held file may belong to a cancelled job: it is never handed to the job left over.
  const keep = manager.expect({ jobId: 'keep', webContentsId: 4, destination: path.join(temp, 'keep.mp4'), signature: 'k' });
  const drop = manager.expect({ jobId: 'drop', webContentsId: 4, destination: path.join(temp, 'drop.mp4'), signature: 'd' });
  const dropped = assert.rejects(drop, /cancelled/);
  const kept = assert.rejects(keep, /could not be attributed/);
  const lone = fakeItem();
  manager.handleDownload({}, lone, { id: 4 });
  fs.writeFileSync(lone.savePath, 'C');
  lone.emit('done', {}, 'completed');
  await sleep(20);
  manager.cancelJob('drop');
  await dropped;
  await kept;
  assert.equal(fs.existsSync(path.join(temp, 'keep.mp4')), false);
  assert.equal(manager.untrusted.size, 0, 'trust is restored once the queue drains');

  // With nothing abandoned, the last held file does belong to the last job.
  const solo = manager.expect({ jobId: 'solo', webContentsId: 5, destination: path.join(temp, 'solo.mp4'), fingerprint: HASH.A, signature: 's' });
  const other = manager.expect({ jobId: 'other', webContentsId: 5, destination: path.join(temp, 'other.mp4'), fingerprint: HASH.B, signature: 'o' });
  const lateItem = fakeItem();
  manager.handleDownload({}, lateItem, { id: 5 });
  fs.writeFileSync(lateItem.savePath, 'B');
  lateItem.emit('done', {}, 'completed');
  assert.equal((await other).attribution, 'fingerprint');
  const soloItem = fakeItem();
  manager.handleDownload({}, soloItem, { id: 5 });
  fs.writeFileSync(soloItem.savePath, 'C');
  soloItem.emit('done', {}, 'completed');
  assert.equal((await solo).attribution, 'single');
  assert.ok(hammingDistance(HASH.A, HASH.B) === 64 && hammingDistance(HASH.A, HASH.A) === 0);
}

async function adapterTests() {
  assert.equal(failureSignalCount("Couldn't generate. See our policy"), 2);
  assert.equal(failureSignalCount('Generating will use 20 credits'), 0);
  assert.ok(capacitySignal('You have too many generations in progress. Try again soon.'));
  assert.ok(capacitySignal('Please wait for your current generations to finish'));
  assert.equal(capacitySignal('Start generation'), '');

  const flow = new GoogleFlowAutomationAdapter({ getURL: () => 'https://flow.google.com/project/p' });
  flow.pageState = async () => ({ state: 'ok', failure_signals: 0, project_id: 'p' });
  // Flow lists results newest first: k2 is the newest tile, 'old' predates the jobs.
  flow.resultSnapshot = async () => [
    { key: 'k2', type: 'video', ready: true },
    { key: 'k1', type: 'video', ready: true },
    { key: 'old', type: 'video', ready: true }
  ];
  let infoReads = 0;
  flow.readResultInfo = async key => { infoReads++; return { prompt: key === 'old' ? 'an earlier scene' : 'same scene' }; };
  const job = (id, at) => ({ job_id: id, request: { type: 'video', prompt: 'same scene' },
    provider_submission: { submitted_at: at, provider_url: 'https://flow.google.com/project/p', baseline_result_keys: ['old'] } });
  const { states } = await flow.generationStates([job('j2', 2), job('j1', 1)]);
  assert.equal(states.get('j1').result_key, 'k1', 'the oldest copy takes the oldest tile made after it');
  assert.equal(states.get('j2').result_key, 'k2', 'two copies of one prompt never share a tile');
  const reads = infoReads;
  const claimed = await flow.generationStates([job('j3', 3)], { claimedKeys: ['k1'] });
  assert.equal(claimed.states.get('j3').result_key, 'k2', 'tiles owned by other jobs are skipped');
  assert.equal(infoReads, reads, 'tile prompts are cached instead of reopening the info panel');
  const none = await flow.generationStates([job('j4', 4)], { claimedKeys: ['k1', 'k2'] });
  assert.equal(none.states.get('j4').state, 'generating');

  // Copy swap repair: an earlier copy took this job's newer tile; the earlier
  // copy's own tile sits in this job's baseline and is still unclaimed.
  const swap = await flow.generationStates([{ ...job('j5', 5), provider_submission: {
    submitted_at: 5, provider_url: 'https://flow.google.com/project/p', baseline_result_keys: ['k1', 'old'] } }], { claimedKeys: ['k2'] });
  assert.equal(swap.states.get('j5').result_key, 'k1');
  const noSwap = await flow.generationStates([{ ...job('j6', 6), provider_submission: {
    submitted_at: 6, provider_url: 'https://flow.google.com/project/p', baseline_result_keys: ['k1', 'old'] } }], { claimedKeys: [] });
  assert.equal(noSwap.states.get('j6').result_key, 'k2', 'without a swap the baseline stays excluded');

  // Only tiles above the newest tile at submission are new: older tiles that
  // were simply not rendered into the baseline never count or match.
  const scoped = new GoogleFlowAutomationAdapter({});
  scoped.readResultInfo = async key => ({ prompt: key === 'mine' || key === 'ancient' ? 'scene x' : 'other' });
  const scopedJob = { request: { type: 'video', prompt: 'scene x' }, provider_submission: { baseline_result_keys: ['top', 'below'] } };
  const grid = [{ key: 'mine', type: 'video', ready: true }, { key: 'top', type: 'video', ready: true },
    { key: 'below', type: 'video', ready: true }, { key: 'ancient', type: 'video', ready: true }];
  assert.equal((await scoped.resultForJob(scopedJob, { results: grid })).key, 'mine');
  assert.equal(await scoped.resultForJob(scopedJob, { results: grid.filter(item => item.key !== 'mine') }), null,
    'an older identical prompt below the submission point is not this job output');
  assert.equal(scoped.newerThanSubmission(scopedJob, [{ key: 'ancient' }], { pastTop: true }).length, 0);

  assert.ok(promptSimilarity('Shot C14 take 4 candy castle with gumdrop towers at sunset', 'Shot C14 take 4 candy castle with gumdrop towers at dusk') >= 0.6);
  assert.ok(promptSimilarity('Shot C14 take 4 candy castle with gumdrop towers', 'Girl and puppy arriving at rainbow island beach') < 0.6);

  // Flow's image aspect radios (DOM order). "Portrait" is 3:4, not 9:16.
  const radios = ['crop_16_9 16:9', 'crop_landscape 4:3', 'crop_square 1:1', 'crop_portrait 3:4', 'crop_9_16 9:16'].map(text => {
    const attributes = { 'aria-checked': text.includes('9:16') ? 'true' : 'false' };
    return { innerText: text, getBoundingClientRect: () => ({ width: 20, height: 20 }),
      getAttribute: name => attributes[name] ?? null, setAttribute: (name, value) => { attributes[name] = value; } };
  });
  const aspect = new GoogleFlowAutomationAdapter({});
  aspect.ensureSettingsPanelOpen = async () => true;
  aspect.executePageScript = async script => vm.runInNewContext(script, {
    document: { querySelectorAll: () => radios },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' })
  });
  const portrait = await aspect.selectSettingsRadio(aspect.aspectRatioPatterns('9:16'), { label: 'aspect ratio' });
  assert.equal(portrait.already_selected, true);
  assert.match(portrait.text, /9:16/, '9:16 never selects the 3:4 portrait option');
  assert.equal(aspect.aspectRatioPatterns('16:9').includes('landscape'), false, '16:9 never matches the 4:3 landscape option');

  // The ingredient picker retries past leftover overlays, finally with a native click.
  const { FlowReferenceController, uploadedReferences, uploadKey } = require('../src/media/flow-reference-controller');
  const picker = new FlowReferenceController({ executePageScript: async () => true, browser: {} });
  const pickerCalls = [];
  let opens = 0;
  picker.pickerState = async () => ({ trigger: true, expanded: 'false', list: opens >= 3, overlays: opens ? ['cdk-overlay-pane'] : [] });
  picker.dismissOverlays = async () => { pickerCalls.push('dismiss'); };
  picker.clickButton = async () => { pickerCalls.push('click'); opens++; return true; };
  picker.nativeClickTrigger = async () => { pickerCalls.push('native'); opens++; return true; };
  picker.waitFor = async read => { if (opens < 3) throw new Error('not ready'); return read(); };
  await picker.openPicker();
  assert.deepEqual(pickerCalls, ['click', 'dismiss', 'click', 'dismiss', 'native']);
  const stuck = new FlowReferenceController({ executePageScript: async () => true, browser: {} });
  stuck.pickerState = async () => ({ trigger: true, expanded: 'true', list: false, overlays: ['flow-info-panel'] });
  stuck.dismissOverlays = async () => {};
  stuck.clickButton = async () => true;
  stuck.nativeClickTrigger = async () => true;
  stuck.waitFor = async () => { throw new Error('not ready'); };
  await assert.rejects(stuck.openPicker(), /after 3 attempts; state=.*flow-info-panel/, 'a persistent failure reports the page state');

  // An empty Flow project opens the picker on its Upload view, with no asset list.
  const empty = new FlowReferenceController({ executePageScript: async () => true, browser: {} });
  let emptyClicks = 0;
  empty.pickerState = async () => ({ trigger: true, expanded: emptyClicks ? 'true' : 'false', list: false, upload: emptyClicks > 0, overlays: [] });
  empty.clickButton = async () => { emptyClicks++; return true; };
  await empty.openPicker();
  assert.equal(emptyClicks, 1, 'the Upload view counts as an open picker');

  // A folder's jobs return to the Flow project they used before.
  const navigations = [];
  const workspace = new GoogleFlowAutomationAdapter({ getURL: () => 'https://flow.google.com/project/other' });
  workspace.loadProjectUrl = async url => { navigations.push(url); return url; };
  workspace.promptSelector = async () => '#prompt';
  const preferredResult = await workspace.ensureWorkspace(1000, { preferredUrl: 'https://flow.google.com/project/main/edit/1' });
  assert.deepEqual(navigations, ['https://flow.google.com/project/main']);
  assert.equal(preferredResult.preferred, true);
  await workspace.ensureWorkspace(1000, { preferredUrl: 'https://flow.google.com/project/main', allowNavigation: false });
  assert.equal(navigations.length, 1, 'no navigation while downloads are running');

  // After a submit Flow keeps the ingredient chips but hides "Clear prompt"
  // until the prompt has text: type a character, then clear.
  let chips = 3;
  let typedText = '';
  const composer = new FlowReferenceController({
    promptSelector: async () => '#prompt',
    browser: { insertText: async (_selector, text) => { typedText += text; }, clearText: async () => {} }
  });
  composer.adapter.executePageScript = async () => false;
  composer.attachments = async () => Array.from({ length: chips }, () => ({ source: '', busy: false }));
  composer.clickButton = async label => {
    if (label !== 'Clear prompt' || !typedText) return false;
    chips = 0; typedText = '';
    return true;
  };
  composer.waitFor = async read => { if (await read()) return true; throw new Error('not ready'); };
  await composer.clearComposer();
  assert.equal(chips, 0, 'leftover ingredient chips are cleared through the revealed Clear prompt');

  // A project file uploaded once is reused by its unique title, not uploaded again.
  const referenceFile = path.join(os.tmpdir(), 'teamyra-reference-reuse-test.png');
  fs.writeFileSync(referenceFile, 'png');
  const projectUrl = 'https://flow.google.com/project/reuse';
  const reuse = new FlowReferenceController({ webContents: { getURL: () => projectUrl } });
  let uploads = 0;
  let attached = [];
  reuse.attachments = async () => attached;
  reuse.openPicker = async () => {};
  reuse.selectExisting = async () => null;
  reuse.uploadFile = async () => { uploads++; return { uploaded_name: 'teamyra-abc', preparation: null }; };
  reuse.selectUploaded = async cached => cached.identity;
  reuse.clickButton = async () => { attached = [{ source: 'https://x/image/11111111-2222-3333-4444-555555555555', busy: false }]; return true; };
  const first = await reuse.attach({ kind: 'file', path: referenceFile });
  assert.equal(uploads, 1);
  assert.equal(uploadedReferences.get(uploadKey(projectUrl, referenceFile)).title, 'teamyra-abc');
  attached = [];
  const second = await reuse.attach({ kind: 'file', path: referenceFile });
  assert.equal(uploads, 1, 'the second job reuses the upload');
  assert.equal(second.reused_upload, true);
  assert.equal(second.provider_asset_id, first.provider_asset_id);
  fs.rmSync(referenceFile, { force: true });

  // Flow's footer is now <button class="footer-left"> opening a CDK overlay with
  // flow-info-panel; the full prompt lives in .prompt-text .text-part.
  const panelState = { open: false };
  const promptText = "Premium Pixar-quality 3D children's film: a sunny backyard garden.";
  const panel = {
    getBoundingClientRect: () => ({ width: panelState.open ? 300 : 0 }),
    querySelector: selector => selector === '.prompt-text'
      ? { textContent: promptText + ' Reuse prompt', querySelector: inner => inner === '.text-part' ? { textContent: promptText } : null }
      : selector === '.title' ? { textContent: 'Sunny backyard garden view' } : selector === '.metadata' ? { textContent: 'Created Oct 22' } : null
  };
  const footerButton = { click: () => { panelState.open = !panelState.open; }, getAttribute: name => name === 'aria-label' ? 'Sunny backyard garden view' : null };
  const tile = { querySelector: selector => selector === 'img[src]' ? { getAttribute: () => 'media-1', src: '' }
    : selector.includes('footer-left') ? (selector.startsWith('button.footer-left') ? footerButton : null) : null };
  const footerFlow = new GoogleFlowAutomationAdapter({});
  footerFlow.executePageScript = async script => vm.runInNewContext(script, {
    document: {
      querySelectorAll: selector => selector.includes('flow-image-tile') ? [tile] : selector === 'flow-info-panel' ? [panel] : [],
      dispatchEvent: () => { panelState.open = false; }
    },
    KeyboardEvent: class { constructor(type, init) { Object.assign(this, { type }, init); } },
    setTimeout, String, Promise
  });
  const info = await footerFlow.readResultInfo('media-1');
  assert.equal(info.prompt, promptText, 'the prompt comes from the new footer overlay, without the button labels');
  assert.equal(info.title, 'Sunny backyard garden view');
  assert.equal(panelState.open, false, 'the info overlay is closed again');

  // Matching is exact after normalization: a prompt that differs only by
  // letters (the old "missing s" was our own diagnostic regex) never matches.
  const strict = new GoogleFlowAutomationAdapter({});
  const tileInfo = { a: 'Puppy  itting with blue bandana', b: 'Puppy sitting with blue bandana' };
  strict.resultInfo = async key => ({ prompt: tileInfo[key] });
  const strictJob = prompt => ({ request: { type: 'image', prompt }, provider_submission: { baseline_result_keys: [] } });
  const strictResults = [{ key: 'b', type: 'image', ready: true }, { key: 'a', type: 'image', ready: true }];
  assert.equal((await strict.resultForJob(strictJob('Puppy sitting with blue bandana'), { results: strictResults })).key, 'b');
  assert.equal(await strict.resultForJob(strictJob('Puppy sitting with red bandana'), { results: strictResults }), null);
  assert.equal((await strict.resultForJob(strictJob('Puppy sitting’s  blue'), { results: [{ key: 'q', type: 'image', ready: true }] }) ?? 'none'), 'none');

  // Single-job polling ignores refusal text that existed before submission.
  const single = new GoogleFlowAutomationAdapter({ getURL: () => 'https://flow.google.com/project/p' });
  single.pageState = async () => ({ state: 'ok', failure_signals: 1 });
  single.resultForJob = async () => null;
  assert.equal((await single.generationState({ provider_submission: { baseline_failure_signals: 1 } })).state, 'generating');
  assert.equal((await single.generationState({ provider_submission: { baseline_failure_signals: 0 } })).reason, 'policy_refusal');
  assert.equal((await single.generationState({ provider_submission: {} })).reason, 'policy_refusal', 'legacy jobs keep the old check');
}

function loadConsumer(core) {
  const source = fs.readFileSync(path.join(__dirname, '../src/media/media-job-consumer.js'), 'utf8');
  const localRequire = createRequire(path.join(__dirname, '../src/media/media-job-consumer.js'));
  const module = { exports: {} };
  const stubs = {
    '../core-api': { callCore: core },
    './media-output-validator': { verifyMediaOutput: async () => ({ decoded: true }), convertImage: async () => {}, hammingDistance },
    './media-audio-processor': { extractAudio: async () => {} }
  };
  vm.runInNewContext(source, { module, require: name => stubs[name] || localRequire(name), setTimeout, clearTimeout, console, Date, Promise });
  return module.exports;
}

function fakeCore(temp, jobs) {
  const records = new Map(jobs.map(job => [job.job_id, { state: 'queued', provider_submission: {}, history: [], ...job }]));
  const calls = [];
  let assets = 0;
  const core = async (name, args = {}) => {
    calls.push(name);
    const record = records.get(args.job_id);
    switch (name) {
      case 'media.claim': {
        const next = [...records.values()].find(item => item.state === 'queued' && !(item.retry_after > Date.now() / 1000));
        if (!next) return null;
        next.state = 'preparing';
        return JSON.parse(JSON.stringify(next));
      }
      case 'media.status': return JSON.parse(JSON.stringify(record));
      case 'media.status-many': return { jobs: Object.fromEntries(args.job_ids.map(id => [id, JSON.parse(JSON.stringify(records.get(id)))])) };
      case 'media.update-state':
        record.state = args.state;
        record.detail = args.detail;
        if (args.extra) Object.assign(record, args.extra);
        return record;
      case 'media.patch': Object.assign(record, args.patch); return record;
      case 'media.prepare-output': return { path: path.join(temp, args.job_id + '.mp4'), format: 'mp4' };
      case 'media.register-asset': record.state = 'completed'; record.asset_id = 'TYR-VID-' + String(++assets).padStart(6, '0'); return { asset_id: record.asset_id };
      case 'media.release':
        record.state = 'queued';
        record.released = (record.released || 0) + 1;
        return record;
      default: return {};
    }
  };
  return { core, records, calls };
}

async function pipelineTests(temp) {
  const jobs = Array.from({ length: 6 }, (_, index) => ({
    job_id: 'job-' + index,
    created_at: index,
    request: { type: 'video', prompt: 'scene ' + index, max_parallel: 3, generation_settings: { download_quality: 'source' } }
  }));
  const { core, records } = fakeCore(temp, jobs);
  const { MediaJobConsumer, DOWNLOAD_PARALLEL } = loadConsumer(core);
  const ready = new Set();
  const submits = [];
  let uiActive = 0;
  let maxUi = 0;
  let activeDownloads = 0;
  let maxDownloads = 0;
  const pending = new Map();
  const page = async fn => {
    uiActive++;
    maxUi = Math.max(maxUi, uiActive);
    try { await sleep(2); return await fn(); } finally { uiActive--; }
  };
  const adapter = {
    probe: async () => ({ buttonLabels: [] }),
    classifyProbe: () => ({ signedIn: true }),
    capabilities: async () => ({ video: true }),
    submit: (job, checkpoint) => page(async () => {
      const submission = { submitted_at: Date.now() / 1000 + submits.length, provider_url: 'https://flow.google.com/project/p', baseline_failure_signals: 0 };
      await checkpoint(submission);
      submits.push(job.job_id);
      return submission;
    }),
    generationStates: (list, { claimedKeys }) => page(async () => {
      const states = new Map();
      for (const job of list) {
        const key = 'key-' + job.job_id;
        states.set(job.job_id, ready.has(job.job_id) && !claimedKeys.includes(key) ? { state: 'ready_to_download', result_key: key } : { state: 'generating' });
      }
      return { page: { state: 'ok', failure_signals: 0 }, states };
    }),
    // Distinct thumbnails (pairwise >= 32 bits apart) may download together.
    resultFingerprint: key => page(async () => DISTINCT[Number(key.slice(-1))]),
    startDownload: job => page(async () => {
      activeDownloads++;
      maxDownloads = Math.max(maxDownloads, activeDownloads);
      setTimeout(() => {
        const entry = pending.get(job.job_id);
        fs.writeFileSync(entry.destination, 'video ' + job.job_id);
        activeDownloads--;
        entry.resolve({ path: entry.destination, bytes: 10, attribution: 'fingerprint' });
      }, 60);
      return { quality: 'source', result_key: job.provider_submission.result_key };
    })
  };
  const downloadManager = {
    expect: ({ jobId, destination, fingerprint }) => {
      assert.ok(fingerprint, 'bulk downloads carry the tile fingerprint');
      assert.ok(destination.length < 200 && destination.includes('.staging-' + jobId), 'downloads land in a short per-job staging path');
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      return new Promise(resolve => pending.set(jobId, { destination, resolve }));
    },
    cancelJob() {}
  };
  const provider = { adapter, ensureLoaded: async () => {}, destroy() {}, view: { webContents: { id: 9 } } };
  let maxInFlight = 0;
  const consumer = new MediaJobConsumer({ surface: 'visual', provider, downloadManager, pollMs: 15, monitorMs: 15,
    onActivity: () => { maxInFlight = Math.max(maxInFlight, consumer.inFlight.size); } });
  consumer.start();
  await until(() => submits.length === 3, 'three back-to-back submissions');
  await sleep(120);
  assert.equal(submits.length, 3, 'the parallel limit holds while all three are generating');
  assert.equal(consumer.busy, true);
  assert.equal(JSON.stringify(consumer.pipelineStatus().phases), JSON.stringify({ generating: 3 }));
  for (const job of jobs) ready.add(job.job_id);
  await until(() => [...records.values()].every(item => item.state === 'completed'), 'all bulk jobs to complete');
  consumer.stop();
  assert.equal(maxUi, 1, 'page interaction is serialized');
  assert.ok(maxInFlight <= 3, 'never more generations than max_parallel');
  assert.ok(maxDownloads > 1 && maxDownloads <= DOWNLOAD_PARALLEL, 'fingerprinted downloads overlap within the download limit');
  assert.equal(new Set([...records.values()].map(item => item.asset_id)).size, 6);
  assert.equal(records.get('job-0').provider_submission.result_key, 'key-job-0');
  assert.equal(fs.readFileSync(path.join(temp, 'job-3.mp4'), 'utf8'), 'video job-3', 'verified staging output is moved to the project path');
  assert.equal(consumer.busy, false);

  // Flow refusing another generation before Generate returns the job to the queue.
  const busyJobs = Array.from({ length: 3 }, (_, index) => ({
    job_id: 'busy-' + index, created_at: index, request: { type: 'video', prompt: 'busy ' + index, max_parallel: 3 }
  }));
  const busyCore = fakeCore(temp, busyJobs);
  const loaded = loadConsumer(busyCore.core);
  let refused = false;
  const busyAdapter = { ...adapter,
    submit: async (job, checkpoint) => {
      if (job.job_id === 'busy-1' && !refused) {
        refused = true;
        throw new Error('generation_click: capacity_limited: Google Flow is busy before Generate: too many generations');
      }
      const submission = { submitted_at: Date.now() / 1000, provider_url: 'https://flow.google.com/project/p', baseline_failure_signals: 0 };
      await checkpoint(submission);
      return submission;
    },
    generationStates: async list => ({ page: { state: 'ok', failure_signals: 0 }, states: new Map(list.map(job => [job.job_id, { state: 'generating' }])) })
  };
  const busyConsumer = new loaded.MediaJobConsumer({ surface: 'visual', provider: { ...provider, adapter: busyAdapter }, downloadManager, pollMs: 15, monitorMs: 15 });
  busyConsumer.start();
  await until(() => busyCore.records.get('busy-1').released === 1, 'capacity release');
  busyConsumer.stop();
  assert.equal(busyCore.records.get('busy-1').state, 'queued');
  assert.notEqual(busyCore.records.get('busy-1').state, 'failed', 'backpressure is not a failure');
  assert.equal(busyConsumer.parallelLimit, 1, 'concurrency adapts to what Flow accepted');
  assert.ok(busyConsumer.pausedUntil > Date.now(), 'new submissions pause briefly');
  busyConsumer.inFlight.clear();

  // Look-alike thumbnails never download side by side; distinct ones do, up to 8.
  const slots = new loaded.MediaJobConsumer({ surface: 'visual', provider, downloadManager });
  slots.activeDownloads.add({ fingerprint: '0000000000000000' });
  assert.equal(slots.canStartDownload({ fingerprint: '0000000000000003' }), false, 'near-identical shots wait');
  assert.equal(slots.canStartDownload({ fingerprint: 'ffffffffffffffff' }), true);
  assert.equal(slots.canStartDownload({ fingerprint: null }), false);
  for (let i = 1; i < loaded.DOWNLOAD_PARALLEL; i += 1) slots.activeDownloads.add({ fingerprint: DISTINCT[i % DISTINCT.length] });
  assert.equal(slots.canStartDownload({ fingerprint: 'ffffffffffffffff' }), false, 'download slots are capped');
  assert.equal(loaded.DOWNLOAD_PARALLEL, 8);

  // Patience scales with how fast Flow has been this session.
  const patient = new loaded.MediaJobConsumer({ surface: 'visual', provider, downloadManager });
  assert.equal(patient.patience().noResultMs, 6 * 60 * 1000);
  patient.generationTimes = [100000, 120000, 200000, 240000];
  assert.equal(patient.patience().noResultMs, 4 * 240000);
  assert.equal(patient.patience().overdueMs, 2 * 240000);

  // A job with no result after a full grid search fails fast and frees its slot.
  const { core: staleCore, records: staleRecords } = fakeCore(temp, [{ job_id: 'stale-0', request: { type: 'video', prompt: 'refused' } }]);
  const staleLoaded = loadConsumer(staleCore);
  let deepRequested = [];
  const staleConsumer = new staleLoaded.MediaJobConsumer({ surface: 'visual', downloadManager, provider: { ...provider, adapter: { ...adapter,
    generationStates: async (list, options) => {
      deepRequested = options.deepJobIds;
      return { page: { state: 'ok', failure_signals: 0 }, states: new Map(list.map(job => [job.job_id, { state: 'generating', searched: options.deepJobIds.includes(job.job_id) }])) };
    } } } });
  const staleFailures = [];
  staleConsumer.handleFailure = async (jobId, error) => { staleFailures.push([jobId, String(error.message)]); };
  staleConsumer.inFlight.set('stale-0', { jobId: 'stale-0', phase: 'generating', submittedAt: Date.now() - 7 * 60 * 1000,
    baselineFailures: 0, submission: {}, job: { job_id: 'stale-0', request: { type: 'video', prompt: 'refused' } } });
  staleRecords.get('stale-0').state = 'generating';
  await staleConsumer.pollOnce();
  assert.deepEqual([...deepRequested], ['stale-0'], 'an overdue job triggers a full grid search');
  assert.equal(staleFailures.length, 1);
  assert.match(staleFailures[0][1], /provider_no_result/);
  assert.equal(staleConsumer.inFlight.size, 0, 'its slot is released immediately');
  assert.equal(staleLoaded.classifyError(new Error("ERR_NAME_NOT_RESOLVED (-105) loading 'https://www.flowmusic.app/'")).category, 'browser_failure');
  assert.equal(staleLoaded.classifyError(new Error('references: Reference Upload media control unavailable')).category, 'selector_failure', 'pre-Generate reference errors are retryable');

  // Finished but unmatched results are reported as such, not as moderation.
  const { core: matchCore } = fakeCore(temp, [{ job_id: 'match-0', request: { type: 'image', prompt: 'garden' } }]);
  const matchLoaded = loadConsumer(matchCore);
  const matchConsumer = new matchLoaded.MediaJobConsumer({ surface: 'visual', downloadManager, provider: { ...provider, adapter: { ...adapter,
    generationStates: async list => ({ page: { state: 'ok', failure_signals: 0 },
      states: new Map(list.map(job => [job.job_id, { state: 'generating', searched: true, unmatched_results: 2 }])) }) } } });
  const matchFailures = [];
  matchConsumer.handleFailure = async (jobId, error) => { matchFailures.push(String(error.message)); };
  matchConsumer.inFlight.set('match-0', { jobId: 'match-0', phase: 'generating', submittedAt: Date.now() - 7 * 60 * 1000,
    watchStartedAt: Date.now() - 60000, baselineFailures: 0, submission: {}, job: { job_id: 'match-0', request: { type: 'image', prompt: 'garden' } } });
  await matchConsumer.pollOnce();
  assert.match(matchFailures[0], /result_match_failed/);
  assert.doesNotMatch(matchFailures[0], /moderation/);
  assert.equal(matchLoaded.classifyError(new Error(matchFailures[0])).category, 'result_match_failed');

  // At decision time a Failed tile newer than the submission means a refusal.
  const refusedConsumer = new matchLoaded.MediaJobConsumer({ surface: 'visual', downloadManager, provider: { ...provider, adapter: { ...adapter,
    generationStates: async list => ({ page: { state: 'ok', failure_signals: 3 },
      states: new Map(list.map(job => [job.job_id, { state: 'generating', searched: true, unmatched_results: 0,
        region: { top: 't', failed: 1, pending_seen: false } }])) }) } } });
  const refusals = [];
  refusedConsumer.handleFailure = async (jobId, error) => { refusals.push(String(error.message)); };
  refusedConsumer.inFlight.set('match-0', { jobId: 'match-0', phase: 'generating', submittedAt: Date.now() - 7 * 60 * 1000,
    watchStartedAt: Date.now() - 60000, baselineFailures: 0, submission: { baseline_failed_above: 0 }, job: { job_id: 'match-0', request: { type: 'video', prompt: 'x' } } });
  await refusedConsumer.pollOnce();
  assert.match(refusals[0], /policy_refusal/);

  // Region-scoped refusals: an old Failed tile scrolling into view never fails a
  // new job, and a job whose own in-progress tile is visible is not refused.
  const regionFlow = new GoogleFlowAutomationAdapter({});
  const regionJob = { request: { type: 'video', prompt: 'Shot C29 (take 4) - candy land' }, provider_submission: { baseline_result_keys: ['top'] } };
  assert.deepEqual(JSON.parse(JSON.stringify(regionFlow.regionFor(regionJob, [
    { key: '', failed: true, text: 'Failed' }, { key: 'top', ready: true }, { key: '', failed: true, text: 'Failed old' }]))),
    { top: 'top', failed: 1, pending_seen: false });
  assert.equal(regionFlow.regionFor(regionJob, [{ key: '', ready: false, failed: false, text: 'play_circle 26% Shot C29 (take 4) - candy land' },
    { key: 'top', ready: true }]).pending_seen, true);
  const regional = new matchLoaded.MediaJobConsumer({ surface: 'visual', provider, downloadManager });
  const regionalFailures = [];
  regional.handleFailure = async jobId => { regionalFailures.push(jobId); };
  const regionalCtx = (jobId, above) => ({ jobId, phase: 'generating', submittedAt: Date.now(), submission: { baseline_failed_above: above }, job: { request: {} } });
  regional.inFlight.set('r1', regionalCtx('r1', 0));
  regional.inFlight.set('r2', regionalCtx('r2', 1));
  regional.inFlight.set('r3', regionalCtx('r3', 0));
  await regional.attributeRegionFailures(new Map([
    ['r1', { region: { top: 'a', failed: 1, pending_seen: false } }],
    ['r2', { region: { top: 'a', failed: 1, pending_seen: false } }],
    ['r3', { region: { top: 'a', failed: 1, pending_seen: true } }]]));
  assert.deepEqual(regionalFailures, ['r1'], 'only the job submitted before the Failed tile appeared, and not one already generating');

  // A resumed job is searched before it can time out or be given up.
  const resumed = new matchLoaded.MediaJobConsumer({ surface: 'visual', downloadManager, provider: { ...provider, adapter: { ...adapter,
    generationStates: async list => ({ page: { state: 'ok', failure_signals: 0 },
      states: new Map(list.map(job => [job.job_id, { state: 'generating', searched: true, unmatched_results: 0 }])) }) } } });
  const resumedFailures = [];
  resumed.handleFailure = async (jobId, error) => { resumedFailures.push(String(error.message)); };
  resumed.inFlight.set('match-0', { jobId: 'match-0', phase: 'generating', submittedAt: Date.now() - 3 * 3600 * 1000,
    watchStartedAt: Date.now(), baselineFailures: 0, submission: {}, job: { job_id: 'match-0', request: { type: 'image', prompt: 'garden' } } });
  await resumed.pollOnce();
  assert.equal(resumedFailures.length, 0, 'an hours-old submission resumed now is not failed before it is searched');

  // Page-wide refusal text is attributed only once it accounts for every candidate.
  const attribution = new loaded.MediaJobConsumer({ surface: 'visual', provider, downloadManager });
  const failed = [];
  attribution.handleFailure = async (jobId, error) => { failed.push([jobId, String(error.message)]); };
  const ctx = (jobId, baselineFailures) => ({ jobId, phase: 'generating', baselineFailures, job: { request: {} } });
  attribution.inFlight.set('p1', ctx('p1', 0));
  attribution.inFlight.set('p2', ctx('p2', 0));
  attribution.inFlight.set('p3', ctx('p3', 1));
  await attribution.attributeFailures(1);
  assert.equal(failed.length, 0, 'one new refusal cannot yet be pinned on either of two jobs');
  attribution.inFlight.get('p2').phase = 'ready';
  await attribution.attributeFailures(1);
  assert.deepEqual(failed.map(item => item[0]), ['p1']);
  assert.match(failed[0][1], /policy_refusal/);
  assert.equal(loaded.classifyError(new Error('download_failure: output aspect ratio does not match request')).category, 'output_mismatch');
  assert.equal(attribution.inFlight.has('p3'), true, 'a job submitted after the refusal is unaffected');
}

// Several Flow tabs (lanes) work one queue: each claims as its lane, runs in
// its own project and marks its submissions so restarts resume them there.
async function laneTests(temp) {
  const jobs = Array.from({ length: 4 }, (_, index) => ({
    job_id: 'lane-' + index, created_at: index, batch_id: 'batch-x',
    request: { type: 'video', prompt: 'lane scene ' + index, project_path: 'D:/folder', generation_settings: { download_quality: 'source' } }
  }));
  const { core: base, records } = fakeCore(temp, jobs);
  const claims = [];
  const projectLookups = [];
  const core = async (name, args = {}) => {
    if (name === 'media.claim') {
      claims.push({ lane: args.lane, lanes: args.lanes, refs_key: args.refs_key });
      const job = await base(name, args);
      return job ? { ...job, refs_key: 'TYR-IMG-1' } : job;
    }
    if (name === 'media.flow-project') {
      projectLookups.push(args.lane);
      return { provider_url: args.lane === 0 ? 'https://flow.google.com/project/main' : null };
    }
    return base(name, args);
  };
  const { MediaJobConsumer } = loadConsumer(core);
  const submitted = [];
  const makeAdapter = lane => ({
    probe: async () => ({ buttonLabels: [] }),
    classifyProbe: () => ({ signedIn: true }),
    capabilities: async () => ({ video: true }),
    submit: async (job, checkpoint) => {
      submitted.push({ lane, preferred: job.preferred_project_url, createNew: job.create_new_project });
      const submission = { submitted_at: Date.now() / 1000, provider_url: job.preferred_project_url || 'https://flow.google.com/project/tab' + lane, baseline_failure_signals: 0 };
      await checkpoint(submission);
      return submission;
    },
    generationStates: async list => ({ page: { state: 'ok', failure_signals: 0 }, states: new Map(list.map(job => [job.job_id, { state: 'generating' }])) })
  });
  const downloadManager = { expect: () => new Promise(() => {}), cancelJob() {} };
  const consumers = [0, 1].map(lane => new MediaJobConsumer({ surface: 'visual', downloadManager, pollMs: 15, monitorMs: 15, lane, lanes: 2,
    provider: { adapter: makeAdapter(lane), ensureLoaded: async () => {}, destroy() {},
      view: { webContents: { id: 20 + lane, getURL: () => lane ? 'https://flow.google.com/project/tab1' : 'https://flow.google.com/project/main' } } } }));
  consumers.forEach(consumer => consumer.start());
  await until(() => [...records.values()].every(item => item.state === 'generating'), 'both tabs to submit the batch');
  consumers.forEach(consumer => consumer.stop());
  assert.deepEqual([...new Set(claims.map(item => item.lane))].sort(), [0, 1], 'each tab claims as its own lane');
  assert.ok(claims.every(item => item.lanes === 2));
  assert.ok(claims.some(item => item.refs_key === 'TYR-IMG-1'), 'a tab asks for jobs using its attached references');
  const laneOf = new Set([...records.values()].map(item => item.provider_submission.lane));
  assert.deepEqual([...laneOf].sort(), [0, 1], 'submissions record their tab');
  const tabSubmits = submitted.filter(item => item.lane === 1);
  assert.ok(tabSubmits.length, 'the extra tab took part of the batch');
  assert.equal(tabSubmits[0].createNew, true, 'a tab without a project creates its own');
  assert.ok(tabSubmits.slice(1).every(item => item.preferred === 'https://flow.google.com/project/tab1' && !item.createNew),
    'later jobs of the tab reuse that project');
  assert.ok(submitted.filter(item => item.lane === 0).every(item => item.preferred === 'https://flow.google.com/project/main' && !item.createNew));
  assert.ok(projectLookups.includes(1));
  // Let the monitors see the jobs end so no watcher keeps running.
  for (const record of records.values()) record.state = 'completed';
  await until(() => consumers.every(consumer => !consumer.inFlight.size), 'tab monitors to drain');

  // A download that never arrives is requested again in place, not after 6 minutes.
  const retryJobs = [{ job_id: 'retry-0', created_at: 0, request: { type: 'video', prompt: 'retry', generation_settings: { download_quality: 'source' } } }];
  const retryCore = fakeCore(temp, retryJobs);
  const loaded = loadConsumer(retryCore.core);
  const waits = [];
  let clicks = 0;
  const retryDownloads = {
    expect: ({ destination, timeoutMs }) => {
      waits.push(timeoutMs);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      if (waits.length === 1) return Promise.reject(new Error('download_failure: Timed out waiting for Google media download completion'));
      fs.writeFileSync(destination, 'video');
      return Promise.resolve({ path: destination, bytes: 5, attribution: 'single' });
    },
    cancelJob() {}
  };
  const retryConsumer = new loaded.MediaJobConsumer({ surface: 'visual', downloadManager: retryDownloads,
    provider: { view: { webContents: { id: 30 } }, adapter: { startDownload: async () => { clicks += 1; return { quality: 'source' }; } } } });
  retryCore.records.get('retry-0').state = 'generating';
  await retryConsumer.downloadAndRegister({ job: retryCore.records.get('retry-0'), jobId: 'retry-0', resultKey: 'k',
    planned: { path: path.join(temp, 'retry.mp4'), format: 'mp4' } });
  assert.equal(clicks, 2, 'Download is clicked again');
  assert.ok(waits[0] <= 150000 && waits[1] > waits[0], 'a short first wait, a longer second one');
  assert.equal(retryCore.records.get('retry-0').state, 'completed');
}

async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'teamyra-media-bulk-'));
  try {
    await downloadManagerTests(temp);
    await adapterTests();
    await pipelineTests(temp);
    await laneTests(temp);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
  console.log('bulk media pipeline, attribution and concurrency tests passed');
}

let finished = false;
// An awaited download that never settles would otherwise exit silently as success.
process.on('beforeExit', () => { if (!finished && !process.exitCode) { console.error('bulk media test stalled'); process.exitCode = 1; } });
main().then(() => { finished = true; }, error => { finished = true; console.error(error); process.exitCode = 1; });
