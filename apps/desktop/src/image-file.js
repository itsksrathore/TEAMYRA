// Site-independent helpers for saving images that a web chat generated:
// format and pixel size from the bytes, the format a target path asks for,
// and in-page scripts to read a blob:/data: image or re-encode an image (the
// page has the browser's decoders; the main process has none for WebP).

const MAX_IMAGE_BYTES = 50 * 1024 * 1024;
const FORMATS = {
  png: { mime: 'image/png', extensions: ['.png'] },
  jpeg: { mime: 'image/jpeg', extensions: ['.jpg', '.jpeg'] },
  webp: { mime: 'image/webp', extensions: ['.webp'] },
  gif: { mime: 'image/gif', extensions: ['.gif'] }
};
// Formats a canvas can write (GIF cannot be encoded by the browser).
const WRITABLE_FORMATS = new Set(['png', 'jpeg', 'webp']);

function formatForPath(filePath) {
  const lower = String(filePath || '').toLowerCase();
  for (const [format, { extensions }] of Object.entries(FORMATS)) {
    if (extensions.some(extension => lower.endsWith(extension))) return format;
  }
  return null;
}

// { format, mime, width, height } from the file header, or null when the
// bytes are not a PNG, JPEG, WebP or GIF image.
function imageInfo(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  const result = (format, width, height) => (width > 0 && height > 0
    ? { format, mime: FORMATS[format].mime, width, height } : null);
  if (bytes.length >= 24 && bytes.readUInt32BE(0) === 0x89504e47 && bytes.readUInt32BE(4) === 0x0d0a1a0a &&
      bytes.toString('latin1', 12, 16) === 'IHDR') {
    return result('png', bytes.readUInt32BE(16), bytes.readUInt32BE(20));
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) { offset += 1; continue; }
      const marker = bytes[offset + 1];
      if (marker === 0xff) { offset += 1; continue; }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
      const length = bytes.readUInt16BE(offset + 2);
      // SOF0..SOF15 except DHT (C4), JPG (C8) and DAC (CC) carry the size.
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return result('jpeg', bytes.readUInt16BE(offset + 7), bytes.readUInt16BE(offset + 5));
      }
      if (length < 2) return null;
      offset += 2 + length;
    }
    return null;
  }
  if (bytes.length >= 30 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') {
    const chunk = bytes.toString('latin1', 12, 16);
    if (chunk === 'VP8X') return result('webp', 1 + bytes.readUIntLE(24, 3), 1 + bytes.readUIntLE(27, 3));
    if (chunk === 'VP8L' && bytes[20] === 0x2f) {
      const bits = bytes.readUInt32LE(21);
      return result('webp', 1 + (bits & 0x3fff), 1 + ((bits >> 14) & 0x3fff));
    }
    if (chunk === 'VP8 ' && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
      return result('webp', bytes.readUInt16LE(26) & 0x3fff, bytes.readUInt16LE(28) & 0x3fff);
    }
    return null;
  }
  if (bytes.length >= 10 && /^GIF8[79]a$/.test(bytes.toString('latin1', 0, 6))) {
    return result('gif', bytes.readUInt16LE(6), bytes.readUInt16LE(8));
  }
  return null;
}

// Browser-side base64 encoding of a Uint8Array without a giant argument list.
const BASE64_JS = `const teamyraBase64 = bytes => {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
};`;

// Page script: reads a blob:/data: (or same-origin) image URL with the page's
// own fetch. Resolves to { ok, type, base64 } or { ok:false, error }.
function readInPageScript(src, maxBytes = MAX_IMAGE_BYTES) {
  return `(async () => {${BASE64_JS}
    try {
      const response = await fetch(${JSON.stringify(String(src))}, { credentials: 'include' });
      if (!response.ok) return { ok: false, error: 'HTTP ' + response.status };
      const blob = await response.blob();
      if (blob.size > ${Number(maxBytes)}) return { ok: false, error: 'image is larger than ${Math.round(maxBytes / 1048576)} MB' };
      return { ok: true, type: blob.type || '', base64: teamyraBase64(new Uint8Array(await blob.arrayBuffer())) };
    } catch (error) { return { ok: false, error: String(error && error.message || error) }; }
  })()`;
}

// Page script: decodes image bytes and encodes them as `mime` at full size.
// Resolves to { ok, base64, width, height } or { ok:false, error }.
function transcodeScript(base64, mime) {
  return `(async () => {${BASE64_JS}
    try {
      const binary = atob(${JSON.stringify(String(base64))});
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      const bitmap = await createImageBitmap(new Blob([bytes]));
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      canvas.getContext('2d').drawImage(bitmap, 0, 0);
      const blob = await canvas.convertToBlob({ type: ${JSON.stringify(String(mime))}, quality: 0.95 });
      return { ok: true, base64: teamyraBase64(new Uint8Array(await blob.arrayBuffer())), width: bitmap.width, height: bitmap.height };
    } catch (error) { return { ok: false, error: String(error && error.message || error) }; }
  })()`;
}

module.exports = {
  MAX_IMAGE_BYTES, FORMATS, WRITABLE_FORMATS, formatForPath, imageInfo, readInPageScript, transcodeScript
};
