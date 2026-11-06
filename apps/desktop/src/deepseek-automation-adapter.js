const { ChatGPTAutomationAdapter, teamyraError } = require('./chatgpt-automation-adapter');
const { MuseAutomationAdapter } = require('./muse-automation-adapter');

// DeepSeek's page (chat.deepseek.com, checked 2026-11-06) for the shared
// web-chat worker. The reply wait, the tool protocol parser and the bounded
// page calls come from the ChatGPT adapter.
//
// Page structure:
// - composer: textarea "Message DeepSeek"; the round primary button sends,
//   shows a Stop icon (and is enabled with an empty box) while DeepSeek
//   writes, and is disabled again when it is done;
// - modes: `.ds-toggle-button` "DeepThink" and "Search" with aria-pressed;
//   both are kept on for every message;
// - messages: virtual-list items `[data-virtual-list-item-key]`. A reply's
//   key is its message id (2, 4, ...); the user message before it has the
//   negative key. The answer is `.ds-assistant-message-main-content`; the
//   thinking is `.ds-think-content` and is never part of the reply;
// - conversation: /a/chat/s/<uuid>; its exact text and status (WIP,
//   FINISHED, incomplete_message) come from /api/v0/chat/history_messages.
const DEEPSEEK_HOME = 'https://chat.deepseek.com/';
const PROMPT_SELECTOR = 'textarea[placeholder*="DeepSeek"], textarea#chat-input';
const SEND_SELECTOR = '.ds-button--primary.ds-button--filled.ds-button--circle';
// Mode labels in English and Chinese.
const MODE_LABELS = { think: ['DeepThink', '深度思考'], search: ['Search', 'Smart Search', '联网搜索', '智能搜索'] };
const DEEPSEEK_BUSY_PREFIX = 'TEAMYRA_SITE_BUSY: ';
const BUSY_REPLY = /^(the server is busy\.? please try again later\.?|服务器繁忙，请稍后再试。?)$/i;

const PAGE_JS = `
  const dsPrompt = () => document.querySelector(${JSON.stringify(PROMPT_SELECTOR)});
  const dsSend = () => document.querySelector(${JSON.stringify(SEND_SELECTOR)});
  const dsVisible = node => { const r = node.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const dsItems = () => {
    const items = [...document.querySelectorAll('[data-virtual-list-item-key]')];
    return items.length ? items : [...document.querySelectorAll('.ds-message')];
  };
  const dsIsReply = node => !!node.querySelector('.ds-assistant-message-main-content, .ds-think-content') ||
    node.classList?.contains('ds-assistant-message-main-content');
  const dsReplies = () => dsItems().filter(dsIsReply);
  const dsUserItems = () => dsItems().filter(node => !dsIsReply(node));
  const dsReplyText = node => [...node.querySelectorAll('.ds-assistant-message-main-content')]
    .map(part => (part.innerText || part.textContent || '').trim()).filter(Boolean).join('\\n\\n');
  // Writing: the round button shows the Stop icon (a rounded square, path
  // "M2 4.88..."; Send is an arrow, "M8.31..."). An enabled button with an
  // empty box alone also stayed true after a reply broke off (INCOMPLETE),
  // so the job waited for ever.
  const dsGenerating = () => {
    const send = dsSend();
    const box = dsPrompt();
    if (!send || String(send.className).includes('ds-button--disabled') || (box && box.value.trim())) return false;
    const icon = (send.querySelector('svg path') || { getAttribute: () => '' }).getAttribute('d') || '';
    return icon ? icon.startsWith('M2 4.88') : true;
  };
  const dsContinueButton = () => [...document.querySelectorAll('.ds-button, button, [role=button]')]
    .find(node => dsVisible(node) && /^(continue|continue generating|继续|继续生成)$/i.test((node.innerText || '').trim()));
`;
const LOGIN_DETECT_JS = `(() => {
  if (/\\/sign_in|\\/login/.test(location.pathname)) return true;
  if (document.querySelector(${JSON.stringify(PROMPT_SELECTOR)})) return false;
  return !!document.querySelector('input[type="password"]');
})()`;
const CHALLENGE_DETECT_JS = `(() => {
  if (document.querySelector('#captcha-container, iframe[src*="awswaf"], iframe[src*="captcha"], iframe[src*="challenges.cloudflare.com"]')) return true;
  return !document.querySelector(${JSON.stringify(PROMPT_SELECTOR)}) &&
    /(verify you are human|human verification|security check|请完成安全验证)/i.test((document.body?.innerText || '').slice(0, 8000));
})()`;

class DeepSeekAutomationAdapter extends ChatGPTAutomationAdapter {
  get siteName() { return 'DeepSeek'; }

  // A background view draws no frames, and pages that lay out on animation
  // frames (the message list) then stall; see the Muse adapter.
  async drawFrame() {
    if (Date.now() - (this.lastFrameAt || 0) < 400) return;
    this.lastFrameAt = Date.now();
    return MuseAutomationAdapter.prototype.drawFrame.call(this);
  }

  async evaluate(source) {
    await this.drawFrame();
    return super.evaluate(source);
  }

  async probe() {
    return this.evaluate(`(() => {
      const prompt = document.querySelector(${JSON.stringify(PROMPT_SELECTOR)});
      return { promptFound: !!prompt, challenged: ${CHALLENGE_DETECT_JS}, loginVisible: ${LOGIN_DETECT_JS},
        url: location.href, title: document.title };
    })()`);
  }

  async newChat() {
    await this.pageCall(() => this.webContents.loadURL(DEEPSEEK_HOME), 'navigation');
    return { ok: true };
  }

  async getCurrentConversation() {
    const url = this.webContents.getURL();
    const match = url.match(/\/a\/chat\/s\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
    return { url, conversationId: match ? match[1] : null, title: this.webContents.getTitle() };
  }

  async lastUserMessage() {
    return this.evaluate(`(() => {${PAGE_JS}
      const last = dsUserItems().at(-1);
      return last ? (last.innerText || last.textContent || '').trim() : '';
    })()`);
  }

  // DeepThink and Search stay on; they apply to each message sent.
  async ensureModes() {
    return this.evaluate(`(() => {
      const labels = ${JSON.stringify(MODE_LABELS)};
      const toggles = [...document.querySelectorAll('.ds-toggle-button')];
      const state = {};
      for (const [mode, names] of Object.entries(labels)) {
        const toggle = toggles.find(node => names.includes((node.innerText || '').trim()));
        if (!toggle) { state[mode] = 'missing'; continue; }
        if (toggle.getAttribute('aria-pressed') !== 'true') toggle.click();
        state[mode] = 'on';
      }
      return state;
    })()`);
  }

  async sendTask(text) {
    // A text box keeps line breaks as \n (see the Muse adapter).
    const value = String(text || '').replace(/\r\n?/g, '\n');
    const payload = JSON.stringify(value);
    await this.ensureModes().catch(() => null);
    await new Promise(resolve => setTimeout(resolve, 250));
    const modes = await this.ensureModes().catch(() => null);
    this.lastModes = modes;
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
    if (!filled?.ok) throw teamyraError('Could not fill the DeepSeek message box', 'TEAMYRA_PAGE_UNRESPONSIVE', 'page_unresponsive');
    // Sent means the box emptied.
    const submit = `(() => {${PAGE_JS}
      const prompt = dsPrompt();
      if (!prompt) return 'gone';
      if (!prompt.value.trim()) return 'sent';
      const send = dsSend();
      if (send && !String(send.className).includes('ds-button--disabled')) { send.click(); return 'clicked'; }
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
      if (state === 'sent') return { ok: true, method: method || 'button', modes };
      if (state === 'gone') throw teamyraError('DeepSeek message box disappeared', 'TEAMYRA_PAGE_UNRESPONSIVE', 'page_unresponsive');
      let pause = 100;
      if (state === 'clicked') {
        method ||= 'button';
        pause = 1500;
      } else if ((attempt === 20 || attempt === 30) && await this.evaluate(pressEnter)) {
        method = 'keyboard';
        pause = 1500;
      }
      await new Promise(resolve => setTimeout(resolve, pause));
    }
    throw teamyraError('DeepSeek did not take the message (send-button-unavailable)', 'TEAMYRA_PAGE_UNRESPONSIVE', 'page_unresponsive');
  }

  async stopGeneration() {
    return this.evaluate(`(() => {${PAGE_JS}
      if (!dsGenerating()) return { ok: false, reason: 'not-generating' };
      dsSend().click();
      return { ok: true };
    })()`);
  }

  // A long answer can stop at DeepSeek's length limit with a "Continue"
  // button. The button is clicked here (up to 30 times per reply), and the
  // reply counts as still being written, so the wait goes on.
  // The page can look as if DeepSeek were still writing, or show a finished
  // empty reply, when the reply broke off (status INCOMPLETE; seen on
  // 2026-11-06 with only thinking text and no answer). Once a reply has
  // ended, or the page has shown no progress for 30 s, its status is read
  // from DeepSeek's data; an INCOMPLETE reply becomes a busy reply, which the
  // job loop asks again.
  async assistantSnapshot() {
    const snap = await this.pageSnapshot();
    if (!snap || !snap.messageId) return snap;
    const now = Date.now();
    if (snap.activity !== this.lastActivity) {
      this.lastActivity = snap.activity;
      this.activitySince = now;
    }
    const stalled = snap.generating && now - (this.activitySince || now) >= (this.stallCheckMs ?? 30000);
    if (snap.generating && !stalled) return snap;
    const cached = this.statusCache?.messageId === snap.messageId ? this.statusCache : null;
    let status = cached?.status;
    if (!status && now - (this.lastStatusCheckAt || 0) >= (this.statusCheckEveryMs ?? 5000)) {
      this.lastStatusCheckAt = now;
      status = await this.messageStatus(snap.messageId).catch(() => null);
      if (status && status !== 'WIP') this.statusCache = { messageId: snap.messageId, status };
    }
    if (status === 'INCOMPLETE') {
      return { ...snap, generating: false, text: DEEPSEEK_BUSY_PREFIX + 'DeepSeek stopped before finishing its reply' };
    }
    if (status === 'FINISHED' && stalled) return { ...snap, generating: false };
    return snap;
  }

  async messageStatus(messageId) {
    const wanted = Number(messageId);
    if (!Number.isFinite(wanted) || wanted <= 0) return null;
    const status = await this.evaluate(`(async () => {
      try {
        const match = location.pathname.match(new RegExp('/a/chat/s/([0-9a-f-]{36})', 'i'));
        if (!match) return null;
        const stored = localStorage.getItem('userToken');
        let token = '';
        try { token = JSON.parse(stored).value || ''; } catch { token = stored || ''; }
        const response = await fetch('/api/v0/chat/history_messages?chat_session_id=' + match[1], {
          credentials: 'include', headers: token ? { Authorization: 'Bearer ' + token } : {}
        });
        if (!response.ok) return null;
        const messages = ((((await response.json()) || {}).data || {}).biz_data || {}).chat_messages || [];
        const message = messages.find(item => item.message_id === ${wanted} && item.role === 'ASSISTANT');
        return message ? String(message.status || '') : null;
      } catch (error) { return null; }
    })()`);
    return typeof status === 'string' && status ? status : null;
  }

  async pageSnapshot() {
    return this.evaluate(`(() => {${PAGE_JS}
      const replies = dsReplies();
      const last = replies.at(-1) || null;
      const key = last ? (last.getAttribute('data-virtual-list-item-key') || String(replies.length)) : '';
      let generating = dsGenerating();
      let continued = false;
      if (!generating && last) {
        const button = dsContinueButton();
        window.__teamyraContinues = window.__teamyraContinues || {};
        if (button && (window.__teamyraContinues[key] || 0) < 30) {
          window.__teamyraContinues[key] = (window.__teamyraContinues[key] || 0) + 1;
          button.click();
          generating = true;
          continued = true;
        }
      }
      const items = dsItems();
      return {
        count: replies.length,
        text: last ? dsReplyText(last) : '',
        messageId: key,
        generating,
        continued,
        challenged: ${CHALLENGE_DETECT_JS},
        images: 0,
        // Thinking text counts as progress before the answer starts.
        activity: items.length + ':' + (last ? last.innerHTML.length : 0)
      };
    })()`);
  }

  // The reply exactly as DeepSeek wrote it (the page shows rendered
  // Markdown), by message id. '' while it is still being written or when it
  // cannot be read.
  async rawReplyText(messageId = '') {
    const wanted = Number(messageId);
    if (!Number.isFinite(wanted) || wanted <= 0) return '';
    const text = await this.evaluate(`(async () => {
      try {
        const match = location.pathname.match(new RegExp('/a/chat/s/([0-9a-f-]{36})', 'i'));
        if (!match) return '';
        const stored = localStorage.getItem('userToken');
        let token = '';
        try { token = JSON.parse(stored).value || ''; } catch { token = stored || ''; }
        const response = await fetch('/api/v0/chat/history_messages?chat_session_id=' + match[1], {
          credentials: 'include', headers: token ? { Authorization: 'Bearer ' + token } : {}
        });
        if (!response.ok) return '';
        const data = await response.json();
        const messages = (((data || {}).data || {}).biz_data || {}).chat_messages || [];
        const message = messages.find(item => item.message_id === ${wanted} && item.role === 'ASSISTANT');
        if (!message || message.status !== 'FINISHED') return '';
        // Search adds citation markers ([reference:0]); they are not part of
        // a tool request or of file contents.
        return (message.fragments || []).filter(part => part.type === 'RESPONSE')
          .map(part => String(part.content || '')).join('').replace(/\\[reference:\\d+\\]/g, '');
      } catch (error) { return ''; }
    })()`);
    return typeof text === 'string' ? text : '';
  }

  // "The server is busy", or a reply that broke off, is not an answer: the
  // message is asked again.
  isTransientReply(text) {
    const value = String(text || '').trim();
    return BUSY_REPLY.test(value) || value.startsWith(DEEPSEEK_BUSY_PREFIX);
  }

  async latestConversationUrl() {
    return this.evaluate(`(() => {
      const link = document.querySelector('a[href*="/a/chat/s/"]');
      return link ? new URL(link.getAttribute('href'), location.href).href : '';
    })()`);
  }
}

module.exports = { DeepSeekAutomationAdapter, DEEPSEEK_HOME, PROMPT_SELECTOR, SEND_SELECTOR, BUSY_REPLY, DEEPSEEK_BUSY_PREFIX };
