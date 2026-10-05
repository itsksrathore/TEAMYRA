const assert = require('node:assert/strict');
const { GoogleFlowAutomationAdapter, FLOW_HOME } = require('../src/media/google-flow-automation-adapter');
const { GoogleFlowMusicAutomationAdapter, FLOW_MUSIC_HOME } = require('../src/media/google-flow-music-automation-adapter');
const { classifyError } = require('../src/media/media-job-consumer');
const { resolveFfmpeg } = require('../src/media/media-audio-processor');
const { partitionForProfile } = require('../src/media/google-media-session-manager');
const { GOOGLE_LOGIN_URL } = require('../src/media/google-media-engine');

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
