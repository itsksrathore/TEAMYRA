const assert = require('node:assert/strict');
const vm = require('node:vm');
const { GoogleFlowAutomationAdapter } = require('../src/media/google-flow-automation-adapter');

async function main() {
  // Flow's closing overlay can swallow attempts to reopen it. Exercise the
  // real selection scripts against a popover that cannot reopen after Escape.
  let open = false;
  let closing = false;
  let closes = 0;
  const radios = [];
  function radio(text, group, selected = false) {
    const attrs = { 'aria-checked': String(selected) };
    const item = {
      innerText: text, textContent: text, group,
      getBoundingClientRect: () => ({ width: open ? 100 : 0, height: open ? 30 : 0 }),
      getAttribute: name => attrs[name] || '',
      setAttribute: (name, value) => { attrs[name] = value; },
      click: () => {
        for (const other of radios.filter(r => r.group === group)) other.setAttribute('aria-checked', 'false');
        attrs['aria-checked'] = 'true';
      }
    };
    radios.push(item);
    return item;
  }
  radio('Image', 'mode', true); radio('Video', 'mode');
  radio('Frames', 'references', true); radio('Ingredients', 'references');
  radio('360p', 'resolution', true); radio('720p', 'resolution');
  radio('9:16', 'aspect', true); radio('16:9', 'aspect');
  radio('x4', 'count', true); radio('x1', 'count');
  radio('4s', 'duration', true); radio('8s', 'duration');
  const trigger = { focus() {}, click() { if (!closing) open = !open; } };
  const document = {
    querySelectorAll: selector => selector === '[role="radio"]' ? radios : [],
    querySelector: selector => selector === '#trigger' ? trigger :
      selector.includes('Select model family') ? { innerText: 'Omni 1.1 Flash' } :
      radios.find(r => selector.includes(r.getAttribute('data-teamyra-setting-radio')) && r.getAttribute('data-teamyra-setting-radio'))
  };
  const adapter = new GoogleFlowAutomationAdapter({ executeJavaScript: async script =>
    vm.runInNewContext(script, { document, getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }) }) });
  adapter.settingsTriggerSelector = async () => '#trigger';
  adapter.waitForSettingsTrigger = async () => '#trigger';
  adapter.settingsTriggerText = async () => 'Video 720p 8s 16:9 x1';
  adapter.browser.pressKeySelector = async (_selector, key) => {
    assert.equal(key, 'Escape'); open = false; closing = true; closes++; return true;
  };
  const selected = await adapter.selectIntent({ type: 'video', aspect_ratio: '16:9', duration: 8, output_count: 1 });
  assert.equal(selected.actual_model, 'Omni 1.1 Flash');
  for (const text of ['Video', 'Ingredients', '720p', '16:9', 'x1', '8s']) {
    assert.equal(radios.find(r => r.innerText === text).getAttribute('aria-checked'), 'true', text);
  }
  assert.equal(closes, 1, 'close only after every setting has been selected and verified');
  console.log('Flow video settings survive overlay teardown regression test passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
