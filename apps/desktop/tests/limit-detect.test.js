const assert = require('node:assert/strict');
const vm = require('node:vm');
const { limitNotice, replyLimitNotice, limitScript } = require('../src/limit-detect');

// Site notices.
for (const text of [
  "You've hit your limit. Please try again later.",
  "You've reached your message limit. Your limit resets at 5:00 PM.",
  'You have reached the daily usage limit. Upgrade to continue.',
  'Too many requests, please try again in 5 minutes.',
  'Rate limit exceeded',
  '您今日的对话次数已用完',
  '已达到今日使用上限',
  '请求过于频繁，请稍后再试'
]) assert.ok(limitNotice(text), text);
for (const text of ['Here is the plan.', 'The build passed.', 'x'.repeat(500) + " You've hit your limit"]) {
  assert.equal(limitNotice(text), '', text);
}

// Replies: only a site's own limit wording, never a model reply about the
// project, never a tool request.
assert.ok(replyLimitNotice("You've hit your limit. Please try again later."));
assert.ok(replyLimitNotice('You have reached the current usage cap for this model. Your limit resets in 3 hours.'));
assert.equal(replyLimitNotice('Done. The API client is rate-limited, so I added a retry.'), '');
assert.equal(replyLimitNotice('Fixed the "Too many requests" error handler.'), '');
assert.equal(replyLimitNotice('TEAMYRA_TOOL_REQUEST {"tool":"filesystem.read","args":{"path":"limit resets"}}'), '');

// The page script finds a visible short notice and ignores hidden ones.
// nodes: elements the notice selectors find. blocks: other page blocks, found
// by the text scan: { text, inside } where `inside` is the selector the block
// sits in (e.g. '.markdown' for model-written text).
function runScript(nodes, blocks = []) {
  const element = ({ text, hidden, inside }) => ({
    innerText: text,
    parentElement: null,
    closest: selector => (inside && selector.split(',').map(part => part.trim()).includes(inside) ? {} : null),
    getBoundingClientRect: () => ({ width: 300, height: 40, top: 100, bottom: 140 }),
    style: hidden ? { display: 'none' } : {}
  });
  const textNodes = blocks.map(block => ({ nodeValue: block.text, parentElement: element(block) }));
  const document = {
    body: {},
    querySelectorAll: () => nodes.map(element),
    createTreeWalker: () => {
      let index = -1;
      return { nextNode: () => textNodes[++index] || null };
    }
  };
  return vm.runInNewContext(limitScript(), {
    document, innerHeight: 800, NodeFilter: { SHOW_TEXT: 4 },
    getComputedStyle: el => ({ display: 'block', visibility: 'visible', opacity: '1', ...el.style })
  });
}

// Grok, 2026-11-07: "Free tier limit reached" as a card in the chat, outside
// any alert or banner element.
assert.equal(runScript([], [{ text: 'Free tier limit reached Try again later or upgrade for much higher limits.' }]),
  'Free tier limit reached Try again later or upgrade for much higher limits.');
// The same words in text the model wrote, or in the user's message, do not count.
assert.equal(runScript([], [{ text: "You've hit your limit for this test fixture.", inside: '.markdown' }]), '');
assert.equal(runScript([], [{ text: 'Free tier limit reached', inside: '[data-testid="user-message"]' }]), '');
// Loose wording ("rate limit") only counts in alert/banner elements, not in a page block.
assert.equal(runScript([], [{ text: 'Rate limit exceeded' }]), '');
assert.equal(runScript([{ text: 'Saved' }, { text: "You've hit your limit for GPT-5. Try again later." }]),
  "You've hit your limit for GPT-5. Try again later.");
assert.equal(runScript([{ text: "You've hit your limit.", hidden: true }]), '');
assert.equal(runScript([]), '');

console.log('usage-limit detector tests passed');
