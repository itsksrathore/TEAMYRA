const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
const { MediaDownloadManager } = require('../src/media/media-download-manager');
const { GoogleFlowAutomationAdapter, failureSignalCount, capacitySignal } = require('../src/media/google-flow-automation-adapter');
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

  // A held file goes to the only job left once the other is cancelled.
  const keep = manager.expect({ jobId: 'keep', webContentsId: 4, destination: path.join(temp, 'keep.mp4'), signature: 'k' });
  const drop = manager.expect({ jobId: 'drop', webContentsId: 4, destination: path.join(temp, 'drop.mp4'), signature: 'd' });
  const dropped = assert.rejects(drop, /cancelled/);
  const lone = fakeItem();
  manager.handleDownload({}, lone, { id: 4 });
  fs.writeFileSync(lone.savePath, 'C');
  lone.emit('done', {}, 'completed');
  await sleep(20);
  manager.cancelJob('drop');
  await dropped;
  assert.equal((await keep).attribution, 'only_candidate');
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
  flow.resultSnapshot = async () => [
    { key: 'old', type: 'video', ready: true },
    { key: 'k1', type: 'video', ready: true },
    { key: 'k2', type: 'video', ready: true }
  ];
  let infoReads = 0;
  flow.readResultInfo = async () => { infoReads++; return { prompt: 'same scene' }; };
  const job = (id, at) => ({ job_id: id, request: { type: 'video', prompt: 'same scene' },
    provider_submission: { submitted_at: at, provider_url: 'https://flow.google.com/project/p', baseline_result_keys: ['old'] } });
  const { states } = await flow.generationStates([job('j2', 2), job('j1', 1)]);
  assert.equal(states.get('j1').result_key, 'k1', 'oldest submission matches first');
  assert.equal(states.get('j2').result_key, 'k2', 'two copies of one prompt never share a tile');
  const reads = infoReads;
  const claimed = await flow.generationStates([job('j3', 3)], { claimedKeys: ['k1'] });
  assert.equal(claimed.states.get('j3').result_key, 'k2', 'tiles owned by other jobs are skipped');
  assert.equal(infoReads, reads, 'tile prompts are cached instead of reopening the info panel');
  const none = await flow.generationStates([job('j4', 4)], { claimedKeys: ['k1', 'k2'] });
  assert.equal(none.states.get('j4').state, 'generating');

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
    './media-output-validator': { verifyMediaOutput: async () => ({ decoded: true }), convertImage: async () => {} },
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
    resultFingerprint: key => page(async () => key),
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

async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'teamyra-media-bulk-'));
  try {
    await downloadManagerTests(temp);
    await adapterTests();
    await pipelineTests(temp);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
  console.log('bulk media pipeline, attribution and concurrency tests passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
