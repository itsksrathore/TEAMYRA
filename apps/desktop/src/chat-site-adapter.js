const { ChatGPTAutomationAdapter, teamyraError } = require('./chatgpt-automation-adapter');
const { MuseAutomationAdapter } = require('./muse-automation-adapter');

// A page driver described by settings instead of code, for web-chat sites
// whose page is "a message box, a send button, a stop button while writing,
// and a list of messages" (Qwen, GLM, Grok). The reply wait, the tool
// protocol parser and the bounded page calls come from the ChatGPT adapter.
//
// A site gives (selectors are CSS; *Js values are page-script expressions):
// - name, home, newChatUrl, conversationPattern (RegExp, group 1 = id)
// - prompt: selector; editor: 'textarea' (default) or 'rich' (contenteditable)
// - send: selector of an enabled Send button; stop: selector of a visible Stop
//   button (present while the site writes)
// - user / reply: selectors of user and reply messages; answer: the answer
//   inside a reply (thinking excluded); replyId: page expression giving a
//   reply node's id (`node` in scope)
// - loginJs, challengeJs: page expressions, true when signed out / checked
// - settingsJs: page script that switches on the best model and settings and
//   returns what it set; run before every message
// - rawReplyJs(idJson): page script returning the reply exactly as written
//   ('' while unfinished or unreadable)
// - busyPattern: a reply that is not an answer ("server busy"), asked again
// Human checks most sites use: Alibaba Cloud's slider (Qwen, z.ai), its older
// "nc" slider, Cloudflare, hCaptcha, reCAPTCHA, GeeTest, and a dialog that
// asks to drag a slider or verify. Text is read only inside dialogs and
// overlays, so a chat that talks about captchas does not count.
const COMMON_CHALLENGE_JS = `(() => {
  const shown = node => { const r = node.getBoundingClientRect(); const s = getComputedStyle(node);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const widgets = '[id^="aliyunCaptcha-window"], [id^="aliyunCaptcha-mask"], .aliyun-captcha, #nc_1_wrapper, .nc-container, ' +
    '.geetest_panel, .geetest_box, iframe[src*="captcha"], iframe[src*="challenges.cloudflare.com"], iframe[src*="hcaptcha"], ' +
    'iframe[src*="recaptcha"], iframe[src*="geetest"]';
  if ([...document.querySelectorAll(widgets)].some(shown)) return true;
  const overlays = [...document.querySelectorAll('[role=dialog], [role=alertdialog], [class*="modal" i], [class*="mask" i], [class*="captcha" i]')].filter(shown);
  return overlays.some(node => /(drag the slider|slide to verify|complete the (security )?verification|verify you are (a )?human|security check|\u5b89\u5168\u9a8c\u8bc1|\u62d6\u52a8\u6ed1\u5757|\u8bf7\u5b8c\u6210\u9a8c\u8bc1)/i
    .test((node.innerText || '').slice(0, 2000)));
})()`;

class ChatSiteAdapter extends ChatGPTAutomationAdapter {
  constructor(webContents, options = {}, site = {}) {
    super(webContents, options);
    this.chatSite = site;
  }

  get siteName() { return this.chatSite.name || 'Chat'; }

  // Background views draw no frames; see the Muse adapter.
  async drawFrame() {
    if (Date.now() - (this.lastFrameAt || 0) < 400) return;
    this.lastFrameAt = Date.now();
    return MuseAutomationAdapter.prototype.drawFrame.call(this);
  }

  async evaluate(source) {
    await this.drawFrame();
    return super.evaluate(source);
  }

  pageHelpers() {
    const site = this.chatSite;
    return `
      const csVisible = node => { const r = node.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const csPrompt = () => document.querySelector(${JSON.stringify(site.prompt)});
      const csPromptText = () => { const p = csPrompt(); return p ? (('value' in p) ? p.value : (p.innerText || '')) : ''; };
      const csReplies = () => [...document.querySelectorAll(${JSON.stringify(site.reply)})];
      const csUsers = () => [...document.querySelectorAll(${JSON.stringify(site.user)})];
      const csAnswer = node => [...node.querySelectorAll(${JSON.stringify(site.answer)})]
        .map(part => (part.innerText || part.textContent || '').trim()).filter(Boolean).join('\\n\\n');
      const csReplyId = node => { try { return String(${site.replyId || "''"} || ''); } catch (error) { return ''; } };
      const csGenerating = () => [...document.querySelectorAll(${JSON.stringify(site.stop)})].some(csVisible);
      const csContinueButton = () => [...document.querySelectorAll('button, [role=button]')]
        .find(node => csVisible(node) && /^(continue|continue generating)$/i.test((node.innerText || '').trim()));
    `;
  }

  async probe() {
    const site = this.chatSite;
    return this.evaluate(`(() => {
      const prompt = document.querySelector(${JSON.stringify(site.prompt)});
      let challenged = false; let loginVisible = false;
      try { challenged = Boolean(${site.challengeJs || 'false'}) || Boolean(${COMMON_CHALLENGE_JS}); } catch {}
      try { loginVisible = !prompt && !challenged && Boolean(${site.loginJs || 'false'}); } catch {}
      return { promptFound: !!prompt, challenged, loginVisible, url: location.href, title: document.title };
    })()`);
  }

  async newChat() {
    await this.pageCall(() => this.webContents.loadURL(this.chatSite.newChatUrl || this.chatSite.home), 'navigation');
    return { ok: true };
  }

  async getCurrentConversation() {
    const url = this.webContents.getURL();
    const match = url.match(this.chatSite.conversationPattern);
    return { url, conversationId: match ? match[1] : null, title: this.webContents.getTitle() };
  }

  async lastUserMessage() {
    // `userPrefix`: a label the site shows before your message ("You").
    const prefix = JSON.stringify(this.chatSite.userPrefix || '');
    return this.evaluate(`(() => {${this.pageHelpers()}
      const last = csUsers().at(-1);
      const text = last ? (last.innerText || last.textContent || '').trim() : '';
      const prefix = ${prefix};
      return prefix && text.startsWith(prefix) ? text.slice(prefix.length).trim() : text;
    })()`);
  }

  // A real mouse click at page coordinates, for menus that ignore scripted
  // clicks (Grok's model menu).
  async trustedClick(x, y) {
    const contents = this.webContents;
    if (!contents || contents.isDestroyed?.()) throw new Error(`${this.siteName} view is unavailable`);
    const point = { x: Math.round(x), y: Math.round(y) };
    contents.sendInputEvent({ type: 'mouseMove', ...point });
    contents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 });
    contents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 });
  }

  async ensureSettings() {
    if (!this.chatSite.settingsJs) return null;
    return this.evaluate(this.chatSite.settingsJs);
  }

  async sendTask(text) {
    const site = this.chatSite;
    const value = String(text || '').replace(/\r\n?/g, '\n');
    const payload = JSON.stringify(value);
    // Menus open and close between steps, so settings get two passes.
    let settings = await this.ensureSettings().catch(() => null);
    if (settings && Object.values(settings).some(state => state !== 'on')) {
      await new Promise(resolve => setTimeout(resolve, 500));
      settings = await this.ensureSettings().catch(() => settings);
    }
    this.lastSettings = settings;
    const fill = site.editor === 'rich' ? `(() => {
      const prompt = document.querySelector(${JSON.stringify(site.prompt)});
      if (!prompt) return { ok: false, reason: 'prompt-not-found' };
      const current = (prompt.innerText || '').replace(/\\n$/, '');
      if (current !== ${payload}) {
        prompt.focus();
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(prompt);
        selection.removeAllRanges();
        selection.addRange(range);
        if (!document.execCommand('insertText', false, ${payload})) {
          prompt.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: ${payload} }));
        }
      }
      const after = (prompt.innerText || '').replace(/\\n+$/, '').replace(/\\n\\n/g, '\\n');
      return { ok: after === ${payload}.replace(/\\n\\n/g, '\\n') || (prompt.innerText || '').replace(/\\s+/g, '') === ${payload}.replace(/\\s+/g, '') };
    })()` : `(() => {
      const prompt = document.querySelector(${JSON.stringify(site.prompt)});
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
    if (!filled?.ok) {
      throw teamyraError(`Could not fill the ${this.siteName} message box`, 'TEAMYRA_PAGE_UNRESPONSIVE', 'page_unresponsive');
    }
    const submit = `(() => {${this.pageHelpers()}
      if (!csPrompt()) return 'gone';
      if (!csPromptText().trim()) return 'sent';
      const send = [...document.querySelectorAll(${JSON.stringify(site.send)})].find(node => !node.disabled && node.getAttribute('aria-disabled') !== 'true');
      if (send) { send.click(); return 'clicked'; }
      return 'waiting';
    })()`;
    const pressEnter = `(() => {${this.pageHelpers()}
      const prompt = csPrompt();
      if (!prompt || !csPromptText().trim()) return false;
      prompt.focus();
      for (const type of ['keydown', 'keypress', 'keyup']) {
        prompt.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
      }
      return true;
    })()`;
    let method = null;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const state = await this.evaluate(submit);
      if (state === 'sent') return { ok: true, method: method || 'button', settings };
      if (state === 'gone') throw teamyraError(`${this.siteName} message box disappeared`, 'TEAMYRA_PAGE_UNRESPONSIVE', 'page_unresponsive');
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
    throw teamyraError(`${this.siteName} did not take the message (send-button-unavailable)`, 'TEAMYRA_PAGE_UNRESPONSIVE', 'page_unresponsive');
  }

  async stopGeneration() {
    return this.evaluate(`(() => {${this.pageHelpers()}
      const stop = [...document.querySelectorAll(${JSON.stringify(this.chatSite.stop)})].find(csVisible);
      if (!stop) return { ok: false, reason: 'stop-button-not-found' };
      (stop.closest('button, [role=button]') || stop).click();
      return { ok: true };
    })()`);
  }

  // A Continue button (a reply cut at the site's length limit) is clicked,
  // up to 30 times per reply, and the reply counts as still being written.
  async assistantSnapshot() {
    const site = this.chatSite;
    return this.evaluate(`(() => {${this.pageHelpers()}
      const replies = csReplies();
      const last = replies.at(-1) || null;
      const id = last ? (csReplyId(last) || String(replies.length)) : '';
      let generating = csGenerating();
      if (!generating && last) {
        const button = csContinueButton();
        window.__teamyraContinues = window.__teamyraContinues || {};
        if (button && (window.__teamyraContinues[id] || 0) < 30) {
          window.__teamyraContinues[id] = (window.__teamyraContinues[id] || 0) + 1;
          button.click();
          generating = true;
        }
      }
      let challenged = false;
      try { challenged = Boolean(${site.challengeJs || 'false'}) || Boolean(${COMMON_CHALLENGE_JS}); } catch {}
      return {
        count: replies.length,
        text: last ? csAnswer(last) : '',
        messageId: id,
        generating,
        challenged,
        images: 0,
        activity: replies.length + ':' + (last ? last.innerHTML.length : 0)
      };
    })()`);
  }

  async rawReplyText(messageId = '') {
    if (!this.chatSite.rawReplyJs || !messageId) return '';
    const text = await this.evaluate(this.chatSite.rawReplyJs(JSON.stringify(String(messageId))));
    return typeof text === 'string' ? text : '';
  }

  isTransientReply(text) {
    return Boolean(this.chatSite.busyPattern && this.chatSite.busyPattern.test(String(text || '').trim()));
  }

  async latestConversationUrl() {
    return '';
  }
}

module.exports = { ChatSiteAdapter, COMMON_CHALLENGE_JS };
