const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { resolveFfmpeg } = require('./media-audio-processor');

function mediaId(value) {
  const text = String(value || '');
  return text.match(/(?:^|\/(?:image|video)\/)([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})(?:$|[/?#])/i)?.[1]?.toLowerCase() || '';
}

function canonicalSource(value) {
  try { const url = new URL(value); return (url.origin + url.pathname).replace(/=s[0-9]+(?:-[a-z0-9-]+)?$/i, ''); }
  catch { return ''; }
}

// Omni references are prompt ingredients. Never promise exact first/end frames.
class FlowReferenceController {
  constructor(adapter) { this.adapter = adapter; }
  async waitFor(read, label, timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const result = await read();
      if (result) return result;
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    throw new Error('selector_failure: ' + label + ' did not become ready');
  }
  async clickButton(label) {
    return this.adapter.executePageScript(`(() => {
      const label = ${JSON.stringify(label.toLowerCase())};
      const target = [...document.querySelectorAll('button')].find(el => {
        const clone = el.cloneNode(true);
        clone.querySelectorAll('mat-icon,[aria-hidden="true"]').forEach(icon => icon.remove());
        const name = el.getAttribute('aria-label') || el.getAttribute('mattooltip') || clone.textContent || '';
        return name.trim().toLowerCase() === label && !el.disabled && el.getAttribute('aria-disabled') !== 'true';
      });
      if (!target) return false;
      target.click(); return true;
    })()`);
  }
  async attachments() {
    return this.adapter.executePageScript(`(() => [...document.querySelectorAll('button[aria-label="Ingredient"]')].map(el => ({
      source: el.querySelector('img')?.getAttribute('src') || '',
      busy: el.getAttribute('aria-busy') === 'true'
    })))()`);
  }
  async clearComposer() {
    const pickerOpen = await this.adapter.executePageScript(`document.querySelector('button[aria-label="Add ingredients to the prompt box"]')?.getAttribute('aria-expanded') === 'true'`);
    if (pickerOpen) {
      await this.clickButton('Add ingredients to the prompt box');
      await this.waitFor(() => this.adapter.executePageScript(`!document.querySelector('[role="listbox"][aria-label="Asset list"]')`), 'closed old asset picker', 5000);
    }
    if (await this.clickButton('Clear prompt')) {
      await this.waitFor(async () => (await this.attachments()).length === 0, 'cleared ingredient list', 5000);
    } else if ((await this.attachments()).length) {
      throw new Error('selector_failure: old reference ingredients cannot be cleared safely');
    }
  }
  async openPicker() {
    if (!await this.clickButton('Add ingredients to the prompt box')) {
      throw new Error('selector_failure: Omni prompt ingredient picker is unavailable');
    }
    await this.waitFor(() => this.adapter.executePageScript(`Boolean(document.querySelector('[role="listbox"][aria-label="Asset list"]'))`), 'ingredient asset picker');
  }
  async candidates() {
    return this.adapter.executePageScript(`(() => [...document.querySelectorAll('[role="listbox"][aria-label="Asset list"] [role="option"]')].map((el, index) => {
      const marker = 'teamyra-ref-' + index;
      el.setAttribute('data-teamyra-reference-option', marker);
      return { marker, title: el.querySelector('.asset-title')?.textContent?.trim() || '',
        type: el.querySelector('.type-subtitle')?.textContent?.trim().toLowerCase() || '',
        source: el.querySelector('img')?.src || '' };
    }))()`);
  }
  async preview() {
    return this.adapter.executePageScript(`(() => {
      const image = [...document.querySelectorAll('img[alt]')].find(el => (el.alt || '').startsWith('Preview of '));
      return image && image.complete && image.naturalWidth > 0
        ? { source: image.src, title: image.alt.slice('Preview of '.length) } : null;
    })()`);
  }
  async selectExisting(reference) {
    const expected = mediaId(reference.provider_asset_id);
    if (!expected) return null;
    const source = await this.adapter.executePageScript(`(() => {
      const image = [...document.querySelectorAll('flow-image-tile img[data-media-id]')].find(el =>
        el.getAttribute('data-media-id')?.toLowerCase() === ${JSON.stringify(expected)});
      return image?.src || '';
    })()`);
    // Grid data-media-id binds the opaque /asb thumbnail to the exact result.
    // Preview thumbnails alone do not expose the provider UUID.
    const expectedSource = canonicalSource(source);
    const rows = await this.candidates();
    for (const row of rows.filter(row => row.type === 'image' &&
      (mediaId(row.source) === expected || (expectedSource && canonicalSource(row.source) === expectedSource)))) {
      const clicked = await this.adapter.executePageScript(`(() => {
        const el = document.querySelector('[data-teamyra-reference-option="' + ${JSON.stringify(row.marker)} + '"]');
        if (!el || el.querySelector('.asset-title')?.textContent?.trim() !== ${JSON.stringify(row.title)}) return false;
        el.click(); return true;
      })()`);
      if (!clicked) continue;
      const preview = await this.waitFor(async () => {
        const preview = await this.preview();
        return preview?.title === row.title ? preview : null;
      }, 'selected image preview', 10000);
      if (mediaId(preview.source) === expected || (expectedSource && canonicalSource(preview.source) === expectedSource)) return expected;
    }
    return null;
  }
  async uploadFile(reference) {
    // A unique upload filename prevents selecting an unrelated existing asset
    // with the same basename. Keep the user's original file untouched.
    const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'teamyra-reference-'));
    const uniqueName = 'teamyra-' + crypto.randomUUID();
    const originalBytes = fs.statSync(reference.path).size;
    // Large provider PNGs can be silently rejected by the upload surface.
    // Keep the original; bound only the temporary ingredient upload copy.
    const optimized = originalBytes > 10 * 1024 * 1024;
    const file = path.join(staging, uniqueName + (optimized ? '.png' : path.extname(reference.path)));
    try {
      if (optimized) {
        const ffmpeg = resolveFfmpeg();
        if (!ffmpeg) throw new Error('selector_failure: large reference upload needs FFmpeg preparation');
        await new Promise((resolve, reject) => execFile(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-n',
          '-i', reference.path, '-vf', "scale=w='min(2048,iw)':h='min(2048,ih)':force_original_aspect_ratio=decrease",
          '-frames:v', '1', '-threads', '1', file], { windowsHide: true, timeout: 30000 },
          error => error ? reject(error) : resolve()));
        if (fs.statSync(file).size > 10 * 1024 * 1024) throw new Error('selector_failure: prepared reference is still too large to upload');
      } else fs.copyFileSync(reference.path, file, fs.constants.COPYFILE_EXCL);
      await this.adapter.browser.uploadFiles(() => this.clickButton('Upload media'), [file]);
      let selectedTitle = '';
      const selected = await this.waitFor(async () => {
        const rows = await this.candidates();
        const row = rows.find(row => [uniqueName.toLowerCase(), path.basename(file).toLowerCase()].includes(row.title.toLowerCase()));
        if (!row) return null;
        if (selectedTitle !== row.title) {
          await this.adapter.executePageScript(`document.querySelector('[data-teamyra-reference-option="' + ${JSON.stringify(row.marker)} + '"]')?.click()`);
          selectedTitle = row.title;
        }
        const preview = await this.preview();
        return preview?.title === selectedTitle ? preview : null;
      }, 'uniquely identified uploaded reference preview', 60000);
      // Its opaque thumbnail is tied to the unique upload; the composer reveals
      // the canonical UUID after Add to prompt, checked in attach().
      return { source: canonicalSource(selected.source), uploaded_name: uniqueName,
        preparation: { optimized, original_bytes: originalBytes, upload_bytes: fs.statSync(file).size } };
    } finally {
      try { fs.unlinkSync(file); } catch {}
      try { fs.rmdirSync(staging); } catch {}
    }
  }
  async attach(reference) {
    const before = await this.attachments();
    await this.openPicker();
    let identity = await this.selectExisting(reference);
    let uploaded = null;
    if (!identity) uploaded = await this.uploadFile(reference);
    if (!identity && !uploaded) throw new Error('selector_failure: reference image identity is unavailable');
    if (!await this.clickButton('Add to prompt')) throw new Error('selector_failure: Add to prompt is unavailable');
    const beforeIds = before.map(item => mediaId(item.source));
    const attached = await this.waitFor(async () => {
      const attached = await this.attachments();
      const ids = attached.map(item => mediaId(item.source));
      const addedIds = ids.filter(id => !beforeIds.includes(id));
      return attached.length === before.length + 1 && attached.every(item => !item.busy) &&
        ids.every(Boolean) && beforeIds.every(id => ids.includes(id)) && addedIds.length === 1 &&
        (!identity || addedIds[0] === identity) ? attached : null;
    }, 'verified prompt image ingredient');
    if (!identity) identity = attached.map(item => mediaId(item.source)).find(id => !beforeIds.includes(id));
    if (!identity) throw new Error('selector_failure: uploaded ingredient lacks a stable image ID');
    return { asset_id: reference.asset_id || null, path: reference.path,
      requested_roles: reference.roles || ['ingredient'], effective_role: 'ingredient',
      provider_asset_id: identity, verified: true, upload_preparation: uploaded?.preparation || null };
  }
  async matches(items = []) {
    const attached = await this.attachments();
    const actual = attached.map(item => mediaId(item.source)).sort();
    const expected = items.map(item => item.provider_asset_id).sort();
    return attached.every(item => !item.busy) && actual.length === expected.length &&
      actual.every((value, index) => value && value === expected[index]);
  }
  async prepare(references = []) {
    await this.clearComposer();
    const items = [];
    for (const reference of references) items.push(await this.attach(reference));
    return { ok: true, mode: 'ingredients', count: items.length, items };
  }
}

module.exports = { FlowReferenceController, mediaId, canonicalSource };
