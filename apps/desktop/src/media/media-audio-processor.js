const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

function resolveFfmpeg() {
  try {
    const bundled = require('ffmpeg-static');
    if (bundled) {
      const unpacked = bundled.includes('app.asar')
        ? bundled.replace('app.asar', 'app.asar.unpacked')
        : bundled;
      if (fs.existsSync(unpacked)) return unpacked;
      if (fs.existsSync(bundled)) return bundled;
    }
  } catch {}
  const candidates = [
    process.env.TEAMYRA_FFMPEG,
    path.join(process.resourcesPath || '', 'ffmpeg.exe')
  ].filter(Boolean);
  return candidates.find(candidate => fs.existsSync(candidate)) || '';
}

function extractAudio(videoPath, audioPath, format = 'wav') {
  const ffmpeg = resolveFfmpeg();
  if (!ffmpeg) throw new Error('Bundled FFmpeg is unavailable');
  const fmt = String(format || 'wav').toLowerCase();
  const codec = fmt === 'wav' ? ['-c:a', 'pcm_s16le'] : fmt === 'mp3' ? ['-c:a', 'libmp3lame'] : ['-c:a', 'aac'];
  fs.mkdirSync(path.dirname(audioPath), { recursive: true });
  return new Promise((resolve, reject) => {
    execFile(ffmpeg, ['-y', '-i', videoPath, '-vn', ...codec, audioPath], { windowsHide: true, timeout: 180000 }, error => {
      if (error) return reject(error);
      try {
        const stat = fs.statSync(audioPath);
        if (!stat.isFile() || stat.size <= 0) throw new Error('Extracted audio is empty');
      } catch (verifyError) {
        return reject(verifyError);
      }
      resolve({ ok: true, path: audioPath });
    });
  });
}

module.exports = { resolveFfmpeg, extractAudio };
