const { MediaBrowserController } = require('./media-browser-controller');

const FLOW_HOME = 'https://flow.google.com/';
const AUTH_WORDS = ['sign in', 'log in', 'choose an account'];
const CHALLENGE_WORDS = ['verify you are human', 'unusual activity', 'captcha'];
const RATE_WORDS = ['rate limit', 'try again later', 'too many requests'];
const CREDIT_WORDS = ['credits', 'credit limit', 'not enough credits', 'out of credits'];

function lower(value) { return String(value || '').toLowerCase(); }

class GoogleFlowAutomationAdapter {
  constructor(webContents) {
    this.webContents = webContents;
    this.browser = new MediaBrowserController(webContents);
  }

  async probe() {
    return this.webContents.executeJavaScript(`(() => {
      const text = (document.body?.innerText || '').slice(0, 30000);
      const lower = text.toLowerCase();
      const inputs = [...document.querySelectorAll('textarea, [contenteditable="true"], input[type="text"]')];
      const prompt = inputs.find(el => {
        const hint = ((el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('placeholder') || '')).toLowerCase();
        return /prompt|describe|what.*create|imagine/.test(hint);
      }) || inputs[0] || null;
      const buttons = [...document.querySelectorAll('button, [role="button"], a[href]')];
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
      return { url: location.href, title: document.title, text: text.slice(0, 10000), promptFound: !!prompt, buttonLabels: labels.slice(0, 160), controls, lower };
    })()`, true);
  }

  classifyProbe(probe) {
    const body = lower(probe?.lower || probe?.text);
    const labels = (probe?.buttonLabels || []).map(lower).join(' | ');
    const links = (probe?.controls || []).map(item => lower((item?.label || '') + ' ' + (item?.href || ''))).join(' | ');
    let host = '';
    try { host = new URL(String(probe?.url || '')).hostname; } catch {}
    const onFlow = host === 'flow.google.com' || host === 'www.flow.google.com';
    const authenticatedUi =
      /google account:|account details|new project|more options for the project/.test(body + ' | ' + labels + ' | ' + links) ||
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

  async capabilities() {
    const probe = await this.probe();
    const labels = (probe.buttonLabels || []).map(lower);
    const joined = labels.join(' | ');
    return {
      surface: 'google-flow',
      image: true,
      video: true,
      native_audio: /audio|sound/.test(joined),
      extend: /extend/.test(joined),
      ingredients: /ingredient|reference/.test(joined),
      first_last_frame: /first frame|last frame/.test(joined),
      models: [],
      discovered_controls: (probe.buttonLabels || []).slice(0, 24),
      discovered_control_links: (probe.controls || []).slice(0, 16).map(item => ({
        label: String(item.label || '').slice(0, 100),
        tag: item.tag,
        href: String(item.href || '').slice(0, 220)
      }))
    };
  }

  async promptSelector() {
    return this.webContents.executeJavaScript(`(() => {
      const selectors = [
        'textarea[aria-label*="prompt" i]', 'textarea[placeholder*="prompt" i]',
        '[contenteditable="true"][aria-label*="prompt" i]',
        '[contenteditable="true"][data-testid*="prompt" i]',
        'textarea', '[contenteditable="true"]'
      ];
      for (const selector of selectors) {
        for (const el of document.querySelectorAll(selector)) {
          const rect = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          const hidden = style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || 1) === 0;
          if (rect.width < 2 || rect.height < 2 || hidden || el.disabled || el.getAttribute('aria-hidden') === 'true') continue;
          const marker = 'teamyra-prompt-' + Math.random().toString(36).slice(2);
          el.setAttribute('data-teamyra-prompt-target', marker);
          return '[data-teamyra-prompt-target="' + marker + '"]';
        }
      }
      return '';
    })()`, true);
  }

  async semanticClick(patterns) {
    const serialized = JSON.stringify(patterns.map(value => String(value).toLowerCase()));
    const selector = await this.webContents.executeJavaScript(`(() => {
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
    })()`, true);
    if (!selector) return false;
    try {
      const clicked = await this.browser.clickSelector(selector);
      if (clicked) return true;
    } catch {}
    return this.webContents.executeJavaScript(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true; })()`, true).catch(() => false);
  }

  async clickCreateNew(timeoutMs = 12000) {
    const selector = '.create-applet-card[role="button"]';
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const nodeId = await this.browser.query(selector).catch(() => 0);
      if (nodeId) {
        const trustedClick = await this.browser.clickSelector(selector).catch(() => false);
        await new Promise(resolve => setTimeout(resolve, 900));
        if (!(await this.browser.query(selector).catch(() => 0))) return true;

        const keyboardFallback = await this.webContents.executeJavaScript(`(() => {
          const el = document.querySelector('.create-applet-card[role="button"]');
          if (!el) return false;
          el.focus();
          try { el.click(); } catch {}
          try { el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true })); } catch {}
          try { el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true })); } catch {}
          return true;
        })()`, true).catch(() => false);
        if (trustedClick || keyboardFallback) {
          await new Promise(resolve => setTimeout(resolve, 1400));
          return true;
        }
      }
      await new Promise(resolve => setTimeout(resolve, 400));
    }
    return false;
  }

  async projectUrls() {
    return this.webContents.executeJavaScript(`(() => [...document.querySelectorAll('a[href*="/project/"]')].map(a => a.href).filter(Boolean))()`, true)
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
    if (await this.promptSelector()) return { ready: true, existing: true };

    const currentUrl = this.webContents.getURL();
    if (/^https:\/\/flow\.google\.com\/project\//i.test(currentUrl)) {
      await this.clickCreateNew();
      return { ready: true, existing: true, project_url: currentUrl };
    }

    const before = new Set(await this.projectUrls());
    const clicked = await this.semanticClick(['new project']);
    if (!clicked) throw new Error('selector_failure: Google Flow New project control was not found');

    const startedAt = Date.now();
    const createDeadline = startedAt + Math.min(timeoutMs, 15000);
    let jsFallbackUsed = false;
    let targetUrl = null;

    while (Date.now() < createDeadline && !targetUrl) {
      await new Promise(resolve => setTimeout(resolve, 700));
      const urls = await this.projectUrls();
      targetUrl = urls.find(url => !before.has(url)) || null;

      if (!jsFallbackUsed && Date.now() - startedAt > 3500 && !targetUrl) {
        jsFallbackUsed = true;
        await this.webContents.executeJavaScript("(() => { const button = document.querySelector('button.new-project-button') || [...document.querySelectorAll('button')].find(el => /new project/i.test(el.innerText || el.getAttribute('aria-label') || '')); if (!button) return false; button.click(); return true; })()", true).catch(() => false);
      }
    }

    if (!targetUrl) {
      const urls = await this.projectUrls();
      targetUrl = urls[0] || null;
    }
    if (!targetUrl) throw new Error('selector_failure: Google Flow project card was not created');

    await this.loadProjectUrl(targetUrl);
    const createNewClicked = await this.clickCreateNew();
    if (!createNewClicked) throw new Error('selector_failure: Google Flow Create New control was not actionable');
    return { ready: true, existing: false, project_url: targetUrl };
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

  async selectIntent(request, operation = null) {
    const type = request.type;
    const operationLabels = {
      image_edit: ['edit image', 'edit'],
      image_variation: ['variation', 'variations'],
      video_extend: ['extend', 'extend video'],
      video_edit: ['edit video', 'edit'],
      video_to_video: ['video to video', 'remix video']
    };
    if (operationLabels[operation]) await this.semanticClick(operationLabels[operation]);
    if (type === 'image') await this.semanticClick(['image', 'create image', 'images']);
    if (type === 'video' || type === 'sound_effect') await this.semanticClick(['video', 'create video', 'videos']);
    if (request.aspect_ratio) {
      await this.semanticClick([request.aspect_ratio]);
    }
    return { ok: true };
  }

  async uploadReferences(references = []) {
    const files = references.map(item => item.path).filter(Boolean);
    if (!files.length) return { ok: true, count: 0 };
    await this.semanticClick(['upload', 'reference', 'ingredient', 'add media', 'add']);
    const selectors = ['input[type="file"][multiple]', 'input[type="file"]'];
    for (const selector of selectors) {
      try {
        if (await this.browser.query(selector)) {
          await this.browser.setFiles(selector, files);
          return { ok: true, count: files.length };
        }
      } catch {}
    }
    throw new Error('selector_failure: Google Flow reference file input was not found');
  }

  async generationSnapshot() {
    return this.webContents.executeJavaScript(`(() => {
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
      return {
        generateDisabled: !!button && (button.disabled || button.getAttribute('aria-disabled') === 'true' || button.classList.contains('mat-mdc-button-disabled')),
        promptText: promptText.slice(0, 1000),
        emptyProjectVisible: empty,
        mediaCount,
        progressSignal: /generating|creating|processing|rendering|cancel generation|stop generation/.test(body)
      };
    })()`, true);
  }

  async startGenerationVerified() {
    const before = await this.generationSnapshot();
    const selector = await this.webContents.executeJavaScript(`(() => {
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
    })()`, true);
    if (!selector) throw new Error('selector_failure: Google Flow generate control is unavailable or disabled');

    let clicked = false;
    try { clicked = await this.browser.clickSelector(selector); } catch {}
    if (!clicked) {
      clicked = await this.webContents.executeJavaScript(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        el.click();
        return true;
      })()`, true).catch(() => false);
    }
    if (!clicked) throw new Error('selector_failure: Google Flow generate control could not be clicked');

    const deadline = Date.now() + 8000;
    let after = before;
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 500));
      after = await this.generationSnapshot();
      const accepted =
        after.generateDisabled ||
        after.progressSignal ||
        after.mediaCount > before.mediaCount ||
        (before.emptyProjectVisible && !after.emptyProjectVisible) ||
        (before.promptText && !after.promptText);
      if (accepted) return { clicked: true, before, after };
    }

    throw new Error('selector_failure: Google Flow did not acknowledge the generation request');
  }

  async submit(job) {
    const request = job.request;
    await this.ensureWorkspace();
    await this.selectIntent(request, job.operation);
    await this.uploadReferences(job.resolved_references || []);
    const selector = await this.waitForPrompt();
    await this.browser.clickSelector(selector).catch(() => false);
    await this.webContents.executeJavaScript(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      el.focus();
      if ('value' in el) {
        const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (setter) setter.call(el, ''); else el.value = '';
        el.dispatchEvent(new Event('input', { bubbles: true }));
      } else {
        el.textContent = '';
        el.dispatchEvent(new InputEvent('input', { bubbles: true }));
      }
      return true;
    })()`, true);
    await this.browser.insertText(selector, request.provider_prompt || request.prompt);
    await this.startGenerationVerified();
    return {
      submitted_at: Date.now() / 1000,
      provider_url: this.webContents.getURL()
    };
  }

  async generationState(job = null) {
    const expectedUrl = job?.provider_submission?.provider_url || '';
    const currentUrl = this.webContents.getURL();
    if (expectedUrl && currentUrl !== expectedUrl && /^https:\/\/flow\.google\.com\/project\//i.test(expectedUrl)) {
      await this.loadProjectUrl(expectedUrl).catch(() => {});
    }
    const probe = await this.probe();
    const cls = this.classifyProbe(probe);
    if (cls.challenged) return { state: 'needs_user_auth', reason: 'human_verification' };
    if (!cls.signedIn) return { state: 'needs_user_auth', reason: 'login_required' };
    if (cls.rateLimited) return { state: 'rate_limited', reason: 'rate_limited' };
    if (cls.creditsExhausted) return { state: 'failed', reason: 'credits_exhausted' };
    const body = lower(probe.text);
    if (/policy|couldn.?t generate|can.?t generate|not allowed/.test(body)) return { state: 'failed', reason: 'policy_refusal' };
    const hasDownload = (probe.buttonLabels || []).some(label => /download/i.test(label));
    if (hasDownload) return { state: 'ready_to_download' };
    return { state: 'generating' };
  }

  async startDownload() {
    const clicked = await this.semanticClick(['download']);
    if (!clicked) throw new Error('selector_failure: Google Flow download control was not found');
    return { ok: true };
  }

  async reconcile(job) {
    const url = job.provider_submission?.provider_url;
    if (!url) return { reconciled: false, reason: 'provider_identity_missing' };
    await this.loadProjectUrl(url);
    const state = await this.generationState(job);
    return { reconciled: true, state };
  }
}

module.exports = { GoogleFlowAutomationAdapter, FLOW_HOME };
