const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const Module = { exports: {} };
const calls = [];
vm.runInNewContext(fs.readFileSync(require.resolve('../src/workspace-bridge'), 'utf8'), {
  module: Module, process, Date,
  require(name) {
    if (name === 'electron') return { app: {} };
    if (name === './core-api') return { callCore: (action, payload, options) => new Promise(resolve => calls.push({ action, payload, options, resolve })) };
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
  const regular = bridge.configure('project', { terminal: true });
  const regularCall = calls.at(-1);
  assert.equal(regularCall.payload.access, undefined);
  assert.equal(regularCall.payload.user_confirmed, undefined);
  regularCall.resolve({ ok: true });
  await regular;
  const access = { full_access: true, outside_workspace: true, destructive_without_confirmation: true };
  const confirmed = bridge.configure('project', { terminal: true }, access);
  assert.equal(calls.at(-1).payload.access, access);
  assert.equal(calls.at(-1).payload.user_confirmed, true);
  calls.at(-1).resolve({ ok: true });
  await confirmed;
  for (const requested of [undefined, 120, 600, 1800, 9999]) {
    for (const explicit of [false, true]) {
      const args = { argv: ['python', '-m', 'unittest'], timeout_seconds: requested };
      const result = explicit ? bridge.executeInWorkspace('project', 'terminal.run', args) : bridge.execute('terminal.run', args);
      const call = calls.at(-1);
      const expected = requested > 120 ? Math.min(requested, 1800) * 1000 + 15000 : 135000;
      assert.equal(call.options.timeout, expected);
      call.resolve({ ok: true });
      await result;
    }
  }

  // Exercise the actual IPC handler with the native confirmation dialog stubbed.
  const main = fs.readFileSync(require.resolve('../src/main'), 'utf8');
  const handlers = new Map();
  const configured = [];
  let current = { full_access: false, outside_workspace: false, destructive_without_confirmation: false };
  let answer = 1;
  let dialogs = 0;
  const provider = { workspaceBridge: {
    status: async () => ({ permissions: current }),
    configure: async (...args) => { configured.push(args); return { ok: true }; }
  } };
  const context = vm.createContext({
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    activeChatgptProvider: () => provider,
    ensureChatgptProvider: async () => provider,
    BrowserWindow: { fromWebContents: () => null, getFocusedWindow: () => null },
    dialog: { showMessageBox: async () => { dialogs++; return { response: answer }; } },
    provider
  });
  vm.runInContext(main.slice(main.indexOf('const ELEVATED_CHATGPT_PERMISSIONS'), main.indexOf("ipcMain.handle('teamyra:chatgpt-select-workspace'")), context);
  const userConfigure = handlers.get('teamyra:chatgpt-workspace-configure');
  const requested = { terminal: true, ...access };
  answer = 0;
  assert.equal((await userConfigure({ sender: {} }, 'project', requested)).cancelled, true);
  assert.equal(configured.length, 0);
  answer = 1;
  await userConfigure({ sender: {} }, 'project', requested);
  assert.equal(dialogs, 2);
  assert.equal(JSON.stringify(configured.at(-1)), JSON.stringify(['project', { terminal: true }, access]));
  assert.equal(requested.full_access, true, 'must not mutate the caller payload');
  // The destructive-only toggle also uses access after confirmation.
  current = { full_access: true, outside_workspace: true, destructive_without_confirmation: false };
  await userConfigure({ sender: {} }, 'project', { destructive_without_confirmation: true });
  assert.equal(dialogs, 3);
  assert.equal(JSON.stringify(configured.at(-1)), JSON.stringify(['project', {}, { destructive_without_confirmation: true }]));

  current = { full_access: false, outside_workspace: false, destructive_without_confirmation: false };
  context.cmd = 'workspace_configure';
  context.payload = { workspace: 'project', permissions: requested, access, user_confirmed: true };
  const automated = main.slice(main.indexOf("if (cmd === 'workspace_configure') {"), main.indexOf("if (cmd === 'changes')"));
  await vm.runInContext('(async () => { ' + automated + ' })()', context);
  const automationCall = configured.at(-1);
  assert.equal(automationCall.length, 2, 'control/MCP must send permissions only');
  for (const key of Object.keys(access)) assert.equal(automationCall[1][key], false);
  assert.equal(dialogs, 3, 'automation cannot raise access via a native dialog');
  console.log('workspace status, user-only access IPC and long timeout tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
