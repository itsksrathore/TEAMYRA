const path = require('node:path');

// Google Vids "AI video clip" panel (Omni). Learned from the live UI:
// - Create / Edit / Animate / Extend modes; prompt is a contenteditable box.
// - Reference images enter through <input type=file accept="image/png, image/jpeg">
//   (one per upload; the input reappears from Ingredients or Add > Upload) and
//   show as "Image1".. chips in the prompt.
// - Generation settings: Omni, 720p/1080p, Landscape/Portrait, duration.
// - Several generations may run at once in one tab; each shows as a card with
//   its prompt and a percentage, then as <video aria-label="Generated video: …">
//   whose src is a direct download URL (1080p MP4 with audio).
// - Results live only in the open tab: reloading loses them.
// Buttons respond to element.click(); synthetic mouse events miss some of them.

const SCRIPT_TIMEOUT_MS = 60000;

function normalize(text) {
  return String(text || '').normalize('NFKC').replace(/[\u200b\u00a0]/g, ' ')
    .replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/\s+/g, ' ').trim().toLowerCase();
}

// A card's prompt as Vids labels it:
// "Generated video: Image1Image2 <prompt>, 1080p, 10 seconds".
function cardPrompt(label) {
  return normalize(String(label || '').replace(/^generated video:\s*/i, '').replace(/^(?:@?image\d+\s*)+/i, '')
    .replace(/,\s*(?:360p|720p|1080p|4k)(?:,\s*\d+(?:\.\d+)?\s*seconds?)?\s*$/i, ''));
}

function samePrompt(cardText, prompt) {
  const card = cardPrompt(cardText);
  const wanted = normalize(prompt);
  if (!card || !wanted) return false;
  // Labels may be cut short; compare what both have.
  const length = Math.min(card.length, wanted.length, 400);
  return length >= Math.min(40, wanted.length) && card.slice(0, length) === wanted.slice(0, length);
}

class GoogleVidsAdapter {
  constructor(webContents) {
    this.webContents = webContents;
    this.chooserFiles = null;
    this.step = 'idle';
    // Page and DevTools calls still waiting for an answer (the tab must not be
    // closed under them).
    this.pending = 0;
  }

  async exec(source, timeoutMs = SCRIPT_TIMEOUT_MS) {
    let timer;
    this.pending += 1;
    try {
      return await Promise.race([
        this.webContents.executeJavaScript(source, true),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('browser_failure: Vids page script timed out')), timeoutMs); })
      ]);
    } finally { clearTimeout(timer); this.pending -= 1; }
  }

  async wait(read, label, timeoutMs = 20000, everyMs = 300) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = await read().catch(() => null);
      if (value) return value;
      await new Promise(resolve => setTimeout(resolve, everyMs));
    }
    throw new Error('selector_failure: Vids ' + label + ' did not become ready');
  }

  // Native file pickers would block a hidden window; answer them through
  // DevTools instead (Page.fileChooserOpened).
  async interceptFileChooser() {
    const wc = this.webContents;
    if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
    if (this.chooserHooked) return;
    this.chooserHooked = true;
    await this.cdp('Page.enable', {}, 8000).catch(() => {});
    await this.cdp('Page.setInterceptFileChooserDialog', { enabled: true }, 8000);
    wc.debugger.on('message', async (_event, method, params) => {
      if (method !== 'Page.fileChooserOpened') return;
      const files = this.chooserFiles || [];
      this.chooserFiles = null;
      if (files.length) {
        await wc.debugger.sendCommand('DOM.setFileInputFiles', { files, backendNodeId: params.backendNodeId }).catch(() => {});
      }
    });
  }

  async setInputFiles(selector, files) {
    const wc = this.webContents;
    if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
    const { root } = await wc.debugger.sendCommand('DOM.getDocument', { depth: -1, pierce: true });
    const { nodeIds } = await wc.debugger.sendCommand('DOM.querySelectorAll', { nodeId: root.nodeId, selector });
    if (!nodeIds.length) return false;
    await wc.debugger.sendCommand('DOM.setFileInputFiles', { nodeId: nodeIds[nodeIds.length - 1], files: files.map(file => path.resolve(file)) });
    return true;
  }

  // Click the first visible element whose aria-label or text matches.
  async click({ label = null, text = null, prefix = null, role = null } = {}) {
    return this.exec(`(() => {
      const label = ${JSON.stringify(label)}, text = ${JSON.stringify(text)}, prefix = ${JSON.stringify(prefix)}, role = ${JSON.stringify(role)};
      const visible = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const nodes = [...document.querySelectorAll(role ? '[role="' + role + '"]' : 'button,[role=button],[role=tab],[role=menuitemradio],[role=radio],[role=menuitem]')].filter(visible);
      const el = nodes.find(node => {
        const aria = node.getAttribute('aria-label') || '';
        const own = (node.innerText || node.textContent || '').trim();
        return (label !== null && aria === label) || (text !== null && own === text) || (prefix !== null && aria.startsWith(prefix));
      });
      if (!el || el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
      el.click();
      return true;
    })()`);
  }

  // Input through DevTools reaches a hidden tab; webContents.sendInputEvent
  // does not (a hidden view draws no frames to hit-test against).
  async cdp(method, params = {}, timeoutMs = 10000) {
    const wc = this.webContents;
    if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
    let timer;
    this.pending += 1;
    try {
      return await Promise.race([wc.debugger.sendCommand(method, params), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('browser_failure: DevTools ' + method + ' did not answer (step: ' + this.step + ')')), timeoutMs);
      })]);
    } finally { clearTimeout(timer); this.pending -= 1; }
  }

  // A hidden view only hit-tests input against a drawn frame: a tiny capture
  // makes Chromium draw the page as it is now.
  async drawFrame() {
    await this.cdp('Page.captureScreenshot', { format: 'jpeg', quality: 1, fromSurface: true,
      clip: { x: 0, y: 0, width: 1, height: 1, scale: 1 } }, 5000).catch(() => null);
  }

  async mouseClick(x, y) {
    await this.drawFrame();
    await this.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await this.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await this.cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  }

  async key(key) {
    await this.drawFrame();
    const codes = { Escape: 27, ArrowRight: 39, ArrowLeft: 37, Enter: 13 };
    const base = { key, code: key, windowsVirtualKeyCode: codes[key] || 0, nativeVirtualKeyCode: codes[key] || 0 };
    await this.cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
    await this.cdp('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  }

  // A real mouse click at the element's centre (some Vids controls, like the
  // side rail buttons, ignore element.click()).
  async press(target) {
    const point = await this.exec(`(() => {
      const t = ${JSON.stringify(target)};
      const visible = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const el = [...document.querySelectorAll('button,[role=button],[role=tab],[role=menuitem],[role=radio]')].filter(visible).find(node => {
        const aria = node.getAttribute('aria-label') || '';
        const own = (node.innerText || node.textContent || '').trim();
        return (t.label && aria === t.label) || (t.text && own === t.text) || (t.prefix && aria.startsWith(t.prefix));
      });
      if (!el) return null;
      el.scrollIntoView({ block: 'nearest' });
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`);
    if (!point) return false;
    await this.mouseClick(point.x, point.y);
    return true;
  }

  async state() {
    return this.exec(`(() => {
      const visible = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const welcome = [...document.querySelectorAll('[role=dialog][aria-label="Getting started"]')].some(visible);
      const tabs = [...document.querySelectorAll('[role=tab]')].filter(visible).map(el => ({ text: el.textContent.trim(), selected: el.getAttribute('aria-selected') === 'true' }));
      const box = [...document.querySelectorAll('[contenteditable=true]')].find(el => visible(el) && /describe|ingredients|what happens next|how you want/i.test(el.getAttribute('aria-label') || ''));
      const settings = [...document.querySelectorAll('button')].find(el => visible(el) && (el.getAttribute('aria-label') || '').startsWith('Generation settings'));
      const generate = [...document.querySelectorAll('button[aria-label=Generate]')].find(visible);
      return {
        url: location.href, welcome, tabs,
        panel: tabs.some(tab => tab.text === 'Create'),
        signedOut: /accounts\\.google\\.com/.test(location.href),
        prompt: box ? (box.innerText || '').trim() : null,
        promptLabel: box ? box.getAttribute('aria-label') : null,
        chips: [...document.querySelectorAll('button')].filter(el => visible(el) && /^Remove (image|video)\\b/i.test(el.getAttribute('aria-label') || '')).length,
        fileInputs: document.querySelectorAll('input[type=file]').length,
        settings: settings ? settings.getAttribute('aria-label') : null,
        generate: generate ? !generate.disabled && generate.getAttribute('aria-disabled') !== 'true' : null,
        collapsed: [...document.querySelectorAll('button[aria-label=Expand]')].some(visible)
      };
    })()`);
  }

  // Every result card in the panel, in page order.
  async cards() {
    return this.exec(`(() => {
      const out = [];
      for (const video of document.querySelectorAll('video[aria-label^="Generated video"]')) {
        out.push({ kind: 'done', label: video.getAttribute('aria-label') || '', src: video.currentSrc || video.src || '',
          width: video.videoWidth, height: video.videoHeight, duration: video.duration || null });
      }
      // In-progress cards: a percentage, a Cancel button and the prompt text.
      for (const cancel of [...document.querySelectorAll('button')].filter(b => b.textContent.trim() === 'Cancel')) {
        const card = cancel.closest('div[class]')?.parentElement?.parentElement || cancel.parentElement;
        let node = cancel;
        for (let i = 0; i < 6 && node && !/\\d{1,3}%/.test(node.innerText || ''); i += 1) node = node.parentElement;
        const text = (node?.innerText || '').replace(/Cancel/g, '').trim();
        const percent = Number((text.match(/(\\d{1,3})%/) || [])[1]);
        out.push({ kind: 'running', percent: Number.isFinite(percent) ? percent : null, label: text.replace(/^\\d{1,3}%\\s*/, '') });
      }
      return out;
    })()`);
  }

  // Text of a visible panel card showing this prompt that reports a failure
  // (refusal, error), or null.
  async failureFor(prompt) {
    const prefix = normalize(prompt).slice(0, 60);
    if (!prefix) return null;
    return this.exec(`(() => {
      const prefix = ${JSON.stringify(prefix)};
      const norm = t => String(t || '').normalize('NFKC').replace(/[\\u200b\\u00a0]/g, ' ').replace(/\\s+/g, ' ').trim().toLowerCase();
      const visible = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const words = /(couldn.t|can.t|unable to|wasn.t able to|failed to) (generate|create|make)|try (a )?different prompt|violat|not allowed|policy|something went wrong|try again/i;
      for (const node of document.querySelectorAll('div')) {
        if (!visible(node) || node.querySelector('video,[contenteditable=true]')) continue;
        const text = node.innerText || '';
        if (text.length > 1500 || !norm(text).includes(prefix) || !words.test(text)) continue;
        return text.trim().slice(0, 600);
      }
      return null;
    })()`);
  }

  async ensureWorkspace(url) {
    this.step = 'workspace: file chooser';
    await this.interceptFileChooser().catch(() => {});
    const current = this.webContents.getURL();
    if (url && !current.startsWith(url.split('?')[0].replace(/\/edit.*$/, ''))) {
      this.step = 'workspace: load';
      // Docs pages may never report a finished load; the page checks below decide.
      this.webContents.loadURL(url).catch(() => {});
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
    this.step = 'workspace: page';
    const ready = await this.wait(async () => {
      const state = await this.state();
      if (state.signedOut) throw new Error('login_required: Google sign-in is required for Google Vids');
      return /docs\.google\.com\/videos\/d\//.test(state.url) ? state : null;
    }, 'workspace', 45000, 500);
    void ready;
    this.step = 'workspace: panel';
    // A new Vids file opens with a "Getting started" dialog; its "Create AI
    // videos" card opens the AI video panel. Otherwise use the side rail.
    await this.wait(async () => {
      const state = await this.state();
      if (state.panel) return true;
      if (state.welcome) {
        const card = await this.exec(`(() => { const d = [...document.querySelectorAll('[role=dialog][aria-label="Getting started"]')].find(el => el.getBoundingClientRect().width > 0);
          const card = d && [...d.querySelectorAll('*')].find(el => el.childElementCount === 0 && el.textContent.trim() === 'Create AI videos');
          if (!card) return null; const r = card.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
        if (card) await this.mouseClick(card.x, card.y);
      } else {
        await this.press({ label: 'Generate an AI video clip' });
      }
      await new Promise(resolve => setTimeout(resolve, 1500));
      return (await this.state()).panel;
    }, 'AI video panel', 45000, 500);
    return this.webContents.getURL();
  }

  async workspaceId() {
    return String(this.webContents.getURL()).match(/\/videos\/d\/([^/?#]+)/)?.[1] || '';
  }

  async expand() {
    if ((await this.state()).collapsed) await this.click({ label: 'Expand' });
  }

  // Vids only switches mode while the composer is empty.
  async setMode(mode = 'Create') {
    await this.expand();
    await this.clearComposer();
    const state = await this.state();
    if (state.tabs.find(tab => tab.text === mode)?.selected) return;
    await this.click({ text: mode, role: 'tab' });
    await this.wait(async () => {
      if ((await this.state()).tabs.find(tab => tab.text === mode)?.selected) return true;
      await this.press({ text: mode });
      await new Promise(resolve => setTimeout(resolve, 600));
      return (await this.state()).tabs.find(tab => tab.text === mode)?.selected;
    }, mode + ' mode', 10000, 400);
  }

  async clearComposer() {
    await this.expand();
    for (let i = 0; i < 12; i += 1) {
      const removed = await this.click({ prefix: 'Remove image' }) || await this.click({ prefix: 'Remove video' });
      if (!removed) break;
      await new Promise(resolve => setTimeout(resolve, 300));
    }
    await this.click({ text: 'Clear' });
    await this.wait(async () => { const s = await this.state(); return !s.prompt && s.chips === 0; }, 'empty composer', 10000)
      .catch(() => null);
  }

  async attachImage(file) {
    const before = (await this.state()).chips;
    const hasInput = async () => (await this.exec(`document.querySelectorAll('input[type=file][accept*="image"]').length`)) > 0;
    if (!await hasInput()) {
      this.chooserFiles = [path.resolve(file)];
      const opened = await this.click({ label: 'Ingredients' }) || await this.click({ text: 'Add image' }) ||
        await this.click({ label: 'Add avatar or ingredients' });
      if (!opened) throw new Error('selector_failure: Vids ingredient control unavailable');
      await new Promise(resolve => setTimeout(resolve, 600));
      if (!await hasInput()) await this.click({ text: 'Upload' });
      await new Promise(resolve => setTimeout(resolve, 600));
    }
    if (await hasInput()) {
      this.chooserFiles = null;
      await this.setInputFiles('input[type=file][accept*="image"]', [file]);
    }
    await this.wait(async () => (await this.state()).chips > before, 'reference image ' + path.basename(file), 45000, 500);
    await this.exec(`document.activeElement?.blur?.(); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
  }

  async setSettings({ resolution = '1080p', portrait = false, duration = null } = {}) {
    const current = () => this.state().then(state => state.settings || '');
    const aspect = portrait ? 'Portrait' : 'Landscape';
    const seconds = duration ? Math.max(3, Math.min(10, Math.round(Number(duration)))) : null;
    const want = [resolution, aspect, ...(seconds ? [seconds + ' seconds'] : [])];
    let text = '';
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await this.expand();
      text = await current();
      if (want.every(part => text.includes(part))) return text;
      const open = async () => (await this.exec(`[...document.querySelectorAll('[role=radio]')].some(el => el.getBoundingClientRect().width > 0)`));
      if (!await open()) await this.click({ prefix: 'Generation settings' });
      await this.wait(open, 'settings popup', 5000, 200);
      if (!text.includes(resolution)) {
        await this.click({ text: resolution === '1080p' ? '720p' : '1080p' });
        await new Promise(resolve => setTimeout(resolve, 400));
        await this.click({ text: resolution, role: 'menuitemradio' });
        await new Promise(resolve => setTimeout(resolve, 500));
        if (!await open()) await this.click({ prefix: 'Generation settings' });
        await this.wait(open, 'settings popup', 5000, 200).catch(() => null);
      }
      if (!text.includes(aspect)) {
        await this.click({ text: aspect, role: 'radio' });
        await new Promise(resolve => setTimeout(resolve, 400));
      }
      if (seconds) await this.setDuration(seconds);
      // Close the popup (Escape as a real key press).
      await this.key('Escape');
      await new Promise(resolve => setTimeout(resolve, 400));
    }
    text = await current();
    const missing = want.filter(part => !text.includes(part));
    if (missing.length) throw new Error('selector_failure: Vids settings did not change (' + missing.join(', ') + '; now ' + text + ')');
    return text;
  }

  // <input type=range aria-label="Video duration"> 3..10 s: keyboard steps on
  // the focused slider, so the page sees real input.
  async setDuration(seconds) {
    const target = Math.max(3, Math.min(10, Math.round(Number(seconds) || 10)));
    const info = await this.exec(`(() => {
      const slider = document.querySelector('input[type=range][aria-label="Video duration"]');
      if (!slider || slider.getBoundingClientRect().width <= 0) return null;
      slider.focus();
      return { now: Number(slider.value) };
    })()`);
    if (!info) return false;
    const steps = target - info.now;
    for (let i = 0; i < Math.abs(steps); i += 1) {
      await this.key(steps > 0 ? 'ArrowRight' : 'ArrowLeft');
      await new Promise(resolve => setTimeout(resolve, 60));
    }
    return true;
  }

  async typePrompt(text) {
    await this.exec(`(() => {
      const box = [...document.querySelectorAll('[contenteditable=true]')].find(el => el.getBoundingClientRect().width > 0 &&
        /describe|ingredients|what happens next|how you want/i.test(el.getAttribute('aria-label') || ''));
      if (!box) return false;
      box.focus();
      const range = document.createRange(); range.selectNodeContents(box); range.collapse(false);
      const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
      return true;
    })()`);
    await this.cdp('Input.insertText', { text: ' ' + text });
    const typed = await this.wait(async () => normalize((await this.state()).prompt).includes(normalize(text).slice(0, 60)), 'prompt text', 10000);
    return typed;
  }

  // Submit one generation; returns once its progress card is visible.
  async submit({ prompt, images = [], mode = 'Create', resolution = '1080p', portrait = false, duration = null, sourceVideo = null }) {
    this.step = 'mode';
    await this.setMode(mode);
    this.step = 'clear';
    await this.clearComposer();
    this.step = 'source video';
    if (sourceVideo) await this.attachVideo(sourceVideo);
    this.step = 'reference images';
    for (const file of images) await this.attachImage(file);
    this.step = 'settings';
    const settings = await this.setSettings({ resolution, portrait, duration });
    this.step = 'prompt';
    await this.typePrompt(prompt);
    this.step = 'generate';
    const running = (await this.cards()).filter(card => card.kind === 'running').length;
    await this.wait(async () => (await this.state()).generate === true, 'Generate button', 15000);
    if (!await this.click({ label: 'Generate' })) throw new Error('selector_failure: Vids Generate is unavailable');
    await this.wait(async () => (await this.cards()).filter(card => card.kind === 'running').length > running ||
      (await this.cards()).some(card => card.kind === 'done' && samePrompt(card.label, prompt)), 'generation start', 30000, 500);
    return { submitted_at: Date.now() / 1000, provider_url: this.webContents.getURL(), selected_settings: settings, mode };
  }

  async attachVideo(file) {
    const before = (await this.state()).chips;
    const selector = 'input[type=file][accept*="video"]';
    if (!await this.exec(`document.querySelectorAll(${JSON.stringify(selector)}).length`)) {
      this.chooserFiles = [path.resolve(file)];
      await this.click({ text: 'Add video' }) || await this.click({ label: 'Add video' });
      await new Promise(resolve => setTimeout(resolve, 800));
    }
    if (await this.exec(`document.querySelectorAll(${JSON.stringify(selector)}).length`)) {
      this.chooserFiles = null;
      await this.setInputFiles(selector, [file]);
    }
    await this.wait(async () => (await this.state()).chips > before, 'source video', 120000, 1000);
  }
}

module.exports = { GoogleVidsAdapter, normalize, cardPrompt, samePrompt };
