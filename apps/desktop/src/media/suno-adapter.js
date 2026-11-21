// Suno (suno.com) page automation. Learned from the live site (Nov 2026,
// signed out; the signed-in Create page is matched by labels, see below):
// - /create redirects a signed-out session to /sign-in ("Welcome to Suno",
//   Continue with Google/Apple/Discord/...). The nav shows "Log in" signed out.
// - Song pages /song/<uuid> embed the clip as JSON in the Next.js payload:
//   id, title, status, metadata {tags (style), prompt (lyrics), duration,
//   make_instrumental, control_sliders}, major_model_version ("v6-mini"),
//   model_name, display_tags, media_urls [{url, content_type "m4a-opus",
//   delivery "progressive"}]; audio_url may read ".../api/forbidden".
// - Playback: audio#active-audio-play plays a MediaSource blob. The page's own
//   service worker (/sw.js) serves the clip as HLS: /_sw-mango/manifest.m3u8?
//   contentId=<id>&src=<media url>&contentType=clip[&muffleAfter=N] listing
//   init.mp4 and seg-N.mp4 (fragmented MP4, Opus). The stored file itself is
//   obfuscated; only the service worker's segments are playable audio.
//   Signed out, the page asks for muffleAfter=10 (muffled after 10 s).
// - Clip menu: "More options for <title>" -> Download -> "MP3 audio" /
//   "WAV audio" (a WAV is prepared first; a "Download “<title>”" button then
//   appears in a dialog). This is the official download and uses the
//   account's download allowance.
// - Same-origin API (cookies): /a/api/session/, /a/api/clips/..., /a/api/feed...
// The Create page's fields are found by their labels/placeholders; a field,
// switch, slider, model or option the page does not show fails with
// option_unavailable listing what it does show.

const SCRIPT_TIMEOUT_MS = 60000;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

// ---- page probes (each runs in the page; self-contained) -------------------

const PROBES = {
  state() {
    const visible = el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden'; };
    const text = el => (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    const clickable = [...document.querySelectorAll('a,button,[role=button]')].filter(visible);
    const signInControl = clickable.some(el => /^(log in|sign in|sign up|join suno.*)$/i.test(text(el)));
    const signInPage = /^\/(sign-in|sign-up|login)/.test(location.pathname) || /welcome to suno/i.test(document.title);
    const creditsMatch = (document.body?.innerText || '').match(/(\d[\d,.]*\s*[kK]?)\s+credits?\b/i);
    // Suno signs in with Clerk: a signed-in page holds its __session cookie
    // and shows no Log in / Sign up control (2026-11-21: the old check wanted
    // a "<n> credits" text the page no longer shows and kept saying signed out).
    const sessionCookie = /(?:^|;\s*)__session(?:_[^=]*)?=[^;]{20,}/.test(document.cookie)
      && !/(?:^|;\s*)__client_uat=0(?:;|$)/.test(document.cookie);
    const notices = [...document.querySelectorAll('[role=alert],[role=status],[role=alertdialog],[role=dialog],[data-sonner-toast],.Toastify__toast,[class*=toast i]')]
      .filter(visible).map(text).filter(Boolean).join('\n').slice(0, 3000);
    const create = clickable.find(el => el.tagName !== 'A' && /^create\b/i.test(text(el)) && text(el).length < 24 && !el.closest('nav,aside'));
    return {
      url: location.href,
      path: location.pathname,
      signedOut: signInPage || (signInControl && !creditsMatch && !sessionCookie),
      signedIn: !signInPage && !signInControl && sessionCookie,
      credits: creditsMatch ? (value => /k$/i.test(value) ? Math.round(parseFloat(value) * 1000) : Number(value.replace(/[,\s]/g, '')))(creditsMatch[1].trim()) : null,
      createButton: create ? { text: text(create), disabled: create.disabled === true || create.getAttribute('aria-disabled') === 'true' } : null,
      notices,
      title: document.title
    };
  },

  async session() {
    try {
      const response = await fetch('/a/api/session/', { credentials: 'include' });
      if (!response.ok) return { ok: false, status: response.status };
      const data = await response.json();
      const roles = data && data.roles && typeof data.roles === 'object' ? Object.keys(data.roles).length : 0;
      const models = Array.isArray(data && data.models) ? data.models.map(item => item && (item.name || item.external_key || item.key || item.id)).filter(Boolean).slice(0, 30) : [];
      return { ok: true, signedIn: Boolean(data && (data.user || data.user_id || data.profile || models.length || roles)), models };
    } catch (error) { return { ok: false, error: String(error && error.message || error) }; }
  },

  // Every visible Create-page control with a label; each gets data-tyr-idx.
  readForm() {
    const visible = el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
    const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
    const text = el => clean(el.innerText || el.textContent);
    const main = document.querySelector('main') || document.body;
    // A short text label near a control: its <label>, aria, placeholder or a nearby heading.
    const labelOf = el => {
      const direct = [el.getAttribute('aria-label'), el.getAttribute('placeholder'), el.getAttribute('title'), el.getAttribute('name')].map(clean).filter(Boolean);
      const ids = (el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean).map(id => document.getElementById(id)).filter(Boolean).map(text);
      const own = el.id ? [...document.querySelectorAll('label[for="' + CSS.escape(el.id) + '"]')].map(text) : [];
      const wrapping = el.closest('label') ? [text(el.closest('label'))] : [];
      let near = '';
      let node = el;
      for (let depth = 0; depth < 4 && node && !near; depth += 1) {
        const parent = node.parentElement;
        if (!parent) break;
        for (const sibling of parent.children) {
          if (sibling === node || sibling.contains(el)) continue;
          const value = text(sibling);
          if (value && value.length <= 40 && !sibling.querySelector('textarea,input,[contenteditable=true]')) { near = value; break; }
        }
        node = parent;
      }
      return [...ids, ...own, ...wrapping, ...direct, near].filter(Boolean).join(' | ').slice(0, 200);
    };
    // Tags from an earlier read stay on the page: clear them, or the button
    // loop below (which skips tagged fields) would skip every button on the
    // second read (2026-11-21: 'no Simple/Custom switch' right after the
    // tabs were found).
    for (const old of document.querySelectorAll('[data-tyr-idx]')) old.removeAttribute('data-tyr-idx');
    let index = 0;
    const tag = el => { const id = String(index++); el.setAttribute('data-tyr-idx', id); return id; };
    const fields = [];
    for (const el of main.querySelectorAll('textarea,input[type=text],input:not([type]),input[type=search],[contenteditable=true]')) {
      if (!visible(el) || el.closest('nav,aside,header')) continue;
      fields.push({ idx: tag(el), kind: el.isContentEditable ? 'editable' : el.tagName.toLowerCase(), label: labelOf(el),
        value: clean(el.isContentEditable ? el.innerText : el.value).slice(0, 200), maxLength: el.maxLength > 0 ? el.maxLength : null });
    }
    const switches = [];
    for (const el of main.querySelectorAll('[role=switch],input[type=checkbox],button[aria-pressed]')) {
      if (!visible(el) && !(el.tagName === 'INPUT' && el.parentElement && visible(el.parentElement))) continue;
      if (el.closest('nav,aside,header')) continue;
      const on = el.getAttribute('aria-checked') === 'true' || el.getAttribute('aria-pressed') === 'true' ||
        el.getAttribute('data-state') === 'checked' || el.checked === true;
      switches.push({ idx: tag(el), label: (labelOf(el) + ' ' + text(el)).trim(), on });
    }
    const sliders = [];
    for (const el of main.querySelectorAll('[role=slider],input[type=range]')) {
      if (!visible(el) || el.closest('nav,aside,header')) continue;
      sliders.push({ idx: tag(el), label: labelOf(el), value: Number(el.getAttribute('aria-valuenow') ?? el.value),
        min: Number(el.getAttribute('aria-valuemin') ?? el.min ?? 0), max: Number(el.getAttribute('aria-valuemax') ?? el.max ?? 100) });
    }
    const buttons = [];
    for (const el of main.querySelectorAll('button,[role=button],[role=tab],[role=radio],[role=combobox],[aria-haspopup]')) {
      if (!visible(el) || el.closest('nav,aside,header') || el.hasAttribute('data-tyr-idx')) continue;
      const value = text(el);
      const aria = clean(el.getAttribute('aria-label'));
      if (!value && !aria) continue;
      // The label of a group of option buttons (e.g. "Vocal Gender": Male / Female).
      let group = '';
      const holder = el.parentElement && el.parentElement.parentElement;
      if (holder) {
        const heading = [...holder.children].find(child => !child.contains(el) && text(child) && text(child).length <= 40 && !child.querySelector('button'));
        if (heading) group = text(heading);
      }
      buttons.push({ idx: tag(el), text: value.slice(0, 80), aria, group,
        role: el.getAttribute('role') || '', popup: el.getAttribute('aria-haspopup') || '', expanded: el.getAttribute('aria-expanded'),
        selected: ['aria-selected', 'aria-checked', 'aria-pressed'].some(name => el.getAttribute(name) === 'true') || el.getAttribute('data-state') === 'active' || el.getAttribute('data-state') === 'on',
        disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true' });
    }
    return { url: location.href, fields, switches, sliders, buttons };
  },

  // Set a text field by its data-tyr-idx (React sees a real input event).
  setText(args) {
    const el = document.querySelector('[data-tyr-idx="' + args.idx + '"]');
    if (!el) return { ok: false, reason: 'gone' };
    el.focus();
    if (el.isContentEditable) return { ok: false, reason: 'editable' };
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, args.value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, value: el.value };
  },

  readValue(args) {
    const el = document.querySelector('[data-tyr-idx="' + args.idx + '"]');
    if (!el) return null;
    if (el.matches('[role=slider],input[type=range]')) return Number(el.getAttribute('aria-valuenow') ?? el.value);
    if (el.matches('[role=switch],input[type=checkbox],button[aria-pressed]')) {
      return el.getAttribute('aria-checked') === 'true' || el.getAttribute('aria-pressed') === 'true' || el.getAttribute('data-state') === 'checked' || el.checked === true;
    }
    return el.isContentEditable ? el.innerText : el.value;
  },

  focus(args) {
    const el = document.querySelector('[data-tyr-idx="' + args.idx + '"]');
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    el.focus();
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: Math.round(r.width) };
  },

  click(args) {
    const el = document.querySelector('[data-tyr-idx="' + args.idx + '"]');
    if (!el) return false;
    el.scrollIntoView({ block: 'center' });
    el.click();
    return true;
  },

  setRange(args) {
    const el = document.querySelector('[data-tyr-idx="' + args.idx + '"]');
    if (!el || el.tagName !== 'INPUT') return false;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, String(args.value));
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  },

  // Step a custom slider to a value with key events sent to the slider itself
  // (Suno's sliders listen to React onKeyDown; mouse events and scripted values
  // do nothing in a hidden tab). Returns the value reached.
  async sliderKeys(args) {
    const el = document.querySelector('[data-tyr-idx="' + args.idx + '"]');
    if (!el) return null;
    const read = () => Number(el.getAttribute('aria-valuenow') ?? el.value);
    const press = key => el.dispatchEvent(new KeyboardEvent('keydown', { key, code: key, keyCode: key === 'ArrowLeft' ? 37 : 39, bubbles: true, cancelable: true }));
    el.focus();
    let current = read();
    for (let i = 0; i < 800 && current !== args.target; i += 1) {
      press(current < args.target ? 'ArrowRight' : 'ArrowLeft');
      await new Promise(resolve => setTimeout(resolve, 15));
      const next = read();
      if (next === current) break;
      if ((current < args.target && next > args.target) || (current > args.target && next < args.target)) { current = next; break; }
      current = next;
    }
    return current;
  },

  // The track of a custom (div role=slider) slider: the nearest ancestor much
  // wider than the thumb. Its screen box, scrolled into view.
  sliderTrack(args) {
    const el = document.querySelector('[data-tyr-idx="' + args.idx + '"]');
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const thumb = el.getBoundingClientRect();
    // Suno's slider element is the whole track (ticks 0-100%): use it as is.
    if (thumb.width >= 60 && thumb.height < 80) return { left: thumb.left, top: thumb.top, width: thumb.width, height: thumb.height };
    let track = el.parentElement;
    for (let i = 0; track && i < 6; i += 1, track = track.parentElement) {
      const r = track.getBoundingClientRect();
      if (r.width >= Math.max(60, thumb.width * 4) && r.height < 80) break;
    }
    if (!track) return null;
    const r = track.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  },

  // Entries of an open menu/listbox/popover.
  menuItems(args) {
    const visible = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
    const roots = [...document.querySelectorAll('[role=menu],[role=listbox],[data-radix-popper-content-wrapper],[role=dialog]')].filter(visible);
    const items = [];
    const nodes = [];
    for (const root of roots) {
      // Suno's model picker is a grid of rows (role=row) in a dialog (2026-11-21).
      for (const el of root.querySelectorAll('[role=menuitem],[role=menuitemradio],[role=menuitemcheckbox],[role=option],[role=row],button')) {
        if (!visible(el) || nodes.includes(el) || nodes.some(node => node.contains(el))) continue;
        nodes.push(el);
        const lines = (el.innerText || '').split('\n').map(clean).filter(Boolean);
        items.push({ index: items.length, label: lines[0] || clean(el.getAttribute('aria-label')), text: lines.join(' ').slice(0, 160),
          aria: clean(el.getAttribute('aria-label')),
          disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true' || el.hasAttribute('data-disabled'),
          checked: el.getAttribute('aria-checked') === 'true' || el.getAttribute('aria-selected') === 'true' || el.getAttribute('data-state') === 'checked',
          submenu: el.getAttribute('aria-haspopup') === 'menu' || el.getAttribute('aria-haspopup') === 'true' });
      }
    }
    if (args && Number.isInteger(args.click)) {
      const el = nodes[args.click];
      if (!el) return null;
      el.scrollIntoView({ block: 'nearest' });
      if (args.hover) {
        for (const type of ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'pointermove']) el.dispatchEvent(new PointerEvent(type, { bubbles: true }));
      }
      el.click();
      return items[args.click];
    }
    return items;
  },

  // Song ids visible on the page, in page order (newest first on Create/Library).
  clipIds() {
    const re = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
    const ids = [];
    const add = value => { const match = String(value || '').match(re); if (match && !ids.includes(match[0].toLowerCase())) ids.push(match[0].toLowerCase()); };
    const main = document.querySelector('main') || document.body;
    for (const el of main.querySelectorAll('a[href*="/song/"],[data-clip-id],[data-song-id],[data-key]')) {
      add(el.getAttribute('data-clip-id') || el.getAttribute('data-song-id') || el.getAttribute('href') || el.getAttribute('data-key'));
    }
    return ids.slice(0, 200);
  },

  // Rows of the Library/Create list: id, title, visible duration/status text.
  clipRows(args) {
    const re = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
    const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
    const rows = [];
    const seen = new Set();
    for (const link of document.querySelectorAll('a[href*="/song/"]')) {
      const id = (link.getAttribute('href').match(re) || [])[0];
      if (!id || seen.has(id.toLowerCase())) continue;
      seen.add(id.toLowerCase());
      let row = link;
      for (let i = 0; i < 6 && row.parentElement && !/\d:\d\d/.test(row.innerText || ''); i += 1) row = row.parentElement;
      const value = clean(row.innerText);
      rows.push({ clip_id: id.toLowerCase(), title: clean(link.innerText) || null,
        duration_text: (value.match(/\b\d{1,2}:\d{2}\b/) || [])[0] || null,
        model_text: (value.match(/\bv\d(?:\.\d+)?(?:[-+ ]?[a-z]+)?\b/i) || [])[0] || null, text: value.slice(0, 200) });
      if (rows.length >= (args && args.limit || 50)) break;
    }
    return rows;
  },

  // The clip objects the page embeds (Next.js payload), by id.
  embeddedClips(args) {
    const wanted = (args && args.ids || []).map(id => String(id).toLowerCase());
    let source = '';
    for (const script of document.querySelectorAll('script')) {
      const value = script.textContent || '';
      if (!value.includes('self.__next_f')) { if (value.trim().startsWith('{') && value.includes('"metadata"')) source += value; continue; }
      const re = /self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g;
      let match;
      while ((match = re.exec(value))) { try { source += JSON.parse(match[1]); } catch {} }
    }
    const found = {};
    const parseAt = start => {
      let depth = 0, quoted = false, escaped = false;
      for (let i = start; i < source.length && i - start < 400000; i += 1) {
        const c = source[i];
        if (quoted) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') quoted = false; continue; }
        if (c === '"') quoted = true;
        else if (c === '{') depth += 1;
        else if (c === '}') { depth -= 1; if (!depth) { try { return JSON.parse(source.slice(start, i + 1)); } catch { return null; } } }
      }
      return null;
    };
    for (const id of wanted) {
      let at = source.indexOf('"id":"' + id + '"');
      let tries = 0;
      while (at >= 0 && !found[id] && tries < 20) {
        tries += 1;
        let start = source.lastIndexOf('{', at);
        for (let back = 0; back < 6 && start >= 0; back += 1) {
          const value = parseAt(start);
          if (value && String(value.id).toLowerCase() === id && (value.metadata || value.media_urls || value.status)) { found[id] = value; break; }
          start = source.lastIndexOf('{', start - 1);
        }
        at = source.indexOf('"id":"' + id + '"', at + 10);
      }
    }
    return found;
  },

  // The playback manifest URL the page itself requested for a clip.
  playbackUrl(args) {
    const id = String(args.id).toLowerCase();
    const entry = performance.getEntriesByType('resource').map(item => item.name).reverse()
      .find(name => name.includes('/_sw-mango/manifest.m3u8') && name.toLowerCase().includes('contentid=' + id));
    const audio = document.getElementById('active-audio-play');
    return { manifest: entry || null, audio: audio ? (audio.currentSrc || audio.src || '') : '', playing: audio ? !audio.paused : false,
      serviceWorker: Boolean(navigator.serviceWorker && navigator.serviceWorker.controller) };
  },

  clickPlay(args) {
    const visible = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const main = document.querySelector('main') || document.body;
    const buttons = [...main.querySelectorAll('button')].filter(visible);
    const label = el => (el.getAttribute('aria-label') || '').trim();
    const play = buttons.find(el => /^play$/i.test(label(el))) ||
      buttons.find(el => /^play\b/i.test(label(el)) && !/playlist|playbar/i.test(label(el))) ||
      [...document.querySelectorAll('button')].filter(visible).find(el => /^playbar: play/i.test(label(el)));
    if (!play) return false;
    play.click();
    return true;
  },

  pause() {
    for (const audio of document.querySelectorAll('audio')) { try { audio.pause(); } catch {} }
    return true;
  },

  // Read the page's playback stream (its service worker's HLS segments) inside the page.
  async readStream(args) {
    const manifestUrl = new URL(args.manifest, location.href);
    const response = await fetch(manifestUrl.href, { credentials: 'include' });
    if (!response.ok) return { ok: false, status: response.status, step: 'manifest' };
    const manifest = await response.text();
    if (!/^#EXTM3U/.test(manifest)) return { ok: false, step: 'manifest', error: 'not an HLS manifest' };
    const lines = manifest.split(/\r?\n/);
    const map = (manifest.match(/#EXT-X-MAP:URI="([^"]+)"/) || [])[1];
    const segments = [];
    let duration = 0;
    for (let i = 0; i < lines.length; i += 1) {
      const inf = lines[i].match(/^#EXTINF:([\d.]+)/);
      if (inf) { duration += Number(inf[1]); const next = lines[i + 1]; if (next && !next.startsWith('#')) segments.push(next.trim()); }
    }
    if (!segments.length) return { ok: false, step: 'manifest', error: 'no segments' };
    // Segments are fetched 8 at a time (one after another took most of the
    // preview time) and joined in playlist order.
    const uris = [map, ...segments].filter(Boolean);
    const parts = new Array(uris.length);
    let bytes = 0;
    let failure = null;
    let next = 0;
    const worker = async () => {
      while (!failure && next < uris.length) {
        const index = next++;
        const part = await fetch(new URL(uris[index], manifestUrl).href, { credentials: 'include' }).catch(error => ({ ok: false, status: 0, error }));
        if (!part.ok) { failure = { ok: false, status: part.status, step: 'segment', segment: uris[index].split('?')[0] }; return; }
        const buffer = new Uint8Array(await part.arrayBuffer());
        bytes += buffer.length;
        if (bytes > 300 * 1024 * 1024) { failure = { ok: false, step: 'segment', error: 'stream too large' }; return; }
        parts[index] = buffer;
      }
    };
    await Promise.all(Array.from({ length: Math.min(8, uris.length) }, worker));
    if (failure) return failure;
    const all = new Uint8Array(bytes);
    let offset = 0;
    for (const part of parts) { all.set(part, offset); offset += part.length; }
    let binary = '';
    for (let i = 0; i < all.length; i += 0x8000) binary += String.fromCharCode.apply(null, all.subarray(i, i + 0x8000));
    const params = manifestUrl.searchParams;
    return { ok: true, base64: btoa(binary), bytes, segments: segments.length, playlist_duration: Math.round(duration * 100) / 100,
      endlist: /#EXT-X-ENDLIST/.test(manifest), muffle_after: params.get('muffleAfter') ? Number(params.get('muffleAfter')) : null,
      content_type: params.get('contentType') || null };
  },

  // Fetch a plain (non-obfuscated) playback URL inside the page.
  async readUrl(args) {
    const response = await fetch(args.src, { credentials: 'include' });
    if (!response.ok) return { ok: false, status: response.status };
    const blob = await response.blob();
    if (blob.size > 300 * 1024 * 1024) return { ok: false, status: 413 };
    const buffer = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    for (let i = 0; i < buffer.length; i += 0x8000) binary += String.fromCharCode.apply(null, buffer.subarray(i, i + 0x8000));
    return { ok: true, status: response.status, type: blob.type, base64: btoa(binary), bytes: buffer.length };
  },

  // A song page's "More options" button for its clip.
  clipMenuButton() {
    const visible = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const main = document.querySelector('main') || document.body;
    const button = [...main.querySelectorAll('button')].filter(visible).find(el => /^more options( for|$)/i.test(el.getAttribute('aria-label') || ''));
    if (!button) return null;
    button.setAttribute('data-tyr-idx', 'clip-menu');
    return { idx: 'clip-menu', label: button.getAttribute('aria-label') };
  }
};

function probeScript(name, args = {}) {
  if (!PROBES[name]) throw new Error('unknown Suno page probe ' + name);
  return '(' + PROBES[name].toString().replace(/^(async\s+)?(\w+)\s*\(/, '$1function $2(') + ')(/*probe:' + name + '*/ ' + JSON.stringify(args) + ')';
}

// ---- pure helpers (Node side, unit-tested) ---------------------------------

function normalizeName(value) {
  return String(value || '').normalize('NFKC').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

// A model/menu entry named exactly (raw), then by normalized label, then by prefix.
function matchOption(items, wanted) {
  const raw = String(wanted || '').trim().toLowerCase().replace(/\s+/g, '');
  const want = normalizeName(wanted);
  if (!want) return null;
  const labels = item => [item.label, item.aria, item.text].filter(Boolean);
  return items.find(item => labels(item).some(label => label.toLowerCase().replace(/\s+/g, '') === raw)) ||
    items.find(item => normalizeName(item.label) === want) ||
    items.find(item => labels(item).some(label => normalizeName(label) === want)) ||
    items.find(item => normalizeName(item.label).startsWith(want)) ||
    items.find(item => want.length >= 4 && labels(item).some(label => normalizeName(label).includes(want))) || null;
}

function describeOptions(items) {
  return items.filter(item => !item.disabled).map(item => item.label || item.text).filter(Boolean).join(', ') || 'none';
}

const FIELD_PATTERNS = {
  description: /describ|song description|prompt|what.*song|sound you want|idea/i,
  lyrics: /lyric/i,
  style: /\bstyles?\b|genre|style of music/i,
  exclude: /exclude|negative/i,
  title: /\btitle\b|song name/i
};

// The Create page's field for a role, by its label.
function findField(form, role) {
  const fields = form.fields || [];
  const pattern = FIELD_PATTERNS[role];
  const label = field => String(field.label || '');
  if (role === 'style') return fields.find(field => pattern.test(label(field)) && !FIELD_PATTERNS.exclude.test(label(field)) && !/influence/i.test(label(field)) && !FIELD_PATTERNS.lyrics.test(label(field))) || null;
  if (role === 'description') {
    return fields.find(field => pattern.test(label(field)) && !FIELD_PATTERNS.lyrics.test(label(field)) && !FIELD_PATTERNS.style.test(label(field))) ||
      fields.find(field => field.kind === 'textarea' && !FIELD_PATTERNS.lyrics.test(label(field)) && !FIELD_PATTERNS.style.test(label(field)) &&
        !FIELD_PATTERNS.exclude.test(label(field)) && !FIELD_PATTERNS.title.test(label(field)) && !/search/i.test(label(field))) || null;
  }
  return fields.find(field => pattern.test(label(field))) || null;
}

function findSwitch(form, pattern) {
  return (form.switches || []).find(item => pattern.test(item.label || '')) ||
    (form.buttons || []).filter(item => item.selected !== undefined).find(item => pattern.test(item.text || item.aria || '') && /^(true|false)$/.test(String(item.selected)) &&
      (item.role === 'switch' || /^(instrumental)$/i.test(item.text || ''))) || null;
}

function findSlider(form, pattern) {
  return (form.sliders || []).find(item => pattern.test(item.label || '')) || null;
}

// Buttons of an option group (e.g. Vocal Gender: Male / Female), by group label.
function findChoice(form, groupPattern, wanted) {
  const want = normalizeName(wanted);
  const buttons = (form.buttons || []).filter(item => groupPattern.test(item.group || '') || groupPattern.test(item.aria || ''));
  const choice = buttons.find(item => normalizeName(item.text) === want || normalizeName(item.aria) === want) || null;
  return { choice, offered: buttons.map(item => item.text || item.aria).filter(Boolean) };
}

function modeButtons(form) {
  return (form.buttons || []).filter(item => /^(simple|custom|advanced)$/i.test(item.text || ''));
}

function modelButton(form) {
  return (form.buttons || []).find(item => /^v\d+(\.\d+)?/i.test(item.text || '') && item.text.length <= 30) ||
    (form.buttons || []).find(item => /model|version/i.test(item.aria || '') && (item.popup || item.expanded !== null)) || null;
}

function labelsOf(form) {
  return [...(form.fields || []).map(item => item.label), ...(form.switches || []).map(item => item.label),
    ...(form.sliders || []).map(item => item.label)].map(value => String(value || '').split(' | ')[0]).filter(Boolean);
}

// ---- limits, refusals, clip data --------------------------------------------

const LIMIT_PATTERNS = [
  { scope: 'download', re: /download limit|reached (?:your|the) (?:monthly |daily )?download|no (?:more )?downloads? (?:left|remaining)|out of downloads|downloads? (?:are |is )?(?:limited|used up)|0 downloads? (?:left|remaining)|(?:upgrade|subscribe) to download|downloads? (?:aren't|are not) available on (?:the|your) (?:free|basic) plan/i },
  { scope: 'generate', re: /out of credits|not enough credits|insufficient credits|(?:you(?:'|’)ve|you have) (?:run out of|used (?:all|up) (?:of )?your) credits|need more credits|no credits (?:left|remaining)|credits? (?:limit|balance) (?:reached|exceeded)|get more credits|daily (?:credit|generation) limit|generation limit/i },
  { scope: 'action', re: /rate limit|too many requests|slow down|try again (?:later|in \d+)|temporarily (?:blocked|limited)|exceeded .* limit/i }
];

function detectLimit(text, action = 'generate') {
  const source = String(text || '');
  for (const pattern of LIMIT_PATTERNS) {
    const match = source.match(pattern.re);
    if (!match) continue;
    const index = match.index || 0;
    return { scope: pattern.scope === 'action' ? action : pattern.scope,
      text: source.slice(Math.max(0, index - 120), index + 220).replace(/\s+/g, ' ').trim() };
  }
  return null;
}

// Seconds until a limit lifts ("in 3 hours", "in 45 minutes", "tomorrow", "next month").
function cooldownSeconds(text, fallback = 6 * 3600) {
  const source = String(text || '');
  const hours = source.match(/in (\d+(?:\.\d+)?) ?(?:hours?|hrs?)\b/i);
  const minutes = source.match(/in (\d+) ?(?:minutes?|mins?)\b/i);
  const days = source.match(/in (\d+) ?days?\b/i);
  let seconds = 0;
  if (days) seconds += Number(days[1]) * 86400;
  if (hours) seconds += Number(hours[1]) * 3600;
  if (minutes) seconds += Number(minutes[1]) * 60;
  if (!seconds && /tomorrow|daily|midnight/i.test(source)) seconds = 12 * 3600;
  if (!seconds && /next month|monthly|billing (?:period|cycle)/i.test(source)) seconds = 3 * 86400;
  if (!seconds && /rate limit|too many requests|slow down/i.test(source)) seconds = 15 * 60;
  return Math.max(300, Math.min(7 * 86400, seconds || fallback));
}

const REFUSAL_RE = /couldn(?:'|’)t generate that|didn(?:'|’)t pass moderation|violat(?:es|ed|ing) (?:our|the) (?:terms|policies|guidelines|community)|contain(?:s)? artist name|don(?:'|’)t reference specific artists|unable to generate lyrics|inappropriate|not allowed|content policy|flagged/i;
function isRefusal(text) { return REFUSAL_RE.test(String(text || '')); }

// Clip-like objects anywhere inside an API response.
function extractClips(data, out = [], depth = 0) {
  if (!data || depth > 8 || out.length > 500) return out;
  if (Array.isArray(data)) { for (const item of data) extractClips(item, out, depth + 1); return out; }
  if (typeof data !== 'object') return out;
  if (typeof data.id === 'string' && UUID_RE.test(data.id) && data.id.length === 36 &&
      (data.status !== undefined || data.metadata || data.media_urls || data.audio_url !== undefined)) {
    out.push(data);
    return out;
  }
  for (const value of Object.values(data)) if (value && typeof value === 'object') extractClips(value, out, depth + 1);
  return out;
}

// What TEAMYRA keeps of a Suno clip object.
function clipSummary(clip) {
  if (!clip || typeof clip !== 'object') return null;
  const meta = clip.metadata && typeof clip.metadata === 'object' ? clip.metadata : {};
  const media = Array.isArray(clip.media_urls) ? clip.media_urls.filter(item => item && /^https:/.test(item.url || '')) : [];
  const status = String(clip.status || (media.length ? 'complete' : '') || '').toLowerCase() || null;
  return {
    clip_id: String(clip.id).toLowerCase(),
    title: clip.title || null,
    status,
    duration: Number(meta.duration) || null,
    style: meta.tags || clip.display_tags || null,
    display_tags: clip.display_tags || null,
    lyrics: typeof meta.prompt === 'string' ? meta.prompt : null,
    description: meta.gpt_description_prompt || null,
    instrumental: meta.make_instrumental === true || clip.make_instrumental === true,
    negative_tags: meta.negative_tags || null,
    control_sliders: meta.control_sliders || null,
    model: clip.major_model_version || clip.model_name || null,
    model_name: clip.model_name || null,
    error: meta.error_message || meta.error_type || null,
    created_at: clip.created_at || null,
    audio_url: /^https:/.test(clip.audio_url || '') && !/\/forbidden/.test(clip.audio_url) ? clip.audio_url : null,
    media_urls: media.map(item => ({ url: item.url, content_type: item.content_type || null, delivery: item.delivery || null })),
    image_url: clip.image_large_url || clip.image_url || null
  };
}

function isDone(summary) { return Boolean(summary && /^(complete|completed|succeeded|success)$/.test(summary.status || '')); }
function isFailed(summary) { return Boolean(summary && (/^(error|failed|failure)$/.test(summary.status || '') || (summary.error && !isDone(summary)))); }

// The manifest URL a page would request for a clip's progressive media URL.
function manifestFor(summary) {
  const media = (summary?.media_urls || []).find(item => /progressive/i.test(item.delivery || '') || /m4a|mp4/i.test(item.content_type || '')) || summary?.media_urls?.[0];
  if (!media) return null;
  return '/_sw-mango/manifest.m3u8?contentId=' + encodeURIComponent(summary.clip_id) + '&src=' + encodeURIComponent(media.url) + '&contentType=clip';
}

// ---- adapter ----------------------------------------------------------------

class SunoAdapter {
  constructor(webContents, { settleMs = 400 } = {}) {
    this.webContents = webContents;
    this.settleMs = settleMs;
    this.step = 'idle';
    this.pending = 0;
    this.clips = new Map();       // clip id -> latest summary seen in the page's API responses
    this.createdIds = [];         // ids from the page's own generate response, newest last
    this.fromFeed = new Set();    // clip ids a feed/library request reported (not the generate reply)
    this.capturing = false;
    this.requests = new Map();
  }

  async exec(source, timeoutMs = SCRIPT_TIMEOUT_MS) {
    let timer;
    this.pending += 1;
    try {
      return await Promise.race([
        this.webContents.executeJavaScript(source, true),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('browser_failure: Suno page script timed out (step: ' + this.step + ')')), timeoutMs); })
      ]);
    } finally { clearTimeout(timer); this.pending -= 1; }
  }

  probe(name, args) { return this.exec(probeScript(name, args)); }
  sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

  async wait(read, label, timeoutMs = 20000, everyMs = 300) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = await read().catch(error => { if (/login_required|option_unavailable|rate_limited|policy_refusal/.test(String(error?.message))) throw error; return null; });
      if (value) return value;
      await this.sleep(everyMs);
    }
    throw new Error('selector_failure: Suno ' + label + ' did not become ready (step: ' + this.step + ')');
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

  // Watch the page's own API responses (clip objects with status, lyrics, media URLs).
  async startCapture() {
    if (this.capturing) return;
    const wc = this.webContents;
    if (!wc.debugger) return;
    await this.cdp('Network.enable', { maxResourceBufferSize: 8 * 1024 * 1024, maxTotalBufferSize: 64 * 1024 * 1024 }).catch(() => null);
    this.capturing = true;
    wc.debugger.on('message', (_event, method, params) => {
      if (method === 'Network.responseReceived') {
        const url = params.response?.url || '';
        if (/^https:\/\/([a-z0-9-]+\.)*suno\.(com|ai)\//.test(url) && /\/api\//.test(url) && /json/i.test(params.response?.mimeType || '')) {
          this.requests.set(params.requestId, url);
          if (this.requests.size > 500) this.requests.delete(this.requests.keys().next().value);
        }
      } else if (method === 'Network.loadingFinished' && this.requests.has(params.requestId)) {
        const url = this.requests.get(params.requestId);
        this.requests.delete(params.requestId);
        wc.debugger.sendCommand('Network.getResponseBody', { requestId: params.requestId }).then(body => {
          const text = body.base64Encoded ? Buffer.from(body.body, 'base64').toString('utf8') : body.body;
          this.ingest(url, JSON.parse(text));
        }).catch(() => {});
      }
    });
  }

  ingest(url, data) {
    const clips = extractClips(data);
    const generateReply = /\/generate/i.test(url);
    for (const clip of clips) {
      const summary = clipSummary(clip);
      if (!summary) continue;
      if (!generateReply) this.fromFeed.add(summary.clip_id);
      const known = this.clips.get(summary.clip_id) || {};
      if (this.clips.size > 2000) this.clips.delete(this.clips.keys().next().value);
      this.clips.set(summary.clip_id, { ...known, ...Object.fromEntries(Object.entries(summary).filter(([, value]) => value !== null && !(Array.isArray(value) && !value.length))) , seen_at: Date.now() });
    }
    if (/\/generate/i.test(url)) {
      for (const clip of clips) {
        const id = String(clip.id).toLowerCase();
        if (!this.createdIds.includes(id)) this.createdIds.push(id);
      }
    }
    return clips.length;
  }

  state() { return this.probe('state'); }

  async ready({ path: wantPath = null } = {}) {
    this.step = 'page';
    return this.wait(async () => {
      const state = await this.state();
      if (state.signedOut) throw new Error('login_required: this Suno account is not signed in (open it in the Agents panel and sign in)');
      if (wantPath && !state.path.startsWith(wantPath)) return null;
      // The Create panel draws a few seconds after the page loads: wait for
      // its Create button (2026-11-21: a job read the form too early and
      // found no Simple/Advanced tabs).
      if (state.path.startsWith('/create') && !state.createButton) return null;
      return state;
    }, 'page', 45000, 500);
  }

  async signedIn() {
    const state = await this.state().catch(() => null);
    if (state?.signedOut) return { signedIn: false, credits: null };
    if (state?.signedIn) return { signedIn: true, credits: state.credits ?? null };
    const session = await this.probe('session').catch(() => ({ ok: false }));
    if (session.ok) return { signedIn: session.signedIn === true || (state?.credits ?? null) !== null, credits: state?.credits ?? null, models: session.models };
    return { signedIn: state ? !state.signedOut && state.credits !== null : null, credits: state?.credits ?? null };
  }

  form() { return this.probe('readForm'); }

  async key(key, modifiers = 0) {
    const codes = { Escape: 27, Enter: 13, Home: 36, End: 35, ArrowRight: 39, ArrowLeft: 37, a: 65, Backspace: 8 };
    const base = { key, code: key.length === 1 ? 'Key' + key.toUpperCase() : key, windowsVirtualKeyCode: codes[key] || 0, nativeVirtualKeyCode: codes[key] || 0, modifiers };
    await this.cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base }).catch(() => null);
    await this.cdp('Input.dispatchKeyEvent', { type: 'keyUp', ...base }).catch(() => null);
  }

  async closeMenus() { await this.key('Escape'); await this.sleep(150); }

  async setText(field, value) {
    const text = String(value ?? '');
    const done = await this.probe('setText', { idx: field.idx, value: text });
    const read = async () => String(await this.probe('readValue', { idx: field.idx }) ?? '');
    if (done?.ok && normalizeName(await read()) === normalizeName(text)) return true;
    // Fallback: select all and type, as a person would.
    if (!await this.probe('focus', { idx: field.idx })) throw new Error('selector_failure: Suno field "' + field.label + '" is gone');
    await this.key('a', 2);
    await this.key('Backspace');
    if (text) await this.cdp('Input.insertText', { text });
    const now = await read();
    if (normalizeName(now) !== normalizeName(text)) {
      if (field.maxLength && text.length > field.maxLength) {
        throw new Error('option_unavailable: Suno field "' + field.label + '" takes at most ' + field.maxLength + ' characters (got ' + text.length + ')');
      }
      throw new Error('selector_failure: Suno field "' + String(field.label).split(' | ')[0] + '" did not take the text');
    }
    return true;
  }

  async setSwitch(item, on) {
    const current = await this.probe('readValue', { idx: item.idx });
    if (Boolean(current) === Boolean(on)) return true;
    await this.probe('click', { idx: item.idx });
    await this.sleep(this.settleMs);
    if (Boolean(await this.probe('readValue', { idx: item.idx })) !== Boolean(on)) {
      throw new Error('selector_failure: Suno switch "' + String(item.label).split(' | ')[0] + '" did not turn ' + (on ? 'on' : 'off'));
    }
    return true;
  }

  async setSlider(item, value) {
    const min = Number.isFinite(item.min) ? item.min : 0;
    const max = Number.isFinite(item.max) ? item.max : 100;
    // Callers give percent; the slider may count 0-1 or 0-100.
    const target = Math.round((min + (max - min) * value / 100) * 1000) / 1000;
    if (await this.probe('setRange', { idx: item.idx, value: target })) return target;
    const keyed = await this.probe('sliderKeys', { idx: item.idx, target });
    if (keyed !== null && Math.abs(keyed - target) <= Math.max(1, (max - min) / 100)) return keyed;
    // Custom sliders ignore scripted values and the hidden tab has no keyboard
    // focus: click the track where the value lies (a real mouse event), then
    // fine-tune with the arrow keys after focusing the page.
    const track = await this.probe('sliderTrack', { idx: item.idx });
    if (track && track.width > 0) {
      const x = Math.round(track.left + track.width * Math.min(1, Math.max(0, (target - min) / ((max - min) || 1))));
      const y = Math.round(track.top + track.height / 2);
      await this.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }).catch(() => null);
      await this.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }).catch(() => null);
      await this.cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }).catch(() => null);
      await this.sleep(300);
    }
    try { this.webContents.focus(); } catch {}
    if (!await this.probe('focus', { idx: item.idx })) throw new Error('selector_failure: Suno slider "' + item.label + '" is gone');
    let current = Number(await this.probe('readValue', { idx: item.idx }));
    const step = (max - min) <= 10 ? 1 : 1;
    for (let i = 0; i < 120 && Math.abs(current - target) >= step; i += 1) {
      await this.key(current < target ? 'ArrowRight' : 'ArrowLeft');
      const next = Number(await this.probe('readValue', { idx: item.idx }));
      if (next === current) break;
      current = next;
    }
    if (Math.abs(current - target) <= (max - min) / 50) return current;
    await this.key('Home');
    current = Number(await this.probe('readValue', { idx: item.idx }));
    for (let i = 0; i < 400 && current < target - 1e-6; i += 1) {
      await this.key('ArrowRight');
      const next = Number(await this.probe('readValue', { idx: item.idx }));
      if (next === current) break;
      current = next;
    }
    if (Math.abs(current - target) > (max - min) / 50) {
      throw new Error('selector_failure: Suno slider "' + String(item.label).split(' | ')[0] + '" stopped at ' + current + ' (wanted ' + target + ')');
    }
    return current;
  }

  async menuFrom(button) {
    await this.probe('click', { idx: button.idx });
    await this.sleep(this.settleMs);
    let items = (await this.probe('menuItems')) || [];
    // The model dialog draws its rows a moment after it opens: wait until the
    // list stops growing (2026-11-21: only "Create Custom Model" was read).
    for (let i = 0; i < 12; i += 1) {
      await this.sleep(300);
      const again = (await this.probe('menuItems')) || [];
      if (again.length === items.length && items.length > 1) break;
      items = again;
    }
    if (!items.length) {
      const at = await this.probe('focus', { idx: button.idx });
      if (at) {
        await this.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: at.x, y: at.y, button: 'left', clickCount: 1 }).catch(() => null);
        await this.cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at.x, y: at.y, button: 'left', clickCount: 1 }).catch(() => null);
        await this.sleep(this.settleMs);
        items = (await this.probe('menuItems')) || [];
      }
    }
    return items;
  }

  async chooseMode(mode) {
    this.step = 'mode';
    const form = await this.form();
    const tabs = modeButtons(form);
    const want = mode === 'custom' ? /^(custom|advanced)$/i : /^simple$/i;
    const tab = tabs.find(item => want.test(item.text));
    if (!tab) {
      if (mode === 'simple' && findField(form, 'description')) return 'simple';
      if (mode === 'custom' && findField(form, 'lyrics') && findField(form, 'style')) return 'custom';
      throw new Error('option_unavailable: Suno ' + mode + ' mode is not offered on this Create page; it shows: ' +
        (tabs.map(item => item.text).join(', ') || 'no Simple/Custom switch'));
    }
    if (!tab.selected) {
      await this.probe('click', { idx: tab.idx });
      await this.sleep(Math.max(this.settleMs, 1200));
    }
    return tab.text.toLowerCase();
  }

  async expandMore() {
    const form = await this.form();
    // Only the Create panel's own "More Options" header: a bare "More" is the
    // sidebar's menu, and clicking it covered the lyrics editor (2026-11-21).
    const more = (form.buttons || []).filter(item => /^(more options|advanced options|show more options)$/i.test(item.text) && item.expanded === 'false');
    for (const item of more) { await this.probe('click', { idx: item.idx }); await this.sleep(this.settleMs); }
    return more.length;
  }

  async chooseModel(model) {
    this.step = 'model';
    // After switching Simple/Advanced the panel redraws: wait for the model button.
    const form = await this.wait(async () => { const read = await this.form(); return modelButton(read) ? read : null; },
      'model button', 8000, 300).catch(() => this.form());
    const button = modelButton(form);
    if (!model) return { model: button ? button.text : null, offered: null, default: true };
    if (button && normalizeName(button.text) === normalizeName(model)) return { model: button.text, offered: null };
    if (!button) throw new Error('option_unavailable: Suno model "' + model + '" cannot be chosen: the Create page shows no model picker');
    const items = (await this.menuFrom(button)).filter(item => item.label);
    const choice = matchOption(items, model);
    if (!choice || choice.disabled) {
      await this.closeMenus();
      throw new Error('option_unavailable: Suno model "' + model + '" is ' + (choice ? 'not available to this account (locked)' : 'not offered') +
        '; it offers: ' + describeOptions(items));
    }
    await this.probe('menuItems', { click: choice.index });
    await this.sleep(this.settleMs);
    if ((await this.probe('menuItems').catch(() => [])).length) await this.closeMenus();
    const after = modelButton(await this.form());
    if (after && !normalizeName(after.text).startsWith(normalizeName(choice.label).slice(0, 3))) {
      throw new Error('selector_failure: Suno kept model ' + after.text + ' after choosing ' + choice.label);
    }
    return { model: choice.label, offered: describeOptions(items) };
  }

  // Fill the Create page from a normalized TEAMYRA request; nothing is clicked
  // that creates anything. Returns what was set.
  async fill(request) {
    const applied = {};
    this.step = 'form';
    await this.wait(async () => {
      const form = await this.form();
      return modeButtons(form).length || findField(form, 'lyrics') || findField(form, 'style') || findField(form, 'description') ? form : null;
    }, 'Create form', 20000, 400);
    applied.mode = await this.chooseMode(request.suno_mode || 'custom');
    const model = await this.chooseModel(request.suno_model);
    applied.model = model.model;
    applied.models_offered = model.offered;
    this.step = 'fields';
    // The Lyrics and Styles sections fold away (their headers are role=button
    // with aria-expanded); a folded section has no editor (2026-11-21: a job
    // after a restart found no Lyrics field). Open them first.
    for (const name of ['Lyrics', 'Styles']) {
      const header = ((await this.form()).buttons || []).find(item => normalizeName(item.text) === normalizeName(name) && item.expanded === 'false');
      if (header) { await this.probe('click', { idx: header.idx }); await this.sleep(Math.max(this.settleMs, 600)); }
    }
    const given = key => request[key] !== null && request[key] !== undefined;
    const needsMore = request.suno_exclude_styles || request.suno_vocal_gender || given('suno_weirdness') || given('suno_style_influence') ||
      given('suno_duration') || given('suno_max_mode') || given('suno_variety') || given('suno_personalize') ||
      Object.keys(request.suno_options || {}).length;
    if (needsMore) await this.expandMore();
    let form = await this.form();
    const need = (role, label) => {
      const field = findField(form, role);
      if (!field) throw new Error('option_unavailable: the Suno Create page has no ' + label + ' field in ' + applied.mode + ' mode; it shows: ' + (labelsOf(form).join(', ') || 'nothing'));
      return field;
    };
    // Instrumental first: it can hide the lyrics box.
    const instrumental = findSwitch(form, /instrumental/i);
    if (instrumental) { await this.setSwitch(instrumental, request.instrumental === true); applied.instrumental = request.instrumental === true; }
    // v6's Advanced page has no Instrumental switch: empty lyrics make an
    // instrumental ("Leave this empty for an instrumental").
    else if (request.instrumental) applied.instrumental = 'empty lyrics';
    form = await this.form();
    if (request.suno_mode === 'custom') {
      if (request.lyrics) { await this.setText(need('lyrics', 'Lyrics'), request.lyrics); applied.lyrics = true; }
      if (request.suno_style) { await this.setText(need('style', 'Styles'), request.suno_style); applied.style = request.suno_style; }
      if (request.suno_title) { await this.setText(need('title', 'Title'), request.suno_title); applied.title = request.suno_title; }
    } else {
      await this.setText(need('description', 'song description'), request.provider_prompt || request.prompt);
      applied.description = true;
    }
    if (request.suno_exclude_styles) { await this.setText(need('exclude', 'Exclude styles'), request.suno_exclude_styles); applied.exclude_styles = request.suno_exclude_styles; }
    if (request.suno_vocal_gender) {
      const { choice, offered } = findChoice(form, /vocal|gender|voice/i, request.suno_vocal_gender);
      if (!choice) throw new Error('option_unavailable: Suno vocal gender "' + request.suno_vocal_gender + '" is not offered; it shows: ' + (offered.join(', ') || 'no Vocal Gender option'));
      if (!choice.selected) await this.probe('click', { idx: choice.idx });
      applied.vocal_gender = request.suno_vocal_gender;
    }
    for (const [key, pattern, name] of [['suno_weirdness', /weird/i, 'Weirdness'], ['suno_style_influence', /style influence|style strength/i, 'Style Influence']]) {
      if (request[key] === null || request[key] === undefined) continue;
      const slider = findSlider(form, pattern);
      if (!slider) throw new Error('option_unavailable: the Suno Create page has no ' + name + ' slider; sliders shown: ' +
        ((form.sliders || []).map(item => String(item.label).split(' | ')[0]).join(', ') || 'none'));
      applied[key.replace('suno_', '')] = await this.setSlider(slider, request[key]);
    }
    // More Options (v6): Duration (Auto, or Custom 10-360 s), Max Mode, Variety
    // (0-4, 1 = Normal), Personalize (My taste).
    const onOff = async (pattern, name, on) => {
      const current = await this.form();
      let { choice, offered } = findChoice(current, pattern, on ? 'On' : 'Off');
      if (!choice && /taste/.test(String(pattern))) {
        // Personalize's Off/On follow its "My taste" button and have no group label.
        const buttons = current.buttons || [];
        const at = buttons.findIndex(item => /^my taste$/i.test(item.text || ''));
        if (at >= 0) choice = buttons.slice(at + 1, at + 3).find(item => normalizeName(item.text) === (on ? 'on' : 'off')) || null;
      }
      if (!choice) throw new Error('option_unavailable: Suno ' + name + ' is not offered; it shows: ' + (offered.join(', ') || 'no ' + name + ' option'));
      if (!choice.selected) { await this.probe('click', { idx: choice.idx }); await this.sleep(this.settleMs); }
      return on;
    };
    const exact = async (pattern, name, value) => {
      const slider = findSlider(await this.form(), pattern);
      if (!slider) throw new Error('option_unavailable: the Suno Create page has no ' + name + ' slider');
      const min = Number.isFinite(slider.min) ? slider.min : 0;
      const max = Number.isFinite(slider.max) ? slider.max : 100;
      if (value < min || value > max) throw new Error('option_unavailable: Suno ' + name + ' takes ' + min + '-' + max + ', not ' + value);
      return this.setSlider(slider, max > min ? (value - min) * 100 / (max - min) : 0);
    };
    if (given('suno_duration')) {
      const auto = request.suno_duration === 'auto';
      const { choice, offered } = findChoice(await this.form(), /duration/i, auto ? 'Auto' : 'Custom');
      if (!choice) throw new Error('option_unavailable: Suno Duration is not offered; it shows: ' + (offered.join(', ') || 'no Duration option'));
      if (!choice.selected) { await this.probe('click', { idx: choice.idx }); await this.sleep(this.settleMs); }
      applied.duration = auto ? 'auto' : await exact(/duration/i, 'Duration', Number(request.suno_duration));
    }
    if (given('suno_max_mode')) applied.max_mode = await onOff(/max mode/i, 'Max Mode', request.suno_max_mode === true);
    if (given('suno_variety')) applied.variety = await exact(/variety/i, 'Variety', Number(request.suno_variety));
    if (given('suno_personalize')) applied.personalize = await onOff(/personali[sz]e|my taste/i, 'Personalize', request.suno_personalize === true);
    for (const [name, value] of Object.entries(request.suno_options || {})) applied[name] = await this.setOption(await this.form(), name, value);
    this.step = 'filled';
    return applied;
  }

  // Any other visible option by its label: text field, switch, slider, choice or menu.
  async setOption(form, name, value) {
    const want = normalizeName(name);
    const has = label => normalizeName(String(label || '').split(' | ')[0]).includes(want) || normalizeName(label).includes(want);
    const field = (form.fields || []).find(item => has(item.label));
    if (field) { await this.setText(field, String(value)); return value; }
    const toggle = (form.switches || []).find(item => has(item.label));
    if (toggle) { await this.setSwitch(toggle, value === true || /^(on|true|yes|1)$/i.test(String(value))); return value; }
    const slider = (form.sliders || []).find(item => has(item.label));
    if (slider) return this.setSlider(slider, Number(value));
    const group = (form.buttons || []).filter(item => has(item.group));
    const choice = group.find(item => normalizeName(item.text) === normalizeName(value));
    if (choice) { if (!choice.selected) await this.probe('click', { idx: choice.idx }); return value; }
    const menu = (form.buttons || []).find(item => (item.popup || item.role === 'combobox') && has(item.aria || item.group));
    if (menu) {
      const items = await this.menuFrom(menu);
      const entry = matchOption(items, value);
      if (!entry || entry.disabled) { await this.closeMenus(); throw new Error('option_unavailable: Suno option "' + name + '" has no choice "' + value + '"; it offers: ' + describeOptions(items)); }
      await this.probe('menuItems', { click: entry.index });
      return entry.label;
    }
    if (group.length) throw new Error('option_unavailable: Suno option "' + name + '" has no choice "' + value + '"; it offers: ' + group.map(item => item.text).join(', '));
    throw new Error('option_unavailable: the Suno Create page has no option "' + name + '"; it shows: ' + (labelsOf(form).join(', ') || 'nothing'));
  }

  clipIds() { return this.probe('clipIds'); }

  async clickCreate() {
    this.step = 'create';
    const state = await this.wait(async () => {
      const value = await this.state();
      return value.createButton && !value.createButton.disabled ? value : null;
    }, 'Create button', 20000, 400);
    const form = await this.form();
    const button = (form.buttons || []).filter(item => /^create\b/i.test(item.text) && item.text.length < 24 && !item.disabled).pop();
    if (!button) throw new Error('selector_failure: Suno Create button not found');
    this.createClickedAt = Date.now();
    await this.probe('click', { idx: button.idx });
    return state;
  }

  // Clips the page's own requests reported as created after our Create click
  // (with the request's title when given), newest first.
  // Only clips a feed/library request listed: the ids in the generate reply
  // are not the finished clips' ids (2026-11-21: Suno v6 lists other ids).
  clipsCreatedSince(since, title = '') {
    const want = normalizeName(title);
    return [...this.clips.entries()]
      .filter(([id]) => this.fromFeed.has(id))
      .map(([id, clip]) => ({ id, clip, at: Date.parse(clip.created_at || '') || 0 }))
      .filter(item => item.at >= since - 15000 && (!want || normalizeName(item.clip.title || '') === want))
      .sort((a, b) => b.at - a.at)
      .map(item => item.id);
  }

  // The new clip ids after Create: from the page's generate response, else new rows.
  async newClips(before, { timeoutMs = 90000, everyMs = 1000, action = 'generate', title = '', refresh = null, refreshEveryMs = 8000 } = {}) {
    this.step = 'new clips';
    const known = new Set(before);
    const since = this.createClickedAt || Date.now();
    const deadline = Date.now() + timeoutMs;
    let refreshedAt = Date.now();
    while (Date.now() < deadline) {
      // The Create page does not always refresh its song list; the Library
      // page's own requests list every clip with its creation time
      // (2026-11-21: two live jobs never saw their new clips on /create).
      if (refresh && Date.now() - refreshedAt >= refreshEveryMs) {
        refreshedAt = Date.now();
        await refresh().catch(() => null);
        await this.sleep(2500);
      }
      // Clips created after the click, as the page's own feed reports them
      // (2026-11-21: an id from the generate reply that was not a clip was
      // followed for 15 minutes while both real clips were done).
      const fresh = this.clipsCreatedSince(since, title).filter(id => !known.has(id));
      if (fresh.length >= 2) return { ids: fresh.slice(0, 2), via: 'feed' };
      // New song rows on the page are finished clips too; with a title, only
      // rows whose known title matches (another app may create songs in the
      // same account at the same time).
      const want = normalizeName(title);
      const rows = (await this.clipIds().catch(() => [])).filter(id => !known.has(id) &&
        (!want || !this.clips.has(id) || normalizeName(this.clips.get(id).title || '') === want));
      if (rows.length >= 2) return { ids: rows.slice(0, 2), via: 'page' };
      if (fresh.length === 1 && Date.now() > since + 45000) return { ids: fresh, via: 'feed' };
      const state = await this.state().catch(() => null);
      const limit = detectLimit(state?.notices, action);
      if (limit) return { ids: [], limit };
      if (isRefusal(state?.notices)) return { ids: [], refusal: String(state.notices).slice(0, 600) };
      await this.sleep(everyMs);
    }
    // Only ids that are clips (seen with clip data): a generate reply also
    // carries ids that are not clips.
    const fresh = this.clipsCreatedSince(since, title).filter(id => !known.has(id));
    // Nothing listed yet: the generate reply's ids as a last resort; the wait
    // that follows re-reads the Library and switches to the listed clips.
    const ids = fresh.length ? fresh : this.createdIds.filter(id => !known.has(id));
    return { ids: ids.slice(0, 2), via: fresh.length ? 'feed' : 'timeout' };
  }

  async embedded(ids) {
    const found = (await this.probe('embeddedClips', { ids }).catch(() => ({}))) || {};
    const result = {};
    for (const [id, clip] of Object.entries(found)) {
      const summary = clipSummary(clip);
      if (summary) { result[id] = summary; this.ingest('embedded', clip); }
    }
    return result;
  }

  // The clip's playback audio as the page plays it, without any Download.
  async captureStream(summary, { playTimeoutMs = 8000 } = {}) {
    this.step = 'preview';
    let urls = await this.probe('playbackUrl', { id: summary.clip_id });
    let source = 'page_request';
    // The page's own player does not list its stream request where it can be
    // read, so pressing Play cost a 25 s wait per clip before the stream was
    // built from the clip's media URL anyway: build it at once when the page's
    // service worker is there (2026-11-21).
    const built = urls.serviceWorker ? manifestFor(summary) : null;
    if (!urls.manifest && built) { urls = { ...urls, manifest: built }; source = 'media_url'; }
    if (!urls.manifest) {
      // Start playback (the view is muted) so the page requests its own stream.
      if (await this.probe('clickPlay')) {
        const deadline = Date.now() + playTimeoutMs;
        while (Date.now() < deadline && !urls.manifest) {
          await this.sleep(500);
          urls = await this.probe('playbackUrl', { id: summary.clip_id });
        }
      }
      await this.probe('pause').catch(() => null);
    }
    let manifest = urls.manifest;
    if (!manifest && urls.serviceWorker) { manifest = manifestFor(summary); source = 'media_url'; }
    if (manifest) {
      const read = await this.exec(probeScript('readStream', { manifest }), 240000);
      if (read?.ok) return { ...read, via: 'stream_segments', manifest_source: source };
      if (!summary.audio_url) throw new Error('download_failure: could not read the Suno playback stream (' + (read?.step || '') + ' ' + (read?.status || read?.error || '') + ')');
    }
    if (summary.audio_url) {
      const read = await this.exec(probeScript('readUrl', { src: summary.audio_url }), 240000);
      if (read?.ok) return { ...read, via: 'audio_url' };
      throw new Error('download_failure: could not read the Suno playback audio (' + (read?.status || read?.error) + ')');
    }
    throw new Error('download_failure: the Suno page offers no playback stream for clip ' + summary.clip_id);
  }

  // Suno's own Download for the open song page: More options -> Download -> MP3/WAV audio.
  async clickDownload(format) {
    this.step = 'download menu';
    const button = await this.wait(() => this.probe('clipMenuButton'), 'clip menu', 20000, 500);
    const items = await this.menuFrom(button);
    const download = items.find(item => /^download\b/i.test(item.label || item.text));
    if (!download) {
      await this.closeMenus();
      const state = await this.state().catch(() => null);
      const limit = detectLimit(state?.notices, 'download');
      if (limit) return { limit };
      throw new Error('option_unavailable: the Suno clip menu has no Download; it offers: ' + describeOptions(items));
    }
    if (download.disabled) {
      await this.closeMenus();
      return { limit: { scope: 'download', text: 'Download is disabled for this clip in this account: ' + (download.text || '') } };
    }
    await this.probe('menuItems', { click: download.index, hover: true });
    await this.sleep(this.settleMs + 300);
    const sub = (await this.probe('menuItems')) || [];
    const wanted = format === 'wav' ? /^wav\b/i : /^mp3\b/i;
    const entry = sub.find(item => wanted.test(item.label || item.text));
    if (!entry || entry.disabled) {
      await this.closeMenus();
      const state = await this.state().catch(() => null);
      const limit = detectLimit((state?.notices || '') + '\n' + (entry?.text || ''), 'download');
      if (limit) return { limit };
      throw new Error('option_unavailable: Suno offers no ' + format.toUpperCase() + ' download for this clip' + (entry ? ' in this account (locked: ' + entry.text + ')' : '') +
        '; the Download menu offers: ' + describeOptions(sub.filter(item => /audio|video|mp3|wav|stem/i.test(item.text))));
    }
    await this.probe('menuItems', { click: entry.index });
    return { clicked: entry.label };
  }

  // A WAV is prepared first; its dialog then shows a Download button.
  async confirmPreparedDownload(timeoutMs = 180000) {
    this.step = 'prepared download';
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const items = (await this.probe('menuItems').catch(() => [])) || [];
      const button = items.find(item => /^download\b/i.test(item.label || item.text) && !item.disabled && /[“"']|\.wav|file/i.test(item.text || ''));
      if (button) { await this.probe('menuItems', { click: button.index }); return true; }
      const state = await this.state().catch(() => null);
      const limit = detectLimit(state?.notices, 'download');
      if (limit) return { limit };
      await this.sleep(1000);
    }
    return false;
  }

  clipRows(limit) { return this.probe('clipRows', { limit }); }
}

module.exports = {
  SunoAdapter, PROBES, probeScript, normalizeName, matchOption, describeOptions, findField, findSwitch, findSlider, findChoice,
  modeButtons, modelButton, detectLimit, cooldownSeconds, isRefusal, extractClips, clipSummary, isDone, isFailed, manifestFor, UUID_RE
};
