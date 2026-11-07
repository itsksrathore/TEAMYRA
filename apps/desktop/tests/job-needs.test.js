const assert = require('node:assert/strict');
const { jobNeed } = require('../src/job-needs');

// What the Tasks view shows on a task that needs the user.
const need = (meta, done = false) => jobNeed(meta, done).need;

// Captcha: a site's human check, while waiting or paused in a job.
assert.equal(need({ state: 'waiting_for_desktop', attention: { kind: 'qwen_verification', message: 'Qwen asks for human verification.' } }), 'captcha');
assert.equal(need({ state: 'needs_user', reason: 'deepseek_verification' }), 'captcha');
assert.equal(need({ state: 'needs_user', last_event: 'needs_user: GLM verification required' }), 'captcha');
assert.equal(jobNeed({ state: 'needs_user', attention: { kind: 'glm_verification', message: 'Solve the check' } }).needMessage, 'Solve the check');

// Action: sign-in, a stuck page, any job paused for the user.
assert.equal(need({ state: 'waiting_for_desktop', attention: { kind: 'chatgpt_sign_in' } }), 'action');
assert.equal(need({ state: 'waiting_for_desktop', attention: { kind: 'qwen_stuck' } }), 'action');
assert.equal(need({ state: 'needs_user', reason: 'permission' }), 'action');
assert.equal(need({ state: 'waiting_for_desktop', last_event: 'waiting: ChatGPT sign-in required in TEAMYRA Desktop' }), 'action');

// Nothing: normal work, and finished jobs whatever they say.
assert.equal(need({ state: 'running', last_event: 'deepseek generating 30 s' }), '');
assert.equal(need({ state: 'queued' }), '');
assert.equal(need({ state: 'failed', attention: { kind: 'qwen_verification' } }), '');
assert.equal(need({ state: 'needs_user', attention: { kind: 'qwen_verification' } }, true), '', 'a job with DONE needs nothing');

console.log('task needs (captcha / action required) tests passed');
