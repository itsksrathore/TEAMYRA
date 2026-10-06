const TOOL_REQUEST_PREFIX = 'TEAMYRA_TOOL_REQUEST ';
const TOOL_REQUEST_MARKER = 'TEAMYRA_TOOL_REQUEST';
const PATH_LIKE_KEYS = new Set(['path', 'paths', 'cwd', 'root', 'file', 'workspace', 'target', 'source', 'destination']);
const VALID_JSON_ESCAPES = new Set(['"', '\\', '/', 'b', 'f', 'n', 'r', 't']);
const DEFAULT_PROGRESS_INTERVAL_MS = 30000;
const PROMPT_SELECTOR = '#prompt-textarea, textarea[data-testid*="prompt"], [contenteditable="true"][data-testid*="prompt"], [contenteditable="true"].ProseMirror, main form [contenteditable="true"], main [contenteditable="true"]';
// Browser-side human-verification detection shared by probe() and
// assistantSnapshot(). A conversation may legitimately mention "verify you are
// human", so the phrase only counts when the prompt is gone or it is in a dialog.
const CHALLENGE_DETECT_JS = `((promptPresent) => {
  const phrases = ['verify you are human', 'verify you are a human', 'checking your browser',
    'checking if the site connection is secure', 'complete the security check', 'confirm you are human'];
  const has = text => { const value = String(text || '').toLowerCase(); return phrases.some(phrase => value.includes(phrase)); };
  if (document.querySelector('iframe[src*="challenges.cloudflare.com"], iframe[src*="arkoselabs"], #challenge-form, #challenge-stage, [id^="cf-chl"]')) return true;
  if (/^just a moment/i.test(document.title || '')) return true;
  if ([...document.querySelectorAll('[role="dialog"], dialog[open]')].some(node => has(node.innerText || node.textContent))) return true;
  return !promptPresent && has((document.body?.innerText || '').slice(0, 12000));
})`;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function teamyraError(message, code, reason) {
  const error = new Error(message);
  if (code) error.code = code;
  if (reason) error.reason = reason;
  return error;
}

// Index just after the JSON object starting at `start`, or -1. A backslash
// skips the next character inside strings (also for invalid escapes).
function balancedObjectEnd(text, start) {
  let depth = 0;
  let inString = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (char === '\\') index += 1;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return -1;
}

function looksLikeWindowsPath(raw) {
  return /(^|[^A-Za-z])[A-Za-z]:\\/.test(raw) || /^\\\\[^\\]/.test(raw) || /[A-Za-z0-9_.-]\\[A-Za-z0-9_.$ -]/.test(raw);
}

// Rewrites the raw body of one JSON string literal so JSON.parse accepts it.
function repairStringBody(raw, pathLike) {
  const windowsPath = pathLike && raw.includes('\\') && looksLikeWindowsPath(raw);
  let out = '';
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (char === '\\') {
      const next = raw[index + 1];
      if (next === undefined) { out += '\\\\'; continue; }
      if (windowsPath) {
        // In a Windows path every backslash is a separator: keep an already
        // doubled one and an escaped quote, double everything else.
        if (next === '\\' || next === '"') { out += '\\' + next; index += 1; }
        else out += '\\\\';
        continue;
      }
      if (VALID_JSON_ESCAPES.has(next)) { out += '\\' + next; index += 1; continue; }
      if (next === 'u' && /^[0-9a-fA-F]{4}$/.test(raw.slice(index + 2, index + 6))) { out += '\\u'; index += 1; continue; }
      out += '\\\\';
      continue;
    }
    if (char === '\n') out += '\\n';
    else if (char === '\r') out += '\\r';
    else if (char === '\t') out += '\\t';
    else if (char < ' ') out += '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0');
    else out += char;
  }
  return out;
}

// Re-serializes JSON-ish object text: repairs invalid escapes and raw control
// characters in every string and treats backslashes in path-like values as
// literal Windows separators (so "D:\new" stays a path, not a newline).
function repairToolJson(text) {
  const stack = [];
  let out = '';
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"') {
      let end = index + 1;
      while (end < text.length && text[end] !== '"') end += text[end] === '\\' ? 2 : 1;
      const raw = text.slice(index + 1, Math.min(end, text.length));
      const frame = stack[stack.length - 1];
      let rest = end + 1;
      while (rest < text.length && /\s/.test(text[rest])) rest += 1;
      const isKey = frame?.type === 'object' && text[rest] === ':';
      const key = isKey ? null : frame?.type === 'object' ? frame.key : frame?.parentKey;
      out += '"' + repairStringBody(raw, !isKey && PATH_LIKE_KEYS.has(String(key || ''))) + '"';
      if (isKey) {
        try { frame.key = JSON.parse('"' + repairStringBody(raw, false) + '"'); } catch { frame.key = raw; }
      }
      index = end;
      continue;
    }
    if (char === '{') {
      stack.push({ type: 'object', key: null });
    } else if (char === '[') {
      const frame = stack[stack.length - 1];
      stack.push({ type: 'array', parentKey: frame?.type === 'object' ? frame.key : frame?.parentKey });
    } else if (char === '}' || char === ']') {
      stack.pop();
    }
    out += char;
  }
  return out;
}

function normalizePathArgs(value, key = null) {
  if (typeof value === 'string') return PATH_LIKE_KEYS.has(String(key || '')) ? value.replace(/\\/g, '/') : value;
  if (Array.isArray(value)) return value.map(item => normalizePathArgs(item, key));
  if (value && typeof value === 'object') {
    const result = {};
    for (const [childKey, child] of Object.entries(value)) result[childKey] = normalizePathArgs(child, childKey);
    return result;
  }
  return value;
}

function validToolRequest(data) {
  return Boolean(data && typeof data === 'object' && typeof data.tool === 'string' && data.tool.trim() &&
    data.args && typeof data.args === 'object' && !Array.isArray(data.args));
}

// Parses the first TEAMYRA_TOOL_REQUEST in a reply. `marker` says whether the
// reply contained the marker at all: a reply with the marker is never treated
// as the final answer, even when its JSON cannot be parsed.
function parseToolRequestDetailed(text) {
  const value = String(text || '');
  const markerAt = value.indexOf(TOOL_REQUEST_MARKER);
  if (markerAt < 0) return { marker: false, request: null, error: null };
  const afterMarker = markerAt + TOOL_REQUEST_MARKER.length;
  const start = value.indexOf('{', afterMarker);
  // Only whitespace, a colon or a ``` / ```json fence may sit between the marker and the JSON.
  if (start < 0 || !/^[\s:`]*(json)?[\s`]*$/i.test(value.slice(afterMarker, start))) {
    return { marker: true, request: null, error: 'TEAMYRA_TOOL_REQUEST must be followed by a JSON object' };
  }
  const ends = [];
  const balanced = balancedObjectEnd(value, start);
  if (balanced > 0) ends.push(balanced);
  for (let index = value.length - 1; index > start && ends.length < 24; index -= 1) {
    if (value[index] === '}' && index + 1 !== balanced) ends.push(index + 1);
  }
  let lastError = 'no complete JSON object after TEAMYRA_TOOL_REQUEST';
  for (const end of ends) {
    const candidate = value.slice(start, end);
    for (const source of [repairToolJson(candidate), candidate]) {
      let data;
      try { data = JSON.parse(source); } catch (error) {
        lastError = 'invalid JSON: ' + String(error?.message || error);
        continue;
      }
      if (!validToolRequest(data)) {
        lastError = 'the request must be {"tool": "<name>", "args": {...}}';
        continue;
      }
      return { marker: true, request: { tool: data.tool.trim(), args: normalizePathArgs(data.args) }, error: null };
    }
  }
  return { marker: true, request: null, error: lastError };
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
      const prompt = document.querySelector(${JSON.stringify(PROMPT_SELECTOR)});
      const bodyText = (document.body?.innerText || '').slice(0, 12000).toLowerCase();
      const challenged = ${CHALLENGE_DETECT_JS}(!!prompt);
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

  async lastUserMessage() {
    return this.evaluate(`(() => {
      const nodes = [...document.querySelectorAll('[data-message-author-role="user"]')];
      const last = nodes.filter(node => (node.innerText || node.textContent || '').trim()).at(-1);
      return last ? (last.innerText || last.textContent || '').trim() : '';
    })()`);
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
      const last = nodes.filter(node => (node.innerText || node.textContent || '').trim()).at(-1);
      const turn = last?.closest('[data-testid^="conversation-turn-"], [data-turn-id], article');
      const messageId = last?.getAttribute('data-message-id') ||
        last?.closest('[data-message-id]')?.getAttribute('data-message-id') ||
        turn?.getAttribute('data-turn-id') || turn?.getAttribute('data-testid') || turn?.id || '';
      const challenged = ${CHALLENGE_DETECT_JS}(!!document.querySelector(${JSON.stringify(PROMPT_SELECTOR)}));
      return { count:messages.length, text:messages[messages.length - 1] || '', messageId, generating, challenged };
    })()`);
  }

  // Waits for a new, stable assistant reply. The wait is bounded only by
  // `deadline` (epoch ms, normally the job deadline) or `timeoutMs`; while
  // ChatGPT is still generating or the text keeps growing it keeps waiting.
  // `onProgress` is called every `progressIntervalMs` with live activity, and
  // with `detectChallenge` a human-verification page raises TEAMYRA_CHALLENGED.
  async waitForAssistantReply({
    previousCount = 0, previousText, previousMessageId = '', timeoutMs, deadline, shouldCancel = null,
    onProgress = null, progressIntervalMs = DEFAULT_PROGRESS_INTERVAL_MS, pollMs = 1200, detectChallenge = false
  } = {}) {
    const startedAt = Date.now();
    const endAt = Number.isFinite(deadline)
      ? deadline
      : Number.isFinite(timeoutMs) ? startedAt + timeoutMs : Infinity;
    let stableText = '';
    let stableCount = 0;
    let nextProgress = startedAt + progressIntervalMs;
    let lastSnap = null;
    while (Date.now() < endAt) {
      if (typeof shouldCancel === 'function' && shouldCancel()) {
        await this.stopGeneration().catch(() => {});
        throw teamyraError('TEAMYRA job cancelled', 'TEAMYRA_CANCELLED', 'cancelled');
      }
      const snap = await this.assistantSnapshot();
      lastSnap = snap;
      if (detectChallenge && snap?.challenged) {
        throw teamyraError('ChatGPT requires user verification in the embedded view', 'TEAMYRA_CHALLENGED', 'chatgpt_verification');
      }
      // ChatGPT virtualizes older turns, so the visible count can stay at five
      // or even decrease. Prefer the last turn identity, then its text.
      const newReply = snap.messageId && previousMessageId
        ? snap.messageId !== previousMessageId
        : snap.count > previousCount || (previousText !== undefined && snap.text !== previousText);
      if (newReply && snap.text) {
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
      if (typeof onProgress === 'function' && Date.now() >= nextProgress) {
        nextProgress = Date.now() + progressIntervalMs;
        try {
          await onProgress({
            elapsedMs: Date.now() - startedAt,
            generating: Boolean(snap.generating) || (newReply && stableCount < 2),
            chars: newReply ? String(snap.text || '').length : 0
          });
        } catch {}
      }
      await sleep(Math.max(1, Math.min(pollMs, endAt - Date.now())));
    }
    const error = teamyraError('Timed out waiting for ChatGPT response', 'TEAMYRA_TIMEOUT', 'timeout');
    error.generating = Boolean(lastSnap?.generating);
    throw error;
  }

  parseToolRequestDetailed(text) {
    return parseToolRequestDetailed(text);
  }

  parseToolRequest(text) {
    return parseToolRequestDetailed(text).request;
  }
}

module.exports = {
  ChatGPTAutomationAdapter,
  TOOL_REQUEST_PREFIX,
  TOOL_REQUEST_MARKER,
  PATH_LIKE_KEYS,
  parseToolRequestDetailed,
  repairToolJson,
  teamyraError
};
