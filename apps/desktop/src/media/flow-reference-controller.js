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

// A prompt chip's image UUID: read from its attributes, else from its thumbnail.
// '' when Flow shows neither (an opaque thumbnail).
function chipId(item) {
  return String(item?.id || '').toLowerCase() || mediaId(item?.source);
}

// The chips not accounted for by the earlier ones (each identified earlier
// chip must still be there), or null. An unidentified earlier chip cannot be
// told apart, so it stays among the leftovers.
function leftoverChips(ids, beforeIds) {
  const rest = [...ids];
  for (const id of beforeIds.filter(Boolean)) {
    const index = rest.indexOf(id);
    if (index < 0) return null;
    rest.splice(index, 1);
  }
  return rest;
}

// No chip at all this long after "Add to prompt": the reference was not
// attached. Fail in seconds instead of waiting out the whole verification.
const NO_CHIP_FAIL_MS = 20000;

function canonicalSource(value) {
  try { const url = new URL(value); return (url.origin + url.pathname).replace(/=s[0-9]+(?:-[a-z0-9-]+)?$/i, ''); }
  catch { return ''; }
}

// A project file uploaded once is reused by its unique upload title for later
// jobs in the same Flow project instead of being uploaded (and added to the
// project grid) again. Keyed by project, file path, size and modification time.
const uploadedReferences = new Map();

function uploadKey(projectUrl, file) {
  const project = String(projectUrl || '').match(/\/project\/([^/?#]+)/)?.[1] || '';
  try {
    const stat = fs.statSync(file);
    return project ? [project, path.resolve(file).toLowerCase(), stat.size, Math.round(stat.mtimeMs)].join('|') : '';
  } catch { return ''; }
}

// Omni references are prompt ingredients. Never promise exact first/end frames.
class FlowReferenceController {
  constructor(adapter) { this.adapter = adapter; this.noChipFailMs = NO_CHIP_FAIL_MS; }
  async waitFor(read, label, timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const result = await read();
      if (result) return result;
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    throw new Error('selector_failure: ' + label + ' did not become ready');
  }
  // Flow asks an account to accept its upload terms ("I agree") before its
  // first upload; until someone does, no uploaded image ever appears.
  async uploadTermsShown() {
    return this.adapter.executePageScript(`[...document.querySelectorAll('button')].some(el =>
      /^\\s*i agree\\s*$/i.test(el.innerText || el.textContent || '') && el.getBoundingClientRect().width > 0)`).catch(() => false);
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
  // A chip's thumbnail is often an opaque /asb URL without the image UUID; look
  // for the UUID in the chip's stable attributes too (data-* ids, src, srcset).
  async attachments() {
    return this.adapter.executePageScript(`(() => {
      const uuid = /(?:^|\\/(?:image|video)\\/)([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})(?:$|[/?#])/i;
      const names = ['data-media-id', 'data-asset-id', 'data-media-key', 'data-id', 'src', 'srcset', 'href'];
      const idOf = el => {
        for (const node of [el, ...el.querySelectorAll('*')]) {
          for (const name of names) {
            for (const part of String(node.getAttribute(name) || '').split(/[\\s,]+/)) {
              const match = part.match(uuid);
              if (match) return match[1].toLowerCase();
            }
          }
        }
        return '';
      };
      return [...document.querySelectorAll('button[aria-label="Ingredient"]')].map(el => ({
        source: el.querySelector('img')?.getAttribute('src') || '',
        id: idOf(el),
        busy: el.getAttribute('aria-busy') === 'true'
      }));
    })()`);
  }
  async clearComposer() {
    const pickerOpen = await this.adapter.executePageScript(`document.querySelector('button[aria-label="Add ingredients to the prompt box"]')?.getAttribute('aria-expanded') === 'true'`);
    if (pickerOpen) {
      await this.clickButton('Add ingredients to the prompt box');
      await this.waitFor(() => this.adapter.executePageScript(`!document.querySelector('[role="listbox"][aria-label="Asset list"]')`), 'closed old asset picker', 5000);
    }
    if (await this.clickButton('Clear prompt')) {
      await this.waitFor(async () => (await this.attachments()).length === 0, 'cleared ingredient list', 5000);
      return;
    }
    if (!(await this.attachments()).length) return;
    // Flow only shows "Clear prompt" while the prompt has text; after a submit
    // the text is gone but the previous job's ingredient chips stay. Type one
    // character so the control appears, then clear everything with it.
    const selector = await this.adapter.promptSelector().catch(() => '');
    if (selector) {
      await this.adapter.browser.insertText(selector, ' x').catch(() => null);
      await new Promise(resolve => setTimeout(resolve, 400));
      if (await this.clickButton('Clear prompt')) {
        const cleared = await this.waitFor(async () => (await this.attachments()).length === 0, 'cleared ingredient list', 5000)
          .catch(() => false);
        if (cleared) return;
      }
      // Last resort: the chips live in the prompt editor; select all and delete.
      await this.adapter.browser.clearText(selector).catch(() => null);
      await new Promise(resolve => setTimeout(resolve, 400));
      if (!(await this.attachments()).length) return;
    }
    throw new Error('selector_failure: old reference ingredients cannot be cleared safely; attached=' +
      (await this.attachments()).length);
  }
  async pickerState() {
    return this.adapter.executePageScript(`(() => {
      const trigger = document.querySelector('button[aria-label="Add ingredients to the prompt box"]');
      const list = document.querySelector('[role="listbox"][aria-label="Asset list"]');
      const uploadControl = [...document.querySelectorAll('button')].some(el => {
        const clone = el.cloneNode(true);
        clone.querySelectorAll('mat-icon,[aria-hidden="true"]').forEach(icon => icon.remove());
        const name = (el.getAttribute('aria-label') || el.getAttribute('mattooltip') || clone.textContent || '').trim().toLowerCase();
        return name === 'upload media' && el.getBoundingClientRect().width > 0;
      });
      return { trigger: Boolean(trigger), expanded: trigger?.getAttribute('aria-expanded') || null, upload: uploadControl,
        disabled: Boolean(trigger?.disabled || trigger?.getAttribute('aria-disabled') === 'true'),
        list: Boolean(list), options: list ? list.querySelectorAll('[role="option"]').length : 0,
        overlays: [...document.querySelectorAll('.cdk-overlay-pane,[role="dialog"],flow-info-panel')]
          .filter(el => el.getBoundingClientRect().width > 0)
          .map(el => String(el.getAttribute('aria-label') || el.tagName.toLowerCase()).slice(0, 60) + ': ' +
            String(el.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 160)).slice(0, 8) };
    })()`).catch(error => ({ error: String(error?.message || error).slice(0, 200) }));
  }
  // Leftover menus, info panels or a half-closed picker intercept the trigger
  // after busy bulk activity; close them before trying again.
  async dismissOverlays() {
    await this.adapter.executePageScript(`(() => {
      document.querySelectorAll('.cdk-overlay-backdrop').forEach(el => el.click());
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
      document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', code: 'Escape', bubbles: true }));
      return true;
    })()`).catch(() => false);
    await new Promise(resolve => setTimeout(resolve, 400));
  }
  async nativeClickTrigger() {
    const selector = await this.adapter.executePageScript(`(() => {
      const el = document.querySelector('button[aria-label="Add ingredients to the prompt box"]');
      if (!el || el.disabled) return '';
      el.setAttribute('data-teamyra-ingredient-trigger', '1');
      return 'button[data-teamyra-ingredient-trigger="1"]';
    })()`).catch(() => '');
    if (!selector) return false;
    return this.adapter.browser.clickSelector(selector).catch(() => false);
  }
  async openPicker() {
    let last = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const state = await this.pickerState();
      if (state.list || (state.expanded === 'true' && state.upload)) return;
      if (attempt || state.expanded === 'true' || state.overlays?.length) await this.dismissOverlays();
      const clicked = attempt < 2 ? await this.clickButton('Add ingredients to the prompt box') : await this.nativeClickTrigger();
      if (!clicked) {
        last = await this.pickerState();
        continue;
      }
      try {
        // A project with no assets yet opens on its Upload view, without a list.
        await this.waitFor(async () => {
          const current = await this.pickerState();
          return current.list || (current.expanded === 'true' && current.upload);
        }, 'ingredient asset picker', attempt < 2 ? 15000 : 30000);
        return;
      } catch { last = await this.pickerState(); }
    }
    if (last && last.trigger === false) throw new Error('selector_failure: Omni prompt ingredient picker is unavailable; state=' + JSON.stringify(last).slice(0, 600));
    throw new Error('selector_failure: ingredient asset picker did not become ready after 3 attempts; state=' + JSON.stringify(last).slice(0, 600));
  }
  async selectUploaded(cached) {
    const rows = await this.candidates();
    // Flow may list the upload with or without its file extension.
    const titles = (cached.titles || [cached.title]).map(title => String(title).toLowerCase());
    const row = rows.find(item => titles.includes(item.title.toLowerCase()));
    if (!row) return null;
    await this.adapter.executePageScript(`document.querySelector('[data-teamyra-reference-option="' + ${JSON.stringify(row.marker)} + '"]')?.click()`);
    const preview = await this.waitFor(async () => {
      const current = await this.preview();
      return current?.title === row.title ? current : null;
    }, 'reused reference preview', 45000).catch(() => null);
    return preview ? cached.identity : null;
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
      await this.adapter.browser.uploadFiles(async () => {
        if (await this.clickButton('Upload media')) return true;
        // The empty-project view keeps Upload media behind its Upload tab.
        if (!await this.clickButton('Upload')) return false;
        await new Promise(resolve => setTimeout(resolve, 500));
        return this.clickButton('Upload media');
      }, [file]);
      let selectedTitle = '';
      let termsCheckedAt = 0;
      const selected = await this.waitFor(async () => {
        if (Date.now() - termsCheckedAt > 2000) {
          termsCheckedAt = Date.now();
          if (await this.uploadTermsShown() === true) {
            throw new Error('upload_terms_required: Google Flow asks this account to accept its upload terms ("I agree") ' +
              'before images can be uploaded; open the account in TEAMYRA and accept them');
          }
        }
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
        uploaded_titles: [...new Set([selectedTitle, uniqueName, path.basename(file)])],
        preparation: { optimized, original_bytes: originalBytes, upload_bytes: fs.statSync(file).size } };
    } finally {
      try { fs.unlinkSync(file); } catch {}
      try { fs.rmdirSync(staging); } catch {}
    }
  }
  async attach(reference) {
    const before = await this.attachments();
    const expected = mediaId(reference.provider_asset_id);
    // Bring a TEAMYRA asset's grid tile into the virtualized grid before the
    // picker opens; selectExisting binds the picker row through that tile.
    if (expected) await this.adapter.revealResult?.(expected)?.catch?.(() => false);
    await this.openPicker();
    let identity = await this.selectExisting(reference);
    let uploaded = null;
    let reused = false;
    const cacheKey = reference.path ? uploadKey(this.adapter.webContents?.getURL?.(), reference.path) : '';
    const cached = cacheKey ? uploadedReferences.get(cacheKey) : null;
    if (!identity && cached) {
      identity = await this.selectUploaded(cached);
      reused = Boolean(identity);
      if (!identity) {
        // A half-finished reuse leaves the picker on its preview; start the
        // upload from a freshly opened picker.
        await this.dismissOverlays();
        await this.openPicker();
      }
    }
    if (!identity) uploaded = await this.uploadFile(reference);
    if (!identity && !uploaded) throw new Error('selector_failure: reference image identity is unavailable');
    if (!await this.clickButton('Add to prompt')) throw new Error('selector_failure: Add to prompt is unavailable');
    const beforeIds = before.map(chipId);
    const unknownBefore = beforeIds.filter(id => !id).length;
    const addedAt = Date.now();
    let seen = null;
    let added = null;
    // Flow processes a fresh upload before its chip settles; with several Flow
    // tabs uploading at once that can take well over 20 s.
    await this.waitFor(async () => {
      const attached = await this.attachments();
      const ids = attached.map(chipId);
      const busy = attached.filter(item => item.busy).length;
      const rest = leftoverChips(ids, beforeIds);
      seen = { chips: attached.length, expected_chips: before.length + 1, busy,
        added: rest, expected_id: identity || null };
      if (attached.length <= before.length && !busy && Date.now() - addedAt > this.noChipFailMs) {
        throw new Error('reference_attach_failed: Flow did not add the reference image to the prompt within ' +
          Math.round(this.noChipFailMs / 1000) + ' s');
      }
      if (attached.length !== before.length + 1 || busy || !rest || rest.length !== unknownBefore + 1) return null;
      // One new chip, settled. Flow may show it with an opaque thumbnail (no
      // UUID): with exactly one chip added after our Add to prompt it is ours.
      // A chip showing a different image is never accepted as the expected one.
      if (identity && !rest.includes(identity) && !rest.includes('')) return null;
      added = identity || (unknownBefore ? null : rest[0] || null);
      return attached;
    }, 'verified prompt image ingredient', uploaded ? 60000 : 30000).catch(error => {
      const message = String(error?.message || error);
      throw new Error((/^reference_attach_failed/.test(message) ? message : 'reference_attach_failed: ' + message) +
        '; seen=' + JSON.stringify(seen).slice(0, 500));
    });
    identity = added || null;
    if (uploaded && cacheKey && identity) {
      if (uploadedReferences.size > 500) uploadedReferences.delete(uploadedReferences.keys().next().value);
      uploadedReferences.set(cacheKey, { title: uploaded.uploaded_name, titles: uploaded.uploaded_titles || [uploaded.uploaded_name], identity });
    }
    return { asset_id: reference.asset_id || null, path: reference.path,
      requested_roles: reference.roles || ['ingredient'], effective_role: 'ingredient',
      provider_asset_id: identity, verified: true, identity_verified: Boolean(identity), upload_preparation: uploaded?.preparation || null,
      reused_upload: reused };
  }
  // Every identified reference is still attached, and nothing else: chips
  // Flow shows without a UUID count only for references attached unidentified.
  async matches(items = []) {
    const attached = await this.attachments();
    if (attached.some(item => item.busy) || attached.length !== items.length) return false;
    const rest = leftoverChips(attached.map(chipId), items.map(item => mediaId(item.provider_asset_id)));
    return Boolean(rest) && rest.length === items.filter(item => !mediaId(item.provider_asset_id)).length;
  }
  async prepare(references = []) {
    // Flow's picker sometimes adds a second chip (a selection it kept) or never
    // shows the selected preview. Start again from an empty composer once
    // before the job is failed or requeued.
    for (let attempt = 0; ; attempt += 1) {
      await this.clearComposer();
      try {
        const items = [];
        for (const reference of references) items.push(await this.attach(reference));
        return { ok: true, mode: 'ingredients', count: items.length, items, attempts: attempt + 1 };
      } catch (error) {
        if (attempt >= 1 || !/did not become ready|reference_attach_failed/i.test(String(error?.message || error))) throw error;
        await this.dismissOverlays().catch(() => {});
      }
    }
  }
}

module.exports = { FlowReferenceController, mediaId, chipId, canonicalSource, uploadedReferences, uploadKey, NO_CHIP_FAIL_MS };
