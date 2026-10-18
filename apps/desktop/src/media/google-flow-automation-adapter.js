const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MediaBrowserController } = require('./media-browser-controller');
const { mediaFingerprints } = require('./media-output-validator');
const { FlowReferenceController } = require('./flow-reference-controller');

const FLOW_HOME = 'https://flow.google.com/';
const AUTH_WORDS = ['sign in', 'log in', 'choose an account'];
const CHALLENGE_WORDS = ['verify you are human', 'unusual activity', 'captcha'];
const RATE_WORDS = ['rate limit', 'try again later', 'too many requests'];
const CREDIT_WORDS = [
  'credits exhausted',
  'no credits',
  'not enough credits',
  'insufficient credits',
  'out of credits',
  'credit limit reached'
];

// Page-wide text that marks a refused or failed generation. Bulk jobs compare
// the count against their submission baseline instead of failing on old tiles.
const FAILURE_SIGNAL_RE = /policy|couldn.?t generate|can.?t generate|not allowed/g;
// Flow refusing another concurrent generation. Detected before the paid click.
const CAPACITY_RE = /(?:too many|maximum(?: number of)?|limit of|max(?:imum)?\s+\d+)\s+(?:\w+\s+){0,3}(?:generations?|videos?|images?|requests?)(?:\s+(?:in progress|at (?:a|one|the same) time|at once))?|wait (?:for|until) (?:your |the )?(?:current |other |previous )?(?:generations?|videos?) (?:to )?(?:finish|complete)/i;

function lower(value) { return String(value || '').toLowerCase(); }

function failureSignalCount(text) {
  return (lower(text).replace(/generating will use [0-9]+ credits/g, '').match(FAILURE_SIGNAL_RE) || []).length;
}

function capacitySignal(text) {
  const match = String(text || '').match(CAPACITY_RE);
  return match ? match[0].slice(0, 200) : '';
}

function projectId(url) {
  return String(url || '').match(/^https:\/\/flow\.google\.com\/project\/([^/?#]+)/i)?.[1] || '';
}

class GoogleFlowAutomationAdapter {
  constructor(webContents) {
    this.webContents = webContents;
    this.browser = new MediaBrowserController(webContents);
    // A tile's provider prompt never changes; avoid reopening its info panel.
    this.resultInfoCache = new Map();
  }

  isTransientPageError(error) {
    const text = String(error?.message || error || '').toLowerCase();
    return text.includes('script failed to execute')
      || text.includes('execution context was destroyed')
      || text.includes('cannot find context')
      || text.includes('frame was detached')
      || text.includes('navigation');
  }

  async executePageScript(script, attempts = 8) {
    let lastError = null;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        return await this.webContents.executeJavaScript(script, true);
      } catch (error) {
        lastError = error;
        if (!this.isTransientPageError(error) || attempt === attempts - 1) throw error;
        await new Promise(resolve => setTimeout(resolve, 180 + attempt * 120));
      }
    }
    throw lastError || new Error('page script execution failed');
  }

  async browserEvaluate(script, attempts = 8) {
    let lastError = null;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        return await this.browser.evaluate(script);
      } catch (error) {
        lastError = error;
        if (!this.isTransientPageError(error) || attempt === attempts - 1) throw error;
        await new Promise(resolve => setTimeout(resolve, 180 + attempt * 120));
      }
    }
    throw lastError || new Error('browser evaluate failed');
  }

  async stage(name, fn) {
    // Each operation bounds its own waits. Do not race a live DOM mutation:
    // ownership must remain with this job until the operation has quiesced.
    try { return await fn(); }
    catch (error) {
      const message = String(error?.message || error || '').slice(0, 1400);
      throw new Error(name + ': ' + message);
    }
  }

  async probe() {
    return this.executePageScript(`(() => {
      const text = (document.body?.innerText || '').slice(0, 30000);
      const lower = text.toLowerCase();
      const visible = el => {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 2 && rect.height > 2 &&
          style.display !== 'none' && style.visibility !== 'hidden' &&
          Number(style.opacity || 1) !== 0 && !el.disabled &&
          el.getAttribute('aria-hidden') !== 'true';
      };
      let pathName = String(location.pathname || '').toLowerCase();
      while (pathName.length > 1 && pathName.endsWith('/')) pathName = pathName.slice(0, -1);
      const onToolsIndex = pathName === '/tools' || pathName.endsWith('/tools');
      const onAppletTool = pathName.includes('/project/') && pathName.includes('/tool/');
      const inputs = [...document.querySelectorAll('textarea, [contenteditable="true"], input[type="text"]')];
      let prompt = inputs.find(el => {
        if (!visible(el)) return false;
        const hint = ((el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('placeholder') || '')).toLowerCase();
        const cls = String(el.className || '').toLowerCase();
        if (/applet agent|make changes|^search$|editable text/.test(hint)) return false;
        if (el.getAttribute('contenteditable') === 'true' && /prosemirror|prompt|composer/.test(cls)) return true;
        return /prompt|describe|what.*create|imagine/.test(hint);
      }) || null;
      if (!prompt) {
        const createCard = [...document.querySelectorAll('.create-applet-card[role="button"], [role="button"], button')]
          .find(el => visible(el) && /create new/i.test(((el.getAttribute('aria-label') || '') + ' ' + (el.innerText || '')).trim()));
        prompt = onAppletTool ? null : (inputs.find(el => {
          if (!visible(el)) return false;
          const aria = String(el.getAttribute('aria-label') || '').toLowerCase();
          const cls = String(el.className || '').toLowerCase();
          if (aria === 'search' || aria.includes('editable text')) return false;
          if (el.getAttribute('contenteditable') === 'true' && /prosemirror|prompt|composer/.test(cls)) return true;
          const context = el.closest('[role="dialog"], [class*="composer" i], [class*="prompt" i], [class*="generate" i], [data-testid*="composer" i]');
          return !!context && !(onToolsIndex && createCard && !context);
        }) || null);
      }
      const inputDetails = inputs.filter(visible).map(el => ({
        tag: el.tagName,
        aria: el.getAttribute('aria-label') || '',
        placeholder: el.getAttribute('placeholder') || '',
        role: el.getAttribute('role') || '',
        contenteditable: el.getAttribute('contenteditable') || '',
        cls: String(el.className || '').slice(0, 180)
      })).slice(0, 24);
      const buttons = [...document.querySelectorAll('button, [role="button"], a[href]')].filter(visible);
      const labels = buttons.map(el => ((el.getAttribute('aria-label') || '') + ' ' + (el.innerText || '')).trim()).filter(Boolean);
      const controls = buttons.map(el => {
        const label = ((el.getAttribute('aria-label') || '') + ' ' + (el.innerText || '')).trim();
        const anchor = el.matches('a[href]') ? el : el.closest('a[href]');
        return {
          label,
          tag: el.tagName,
          href: anchor?.href || '',
          role: el.getAttribute('role') || '',
          cls: String(el.className || '').slice(0, 180)
        };
      }).filter(item => item.label).slice(0, 160);
      return { url: location.href, title: document.title, text: text.slice(0, 10000), promptFound: !!prompt, inputDetails, buttonLabels: labels.slice(0, 160), controls, lower };
    })()`);
  }

  classifyProbe(probe) {
    const body = lower(probe?.lower || probe?.text);
    const labels = (probe?.buttonLabels || []).map(lower).join(' | ');
    const links = (probe?.controls || []).map(item => lower((item?.label || '') + ' ' + (item?.href || ''))).join(' | ');
    let host = '';
    try { host = new URL(String(probe?.url || '')).hostname; } catch {}
    const onFlow = host === 'flow.google.com' || host === 'www.flow.google.com';
    const authenticatedUi =
      /google account:|account details|new project|more options for the project|settings trigger|add media menu|apps_spark_2\s*tools|\bhome\s+home\b/.test(body + ' | ' + labels + ' | ' + links) ||
      /accounts\.google\.com\/signoutoptions/.test(links) ||
      probe?.promptFound === true;
    const explicitAuthUi = /(^|\|\s*)(sign in|log in|choose an account)(\s*\||$)/.test(labels) ||
      /accounts\.google\.com\/(service)?login/.test(links);
    return {
      signedIn: onFlow && authenticatedUi && !explicitAuthUi,
      challenged: CHALLENGE_WORDS.some(word => body.includes(word)),
      rateLimited: RATE_WORDS.some(word => body.includes(word)),
      creditsExhausted: CREDIT_WORDS.some(word => body.includes(word)),
      promptFound: probe?.promptFound === true
    };
  }

  async capabilities(existingProbe = null) {
    const probe = existingProbe || await this.probe();
    const labels = (probe.buttonLabels || []).map(lower);
    const joined = labels.join(' | ');
    // Status polling must be observational: opening settings here races submission.
    const settingsOptions = (probe.buttonLabels || []).filter(label => /omni|nano banana|lyria/i.test(label));
    return {
      surface: 'google-flow',
      image: true,
      video: true,
      native_audio: /audio|sound/.test(joined),
      extend: /extend/.test(joined),
      ingredients: /ingredient|reference/.test(joined),
      first_last_frame: false,
      reference_mode: 'ingredients',
      reference_note: 'Omni images attach directly to the prompt; exact first/last frames are unavailable',
      video_generation_resolution: '720p',
      video_download_quality: '1080p',
      sound_effect_generation_resolution: '360p',
      sound_effect_download_quality: 'source',
      models: settingsOptions.slice(0, 20),
      settings_options: settingsOptions.slice(0, 80),
      discovered_controls: (probe.buttonLabels || []).slice(0, 24),
      prompt_inputs: (probe.inputDetails || []).slice(0, 12),
      discovered_control_links: (probe.controls || []).slice(0, 16).map(item => ({
        label: String(item.label || '').slice(0, 100),
        tag: item.tag,
        href: String(item.href || '').slice(0, 220)
      }))
    };
  }

  async promptSelector() {
    return this.browserEvaluate(`(() => {
      const visible = el => {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 2 && rect.height > 2 &&
          style.display !== 'none' && style.visibility !== 'hidden' &&
          Number(style.opacity || 1) !== 0 && !el.disabled &&
          el.getAttribute('aria-hidden') !== 'true';
      };
      const mark = el => {
        const marker = 'teamyra-prompt-' + Math.random().toString(36).slice(2);
        el.setAttribute('data-teamyra-prompt-target', marker);
        return '[data-teamyra-prompt-target="' + marker + '"]';
      };
      const inputs = [...document.querySelectorAll('textarea, [contenteditable="true"], input[type="text"]')];
      const explicit = inputs.find(el => {
        if (!visible(el)) return false;
        const hint = [
          el.getAttribute('aria-label') || '',
          el.getAttribute('placeholder') || '',
          el.getAttribute('data-testid') || ''
        ].join(' ').toLowerCase();
        const cls = String(el.className || '').toLowerCase();
        if (/applet agent|make changes|^search$|editable text/.test(hint)) return false;
        if (el.getAttribute('contenteditable') === 'true' && /prosemirror|prompt|composer/.test(cls)) return true;
        return /prompt|describe|what.*create|imagine/.test(hint);
      });
      if (explicit) return mark(explicit);

      const createCard = [...document.querySelectorAll('.create-applet-card[role="button"], [role="button"], button')]
        .find(el => visible(el) && /create new/i.test(((el.getAttribute('aria-label') || '') + ' ' + (el.innerText || '')).trim()));
      let pathName = String(location.pathname || '').toLowerCase();
      while (pathName.length > 1 && pathName.endsWith('/')) pathName = pathName.slice(0, -1);
      const onToolsIndex = pathName === '/tools' || pathName.endsWith('/tools');
      const onAppletTool = pathName.includes('/project/') && pathName.includes('/tool/');
      const hasEditorContext = el => {
        let node = el;
        for (let depth = 0; node && depth < 8; depth += 1, node = node.parentElement) {
          const role = (node.getAttribute?.('role') || '').toLowerCase();
          const cls = String(node.className || '').toLowerCase();
          const testid = (node.getAttribute?.('data-testid') || '').toLowerCase();
          if (role === 'dialog' || /composer|prompt|generate|creation|editor/.test(cls + ' ' + testid)) return true;
        }
        return false;
      };
      for (const el of inputs) {
        if (!visible(el)) continue;
        if (onAppletTool) continue;
        const aria = String(el.getAttribute('aria-label') || '').toLowerCase();
        const cls = String(el.className || '').toLowerCase();
        if (aria === 'search' || aria.includes('editable text')) continue;
        if (el.getAttribute('contenteditable') === 'true' && /prosemirror|prompt|composer/.test(cls)) return mark(el);
        if (onToolsIndex && createCard && !hasEditorContext(el)) continue;
        if (!hasEditorContext(el)) continue;
        return mark(el);
      }
      return '';
    })()`);
  }

  async semanticClick(patterns) {
    const serialized = JSON.stringify(patterns.map(value => String(value).toLowerCase()));
    const selector = await this.executePageScript(`(() => {
      const patterns = ${serialized};
      const all = [...document.querySelectorAll('button, [role="button"], [role="menuitem"], [role="option"]')];
      const target = all.find(el => {
        const text = ((el.getAttribute('aria-label') || '') + ' ' + (el.innerText || '')).trim().toLowerCase();
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && patterns.some(pattern => text.includes(pattern));
      });
      if (!target) return '';
      const marker = 'teamyra-media-' + Math.random().toString(36).slice(2);
      target.setAttribute('data-teamyra-media-target', marker);
      return '[data-teamyra-media-target="' + marker + '"]';
    })()`);
    if (!selector) return false;
    try {
      const clicked = await this.browser.clickSelector(selector);
      if (clicked) return true;
    } catch {}
    return this.executePageScript(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true; })()`).catch(() => false);
  }

  async settingsTriggerSelector() {
    return this.executePageScript(`(() => {
      const el = [...document.querySelectorAll('button,[role="button"]')].find(node => {
        const text = ((node.getAttribute('aria-label') || '') + ' ' + (node.innerText || '')).trim().toLowerCase();
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && text.includes('settings trigger');
      });
      if (!el) return '';
      const token = 'teamyra-settings-' + Math.random().toString(36).slice(2);
      el.setAttribute('data-teamyra-settings-trigger', token);
      return '[data-teamyra-settings-trigger="' + token + '"]';
    })()`).catch(() => '');
  }

  async settingsPanelSnapshot() {
    return this.executePageScript(`(() => {
      const bodyText = String(document.body?.innerText || '');
      const visible = el => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' &&
          style.visibility !== 'hidden' && Number(style.opacity || 1) !== 0;
      };
      const overlays = [...document.querySelectorAll('*')].filter(el => {
        if (!visible(el)) return false;
        const role = String(el.getAttribute('role') || '').toLowerCase();
        const cls = String(el.className || '').toLowerCase();
        return ['dialog','listbox','menu','option','radio','menuitem'].includes(role) ||
          /menu|popover|dropdown|overlay|select-panel|settings-panel/.test(cls);
      });
      return {
        bodyText: bodyText.slice(0, 20000),
        overlayCount: overlays.length,
        overlayText: [...new Set(overlays.map(el => String(el.innerText || el.textContent || '').trim()).filter(Boolean))].slice(0,120)
      };
    })()`).catch(() => ({ bodyText: '', overlayCount: 0, overlayText: [] }));
  }

  async openSettingsPanel() {
    if (await this.settingsPanelIsOpen()) return { opened: true, already_open: true };
    const selector = await this.settingsTriggerSelector();
    if (!selector) return { opened: false, before: null, after: null };
    const before = await this.settingsPanelSnapshot();
    const attempts = [
      () => this.executePageScript(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        el.focus?.();
        el.click?.();
        return true;
      })()`),
      () => this.browser.clickSelector(selector),
      () => this.browser.pressKeySelector(selector, 'Enter'),
      () => this.browser.pressKeySelector(selector, ' ')
    ];
    for (const attempt of attempts) {
      await attempt().catch(() => false);
      await new Promise(resolve => setTimeout(resolve, 320));
      const after = await this.settingsPanelSnapshot();
      const changed = after.overlayCount > before.overlayCount ||
        after.bodyText !== before.bodyText ||
        (after.overlayText || []).join('|') !== (before.overlayText || []).join('|');
      if (changed) return { opened: true, before, after };
    }
    return { opened: false, before, after: await this.settingsPanelSnapshot() };
  }

  async activateVisibleText(patterns) {
    const serialized = JSON.stringify(patterns.map(value => lower(value)));
    const selector = await this.executePageScript(`(() => {
      const patterns = ${serialized};
      const visible = el => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' &&
          style.visibility !== 'hidden' && Number(style.opacity || 1) !== 0 &&
          !el.disabled && el.getAttribute('aria-disabled') !== 'true' &&
          el.getAttribute('aria-hidden') !== 'true';
      };
      const all = [...document.querySelectorAll('button,[role="button"],[role="menuitem"],[role="option"],[role="radio"],label,div,span')];
      const candidates = all.filter(el => {
        if (!visible(el)) return false;
        const text = ((el.getAttribute('aria-label') || '') + ' ' + (el.innerText || el.textContent || '')).trim().toLowerCase();
        if (!text || text.includes('settings trigger')) return false;
        return patterns.some(pattern => text.includes(pattern));
      }).sort((a,b) => {
        const at = String(a.innerText || a.textContent || '').trim().length;
        const bt = String(b.innerText || b.textContent || '').trim().length;
        return at - bt;
      });
      const matched = candidates[0];
      if (!matched) return '';
      const target = matched.closest('button,[role="button"],[role="menuitem"],[role="option"],[role="radio"],label') || matched;
      const token = 'teamyra-setting-option-' + Math.random().toString(36).slice(2);
      target.setAttribute('data-teamyra-setting-option', token);
      return '[data-teamyra-setting-option="' + token + '"]';
    })()`).catch(() => '');
    if (!selector) return false;
    try {
      if (await this.browser.clickSelector(selector)) return true;
    } catch {}
    try {
      if (await this.browser.pressKeySelector(selector, 'Enter')) return true;
    } catch {}
    return this.executePageScript(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      el.click?.();
      return true;
    })()`).catch(() => false);
  }

  async settingsOptions() {
    const beforeText = await this.executePageScript("document.body?.innerText || ''").catch(() => '');
    const openedState = await this.openSettingsPanel();
    if (!openedState.opened) return [];
    await new Promise(resolve => setTimeout(resolve, 200));
    const data = await this.executePageScript(`(() => {
      const bodyText = String(document.body?.innerText || '');
      const lines = [...new Set(bodyText.split(/\\r?\\n/).map(v => v.trim()).filter(Boolean))];
      const visible = el => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' &&
          style.visibility !== 'hidden' && Number(style.opacity || 1) !== 0;
      };
      const controls = [...document.querySelectorAll('*')]
        .filter(el => visible(el) && (
          /menu|popover|dropdown|select|option|radio|settings/i.test(String(el.className || '')) ||
          ['menuitem','option','radio','dialog','listbox'].includes(String(el.getAttribute('role') || '').toLowerCase())
        ))
        .map(el => ((el.getAttribute('aria-label') || '') + ' ' + (el.innerText || '')).trim())
        .filter(Boolean);
      return { lines: lines.slice(0, 260), controls: [...new Set(controls)].slice(0, 180) };
    })()`).catch(() => ({ lines: [], controls: [] }));
    await this.executePageScript(`(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
      document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', code: 'Escape', bubbles: true }));
      return true;
    })()`).catch(() => false);
    const beforeLines = new Set(String(beforeText || '').split(/\r?\n/).map(v => v.trim()).filter(Boolean));
    const newLines = (data.lines || []).filter(line => !beforeLines.has(line));
    return [...new Set([...(data.controls || []), ...newLines])].slice(0, 180);
  }

  async settingsControlState() {
    const opened = await this.openSettingsPanel();
    if (!opened.opened) return [];
    const controls = await this.executePageScript(`(() => {
      const visible = el => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
      };
      return [...document.querySelectorAll('button,[role="button"],[role="tab"],[role="radio"],[role="option"],label')]
        .filter(visible)
        .map(el => ({
          text: ((el.getAttribute('aria-label') || '') + ' ' + (el.innerText || el.textContent || '')).trim().slice(0,180),
          role: el.getAttribute('role') || '',
          selected: el.getAttribute('aria-selected'),
          checked: el.getAttribute('aria-checked'),
          pressed: el.getAttribute('aria-pressed'),
          cls: String(el.className || '').slice(0,220)
        }))
        .filter(item => item.text)
        .slice(0,180);
    })()`).catch(() => []);
    await this.executePageScript(`(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
      document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', code: 'Escape', bubbles: true }));
      return true;
    })()`).catch(() => false);
    return controls;
  }

  async settingsTriggerText() {
    return this.executePageScript(`(() => {
      const el = [...document.querySelectorAll('button,[role="button"]')].find(node => {
        const text = ((node.getAttribute('aria-label') || '') + ' ' + (node.innerText || '')).trim().toLowerCase();
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && text.includes('settings trigger');
      });
      return el ? ((el.getAttribute('aria-label') || '') + ' ' + (el.innerText || '')).trim() : '';
    })()`).catch(() => '');
  }

  async waitForSettingsTrigger(timeoutMs = 12000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const text = await this.settingsTriggerText();
      if (text) return text;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    return '';
  }

  async closeSettingsPanel() {
    if (!await this.settingsPanelIsOpen()) return true;
    const selector = await this.settingsTriggerSelector();
    if (selector) await this.browser.pressKeySelector(selector, 'Escape').catch(() => false);
    if (await this.settingsPanelIsOpen()) {
      await this.executePageScript(`document.querySelector(${JSON.stringify(selector)})?.click()`);
    }
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      if (!await this.settingsPanelIsOpen()) return true;
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    throw new Error('selector_failure: settings panel did not close');
  }

  async chooseSettingOption(patterns, { required = false, label = 'setting' } = {}) {
    const before = await this.waitForSettingsTrigger(required ? 6000 : 1500);
    const openedState = before ? await this.openSettingsPanel() : { opened: false };
    if (!openedState.opened) {
      if (required) throw new Error('selector_failure: Google Flow settings trigger was not actionable for ' + label);
      return { ok: false, before, after: before };
    }
    const clicked = await this.activateVisibleText(patterns);
    if (!clicked) {
      await this.executePageScript(`(() => {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
        document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', code: 'Escape', bubbles: true }));
        return true;
      })()`).catch(() => false);
      if (required) {
        const options = await this.settingsOptions().catch(() => []);
        throw new Error('selector_failure: Google Flow ' + label + ' option was not found; options=' + options.slice(0, 50).join(' | '));
      }
      return { ok: false, before, after: before };
    }
    await new Promise(resolve => setTimeout(resolve, 500));
    const after = await this.settingsTriggerText();
    return { ok: true, before, after };
  }

  async clickCreateNew(timeoutMs = 12000) {
    const deadline = Date.now() + timeoutMs;
    const editorReady = async () => {
      const url = this.webContents.getURL();
      if (/\/project\/[^/]+\/tool\/[^/?#]+/i.test(url)) return true;
      return Boolean(await this.promptSelector().catch(() => ''));
    };
    const exactSelectors = [
      '.create-applet-card[role="button"]',
      '[role="button"][aria-label*="create new" i]',
      'button[aria-label*="create new" i]'
    ];
    while (Date.now() < deadline) {
      for (const selector of exactSelectors) {
        const nodeId = await this.browser.query(selector).catch(() => 0);
        if (!nodeId) continue;

        const attempts = [
          () => this.browser.clickSelector(selector),
          () => this.browser.pressKeySelector(selector, 'Enter'),
          () => this.browser.pressKeySelector(selector, ' '),
          () => this.executePageScript(`(() => {
            const el = document.querySelector(${JSON.stringify(selector)});
            if (!el) return false;
            el.focus?.();
            el.click?.();
            return true;
          })()`)
        ];
        for (const attempt of attempts) {
          await attempt().catch(() => false);
          const settleDeadline = Date.now() + 1800;
          while (Date.now() < settleDeadline) {
            if (await editorReady()) return true;
            await new Promise(resolve => setTimeout(resolve, 180));
          }
        }
      }

      const semantic = await this.semanticClick(['create new']).catch(() => false);
      if (semantic) {
        const settleDeadline = Date.now() + 1800;
        while (Date.now() < settleDeadline) {
          if (await editorReady()) return true;
          await new Promise(resolve => setTimeout(resolve, 180));
        }
      }
      await new Promise(resolve => setTimeout(resolve, 350));
    }
    return false;
  }

  async projectUrls() {
    return this.executePageScript(`(() => [...document.querySelectorAll('a[href*="/project/"]')].map(a => a.href).filter(Boolean))()`)
      .then(items => Array.from(new Set(Array.isArray(items) ? items : [])))
      .catch(() => []);
  }

  async loadProjectUrl(url) {
    let navigationError = null;
    const ready = new Promise(resolve => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.webContents.removeListener('dom-ready', finish);
        this.webContents.removeListener('did-stop-loading', finish);
        resolve();
      };
      const timer = setTimeout(finish, 20000);
      timer.unref?.();
      this.webContents.once('dom-ready', finish);
      this.webContents.once('did-stop-loading', finish);
    });
    this.webContents.loadURL(url).catch(error => { navigationError = error; });
    await ready;
    const current = this.webContents.getURL();
    if (!/^https:\/\/flow\.google\.com\/project\//i.test(current)) {
      throw navigationError || new Error('selector_failure: Google Flow project route did not open');
    }
    return current;
  }

  async ensureWorkspace(timeoutMs = 30000) {
    const currentPrompt = await this.promptSelector();
    if (currentPrompt) return { ready: true, existing: true };

    const currentUrl = this.webContents.getURL();
    if (/^https:\/\/flow\.google\.com\/project\//i.test(currentUrl)) {
      const match = currentUrl.match(/^(https:\/\/flow\.google\.com\/project\/[^/?#]+)/i);
      const baseProjectUrl = match?.[1] || '';
      if (!baseProjectUrl) throw new Error('selector_failure: Google Flow project id could not be resolved');
      if (currentUrl !== baseProjectUrl && currentUrl !== baseProjectUrl + '/') {
        await this.loadProjectUrl(baseProjectUrl);
      }
      return { ready: true, existing: true, project_url: baseProjectUrl };
    }

    const existingUrls = await this.projectUrls();
    if (existingUrls.length) {
      const base = String(existingUrls[0]).match(/^(https:\/\/flow\.google\.com\/project\/[^/?#]+)/i)?.[1] || existingUrls[0];
      await this.loadProjectUrl(base);
      return { ready: true, existing: true, project_url: base };
    }

    const openedExisting = await this.semanticClick(['open project']).catch(() => false);
    if (openedExisting) {
      const openDeadline = Date.now() + Math.min(timeoutMs, 12000);
      while (Date.now() < openDeadline) {
        await new Promise(resolve => setTimeout(resolve, 350));
        const navigated = this.webContents.getURL();
        const match = navigated.match(/^(https:\/\/flow\.google\.com\/project\/[^/?#]+)/i);
        if (match?.[1]) {
          if (navigated !== match[1] && navigated !== match[1] + '/') await this.loadProjectUrl(match[1]);
          return { ready: true, existing: true, project_url: match[1] };
        }
      }
    }

    const before = new Set(await this.projectUrls());
    const clicked = await this.semanticClick(['new project']);
    if (!clicked) throw new Error('selector_failure: Google Flow project could not be opened or created');

    const startedAt = Date.now();
    const createDeadline = startedAt + Math.min(timeoutMs, 15000);
    let jsFallbackUsed = false;
    let targetUrl = null;

    while (Date.now() < createDeadline && !targetUrl) {
      await new Promise(resolve => setTimeout(resolve, 700));
      const urls = await this.projectUrls();
      targetUrl = urls.find(url => !before.has(url)) || null;

      const navigated = this.webContents.getURL();
      const navMatch = navigated.match(/^(https:\/\/flow\.google\.com\/project\/[^/?#]+)/i);
      if (navMatch?.[1]) targetUrl = navMatch[1];

      if (!jsFallbackUsed && Date.now() - startedAt > 3500 && !targetUrl) {
        jsFallbackUsed = true;
        await this.webContents.executeJavaScript("(() => { const button = document.querySelector('button.new-project-button') || [...document.querySelectorAll('button')].find(el => /new project/i.test(el.innerText || el.getAttribute('aria-label') || '')); if (!button) return false; button.click(); return true; })()", true).catch(() => false);
      }
    }

    if (!targetUrl) {
      const urls = await this.projectUrls();
      targetUrl = urls[0] || null;
    }
    if (!targetUrl) throw new Error('selector_failure: Google Flow project was not created');

    const match = targetUrl.match(/^(https:\/\/flow\.google\.com\/project\/[^/?#]+)/i);
    const baseProjectUrl = match?.[1] || targetUrl.replace(/\/$/, '');
    await this.loadProjectUrl(baseProjectUrl);
    return { ready: true, existing: false, project_url: baseProjectUrl };
  }

  async waitForPrompt(timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const selector = await this.promptSelector();
      if (selector) return selector;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    const probe = await this.probe().catch(() => null);
    const labels = (probe?.buttonLabels || []).slice(0, 24).join(' | ');
    const createControl = (probe?.controls || []).find(item => /create new/i.test(item.label || '')) || null;
    throw new Error(
      'selector_failure: Google Flow generation prompt did not become ready; url=' +
      String(probe?.url || this.webContents.getURL()).slice(0, 260) +
      '; controls=' + labels.slice(0, 1200) +
      '; create=' + JSON.stringify(createControl || {}).slice(0, 900)
    );
  }

  aspectRatioPatterns(value) {
    // Flow labels: crop_16_9 16:9, crop_landscape 4:3, crop_square 1:1,
    // crop_portrait 3:4, crop_9_16 9:16. Generic words like "portrait" name a
    // different ratio, so match the exact ratio text and icon only.
    const ratio = String(value || '').trim().toLowerCase();
    if (ratio === '1:1') return ['1:1', 'crop_square'];
    if (ratio === '16:9') return ['16:9', 'crop_16_9'];
    if (ratio === '9:16') return ['9:16', 'crop_9_16'];
    if (ratio === '4:3') return ['4:3', 'crop_landscape', 'crop_4_3'];
    if (ratio === '3:4') return ['3:4', 'crop_portrait', 'crop_3_4'];
    return [ratio];
  }

  async selectRadioSetting(patterns, options = {}) {
    const result = await this.selectSettingsRadio(patterns, options);
    await this.closeSettingsPanel();
    return result;
  }

  async settingsPanelIsOpen() {
    return this.executePageScript(`(() => {
      const visible = el => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && s.display !== 'none' &&
          s.visibility !== 'hidden' && Number(s.opacity || 1) !== 0;
      };
      return [...document.querySelectorAll('[role="radio"]')].filter(visible).some(el => {
        const text = ((el.getAttribute('aria-label') || '') + ' ' + (el.innerText || el.textContent || '')).toLowerCase();
        return /\\bimage\\b|\\bvideo\\b|360p|720p|16:9|9:16/.test(text);
      });
    })()`).catch(() => false);
  }

  async ensureSettingsPanelOpen(timeoutMs = 6000) {
    if (await this.settingsPanelIsOpen()) return true;
    await this.waitForSettingsTrigger(12000);
    const selector = await this.settingsTriggerSelector();
    if (!selector) return false;
    const attempts = [
      () => this.executePageScript(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        el.focus?.();
        el.click?.();
        return true;
      })()`),
      () => this.browser.clickSelector(selector),
      () => this.browser.pressKeySelector(selector, 'Enter')
    ];
    for (const attempt of attempts) {
      await attempt().catch(() => false);
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (await this.settingsPanelIsOpen()) return true;
        await new Promise(resolve => setTimeout(resolve, 150));
      }
    }
    return false;
  }

  async selectSettingsRadio(patterns, { required = true, label = 'setting' } = {}) {
    const serialized = JSON.stringify(patterns.map(value => lower(value)));
    const opened = await this.ensureSettingsPanelOpen();
    if (!opened) {
      if (required) throw new Error('selector_failure: Google Flow settings panel was not ready for ' + label);
      return { ok: false };
    }

    const state = async () => this.executePageScript(`(() => {
      const patterns = ${serialized};
      const visible = el => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && s.display !== 'none' &&
          s.visibility !== 'hidden' && Number(s.opacity || 1) !== 0;
      };
      const radios = [...document.querySelectorAll('[role="radio"]')].filter(visible);
      const label = el => ((el.getAttribute('aria-label') || '') + ' ' + (el.innerText || el.textContent || '')).trim().toLowerCase();
      // Patterns are in preference order: the first pattern any radio matches wins.
      let target = null;
      for (const pattern of patterns) {
        target = radios.find(el => label(el).includes(pattern));
        if (target) break;
      }
      if (!target) return { found: false, selected: false, text: '' };
      const token = target.getAttribute('data-teamyra-setting-radio') ||
        ('teamyra-setting-radio-' + Math.random().toString(36).slice(2));
      target.setAttribute('data-teamyra-setting-radio', token);
      return {
        found: true,
        selected: target.getAttribute('aria-checked') === 'true',
        text: ((target.getAttribute('aria-label') || '') + ' ' + (target.innerText || target.textContent || '')).trim(),
        selector: '[data-teamyra-setting-radio="' + token + '"]'
      };
    })()`).catch(() => ({ found: false, selected: false, text: '' }));

    let current = await state();
    if (!current.found) {
      if (required) {
        const options = await this.settingsPanelSnapshot().catch(() => ({ overlayText: [] }));
        throw new Error('selector_failure: Google Flow ' + label + ' option was not found; options=' +
          (options.overlayText || []).slice(0, 80).join(' | '));
      }
      return { ok: false };
    }
    if (current.selected) return { ok: true, already_selected: true, text: current.text };

    const attempts = [
      () => this.executePageScript(`(() => {
        const el = document.querySelector(${JSON.stringify(current.selector)});
        if (!el) return false;
        el.click?.();
        return true;
      })()`),
      () => this.browser.clickSelector(current.selector),
      () => this.browser.pressKeySelector(current.selector, 'Enter')
    ];
    for (const attempt of attempts) {
      await attempt().catch(() => false);
      const deadline = Date.now() + 2500;
      while (Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 150));
        await this.ensureSettingsPanelOpen(1200).catch(() => false);
        current = await state();
        if (current.selected) return { ok: true, text: current.text };
      }
    }
    if (required) throw new Error('selector_failure: Google Flow ' + label + ' did not become selected');
    return { ok: false };
  }

  async selectVideoModeAndModel(request) {
    await this.selectSettingsRadio(['video'], { required: true, label: 'Video mode' });
    // Switching lanes may destroy the popover. Reopen and inspect its new DOM.
    if (!await this.ensureSettingsPanelOpen()) throw new Error('selector_failure: video settings did not reopen');
    const modelText = () => this.executePageScript(`document.querySelector('button[aria-label="Select model family"]')?.innerText || ''`);
    let actual = await modelText();
    if (!/omni(?:\s*1\.1)?\s*flash/i.test(actual)) {
      await this.executePageScript(`document.querySelector('button[aria-label="Select model family"]')?.click()`);
      const deadline = Date.now() + 5000;
      let selected = false;
      while (Date.now() < deadline && !selected) {
        selected = await this.executePageScript(`(() => {
          const options = [...document.querySelectorAll('[role="menuitem"],[role="option"],[role="radio"]')];
          const option = options.find(el => {
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0 && /omni.*flash/i.test(el.innerText || '') && !el.disabled;
          });
          if (!option) return false;
          option.click(); return true;
        })()`);
        if (!selected) await new Promise(resolve => setTimeout(resolve, 150));
      }
      if (!selected) throw new Error('selector_failure: Omni Flash video model is unavailable');
      await this.ensureSettingsPanelOpen();
    }
    const verifyDeadline = Date.now() + 5000;
    while (Date.now() < verifyDeadline) {
      actual = await modelText();
      if (/omni(?:\s*1\.1)?\s*flash/i.test(actual)) {
        return { ok: true, actual_model: actual.replace('arrow_drop_down', '').trim() };
      }
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    throw new Error('selector_failure: Omni Flash video model did not become selected');
  }

  async selectIntent(request, operation = null) {
    const type = request.type;
    const settings = request.generation_settings || {};
    let actualModel = '';
    const operationLabels = {
      image_edit: ['edit image', 'edit'],
      image_variation: ['variation', 'variations'],
      video_extend: ['extend', 'extend video'],
      video_edit: ['edit video', 'edit'],
      video_to_video: ['video to video', 'remix video']
    };
    if (operationLabels[operation]) await this.semanticClick(operationLabels[operation]);

    if (type === 'image') {
      await this.selectSettingsRadio(['image'], { required: true, label: 'Image mode' });
      const preferred = String(request.model_preference || 'auto');
      if (preferred.toLowerCase() !== 'auto') {
        if (!await this.ensureSettingsPanelOpen()) throw new Error('selector_failure: image settings unavailable');
        await this.executePageScript(`document.querySelector('button[aria-label="Select model family"]')?.click()`);
        await new Promise(resolve => setTimeout(resolve, 250));
        const selected = await this.executePageScript(`(() => {
          const wanted = ${JSON.stringify(preferred.toLowerCase())};
          const option = [...document.querySelectorAll('[role="menuitem"],[role="option"]')].find(el =>
            el.getBoundingClientRect().width > 0 && el.innerText.trim().toLowerCase().replace(/^🍌\\s*/, '') === wanted);
          if (!option) return false;
          option.click(); return true;
        })()`);
        if (!selected) throw new Error('selector_failure: requested image model unavailable');
        await this.closeSettingsPanel();
        if (!(await this.settingsTriggerText()).toLowerCase().includes(preferred.toLowerCase())) throw new Error('selector_failure: requested image model did not become selected');
      }
      actualModel = (await this.settingsTriggerText()).replace('Settings trigger', '').split('\n')[0].trim();
    }

    if (type === 'video' || type === 'sound_effect') {
      const videoSelection = await this.selectVideoModeAndModel(request);
      actualModel = videoSelection.actual_model;
      // Omni attaches reference images directly to the prompt. Its Frames
      // lane must never be used to imply unsupported start/end-frame control.
      // Keep one verified popover open. Closing/reopening between each setting
      // races Flow's overlay teardown and can hide the 720p control mid-setup.
      await this.selectSettingsRadio(['ingredients'], { required: true, label: 'Omni Ingredients mode' });
      const resolution = type === 'sound_effect' ? '360p' : String(settings.generation_resolution || '720p');
      await this.selectSettingsRadio([resolution], { required: true, label: resolution + ' resolution' });
    }

    if (request.aspect_ratio) {
      await this.selectSettingsRadio(this.aspectRatioPatterns(request.aspect_ratio), {
        required: true,
        label: 'aspect ratio'
      });
    }

    const count = Math.max(1, Math.min(Number(request.output_count || 1), 4));
    await this.selectSettingsRadio(['x' + count], {
      required: true,
      label: 'output count'
    });

    const requestedDuration = Number(request.duration || 0);
    if ((type === 'video' || type === 'sound_effect') && requestedDuration > 0) {
      const supported = [4, 6, 8, 10];
      const seconds = supported.find(value => value >= requestedDuration) || 10;
      await this.selectSettingsRadio([seconds + 's', seconds + ' sec', seconds + ' seconds'], {
        required: true,
        label: 'video duration'
      });
    }

    await this.closeSettingsPanel();
    return { ok: true, settings: await this.settingsTriggerText(), actual_model: actualModel };
  }

  async uploadReferences(references = []) {
    return new FlowReferenceController(this).prepare(references);
  }

  async resultSnapshot() {
    return this.executePageScript(`(() => [...document.querySelectorAll('flow-image-tile,flow-video-tile')].map(tile => {
      const image = tile.querySelector('img[src]');
      let key = image?.getAttribute('data-media-id') || '';
      if (!key && image?.src) { try { key = new URL(image.src).pathname; } catch {} }
      const text = tile.textContent || '';
      return { key, type: tile.tagName === 'FLOW-VIDEO-TILE' ? 'video' : 'image',
        text: text.trim().slice(0, 2000), ready: Boolean(key && image?.complete && image.naturalWidth > 0 &&
          tile.querySelector('button[aria-label="More options"]') && !/generating|processing|[0-9]+%/i.test(text)) };
    }))()`);
  }

  async resultForJob(job, { results = null, excludeKeys = null } = {}) {
    results = results || await this.resultSnapshot();
    const submission = job?.provider_submission || {};
    const type = job?.request?.type === 'sound_effect' ? 'video' : job?.request?.type;
    if (submission.result_key) {
      const saved = results.find(result => result.key === submission.result_key && result.type === type && result.ready);
      if (saved) return saved;
    }
    // Thumbnail URLs can change on reload. Match the provider's full prompt,
    // including on fresh tiles, rather than choosing any key outside baseline.
    const prompt = String(job?.request?.provider_prompt || job?.request?.prompt || '').replace(/\s+/g, ' ').trim();
    if (!prompt) return null;
    const baseline = new Set(submission.baseline_result_keys || []);
    // In a bulk run, tiles already matched to other jobs (including copies of
    // the same prompt) belong to them.
    const taken = excludeKeys instanceof Set ? excludeKeys : new Set(excludeKeys || []);
    for (const result of results.filter(result => result.type === type && result.ready && !taken.has(result.key) &&
      (submission.result_key || !Array.isArray(submission.baseline_result_keys) || !baseline.has(result.key)))) {
      const info = await this.resultInfo(result.key);
      if (String(info?.prompt || '').replace(/\s+/g, ' ').trim() === prompt) return result;
    }
    return null;
  }

  async resultInfo(key) {
    if (key && this.resultInfoCache.has(key)) return this.resultInfoCache.get(key);
    const info = await this.readResultInfo(key);
    if (key && info?.prompt) {
      if (this.resultInfoCache.size > 500) this.resultInfoCache.delete(this.resultInfoCache.keys().next().value);
      this.resultInfoCache.set(key, info);
    }
    return info;
  }

  async readResultInfo(key) {
    return this.executePageScript(`(async () => {
      const key = ${JSON.stringify(key)};
      const tile = [...document.querySelectorAll('flow-image-tile,flow-video-tile')].find(tile => {
        const image = tile.querySelector('img[src]');
        let id = image?.getAttribute('data-media-id') || '';
        if (!id && image?.src) { try { id = new URL(image.src).pathname; } catch {} }
        return id === key;
      });
      const footer = tile?.querySelector('.footer-left[role="button"]');
      if (!footer) return null;
      footer.click();
      await new Promise(resolve => setTimeout(resolve, 200));
      const panel = [...document.querySelectorAll('flow-info-panel')].find(el => el.getBoundingClientRect().width > 0);
      const info = { prompt: panel?.querySelector('.prompt-text')?.textContent || '', metadata: panel?.querySelector('.metadata')?.textContent || '' };
      footer.click();
      return info;
    })()`);
  }

  async generationSnapshot() {
    return this.executePageScript(`(() => {
      const button = document.querySelector('button.generate-icon-button')
        || [...document.querySelectorAll('button')].find(el => /start generation/i.test(((el.getAttribute('aria-label') || '') + ' ' + (el.innerText || '')).trim()));
      const prompt = [...document.querySelectorAll('textarea, [contenteditable="true"]')].find(el => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 2 && rect.height > 2 && style.display !== 'none' && style.visibility !== 'hidden';
      });
      const promptText = prompt
        ? ('value' in prompt ? String(prompt.value || '') : String(prompt.innerText || prompt.textContent || ''))
        : '';
      const empty = [...document.querySelectorAll('.empty-project-message, .empty-project-text')]
        .some(el => {
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0 && /start creating|drop media/i.test(el.innerText || el.textContent || '');
        });
      const body = (document.body?.innerText || '').toLowerCase();
      const mediaCount = document.querySelectorAll('img[src], video[src], [class*="media-tile"], [class*="asset-tile"]').length;
      let buttonInfo = null;
      if (button) {
        const rect = button.getBoundingClientRect();
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;
        const top = document.elementFromPoint(centerX, centerY);
        buttonInfo = {
          tag: button.tagName,
          cls: String(button.className || '').slice(0, 300),
          aria: button.getAttribute('aria-label') || '',
          text: String(button.innerText || button.textContent || '').trim().slice(0, 300),
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          topTag: top?.tagName || '',
          topCls: String(top?.className || '').slice(0, 300),
          topText: String(top?.innerText || top?.textContent || '').trim().slice(0, 300),
          topIsButton: top === button || button.contains(top)
        };
      }
      return {
        generateDisabled: !!button && (button.disabled || button.getAttribute('aria-disabled') === 'true' || button.classList.contains('mat-mdc-button-disabled')),
        promptText: promptText.slice(0, 1000),
        promptInfo: prompt ? {
          tag: prompt.tagName,
          cls: String(prompt.className || '').slice(0, 300),
          aria: prompt.getAttribute('aria-label') || '',
          contenteditable: prompt.getAttribute('contenteditable') || ''
        } : null,
        buttonInfo,
        emptyProjectVisible: empty,
        mediaCount,
        progressSignal: /generating|creating|processing|rendering|cancel generation|stop generation/.test(body.replace(/generating will use [0-9]+ credits/g, ''))
      };
    })()`);
  }

  async startGenerationVerified(beforeSubmit = async () => {}, { nativeActivation = false } = {}) {
    let before = await this.generationSnapshot();
    const readyDeadline = Date.now() + 10000;
    while ((before.generateDisabled || !before.promptText) && Date.now() < readyDeadline) {
      await new Promise(resolve => setTimeout(resolve, 300));
      before = await this.generationSnapshot();
    }
    if (before.generateDisabled || !before.promptText) {
      const busy = capacitySignal(await this.executePageScript("document.body?.innerText || ''").catch(() => ''));
      if (busy) throw new Error('capacity_limited: Google Flow is busy before Generate: ' + busy);
      throw new Error(
        'selector_failure: Google Flow generate control did not become ready; snapshot=' +
        JSON.stringify(before).slice(0, 1600)
      );
    }
    const selector = await this.executePageScript(`(() => {
      const all = [...document.querySelectorAll('button')];
      const target = all.find(el => {
        const text = ((el.getAttribute('aria-label') || '') + ' ' + (el.innerText || '')).trim().toLowerCase();
        const rect = el.getBoundingClientRect();
        const disabled = el.disabled || el.getAttribute('aria-disabled') === 'true' || el.classList.contains('mat-mdc-button-disabled');
        return rect.width > 0 && rect.height > 0 && !disabled && (el.classList.contains('generate-icon-button') || text.includes('start generation'));
      });
      if (!target) return '';
      const marker = 'teamyra-generate-' + Math.random().toString(36).slice(2);
      target.setAttribute('data-teamyra-generate-target', marker);
      return '[data-teamyra-generate-target="' + marker + '"]';
    })()`);
    if (!selector) throw new Error('selector_failure: Google Flow generate control is unavailable or disabled');

    const acceptedFrom = async baseline => {
      const deadline = Date.now() + 15000;
      let after = baseline;
      while (Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 250));
        after = await this.generationSnapshot();
        const accepted =
          (!baseline.generateDisabled && after.generateDisabled) ||
          (!baseline.progressSignal && after.progressSignal) ||
          after.mediaCount > baseline.mediaCount ||
          (baseline.emptyProjectVisible && !after.emptyProjectVisible) ||
          (baseline.promptText && after.promptText !== baseline.promptText);
        if (accepted) return { ok: true, after };
      }
      return { ok: false, after };
    };

    await beforeSubmit(before);
    // A delayed acknowledgement must never trigger a second provider generation.
    if (nativeActivation) await this.browser.clickSelector(selector);
    else await this.executePageScript(`(() => {
      const button = document.querySelector(${JSON.stringify(selector)});
      if (!button || button.disabled) throw new Error('Generate control unavailable');
      button.click();
      return true;
    })()`, 1);
    const result = await acceptedFrom(before);
    if (result.ok) return { clicked: true, before, after: result.after };

    throw new Error(
      'selector_failure: Google Flow did not acknowledge the generation request; before=' +
      JSON.stringify(before).slice(0, 1400) + '; after=' + JSON.stringify(result.after).slice(0, 1400)
    );
  }

  async submit(job, beforeSubmit = async () => {}) {
    return this.browser.withActivePage(() => this.submitToWorkspace(job, beforeSubmit));
  }

  async submitToWorkspace(job, beforeSubmit) {
    const request = job.request;
    await this.stage('workspace', () => this.ensureWorkspace());
    await this.stage('workspace_ready', async () => {
      const deadline = Date.now() + 20000;
      while (await this.executePageScript(`Boolean(document.querySelector('flow-loading-page'))`)) {
        if (Date.now() >= deadline) throw new Error('selector_failure: Flow workspace loading did not finish');
        await new Promise(resolve => setTimeout(resolve, 150));
      }
      if (!await this.waitForSettingsTrigger()) throw new Error('selector_failure: Flow composer unavailable');
    });
    await new FlowReferenceController(this).clearComposer();
    const intent = await this.stage('intent', () => this.selectIntent(request, job.operation));
    const references = await this.stage('references', () => this.uploadReferences(job.resolved_references || []), null);
    const selector = await this.stage('prompt_find', () => this.waitForPrompt());
    await this.browser.clickSelector(selector).catch(() => false);
    await this.stage('prompt_clear', () => this.browser.clearText(selector));
    const readPrompt = () => this.executePageScript(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      return el ? ('value' in el ? el.value : el.innerText || el.textContent || '') : null;
    })()`);
    if (String(await readPrompt()).trim()) throw new Error('selector_failure: prompt editor did not clear');
    const providerPrompt = request.provider_prompt || request.prompt;
    await this.stage('prompt_fill', () => this.browser.insertText(selector, providerPrompt));
    const normalizeText = value => String(value || '').replace(/\s+/g, ' ').trim();
    if (normalizeText(await readPrompt()) !== normalizeText(providerPrompt)) throw new Error('selector_failure: prompt editor did not update');
    if (references && !await new FlowReferenceController(this).matches(references.items)) {
      throw new Error('selector_failure: prompt reference identities changed before generation');
    }
    const baselineResults = await this.resultSnapshot();
    const baselineFailures = failureSignalCount(await this.executePageScript("document.body?.innerText || ''").catch(() => ''));
    const generation = await this.stage('generation_click', () => this.startGenerationVerified(async before => {
      await beforeSubmit({
        submitted_at: Date.now() / 1000,
        provider_url: this.webContents.getURL(),
        baseline_media_count: Number(before.mediaCount || 0),
        baseline_result_keys: baselineResults.map(result => result.key).filter(Boolean),
        baseline_failure_signals: baselineFailures,
        selected_settings: await this.settingsTriggerText(),
        actual_model: intent.actual_model,
        reference_attachments: references?.items || [],
        reference_mode: 'ingredients',
        acknowledgement_pending: true
      });
    }, { nativeActivation: request.type === 'image' }), 60000);
    return {
      submitted_at: Date.now() / 1000,
      provider_url: this.webContents.getURL(),
      baseline_media_count: Number(generation?.before?.mediaCount || 0),
      baseline_result_keys: baselineResults.map(result => result.key).filter(Boolean),
      baseline_failure_signals: baselineFailures,
      selected_settings: await this.settingsTriggerText(),
      actual_model: intent.actual_model,
      reference_attachments: references?.items || [],
      reference_mode: 'ingredients'
    };
  }

  async pageState(expectedUrl = '', acceptableUrls = null, { allowNavigation = true } = {}) {
    // Bulk jobs submitted from one page share it: any of their submission
    // URLs is acceptable, so polling never reloads between them. A reload
    // would also abort in-page upscale downloads, so callers can defer it.
    const currentUrl = this.webContents.getURL();
    const acceptable = acceptableUrls || [expectedUrl];
    if (allowNavigation && expectedUrl && /^https:\/\/flow\.google\.com\/project\//i.test(expectedUrl) && !acceptable.includes(currentUrl)) {
      await this.loadProjectUrl(expectedUrl).catch(() => {});
    }
    let probe;
    try {
      probe = await this.probe();
    } catch (error) {
      if (this.isTransientPageError(error)) return { state: 'generating', reason: 'page_transition' };
      throw error;
    }
    const cls = this.classifyProbe(probe);
    if (cls.challenged) return { state: 'needs_user_auth', reason: 'human_verification' };
    if (!cls.signedIn) {
      const authVisible = (probe.buttonLabels || []).some(label => /^(sign in|log in|choose an account)$/i.test(String(label).trim()));
      if (!authVisible && /^https:\/\/flow\.google\.com\/project\//i.test(probe.url || this.webContents.getURL())) {
        return { state: 'generating', reason: 'page_transition' };
      }
      return { state: 'needs_user_auth', reason: 'login_required' };
    }
    return {
      state: 'ok',
      rate_limited: cls.rateLimited,
      credits_exhausted: cls.creditsExhausted,
      failure_signals: failureSignalCount(probe.text),
      project_id: projectId(probe.url || this.webContents.getURL())
    };
  }

  async generationState(job = null) {
    const page = await this.pageState(job?.provider_submission?.provider_url || '');
    if (page.state !== 'ok') return page;
    // A finished result wins over unrelated page-wide warnings.
    const result = await this.resultForJob(job);
    if (result) return { state: 'ready_to_download', result_key: result.key };
    if (page.rate_limited) return { state: 'rate_limited', reason: 'rate_limited' };
    if (page.credits_exhausted) return { state: 'failed', reason: 'credits_exhausted' };
    const baseline = job?.provider_submission?.baseline_failure_signals;
    const refused = Number.isFinite(Number(baseline)) && baseline !== null
      ? page.failure_signals > Number(baseline)
      : page.failure_signals > 0;
    if (refused) return { state: 'failed', reason: 'policy_refusal' };
    return { state: 'generating' };
  }

  // One page inspection for every in-flight bulk job. Jobs are matched oldest
  // first and each tile is assigned at most once, so copies of one prompt and
  // already-claimed tiles never satisfy two jobs.
  async generationStates(jobs = [], { claimedKeys = [], allowNavigation = true } = {}) {
    const ordered = [...jobs].sort((a, b) =>
      Number(a?.provider_submission?.submitted_at || 0) - Number(b?.provider_submission?.submitted_at || 0));
    const current = projectId(this.webContents.getURL());
    const target = ordered.find(job => projectId(job?.provider_submission?.provider_url) === current) || ordered[0];
    const urls = ordered.map(job => job?.provider_submission?.provider_url).filter(Boolean);
    const page = await this.pageState(target?.provider_submission?.provider_url || '', urls, { allowNavigation });
    const states = new Map();
    if (page.state !== 'ok') {
      for (const job of ordered) states.set(job.job_id, { state: page.state, reason: page.reason });
      return { page, states };
    }
    const results = await this.resultSnapshot();
    const taken = new Set(claimedKeys);
    for (const job of ordered) {
      const jobProject = projectId(job?.provider_submission?.provider_url);
      if (jobProject && page.project_id && jobProject !== page.project_id) {
        states.set(job.job_id, { state: 'generating', reason: 'other_project' });
        continue;
      }
      const result = await this.resultForJob(job, { results, excludeKeys: taken });
      if (result) {
        taken.add(result.key);
        states.set(job.job_id, { state: 'ready_to_download', result_key: result.key });
      } else {
        states.set(job.job_id, { state: 'generating' });
      }
    }
    return { page, states };
  }

  // 64-bit difference hash of a result tile's thumbnail. Downloads arrive as
  // anonymous blob URLs; this lets concurrent downloads be attributed by content.
  // Flow serves thumbnails from another origin, so the page usually cannot read
  // their pixels; the main process then fetches the thumbnail with this view's
  // session and hashes it with FFmpeg, exactly like downloaded files.
  async resultFingerprint(key) {
    this.lastFingerprint = { key, source: null, reason: '' };
    if (!key) return null;
    const page = await this.executePageScript(`(async () => {
      const key = ${JSON.stringify(key)};
      const tile = [...document.querySelectorAll('flow-image-tile,flow-video-tile')].find(tile => {
        const image = tile.querySelector('img[src]');
        let id = image?.getAttribute('data-media-id') || '';
        if (!id && image?.src) { try { id = new URL(image.src).pathname; } catch {} }
        return id === key;
      });
      const image = tile?.querySelector('img[src]');
      if (!image) return { reason: 'thumbnail_missing' };
      const src = image.currentSrc || image.src || '';
      if (!image.complete || !image.naturalWidth) return { src, reason: 'thumbnail_not_loaded' };
      try {
        const canvas = document.createElement('canvas');
        canvas.width = 72; canvas.height = 64;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        context.imageSmoothingQuality = 'high';
        context.drawImage(image, 0, 0, 72, 64);
        const data = context.getImageData(0, 0, 72, 64).data;
        const gray = new Array(72).fill(0);
        for (let y = 0; y < 64; y += 1) for (let x = 0; x < 72; x += 1) {
          const i = (y * 72 + x) * 4;
          gray[Math.floor(y / 8) * 9 + Math.floor(x / 8)] += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        }
        let hex = '';
        for (let row = 0; row < 8; row += 1) {
          let byte = 0;
          for (let col = 0; col < 8; col += 1) byte = (byte << 1) | (gray[row * 9 + col] > gray[row * 9 + col + 1] ? 1 : 0);
          hex += byte.toString(16).padStart(2, '0');
        }
        return { hash: hex, src };
      } catch (error) {
        return { src, reason: 'canvas_' + String(error?.name || 'error').toLowerCase() };
      }
    })()`).catch(error => ({ reason: 'page_script: ' + String(error?.message || error).slice(0, 160) }));
    if (page?.hash) {
      this.lastFingerprint = { key, source: 'page_canvas', reason: '' };
      return page.hash;
    }
    const src = String(page?.src || '');
    if (!/^https:\/\//i.test(src) || typeof this.webContents.session?.fetch !== 'function') {
      this.lastFingerprint = { key, source: null, reason: page?.reason || 'thumbnail_unavailable' };
      return null;
    }
    const temp = path.join(os.tmpdir(), 'teamyra-thumb-' + process.pid + '-' + Math.random().toString(36).slice(2) + '.img');
    try {
      const response = await this.webContents.session.fetch(src);
      if (!response.ok) throw new Error('HTTP ' + response.status);
      fs.writeFileSync(temp, Buffer.from(await response.arrayBuffer()));
      const [hash] = await mediaFingerprints(temp, { maxFrames: 1 });
      this.lastFingerprint = { key, source: hash ? 'session_fetch' : null, reason: hash ? '' : 'thumbnail_decode_failed' };
      return hash || null;
    } catch (error) {
      this.lastFingerprint = { key, source: null, reason: 'thumbnail_fetch: ' + String(error?.message || error).slice(0, 160) };
      return null;
    } finally {
      try { fs.unlinkSync(temp); } catch {}
    }
  }

  async openGeneratedAssetMenu(resultKey = null) {
    // Close any leftover menu so the subsequent choices belong to this exact tile.
    await this.executePageScript(`document.querySelector('.cdk-overlay-backdrop')?.click()`);
    const selector = await this.executePageScript(`(() => {
      const visible = el => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' &&
          style.visibility !== 'hidden' && Number(style.opacity || 1) !== 0;
      };
      const key = ${JSON.stringify(resultKey)};
      const tiles = [...document.querySelectorAll('flow-image-tile,flow-video-tile')];
      const tile = tiles.find(tile => {
        const image = tile.querySelector('img[src]');
        let id = image?.getAttribute('data-media-id') || '';
        if (!id && image?.src) { try { id = new URL(image.src).pathname; } catch {} }
        return key && id === key;
      });
      const target = tile?.querySelector('button[aria-label="More options"]');
      if (!target) return '';
      const marker = 'teamyra-result-menu-' + Math.random().toString(36).slice(2);
      target.setAttribute('data-teamyra-result-menu', marker);
      return '[data-teamyra-result-menu="' + marker + '"]';
    })()`);
    if (!selector) return false;
    const attempts = [
      () => this.executePageScript(`document.querySelector(${JSON.stringify(selector)})?.click()`)
    ];
    for (const attempt of attempts) {
      await attempt().catch(() => false);
      await new Promise(resolve => setTimeout(resolve, 250));
      const choices = await this.downloadChoices().catch(() => []);
      if (choices.some(choice => /download|upscale|1080p|2x|4x|original|source/i.test(choice.text))) return true;
    }
    return false;
  }

  async clickDownloadChoice(patterns) {
    return this.executePageScript(`(() => {
      const patterns = ${JSON.stringify(patterns.map(lower))};
      const target = [...document.querySelectorAll('[role="menuitem"],button')].find(el => {
        const r = el.getBoundingClientRect();
        const text = ((el.getAttribute('aria-label') || '') + ' ' + (el.innerText || '')).trim().toLowerCase();
        return r.width > 0 && r.height > 0 && !el.disabled && el.getAttribute('aria-disabled') !== 'true' && patterns.some(p => text.includes(p));
      });
      if (!target) return false;
      target.click(); return true;
    })()`);
  }

  async downloadChoices() {
    return this.executePageScript(`(() => [...document.querySelectorAll('[role="menuitem"],button')]
      .filter(el => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' &&
          s.display !== 'none' && !el.disabled && el.getAttribute('aria-disabled') !== 'true';
      }).map(el => ({
        text: ((el.getAttribute('aria-label') || '') + ' ' + (el.innerText || '')).trim(),
        submenu: el.getAttribute('aria-haspopup') === 'menu' || el.classList.contains('mat-mdc-menu-item-submenu-trigger')
      })))()`);
  }

  async openDownloadChoices(resultKey) {
    if (!await this.openGeneratedAssetMenu(resultKey)) throw new Error('selector_failure: generated asset menu unavailable');
    const choices = await this.downloadChoices();
    const submenu = choices.find(item => /download/i.test(item.text) && item.submenu);
    if (submenu) {
      await this.clickDownloadChoice(['download']);
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const updated = await this.downloadChoices();
        if (updated.some(item => /original size|upscaled|1080p|4x|2x/i.test(item.text))) return updated;
        await new Promise(resolve => setTimeout(resolve, 150));
      }
      throw new Error('selector_failure: download quality submenu did not open');
    }
    return choices;
  }

  async startDownload(job = null, { excludeKeys = null } = {}) {
    const type = job?.request?.type;
    if (!type) throw new Error('download_failure: media request is missing');
    const result = await this.resultForJob(job, { excludeKeys });
    if (!result) throw new Error('download_failure: submitted result identity is unavailable');
    const choices = await this.openDownloadChoices(result.key);
    const quality = job.request.generation_settings?.download_quality ||
      (type === 'image' ? 'prefer_4x_then_2x' : type === 'video' ? '1080p' : 'source');
    let selected;
    let actualQuality = 'source';
    if (type === 'image' && quality !== 'source') {
      const four = choices.find(item => /4k|4x/i.test(item.text) && /upscal/i.test(item.text));
      const two = choices.find(item => /2k|2x/i.test(item.text) && /upscal/i.test(item.text));
      selected = quality === '2x' ? two : four || (quality === 'prefer_4x_then_2x' ? two : null);
      actualQuality = selected === four ? '4x' : '2x';
    } else if (type === 'video' && quality !== 'source') {
      selected = choices.find(item => /1080\s*p/i.test(item.text) && /upscal/i.test(item.text));
      actualQuality = '1080p';
    } else {
      selected = choices.find(item => /original size|original|source/i.test(item.text)) ||
        choices.find(item => /download media/i.test(item.text) && !item.submenu);
    }
    if (!selected) throw new Error('download_failure: requested ' + quality + ' quality is unavailable');
    if (!await this.clickDownloadChoice([selected.text])) {
      throw new Error('selector_failure: download quality control could not be activated');
    }
    // Flow's quality menu command starts upscale AND download. The consumer waits
    // for the actual Electron download event and completed file, not a second click.
    return { ok: true, quality: actualQuality, provider_label: selected.text, result_key: result.key,
      upscale: actualQuality !== 'source', wait_for_download: true };
  }

  async reconcile(job, { allowNavigation = true } = {}) {
    const url = job.provider_submission?.provider_url;
    if (!url) return { reconciled: false, reason: 'provider_identity_missing' };
    // Other bulk downloads are running: the shared monitor checks this job once
    // the page may navigate again.
    if (!allowNavigation) return { reconciled: true, state: { state: 'generating', reason: 'navigation_deferred' } };
    await this.loadProjectUrl(url);
    const state = await this.generationState(job);
    return { reconciled: true, state };
  }
}

module.exports = { GoogleFlowAutomationAdapter, FLOW_HOME, failureSignalCount, capacitySignal, projectId };
