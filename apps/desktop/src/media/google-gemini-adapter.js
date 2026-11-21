const path = require('node:path');

// Google Gemini (gemini.google.com/app) page automation. Learned from the
// live page (Nov 2026):
// - Prompt: div.ql-editor[contenteditable=true][aria-label="Enter a prompt for Gemini"].
// - Mode picker: button[data-test-id=bard-mode-menu-button] "Open mode picker,
//   currently Auto" opens gem-menu[role=menu] of gem-menu-item[role=menuitemradio]
//   each with span.label and div.sublabel ("Auto"/"Adapts to your needs",
//   "Everyday help"/"4 Hydrogen", ...); aria-checked marks the current one.
// - Chat / Task: gem-segmented-button buttons under the prompt box.
// - "Upload & tools" (+) opens a mat-action-list[role=menu]: Upload files, Add
//   from Drive, ... and, signed in, the tools (images, videos, Deep Research,
//   Canvas...). Hidden <input type=file> elements take uploads (one accepts
//   image/*,video/*, one documents).
// - Send: button[aria-label="Send message"]; while answering a
//   button[aria-label="Stop response"] shows. The chat moves to /app/<id>.
// - Answers: model-response > message-content .markdown; message-actions
//   (Copy, Redo) appear when the answer is complete.
// Labels change: every option is matched by name from the page's own menus and
// a missing one fails with option_unavailable listing what the page offers.

const SCRIPT_TIMEOUT_MS = 60000;

// ---- page probes (each runs in the page; self-contained) -------------------

const PROBES = {
  state() {
    const visible = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const buttons = [...document.querySelectorAll('button,[role=button]')].filter(visible);
    const aria = el => el.getAttribute('aria-label') || '';
    const box = [...document.querySelectorAll('[contenteditable=true]')].find(el => visible(el) &&
      (/prompt|gemini|ask/i.test(aria(el)) || el.classList.contains('ql-editor')));
    const send = buttons.find(el => /^send message$/i.test(aria(el)) || el.classList.contains('send-button'));
    const picker = buttons.find(el => el.getAttribute('data-test-id') === 'bard-mode-menu-button' || /^open mode picker/i.test(aria(el)));
    const signIn = buttons.some(el => /^sign in$/i.test((el.innerText || '').trim())) ||
      [...document.querySelectorAll('a')].some(el => visible(el) && /^sign in$/i.test((el.innerText || '').trim()));
    const account = [...document.querySelectorAll('a[aria-label^="Google Account"],[aria-label^="Google Account:"]')].some(visible);
    const segments = [...document.querySelectorAll('gem-segmented-button button, button.gem-segmented-button-action')].filter(visible)
      .map(el => ({ text: (el.innerText || '').trim(),
        selected: ['aria-pressed', 'aria-checked', 'aria-selected'].some(name => el.getAttribute(name) === 'true') ||
          Boolean(el.closest('.gem-segmented-button-selected')) }));
    // Snackbars, banners and dialogs may carry a usage-limit message.
    const notices = [...document.querySelectorAll('[role=alert],[role=status],mat-snack-bar-container,.mat-mdc-snack-bar-label,[role=dialog],.limit-banner,usage-limit-banner')]
      .filter(visible).map(el => (el.innerText || '').trim()).filter(Boolean).join('\n').slice(0, 2000);
    return {
      url: location.href,
      signedOut: /accounts\.google\.com/.test(location.host) || (signIn && !account),
      prompt: box ? (box.innerText || '').trim() : null,
      sendEnabled: send ? !send.disabled && send.getAttribute('aria-disabled') !== 'true' : false,
      stop: buttons.some(el => /^stop (response|generating|research)/i.test(aria(el))),
      model: picker ? aria(picker).replace(/^open mode picker,?\s*(currently\s*)?/i, '').trim() || (picker.innerText || '').trim() : null,
      segments,
      responses: document.querySelectorAll('model-response').length,
      attachments: [...document.querySelectorAll('button')].filter(el => visible(el) && /^remove (file|image|attachment|upload)/i.test(aria(el))).length +
        document.querySelectorAll('uploader-file-preview, file-preview, .file-preview-container .file-preview').length,
      notices
    };
  },

  openMenu(args) {
    const visible = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const aria = el => el.getAttribute('aria-label') || '';
    const buttons = [...document.querySelectorAll('button,[role=button]')].filter(visible);
    const trigger = args.menu === 'model'
      ? buttons.find(el => el.getAttribute('data-test-id') === 'bard-mode-menu-button' || /^open mode picker/i.test(aria(el)))
      : args.menu === 'tools'
        ? buttons.find(el => /^upload (&|and) tools$|^open upload file menu$|^tools$/i.test(aria(el)) || el.getAttribute('data-test-id') === 'upload-and-tools-button')
        : null;
    if (!trigger) return null;
    trigger.click();
    const r = trigger.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  },

  menuItems(args) {
    const visible = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const clean = text => String(text || '').replace(/\s+/g, ' ').trim();
    const menus = [...document.querySelectorAll('[role=menu]')].filter(visible);
    const items = [];
    const seen = new Set();
    for (const menu of menus) {
      for (const el of menu.querySelectorAll('[role=menuitemradio],[role=menuitem],[role=menuitemcheckbox],button[mat-list-item],button.mat-mdc-list-item')) {
        if (!visible(el) || seen.has(el)) continue;
        seen.add(el);
        const label = clean(el.querySelector('.label,.gem-menu-item-label,.menu-text')?.innerText) || clean(el.getAttribute('aria-label')) || clean(el.innerText);
        const sublabel = clean(el.querySelector('.sublabel,.gem-menu-item-sublabel,.description')?.innerText);
        items.push({ index: items.length, label, sublabel, aria: clean(el.getAttribute('aria-label')), text: clean(el.innerText).slice(0, 200),
          disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
          checked: el.getAttribute('aria-checked') === 'true' || el.classList.contains('selected') || el.classList.contains('is-selected'),
          submenu: el.getAttribute('aria-haspopup') === 'menu' || el.getAttribute('aria-haspopup') === 'true' });
      }
    }
    if (args && Number.isInteger(args.click)) {
      const el = [...seen][args.click];
      if (!el) return null;
      el.scrollIntoView({ block: 'nearest' });
      el.click();
      return items[args.click];
    }
    return items;
  },

  setMode(args) {
    const visible = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const want = String(args.mode || '').toLowerCase();
    const el = [...document.querySelectorAll('gem-segmented-button button, button.gem-segmented-button-action')].filter(visible)
      .find(node => (node.innerText || '').trim().toLowerCase() === want);
    if (!el) return false;
    el.click();
    return true;
  },

  inputChips() {
    const visible = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const box = [...document.querySelectorAll('[contenteditable=true]')].find(visible);
    let area = box;
    for (let i = 0; i < 8 && area && area.parentElement; i += 1) area = area.parentElement;
    if (!area) return [];
    return [...area.querySelectorAll('button,[role=button],.chip,[class*=chip]')].filter(visible)
      .map(el => ((el.getAttribute('aria-label') || '') + ' ' + (el.innerText || '')).replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 60);
  },

  focusPrompt() {
    const visible = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const box = [...document.querySelectorAll('[contenteditable=true]')].find(el => visible(el) &&
      (/prompt|gemini|ask/i.test(el.getAttribute('aria-label') || '') || el.classList.contains('ql-editor')));
    if (!box) return false;
    box.focus();
    const range = document.createRange(); range.selectNodeContents(box); range.collapse(false);
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
    return true;
  },

  clickSend() {
    const visible = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const send = [...document.querySelectorAll('button')].filter(visible)
      .find(el => /^send message$/i.test(el.getAttribute('aria-label') || '') || el.classList.contains('send-button'));
    if (!send || send.disabled || send.getAttribute('aria-disabled') === 'true') return false;
    send.click();
    return true;
  },

  // The last answer: completion, text, media and controls.
  lastResponse() {
    const visible = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const responses = [...document.querySelectorAll('model-response')];
    const last = responses[responses.length - 1];
    const buttons = [...document.querySelectorAll('button')].filter(visible);
    const stop = buttons.some(el => /^stop (response|generating|research)/i.test(el.getAttribute('aria-label') || ''));
    const startResearch = buttons.some(el => /^start research$/i.test((el.innerText || '').trim()));
    const immersive = [...document.querySelectorAll('deep-research-immersive-panel, immersive-panel, code-immersive-panel, .immersive-panel, [data-test-id=immersive-panel]')].some(visible);
    if (!last) return { count: 0, stop, startResearch, immersive, done: false, text: '', media: [], downloads: 0 };
    const content = last.querySelector('message-content') || last;
    const media = [];
    for (const img of last.querySelectorAll('img')) {
      const r = img.getBoundingClientRect();
      const src = img.currentSrc || img.src || '';
      if (!src || /\.svg(\?|$)|favicon|\/s\d{1,2}-|=s\d{1,2}(-|$)/i.test(src)) continue;
      if ((img.naturalWidth || r.width) < 160 || (img.naturalHeight || r.height) < 160) continue;
      if (img.closest('sources-list, source-footnote, .source-chip, .sources-carousel')) continue;
      media.push({ kind: 'image', src, width: img.naturalWidth || Math.round(r.width), height: img.naturalHeight || Math.round(r.height) });
    }
    for (const video of last.querySelectorAll('video')) {
      const src = video.currentSrc || video.src || video.querySelector('source')?.src || '';
      if (src) media.push({ kind: 'video', src, width: video.videoWidth || 0, height: video.videoHeight || 0, duration: video.duration || null });
    }
    const downloads = [...last.querySelectorAll('button')].filter(el => visible(el) && /download/i.test((el.getAttribute('aria-label') || '') + ' ' + (el.innerText || ''))).length;
    const footer = last.querySelector('.response-footer.complete, message-actions, copy-button');
    const busy = last.querySelector('[aria-busy=true]');
    const links = [...content.querySelectorAll('a[href]')].map(a => a.href).filter(href => /^https:/.test(href)).slice(0, 200);
    return { count: responses.length, stop, startResearch, immersive, done: !stop && Boolean(footer) && !busy,
      text: (content.innerText || '').trim().slice(0, 200000), media, downloads, links };
  },

  // The answer (or the Deep Research / Canvas panel) as a small node tree for Markdown.
  responseTree(args) {
    const visible = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    let root = null;
    if (args && args.immersive) {
      root = [...document.querySelectorAll('deep-research-immersive-panel, immersive-panel, code-immersive-panel, .immersive-panel, [data-test-id=immersive-panel]')]
        .filter(visible).map(el => el.querySelector('.markdown, message-content, .ProseMirror, [contenteditable]') || el)[0] || null;
    }
    if (!root) {
      const responses = [...document.querySelectorAll('model-response')];
      const last = responses[responses.length - 1];
      root = last && (last.querySelector('message-content .markdown') || last.querySelector('message-content') || last);
    }
    if (!root) return null;
    const skip = /^(script|style|svg|button|mat-icon|gem-icon|sources-list|message-actions|thinking-overlay)$/i;
    let budget = 60000;
    const walk = node => {
      if (budget-- <= 0) return null;
      if (node.nodeType === 3) return { t: node.nodeValue };
      if (node.nodeType !== 1 || skip.test(node.tagName)) return null;
      const out = { tag: node.tagName.toLowerCase(), c: [] };
      if (node.tagName === 'A' && node.href) out.href = node.href;
      if (node.tagName === 'IMG') { out.src = node.currentSrc || node.src || ''; out.alt = node.alt || ''; }
      if (node.tagName === 'CODE' || node.tagName === 'PRE') {
        const lang = (node.className.match(/language-([\w+-]+)/) || [])[1]; if (lang) out.lang = lang;
      }
      for (const child of node.childNodes) { const item = walk(child); if (item) out.c.push(item); }
      return out;
    };
    return walk(root);
  },

  clickStartResearch() {
    const visible = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const el = [...document.querySelectorAll('button')].filter(visible).find(node => /^start research$/i.test((node.innerText || '').trim()));
    if (!el || el.disabled) return false;
    el.click();
    return true;
  },

  clickDownload(args) {
    const visible = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const responses = [...document.querySelectorAll('model-response')];
    const last = responses[responses.length - 1];
    if (!last) return false;
    const buttons = [...last.querySelectorAll('button')].filter(el => visible(el) &&
      /download/i.test((el.getAttribute('aria-label') || '') + ' ' + (el.innerText || '')));
    const el = buttons[Math.max(0, Number(args && args.index) || 0)];
    if (!el) return false;
    el.click();
    return true;
  },

  // Read a blob:/data:/same-site media URL inside the page (its own cookies).
  async readMedia(args) {
    const response = await fetch(args.src, { credentials: 'include' });
    if (!response.ok) return { ok: false, status: response.status };
    const blob = await response.blob();
    if (blob.size > 400 * 1024 * 1024) return { ok: false, status: 413 };
    const buffer = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    for (let i = 0; i < buffer.length; i += 0x8000) binary += String.fromCharCode.apply(null, buffer.subarray(i, i + 0x8000));
    return { ok: true, status: response.status, type: blob.type, base64: btoa(binary) };
  }
};

function probeScript(name, args = {}) {
  if (!PROBES[name]) throw new Error('unknown Gemini page probe ' + name);
  return '(' + PROBES[name].toString().replace(/^(async\s+)?(\w+)\s*\(/, '$1function $2(') + ')(/*probe:' + name + '*/ ' + JSON.stringify(args) + ')';
}

// ---- pure helpers (Node side, unit-tested) ---------------------------------

function normalizeName(value) {
  return String(value || '').normalize('NFKC').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

// A menu entry named by its label, sublabel, both, or aria-label.
function matchOption(items, wanted) {
  const want = normalizeName(wanted);
  if (!want) return null;
  const names = item => [item.label, item.sublabel, (item.label || '') + ' ' + (item.sublabel || ''),
    (item.sublabel || '') + ' ' + (item.label || ''), item.aria].map(normalizeName).filter(Boolean);
  return items.find(item => names(item).includes(want)) ||
    items.find(item => names(item).some(name => name.startsWith(want) || (want.length >= 4 && name.includes(want)))) || null;
}

const UPLOAD_ENTRY = /^(upload|add from|more uploads|photos|import code|notebooklm|add (files|photos)|drive)/i;
const TOOL_PATTERNS = {
  image: /\b(create|generate|make)?\s*images?\b|image generation|nano banana/i,
  video: /\b(create|generate|make)?\s*videos?\b|\bveo\b/i,
  deep_research: /deep\s*research/i,
  canvas: /\bcanvas\b/i
};

function matchTool(items, tool) {
  const candidates = items.filter(item => !UPLOAD_ENTRY.test(item.label || item.text || ''));
  const pattern = TOOL_PATTERNS[tool];
  const text = item => [item.label, item.sublabel, item.aria, item.text].filter(Boolean).join(' ');
  if (pattern) {
    const hits = candidates.filter(item => pattern.test(text(item)));
    // "Create images" over a "Videos" entry whose description mentions images.
    return hits.find(item => pattern.test(item.label || '')) || hits[0] || null;
  }
  return matchOption(candidates, String(tool || '').replace(/_/g, ' '));
}

function describeOptions(items) {
  return items.map(item => item.sublabel ? item.label + ' (' + item.sublabel + ')' : item.label).filter(Boolean).join(', ') || 'none';
}

const LIMIT_RE = /(you(?:'|’)ve|you have) (?:reached|hit|used up) (?:your|the) (?:\w+ )?(?:limit|quota)|(?:reached|hit) (?:your|the|its) (?:daily |usage |generation )?limit|limit (?:for|on) (?:image|video|deep research|research|canvas)[\w ]*(?:reached|resets?)|(?:limit|quota) (?:will )?resets? (?:on|at|in|tomorrow)|you(?:'|’)ve used all|out of (?:\w+ )?(?:generations|requests|quota)|too many requests|try again (?:in \d+|later today|tomorrow)|usage limit/i;

function detectLimit(text) {
  const match = String(text || '').match(LIMIT_RE);
  if (!match) return null;
  const index = match.index || 0;
  const source = String(text);
  return source.slice(Math.max(0, index - 120), index + 220).replace(/\s+/g, ' ').trim();
}

// Seconds until a limit lifts, from "in 3 hours", "in 45 minutes", "tomorrow".
function cooldownSeconds(text, fallback = 4 * 3600) {
  const source = String(text || '');
  const hours = source.match(/in (\d+(?:\.\d+)?) ?(?:hours?|hrs?)\b/i);
  const minutes = source.match(/in (\d+) ?(?:minutes?|mins?)\b/i);
  const days = source.match(/in (\d+) ?days?\b/i);
  let seconds = 0;
  if (days) seconds += Number(days[1]) * 86400;
  if (hours) seconds += Number(hours[1]) * 3600;
  if (minutes) seconds += Number(minutes[1]) * 60;
  if (!seconds && /tomorrow/i.test(source)) seconds = 12 * 3600;
  return Math.max(300, Math.min(7 * 86400, seconds || fallback));
}

const REFUSAL_RE = /(I|we)(?:'|’)?m (?:not able|unable) to (?:create|generate|make|help)|(I|we) can(?:'|’)?t (?:create|generate|make|help with) (?:that|this|images?|videos?)|against (?:our|my) (?:policies|guidelines|terms)|violates? (?:our|the) (?:policies|guidelines|terms)|not able to help with that/i;

function isRefusal(text) { return REFUSAL_RE.test(String(text || '')); }

function sniffMedia(buffer) {
  const b = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  if (b.length >= 8 && b.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { kind: 'image', ext: 'png' };
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { kind: 'image', ext: 'jpg' };
  if (b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return { kind: 'image', ext: 'webp' };
  if (b.length >= 6 && /^GIF8[79]a$/.test(b.toString('ascii', 0, 6))) return { kind: 'image', ext: 'gif' };
  if (b.length >= 12 && b.toString('ascii', 4, 8) === 'ftyp') return { kind: 'video', ext: 'mp4' };
  if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return { kind: 'video', ext: 'webm' };
  return null;
}

// The node tree from responseTree() as Markdown.
function treeToMarkdown(tree) {
  const inline = node => {
    if (!node) return '';
    if (node.t !== undefined) return node.t.replace(/\s+/g, ' ');
    const inner = (node.c || []).map(inline).join('');
    switch (node.tag) {
      case 'b': case 'strong': return inner.trim() ? '**' + inner.trim() + '**' : '';
      case 'i': case 'em': return inner.trim() ? '*' + inner.trim() + '*' : '';
      case 'code': return '`' + inner + '`';
      case 'a': return node.href && !/^javascript:/i.test(node.href) ? '[' + (inner.trim() || node.href) + '](' + node.href + ')' : inner;
      case 'br': return '\n';
      case 'img': return node.src && !/^data:/.test(node.src) ? '![' + (node.alt || '') + '](' + node.src + ')' : '';
      case 'sup': return inner.trim() ? '^' + inner.trim() : '';
      default: return inner;
    }
  };
  const text = node => node.t !== undefined ? node.t : (node.c || []).map(text).join('');
  const blocks = [];
  const BLOCK = /^(p|div|h[1-6]|ul|ol|pre|blockquote|table|hr|section|article|li|response-element|code-block|message-content|structured-content-container)$/;
  const isBlock = node => node && node.tag && BLOCK.test(node.tag);
  const list = (node, depth, lines = null) => {
    const own = !lines;
    lines = lines || [];
    let n = 0;
    for (const item of node.c || []) {
      if (item.tag !== 'li') continue;
      n += 1;
      const marker = node.tag === 'ol' ? n + '. ' : '- ';
      const parts = []; const nested = [];
      for (const child of item.c || []) {
        if (child.tag === 'ul' || child.tag === 'ol') nested.push(child);
        else parts.push(isBlock(child) ? render(child, depth + 1, true) : inline(child));
      }
      lines.push('  '.repeat(depth) + marker + parts.join(' ').replace(/\s*\n\s*/g, ' ').trim());
      for (const child of nested) list(child, depth + 1, lines);
    }
    if (own && lines.length) blocks.push(lines.join('\n'));
  };
  const table = node => {
    const rows = [];
    const collect = n => { for (const child of n.c || []) { if (child.tag === 'tr') rows.push(child); else if (child.tag) collect(child); } };
    collect(node);
    if (!rows.length) return;
    const cells = rows.map(row => (row.c || []).filter(cell => cell.tag === 'td' || cell.tag === 'th')
      .map(cell => inline(cell).replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim()));
    const width = Math.max(...cells.map(row => row.length));
    const pad = row => [...row, ...Array(width - row.length).fill('')];
    blocks.push(['| ' + pad(cells[0]).join(' | ') + ' |', '|' + ' --- |'.repeat(width),
      ...cells.slice(1).map(row => '| ' + pad(row).join(' | ') + ' |')].join('\n'));
  };
  function render(node, depth = 0, asText = false) {
    if (!node) return '';
    if (node.t !== undefined) { if (!asText && node.t.trim()) blocks.push(node.t.trim()); return node.t; }
    const tag = node.tag;
    if (/^h[1-6]$/.test(tag)) { const value = '#'.repeat(Number(tag[1])) + ' ' + inline(node).trim(); if (asText) return value; blocks.push(value); return ''; }
    if (tag === 'p') { const value = inline(node).trim(); if (asText) return value; if (value) blocks.push(value); return ''; }
    if (tag === 'ul' || tag === 'ol') { list(node, depth); return ''; }
    if (tag === 'pre') {
      const code = (node.c || []).find(child => child.tag === 'code');
      blocks.push('```' + ((code && code.lang) || node.lang || '') + '\n' + text(code || node).replace(/\n+$/, '') + '\n```');
      return '';
    }
    if (tag === 'blockquote') { const value = inline(node).trim(); if (value) blocks.push(value.split('\n').map(line => '> ' + line).join('\n')); return ''; }
    if (tag === 'table') { table(node); return ''; }
    if (tag === 'hr') { blocks.push('---'); return ''; }
    // Containers: blocks render themselves; runs of inline nodes form a paragraph.
    let run = [];
    const flush = () => { const value = run.map(inline).join('').trim(); if (value) blocks.push(value); run = []; };
    for (const child of node.c || []) {
      if (isBlock(child)) { flush(); render(child, depth); } else run.push(child);
    }
    flush();
    return '';
  }
  render(tree);
  return blocks.join('\n\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

// ---- adapter ----------------------------------------------------------------

class GoogleGeminiAdapter {
  constructor(webContents, { settleMs = 500 } = {}) {
    this.webContents = webContents;
    this.settleMs = settleMs;
    this.step = 'idle';
    this.pending = 0;
    this.chooserFiles = null;
  }

  async exec(source, timeoutMs = SCRIPT_TIMEOUT_MS) {
    let timer;
    this.pending += 1;
    try {
      return await Promise.race([
        this.webContents.executeJavaScript(source, true),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('browser_failure: Gemini page script timed out')), timeoutMs); })
      ]);
    } finally { clearTimeout(timer); this.pending -= 1; }
  }

  probe(name, args) { return this.exec(probeScript(name, args)); }
  sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

  async wait(read, label, timeoutMs = 20000, everyMs = 300) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = await read().catch(error => { if (/login_required|option_unavailable/.test(String(error?.message))) throw error; return null; });
      if (value) return value;
      await this.sleep(everyMs);
    }
    throw new Error('selector_failure: Gemini ' + label + ' did not become ready');
  }

  async cdp(method, params = {}, timeoutMs = 10000) {
    const wc = this.webContents;
    if (!wc.debugger) throw new Error('browser_failure: DevTools is unavailable');
    if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
    let timer;
    this.pending += 1;
    try {
      return await Promise.race([wc.debugger.sendCommand(method, params), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('browser_failure: DevTools ' + method + ' did not answer (step: ' + this.step + ')')), timeoutMs);
      })]);
    } finally { clearTimeout(timer); this.pending -= 1; }
  }

  async key(key) {
    const codes = { Escape: 27, Enter: 13 };
    const base = { key, code: key, windowsVirtualKeyCode: codes[key] || 0, nativeVirtualKeyCode: codes[key] || 0 };
    await this.cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base }).catch(() => null);
    await this.cdp('Input.dispatchKeyEvent', { type: 'keyUp', ...base }).catch(() => null);
  }

  async mouseClick(x, y) {
    await this.cdp('Page.captureScreenshot', { format: 'jpeg', quality: 1, fromSurface: true, clip: { x: 0, y: 0, width: 1, height: 1, scale: 1 } }, 5000).catch(() => null);
    await this.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await this.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await this.cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  }

  state() { return this.probe('state'); }

  // A fresh chat page, signed in.
  async ready() {
    this.step = 'page';
    return this.wait(async () => {
      const state = await this.state();
      if (state.signedOut) throw new Error('login_required: this Google account is not signed in to Gemini');
      return state.prompt !== null ? state : null;
    }, 'prompt box', 45000, 500);
  }

  async closeMenus() {
    await this.key('Escape');
    await this.sleep(150);
  }

  // Open a menu and read its entries (a real click if element.click() did not open it).
  async menu(name) {
    const items = async () => (await this.probe('menuItems')) || [];
    const opened = await this.probe('openMenu', { menu: name });
    if (!opened) throw new Error('selector_failure: Gemini ' + (name === 'model' ? 'mode picker' : 'Upload & tools') + ' button not found');
    await this.sleep(this.settleMs);
    let list = await items();
    if (!list.length) {
      await this.mouseClick(opened.x, opened.y).catch(() => null);
      await this.sleep(this.settleMs);
      list = await items();
    }
    if (!list.length) throw new Error('selector_failure: Gemini ' + name + ' menu did not open');
    return list;
  }

  async chooseModel(model) {
    this.step = 'model';
    const wanted = String(model || 'Auto');
    const state = await this.state();
    if (state.model && normalizeName(state.model) === normalizeName(wanted)) return { model: state.model, offered: null };
    const items = (await this.menu('model')).filter(item => item.label);
    const choice = matchOption(items, wanted);
    if (!choice || choice.disabled) {
      await this.closeMenus();
      throw new Error('option_unavailable: Gemini model "' + wanted + '" is ' + (choice ? 'disabled' : 'not offered') +
        ' in this account; it offers: ' + describeOptions(items.filter(item => !item.disabled && !/^sign in$/i.test(item.label))));
    }
    if (!choice.checked) await this.probe('menuItems', { click: choice.index });
    await this.sleep(this.settleMs);
    if (await this.probe('menuItems').then(list => list && list.length).catch(() => 0)) await this.closeMenus();
    const label = (await this.state()).model || '';
    if (label && ![choice.label, choice.sublabel].some(name => name && normalizeName(label).includes(normalizeName(name)))) {
      throw new Error('selector_failure: Gemini kept model ' + label + ' after choosing ' + choice.label);
    }
    return { model: choice.label, description: choice.sublabel, offered: describeOptions(items) };
  }

  // The mode picker's "Thinking level" submenu (Low / Medium / High, signed
  // in). High by default (owner, 2026-11-21). Returns the level set, or null
  // when the page has no such submenu (it is not an error then).
  async chooseThinking(level) {
    this.step = 'thinking';
    const want = String(level || 'high').toLowerCase();
    const levelOf = item => ((item.label || item.text || '').trim().split(' ')[0] || '').toLowerCase();
    let items = await this.menu('model');
    const entry = items.find(item => /thinking level/i.test(item.text || item.label || ''));
    if (!entry) { await this.closeMenus(); return null; }
    await this.probe('menuItems', { click: entry.index });
    await this.sleep(this.settleMs);
    items = (await this.probe('menuItems')) || [];
    const levels = items.filter(item => ['low', 'medium', 'high'].includes(levelOf(item)));
    const choice = levels.find(item => levelOf(item) === want);
    if (!choice || choice.disabled) {
      await this.closeMenus();
      throw new Error('option_unavailable: Gemini thinking level "' + level + '" is not offered in this account; it offers: ' +
        (levels.map(item => item.label || item.text).join(', ') || 'none'));
    }
    if (!choice.checked) {
      await this.probe('menuItems', { click: choice.index });
      await this.sleep(this.settleMs);
    }
    await this.closeMenus();
    if ((await this.probe('menuItems').then(list => list && list.length).catch(() => 0))) await this.closeMenus();
    return want;
  }

  async chooseMode(mode) {
    this.step = 'mode';
    const want = String(mode || 'chat').toLowerCase();
    const segments = (await this.state()).segments || [];
    const current = segments.find(item => item.text.toLowerCase() === want);
    if (!current) {
      if (want === 'chat' && !segments.some(item => item.selected)) return 'chat';
      throw new Error('option_unavailable: Gemini mode "' + mode + '" is not offered in this account; it offers: ' +
        (segments.map(item => item.text).join(', ') || 'no Chat/Task toggle'));
    }
    if (current.selected) return want;
    await this.probe('setMode', { mode: want });
    await this.wait(async () => ((await this.state()).segments || []).find(item => item.text.toLowerCase() === want)?.selected,
      want + ' mode', 8000, 250);
    return want;
  }

  async chooseTool(tool) {
    this.step = 'tool';
    if (!tool || tool === 'none') return null;
    let items = await this.menu('tools');
    let choice = matchTool(items, tool);
    // Tools may sit in a submenu ("Tools", "More").
    if (!choice) {
      const more = items.find(item => item.submenu && !UPLOAD_ENTRY.test(item.label || '') || /^(tools|more tools|more)$/i.test(item.label || ''));
      if (more) {
        await this.probe('menuItems', { click: more.index });
        await this.sleep(this.settleMs);
        items = (await this.probe('menuItems')) || items;
        choice = matchTool(items, tool);
      }
    }
    if (!choice || choice.disabled) {
      await this.closeMenus();
      const offered = items.filter(item => !item.disabled && !UPLOAD_ENTRY.test(item.label || '')).map(item => item.label);
      throw new Error('option_unavailable: Gemini tool "' + tool + '" is ' + (choice ? 'disabled' : 'not offered') +
        ' in this account (signed-in accounts list tools in Upload & tools); it offers: ' + (offered.join(', ') || 'no tools'));
    }
    if (!choice.checked) await this.probe('menuItems', { click: choice.index });
    await this.sleep(this.settleMs);
    if (await this.probe('menuItems').then(list => list && list.length).catch(() => 0)) await this.closeMenus();
    const chips = await this.probe('inputChips').catch(() => []);
    const words = normalizeName(choice.label).slice(0, 8);
    return { tool: choice.label, confirmed: chips.some(chip => normalizeName(chip).includes(words)) };
  }

  async setInputFiles(accept, files) {
    const { root } = await this.cdp('DOM.getDocument', { depth: -1, pierce: true });
    const { nodeIds } = await this.cdp('DOM.querySelectorAll', { nodeId: root.nodeId, selector: 'input[type=file]' });
    for (const nodeId of nodeIds) {
      const { node } = await this.cdp('DOM.describeNode', { nodeId });
      const attrs = node.attributes || [];
      const value = attrs[attrs.indexOf('accept') + 1] || '';
      if (attrs.indexOf('accept') >= 0 && accept(value)) {
        await this.cdp('DOM.setFileInputFiles', { nodeId, files: files.map(file => path.resolve(file)) });
        return true;
      }
    }
    return false;
  }

  // Upload project files with the + menu's hidden inputs (images/videos to the
  // media input, everything else to the documents input).
  async attach(files = []) {
    this.step = 'references';
    if (!files.length) return 0;
    const before = (await this.state()).attachments;
    const media = files.filter(file => /\.(png|jpe?g|webp|gif|heic|mp4|mov|webm)$/i.test(file));
    const docs = files.filter(file => !media.includes(file));
    await this.menu('tools').catch(() => null);
    try {
      if (media.length && !await this.setInputFiles(value => /image/.test(value), media)) {
        throw new Error('reference_attach_failed: Gemini image upload input not found');
      }
      if (docs.length && !await this.setInputFiles(value => /\.pdf/.test(value) || /\.txt/.test(value), docs)) {
        throw new Error('reference_attach_failed: Gemini file upload input not found');
      }
    } finally { await this.closeMenus(); }
    try {
      await this.wait(async () => (await this.state()).attachments >= before + files.length, 'uploads', 120000, 750);
    } catch {
      throw new Error('reference_attach_failed: Gemini did not show ' + files.length + ' uploaded file(s): ' + files.map(file => path.basename(file)).join(', '));
    }
    return files.length;
  }

  async typePrompt(text) {
    this.step = 'prompt';
    if (!await this.probe('focusPrompt')) throw new Error('selector_failure: Gemini prompt box not found');
    await this.cdp('Input.insertText', { text });
    const want = normalizeName(text).slice(0, 60);
    await this.wait(async () => normalizeName((await this.state()).prompt).includes(want), 'prompt text', 10000);
  }

  async send() {
    this.step = 'send';
    const before = (await this.state()).responses;
    // Send stays disabled while uploads finish.
    await this.wait(async () => (await this.state()).sendEnabled, 'Send button', 120000, 400);
    if (!await this.probe('clickSend')) throw new Error('selector_failure: Gemini Send is unavailable');
    await this.wait(async () => {
      const state = await this.state();
      return state.stop || state.responses > before || !state.prompt;
    }, 'answer start', 30000, 400);
    return before;
  }

  lastResponse() { return this.probe('lastResponse'); }
  startResearch() { return this.probe('clickStartResearch'); }
  clickDownload(index = 0) { return this.probe('clickDownload', { index }); }
  readMedia(src) { return this.exec(probeScript('readMedia', { src }), 180000); }

  async markdown({ immersive = false } = {}) {
    const tree = await this.probe('responseTree', { immersive });
    return tree ? treeToMarkdown(tree) : '';
  }
}

module.exports = {
  GoogleGeminiAdapter, PROBES, probeScript, normalizeName, matchOption, matchTool, describeOptions,
  detectLimit, cooldownSeconds, isRefusal, sniffMedia, treeToMarkdown, TOOL_PATTERNS
};
