// One human-check (captcha) detector for every web-chat site.
//
// challengeScript(promptSelector) gives a page-script expression that is ''
// when the page shows no human check, or the kind of check it shows
// ('cloudflare', 'recaptcha', 'hcaptcha', 'arkose', 'geetest', 'aliyun',
// 'aws-waf', 'tencent', 'datadome', 'perimeterx', 'captcha', 'text').
// A job that meets one pauses as `needs_user` (attention
// `<site>_verification`), the Tasks view shows "Captcha required" and plays
// the captcha sound; the user solves it in TEAMYRA and the job continues.
// Nothing here tries to solve or avoid a check.
//
// To keep a chat that merely talks about captchas from counting:
// - widgets count only when shown (size, display, visibility, opacity);
// - wording counts only inside dialogs and overlays, or on a page that has
//   no message box (a full-page check).

const WIDGETS = [
  // [kind, selector]
  ['cloudflare', 'iframe[src*="challenges.cloudflare.com"], #challenge-form, #challenge-stage, [id^="cf-chl"], .cf-turnstile, #turnstile-wrapper'],
  ['recaptcha', 'iframe[src*="google.com/recaptcha"], iframe[src*="recaptcha.net"], iframe[title*="reCAPTCHA"], .g-recaptcha'],
  ['hcaptcha', 'iframe[src*="hcaptcha.com"], .h-captcha'],
  ['arkose', 'iframe[src*="arkoselabs"], iframe[src*="funcaptcha"], #FunCaptcha, [data-e2e="enforcement-frame"]'],
  ['geetest', '.geetest_panel, .geetest_box, .geetest_holder, iframe[src*="geetest"]'],
  ['aliyun', '#aliyunCaptcha-window-popup.window-show, #aliyunCaptcha-mask.mask-show, #aliyunCaptcha-window-embed, #nc_1_wrapper, .nc-container, .baxia-dialog, #baxia-dialog-content, iframe[src*="punish"]'],
  ['aws-waf', '#captcha-container, .amzn-captcha-modal, iframe[src*="awswaf"], iframe[src*="captcha.awswaf"]'],
  ['tencent', '#tcaptcha_transform, #tCaptchaDyMainWrap, iframe[src*="captcha.qq.com"], iframe[src*="turing.captcha"]'],
  ['datadome', 'iframe[src*="captcha-delivery.com"], iframe[src*="geo.captcha-delivery"]'],
  ['perimeterx', '#px-captcha, iframe[src*="px-cloud"], iframe[src*="perimeterx"]'],
  ['captcha', 'iframe[src*="captcha" i], iframe[title*="captcha" i], [id*="captcha" i], [class*="captcha" i]']
];

const PHRASES = [
  'verify you are human', 'verify you are a human', 'are you a robot', "i'm not a robot", 'i am not a robot',
  'checking your browser', 'checking if the site connection is secure', 'complete the security check',
  'confirm you are human', 'human verification', 'press and hold', 'drag the slider', 'slide to verify',
  'slide to complete', 'complete the puzzle', 'please complete the verification', 'select all images',
  'unusual traffic', 'security verification', 'verify that you are not a robot',
  '安全验证', '人机验证', '滑动验证', '拖动滑块',
  '请完成验证', '请完成安全验证'
];

const TITLES = ['just a moment', 'attention required', 'verify you are human', 'security check', 'captcha'];

function challengeScript(promptSelector = '') {
  return `(() => {
  try {
    const shown = node => {
      const rect = node.getBoundingClientRect();
      if (rect.width < 40 || rect.height < 20) return false;
      // Some sites keep a ready-made check off screen; only one in view counts.
      if (rect.bottom <= 0 || rect.right <= 0 || rect.top >= innerHeight || rect.left >= innerWidth) return false;
      const style = getComputedStyle(node);
      return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0.05;
    };
    const widgets = ${JSON.stringify(WIDGETS)};
    for (const [kind, selector] of widgets) {
      let nodes = [];
      try { nodes = [...document.querySelectorAll(selector)]; } catch (error) { continue; }
      if (nodes.some(shown)) return kind;
    }
    const phrases = ${JSON.stringify(PHRASES)};
    const says = text => { const value = String(text || '').toLowerCase(); return phrases.some(phrase => value.includes(phrase)); };
    const title = String(document.title || '').toLowerCase();
    if (${JSON.stringify(TITLES)}.some(item => title.startsWith(item))) return 'text';
    const overlays = [...document.querySelectorAll('[role=dialog], [role=alertdialog], dialog[open], [aria-modal="true"], [class*="modal" i], [class*="overlay" i], [class*="mask" i]')]
      .filter(shown);
    if (overlays.some(node => says((node.innerText || '').slice(0, 3000)))) return 'text';
    const prompt = ${JSON.stringify(promptSelector)} ? document.querySelector(${JSON.stringify(promptSelector)}) : null;
    if (!prompt && says((document.body ? document.body.innerText : '').slice(0, 6000))) return 'text';
    return '';
  } catch (error) {
    return '';
  }
})()`;
}

module.exports = { challengeScript, WIDGETS, PHRASES };
