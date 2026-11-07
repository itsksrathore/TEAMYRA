const assert = require('node:assert/strict');
const vm = require('node:vm');
const { challengeScript } = require('../src/challenge-detect');

// Runs the page script against a small fake page.
// widgets: { selectorFragment: { rect, style } }, overlays: [{ text, rect }],
// body: page text, prompt: whether the message box exists.
function detect({ widgets = {}, overlays = [], body = '', title = '', prompt = true }) {
  const node = ({ rect = { width: 300, height: 200, top: 100, left: 100, bottom: 300, right: 400 }, style = {}, text = '' } = {}) => ({
    getBoundingClientRect: () => rect, style, innerText: text
  });
  const document = {
    title,
    body: { innerText: body },
    querySelector: selector => (prompt && selector === 'textarea.box' ? {} : null),
    querySelectorAll: selector => {
      if (selector.includes('[role=dialog]')) return overlays.map(node);
      return Object.entries(widgets).filter(([fragment]) => selector.includes(fragment)).map(([, spec]) => node(spec));
    }
  };
  const context = {
    document, innerWidth: 1280, innerHeight: 800,
    getComputedStyle: el => ({ display: 'block', visibility: 'visible', opacity: '1', ...el.style })
  };
  return vm.runInNewContext(challengeScript('textarea.box'), context);
}

assert.equal(detect({}), '', 'a normal chat page');
assert.equal(detect({ widgets: { 'aliyunCaptcha-window-popup': {} } }), 'aliyun');
assert.equal(detect({ widgets: { 'challenges.cloudflare.com': {} } }), 'cloudflare');
assert.equal(detect({ widgets: { 'hcaptcha.com': {} } }), 'hcaptcha');
assert.equal(detect({ widgets: { 'google.com/recaptcha': {} } }), 'recaptcha');
assert.equal(detect({ widgets: { '#px-captcha': {} } }), 'perimeterx');
assert.equal(detect({ widgets: { 'geetest_panel': {} } }), 'geetest');
assert.equal(detect({ widgets: { '#captcha-container': {} } }), 'aws-waf');
// Hidden, tiny or off-screen widgets do not count.
assert.equal(detect({ widgets: { 'aliyunCaptcha-window-popup': { style: { display: 'none' } } } }), '');
assert.equal(detect({ widgets: { 'challenges.cloudflare.com': { rect: { width: 0, height: 0, top: 0, left: 0, bottom: 0, right: 0 } } } }), '');
assert.equal(detect({ widgets: { 'challenges.cloudflare.com': { rect: { width: 300, height: 80, top: -2000, left: 0, bottom: -1920, right: 300 } } } }), '');
// Wording: in a dialog it counts, in the chat itself it does not.
assert.equal(detect({ overlays: [{ text: 'Please drag the slider to complete the puzzle' }] }), 'text');
assert.equal(detect({ overlays: [{ text: '请完成安全验证' }] }), 'text');
assert.equal(detect({ body: 'Here is how a captcha works: verify you are human by pressing...', prompt: true }), '');
// A full-page check (no message box) counts by its wording or title.
assert.equal(detect({ body: 'Checking your browser before accessing the site', prompt: false }), 'text');
assert.equal(detect({ title: 'Just a moment...', prompt: false }), 'text');

console.log('captcha detector tests passed');
