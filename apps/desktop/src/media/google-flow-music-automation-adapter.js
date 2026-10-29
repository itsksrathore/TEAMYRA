const { MediaBrowserController } = require('./media-browser-controller');

const FLOW_MUSIC_HOME = 'https://www.flowmusic.app/';

function lower(value) { return String(value || '').toLowerCase(); }

class GoogleFlowMusicAutomationAdapter {
  constructor(webContents) {
    this.webContents = webContents;
    this.browser = new MediaBrowserController(webContents);
  }

  async probe() {
    return this.webContents.executeJavaScript(`(() => {
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
      const controls = [...document.querySelectorAll('button, [role="button"], [role="menuitem"], [role="option"]')].filter(visible);
      const allDetails = controls.map(el => {
        const label = ((el.getAttribute('aria-label') || '') + ' ' + (el.innerText || '')).trim();
        return {
          label,
          tag: el.tagName,
          role: el.getAttribute('role') || '',
          cls: String(el.className || '').slice(0, 180),
          type: el.getAttribute('type') || ''
        };
      }).filter(item => item.label);
      const resultLabels = allDetails
        .map(item => item.label)
        .filter(label => /^more options for /i.test(label))
        .slice(0, 400);
      const resultEntries = controls.filter(el => /^more options for /i.test(el.getAttribute('aria-label') || '')).flatMap(el => {
        const card = el.closest('[role="button"]');
        const link = card?.querySelector('a[href^="/song/"]');
        return link ? [{ key: link.getAttribute('href'), label: el.getAttribute('aria-label') }] : [];
      });
      const controlDetails = allDetails.slice(0, 160);
      return {
        url: location.href, title: document.title, text: text.slice(0, 10000), lower,
        promptFound: !!document.querySelector('textarea, [contenteditable="true"], input[type="text"]'),
        labels: controlDetails.map(item => item.label),
        resultLabels,
        resultEntries,
        controlDetails
      };
    })()`, true);
  }

  classifyProbe(probe) {
    const body = lower(probe?.lower || probe?.text);
    const labels = (probe?.labels || []).map(lower).join(' | ');
    let host = '';
    try { host = new URL(String(probe?.url || '')).hostname; } catch {}
    const onMusicApp = host === 'flowmusic.app' || host === 'www.flowmusic.app';
    const strongAuthenticatedUi =
      /settings menu/.test(labels) && /member/.test(labels) &&
      (/new session/.test(labels) || /profile/.test(labels) || /songs/.test(labels));
    const explicitAuthUi = /continue with google|choose an account/.test(labels) ||
      /continue with google|choose an account/.test(body);
    return {
      signedIn: onMusicApp && strongAuthenticatedUi && !explicitAuthUi,
      challenged: /verify you are human|unusual activity|captcha/.test(body),
      rateLimited: /rate limit|try again later|too many requests/.test(body),
      creditsExhausted: /credits exhausted|no credits|not enough credits|insufficient credits|out of credits|credit limit reached/.test(body),
      promptFound: probe?.promptFound === true
    };
  }

  async capabilities(existingProbe = null) {
    const probe = existingProbe || await this.probe();
    const joined = (probe.labels || []).map(lower).join(' | ');
    return {
      surface: 'google-flow-music',
      text_prompt: true,
      image_prompt: /image|photo/.test(joined),
      audio_prompt: /audio|upload/.test(joined),
      instrumental: /instrumental/.test(joined),
      vocals: /vocal|lyrics/.test(joined),
      remix: false,
      extend: false,
      replace_section: false,
      discovered_controls: (probe.labels || []).slice(0, 80),
      google_auth_control: (probe.controlDetails || []).find(item => /continue with google/i.test(item.label || '')) || null
    };
  }

  async semanticClick(patterns) {
    const serialized = JSON.stringify(patterns.map(value => lower(value)));
    const selector = await this.webContents.executeJavaScript(`(() => {
      const patterns = ${serialized};
      const all = [...document.querySelectorAll('button, [role="button"], [role="menuitem"], [role="option"]')];
      const target = all.find(el => {
        const text = ((el.getAttribute('aria-label') || '') + ' ' + (el.innerText || '')).trim().toLowerCase();
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && patterns.some(pattern => text.includes(pattern));
      });
      if (!target) return '';
      const marker = 'teamyra-music-' + Math.random().toString(36).slice(2);
      target.setAttribute('data-teamyra-music-target', marker);
      return '[data-teamyra-music-target="' + marker + '"]';
    })()`, true);
    if (!selector) return false;
    try {
      const clicked = await this.browser.clickSelector(selector);
      if (clicked) return true;
    } catch {}
    return this.webContents.executeJavaScript(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true; })()`, true).catch(() => false);
  }

  async beginGoogleAuthorization(timeoutMs = 12000) {
    let probe = await this.probe().catch(() => null);
    if (probe && this.classifyProbe(probe).signedIn) return { authorized: true, started: false };

    await this.semanticClick(['log in', 'login']).catch(() => false);
    const deadline = Date.now() + timeoutMs;
    let googleClicked = false;
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 450));
      probe = await this.probe().catch(() => null);
      if (probe && this.classifyProbe(probe).signedIn) return { authorized: true, started: true };
      const labels = (probe?.labels || []).map(lower);
      if (!googleClicked && labels.some(label => label.includes('continue with google'))) {
        googleClicked = await this.semanticClick(['continue with google']).catch(() => false);
        if (googleClicked) {
          await new Promise(resolve => setTimeout(resolve, 900));
          return { authorized: false, started: true, needs_user_action: true };
        }
      }
    }
    return { authorized: false, started: true, needs_user_action: true };
  }

  async uploadReferences(references = []) {
    const files = references.map(item => item.path).filter(Boolean);
    if (!files.length) return;
    await this.semanticClick(['upload', 'add', 'image', 'audio']);
    for (const selector of ['input[type="file"][multiple]', 'input[type="file"]']) {
      if (await this.browser.query(selector)) {
        await this.browser.setFiles(selector, files);
        return;
      }
    }
    throw new Error('selector_failure: Flow Music file input was not found');
  }

  async fillField(selector, text) {
    const cleared = await this.webContents.executeJavaScript(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(el, '');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`, true);
    if (!cleared) throw new Error('selector_failure: Flow Music input unavailable');
    await this.browser.insertText(selector, text);
    const actual = await this.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(selector)})?.value`, true);
    if (actual !== text) throw new Error('selector_failure: Flow Music input did not update');
  }

  async submit(job, beforeSubmit = async () => {}) {
    if (job.operation) throw new Error('selector_failure: Flow Music transform is unsupported; an existing song will not be replaced by a fresh generation');
    const request = job.request;
    // Use the actual composer, not the Explore page's AI conversation input.
    await this.webContents.loadURL(new URL('/session', FLOW_MUSIC_HOME).href);
    const deadline = Date.now() + 15000;
    while (!await this.browser.query('textarea[aria-label="Sound description"]')) {
      if (Date.now() >= deadline) throw new Error('selector_failure: Flow Music composer unavailable');
      await this.semanticClick(['toggle compose panel', 'open compose panel']).catch(() => false);
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    await this.uploadReferences(job.resolved_references || []);
    await this.fillField('textarea[aria-label="Sound description"]', request.prompt);
    if (request.lyrics) await this.fillField('textarea[aria-label="Lyrics"]', request.lyrics);
    const switchSelector = 'button[aria-label="Toggle instrumental mode"]';
    const desired = request.instrumental === true;
    const readSwitch = () => this.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(switchSelector)})?.getAttribute('aria-checked')`, true);
    const switchActions = [
      () => this.browser.clickSelector(switchSelector),
      () => this.browser.pressKeySelector(switchSelector, 'Enter'),
      () => this.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(switchSelector)})?.click()`, true)
    ];
    for (const action of switchActions) {
      if ((await readSwitch() === 'true') === desired) break;
      await action();
      await new Promise(resolve => setTimeout(resolve, 300));
    }
    if ((await readSwitch() === 'true') !== desired) throw new Error('selector_failure: instrumental mode did not update');
    const before = await this.probe();
    const pending = {
      submitted_at: Date.now() / 1000, provider_url: this.webContents.getURL(),
      prompt_excerpt: request.prompt.slice(0, 160),
      baseline_result_labels: before.resultLabels || [], acknowledgement_pending: true,
      baseline_result_keys: (before.resultEntries || []).map(item => item.key)
    };
    await beforeSubmit(pending);
    const clicked = await this.webContents.executeJavaScript(`(() => {
      const button = [...document.querySelectorAll('button')].find(el => el.innerText.trim().toLowerCase() === 'generate' && !el.disabled);
      if (!button) return false;
      button.click(); return true;
    })()`, true);
    if (!clicked) throw new Error('selector_failure: Flow Music Generate control unavailable');
    const acceptedDeadline = Date.now() + 12000;
    while (Date.now() < acceptedDeadline) {
      await new Promise(resolve => setTimeout(resolve, 350));
      if (/\/session\/[^/]+/.test(this.webContents.getURL())) {
        return { ...pending, provider_url: this.webContents.getURL(), acknowledgement_pending: false };
      }
    }
    throw new Error('generation_failure: Flow Music acknowledgement uncertain; reconciliation required');
  }

  newResultLabel(probe, job) {
    const baselineLabels = job?.provider_submission?.baseline_result_labels;
    if (!Array.isArray(baselineLabels)) return null;
    // Public Explore results can change independently of this generation.
    if (!/\/session(?:\/|$)/.test(String(probe.url || ''))) return null;
    const keys = job?.provider_submission?.baseline_result_keys;
    if (Array.isArray(keys)) {
      const baseline = new Set(keys);
      const savedKey = job.provider_submission.result_key;
      return (probe.resultEntries || []).find(item => savedKey ? item.key === savedKey : !baseline.has(item.key))?.label || null;
    }
    const baseline = new Set(baselineLabels.map(lower));
    return (probe.resultLabels || []).find(label => !baseline.has(lower(label))) || null;
  }

  async generationState(job = null) {
    const probe = await this.probe();
    const cls = this.classifyProbe(probe);
    if (cls.challenged) return { state: 'needs_user_auth', reason: 'human_verification' };
    if (!cls.signedIn) return { state: 'needs_user_auth', reason: 'login_required' };
    if (cls.rateLimited) return { state: 'rate_limited', reason: 'rate_limited' };
    if (cls.creditsExhausted) return { state: 'failed', reason: 'credits_exhausted' };
    const body = lower(probe.text);
    if (/policy|couldn.?t generate|can.?t generate|not allowed/.test(body)) return { state: 'failed', reason: 'policy_refusal' };
    const newResult = this.newResultLabel(probe, job);
    if (newResult) {
      const keys = new Set(job?.provider_submission?.baseline_result_keys || []);
      const savedKey = job?.provider_submission?.result_key;
      const entry = (probe.resultEntries || []).find(item => item.label === newResult && (savedKey ? item.key === savedKey : !keys.has(item.key)));
      return { state: 'ready_to_download', result_label: newResult, result_key: entry?.key };
    }
    return { state: 'generating' };
  }

  async startDownload(job = null) {
    const probe = await this.probe();
    const label = this.newResultLabel(probe, job);
    if (!label) throw new Error('download_failure: no new result belonging to this music session');
    const opened = await this.webContents.executeJavaScript(`(() => {
      const wanted = ${JSON.stringify(label)};
      const key = ${JSON.stringify(job.provider_submission?.result_key || '')};
      const button = [...document.querySelectorAll('button[aria-haspopup="menu"]')].find(el => {
        if (((el.getAttribute('aria-label') || '') + ' ' + (el.innerText || '')).trim() !== wanted) return false;
        return !key || el.closest('[role="button"]')?.querySelector('a[href^="/song/"]')?.getAttribute('href') === key;
      });
      if (!button) return false;
      if (button.getAttribute('aria-expanded') !== 'true') {
        button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse', isPrimary: true }));
      }
      return true;
    })()`, true);
    if (!opened) throw new Error('selector_failure: generated song overflow unavailable');
    const format = String(job.request?.format || 'wav').toUpperCase();
    const deadline = Date.now() + 8000;
    let submenuOpened = false;
    while (Date.now() < deadline) {
      const state = await this.webContents.executeJavaScript(`(() => {
        const visible = el => el.getBoundingClientRect().width > 0 && el.getAttribute('data-disabled') === null;
        const items = [...document.querySelectorAll('[role="menuitem"]')].filter(visible);
        const audio = items.find(el => el.innerText.trim().toUpperCase() === ${JSON.stringify(format)});
        if (audio) { audio.click(); return 'download'; }
        const download = items.find(el => /^download(?: audio)?$/i.test(el.innerText.trim()));
        if (download && download.getAttribute('aria-haspopup') === 'menu' && download.getAttribute('aria-expanded') !== 'true') {
          download.focus();
          download.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
          return 'submenu';
        }
        const direct = items.find(el => /^download audio$/i.test(el.innerText.trim()) && !el.hasAttribute('aria-haspopup'));
        if (direct) { direct.click(); return 'download'; }
        return 'waiting';
      })()`, true);
      if (state === 'download') return { ok: true, result_label: label, format: format.toLowerCase(), audio_only: true };
      if (state === 'submenu') submenuOpened = true;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    throw new Error('selector_failure: Flow Music audio download menu unavailable; submenu=' + submenuOpened);
  }

  async reconcile(job) {
    const url = job.provider_submission?.provider_url;
    if (!url || !/\/session\/[^/]+/.test(url)) return { reconciled: false, reason: 'provider_session_identity_missing' };
    await this.webContents.loadURL(url);
    const state = await this.generationState(job);
    return { reconciled: true, state };
  }
}

module.exports = { GoogleFlowMusicAutomationAdapter, FLOW_MUSIC_HOME };
