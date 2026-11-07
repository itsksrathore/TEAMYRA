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
  /请求(?:过于|太)频繁/
];
const MAX_NOTICE_CHARS = 400;

// Wording that only a site's own limit message uses. A reply of the model
// itself may well say "rate limit" or "too many requests" about the project.
const REPLY_PATTERNS = [0, 2, 3, 5, 8, 9].map(index => LIMIT_PATTERNS[index]);

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

// Page script: the first short, visible notice outside the conversation
// (alerts, toasts, banners, dialogs) whose wording is a limit, or ''.
function limitScript() {
  const sources = LIMIT_PATTERNS.map(pattern => [pattern.source, pattern.flags]);
  return `(() => {
    const patterns = ${JSON.stringify(sources)}.map(([source, flags]) => new RegExp(source, flags));
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
    return '';
  })()`;
}

module.exports = { limitNotice, replyLimitNotice, limitScript, LIMIT_PATTERNS };
