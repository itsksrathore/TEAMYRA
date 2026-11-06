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
// Browser-side conversation turns. ChatGPT has rendered turns in several
// ways: `data-message-author-role` nodes, and (current, Nov 2026) unit
// containers `[data-content-search-unit-key$=":user|:assistant"]` that carry
// the message id in `data-chatgpt-search-message-ids` and contain a
// `[data-markdown-text-style]` body only once the reply is rendered. History
// is virtualized ("Loading older messages…"), so counts are unreliable and
// the message id is what identifies a turn. `teamyraTurns(role)` returns the
// turn containers of that role in document order.
const TURNS_JS = `
  const teamyraUnitSelector = role => '[data-content-search-unit-key$=":' + role + '"], [data-chatgpt-search-unit-key$=":' + role + '"], [data-message-author-role="' + role + '"]';
  const teamyraTurns = role => {
    const seen = new Set();
    const out = [];
    for (const node of document.querySelectorAll(teamyraUnitSelector(role))) {
      const unit = node.closest('[data-content-search-unit-key], [data-chatgpt-search-unit-key]') || node;
      if (!seen.has(unit)) { seen.add(unit); out.push(unit); }
    }
    return out;
  };
  const teamyraTurnId = unit => {
    const ids = (unit.getAttribute('data-chatgpt-search-message-ids') || '').trim().split(/\\s+/).filter(Boolean);
    const inner = unit.querySelector('[data-message-id]');
    const turn = unit.closest('[data-testid^="conversation-turn-"], [data-turn-id], article');
    return ids[0] || unit.getAttribute('data-message-id') || inner?.getAttribute('data-message-id') ||
      unit.closest('[data-message-id]')?.getAttribute('data-message-id') ||
      turn?.getAttribute('data-turn-id') || turn?.getAttribute('data-testid') || turn?.id || '';
  };
  const teamyraText = (unit, prefix) => {
    const bodies = [...unit.querySelectorAll('[data-markdown-text-style="assistant-message"]')];
    const text = bodies.length
      ? bodies.map(node => (node.innerText || node.textContent || '').trim()).filter(Boolean).join('\\n\\n')
      : (unit.innerText || unit.textContent || '').trim();
    return text.replace(prefix, '').trim();
  };
`;
// Browser-side signed-out detection. Only ChatGPT's own sign-in controls count,
// never conversation content: a task, file or reply may well say "log in" or
// link to an OAuth page (that used to fail jobs with "sign-in is required").
const LOGIN_DETECT_JS = `(() => {
  if (/^https:\\/\\/auth(0)?\\.openai\\.com\\//.test(location.href)) return true;
  const inContent = node => !!node.closest('[data-message-author-role], [data-content-search-unit-key], [data-chatgpt-search-unit-key], [data-testid^="conversation-turn-"], article, .markdown, [class*="markdown"]');
  const visible = node => { const r = node.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const controls = [...document.querySelectorAll('button[data-testid="login-button"], button[data-testid="signup-button"], a[data-testid="login-button"], a[data-testid="signup-button"]')];
  if (controls.some(node => !inContent(node) && visible(node))) return true;
  const labels = /^(log in|sign up|sign up for free|sign in)$/i;
  return [...document.querySelectorAll('header button, header a, nav button, nav a, [role="banner"] button, [role="banner"] a, [role="dialog"] button')]
    .some(node => !inContent(node) && visible(node) && labels.test((node.innerText || node.textContent || '').trim()));
})()`;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function teamyraError(message, code, reason) {
  const error = new Error(message);
  if (code) error.code = code;
  if (reason) error.reason = reason;
  return error;
}

function pageTimeoutMs(value = process.env.TEAMYRA_CHATGPT_PAGE_TIMEOUT_MS) {
  return Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : 20000;
}

// Race the operation itself, including synchronous throws. A late settlement
// is consumed but cannot turn a timed-out call into a successful call.
async function boundedPageCall(operation, { timeoutMs, onTimeout, label = 'page call' } = {}) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = teamyraError(`ChatGPT ${label} timed out`, 'TEAMYRA_PAGE_UNRESPONSIVE', 'page_unresponsive');
          try { onTimeout?.(error); } catch {} finally { reject(error); }
        }, pageTimeoutMs(timeoutMs));
      })
    ]);
  } finally { clearTimeout(timer); }
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
    if (char === '"') out += '\\"';
    else if (char === '\n') out += '\\n';
    else if (char === '\r') out += '\\r';
    else if (char === '\t') out += '\\t';
    else if (char < ' ') out += '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0');
    else out += char;
  }
  return out;
}

// A quote at `at` ends a JSON string only if what follows is JSON structure:
// a colon, a closing bracket, the end, or a comma before the next key/value.
function closesJsonString(text, at) {
  let index = at + 1;
  while (index < text.length && /\s/.test(text[index])) index += 1;
  if (index >= text.length) return true;
  const next = text[index];
  if (next === ':' || next === '}' || next === ']') return true;
  if (next !== ',') return false;
  index += 1;
  while (index < text.length && /\s/.test(text[index])) index += 1;
  if (index >= text.length || /["{[\]}\d-]/.test(text[index])) return true;
  return /^(?:true|false|null)\s*[,}\]]/.test(text.slice(index, index + 8));
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
      for (;;) {
        while (end < text.length && text[end] !== '"') end += text[end] === '\\' ? 2 : 1;
        if (end >= text.length || closesJsonString(text, end)) break;
        end += 1; // an unescaped quote inside the value ("say "hi"") is content
      }
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
const RAW_REPLY_JS = [
  '(async () => {',
  '  try {',
  '    const wanted = __MESSAGE_ID__;',
  '    const match = location.pathname.match(new RegExp("/c/([0-9a-f-]{36})", "i"));',
  '    if (!match) return "";',
  '    const cache = window.__teamyraAuth || {};',
  '    if (!cache.token || Date.now() - cache.at > 300000) {',
  '      const session = await fetch("/api/auth/session", { credentials: "include" }).then(r => r.ok ? r.json() : null);',
  '      if (!session || !session.accessToken) return "";',
  '      window.__teamyraAuth = { token: session.accessToken, at: Date.now() };',
  '    }',
  '    const response = await fetch("/backend-api/conversation/" + match[1], { credentials: "include",',
  '      headers: { Authorization: "Bearer " + window.__teamyraAuth.token } });',
  '    if (!response.ok) { if (response.status === 401) window.__teamyraAuth = null; return ""; }',
  '    const data = await response.json();',
  '    const mapping = (data && data.mapping) || {};',
  '    const textOf = node => {',
  '      const message = node && node.message;',
  '      if (!message || !message.author || message.author.role !== "assistant") return null;',
  '      const content = message.content || {};',
  '      if (content.content_type !== "text") return null;',
  '      return (content.parts || []).filter(part => typeof part === "string").join(String.fromCharCode(10));',
  '    };',
  // An id the data does not have yet: never fall back to an older reply.
  '    if (wanted) return mapping[wanted] ? (textOf(mapping[wanted]) || "") : "";',
  '    // No id from the page: the newest assistant text on the current branch.',
  '    for (let id = data.current_node, hops = 0; id && mapping[id] && hops < 50; id = mapping[id].parent, hops += 1) {',
  '      const text = textOf(mapping[id]);',
  '      if (text) return text;',
  '    }',
  '    return "";',
  '  } catch (error) { return ""; }',
  '})()'
].join('\n');

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
  constructor(webContents, options = {}) {
    this.webContents = webContents;
    this.pageOptions = options;
  }

  // The site's name in errors (a subclass drives another site).
  get siteName() { return 'ChatGPT'; }

  pageCall(operation, label) {
    return boundedPageCall(operation, { ...this.pageOptions, label });
  }

  async evaluate(source) {
    if (!this.webContents || this.webContents.isDestroyed()) throw new Error('ChatGPT view is unavailable');
    return this.pageCall(() => this.webContents.executeJavaScript(source, true), 'executeJavaScript');
  }

  async probe() {
    return this.evaluate(`(() => {
      const prompt = document.querySelector(${JSON.stringify(PROMPT_SELECTOR)});
      const challenged = ${CHALLENGE_DETECT_JS}(!!prompt);
      const loginVisible = ${LOGIN_DETECT_JS};
      return { promptFound: !!prompt, challenged, loginVisible, url: location.href, title: document.title };
    })()`);
  }

  async newChat() {
    await this.pageCall(() => this.webContents.loadURL('https://chatgpt.com/'), 'navigation');
    return { ok: true };
  }

  async getCurrentConversation() {
    const url = this.webContents.getURL();
    const match = url.match(/\/c\/([A-Za-z0-9_-]+)/);
    return { url, conversationId: match ? match[1] : null, title: this.webContents.getTitle() };
  }

  async lastUserMessage() {
    return this.evaluate(`(() => {${TURNS_JS}
      const texts = teamyraTurns('user').map(unit => teamyraText(unit, /^You said:\\s*/i)).filter(Boolean);
      return texts.at(-1) || '';
    })()`);
  }

  async sendTask(text) {
    const payload = JSON.stringify(String(text || ''));
    const initial = await this.evaluate(`(() => {${TURNS_JS}
      const value = ${payload};
      const assistantCount = teamyraTurns('assistant').length;
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
    const fallback = await this.evaluate(`(() => {${TURNS_JS}
      const prompt = document.querySelector(
        '#prompt-textarea, textarea[data-testid*="prompt"], [contenteditable="true"][data-testid*="prompt"], [contenteditable="true"].ProseMirror, main form [contenteditable="true"], main [contenteditable="true"]'
      );
      const currentText = prompt
        ? (prompt instanceof HTMLTextAreaElement || prompt instanceof HTMLInputElement ? prompt.value : prompt.innerText || prompt.textContent || '')
        : '';
      const assistantCount = teamyraTurns('assistant').length;
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
    return this.evaluate(`(() => {${TURNS_JS}
      const turnOf = node => node?.closest('[data-content-search-unit-key], [data-chatgpt-search-unit-key], [data-testid^="conversation-turn-"], [data-turn-id], article');
      // Generated images count as reply content: an image-only reply has no
      // text, and used to be treated as "no reply yet" until the job failed.
      const imagesOf = node => {
        const scope = turnOf(node) || node;
        return scope ? [...scope.querySelectorAll('img')].filter(img => {
          const rect = img.getBoundingClientRect();
          return Math.max(rect.width, img.naturalWidth || 0) >= 128 && Math.max(rect.height, img.naturalHeight || 0) >= 128;
        }).length : 0;
      };
      const withImages = (node, text) => {
        const images = imagesOf(node);
        return !text && images ? '[ChatGPT replied with ' + images + ' generated image' + (images === 1 ? '' : 's') + ']' : text;
      };
      // Turn containers first: they exist for every reply, including the one
      // streaming now. Picking "the first selector that matches anything"
      // read a stale older message while a new reply had no markdown body yet.
      let nodes = teamyraTurns('assistant');
      let messages = nodes.map(unit => withImages(unit, teamyraText(unit, /^ChatGPT said:\\s*/i)));
      if (!messages.some(Boolean)) {
        nodes = [...document.querySelectorAll('[data-markdown-text-style="assistant-message"], main .markdown.prose, main [class*="markdown"][class*="prose"]')];
        messages = nodes.map(node => withImages(node, (node.innerText || node.textContent || '').trim()));
      }
      const kept = nodes.map((node, index) => [node, messages[index]]).filter(([, text]) => text);
      nodes = kept.map(([node]) => node);
      messages = kept.map(([, text]) => text);

      const generating = !!document.querySelector(
        'button[data-testid="stop-button"], button[data-testid*="stop"], button[aria-label*="Stop generating"], button[aria-label*="Stop"], button[aria-label*="stop"]'
      );
      const last = nodes.at(-1);
      const messageId = last ? teamyraTurnId(turnOf(last) || last) || teamyraTurnId(last) : '';
      // Any change in the newest turn (thinking text, an image rendering in)
      // is progress, even before the reply has text.
      const turns = [...teamyraTurns('user'), ...teamyraTurns('assistant')];
      const legacy = document.querySelectorAll('[data-testid^="conversation-turn-"], [data-turn-id]');
      const newest = teamyraTurns('assistant').at(-1) || legacy[legacy.length - 1];
      const activity = (turns.length || legacy.length) + ':' + (newest ? newest.innerHTML.length : 0);
      const challenged = ${CHALLENGE_DETECT_JS}(!!document.querySelector(${JSON.stringify(PROMPT_SELECTOR)}));
      return { count:messages.length, text:messages[messages.length - 1] || '', messageId, generating, challenged,
        images: last ? imagesOf(last) : 0, activity };
    })()`);
  }

  // URL of the newest conversation in the sidebar, or ''. Used after a reload
  // when the job's conversation URL was never observed.
  async latestConversationUrl() {
    // Pinned chats are listed first; the newest chat is the first link after
    // the "Recents" heading (or after "Chats" in older layouts).
    return this.evaluate(`(() => {
      const links = [...document.querySelectorAll('nav a[href*="/c/"], aside a[href*="/c/"]')];
      // The sidebar also holds hidden copies of the headings before the
      // pinned list; the section heading is the last one.
      const heading = [...document.querySelectorAll('nav *, aside *')].filter(node =>
        node.children.length === 0 && /^(recents|chats)$/i.test((node.textContent || '').trim())).at(-1);
      const after = heading
        ? links.find(link => heading.compareDocumentPosition(link) & Node.DOCUMENT_POSITION_FOLLOWING)
        : null;
      const link = after || (heading ? null : links[0]);
      return link ? new URL(link.getAttribute('href'), location.href).href : '';
    })()`);
  }

  // Waits for a new, stable assistant reply. The wait is bounded only by
  // `deadline` (epoch ms, normally the job deadline) or `timeoutMs`; while
  // ChatGPT is still generating or the text keeps growing it keeps waiting.
  // `onProgress` is called every `progressIntervalMs` with live activity, and
  // with `detectChallenge` a human-verification page raises TEAMYRA_CHALLENGED.
  async waitForAssistantReply({
    previousCount = 0, previousText, previousMessageId = '', timeoutMs, deadline, shouldCancel = null,
    onProgress = null, progressIntervalMs = DEFAULT_PROGRESS_INTERVAL_MS, pollMs = 1200, detectChallenge = false,
    noProgressMs = 300000, shouldRecover = null
  } = {}) {
    const startedAt = Date.now();
    const endAt = Number.isFinite(deadline)
      ? deadline
      : Number.isFinite(timeoutMs) ? startedAt + timeoutMs : Infinity;
    let stableText = '';
    let stableCount = 0;
    let nextProgress = startedAt + progressIntervalMs;
    let lastSnap = null;
    let lastProgressAt = startedAt;
    let lastSignature = null;
    while (Date.now() < endAt) {
      if (typeof shouldCancel === 'function' && shouldCancel()) {
        await this.stopGeneration().catch(() => {});
        throw teamyraError('TEAMYRA job cancelled', 'TEAMYRA_CANCELLED', 'cancelled');
      }
      const snap = await this.assistantSnapshot();
      lastSnap = snap;
      const signature = JSON.stringify([snap.count, snap.messageId, snap.text, snap.activity ?? null]);
      if (signature !== lastSignature || snap.generating) lastProgressAt = Date.now();
      lastSignature = signature;
      if (shouldRecover?.() || (!snap.generating && Date.now() - lastProgressAt >= noProgressMs)) {
        throw teamyraError(this.siteName + ' page made no progress', 'TEAMYRA_PAGE_UNRESPONSIVE', 'page_unresponsive');
      }
      if (detectChallenge && snap?.challenged) {
        throw teamyraError(this.siteName + ' requires user verification in the embedded view', 'TEAMYRA_CHALLENGED',
          this.siteName.toLowerCase() + '_verification');
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
    const error = teamyraError('Timed out waiting for ' + this.siteName + ' response', 'TEAMYRA_TIMEOUT', 'timeout');
    error.generating = Boolean(lastSnap?.generating);
    throw error;
  }

  // The reply exactly as ChatGPT wrote it, from the conversation data the
  // page itself loads. The page text is rendered Markdown: `$...$` becomes
  // math, a doubled backslash or `\"` loses a backslash, `*x*` loses its stars. Tool
  // requests read from it broke as JSON (or, worse, wrote changed code), so
  // they are parsed from this text. '' when it cannot be read.
  async rawReplyText(messageId = '') {
    const text = await this.evaluate(RAW_REPLY_JS.replace('__MESSAGE_ID__', JSON.stringify(String(messageId || ''))));
    return typeof text === 'string' ? text : '';
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
  teamyraError,
  boundedPageCall,
  pageTimeoutMs
};
