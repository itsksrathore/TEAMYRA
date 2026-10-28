const assert = require('node:assert/strict');
const { GoogleFlowAutomationAdapter, FLOW_HOME } = require('../src/media/google-flow-automation-adapter');
const { GoogleFlowMusicAutomationAdapter, FLOW_MUSIC_HOME } = require('../src/media/google-flow-music-automation-adapter');
const { classifyError } = require('../src/media/media-job-consumer');
const { resolveFfmpeg } = require('../src/media/media-audio-processor');
const { partitionForProfile } = require('../src/media/google-media-session-manager');
const { GOOGLE_LOGIN_URL, observedStatus, flowLaneCount, mediaProfiles, GoogleMediaEngine, GoogleMediaProfileRuntime } = require('../src/media/google-media-engine');

// Bulk runs in 3 Flow tabs unless TEAMYRA_FLOW_LANES says otherwise (1-4).
assert.equal(flowLaneCount(undefined), 3);
assert.equal(flowLaneCount('1'), 1);
assert.equal(flowLaneCount('9'), 4);
assert.equal(flowLaneCount('nope'), 3);

// A probe that timed out is not a logout: the last known state stands.
{
  const failed = { loaded: true, probe_ok: false, probe_error: 'browser_failure: page script timed out' };
  const kept = observedStatus(failed, { connected: true, flow_ready: true }, 'visual');
  assert.equal(kept.signedIn, true);
  assert.equal(kept.unknown, true);
  assert.equal(kept.promptFound, true);
  assert.equal(observedStatus(failed, {}, 'visual').signedIn, false);
  assert.equal(observedStatus(failed, { music_signed_in: true }, 'music').signedIn, true);
  const seen = { loaded: true, probe_ok: true, signedIn: false };
  assert.equal(observedStatus(seen, { connected: true }, 'visual'), seen);
}

// Every enabled Google account takes bulk Flow work.
{
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamyra-media-profiles-'));
  const write = (id, meta) => {
    fs.mkdirSync(path.join(root, id));
    if (meta) fs.writeFileSync(path.join(root, id, 'teamyra-profile.json'), JSON.stringify(meta));
  };
  write('acct-b', { enabled: true, priority: 100 });
  write('acct-a', { enabled: true, priority: 100 });
  write('acct-off', { enabled: false });
  write('acct-bare');
  fs.writeFileSync(path.join(root, 'builtin-google.json'), JSON.stringify({ enabled: false }));
  assert.equal(mediaProfiles(root, path.join(root, 'builtin-google.json'))[0].enabled, false, 'the built-in account can be disabled');
  fs.unlinkSync(path.join(root, 'builtin-google.json'));
  const listed = mediaProfiles(root, path.join(root, 'builtin-google.json'));
  fs.rmSync(root, { recursive: true, force: true });
  assert.deepEqual(listed.map(item => item.id).sort(), ['acct-a', 'acct-b', 'acct-bare', 'acct-off', 'google']);
  assert.equal(listed.find(item => item.id === 'acct-off').enabled, false);

  const engine = new GoogleMediaEngine({ window: null, listProfiles: () => listed });
  assert.deepEqual(engine.enabledProfiles(), ['google', 'acct-a', 'acct-b', 'acct-bare'], 'built-in first, then by priority and name');
  const wakes = [];
  const fake = (id, connected) => ({
    profileId: id,
    lastStatus: { connected, challenged: false },
    working() { return this.lastStatus.connected === true; },
    wake(surface, options) { wakes.push({ id, surface, requireConnected: options?.requireConnected }); return { connected, needs_user_auth: connected ? false : null }; }
  });
  for (const [id, connected] of [['google', true], ['acct-a', false], ['acct-b', true], ['acct-bare', false]]) engine.profiles.set(id, fake(id, connected));
  const woken = engine.wakeAll('visual');
  assert.deepEqual(wakes.map(item => item.id), ['google', 'acct-a', 'acct-b', 'acct-bare'], 'every enabled account is woken, the disabled one is not');
  assert.ok(wakes.every(item => item.requireConnected === true), 'an account starts claiming only once verified signed in');
  assert.equal(woken.accounts.length, 4);
  assert.equal(woken.tabs_per_account, flowLaneCount());
  assert.equal(woken.needs_user_auth, false);

  wakes.length = 0;
  engine.wakeAll('music');
  assert.deepEqual(wakes, [{ id: 'google', surface: 'music', requireConnected: undefined }], 'Flow Music stays on the active account');

  // Nobody known to work: the active account starts as before so jobs can report sign-in.
  for (const runtime of engine.profiles.values()) runtime.lastStatus.connected = false;
  wakes.length = 0;
  engine.wakeAll('visual');
  assert.deepEqual(wakes.filter(item => item.requireConnected === false).map(item => item.id), ['google']);

  // Single jobs go to the active account while it works, else the first working one.
  engine.profiles.get('acct-b').lastStatus.connected = true;
  assert.equal(engine.mainProfileId(), 'acct-b');
  engine.profiles.get('google').lastStatus.connected = true;
  assert.equal(engine.mainProfileId(), 'google');
  assert.equal(engine.otherWorking('google'), true);
  assert.equal(engine.otherWorking('acct-b'), true);
  engine.profiles.get('acct-b').lastStatus.connected = false;
  assert.equal(engine.otherWorking('google'), false);

  // An account that stops working is parked only when another one works.
  const consumer = () => ({ pausedUntil: 0, pauseReason: '' });
  const runtime = {
    profileId: 'acct-a', engine, parkedUntil: 0, parkReason: '', consumers: [consumer(), consumer()],
    lastStatus: { connected: true, challenged: false }, stopped: false,
    visualConsumers() { return this.consumers; },
    setConsumerState(kind, enabled) { if (kind === 'visual' && !enabled) this.stopped = true; }
  };
  const problem = GoogleMediaProfileRuntime.prototype.accountProblem;
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(problem.call(runtime, 'credits', 'out of credits'), true, 'google still works, so acct-a parks');
    assert.ok(runtime.parkedUntil > Date.now() + 20 * 60 * 1000);
    assert.ok(runtime.consumers.every(item => item.pausedUntil === runtime.parkedUntil), 'every tab of the account stops claiming');
    assert.equal(runtime.stopped, false, 'out of credits keeps watching accepted generations');
    runtime.parkedUntil = 0;
    assert.equal(problem.call(runtime, 'upload_terms', 'terms'), true, 'upload terms not accepted parks the account for a while');
    assert.ok(runtime.parkedUntil > Date.now() + 10 * 60 * 1000 && runtime.parkedUntil < Date.now() + 25 * 60 * 1000);
    GoogleMediaProfileRuntime.prototype.unpark.call(runtime);
    assert.ok(runtime.parkedUntil === 0 && runtime.consumers.every(item => item.pausedUntil === 0), 'opening the account lets it work again');
    assert.equal(problem.call(runtime, 'signed_out', 'Google Media sign-in is required'), true);
    assert.equal(runtime.stopped, true);
    assert.equal(runtime.lastStatus.connected, false);
    engine.profiles.get('google').lastStatus.connected = false;
    const alone = { ...runtime, profileId: 'google', stopped: false, lastStatus: { connected: true } };
    assert.equal(problem.call(alone, 'signed_out', 'x'), false, 'the only signed-out account keeps the old behaviour');
    assert.equal(alone.stopped, false);
    alone.parkedUntil = 0;
    assert.equal(problem.call(alone, 'credits', 'x'), true, 'out of credits parks even the only account: jobs wait instead of failing');
    assert.ok(alone.parkedUntil > Date.now());

    // Generate found disabled again and again (Flow's out-of-credits state)
    // parks the account; one successful click resets the count.
    const blocked = { ...runtime, generateBlocked: 0, parkedUntil: 0, accountProblem(kind) { this.parked = kind; return true; } };
    const submitResult = GoogleMediaProfileRuntime.prototype.submitResult;
    assert.deepEqual([1, 2, 3].map(() => submitResult.call(blocked, false)), ['counted', 'counted', 'counted']);
    assert.equal(submitResult.call(blocked, true), 'ok');
    assert.deepEqual([1, 2, 3].map(() => submitResult.call(blocked, false)), ['counted', 'counted', 'counted']);
    assert.equal(submitResult.call(blocked, false), 'parked');
    assert.equal(blocked.parked, 'credits');

    // A disabled account stops claiming; one enabled again starts.
    const gate = new GoogleMediaEngine({ window: null, listProfiles: () => listed });
    const working = GoogleMediaProfileRuntime.prototype.working;
    const tab = { profileId: 'acct-off', engine: gate, visualConsumerStarted: true, parkedUntil: 0, lastStatus: { connected: true } };
    assert.equal(working.call(tab), false, 'disabled');
    assert.equal(working.call({ ...tab, profileId: 'acct-a' }), true);
    assert.equal(working.call({ ...tab, profileId: 'acct-a', parkedUntil: Date.now() + 1000 }), false, 'parked');
    assert.equal(working.call({ ...tab, profileId: 'acct-a', lastStatus: { connected: false } }), false, 'signed out');
  } finally {
    console.warn = warn;
  }
}

// Out of credits shows as a button label ("Insufficient credits warning").
{
  const credits = new GoogleFlowAutomationAdapter({});
  const base = { url: 'https://flow.google.com/project/p', lower: 'new project', buttonLabels: ['Settings trigger Video', 'Agent'] };
  assert.equal(credits.classifyProbe(base).creditsExhausted, false);
  assert.equal(credits.classifyProbe({ ...base, buttonLabels: [...base.buttonLabels, 'Insufficient credits warning info'] }).creditsExhausted, true);
}

assert.equal(FLOW_HOME, 'https://flow.google.com/');
assert.equal(FLOW_MUSIC_HOME, 'https://www.flowmusic.app/');
assert.match(GOOGLE_LOGIN_URL, /^https:\/\/accounts\.google\.com\//);
assert.equal(partitionForProfile('google'), 'persist:teamyra-google-media-profile');
assert.equal(partitionForProfile('Google Media 2'), 'persist:teamyra-google-media-google-media-2');
assert.notEqual(partitionForProfile('google'), partitionForProfile('Google Media 2'));

const flow = new GoogleFlowAutomationAdapter({});
assert.equal(flow.classifyProbe({ lower: 'sign in', promptFound: false }).signedIn, false);
assert.equal(flow.classifyProbe({ lower: 'verify you are human', promptFound: false }).challenged, true);
assert.equal(flow.classifyProbe({ lower: 'too many requests', promptFound: true }).rateLimited, true);
assert.equal(flow.classifyProbe({
  url: 'https://flow.google.com/',
  lower: 'history workspace',
  promptFound: false,
  buttonLabels: ['Home', 'New project', 'Account details ULTRA'],
  controls: [{ label: 'Google Account: Test User', href: 'https://accounts.google.com/SignOutOptions?continue=https://flow.google.com/' }]
}).signedIn, true);
assert.equal(flow.classifyProbe({
  url: 'https://flow.google.com/',
  lower: 'welcome',
  promptFound: false,
  buttonLabels: ['Sign in'],
  controls: [{ label: 'Sign in', href: 'https://accounts.google.com/ServiceLogin' }]
}).signedIn, false);

const music = new GoogleFlowMusicAutomationAdapter({});
assert.equal(music.classifyProbe({ lower: 'choose an account' }).signedIn, false);
assert.equal(music.classifyProbe({ lower: 'unusual activity' }).challenged, true);
assert.equal(music.classifyProbe({
  url: 'https://www.flowmusic.app/suburbanplatform',
  lower: 'songs playlists spaces',
  labels: ['New session', 'Profile', 'Settings menu suburbanplatform MEMBER', 'Songs (0)']
}).signedIn, true);

assert.deepEqual(classifyError(new Error('selector_failure: missing button')), {
  state: 'failed', category: 'selector_failure'
});
assert.deepEqual(classifyError(new Error('rate_limited')), {
  state: 'rate_limited', category: 'rate_limited'
});
assert.ok(resolveFfmpeg(), 'ffmpeg-static should resolve to a bundled binary path');

console.log('media automation contract tests passed');
