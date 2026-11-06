const { ChatGPTAutomationAdapter } = require('./chatgpt-automation-adapter');

const MUSE_HOME = 'https://muse.ai/';
const NEW_THREAD_URL = 'https://muse.ai/thread/new';
const PROMPT_SELECTOR = 'textarea[aria-label="Message"]';
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

  async probe() {
    return this.evaluate(`(() => {
      const prompt = document.querySelector(${JSON.stringify(PROMPT_SELECTOR)});
      return { promptFound: !!prompt, challenged: ${CHALLENGE_DETECT_JS}, loginVisible: ${LOGIN_DETECT_JS},
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
    const payload = JSON.stringify(String(text || ''));
    const filled = await this.evaluate(`(() => {
      const prompt = document.querySelector(${JSON.stringify(PROMPT_SELECTOR)});
      if (!prompt) return { ok: false, reason: 'prompt-not-found' };
      prompt.focus();
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(prompt, ${payload});
      prompt.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${payload} }));
      return { ok: prompt.value.length > 0 };
    })()`);
    if (!filled?.ok) throw new Error(filled?.reason || 'Could not populate the Muse message box');
    // The Send button appears once the box has text.
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const clicked = await this.evaluate(`(() => {
        const send = [...document.querySelectorAll('button[aria-label="Send"]')]
          .find(button => !button.disabled && button.getBoundingClientRect().width > 0);
        if (!send) return false;
        send.click();
        return true;
      })()`);
      if (clicked) return { ok: true, method: 'button' };
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('send-button-unavailable');
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
        challenged: ${CHALLENGE_DETECT_JS},
        images: 0,
        activity: museItems().length + ':' + (newest ? newest.innerHTML.length : 0)
      };
    })()`);
  }

  // The thread URL appears as soon as the first message is sent, so there is
  // no sidebar to search for a conversation whose URL was never seen.
  async latestConversationUrl() {
    return '';
  }
}

module.exports = { MuseAutomationAdapter, MUSE_HOME, NEW_THREAD_URL, PROMPT_SELECTOR };
