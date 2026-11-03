const fs = require('node:fs');
const path = require('node:path');
const { GoogleVidsProvider } = require('./google-vids-provider');

// Developer tool for learning the Google Vids UI from a Google Media
// account's own session (only when TEAMYRA_DEV_DEBUG=1): open a page, take a
// screenshot, list the visible controls, click, type, run a script, and catch
// a download. Never part of normal operation.
// Kept across reloads of this module (it is re-required on every call).
const store = globalThis.__teamyraVidsDebug || (globalThis.__teamyraVidsDebug = { tabs: new Map(), downloads: new Map() });
const { tabs, downloads } = store;

function tab(engine, window, profileId, name = 'debug') {
  const runtime = engine.ensureProfile(profileId || 'google');
  const key = runtime.profileId + ':' + name;
  if (!tabs.has(key)) tabs.set(key, { runtime, provider: new GoogleVidsProvider({ window, sessionManager: runtime.sessionManager }) });
  return tabs.get(key);
}

const CONTROLS = `(() => {
  const visible = el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && r.bottom > 0 && r.top < innerHeight; };
  const nodes = [...document.querySelectorAll('button,[role=button],[role=menuitem],[role=tab],[role=option],[role=checkbox],[role=radio],[role=switch],a[href],input,textarea,[contenteditable=true],[role=textbox],select,video')].filter(visible);
  return { url: location.href, title: document.title, controls: nodes.slice(0, 250).map(el => { const r = el.getBoundingClientRect();
    return { tag: el.tagName.toLowerCase(), role: el.getAttribute('role') || '', label: (el.getAttribute('aria-label') || el.getAttribute('data-tooltip') || '').slice(0, 80),
      text: (el.innerText || el.value || el.placeholder || '').replace(/\\s+/g, ' ').trim().slice(0, 80),
      x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2),
      state: [el.disabled ? 'disabled' : '', el.getAttribute('aria-pressed') === 'true' ? 'pressed' : '', el.getAttribute('aria-checked') === 'true' ? 'checked' : '', el.getAttribute('aria-selected') === 'true' ? 'selected' : '', el.getAttribute('aria-expanded') === 'true' ? 'expanded' : ''].filter(Boolean).join(','),
      src: el.tagName === 'VIDEO' ? (el.currentSrc || el.src || '').slice(0, 160) : undefined }; }) };
})()`;

async function vidsDebug(engine, window, payload = {}) {
  // On with TEAMYRA_DEV_DEBUG=1 or the file .teamyra-desktop/dev-debug (a desktop
  // the gateway restarts does not inherit environment variables).
  const flag = path.resolve(__dirname, '..', '..', '..', '..', '.teamyra-desktop', 'dev-debug');
  if (process.env.TEAMYRA_DEV_DEBUG !== '1' && !fs.existsSync(flag)) throw new Error('vids.debug needs TEAMYRA_DEV_DEBUG=1');
  globalThis.__teamyraVidsActiveAt = Date.now();
  // vids_tab: inspect a worker's own Vids tab instead of the debug tab.
  const current = payload.vids_tab
    ? (() => { const runtime = engine.ensureProfile(payload.profile_id || 'google');
      return { runtime, provider: runtime.vidsTabs[Number(payload.vids_tab) - 1].provider }; })()
    : tab(engine, window, payload.profile_id, payload.tab || 'debug');
  const { provider, runtime } = current;
  const contents = () => provider.ensureView().webContents;
  switch (payload.op) {
    case 'open': return { url: await provider.load(String(payload.url || 'https://vids.new')) };
    case 'url': return { url: provider.view ? contents().getURL() : '' };
    case 'debug_step': return { step: store.lastAdapter?.step || null };
    case 'worker': {
      // A Vids worker's state without touching its page.
      const runtime = engine.ensureProfile(payload.profile_id || 'google');
      return runtime.vidsTabs.map(item => ({ ...item.consumer.status(), step: item.provider.adapter?.step || null,
        busy: item.consumer.busy, view: Boolean(item.provider.view) }));
    }
    case 'bounds': {
      provider.bounds = { x: 0, y: 0, width: Number(payload.width) || 1600, height: Number(payload.height) || 1000 };
      provider.ensureView().setBounds(provider.bounds);
      return provider.bounds;
    }
    case 'shot': {
      const file = path.resolve(String(payload.file));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const wc = contents();
      try {
        const image = await wc.capturePage();
        if (image.isEmpty()) throw new Error('empty capture');
        fs.writeFileSync(file, image.toPNG());
        return { file, size: image.getSize(), url: wc.getURL() };
      } catch {
        // A hidden view has no display surface; DevTools can still render it.
        if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
        const shot = await wc.debugger.sendCommand('Page.captureScreenshot', { format: 'png', fromSurface: true });
        fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
        return { file, url: wc.getURL(), via: 'devtools' };
      }
    }
    case 'dom': return contents().executeJavaScript(CONTROLS, true);
    case 'click': {
      const x = Math.round(Number(payload.x)); const y = Math.round(Number(payload.y));
      const wc = contents();
      wc.sendInputEvent({ type: 'mouseMove', x, y });
      wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
      wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
      await new Promise(resolve => setTimeout(resolve, Number(payload.wait_ms) || 800));
      return { clicked: [x, y], url: wc.getURL() };
    }
    case 'type': {
      await contents().insertText(String(payload.text || ''));
      return { typed: String(payload.text || '').length };
    }
    case 'key': {
      const wc = contents();
      for (const type of ['keyDown', 'char', 'keyUp']) {
        if (type === 'char' && String(payload.key).length !== 1) continue;
        wc.sendInputEvent({ type, keyCode: String(payload.key), modifiers: payload.modifiers || [] });
      }
      return { key: payload.key };
    }
    case 'eval': return contents().executeJavaScript(String(payload.script || 'null'), true);
    case 'upload': {
      // Answer the next file chooser with these files (through the debugger).
      const wc = contents();
      const files = (payload.files || []).map(file => path.resolve(String(file)));
      if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
      await wc.debugger.sendCommand('Page.setInterceptFileChooserDialog', { enabled: true });
      const onEvent = async (_event, method, params) => {
        if (method !== 'Page.fileChooserOpened') return;
        wc.debugger.removeListener('message', onEvent);
        await wc.debugger.sendCommand('DOM.setFileInputFiles', { files, backendNodeId: params.backendNodeId }).catch(() => {});
        await wc.debugger.sendCommand('Page.setInterceptFileChooserDialog', { enabled: false }).catch(() => {});
      };
      wc.debugger.on('message', onEvent);
      return { armed: files };
    }
    case 'expect_download': {
      const file = path.resolve(String(payload.file));
      const key = runtime.profileId + ':' + file;
      const record = { file, state: 'waiting', at: Date.now() };
      downloads.set(key, record);
      runtime.downloadManager.expect({ jobId: 'vids-debug-' + Date.now(), webContentsId: contents().id, destination: file,
        timeoutMs: Number(payload.timeout_ms) || 600000 })
        .then(result => Object.assign(record, { state: 'done', result }))
        .catch(error => Object.assign(record, { state: 'failed', error: String(error?.message || error) }));
      return record;
    }
    case 'set_file': {
      // Put files straight into a page's <input type=file> (no picker).
      const wc = contents();
      if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
      const { root } = await wc.debugger.sendCommand('DOM.getDocument', { depth: -1, pierce: true });
      const { nodeIds } = await wc.debugger.sendCommand('DOM.querySelectorAll', { nodeId: root.nodeId,
        selector: String(payload.selector || 'input[type=file]') });
      const nodeId = nodeIds[Number(payload.index) || 0];
      if (!nodeId) return { error: 'no matching file input', count: nodeIds.length };
      await wc.debugger.sendCommand('DOM.setFileInputFiles', { nodeId, files: (payload.files || []).map(file => path.resolve(String(file))) });
      return { inputs: nodeIds.length, set: payload.files };
    }
    case 'adapter': {
      // Call a GoogleVidsAdapter method on this tab (re-read each call).
      delete require.cache[require.resolve('./google-vids-adapter')];
      const { GoogleVidsAdapter } = require('./google-vids-adapter');
      const adapter = new GoogleVidsAdapter(contents());
      adapter.chooserHooked = Boolean(current.chooserHooked);
      store.lastAdapter = adapter;
      const started = Date.now();
      try {
        const result = await adapter[payload.method](...(payload.args || []));
        current.chooserHooked = adapter.chooserHooked;
        return { ok: true, ms: Date.now() - started, result };
      } catch (error) {
        return { ok: false, ms: Date.now() - started, error: String(error?.message || error) };
      }
    }
    case 'download_status': return [...downloads.values()];
    case 'fetch': {
      // Save a URL (e.g. a generated clip's video src) with the account's session.
      const file = path.resolve(String(payload.file));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      let url = String(payload.url || '');
      if (!url && payload.video_index !== undefined) {
        url = await contents().executeJavaScript(`[...document.querySelectorAll('video')].map(v => v.currentSrc || v.src)[${Number(payload.video_index)}] || ''`, true);
      }
      const response = await runtime.sessionManager.getSession().fetch(url);
      const buffer = Buffer.from(await response.arrayBuffer());
      fs.writeFileSync(file, buffer);
      return { status: response.status, type: response.headers.get('content-type'), bytes: buffer.length, file,
        disposition: response.headers.get('content-disposition') };
    }
    case 'close': provider.destroy(); tabs.delete(runtime.profileId + ':' + (payload.tab || 'debug')); return { closed: true };
    default: throw new Error('unknown vids.debug op: ' + payload.op);
  }
}

module.exports = { vidsDebug };
