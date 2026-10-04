const TOOL_REQUEST_PREFIX = 'TEAMYRA_TOOL_REQUEST ';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

class ChatGPTAutomationAdapter {
  constructor(webContents) {
    this.webContents = webContents;
  }

  async evaluate(source) {
    if (!this.webContents || this.webContents.isDestroyed()) throw new Error('ChatGPT view is unavailable');
    return this.webContents.executeJavaScript(source, true);
  }

  async probe() {
    return this.evaluate(`(() => {
      const prompt = document.querySelector(
        '#prompt-textarea, textarea[data-testid*="prompt"], [contenteditable="true"][data-testid*="prompt"], [contenteditable="true"].ProseMirror, main form [contenteditable="true"], main [contenteditable="true"]'
      );
      const bodyText = (document.body?.innerText || '').slice(0, 12000).toLowerCase();
      const challenged = bodyText.includes('verify you are human') || bodyText.includes('checking your browser');
      const loginVisible = !!document.querySelector('a[href*="auth"], button[data-testid*="login"]') || /log in|sign up/.test(bodyText.slice(0, 3000));
      return { promptFound: !!prompt, challenged, loginVisible, url: location.href, title: document.title };
    })()`);
  }

  async newChat() {
    await this.webContents.loadURL('https://chatgpt.com/');
    return { ok: true };
  }

  async getCurrentConversation() {
    const url = this.webContents.getURL();
    const match = url.match(/\/c\/([A-Za-z0-9_-]+)/);
    return { url, conversationId: match ? match[1] : null, title: this.webContents.getTitle() };
  }

  async sendTask(text) {
    const payload = JSON.stringify(String(text || ''));
    const initial = await this.evaluate(`(() => {
      const value = ${payload};
      const assistantCount = document.querySelectorAll('[data-message-author-role="assistant"]').length;
      const prompt = document.querySelector(
        '#prompt-textarea, textarea[data-testid*="prompt"], [contenteditable="true"][data-testid*="prompt"], [contenteditable="true"].ProseMirror, main form [contenteditable="true"], main [contenteditable="true"]'
      );
      if (!prompt) return { ok:false, reason:'prompt-not-found', assistantCount };
      prompt.focus();
      if (prompt instanceof HTMLTextAreaElement || prompt instanceof HTMLInputElement) {
        const proto = prompt instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (setter) setter.call(prompt, value); else prompt.value = value;
        prompt.dispatchEvent(new InputEvent('input', { bubbles:true, inputType:'insertText', data:value }));
        prompt.dispatchEvent(new Event('change', { bubbles:true }));
      } else {
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(prompt);
        selection.removeAllRanges();
        selection.addRange(range);
        let inserted = false;
        try { inserted = document.execCommand('insertText', false, value); } catch {}
        if (!inserted) {
          prompt.textContent = value;
          prompt.dispatchEvent(new InputEvent('input', { bubbles:true, inputType:'insertText', data:value }));
        }
      }
      return { ok:true, assistantCount };
    })()`);
    if (!initial?.ok) throw new Error(initial?.reason || 'Could not populate ChatGPT prompt');

    const buttonScript = `(() => {
      const selectors = [
        'button[data-testid="send-button"]',
        'button[data-testid*="send"]',
        'button[aria-label="Send prompt"]',
        'button[aria-label*="Send"]',
        'button[aria-label*="send"]',
        'form button[type="submit"]'
      ];
      const buttons = selectors.flatMap(selector => [...document.querySelectorAll(selector)]);
      const send = buttons.find(button => {
        const style = getComputedStyle(button);
        const rect = button.getBoundingClientRect();
        return !button.disabled && button.getAttribute('aria-disabled') !== 'true' &&
          style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      });
      if (!send) return { ok:false };
      send.click();
      return { ok:true };
    })()`;

    for (let attempt = 0; attempt < 30; attempt += 1) {
      const clicked = await this.evaluate(buttonScript);
      if (clicked?.ok) return { ok: true, method: 'button' };
      await sleep(100);
    }

    try {
      this.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'ENTER' });
      this.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'ENTER' });
    } catch {}

    await sleep(350);
    const fallback = await this.evaluate(`(() => {
      const prompt = document.querySelector(
        '#prompt-textarea, textarea[data-testid*="prompt"], [contenteditable="true"][data-testid*="prompt"], [contenteditable="true"].ProseMirror, main form [contenteditable="true"], main [contenteditable="true"]'
      );
      const currentText = prompt
        ? (prompt instanceof HTMLTextAreaElement || prompt instanceof HTMLInputElement ? prompt.value : prompt.innerText || prompt.textContent || '')
        : '';
      const assistantCount = document.querySelectorAll('[data-message-author-role="assistant"]').length;
      const generating = !!document.querySelector(
        'button[data-testid="stop-button"], button[data-testid*="stop"], button[aria-label*="Stop generating"], button[aria-label*="Stop"], button[aria-label*="stop"]'
      );
      return {
        sent: !String(currentText || '').trim() || assistantCount > ${Number(initial.assistantCount) || 0} || generating
      };
    })()`);
    if (!fallback?.sent) throw new Error('send-button-unavailable');
    return { ok: true, method: 'keyboard' };
  }

  async stopGeneration() {
    return this.evaluate(`(() => {
      const stop = document.querySelector(
        'button[data-testid="stop-button"], button[data-testid*="stop"], button[aria-label*="Stop generating"], button[aria-label*="Stop"], button[aria-label*="stop"]'
      );
      if (!stop) return { ok:false, reason:'stop-button-not-found' };
      stop.click();
      return { ok:true };
    })()`);
  }

  async assistantSnapshot() {
    return this.evaluate(`(() => {
      let nodes = [...document.querySelectorAll('[data-markdown-text-style="assistant-message"]')];
      let messages = nodes.map(node => (node.innerText || node.textContent || '').trim()).filter(Boolean);

      if (!messages.length) {
        nodes = [...document.querySelectorAll('[data-message-author-role="assistant"]')];
        messages = nodes.map(node => (node.innerText || node.textContent || '').trim()).filter(Boolean);
      }

      if (!messages.length) {
        nodes = [...document.querySelectorAll(
          '[data-content-search-unit-key$=":assistant"], [data-chatgpt-search-unit-key$=":assistant"]'
        )];
        messages = nodes.map(node => {
          const text = (node.innerText || node.textContent || '').trim();
          return text.replace(/^ChatGPT said:\\s*/i, '').trim();
        }).filter(Boolean);
      }

      if (!messages.length) {
        nodes = [...document.querySelectorAll('main .markdown.prose, main [class*="markdown"][class*="prose"]')];
        messages = nodes.map(node => (node.innerText || node.textContent || '').trim()).filter(Boolean);
      }

      const generating = !!document.querySelector(
        'button[data-testid="stop-button"], button[data-testid*="stop"], button[aria-label*="Stop generating"], button[aria-label*="Stop"], button[aria-label*="stop"]'
      );
      return { count:messages.length, text:messages[messages.length - 1] || '', generating };
    })()`);
  }

  async waitForAssistantReply({ previousCount = 0, timeoutMs = 180000, shouldCancel = null } = {}) {
    const deadline = Date.now() + timeoutMs;
    let stableText = '';
    let stableCount = 0;
    while (Date.now() < deadline) {
      if (typeof shouldCancel === 'function' && shouldCancel()) {
        await this.stopGeneration().catch(() => {});
        const error = new Error('TEAMYRA job cancelled');
        error.code = 'TEAMYRA_CANCELLED';
        throw error;
      }
      const snap = await this.assistantSnapshot();
      if (snap.count > previousCount && snap.text) {
        if (snap.text === stableText) stableCount += 1;
        else {
          stableText = snap.text;
          stableCount = 1;
        }
        if (!snap.generating && stableCount >= 2) return snap;
      } else {
        stableText = '';
        stableCount = 0;
      }
      await sleep(1200);
    }
    throw new Error('Timed out waiting for ChatGPT response');
  }

  parseToolRequest(text) {
    const value = String(text || '').trim();
    if (!value.startsWith(TOOL_REQUEST_PREFIX) || /[\r\n]/.test(value)) return null;
    try {
      const data = JSON.parse(value.slice(TOOL_REQUEST_PREFIX.length));
      if (!data || typeof data.tool !== 'string' || !data.args || typeof data.args !== 'object' || Array.isArray(data.args)) return null;
      return { tool: data.tool, args: data.args };
    } catch {
      return null;
    }
  }
}

module.exports = { ChatGPTAutomationAdapter, TOOL_REQUEST_PREFIX };
