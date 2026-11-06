const assert = require('node:assert/strict');
const path = require('node:path');

// One long-lived TEAMYRA Core process answers the desktop's calls, many at
// once; a new process per call cost ~600 ms each. Uses the real core.
process.env.TEAMYRA_ROOT = process.env.TEAMYRA_ROOT || path.resolve(__dirname, '..', '..', '..');
const { callCore, coreServer } = require('../src/core-api');

(async () => {
  const payload = { provider_url: 'https://example.invalid/none' };
  await callCore('media.claimed-keys', payload);
  const server = coreServer.child;
  assert.ok(server, 'the first call starts one core process');

  const answers = await Promise.all(Array.from({ length: 30 }, () => callCore('media.claimed-keys', payload)));
  assert.equal(answers.length, 30);
  assert.equal(coreServer.child, server, 'the same process answers every call');
  assert.equal(coreServer.pending.size, 0);

  await assert.rejects(callCore('no.such-action'), /unsupported desktop core action/);
  await assert.rejects(callCore('bad action!'), /Invalid core action/);

  // Without the process (stopped, or TEAMYRA_CORE_PER_CALL=1), a call runs
  // in a process of its own, as before.
  coreServer.stop();
  process.env.TEAMYRA_CORE_PER_CALL = '1';
  const single = await callCore('media.claimed-keys', payload);
  assert.deepEqual(single, answers[0]);
  assert.equal(coreServer.child, null);
  console.log('core server tests passed');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
