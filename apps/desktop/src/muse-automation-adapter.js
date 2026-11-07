const { ChatGPTAutomationAdapter, teamyraError } = require('./chatgpt-automation-adapter');

const MUSE_HOME = 'https://muse.ai/';
const NEW_THREAD_URL = 'https://muse.ai/thread/new';
const PROMPT_SELECTOR = 'textarea[aria-label="Message"]';

// Every kind of human check (challenge-detect.js), next to this site's own.
const SHARED_CHALLENGE_JS = require('./challenge-detect').challengeScript(PROMPT_SELECTOR);
// Browser-side conversation reading for muse.ai (checked 2026-11-06). Messages
// are `[data-message-item]` with `data-message-role` user/assistant. A reply
// is everything the assistant wrote after the last user message (it can span
// several items). Muse's own message ids can change while a reply settles, so
// a reply is identified by the user message it answers plus its item count.
const MESSAGES_JS = `
  const museItems = () => [...document.querySelectorAll('[data-message-item]')];
  const museText = (node, prefix) => (node.innerText || node.textContent || '').trim().replace(prefix, '').trim();
  const museLastUser = () => museItems().filter(node => node.getAttribute('data-message-role') === 'user').at(-1) || null;
  const museReplyItems = () => {
    const items = museItems();
    const last = museLastUser();
    const after = last ? items.slice(items.indexOf(last) + 1) : items;
    return after.filter(node => node.getAttribute('data-message-role') === 'assistant');
  };
  const museGenerating = () => [...document.querySelectorAll('button[aria-label="Stop"]')]
    .some(button => button.getBoundingClientRect().width > 0);
`;
// Signed out: the landing page's own sign-in form, never conversation text.
const LOGIN_DETECT_JS = `(() => {
  const visible = node => { const r = node.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  if (document.querySelector(${JSON.stringify(PROMPT_SELECTOR)})) return false;
  if ([...document.querySelectorAll('input[placeholder="Mobile number or email"], input[aria-label="Mobile number or email"]')].some(visible)) return true;
  return [...document.querySelectorAll('h1, h2, [role="heading"]')]
    .some(node => visible(node) && /^log in or create an account$/i.test((node.innerText || '').trim()));
})()`;
const CHALLENGE_DETECT_JS = `(() => {
  if (document.querySelector('iframe[src*="challenges.cloudflare.com"], iframe[src*="arkoselabs"], iframe[src*="recaptcha"], iframe[src*="hcaptcha"]')) return true;
  const phrases = /(confirm (that )?you('| a)re (a )?human|verify you are (a )?human|security check|checking your browser)/i;
  return !document.querySelector(${JSON.stringify(PROMPT_SELECTOR)}) && phrases.test((document.body?.innerText || '').slice(0, 12000));
})()`;

// Muse's page (muse.ai) for the shared web-chat worker. The reply wait, the
// tool protocol parser and the bounded page calls come from the ChatGPT
// adapter; only reading and driving the page differ.
class MuseAutomationAdapter extends ChatGPTAutomationAdapter {
  get siteName() { return 'Muse'; }

  // Muse sizes its chat column from code that runs when a frame is drawn, and
  // the worker's background view draws none: the message box stays 0 px wide
  // and the Send button never appears. A 1x1 DevTools capture draws a frame.
  async drawFrame() {
    // A view the user is looking at draws its own frames; capturing it every
    // few seconds is wasted work and could make the page flicker.
    if (this.pageOptions?.isVisible?.()) return;
    const api = this.webContents?.debugger;
    if (!api || this.webContents.isDestroyed?.()) return;
    try {
      if (!api.isAttached()) api.attach('1.3');
      // Best effort with its own short limit: a slow capture is not a hung page.
      let timer;
      await Promise.race([
        api.sendCommand('Page.captureScreenshot', {
          format: 'png', fromSurface: true, clip: { x: 0, y: 0, width: 1, height: 1, scale: 1 }
        }),
        new Promise(resolve => { timer = setTimeout(resolve, 3000); })
      ]).finally(() => clearTimeout(timer));
    } catch {}
  }

  async evaluate(source) {
    await this.drawFrame();
    return super.evaluate(source);
  }

  async probe() {
    return this.evaluate(`(() => {
      const prompt = document.querySelector(${JSON.stringify(PROMPT_SELECTOR)});
      return { promptFound: !!prompt, challenged: (${CHALLENGE_DETECT_JS} || Boolean(${SHARED_CHALLENGE_JS})), loginVisible: ${LOGIN_DETECT_JS},
        url: location.href, title: document.title };
    })()`);
  }

  // A new side chat, never the user's main Muse chat (it has its own memory).
  async newChat() {
    await this.pageCall(() => this.webContents.loadURL(NEW_THREAD_URL), 'navigation');
    return { ok: true };
  }

  async getCurrentConversation() {
    const url = this.webContents.getURL();
    const match = url.match(/\/thread\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
    return { url, conversationId: match ? match[1] : null, title: this.webContents.getTitle() };
  }

  async lastUserMessage() {
    return this.evaluate(`(() => {${MESSAGES_JS}
      const last = museLastUser();
      return last ? museText(last, /^You:\\s*/i) : '';
    })()`);
  }

  async sendTask(text) {
    // A text box keeps line breaks as \n: a task written on Windows (\r\n)
    // never read back equal and the job failed with the prompt left unsent.
    const value = String(text || '').replace(/\r\n?/g, '\n');
    const payload = JSON.stringify(value);
    // Fill the box the way React reads it (its onChange takes the native
    // value setter plus an input event). Right after a new side chat opens
    // the page re-renders the box, so keep filling until the value stays.
    // Electron's insertText is not used: in the hidden worker view it never
    // returned, which looked like a hung page.
    const fill = `(() => {
      const prompt = document.querySelector(${JSON.stringify(PROMPT_SELECTOR)});
      if (!prompt) return { ok: false, reason: 'prompt-not-found' };
      if (prompt.value !== ${payload}) {
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
        setter.call(prompt, ${payload});
        prompt.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${payload} }));
      }
      return { ok: prompt.value === ${payload} };
    })()`;
    let filled = null;
    for (let attempt = 0, steady = 0; attempt < 12 && steady < 2; attempt += 1) {
      if (attempt) await new Promise(resolve => setTimeout(resolve, 400));
      filled = await this.evaluate(fill);
      steady = filled?.ok ? steady + 1 : 0;
    }
    // A box that will not take the text, or a message that will not go, is a
    // page problem: the job loop reloads the chat, checks whether the message
    // arrived, and sends it again only if it did not.
    if (!filled?.ok) throw teamyraError('Could not populate the Muse message box', 'TEAMYRA_PAGE_UNRESPONSIVE', 'page_unresponsive');
    // The Send button animates in about 1.5 s after the box gets text, and a
    // hidden view pauses that animation, so the button may never look
    // visible. Click it as soon as it exists; otherwise press Enter in the box
    // (the page submits on Enter). Sent means the box emptied.
    const submit = `(() => {
      const prompt = document.querySelector(${JSON.stringify(PROMPT_SELECTOR)});
      if (!prompt) return 'gone';
      if (!prompt.value.trim()) return 'sent';
      const send = [...document.querySelectorAll('button[aria-label="Send"]')].find(button => !button.disabled);
      if (send) { send.click(); return 'clicked'; }
      return 'waiting';
    })()`;
    const pressEnter = `(() => {
      const prompt = document.querySelector(${JSON.stringify(PROMPT_SELECTOR)});
      if (!prompt || !prompt.value.trim()) return false;
      prompt.focus();
      for (const type of ['keydown', 'keypress', 'keyup']) {
        prompt.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
      }
      return true;
    })()`;
    let method = null;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const state = await this.evaluate(submit);
      if (state === 'sent') return { ok: true, method: method || 'button' };
      if (state === 'gone') throw teamyraError('Muse message box disappeared', 'TEAMYRA_PAGE_UNRESPONSIVE', 'page_unresponsive');
      let pause = 100;
      if (state === 'clicked') {
        method ||= 'button';
        // Give the page time to take the message before looking again, so
        // a slow clear is never answered with a second click.
        pause = 1500;
      } else if ((attempt === 20 || attempt === 30) && await this.evaluate(pressEnter)) {
        // No button after 2 s, or a click that did not send: try Enter.
        method = 'keyboard';
        pause = 1500;
      }
      await new Promise(resolve => setTimeout(resolve, pause));
    }
    throw teamyraError('Muse did not take the message (send-button-unavailable)', 'TEAMYRA_PAGE_UNRESPONSIVE', 'page_unresponsive');
  }

  async stopGeneration() {
    return this.evaluate(`(() => {
      const stop = [...document.querySelectorAll('button[aria-label="Stop"]')].find(button => button.getBoundingClientRect().width > 0);
      if (!stop) return { ok: false, reason: 'stop-button-not-found' };
      stop.click();
      return { ok: true };
    })()`);
  }

  async assistantSnapshot() {
    return this.evaluate(`(() => {${MESSAGES_JS}
      const reply = museReplyItems();
      const text = reply.map(node => museText(node, /^Muse:\\s*/i)).filter(Boolean).join('\\n\\n');
      const lastUser = museLastUser();
      const userId = lastUser ? (lastUser.getAttribute('data-message-id') || String(museItems().indexOf(lastUser))) : 'none';
      const newest = museItems().at(-1);
      return {
        count: museItems().filter(node => node.getAttribute('data-message-role') === 'assistant').length,
        text,
        messageId: reply.length ? userId + ':' + reply.length : '',
        generating: museGenerating(),
        challenged: (${CHALLENGE_DETECT_JS} || Boolean(${SHARED_CHALLENGE_JS})),
        images: 0,
        activity: museItems().length + ':' + (newest ? newest.innerHTML.length : 0)
      };
    })()`);
  }

  // ChatGPT's conversation data is not available on muse.ai.
  async rawReplyText() {
    return '';
  }

  // The thread URL appears as soon as the first message is sent, so there is
  // no sidebar to search for a conversation whose URL was never seen.
  async latestConversationUrl() {
    return '';
  }
}

module.exports = { MuseAutomationAdapter, MUSE_HOME, NEW_THREAD_URL, PROMPT_SELECTOR };
