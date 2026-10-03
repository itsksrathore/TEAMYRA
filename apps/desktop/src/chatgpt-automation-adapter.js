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
      const prompt = document.querySelector('#prompt-textarea, textarea[data-testid*="prompt"], [contenteditable="true"][data-testid*="prompt"], main [contenteditable="true"]');
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
    const result = await this.evaluate(`(() => {
      const value = ${payload};
      const prompt = document.querySelector('#prompt-textarea, textarea[data-testid*="prompt"], [contenteditable="true"][data-testid*="prompt"], main [contenteditable="true"]');
      if (!prompt) return { ok:false, reason:'prompt-not-found' };
      prompt.focus();
      if (prompt instanceof HTMLTextAreaElement || prompt instanceof HTMLInputElement) {
        const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(prompt), 'value')?.set;
        if (setter) setter.call(prompt, value); else prompt.value = value;
        prompt.dispatchEvent(new Event('input', { bubbles:true }));
      } else {
        prompt.focus();
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
      const send = document.querySelector('button[data-testid="send-button"], button[aria-label*="Send"], button[aria-label*="send"]');
      if (!send || send.disabled) return { ok:false, reason:'send-button-unavailable' };
      send.click();
      return { ok:true };
    })()`);
    if (!result?.ok) throw new Error(result?.reason || 'Could not send ChatGPT message');
    return result;
  }

  async stopGeneration() {
    return this.evaluate(`(() => {
      const stop = document.querySelector('button[data-testid*="stop"], button[aria-label*="Stop"], button[aria-label*="stop"]');
      if (!stop) return { ok:false, reason:'stop-button-not-found' };
      stop.click();
      return { ok:true };
    })()`);
  }

  async assistantSnapshot() {
    return this.evaluate(`(() => {
      const nodes = [...document.querySelectorAll('[data-message-author-role="assistant"]')];
      const messages = nodes.map(node => (node.innerText || '').trim()).filter(Boolean);
      const stop = !!document.querySelector('button[data-testid*="stop"], button[aria-label*="Stop"], button[aria-label*="stop"]');
      return { count:messages.length, text:messages[messages.length - 1] || '', generating:stop };
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
      if (snap.count > previousCount && snap.text && !snap.generating) {
        if (snap.text === stableText) stableCount += 1;
        else {
          stableText = snap.text;
          stableCount = 1;
        }
        if (stableCount >= 2) return snap;
      }
      await sleep(1200);
    }
    throw new Error('Timed out waiting for ChatGPT response');
  }

  parseToolRequest(text) {
    const line = String(text || '').split(/\r?\n/).map(item => item.trim())
      .find(item => item.startsWith(TOOL_REQUEST_PREFIX));
    if (!line) return null;
    try {
      const data = JSON.parse(line.slice(TOOL_REQUEST_PREFIX.length));
      if (!data || typeof data.tool !== 'string' || !data.args || typeof data.args !== 'object' || Array.isArray(data.args)) return null;
      return { tool: data.tool, args: data.args };
    } catch {
      return null;
    }
  }
}

module.exports = { ChatGPTAutomationAdapter, TOOL_REQUEST_PREFIX };
