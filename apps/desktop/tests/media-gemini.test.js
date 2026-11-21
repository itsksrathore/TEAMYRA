const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  GoogleGeminiAdapter, matchOption, matchTool, detectLimit, cooldownSeconds, isRefusal, sniffMedia, treeToMarkdown, normalizeName
} = require('../src/media/google-gemini-adapter');
const { GeminiJobConsumer, category } = require('../src/media/gemini-job-consumer');
const { geminiChatUrl, safeGeminiUrl } = require('../src/media/google-gemini-provider');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// The mode picker as the signed-out page lists it (label / sublabel).
const MODEL_MENU = [
  { label: 'Auto', sublabel: 'Adapts to your needs', checked: true },
  { label: 'Everyday help', sublabel: '4 Hydrogen' },
  { label: 'Deeper analysis', sublabel: '4 Neon' },
  { label: 'Code & complex work', sublabel: '4 Carbon' },
  { label: 'Sign in', sublabel: 'Get more access' }
];
const TOOLS_MENU = [
  { label: 'Upload files', aria: 'Upload files. Documents, data, code files' },
  { label: 'Add from Drive', aria: 'Add from Drive. Sheets, Docs, Slides' },
  { label: 'Create images', sublabel: 'Nano Banana' },
  { label: 'Create videos', sublabel: 'Veo' },
  { label: 'Deep Research' },
  { label: 'Canvas' },
  { label: 'Guided Learning' }
];

function pureTests() {
  const items = MODEL_MENU.map((item, index) => ({ index, ...item }));
  assert.equal(matchOption(items, 'Auto').label, 'Auto');
  assert.equal(matchOption(items, '4 neon').label, 'Deeper analysis');
  assert.equal(matchOption(items, '4Hydrogen').label, 'Everyday help');
  assert.equal(matchOption(items, 'EVERYDAY  HELP').sublabel, '4 Hydrogen');
  assert.equal(matchOption(items, 'carbon').sublabel, '4 Carbon');
  assert.equal(matchOption(items, '4 Argon'), null, 'a model the page does not list is not guessed');

  const tools = TOOLS_MENU.map((item, index) => ({ index, ...item }));
  assert.equal(matchTool(tools, 'image').label, 'Create images');
  assert.equal(matchTool(tools, 'video').label, 'Create videos');
  assert.equal(matchTool(tools, 'deep_research').label, 'Deep Research');
  assert.equal(matchTool(tools, 'canvas').label, 'Canvas');
  assert.equal(matchTool(tools, 'guided_learning').label, 'Guided Learning');
  assert.equal(matchTool(tools.slice(0, 2), 'image'), null, 'upload entries are never taken for tools');

  assert.ok(detectLimit("You've reached your limit for video generation. Your limit resets tomorrow at 3:00 AM."));
  assert.ok(detectLimit('You have reached your daily limit for Deep Research. Try again in 5 hours.'));
  assert.equal(detectLimit('Here are three colors: red, blue, green.'), null);
  assert.equal(cooldownSeconds('Try again in 5 hours'), 5 * 3600);
  assert.equal(cooldownSeconds('limit resets in 45 minutes'), 45 * 60);
  assert.equal(cooldownSeconds('Your limit resets tomorrow'), 12 * 3600);
  assert.equal(cooldownSeconds('limit reached'), 4 * 3600);
  assert.ok(isRefusal("I can't create images of that person."));
  assert.ok(!isRefusal('Here is your image.'));

  assert.equal(sniffMedia(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0])).ext, 'png');
  assert.equal(sniffMedia(Buffer.from([0xff, 0xd8, 0xff, 0xe0])).ext, 'jpg');
  assert.equal(sniffMedia(Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmp42')])).kind, 'video');
  assert.equal(sniffMedia(Buffer.from('<html>')), null);

  const markdown = treeToMarkdown({ tag: 'div', c: [
    { tag: 'h2', c: [{ t: 'Summary' }] },
    { tag: 'p', c: [{ t: 'Gemini says ' }, { tag: 'b', c: [{ t: 'hello' }] }, { t: ' with a ' }, { tag: 'a', href: 'https://example.com/a', c: [{ t: 'link' }] }] },
    { tag: 'ul', c: [{ tag: 'li', c: [{ tag: 'p', c: [{ t: 'Red' }] }] }, { tag: 'li', c: [{ tag: 'p', c: [{ t: 'Blue' }] },
      { tag: 'ol', c: [{ tag: 'li', c: [{ t: 'Navy' }] }] }] }] },
    { tag: 'pre', c: [{ tag: 'code', lang: 'python', c: [{ t: 'print(1)\n' }] }] },
    { tag: 'table', c: [{ tag: 'tbody', c: [
      { tag: 'tr', c: [{ tag: 'th', c: [{ t: 'A' }] }, { tag: 'th', c: [{ t: 'B' }] }] },
      { tag: 'tr', c: [{ tag: 'td', c: [{ t: '1' }] }, { tag: 'td', c: [{ t: '2' }] }] }] }] }
  ] });
  assert.match(markdown, /^## Summary/);
  assert.match(markdown, /Gemini says \*\*hello\*\* with a \[link\]\(https:\/\/example\.com\/a\)/);
  assert.match(markdown, /- Red\n- Blue\n {2}1\. Navy/);
  assert.match(markdown, /```python\nprint\(1\)\n```/);
  assert.match(markdown, /\| A \| B \|\n\| --- \| --- \|\n\| 1 \| 2 \|/);

  assert.equal(geminiChatUrl('https://gemini.google.com/app/a8ab97f93ed3bd65?hl=en'), 'https://gemini.google.com/app/a8ab97f93ed3bd65');
  assert.equal(geminiChatUrl('https://gemini.google.com/app'), null);
  assert.ok(safeGeminiUrl('https://lh3.googleusercontent.com/x'));
  assert.ok(!safeGeminiUrl('https://evil.example.com/'));
  assert.equal(category('option_unavailable: Gemini model "x" is not offered'), 'option_unavailable');
  assert.equal(category('reference_attach_failed: no upload'), 'reference_attach_failed');
  assert.equal(normalizeName('Code & complex work'), 'codecomplexwork');
}

// A Gemini page model answering the adapter's page probes and DevTools calls.
class FakeGeminiPage {
  constructor({ signedIn = true, tools = TOOLS_MENU } = {}) {
    this.signedIn = signedIn;
    this.models = MODEL_MENU.map(item => ({ ...item, disabled: !signedIn && item.label !== 'Auto' && item.label !== 'Sign in' }));
    this.tools = signedIn ? tools : TOOLS_MENU.slice(0, 2);
    this.menuOpen = null;
    this.mode = 'chat';
    this.prompt = '';
    this.chips = [];
    this.attachments = 0;
    this.inputs = [{ nodeId: 11, accept: '.txt,.pdf,.doc' }, { nodeId: 12, accept: 'image/*,video/*' }];
    this.uploaded = {};
    this.responses = 0;
    this.sent = [];
    this.url = 'https://gemini.google.com/app';
    this.debugger = this.makeDebugger();
  }

  makeDebugger() {
    const page = this;
    let attached = false;
    return {
      isAttached: () => attached,
      attach: () => { attached = true; },
      on: () => {},
      async sendCommand(method, params) {
        if (method === 'Input.insertText') { page.prompt += params.text; return {}; }
        if (method === 'Input.dispatchKeyEvent') { if (params.key === 'Escape') page.menuOpen = null; return {}; }
        if (method === 'DOM.getDocument') return { root: { nodeId: 1 } };
        if (method === 'DOM.querySelectorAll') return { nodeIds: page.menuOpen === 'tools' ? page.inputs.map(item => item.nodeId) : [] };
        if (method === 'DOM.describeNode') return { node: { attributes: ['type', 'file', 'accept', page.inputs.find(item => item.nodeId === params.nodeId).accept] } };
        if (method === 'DOM.setFileInputFiles') {
          page.uploaded[params.nodeId] = params.files;
          page.attachments += params.files.length;
          return {};
        }
        return {};
      }
    };
  }

  get selectedModel() { return this.models.find(item => item.checked); }

  menuList() {
    const list = this.menuOpen === 'model' ? this.models : this.menuOpen === 'tools' ? this.tools : [];
    return list.map((item, index) => ({ index, label: item.label, sublabel: item.sublabel || '', aria: item.aria || '', text: item.label,
      disabled: item.disabled === true, checked: item.checked === true, submenu: false }));
  }

  probe(name, args) {
    switch (name) {
      case 'state': return { url: this.url, signedOut: false, prompt: this.prompt, sendEnabled: Boolean(this.prompt.trim()),
        stop: false, model: this.selectedModel.label, segments: this.signedIn ? [{ text: 'Chat', selected: this.mode === 'chat' },
          { text: 'Task', selected: this.mode === 'task' }] : [], responses: this.responses, attachments: this.attachments, notices: '' };
      case 'openMenu': this.menuOpen = args.menu; return { x: 10, y: 10 };
      case 'menuItems': {
        const list = this.menuList();
        if (!Number.isInteger(args.click)) return list;
        const item = (this.menuOpen === 'model' ? this.models : this.tools)[args.click];
        if (this.menuOpen === 'model') { for (const entry of this.models) entry.checked = entry === item; }
        else this.chips.push(item.label);
        this.menuOpen = null;
        return list[args.click];
      }
      case 'setMode': this.mode = args.mode; return true;
      case 'inputChips': return this.chips.map(label => 'Deselect ' + label);
      case 'focusPrompt': return true;
      case 'clickSend': this.sent.push({ prompt: this.prompt, model: this.selectedModel.label, mode: this.mode, chips: [...this.chips] });
        this.prompt = ''; this.responses += 1; this.url = 'https://gemini.google.com/app/c0ffee1234'; return true;
      default: throw new Error('unexpected probe ' + name);
    }
  }

  async executeJavaScript(script) {
    const match = script.match(/\/\*probe:(\w+)\*\/ ([\s\S]*)\)$/);
    if (!match) throw new Error('not a probe: ' + script.slice(0, 80));
    return this.probe(match[1], JSON.parse(match[2]));
  }
}

async function adapterTests() {
  const page = new FakeGeminiPage();
  const adapter = new GoogleGeminiAdapter(page, { settleMs: 1 });
  assert.equal((await adapter.chooseModel('4 neon')).model, 'Deeper analysis');
  assert.equal(page.selectedModel.sublabel, '4 Neon');
  await assert.rejects(adapter.chooseModel('4 Argon'), error => {
    assert.match(error.message, /^option_unavailable: Gemini model "4 Argon" is not offered/);
    assert.match(error.message, /Everyday help \(4 Hydrogen\)/, 'the error lists what the page offers');
    return true;
  });
  assert.equal(await adapter.chooseMode('task'), 'task');
  assert.equal(page.mode, 'task');
  const tool = await adapter.chooseTool('deep_research');
  assert.deepEqual(tool, { tool: 'Deep Research', confirmed: true });
  await assert.rejects(adapter.chooseTool('podcast_maker'), /option_unavailable: Gemini tool "podcast_maker" is not offered.*Create images/);
  assert.equal(await adapter.chooseTool('none'), null);
  const files = [path.resolve('refs/a.png'), path.resolve('refs/brief.pdf')];
  assert.equal(await adapter.attach(files), 2);
  assert.deepEqual(page.uploaded[12], [files[0]], 'images go to the image/video input');
  assert.deepEqual(page.uploaded[11], [files[1]], 'documents go to the documents input');
  await adapter.typePrompt('Summarize the brief');
  assert.equal(await adapter.send(), 0);
  assert.equal(page.sent[0].prompt, 'Summarize the brief');
  assert.equal(page.sent[0].mode, 'task');

  // Signed out (or an account without tools): fail clearly, nothing sent.
  const bare = new FakeGeminiPage({ signedIn: false });
  const plain = new GoogleGeminiAdapter(bare, { settleMs: 1 });
  await assert.rejects(plain.chooseTool('image'), /option_unavailable: Gemini tool "image" is not offered.*no tools/);
  await assert.rejects(plain.chooseModel('4 Carbon'), /option_unavailable: Gemini model "4 Carbon" is disabled/);
  await assert.rejects(plain.chooseMode('task'), /option_unavailable: Gemini mode "task"/);
  assert.equal(await plain.chooseMode('chat'), 'chat');
  assert.equal(bare.sent.length, 0);
}

function fakeCore(temp, jobs) {
  const records = new Map(jobs.map(job => [job.job_id, { state: 'queued', history: [], ...job }]));
  const registered = [];
  const calls = [];
  const core = async (name, args = {}) => {
    calls.push([name, args]);
    const record = records.get(args.job_id);
    switch (name) {
      case 'media.claim': {
        const next = [...records.values()].find(item => item.state === 'queued');
        if (!next) return null;
        next.state = 'preparing';
        return JSON.parse(JSON.stringify(next));
      }
      case 'media.status': return JSON.parse(JSON.stringify(record));
      case 'media.status-many': return { jobs: Object.fromEntries(args.job_ids.map(id => [id, { cancel_requested: false }])) };
      case 'media.update-state': record.state = args.state; record.detail = args.detail; if (args.extra) Object.assign(record, args.extra); return record;
      case 'media.patch': Object.assign(record, args.patch); return record;
      case 'media.reconcile': record.state = 'generating'; return record;
      case 'media.prepare-output': {
        const ext = record.request.format || { image: 'png', video: 'mp4', text: 'md' }[record.request.type];
        return { path: path.join(temp, args.job_id + '.' + ext), format: ext, staging_dir: path.join(temp, '.staging-' + args.job_id) };
      }
      case 'media.register-asset': record.state = 'completed'; registered.push(args); return { asset_id: 'TYR-X-' + registered.length };
      case 'media.gemini-limit': record.state = 'rate_limited'; record.limit = args; return {};
      default: return {};
    }
  };
  return { core, records, registered, calls };
}

// A scripted adapter: what the page shows after the prompt is sent.
function scriptedAdapter(answer, extra = {}) {
  const log = [];
  return {
    log,
    step: 'idle',
    ready: async () => ({}),
    chooseThinking: async level => { log.push(['thinking', level]); return level; },
    chooseModel: async model => { log.push(['model', model]); if (/argon/i.test(model)) throw new Error('option_unavailable: Gemini model "' + model + '" is not offered in this account; it offers: Auto'); return { model, description: 'x' }; },
    chooseMode: async mode => { log.push(['mode', mode]); return mode; },
    chooseTool: async tool => { log.push(['tool', tool]); return tool === 'none' ? null : { tool, confirmed: true }; },
    attach: async files => { log.push(['attach', files]); return files.length; },
    typePrompt: async text => { log.push(['prompt', text]); },
    send: async () => { log.push(['send']); return 0; },
    wait: async read => read(),
    state: async () => ({ notices: extra.notices || '' }),
    lastResponse: async () => answer,
    startResearch: async () => { log.push(['start research']); answer.startResearch = false; return true; },
    clickDownload: async () => false,
    markdown: async ({ immersive }) => immersive ? (extra.document || '') : (extra.markdown || ''),
    readMedia: async src => extra.readMedia(src)
  };
}

function consumerFor(core, adapter, temp, options = {}) {
  const provider = { view: { webContents: { getURL: () => 'https://gemini.google.com/app/c0ffee1234', id: 7 } },
    loads: [], async load(url) { this.loads.push(url); return url; }, ensureView() {} };
  const consumer = new GeminiJobConsumer({ workerName: 'gemini-test', provider, profileId: 'acct-2', core, pollMs: 5, settleMs: 0,
    verify: async () => ({ decoded: true, width: 1024, height: 1024 }), ...options });
  consumer.adapter = async () => adapter;
  return { consumer, provider };
}

async function consumerTests(temp) {
  // Plain answer saved as a Markdown document asset.
  {
    const job = { job_id: 'g1', request: { type: 'text', prompt: 'Explain tides', gemini_model: '4 Neon', gemini_mode: 'chat', gemini_tool: 'none', format: 'md', generation_settings: {} },
      resolved_references: [{ path: 'C:/p/brief.pdf' }] };
    const { core, records, registered } = fakeCore(temp, [job]);
    const adapter = scriptedAdapter({ count: 1, done: true, text: 'Tides are...', media: [], links: ['https://docs.google.com/document/d/1'] },
      { markdown: '## Tides\n\nThe moon pulls the sea.\n' });
    const { consumer } = consumerFor(core, adapter, temp);
    await consumer.run((await core('media.claim')));
    assert.equal(records.get('g1').state, 'completed', records.get('g1').detail);
    const saved = fs.readFileSync(path.join(temp, 'g1.md'), 'utf8');
    assert.match(saved, /The moon pulls the sea/);
    assert.match(saved, /Google Gemini · 4 Neon · chat/);
    assert.equal(registered[0].provider, 'google-gemini');
    assert.equal(registered[0].metadata.gemini_model, '4 Neon');
    assert.deepEqual(registered[0].metadata.doc_links, ['https://docs.google.com/document/d/1']);
    assert.deepEqual(adapter.log.find(entry => entry[0] === 'attach')[1], ['C:/p/brief.pdf']);
    assert.equal(records.get('g1').provider_submission.provider_url, 'https://gemini.google.com/app/c0ffee1234');
    assert.equal(records.get('g1').provider_submission.profile_id, 'acct-2');
  }
  // Generated image: read inside the page, checked to be an image, registered.
  {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(4096, 1)]);
    const job = { job_id: 'g2', request: { type: 'image', prompt: 'A red fox', gemini_model: 'Auto', gemini_tool: 'image', format: 'png', aspect_ratio: '16:9', generation_settings: {} } };
    const { core, records, registered } = fakeCore(temp, [job]);
    const adapter = scriptedAdapter({ count: 1, done: true, text: 'Here is your fox', media: [{ kind: 'image', src: 'blob:https://gemini.google.com/1' }], downloads: 0 },
      { readMedia: async () => ({ ok: true, base64: png.toString('base64') }) });
    const { consumer } = consumerFor(core, adapter, temp);
    await consumer.run((await core('media.claim')));
    assert.equal(records.get('g2').state, 'completed', records.get('g2').detail);
    assert.ok(fs.readFileSync(path.join(temp, 'g2.png')).equals(png));
    assert.equal(registered[0].metadata.downloaded_via, 'page_fetch');
    assert.match(adapter.log.find(entry => entry[0] === 'prompt')[1], /Aspect ratio: 16:9/);
  }
  // A video answer that is not a video file fails as a download failure.
  {
    const job = { job_id: 'g3', request: { type: 'video', prompt: 'A wave', gemini_tool: 'video', generation_settings: {} } };
    const { core, records } = fakeCore(temp, [job]);
    const adapter = scriptedAdapter({ count: 1, done: true, text: '', media: [{ kind: 'video', src: 'https://contribution.usercontent.google.com/v' }] });
    const { consumer } = consumerFor(core, adapter, temp, { fetchUrl: async () => ({ ok: true, arrayBuffer: async () => Buffer.from('<html>login</html>') }) });
    await consumer.run((await core('media.claim')));
    assert.equal(records.get('g3').state, 'failed');
    assert.equal(records.get('g3').failure.category, 'download_failure');
  }
  // An image request answered with a refusal and no image.
  {
    const job = { job_id: 'g4', request: { type: 'image', prompt: 'x', gemini_tool: 'image', generation_settings: {} } };
    const { core, records } = fakeCore(temp, [job]);
    const adapter = scriptedAdapter({ count: 1, done: true, text: "I can't create images of real people like that.", media: [] });
    const { consumer } = consumerFor(core, adapter, temp);
    consumer.settleMs = 0;
    await consumer.run((await core('media.claim')));
    assert.equal(records.get('g4').failure.category, 'policy_refusal');
  }
  // Usage limit: the account rests and the job goes back for another account.
  {
    const job = { job_id: 'g5', request: { type: 'video', prompt: 'A wave', gemini_tool: 'video', generation_settings: {} } };
    const { core, records, registered } = fakeCore(temp, [job]);
    const adapter = scriptedAdapter({ count: 1, done: true, text: "You've reached your limit for video generation. Try again in 3 hours.", media: [] });
    const { consumer } = consumerFor(core, adapter, temp);
    await consumer.run((await core('media.claim')));
    assert.equal(records.get('g5').state, 'rate_limited');
    assert.equal(records.get('g5').limit.profile_id, 'acct-2');
    assert.equal(records.get('g5').limit.scope, 'video');
    assert.equal(records.get('g5').limit.seconds, 3 * 3600);
    assert.equal(registered.length, 0);
  }
  // A missing option fails clearly before anything is sent.
  {
    const job = { job_id: 'g6', request: { type: 'text', prompt: 'x', gemini_model: '4 Argon', gemini_tool: 'none', generation_settings: {} } };
    const { core, records } = fakeCore(temp, [job]);
    const adapter = scriptedAdapter({ count: 0 });
    const { consumer } = consumerFor(core, adapter, temp);
    await consumer.run((await core('media.claim')));
    assert.equal(records.get('g6').failure.category, 'option_unavailable');
    assert.ok(!adapter.log.some(entry => entry[0] === 'send'));
  }
  // Deep Research: the plan is started, then the report panel is saved.
  {
    const job = { job_id: 'g7', request: { type: 'text', prompt: 'Research tides', gemini_tool: 'deep_research', generation_settings: {} } };
    const { core, records } = fakeCore(temp, [job]);
    const answer = { count: 1, done: true, text: 'Here is the plan', media: [], startResearch: true, immersive: false };
    const adapter = scriptedAdapter(answer, { document: '# Tides report\n\nLong findings.\n', markdown: 'I have completed the research.\n' });
    const original = adapter.startResearch;
    adapter.startResearch = async () => { const value = await original(); setTimeout(() => { answer.immersive = true; }, 20); return value; };
    const { consumer } = consumerFor(core, adapter, temp);
    await consumer.run((await core('media.claim')));
    assert.equal(records.get('g7').state, 'completed', records.get('g7').detail);
    assert.ok(adapter.log.some(entry => entry[0] === 'start research'));
    const saved = fs.readFileSync(path.join(temp, 'g7.md'), 'utf8');
    assert.match(saved, /# Tides report[\s\S]*Long findings[\s\S]*I have completed the research/);
  }
  // Sent before a restart: the same chat is reopened, nothing is sent again.
  {
    const job = { job_id: 'g8', request: { type: 'text', prompt: 'x', gemini_tool: 'none', generation_settings: {} },
      provider_submission: { submitted_at: 1, provider_url: 'https://gemini.google.com/app/abc123def', profile_id: 'acct-2' } };
    const { core, records } = fakeCore(temp, [job]);
    const adapter = scriptedAdapter({ count: 1, done: true, text: 'Answer', media: [] }, { markdown: 'Answer\n' });
    const { consumer, provider } = consumerFor(core, adapter, temp);
    await consumer.run((await core('media.claim')));
    assert.deepEqual(provider.loads, ['https://gemini.google.com/app/abc123def']);
    assert.ok(!adapter.log.some(entry => entry[0] === 'send'));
    assert.equal(records.get('g8').state, 'completed');
  }
  // The tab claims only through mayClaim (a signed-out account resumes only).
  {
    const { core, calls } = fakeCore(temp, []);
    const { consumer } = consumerFor(core, scriptedAdapter({}), temp, { mayClaim: () => false });
    consumer.running = true;
    await consumer.tick();
    consumer.stop();
    const claim = calls.find(entry => entry[0] === 'media.claim')[1];
    assert.equal(claim.surface, 'gemini');
    assert.equal(claim.resume_only, true);
    assert.equal(claim.profile_id, 'acct-2');
  }
}

(async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'teamyra-gemini-'));
  try {
    pureTests();
    await adapterTests();
    await consumerTests(temp);
    await sleep(5);
    console.log('google gemini adapter, options and job consumer tests passed');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exit(1); });
