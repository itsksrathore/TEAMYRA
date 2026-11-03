const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { cardPrompt, samePrompt } = require('../src/media/google-vids-adapter');
const { VidsJobConsumer, WorkspaceStore } = require('../src/media/vids-job-consumer');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(condition, label, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (condition()) return; await sleep(10); }
  throw new Error('timed out waiting for ' + label);
}

function labelTests() {
  // Vids labels finished clips with the chips and the settings around the prompt.
  assert.equal(cardPrompt('Generated video: Image1Image2 The fox walks in., 1080p, 10 seconds'), 'the fox walks in.');
  assert.equal(cardPrompt('@Image1 The fox walks in.'), 'the fox walks in.');
  assert.ok(samePrompt('Generated video: A red tram climbing a street in Lisbon, gentle camera follow, 1080p, 6 seconds',
    'A red tram climbing a street in Lisbon, gentle camera follow'));
  assert.ok(!samePrompt('Generated video: A red tram climbing a street in Porto at night, 1080p, 6 seconds',
    'A red tram climbing a street in Lisbon, gentle camera follow'));
}

function fakeCore(temp, jobs) {
  const records = new Map(jobs.map(job => [job.job_id, { state: 'queued', history: [], ...job }]));
  const registered = [];
  const core = async (name, args = {}) => {
    const record = records.get(args.job_id);
    switch (name) {
      case 'media.claim': {
        const next = [...records.values()].find(item => item.state === 'queued');
        if (!next) return null;
        next.state = 'preparing';
        return JSON.parse(JSON.stringify(next));
      }
      case 'media.status': return JSON.parse(JSON.stringify(record));
      case 'media.status-many': return { jobs: Object.fromEntries(args.job_ids.map(id => [id, { cancel_requested: false }])) };
      case 'media.update-state': record.state = args.state; record.detail = args.detail; if (args.extra) Object.assign(record, args.extra); return record;
      case 'media.patch': Object.assign(record, args.patch); return record;
      case 'media.prepare-output': return { path: path.join(temp, args.job_id + '.mp4'), staging_dir: path.join(temp, '.staging-' + args.job_id) };
      case 'media.register-asset': record.state = 'completed'; registered.push(args); return { asset_id: 'TYR-VID-' + registered.length };
      default: return {};
    }
  };
  return { core, records, registered };
}

async function consumerTests(temp) {
  const prompt = 'A golden retriever running along a misty beach at sunrise';
  const jobs = [
    { job_id: 'v1', request: { type: 'video', prompt, vids_mode: 'create', aspect_ratio: '16:9', duration: 6, generation_settings: { generation_resolution: '1080p' } } },
    { job_id: 'v2', request: { type: 'video', prompt, vids_mode: 'create', aspect_ratio: '16:9', generation_settings: { generation_resolution: '1080p' } } },
    { job_id: 'v3', request: { type: 'video', prompt: 'A forbidden scene that Vids refuses outright', vids_mode: 'create', generation_settings: {} },
      resolved_references: [{ path: 'C:/refs/a.png' }] }
  ];
  const { core, records, registered } = fakeCore(temp, jobs);
  const submitted = [];
  let cards = [];
  const adapter = {
    submit: async options => {
      submitted.push(options);
      cards.push({ kind: 'running', label: options.prompt, percent: 5 });
      return { submitted_at: Date.now() / 1000, provider_url: 'https://docs.google.com/videos/d/abc/edit', selected_settings: 'x', mode: options.mode };
    },
    cards: async () => cards,
    failureFor: async text => /forbidden/.test(text) ? "We couldn't generate this video. Try a different prompt." : null
  };
  const consumer = new VidsJobConsumer({ workerName: 'vids-test', provider: { view: { webContents: { getURL: () => '' } } }, core,
    pollMs: 20, inFlightLimit: 3, verify: async () => ({ decoded: true, width: 1920, height: 1080 }),
    fetchVideo: async url => ({ ok: true, status: 200, arrayBuffer: async () => Buffer.from('video ' + url) }) });
  consumer.adapter = async () => adapter;
  consumer.workspace = async () => 'https://docs.google.com/videos/d/abc/edit';
  consumer.start();
  await until(() => submitted.length === 3, 'three submissions in one tab');
  assert.equal(submitted[0].duration, 6);
  assert.equal(submitted[0].resolution, '1080p');
  assert.deepEqual(submitted[2].images, ['C:/refs/a.png'], 'reference images are attached');
  // Two copies of one prompt finish: each job gets its own clip, oldest first.
  cards = [
    { kind: 'done', label: 'Generated video: ' + prompt + ', 1080p, 6 seconds', src: 'https://contribution-rt.usercontent.google.com/download?c=one' },
    { kind: 'done', label: 'Generated video: ' + prompt + ', 1080p, 10 seconds', src: 'https://contribution-rt.usercontent.google.com/download?c=two' }
  ];
  await until(() => registered.length === 2, 'both clips registered');
  assert.equal(fs.readFileSync(path.join(temp, 'v1.mp4'), 'utf8'), 'video https://contribution-rt.usercontent.google.com/download?c=one');
  assert.equal(fs.readFileSync(path.join(temp, 'v2.mp4'), 'utf8'), 'video https://contribution-rt.usercontent.google.com/download?c=two');
  assert.equal(registered[0].provider, 'google-vids');
  assert.equal(records.get('v1').provider_submission.engine, 'google-vids');
  consumer.stop();

  // A failure card with the job's prompt fails it (after the grace period).
  const lateCtx = consumer.inFlight.get('v3');
  assert.ok(lateCtx, 'the refused job is still being watched');
  lateCtx.submittedAt -= 60000;
  lateCtx.lastRunningAt = Date.now() - 60000;
  await consumer.pollOnce();
  assert.equal(records.get('v3').state, 'failed');
  assert.equal(records.get('v3').failure.category, 'policy_refusal');
  assert.equal(consumer.busy, false);

  // A refusal card shows no prompt: jobs whose card vanished take new refusal
  // cards only when there is one for each of them.
  const terms = 'That request looks like it goes against our terms. Try asking something else.';
  const refused = fakeCore(temp, [{ job_id: 'r1', request: { type: 'video', prompt: 'x' } }, { job_id: 'r2', request: { type: 'video', prompt: 'y' } }]);
  let feed = [{ kind: 'failed', id: 'old', label: terms }, { kind: 'failed', id: 'f1', label: terms }];
  const tab = new VidsJobConsumer({ workerName: 'vids-test', provider: {}, core: refused.core, pollMs: 20 });
  tab.adapter = async () => ({ cards: async () => feed, failureFor: async () => null });
  for (const [jobId, prompt] of [['r1', 'A knight rides over a dune crest at dawn'], ['r2', 'Riders fan out across the sand at full gallop']]) {
    tab.inFlight.set(jobId, { jobId, prompt, submittedAt: Date.now() - 120000, knownFailures: new Set(['old']) });
  }
  await tab.pollOnce();
  assert.equal(refused.records.get('r1').state, 'queued', 'one new refusal card cannot be pinned on one of two jobs');
  feed = [...feed, { kind: 'failed', id: 'f2', label: terms }];
  await tab.pollOnce();
  assert.equal(refused.records.get('r1').failure.category, 'policy_refusal');
  assert.equal(refused.records.get('r2').failure.category, 'policy_refusal');
  assert.match(refused.records.get('r2').detail, /against our terms/);

  // A job submitted before a restart cannot be found again in a new tab.
  const lost = fakeCore(temp, [{ job_id: 'lost', request: { type: 'video', prompt: 'x' }, provider_submission: { submitted_at: 1 } }]);
  const restarted = new VidsJobConsumer({ workerName: 'vids-test', provider: {}, core: lost.core, pollMs: 20 });
  await restarted.admit(JSON.parse(JSON.stringify(lost.records.get('lost'))));
  assert.equal(lost.records.get('lost').failure.category, 'vids_tab_lost');

  // Each tab remembers its Vids file.
  const store = new WorkspaceStore(path.join(temp, 'ws.json'));
  store.set('google:tab1', 'https://docs.google.com/videos/d/one/edit');
  assert.equal(new WorkspaceStore(path.join(temp, 'ws.json')).get('google:tab1'), 'https://docs.google.com/videos/d/one/edit');
}

// Closing a Vids tab under a pending page call crashed the desktop.
function providerCloseTests() {
  const Module = require('node:module');
  const original = Module._load;
  Module._load = function (request, ...rest) {
    if (request === 'electron') return { WebContentsView: class {} };
    return original.call(this, request, ...rest);
  };
  delete require.cache[require.resolve('../src/media/google-vids-provider')];
  const { GoogleVidsProvider } = require('../src/media/google-vids-provider');
  Module._load = original;
  const calls = [];
  const wc = { isDestroyed: () => false, stop: () => calls.push('stop'), close: () => calls.push('close'),
    debugger: { isAttached: () => true, detach: () => calls.push('detach') } };
  const provider = new GoogleVidsProvider({ window: { contentView: { removeChildView: () => calls.push('remove') } }, sessionManager: {} });
  provider.view = { webContents: wc };
  provider.adapter = { pending: 1 };
  assert.equal(provider.destroy(), false, 'a tab with a pending call is kept');
  assert.deepEqual(calls, []);
  assert.equal(provider.destroy({ force: true }), true, 'shutdown still closes it');
  assert.deepEqual(calls, ['detach', 'stop', 'remove', 'close'], 'DevTools detached and loading stopped before close');
  assert.equal(provider.view, null);
}

async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'teamyra-vids-'));
  try {
    labelTests();
    providerCloseTests();
    await consumerTests(temp);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
  console.log('google vids adapter labels, tab pipeline and recovery tests passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
