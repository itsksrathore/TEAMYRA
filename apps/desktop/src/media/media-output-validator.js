const { execFile } = require('node:child_process');
const { resolveFfmpeg } = require('./media-audio-processor');

function convertImage(source, destination, format) {
  const ffmpeg = resolveFfmpeg();
  if (!ffmpeg) throw new Error('download_failure: FFmpeg image conversion unavailable');
  const codec = { png: 'png', jpg: 'mjpeg', jpeg: 'mjpeg', webp: 'libwebp' }[format];
  if (!codec) throw new Error('download_failure: unsupported image format');
  return new Promise((resolve, reject) => {
    execFile(ffmpeg, ['-y', '-i', source, '-map', '0:v:0', '-frames:v', '1', '-c:v', codec, destination],
      { windowsHide: true, timeout: 180000 }, error => error ? reject(error) : resolve(destination));
  });
}

function verifyMediaOutput(file, request, downloadAction = {}) {
  const ffmpeg = resolveFfmpeg();
  if (!ffmpeg) throw new Error('download_failure: FFmpeg media verification unavailable');
  return new Promise((resolve, reject) => {
    execFile(ffmpeg, ['-hide_banner', '-i', file, '-t', '0.1', '-f', 'null', '-'],
      { windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 }, (error, _stdout, stderr) => {
        if (error) return reject(new Error('download_failure: downloaded file could not be decoded: ' + String(stderr).slice(-600)));
        const video = String(stderr).split(/\r?\n/).find(line => /Stream .*Video:/.test(line));
        const movingVideo = Boolean(video && request.type !== 'image' && !/\(attached pic\)/i.test(video));
        const audio = /Stream .*Audio:/.test(stderr);
        const dimensions = video?.match(/\b(\d{2,5})x(\d{2,5})\b/);
        const width = Number(dimensions?.[1] || 0);
        const height = Number(dimensions?.[2] || 0);
        const visual = request.type === 'image' || request.type === 'video';
        if (visual && (!width || !height)) return reject(new Error('download_failure: expected a visual media stream'));
        if (!visual && !audio) return reject(new Error('download_failure: expected an audio stream'));
        if (!visual && movingVideo) return reject(new Error('download_failure: expected an audio-only file'));
        if (visual && request.aspect_ratio) {
          const [rw, rh] = request.aspect_ratio.split(':').map(Number);
          if (rw && rh && Math.abs(width / height - rw / rh) > 0.02) {
            return reject(new Error('download_failure: output aspect ratio does not match request'));
          }
        }
        const quality = downloadAction.quality;
        if (request.type === 'video' && quality === '1080p' && Math.min(width, height) < 1080) {
          return reject(new Error('download_failure: video did not reach 1080p'));
        }
        if (request.type === 'image' && ['4x', '2x'].includes(quality) && Math.max(width, height) < (quality === '4x' ? 3840 : 1920)) {
          return reject(new Error('download_failure: image did not reach requested upscale size'));
        }
        resolve({ decoded: true, width: visual ? width : 0, height: visual ? height : 0, audio, video: movingVideo, cover_art: Boolean(video && /\(attached pic\)/i.test(video)) });
      });
  });
}

// Same 9x8 difference hash as the Flow tile thumbnail: area-scale to 72x64,
// average 8x8 blocks, compare horizontal neighbours. Videos hash one frame per
// second (plus the first) because a tile poster may come from any moment.
function dHashFromGray(gray) {
  const blocks = new Array(72).fill(0);
  for (let y = 0; y < 64; y += 1) for (let x = 0; x < 72; x += 1) {
    blocks[Math.floor(y / 8) * 9 + Math.floor(x / 8)] += gray[y * 72 + x];
  }
  let hex = '';
  for (let row = 0; row < 8; row += 1) {
    let byte = 0;
    for (let col = 0; col < 8; col += 1) byte = (byte << 1) | (blocks[row * 9 + col] > blocks[row * 9 + col + 1] ? 1 : 0);
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}

function mediaFingerprints(file, { maxFrames = 12 } = {}) {
  const ffmpeg = resolveFfmpeg();
  if (!ffmpeg) return Promise.resolve([]);
  const frameBytes = 72 * 64;
  return new Promise(resolve => {
    execFile(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', file,
      '-vf', "select='eq(n\,0)+gte(t-prev_selected_t\,1)',scale=72:64:flags=area,format=gray",
      '-vsync', 'vfr', '-frames:v', String(maxFrames), '-f', 'rawvideo', '-'],
    { windowsHide: true, timeout: 60000, encoding: 'buffer', maxBuffer: frameBytes * (maxFrames + 1) }, (error, stdout) => {
      if (error || !stdout?.length) return resolve([]);
      const hashes = [];
      for (let offset = 0; offset + frameBytes <= stdout.length; offset += frameBytes) {
        hashes.push(dHashFromGray(stdout.subarray(offset, offset + frameBytes)));
      }
      resolve([...new Set(hashes)]);
    });
  });
}

function hammingDistance(a, b) {
  if (!a || !b || a.length !== b.length) return 64;
  let distance = 0;
  for (let i = 0; i < a.length; i += 2) {
    let x = parseInt(a.slice(i, i + 2), 16) ^ parseInt(b.slice(i, i + 2), 16);
    while (x) { distance += x & 1; x >>= 1; }
  }
  return distance;
}

module.exports = { verifyMediaOutput, convertImage, mediaFingerprints, hammingDistance, dHashFromGray };
