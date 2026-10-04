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
      const controls = [...document.querySelectorAll('button, [role="button"], [role="menuitem"], [role="option"]')];
      return {
        url: location.href, title: document.title, text: text.slice(0, 10000), lower,
        promptFound: !!document.querySelector('textarea, [contenteditable="true"], input[type="text"]'),
        labels: controls.map(el => ((el.getAttribute('aria-label') || '') + ' ' + (el.innerText || '')).trim()).filter(Boolean).slice(0, 160)
      };
    })()`, true);
  }

  classifyProbe(probe) {
    const body = lower(probe?.lower || probe?.text);
    return {
      signedIn: !/sign in|log in|choose an account/.test(body),
      challenged: /verify you are human|unusual activity|captcha/.test(body),
      rateLimited: /rate limit|try again later|too many requests/.test(body),
      promptFound: probe?.promptFound === true
    };
  }

  async capabilities() {
    const probe = await this.probe();
    const joined = (probe.labels || []).map(lower).join(' | ');
    return {
      surface: 'google-flow-music',
      text_prompt: true,
      image_prompt: /image|photo/.test(joined),
      audio_prompt: /audio|upload/.test(joined),
      instrumental: /instrumental/.test(joined),
      vocals: /vocal|lyrics/.test(joined),
      remix: /remix/.test(joined),
      extend: /extend|continue/.test(joined),
      replace_section: /replace|section/.test(joined),
      discovered_controls: (probe.labels || []).slice(0, 80)
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

  async submit(job) {
    const request = job.request;
    const operationLabels = {
      music_remix: ['remix'],
      music_extend: ['extend', 'continue'],
      music_replace_section: ['replace', 'section']
    };
    if (operationLabels[job.operation]) await this.semanticClick(operationLabels[job.operation]);
    await this.uploadReferences(job.resolved_references || []);
    if (request.instrumental) await this.semanticClick(['instrumental']);
    if (request.vocals) await this.semanticClick(['vocals', 'lyrics']);
    const selector = await this.webContents.executeJavaScript(`(() => {
      const selectors = ['textarea[aria-label*="prompt" i]','textarea[placeholder*="prompt" i]','[contenteditable="true"][aria-label*="prompt" i]','textarea','[contenteditable="true"]'];
      for (const selector of selectors) {
        for (const el of document.querySelectorAll(selector)) {
          const rect = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          const hidden = style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || 1) === 0;
          if (rect.width < 2 || rect.height < 2 || hidden || el.disabled || el.getAttribute('aria-hidden') === 'true') continue;
          const marker = 'teamyra-music-prompt-' + Math.random().toString(36).slice(2);
          el.setAttribute('data-teamyra-music-prompt-target', marker);
          return '[data-teamyra-music-prompt-target="' + marker + '"]';
        }
      }
      return '';
    })()`, true);
    if (!selector) throw new Error('selector_failure: Flow Music prompt input was not found');
    await this.browser.clickSelector(selector).catch(() => false);
    await this.browser.insertText(selector, request.prompt + (request.lyrics ? '\n\nLyrics:\n' + request.lyrics : ''));
    const clicked = await this.semanticClick(['generate', 'create']);
    if (!clicked) throw new Error('selector_failure: Flow Music generate control was not found');
    return { submitted_at: Date.now() / 1000, provider_url: this.webContents.getURL() };
  }

  async generationState() {
    const probe = await this.probe();
    const cls = this.classifyProbe(probe);
    if (cls.challenged) return { state: 'needs_user_auth', reason: 'human_verification' };
    if (!cls.signedIn) return { state: 'needs_user_auth', reason: 'login_required' };
    if (cls.rateLimited) return { state: 'rate_limited', reason: 'rate_limited' };
    const body = lower(probe.text);
    if (/policy|couldn.?t generate|can.?t generate|not allowed/.test(body)) return { state: 'failed', reason: 'policy_refusal' };
    const hasDownload = (probe.labels || []).some(label => /download/i.test(label));
    if (hasDownload) return { state: 'ready_to_download' };
    return { state: 'generating' };
  }

  async startDownload() {
    const clicked = await this.semanticClick(['download']);
    if (!clicked) throw new Error('selector_failure: Flow Music download control was not found');
    return { ok: true };
  }

  async reconcile(job) {
    const url = job.provider_submission?.provider_url;
    if (!url) return { reconciled: false, reason: 'provider_identity_missing' };
    await this.webContents.loadURL(url);
    const state = await this.generationState();
    return { reconciled: true, state };
  }
}

module.exports = { GoogleFlowMusicAutomationAdapter, FLOW_MUSIC_HOME };
