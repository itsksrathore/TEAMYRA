// Usage-limit notices on the web-chat sites (ChatGPT, Muse, DeepSeek, Qwen,
// Grok, GLM). A site that hit its message limit shows a short notice (a
// toast, a banner over the message box, a dialog, or a short reply in the
// chat) and then answers nothing. TEAMYRA asks for this notice only while a
// reply is overdue, or for a reply that came back short, and then hands the
// job to another account or model (bridge/job_transfer.py).
//
// The notice has to be short: a real reply that talks about limits is long
// text inside the conversation and does not count.

const LIMIT_PATTERNS = [
  /you(?:'|’)?ve (?:hit|reached|used up|exceeded) (?:your|the|our)\b[^.\n]{0,60}\blimit/i,
  /\b(?:usage|message|messages|rate|daily|hourly|free[- ]plan|plan|chat|request|conversation) (?:limit|cap)\b[^.\n]{0,60}\b(?:reached|exceeded|hit|resets?|reset)\b/i,
  /\breached (?:the|your|our) (?:current |daily |free |message |usage )*(?:limit|cap)\b/i,
  /\blimit (?:resets|will reset|reset at|reset in)\b/i,
  /\btoo many (?:requests|messages)\b/i,
  /\bout of (?:free )?(?:messages|queries|credits)\b/i,
  /\brate[- ]limit(?:ed)?\b/i,
  /\bupgrade (?:to|for) (?:continue|keep chatting|more messages)\b/i,
  /(?:已达|达到|超出|超过)(?:今日|当日|每日|本日|使用|对话|消息|次数|的){0,3}(?:上限|限制|限额)/,
  /(?:次数|额度|配额)(?:已)?(?:用完|用尽|耗尽)/,
  /请求(?:过于|太)频繁/,
  /\b(?:free|daily|hourly|usage|message|messages|plan|tier|quota|query|queries)\b[\w -]{0,24}\b(?:limit|quota|cap) (?:reached|exceeded|hit)\b/i
];
const MAX_NOTICE_CHARS = 400;

// Wording that only a site's own limit message uses. A reply of the model
// itself may well say "rate limit" or "too many requests" about the project.
const REPLY_PATTERNS = [0, 2, 3, 5, 8, 9, 11].map(index => LIMIT_PATTERNS[index]);

function matchShort(text, patterns) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (!value || value.length > MAX_NOTICE_CHARS) return '';
  return patterns.some(pattern => pattern.test(value)) ? value : '';
}

// The limit wording in a notice (short text only), or ''.
function limitNotice(text) {
  return matchShort(text, LIMIT_PATTERNS);
}

// A whole reply that is the site's limit message instead of an answer, or ''.
function replyLimitNotice(text) {
  if (/TEAMYRA_TOOL_REQUEST/.test(String(text || ''))) return '';
  return matchShort(text, REPLY_PATTERNS);
}

// Page script: the first short, visible limit notice, or ''. It looks in
// alerts, toasts, banners and dialogs with every limit wording, then in any
// short block of the page with the site-only wording (REPLY_PATTERNS): Grok
// shows "Free tier limit reached" as a card in the chat, which is none of
// those elements. Text the model wrote (Markdown, code) and the user's own
// messages are skipped.
function limitScript() {
  const sources = LIMIT_PATTERNS.map(pattern => [pattern.source, pattern.flags]);
  const strictSources = REPLY_PATTERNS.map(pattern => [pattern.source, pattern.flags]);
  return `(() => {
    const patterns = ${JSON.stringify(sources)}.map(([source, flags]) => new RegExp(source, flags));
    const strict = ${JSON.stringify(strictSources)}.map(([source, flags]) => new RegExp(source, flags));
    const selector = [
      '[role=alert]', '[role=status]', '[role=alertdialog]', '[role=dialog]', '[aria-live]',
      '[class*=toast]', '[class*=Toast]', '[class*=banner]', '[class*=Banner]', '[class*=notice]',
      '[class*=limit]', '[class*=Limit]', '[data-testid*=limit]', '[class*=error]', '[class*=Error]',
      '[class*=message-box]', '[class*=notification]'
    ].join(',');
    const shown = el => {
      const rect = el.getBoundingClientRect();
      if (rect.width < 20 || rect.height < 10) return false;
      if (rect.bottom < 0 || rect.top > innerHeight) return false;
      const style = getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0.05;
    };
    for (const el of document.querySelectorAll(selector)) {
      const text = String(el.innerText || '').replace(/\\s+/g, ' ').trim();
      if (!text || text.length > ${MAX_NOTICE_CHARS} || !shown(el)) continue;
      if (patterns.some(pattern => pattern.test(text))) return text;
    }
    const skip = 'pre, code, .markdown, [class*=markdown], .prose, [class*=prose], [data-message-author-role="user"], ' +
      '[data-testid="user-message"], [class*=user-message], [class*=message-user], [contenteditable], textarea, input';
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let visited = 0;
    for (let node = walker.nextNode(); node && visited < 30000; node = walker.nextNode(), visited += 1) {
      const raw = node.nodeValue || '';
      if (raw.length < 6 || !/limit|quota|上限|限制|限额|用完|用尽|耗尽/i.test(raw)) continue;
      let el = node.parentElement;
      if (!el || el.closest(skip)) continue;
      // Grow to the notice block (title plus its one-line explanation).
      for (let up = 0; up < 3 && el.parentElement && String(el.parentElement.innerText || '').length <= ${MAX_NOTICE_CHARS}; up += 1) {
        el = el.parentElement;
      }
      const text = String(el.innerText || '').replace(/\\s+/g, ' ').trim();
      if (!text || text.length > ${MAX_NOTICE_CHARS} || !shown(el)) continue;
      if (strict.some(pattern => pattern.test(text))) return text;
    }
    return '';
  })()`;
}

module.exports = { limitNotice, replyLimitNotice, limitScript, LIMIT_PATTERNS };
