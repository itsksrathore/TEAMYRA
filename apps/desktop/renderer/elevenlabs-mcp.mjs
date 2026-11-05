const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export async function openElevenLabsMcp(profile, onChange = () => {}, { startLogin = false } = {}) {
  await Promise.all([window.teamyra.setGoogleMediaVisible(false).catch(() => {}), window.teamyra.setChatgptVisible(false).catch(() => {})]);
  const existing = document.querySelector('#elevenLabsMcpDialog');
  if (existing) { existing.showModal(); return; }
  const dialog = document.createElement('dialog');
  dialog.id = 'elevenLabsMcpDialog';
  dialog.className = 'glass-dialog bulk-dialog';
  dialog.setAttribute('aria-labelledby', 'elevenLabsMcpTitle');
  dialog.innerHTML = `<div class="dialog-card">
    <div class="dialog-head"><div><span class="micro-label">ELEVENLABS · OFFICIAL MCP</span><h2 id="elevenLabsMcpTitle">${escape(profile.name || profile.id)}</h2></div>
    <button type="button" data-close class="icon-btn" aria-label="Close">×</button></div>
    <p class="bulk-summary">Connect your ElevenLabs workspace through its official hosted MCP. Complete OAuth sign-in in the browser and confirm the intended account/workspace.</p>
    <p class="bulk-summary"><code>https://api.us.elevenlabs.io/v1/mcp</code></p>
    <p data-state class="bulk-summary" role="status">Checking MCP connection…</p>
    <div class="dialog-actions"><button type="button" data-refresh class="btn quiet">Load tools</button><button type="button" data-connect class="btn primary">Connect / Login</button></div>
    <p class="bulk-summary">Connect / Login opens official ElevenLabs authorization in your browser. The browser may reuse its current signed-in account. To connect another account, switch accounts on ElevenLabs in that browser, then select Connect again. Other profiles keep their connections.</p>
    <form data-form>
      <div class="bulk-folder"><label class="bulk-field"><span>Available MCP tool</span><select data-tool required><option value="">Connect to discover tools</option></select></label></div>
      <p data-description class="bulk-summary"></p>
      <details class="bulk-summary"><summary>Tool input schema</summary><pre data-schema></pre></details>
      <label class="task-prompt"><textarea data-arguments required aria-label="MCP tool arguments as JSON" spellcheck="false" placeholder='{"text": "Namaste"}'>{}</textarea></label>
      <p class="bulk-summary">Tool calls use this account's permissions and credits. Agents can use the same connection through TEAMYRA's MCP pool.</p>
      <div data-error class="dialog-error" role="alert" hidden></div>
      <div class="dialog-actions"><button type="submit" data-run class="btn quiet" disabled>Run selected tool</button></div>
    </form>
    <pre data-result class="bulk-summary" style="white-space:pre-wrap;overflow-wrap:anywhere;max-height:240px;overflow:auto"></pre>
  </div>`;
  document.body.append(dialog);
  const $ = selector => dialog.querySelector(selector);
  let tools = [];
  let busy = false;
  let loggedIn = false;
  function showState(state) {
    $('[data-state]').textContent = state.state === 'connected'
      ? `MCP connected · ${state.toolCount} tools · server: ${state.server}`
      : state.state === 'connecting' ? state.phase === 'loading_tools'
        ? 'Browser authorization received. Loading ElevenLabs MCP tools…'
        : 'Complete ElevenLabs sign-in in the browser. This window will update automatically…'
      : `MCP ${state.state.replaceAll('_', ' ')} · server: ${state.server}`;
    loggedIn = state.state === 'connected' || state.savedLogin === true;
    $('[data-connect]').textContent = loggedIn ? 'Switch account' : 'Connect / Login';
  }
  async function run(fn) {
    if (busy) return;
    busy = true;
    $('[data-error]').hidden = true;
    $('[data-connect]').disabled = true;
    $('[data-refresh]').disabled = true;
    $('[data-run]').disabled = true;
    try { await fn(); }
    catch (error) {
      $('[data-error]').textContent = String(error?.message || error).replace(/^Error invoking remote method '[^']+': Error: /, '');
      $('[data-error]').hidden = false;
      $('[data-state]').textContent = 'MCP request did not complete. No tool call was automatically retried.';
    } finally {
      busy = false;
      if (dialog.isConnected) {
        $('[data-connect]').disabled = false;
        $('[data-refresh]').disabled = false;
        $('[data-run]').disabled = !tools.length;
      }
      await Promise.resolve().then(onChange).catch(() => {});
    }
  }
  $('[data-close]').onclick = () => dialog.close();
  const unsubscribe = window.teamyra.onElevenLabsMcpState(state => {
    if (state.profileId === profile.id && dialog.isConnected) showState(state);
  });
  dialog.addEventListener('close', () => { unsubscribe(); dialog.remove(); }, { once: true });
  $('[data-tool]').onchange = () => {
    const tool = tools.find(t => t.name === $('[data-tool]').value);
    $('[data-description]').textContent = tool?.description || '';
    $('[data-schema]').textContent = JSON.stringify(tool?.inputSchema || {}, null, 2);
  };
  const connect = reauthorize => run(async () => {
    $('[data-state]').textContent = 'Connecting to official ElevenLabs MCP. Complete OAuth sign-in in the browser if prompted…';
    const result = reauthorize ? await window.teamyra.elevenLabsMcpReauthorize(profile.id) : await window.teamyra.elevenLabsMcpConnect(profile.id);
    tools = result.tools;
    $('[data-tool]').innerHTML = tools.map(tool => `<option value="${escape(tool.name)}">${escape(tool.name)}</option>`).join('');
    $('[data-tool]').dispatchEvent(new Event('change'));
    $('[data-refresh]').textContent = 'Refresh tools';
    showState(result);
  });
  // Switch account starts a new sign-in; Connect / Login uses this profile's
  // own store (the browser opens only when it holds no login).
  $('[data-connect]').onclick = () => connect(loggedIn);
  $('[data-refresh]').onclick = () => connect(false);
  $('[data-form]').onsubmit = event => {
    event.preventDefault();
    run(async () => {
      const args = JSON.parse($('[data-arguments]').value);
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Tool arguments must be a JSON object');
      $('[data-state]').textContent = 'Calling ElevenLabs MCP…';
      const result = await window.teamyra.elevenLabsMcpCall({ profileId: profile.id, toolName: $('[data-tool]').value, arguments: args });
      $('[data-result]').textContent = JSON.stringify(result.result, null, 2);
      $('[data-state]').textContent = result.result?.isError ? 'ElevenLabs returned a tool error. See the response below.' : 'MCP tool response received.';
    });
  };
  dialog.showModal();
  if (startLogin) await connect(false);
  else {
    const state = await window.teamyra.elevenLabsMcpStatus(profile.id);
    showState(state);
    // A saved login loads its tools without a new browser sign-in.
    if (state.state === 'connected' || state.state === 'connecting' || state.savedLogin === true) await connect(false);
  }
}
