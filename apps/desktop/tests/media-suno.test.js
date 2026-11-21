const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const {
  SunoAdapter, matchOption, normalizeName, detectLimit, cooldownSeconds, isRefusal, extractClips, clipSummary, isDone, isFailed,
  manifestFor, findField, findSwitch, findSlider, findChoice, modelButton, probeScript
} = require('../src/media/suno-adapter');
const { SunoJobConsumer, category } = require('../src/media/suno-job-consumer');
const { SunoDownloads, safeSunoUrl, partitionForSuno, songUrl, sunoProfiles } = require('../src/media/suno-provider');
const { sniffAudio, parseFfmpegReport, findWhisper } = require('../src/media/suno-audio');
const { SunoEngine } = require('../src/media/suno-engine');

const CLIP_A = '4eed94d1-9d36-4a8b-aa74-71250bbb8b0f';
const CLIP_B = 'c1a16429-f3fe-4d99-bdcf-61ee13ed6f00';
const OLD_CLIP = '9f5adfa3-865d-482f-9ce6-38f5cc05a8ae';

// A clip object shaped like the one suno.com embeds in /song/<id> (Nov 2026).
function clipJson(id, extra = {}) {
  return {
    id, entity_type: 'song_schema', title: 'Monsoon', status: 'complete',
    video_url: 'https://cdn1.suno.ai/' + id + '.mp4', audio_url: 'https://studio-api.prod.suno.com/api/forbidden',
    media_urls: [{ url: 'https://d2lwuy8qc234o3.cloudfront.net/1/clip/' + id + '.m4a', content_type: 'm4a-opus', delivery: 'progressive', encoding: '1.0.0' }],
    image_large_url: 'https://cdn2.suno.ai/x.jpeg', major_model_version: 'v4.5', model_name: 'chirp-auk',
    metadata: { tags: 'indie pop, female vocals', prompt: '[Verse]\nRain on the roof', type: 'gen', duration: 182.4, make_instrumental: false,
      control_sliders: { style_weight: 0.5 } },
    display_tags: 'indie pop', ...extra
  };
}

const FFMPEG_REPORT = `Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'x.m4a':
  Duration: 00:03:02.40, start: 0.000000, bitrate: 131 kb/s
  Stream #0:0[0x1](und): Audio: opus (Opus / 0x7375704F), 48000 Hz, stereo, fltp, 128 kb/s (default)
[silencedetect @ 000] silence_start: 0
[silencedetect @ 000] silence_end: 3.5 | silence_duration: 3.5
[silencedetect @ 000] silence_start: 90.2
[silencedetect @ 000] silence_end: 95.4 | silence_duration: 5.2
size=N/A time=00:03:02.40 bitrate=N/A speed= 300x
[Parsed_volumedetect_0 @ 000] mean_volume: -14.2 dB
[Parsed_volumedetect_0 @ 000] max_volume: -0.4 dB`;

function pureTests() {
  const models = [{ index: 0, label: 'v5', text: 'v5 Authentic vocals' }, { index: 1, label: 'v4.5+', text: 'v4.5+ Advanced creation' },
    { index: 2, label: 'v4.5', text: 'v4.5 Intelligent prompts' }, { index: 3, label: 'v6', text: 'v6 Pro', disabled: true }];
  assert.equal(matchOption(models, 'v4.5').label, 'v4.5', 'exact label wins over v4.5+');
  assert.equal(matchOption(models, 'V4.5+').label, 'v4.5+');
  assert.equal(matchOption(models, ' v5 ').label, 'v5');
  assert.equal(matchOption(models, 'v3.5'), null, 'a model the page does not list is not guessed');
  assert.equal(normalizeName('Style Influence'), 'styleinfluence');

  assert.equal(detectLimit("You're out of credits. Upgrade to get more credits.").scope, 'generate');
  assert.equal(detectLimit('Not enough credits to create this song').scope, 'generate');
  assert.equal(detectLimit("You've reached your monthly download limit").scope, 'download');
  assert.equal(detectLimit('Rate limit exceeded. Please wait before retrying actions.', 'download').scope, 'download');
  assert.equal(detectLimit('Rate limit exceeded.', 'generate').scope, 'generate');
  assert.equal(detectLimit('Your song is ready'), null);
  assert.equal(cooldownSeconds('Try again in 2 hours'), 2 * 3600);
  assert.equal(cooldownSeconds('Rate limit exceeded'), 15 * 60);
  assert.equal(cooldownSeconds('Credits reset tomorrow'), 12 * 3600);
  assert.equal(cooldownSeconds('monthly download limit'), 3 * 86400);
  assert.ok(isRefusal("Couldn't generate that."));
  assert.ok(isRefusal('Your excluded styles contain artist name X - we don\'t reference specific artists'));
  assert.ok(!isRefusal('Monsoon by you'));

  const found = extractClips({ clips: [clipJson(CLIP_A), { id: 'x', status: 'complete' }], user: { id: CLIP_B } });
  assert.deepEqual(found.map(item => item.id), [CLIP_A], 'only clip-shaped objects with a uuid');
  const summary = clipSummary(clipJson(CLIP_A));
  assert.equal(summary.clip_id, CLIP_A);
  assert.equal(summary.duration, 182.4);
  assert.equal(summary.lyrics, '[Verse]\nRain on the roof');
  assert.equal(summary.style, 'indie pop, female vocals');
  assert.equal(summary.model, 'v4.5');
  assert.equal(summary.audio_url, null, 'the forbidden placeholder is not a playable URL');
  assert.ok(isDone(summary));
  assert.ok(isFailed(clipSummary(clipJson(CLIP_B, { status: 'error', metadata: { error_message: 'Song failed' } }))));
  assert.ok(!isDone(clipSummary(clipJson(CLIP_B, { status: 'streaming' }))));
  assert.equal(manifestFor(summary), '/_sw-mango/manifest.m3u8?contentId=' + CLIP_A + '&src=' +
    encodeURIComponent('https://d2lwuy8qc234o3.cloudfront.net/1/clip/' + CLIP_A + '.m4a') + '&contentType=clip');

  assert.equal(sniffAudio(Buffer.concat([Buffer.from([0, 0, 0, 0x1c]), Buffer.from('ftypiso6')])).ext, 'm4a');
  assert.equal(sniffAudio(Buffer.from('ID3\u0004\u0000')).ext, 'mp3');
  assert.equal(sniffAudio(Buffer.from([0xff, 0xfb, 0x90, 0x44])).ext, 'mp3');
  assert.equal(sniffAudio(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE')])).ext, 'wav');
  assert.equal(sniffAudio(Buffer.from([0xec, 0x38, 0x44, 0x47, 0xb8, 0xd8, 0x59, 0x1c])), null, 'the obfuscated stored file is not audio');
  assert.equal(sniffAudio(Buffer.from('<html>')), null);

  const report = parseFfmpegReport(FFMPEG_REPORT);
  assert.equal(report.duration, 182.4);
  assert.equal(report.bitrate_kbps, 128);
  assert.equal(report.codec, 'opus');
  assert.equal(report.sample_rate, 48000);
  assert.equal(report.mean_volume_db, -14.2);
  assert.equal(report.silences.length, 2);
  assert.ok(report.hints.some(hint => hint.startsWith('silent_start')));
  assert.ok(report.hints.some(hint => hint.startsWith('gap')));
  const silent = parseFfmpegReport('Duration: 00:00:20.00, bitrate: 64 kb/s\n Stream #0:0: Audio: aac, 44100 Hz, mono\nmean_volume: -inf dB\nmax_volume: -inf dB');
  assert.ok(silent.hints.some(hint => hint.startsWith('silent:')));
  assert.ok(silent.hints.some(hint => hint.startsWith('short')));
  assert.equal(findWhisper({ env: { PATH: '' }, exists: () => false }), '');
  assert.equal(findWhisper({ env: { TEAMYRA_WHISPER: 'C:/w/whisper.exe' }, exists: file => file === 'C:/w/whisper.exe' }), 'C:/w/whisper.exe');

  assert.ok(safeSunoUrl('https://suno.com/create'));
  assert.ok(safeSunoUrl('https://d2lwuy8qc234o3.cloudfront.net/1/clip/x.m4a'));
  assert.ok(safeSunoUrl('https://accounts.google.com/o/oauth2'));
  assert.ok(!safeSunoUrl('https://accounts.google.com/', { signIn: false }));
  assert.ok(!safeSunoUrl('http://suno.com/'));
  assert.ok(!safeSunoUrl('https://evil.example.com/'));
  assert.equal(partitionForSuno('suno'), 'persist:teamyra-suno');
  assert.equal(partitionForSuno('Suno 2-ab'), 'persist:teamyra-suno-suno-2-ab');
  assert.equal(songUrl(CLIP_A.toUpperCase()), 'https://suno.com/song/' + CLIP_A);
  assert.equal(category('option_unavailable: Suno model "v9"'), 'option_unavailable');
  assert.equal(category('download_failure: x'), 'download_failure');
  assert.match(probeScript('state'), /^\(function state\(/);
  assert.match(probeScript('readStream', { manifest: '/m' }), /^\(async function readStream\(/);
}

// The Create page as the adapter's probes see it (signed in, Custom mode available).
class FakeSunoPage {
  constructor({ models = ['v5', 'v4.5+', 'v4.5'], sliders = true, gender = true, signedIn = true } = {}) {
    this.mode = 'simple';
    this.model = models[0];
    this.models = models;
    this.hasSliders = sliders;
    this.hasGender = gender;
    this.signedIn = signedIn;
    this.values = { description: '', lyrics: '', style: '', title: '', exclude: '' };
    this.instrumental = false;
    this.gender = null;
    this.sliders = { weird: 50, influence: 50 };
    this.menu = null;
    this.created = [];
    this.rows = [OLD_CLIP];
    this.notices = '';
    this.playing = null;
    this.requested = [];
    this.debugger = { isAttached: () => true, attach() {}, on() {}, sendCommand: async (method, params) => this.cdp(method, params) };
    this.focused = null;
  }

  cdp(method, params) {
    if (method === 'Input.insertText' && this.focused) this.values[this.focused] = (this.values[this.focused] || '') + params.text;
    if (method === 'Input.dispatchKeyEvent' && params.type === 'rawKeyDown' && params.key === 'Escape') this.menu = null;
    // A Radix-style slider moves one step per arrow key.
    if (method === 'Input.dispatchKeyEvent' && params.type === 'rawKeyDown' && this.focused in this.sliders) {
      const value = this.sliders[this.focused];
      this.sliders[this.focused] = params.key === 'Home' ? 0 : params.key === 'End' ? 100 : params.key === 'ArrowRight' ? Math.min(100, value + 1)
        : params.key === 'ArrowLeft' ? Math.max(0, value - 1) : value;
    }
    return {};
  }

  form() {
    const fields = [];
    const add = (key, label) => fields.push({ idx: 'f-' + key, kind: 'textarea', label, value: this.values[key] });
    if (this.mode === 'simple') add('description', 'Describe the song you want');
    else {
      if (!this.instrumental) add('lyrics', 'Lyrics | Write some lyrics or a prompt');
      add('style', 'Styles | Hip-hop, R&B, upbeat');
      add('exclude', 'Exclude styles');
      fields.push({ idx: 'f-title', kind: 'input', label: 'Song Title (Optional)', value: this.values.title });
    }
    const buttons = [
      { idx: 'b-simple', text: 'Simple', selected: this.mode === 'simple', group: '' },
      { idx: 'b-custom', text: 'Custom', selected: this.mode === 'custom', group: '' },
      { idx: 'b-model', text: this.model, popup: 'menu', expanded: 'false', group: '' },
      { idx: 'b-create', text: 'Create', group: '' }
    ];
    if (this.mode === 'custom' && this.hasGender) {
      buttons.push({ idx: 'b-male', text: 'Male', group: 'Vocal Gender', selected: this.gender === 'male' },
        { idx: 'b-female', text: 'Female', group: 'Vocal Gender', selected: this.gender === 'female' });
    }
    const sliders = this.mode === 'custom' && this.hasSliders ? [
      { idx: 's-weird', label: 'Weirdness', value: this.sliders.weird, min: 0, max: 100 },
      { idx: 's-influence', label: 'Style Influence', value: this.sliders.influence, min: 0, max: 100 }] : [];
    return { url: 'https://suno.com/create', fields, switches: [{ idx: 'sw-instrumental', label: 'Instrumental', on: this.instrumental }], sliders, buttons };
  }

  probe(name, args) {
    switch (name) {
      case 'state': return { url: 'https://suno.com/create', path: '/create', signedOut: !this.signedIn, credits: 480,
        createButton: { text: 'Create', disabled: false }, notices: this.notices };
      case 'session': return { ok: true, signedIn: this.signedIn, models: [] };
      case 'readForm': return this.form();
      case 'setText': { const key = args.idx.slice(2); this.values[key] = args.value; return { ok: true, value: args.value }; }
      case 'readValue': {
        if (args.idx === 'sw-instrumental') return this.instrumental;
        if (args.idx.startsWith('s-')) return this.sliders[args.idx.slice(2)];
        return this.values[args.idx.slice(2)];
      }
      case 'focus': this.focused = args.idx.slice(2); return { x: 1, y: 1 };
      case 'setRange': return false;
      // Key events sent to the slider step it to the target (the live page's way).
      case 'sliderKeys': { const key = args.idx.slice(2); this.sliders[key] = args.target; return args.target; }
      case 'sliderTrack': return null;
      case 'click': {
        if (args.idx === 'b-custom') this.mode = 'custom';
        else if (args.idx === 'b-simple') this.mode = 'simple';
        else if (args.idx === 'sw-instrumental') this.instrumental = !this.instrumental;
        else if (args.idx === 'b-model') this.menu = 'model';
        else if (args.idx === 'b-male' || args.idx === 'b-female') this.gender = args.idx.slice(2);
        else if (args.idx === 'b-create') {
          this.created.push({ mode: this.mode, model: this.model, values: { ...this.values }, instrumental: this.instrumental, gender: this.gender, sliders: { ...this.sliders } });
          this.rows.unshift(CLIP_B, CLIP_A);
        }
        return true;
      }
      case 'menuItems': {
        const items = this.menu === 'model' ? this.models.map((label, index) => ({ index, label, text: label, disabled: label === 'v6' })) : [];
        if (Number.isInteger(args.click)) { this.model = this.models[args.click]; this.menu = null; return items[args.click]; }
        return items;
      }
      case 'clipIds': return [...this.rows];
      case 'embeddedClips': return Object.fromEntries((args.ids || []).map(id => [id, clipJson(id)]));
      case 'playbackUrl': return { manifest: this.playing ? '/_sw-mango/manifest.m3u8?contentId=' + this.playing + '&src=x&contentType=clip' : null,
        audio: '', playing: Boolean(this.playing), serviceWorker: true };
      case 'clickPlay': this.playing = CLIP_A; return true;
      case 'pause': return true;
      case 'readStream': this.requested.push(args.manifest); return { ok: true, base64: Buffer.concat([Buffer.from([0, 0, 0, 0x1c]), Buffer.from('ftypiso6'), Buffer.alloc(9000)]).toString('base64'),
        bytes: 9012, segments: 31, playlist_duration: 182, endlist: true, muffle_after: null };
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
  const page = new FakeSunoPage();
  const adapter = new SunoAdapter(page, { settleMs: 1 });
  const form = page.form();
  assert.equal(findField(form, 'description').idx, 'f-description');
  assert.equal(modelButton(form).text, 'v5');
  const applied = await adapter.fill({ suno_mode: 'custom', suno_model: 'v4.5', lyrics: '[Verse] rain', suno_style: 'indie pop', suno_title: 'Monsoon',
    suno_vocal_gender: 'female', suno_weirdness: 30, suno_style_influence: 70, suno_exclude_styles: 'metal', instrumental: false, suno_options: {} });
  assert.equal(applied.mode, 'custom');
  assert.equal(page.model, 'v4.5');
  assert.deepEqual([page.values.lyrics, page.values.style, page.values.title, page.values.exclude], ['[Verse] rain', 'indie pop', 'Monsoon', 'metal']);
  assert.equal(page.gender, 'female');
  assert.equal(applied.vocal_gender, 'female');
  const finalForm = page.form();
  assert.equal(findSlider(finalForm, /weird/i).label, 'Weirdness');
  assert.equal(findChoice(finalForm, /vocal/i, 'MALE').choice.text, 'Male');
  assert.equal(findSwitch(finalForm, /instrumental/i).idx, 'sw-instrumental');
  // A model the page does not list: clear error, nothing created.
  await assert.rejects(new SunoAdapter(new FakeSunoPage(), { settleMs: 1 }).fill({ suno_mode: 'simple', suno_model: 'v3.5', prompt: 'x' }),
    /option_unavailable: Suno model "v3.5" is not offered; it offers: v5, v4.5\+, v4.5/);
  const locked = new FakeSunoPage({ models: ['v5', 'v6'] });
  await assert.rejects(new SunoAdapter(locked, { settleMs: 1 }).fill({ suno_mode: 'simple', suno_model: 'v6', prompt: 'x' }), /not available to this account/);
  const plain = new FakeSunoPage({ sliders: false, gender: false });
  await assert.rejects(new SunoAdapter(plain, { settleMs: 1 }).fill({ suno_mode: 'custom', suno_style: 'x', lyrics: 'y', suno_weirdness: 10, suno_options: {} }),
    /option_unavailable: the Suno Create page has no Weirdness slider/);
  await assert.rejects(new SunoAdapter(new FakeSunoPage(), { settleMs: 1 }).fill({ suno_mode: 'custom', suno_style: 'x', lyrics: 'y', suno_options: { 'Persona': 'Mine' } }),
    /option_unavailable: the Suno Create page has no option "Persona"/);
  assert.equal(plain.created.length + locked.created.length, 0);
  // Simple mode: the description box, instrumental on.
  const simple = new FakeSunoPage();
  await new SunoAdapter(simple, { settleMs: 1 }).fill({ suno_mode: 'simple', prompt: 'lofi rain', instrumental: true, suno_options: {} });
  assert.equal(simple.values.description, 'lofi rain');
  assert.equal(simple.instrumental, true);

  // Create, then the two new clips (from the page's generate response, else new rows).
  const known = await adapter.clipIds();
  await adapter.clickCreate();
  adapter.ingest('https://suno.com/a/api/generate/v2/', { clips: [clipJson(CLIP_A, { status: 'submitted' }), clipJson(CLIP_B, { status: 'submitted' })] });
  const created = await adapter.newClips(known, { timeoutMs: 1000, everyMs: 5 });
  assert.deepEqual(created, { ids: [CLIP_A, CLIP_B], via: 'network' });
  assert.equal(adapter.clips.get(CLIP_A).status, 'submitted');
  adapter.ingest('https://suno.com/a/api/feed/v3', { clips: [clipJson(CLIP_A)] });
  assert.equal(adapter.clips.get(CLIP_A).status, 'complete');
  const rowsOnly = new SunoAdapter(page, { settleMs: 1 });
  page.rows = [OLD_CLIP];
  const before = await rowsOnly.clipIds();
  await rowsOnly.clickCreate();
  assert.deepEqual((await rowsOnly.newClips(before, { timeoutMs: 1000, everyMs: 5 })).ids, [CLIP_B, CLIP_A]);
  // A credit message instead of clips.
  const broke = new FakeSunoPage();
  broke.notices = "You're out of credits";
  const limited = await new SunoAdapter(broke, { settleMs: 1 }).newClips([OLD_CLIP], { timeoutMs: 200, everyMs: 5 });
  assert.equal(limited.limit.scope, 'generate');

  // Preview: the page's own playback stream after pressing Play; no Download.
  const stream = await adapter.captureStream(clipSummary(clipJson(CLIP_A)), { playTimeoutMs: 1000 });
  assert.equal(stream.via, 'stream_segments');
  assert.equal(stream.manifest_source, 'page_request');
  assert.match(page.requested[0], /contentId=4eed94d1/);
  // Signed out: the page check says so.
  await assert.rejects(new SunoAdapter(new FakeSunoPage({ signedIn: false }), { settleMs: 1 }).ready(), /login_required/);
}

function fakeCore(jobs) {
  const records = new Map(jobs.map(job => [job.job_id, { state: 'queued', history: [], ...job }]));
  const calls = [];
  const registered = [];
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
      case 'media.status-many': return { jobs: { [args.job_ids[0]]: { cancel_requested: false } } };
      case 'media.update-state': record.state = args.state; record.detail = args.detail; if (args.extra) Object.assign(record, args.extra); return record;
      case 'media.patch': Object.assign(record, args.patch); return record;
      case 'media.reconcile': return record;
      case 'media.release': record.state = 'queued'; record.released = args.reason; return record;
      case 'media.suno-limit': record.state = 'rate_limited'; record.limit = args; return {};
      case 'media.suno-preview-paths': return { paths: Object.fromEntries(args.clips.map(clip => [clip.clip_id,
        path.join(record.dir, clip.clip_id.slice(0, 8) + '.preview.' + clip.ext)])) };
      case 'media.suno-register-previews': record.state = 'completed'; registered.push(args); return {};
      case 'media.prepare-output': return { path: path.join(record.dir, 'final.' + record.request.format), format: record.request.format,
        staging_dir: path.join(record.dir, '.staging') };
      case 'media.register-asset': record.state = 'completed'; registered.push(args); return { asset_id: 'TYR-MUS-000009' };
      case 'media.suno-account-status': return {};
      default: return {};
    }
  };
  return { core, records, calls, registered };
}

function scriptedAdapter(options = {}) {
  const log = [];
  const clips = new Map();
  const m4a = Buffer.concat([Buffer.from([0, 0, 0, 0x1c]), Buffer.from('ftypiso6'), Buffer.alloc(12000)]);
  return {
    log, clips, step: 'idle', pending: 0,
    ready: async () => { if (options.signedOut) throw new Error('login_required: this Suno account is not signed in'); return {}; },
    state: async () => ({ notices: options.notices || '', signedOut: false }),
    fill: async request => { log.push(['fill', request.suno_mode, request.suno_model]); if (request.suno_model === 'v9') throw new Error('option_unavailable: Suno model "v9" is not offered; it offers: v5'); return { mode: request.suno_mode, model: request.suno_model || 'v5' }; },
    clipIds: async () => [OLD_CLIP],
    clickCreate: async () => { log.push(['create']); },
    newClips: async () => options.newClips || { ids: [CLIP_A, CLIP_B], via: 'network' },
    embedded: async ids => {
      for (const id of ids) clips.set(id, clipSummary(clipJson(id, options.status?.[id] ? { status: options.status[id] } : {})));
      return Object.fromEntries(ids.map(id => [id, clips.get(id)]));
    },
    captureStream: async summary => { log.push(['stream', summary.clip_id]); return { ok: true, base64: m4a.toString('base64'), via: 'stream_segments', manifest_source: 'page_request',
      segments: 31, playlist_duration: 182, endlist: true, muffle_after: options.muffle || null }; },
    clickDownload: async format => { log.push(['download', format]); return options.downloadLimit ? { limit: { scope: 'download', text: options.downloadLimit } } : { clicked: format.toUpperCase() + ' audio' }; },
    confirmPreparedDownload: async () => new Promise(() => {}),
    startCapture: async () => {}
  };
}

function consumerFor(core, adapter, options = {}) {
  const loads = [];
  const provider = { view: { webContents: { getURL: () => 'https://suno.com/create' } }, webContentsId: 7, loads,
    async load(url) { loads.push(url); return url; }, ensureView() {} };
  const consumer = new SunoJobConsumer({ workerName: 'suno-test', provider, profileId: 'suno-2', core, pollMs: 2, statusFallbackMs: 0,
    verify: async () => ({ decoded: true, audio: true }),
    analyze: async file => ({ duration: 182.4, bitrate_kbps: 128, codec: 'opus', sample_rate: 48000, channels: 'stereo', mean_volume_db: -14,
      max_volume_db: -0.5, silences: [], silence_seconds: 0, silence_threshold_db: -45, hints: fs.existsSync(file) ? [] : ['missing'] }),
    transcriber: async () => ({ available: false }), ...options });
  consumer.adapter = async () => adapter;
  return { consumer, provider };
}

async function consumerTests(temp) {
  const request = { type: 'song', prompt: 'monsoon pop', suno_action: 'generate', suno_mode: 'custom', suno_model: 'v4.5', lyrics: 'la',
    suno_style: 'pop', suno_title: 'Monsoon', instrumental: false, suno_options: {}, generation_settings: {} };
  // Generate: two clips, both saved as previews from the playback stream.
  {
    const dir = fs.mkdtempSync(path.join(temp, 'g1-'));
    const { core, records, registered, calls } = fakeCore([{ job_id: 'job-1', dir, request }]);
    const adapter = scriptedAdapter({ muffle: null });
    const { consumer, provider } = consumerFor(core, adapter);
    await consumer.run(await core('media.claim'));
    const record = records.get('job-1');
    assert.equal(record.state, 'completed', record.detail);
    assert.deepEqual(record.provider_submission.clip_ids, [CLIP_A, CLIP_B]);
    assert.equal(record.provider_submission.profile_id, 'suno-2');
    assert.ok(calls.findIndex(entry => entry[0] === 'media.patch' && entry[1].patch.submission_phase === 'sending') <
      calls.findIndex(entry => entry[0] === 'media.patch' && entry[1].patch.submission_phase === 'submitted'));
    const clips = registered[0].clips;
    assert.equal(clips.length, 2);
    assert.equal(clips[0].clip_id, CLIP_A);
    assert.ok(fs.existsSync(clips[0].local_path));
    assert.equal(clips[0].metadata.preview_source.no_download_credit, true);
    assert.equal(clips[0].metadata.preview_source.via, 'stream_segments');
    assert.equal(clips[0].metadata.lyrics, '[Verse]\nRain on the roof');
    assert.equal(clips[0].metadata.style, 'indie pop, female vocals');
    assert.equal(clips[0].metadata.model, 'v4.5');
    assert.equal(clips[0].metadata.duration, 182.4);
    assert.equal(clips[0].metadata.transcript_note, 'no local whisper found');
    assert.ok(provider.loads.includes('https://suno.com/song/' + CLIP_B), 'each clip is read from its song page');
    assert.ok(!adapter.log.some(entry => entry[0] === 'download'), 'previews never click Download');
  }
  // One clip fails in Suno: the other is still registered, the failure noted.
  {
    const dir = fs.mkdtempSync(path.join(temp, 'g2-'));
    const { core, records, registered } = fakeCore([{ job_id: 'job-2', dir, request }]);
    const adapter = scriptedAdapter({ status: { [CLIP_B]: 'error' } });
    const { consumer } = consumerFor(core, adapter);
    await consumer.run(await core('media.claim'));
    assert.equal(records.get('job-2').state, 'completed', records.get('job-2').detail);
    assert.equal(registered[0].clips.length, 1);
    assert.equal(registered[0].clips[0].metadata.other_clips_failed[0].clip_id, CLIP_B);
  }
  // Out of credits after Create, no clip: the account rests and the job goes back.
  {
    const { core, records, registered } = fakeCore([{ job_id: 'job-3', dir: temp, request }]);
    const adapter = scriptedAdapter({ newClips: { ids: [], limit: { scope: 'generate', text: "You're out of credits" } } });
    const { consumer } = consumerFor(core, adapter);
    await consumer.run(await core('media.claim'));
    assert.equal(records.get('job-3').state, 'rate_limited');
    assert.equal(records.get('job-3').limit.scope, 'generate');
    assert.equal(records.get('job-3').limit.profile_id, 'suno-2');
    assert.equal(registered.length, 0);
  }
  // A model the page does not offer: fails clearly before Create.
  {
    const { core, records } = fakeCore([{ job_id: 'job-4', dir: temp, request: { ...request, suno_model: 'v9' } }]);
    const adapter = scriptedAdapter();
    const { consumer } = consumerFor(core, adapter);
    await consumer.run(await core('media.claim'));
    assert.equal(records.get('job-4').failure.category, 'option_unavailable');
    assert.ok(!adapter.log.some(entry => entry[0] === 'create'));
  }
  // Signed out before anything was made: the job goes back for another account.
  {
    const { core, records } = fakeCore([{ job_id: 'job-5', dir: temp, request }]);
    const seen = [];
    const { consumer } = consumerFor(core, scriptedAdapter({ signedOut: true }), { onSignedIn: (value) => seen.push(value) });
    await consumer.run(await core('media.claim'));
    assert.equal(records.get('job-5').state, 'queued');
    assert.match(records.get('job-5').released, /not signed in/);
    assert.deepEqual(seen, [false]);
  }
  // Created before a restart: the saved clips are followed, Create is not clicked again.
  {
    const dir = fs.mkdtempSync(path.join(temp, 'g6-'));
    const { core, records } = fakeCore([{ job_id: 'job-6', dir, request, provider_submission: { submitted_at: 1, clip_ids: [CLIP_A, CLIP_B], profile_id: 'suno-2' } }]);
    const adapter = scriptedAdapter();
    const { consumer } = consumerFor(core, adapter);
    await consumer.run(await core('media.claim'));
    assert.equal(records.get('job-6').state, 'completed', records.get('job-6').detail);
    assert.ok(!adapter.log.some(entry => entry[0] === 'create' || entry[0] === 'fill'));
  }
  // Official download: Suno's own Download, verified and registered with its preview.
  {
    const dir = fs.mkdtempSync(path.join(temp, 'd1-'));
    const downloadRequest = { type: 'song', suno_action: 'download', suno_clip_id: CLIP_A, format: 'mp3', generation_settings: {} };
    const { core, records, registered } = fakeCore([{ job_id: 'job-7', dir, request: downloadRequest, parent_asset_ids: ['TYR-MUS-000001'] }]);
    const adapter = scriptedAdapter();
    const downloads = { expected: [], expect: ({ destination }) => {
      const file = destination;
      return new Promise(resolve => setTimeout(() => {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, Buffer.concat([Buffer.from('ID3\u0004\u0000'), Buffer.alloc(4000)]));
        resolve({ path: file, bytes: 4005, filename: 'Monsoon.mp3' });
      }, 5));
    } };
    const { consumer, provider } = consumerFor(core, adapter, { downloads });
    await consumer.run(await core('media.claim'));
    const record = records.get('job-7');
    assert.equal(record.state, 'completed', record.detail);
    assert.deepEqual(adapter.log.filter(entry => entry[0] === 'download'), [['download', 'mp3']]);
    assert.equal(provider.loads[0], 'https://suno.com/song/' + CLIP_A);
    assert.equal(registered[0].metadata.official_download, true);
    assert.equal(registered[0].metadata.preview_asset_id, 'TYR-MUS-000001');
    assert.equal(registered[0].provider_asset_id, CLIP_A);
    assert.ok(fs.existsSync(path.join(dir, 'final.mp3')));
  }
  // Download limit: the account's downloads rest; nothing is registered.
  {
    const dir = fs.mkdtempSync(path.join(temp, 'd2-'));
    const downloadRequest = { type: 'song', suno_action: 'download', suno_clip_id: CLIP_A, format: 'wav', generation_settings: {} };
    const { core, records, registered } = fakeCore([{ job_id: 'job-8', dir, request: downloadRequest }]);
    const downloads = new SunoDownloads(new EventEmitter());
    const { consumer } = consumerFor(core, scriptedAdapter({ downloadLimit: "You've reached your monthly download limit" }), { downloads });
    await consumer.run(await core('media.claim'));
    assert.equal(records.get('job-8').state, 'rate_limited');
    assert.equal(records.get('job-8').limit.scope, 'download');
    assert.equal(downloads.expected.length, 0, 'the unused download wait is dropped');
    assert.equal(registered.length, 0);
  }
  // A download that is not the asked format fails as a download failure.
  {
    const dir = fs.mkdtempSync(path.join(temp, 'd3-'));
    const { core, records } = fakeCore([{ job_id: 'job-9', dir, request: { type: 'song', suno_action: 'download', suno_clip_id: CLIP_A, format: 'mp3' } }]);
    const downloads = { expected: [], expect: ({ destination }) => {
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, '<html>login</html>');
      return Promise.resolve({ path: destination });
    } };
    const { consumer } = consumerFor(core, scriptedAdapter(), { downloads });
    await consumer.run(await core('media.claim'));
    assert.equal(records.get('job-9').failure.category, 'download_failure');
  }
  // The worker asks only for Suno work of its own account, and stops when idle.
  {
    const { core, calls } = fakeCore([]);
    const { consumer } = consumerFor(core, scriptedAdapter(), { mayClaim: () => false, idleStopMs: 0 });
    consumer.running = true;
    consumer.lastWorkAt = 0;
    await consumer.tick();
    const claim = calls.find(entry => entry[0] === 'media.claim')[1];
    assert.equal(claim.surface, 'suno');
    assert.equal(claim.profile_id, 'suno-2');
    assert.equal(claim.resume_only, true);
    assert.equal(consumer.running, false);
  }
}

async function downloadsTests(temp) {
  const session = new EventEmitter();
  let userView = 0;
  const downloads = new SunoDownloads(session, { isUserView: id => id === userView });
  const item = (name, onSave) => {
    const emitter = new EventEmitter();
    emitter.cancelled = false;
    emitter.cancel = () => { emitter.cancelled = true; };
    emitter.setSavePath = file => { emitter.path = file; onSave?.(file); };
    emitter.getFilename = () => name;
    emitter.getMimeType = () => 'audio/mpeg';
    emitter.getURL = () => 'https://cdn1.suno.ai/x.mp3';
    return emitter;
  };
  const target = path.join(temp, 'dl', 'download.mp3');
  const waiting = downloads.expect({ webContentsId: 7, destination: target, timeoutMs: 2000 });
  const stray = item('stray.mp3');
  session.emit('will-download', {}, stray, { id: 9 });
  assert.ok(stray.cancelled, 'a download no job waits for is cancelled in a worker tab');
  userView = 11;
  const mine = item('mine.mp3');
  session.emit('will-download', {}, mine, { id: 11 });
  assert.ok(!mine.cancelled && !mine.path, "the user's own download in the Open view is left alone");
  const real = item('Monsoon.mp3', file => fs.writeFileSync(file, 'ID3data'));
  session.emit('will-download', {}, real, { id: 7 });
  real.emit('done', {}, 'completed');
  const result = await waiting;
  assert.equal(result.path, path.resolve(target));
  assert.equal(result.filename, 'Monsoon.mp3');
}

async function engineTests(temp) {
  const root = path.join(temp, 'root');
  const profilesRoot = path.join(root, 'profiles', 'suno');
  fs.mkdirSync(path.join(profilesRoot, 'suno-2-ab12'), { recursive: true });
  fs.writeFileSync(path.join(profilesRoot, 'suno-2-ab12', 'teamyra-profile.json'), JSON.stringify({ name: 'Second', enabled: true }));
  fs.writeFileSync(path.join(profilesRoot, 'builtin-suno.json'), JSON.stringify({ name: 'Main Suno', enabled: false }));
  assert.deepEqual(sunoProfiles(profilesRoot, path.join(profilesRoot, 'builtin-suno.json')).map(item => [item.id, item.name, item.enabled]),
    [['suno', 'Main Suno', false], ['suno-2-ab12', 'Second', true]]);
  const made = [];
  class FakeRuntime {
    constructor({ profileId, engine }) {
      this.profileId = profileId; this.engine = engine; made.push(this);
      this.status = { signedIn: profileId === 'suno-2-ab12' ? null : false, checkedAt: 0 };
      this.display = { visible: false, setVisible: value => { this.display.visible = value; }, setBounds: bounds => { this.display.bounds = bounds; } };
      this.consumer = { busy: false, running: false, start: () => { this.consumer.running = true; } };
      this.opened = 0;
    }
    async refreshStatus({ page } = {}) { if (page && this.profileId === 'suno-2-ab12') this.status.signedIn = true; return this.status; }
    startWorker() { if (this.engine.accountMeta(this.profileId).enabled !== false && this.status.signedIn) this.consumer.start(); }
    async open() { this.opened += 1; this.display.setVisible(true); return { profile_id: this.profileId }; }
    snapshot() { return { profile_id: this.profileId, signed_in: this.status.signedIn === true }; }
    destroy() {}
  }
  const engine = new SunoEngine({ window: {}, root, Runtime: FakeRuntime, core: async () => ({}) });
  const wake = await engine.wakeAll();
  assert.deepEqual(wake.accounts.map(item => [item.profile_id, item.signed_in, item.enabled, item.working]),
    [['suno', false, false, false], ['suno-2-ab12', true, true, true]], 'only signed-in, enabled accounts work');
  assert.equal(wake.needs_user_auth, false);
  engine.setBounds({ x: 10, y: 20, width: 800, height: 600 });
  await engine.open('suno-2-ab12');
  assert.equal(engine.activeProfileId, 'suno-2-ab12');
  assert.equal(made[1].display.visible, true);
  engine.setVisible(false);
  assert.equal(made[1].display.visible, false);
  assert.throws(() => engine.ensure('nobody'), /Unknown Suno account/);
}

(async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'teamyra-suno-'));
  try {
    pureTests();
    await adapterTests();
    await consumerTests(temp);
    await downloadsTests(temp);
    await engineTests(temp);
    console.log('suno adapter, previews, downloads and engine tests passed');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exit(1); });

// 2026-11-21: after choosing a Google account the sign-in hops through other
// Google hosts; a refused hop left Suno's sign-in stuck.
{
  const assert = require('node:assert/strict');
  const { isSignInHost, safeSunoUrl } = require('../src/media/suno-provider');
  for (const host of ['accounts.google.com', 'accounts.youtube.com', 'accounts.google.co.in', 'ssl.gstatic.com', 'appleid.apple.com', 'discord.com']) {
    assert.ok(isSignInHost(host), host);
  }
  for (const host of ['evil.com', 'google.com.evil.com', 'googlex.com']) assert.ok(!isSignInHost(host), host);
  assert.ok(safeSunoUrl('https://accounts.youtube.com/accounts/SetSID?x=1', { signIn: true }));
  assert.ok(!safeSunoUrl('https://accounts.youtube.com/accounts/SetSID', { signIn: false }), 'the worker stays on Suno');
  console.log('suno sign-in host tests passed');
}
