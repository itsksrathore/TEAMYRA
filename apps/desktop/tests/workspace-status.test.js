const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const Module = { exports: {} };
const calls = [];
vm.runInNewContext(fs.readFileSync(require.resolve('../src/workspace-bridge'), 'utf8'), {
  module: Module, process, Date,
  require(name) {
    if (name === 'electron') return { app: {} };
    if (name === './core-api') return { callCore: (action) => new Promise(resolve => calls.push({ action, resolve })) };
    return require(name);
  }
});
const bridge = Object.create(Module.exports.WorkspaceBridge.prototype);
Object.assign(bridge, { token: 'test', statusCache: null, statusPending: null, statusGeneration: 0 });
(async () => {
  const first = bridge.status();
  assert.equal(bridge.status(), first);
  assert.equal(calls.length, 1);
  calls[0].resolve({ workspace: 'old' });
  await first;
  assert.equal((await bridge.status()).workspace, 'old');
  assert.equal(calls.length, 1);
  bridge.statusCache.at = 0;
  const stale = bridge.status();
  const configure = bridge.configure('new');
  calls[2].resolve({ ok: true });
  await configure;
  const fresh = bridge.status();
  calls[1].resolve({ workspace: 'old' });
  await stale;
  assert.equal(bridge.statusPending, fresh);
  calls[3].resolve({ workspace: 'new' });
  await fresh;
  assert.equal((await bridge.status()).workspace, 'new');
  console.log('workspace status caching and invalidation tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
