const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { resolveFfmpeg } = require('./media-audio-processor');

// Audio checks for Suno clips: what the file really is (header sniff), its
// duration/bitrate/codec, loudness (volumedetect) and silences (silencedetect)
// from one FFmpeg pass, plus hints a caller's AI can use to reject a bad clip
// before spending a download. An optional transcript comes from a local
// Whisper CLI when one is installed (TEAMYRA_WHISPER or `whisper` on PATH);
// nothing is installed.

function sniffAudio(buffer) {
  const b = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  if (b.length >= 12 && b.toString('ascii', 4, 8) === 'ftyp') return { ext: 'm4a', container: 'mp4' };
  if (b.length >= 8 && b.toString('ascii', 4, 8) === 'moof') return { ext: 'm4a', container: 'fmp4' };
  if (b.length >= 3 && b.toString('ascii', 0, 3) === 'ID3') return { ext: 'mp3', container: 'mp3' };
  if (b.length >= 2 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0 && (b[1] & 0x06) !== 0) return { ext: 'mp3', container: 'mp3' };
  if (b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WAVE') return { ext: 'wav', container: 'wav' };
  if (b.length >= 4 && b.toString('ascii', 0, 4) === 'OggS') return { ext: 'ogg', container: 'ogg' };
  if (b.length >= 4 && b.toString('ascii', 0, 4) === 'fLaC') return { ext: 'flac', container: 'flac' };
  if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return { ext: 'webm', container: 'webm' };
  return null;
}

function seconds(text) {
  const match = String(text || '').match(/(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/);
  return match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) : null;
}

// One FFmpeg stderr report (volumedetect + silencedetect) as numbers and hints.
function parseFfmpegReport(stderr, { silenceDb = -45 } = {}) {
  const text = String(stderr || '');
  const durationLine = text.match(/Duration:\s*([\d:.]+)(?:,\s*start:[^,]*)?(?:,\s*bitrate:\s*(\d+)\s*kb\/s)?/);
  const audio = text.match(/Stream #[^\n]*Audio:\s*([^,\s(]+)[^\n]*?(\d{4,6}) Hz,\s*([^,\n]+)/);
  const streamRate = text.match(/Stream #[^\n]*Audio:[^\n]*?(\d+) kb\/s/);
  // The decoded length (time= of the last progress line) beats a missing header duration.
  const times = [...text.matchAll(/time=\s*([\d:.]+)/g)].map(match => seconds(match[1])).filter(Number.isFinite);
  const mean = text.match(/mean_volume:\s*(-?[\d.]+|-inf) dB/);
  const max = text.match(/max_volume:\s*(-?[\d.]+|-inf) dB/);
  const silences = [];
  let open = null;
  for (const line of text.split(/\r?\n/)) {
    const start = line.match(/silence_start:\s*(-?[\d.]+)/);
    const end = line.match(/silence_end:\s*(-?[\d.]+)\s*\|\s*silence_duration:\s*([\d.]+)/);
    if (start) open = Math.max(0, Number(start[1]));
    if (end) {
      silences.push({ start: open ?? Math.max(0, Number(end[1]) - Number(end[2])), end: Number(end[1]), duration: Number(end[2]) });
      open = null;
    }
  }
  const headerDuration = durationLine ? seconds(durationLine[1]) : null;
  const decoded = times.length ? Math.max(...times) : null;
  const duration = Number.isFinite(headerDuration) && headerDuration > 0 ? headerDuration : decoded;
  if (open !== null && Number.isFinite(duration)) silences.push({ start: open, end: duration, duration: Math.max(0, duration - open), open_ended: true });
  const level = value => value ? (value[1] === '-inf' ? -Infinity : Number(value[1])) : null;
  const report = {
    duration: Number.isFinite(duration) ? Math.round(duration * 100) / 100 : null,
    decoded_duration: Number.isFinite(decoded) ? Math.round(decoded * 100) / 100 : null,
    bitrate_kbps: Number(streamRate?.[1] || durationLine?.[2] || 0) || null,
    codec: audio ? audio[1] : null,
    sample_rate: audio ? Number(audio[2]) : null,
    channels: audio ? audio[3].trim() : null,
    mean_volume_db: level(mean),
    max_volume_db: level(max),
    silence_threshold_db: silenceDb,
    silences: silences.slice(0, 50),
    silence_seconds: Math.round(silences.reduce((sum, item) => sum + item.duration, 0) * 100) / 100
  };
  report.hints = audioHints(report);
  return report;
}

function audioHints(report) {
  const hints = [];
  const d = report.duration || 0;
  if (!d) hints.push('no_duration: the audio has no measurable length');
  else if (d < 30) hints.push('short: only ' + d.toFixed(1) + ' s long');
  if (report.mean_volume_db === -Infinity || (report.max_volume_db !== null && report.max_volume_db < -40)) hints.push('silent: the clip is (almost) silent');
  else if (report.mean_volume_db !== null && report.mean_volume_db < -30) hints.push('very_quiet: mean volume ' + report.mean_volume_db + ' dB');
  if (report.max_volume_db !== null && report.max_volume_db >= -0.05 && report.mean_volume_db > -8) hints.push('loud_or_clipping: peaks at 0 dB with a mean of ' + report.mean_volume_db + ' dB');
  if (d && report.silence_seconds / d > 0.2) hints.push('long_silences: ' + report.silence_seconds + ' s of silence in ' + d + ' s');
  const first = report.silences[0];
  if (first && first.start <= 0.1 && first.duration >= 3) hints.push('silent_start: the first ' + first.duration.toFixed(1) + ' s are silent');
  const middle = report.silences.filter(item => item.start > 5 && item.end < d - 5 && item.duration >= 4);
  if (middle.length) hints.push('gap: ' + middle.length + ' silent gap(s) of 4 s or more inside the song');
  const last = report.silences[report.silences.length - 1];
  if (last && d && last.end >= d - 0.5 && last.duration >= 8) hints.push('silent_end: the last ' + last.duration.toFixed(1) + ' s are silent');
  return hints;
}

function runFfmpeg(args, { exec = execFile, ffmpeg = resolveFfmpeg(), timeout = 180000 } = {}) {
  if (!ffmpeg) return Promise.reject(new Error('download_failure: FFmpeg is unavailable for audio checks'));
  return new Promise((resolve, reject) => {
    exec(ffmpeg, args, { windowsHide: true, timeout, maxBuffer: 8 * 1024 * 1024 }, (error, _stdout, stderr) => {
      if (error && !/mean_volume|silence_|time=/.test(String(stderr || ''))) {
        reject(new Error('download_failure: the audio could not be decoded: ' + String(stderr || error.message).slice(-600)));
      } else resolve(String(stderr || ''));
    });
  });
}

async function analyzeAudio(file, options = {}) {
  const silenceDb = options.silenceDb ?? -45;
  const stderr = await runFfmpeg(['-hide_banner', '-nostats', '-stats_period', '5', '-i', file, '-vn',
    '-af', 'volumedetect,silencedetect=n=' + silenceDb + 'dB:d=2', '-f', 'null', '-'], options);
  const report = parseFfmpegReport(stderr, { silenceDb });
  if (!report.codec) throw new Error('download_failure: no audio stream in ' + path.basename(file));
  if (!report.duration || report.duration <= 0) throw new Error('download_failure: the audio has no duration');
  return report;
}

// A local Whisper CLI, when one exists. Never installs anything.
function findWhisper({ env = process.env, exists = fs.existsSync } = {}) {
  if (env.TEAMYRA_WHISPER === '0') return '';
  if (env.TEAMYRA_WHISPER && exists(env.TEAMYRA_WHISPER)) return env.TEAMYRA_WHISPER;
  const names = process.platform === 'win32' ? ['whisper.exe', 'whisper.cmd', 'whisper.bat'] : ['whisper'];
  for (const dir of String(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean)) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (exists(candidate)) return candidate;
    }
  }
  return '';
}

function transcribe(file, { whisper = findWhisper(), exec = execFile, timeout = 6 * 60 * 1000, model = process.env.TEAMYRA_WHISPER_MODEL || 'base' } = {}) {
  if (!whisper) return Promise.resolve({ available: false });
  const outDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'teamyra-whisper-'));
  return new Promise(resolve => {
    exec(whisper, [file, '--model', model, '--output_format', 'txt', '--output_dir', outDir, '--fp16', 'False'],
      { windowsHide: true, timeout, maxBuffer: 8 * 1024 * 1024, shell: /\.(cmd|bat)$/i.test(whisper) }, error => {
        let text = '';
        try {
          const name = fs.readdirSync(outDir).find(item => item.endsWith('.txt'));
          if (name) text = fs.readFileSync(path.join(outDir, name), 'utf8').trim();
        } catch {}
        try { fs.rmSync(outDir, { recursive: true, force: true }); } catch {}
        resolve(text ? { available: true, model, text: text.slice(0, 20000) }
          : { available: true, model, error: String(error?.message || 'no transcript').slice(0, 300) });
      });
  });
}

module.exports = { sniffAudio, parseFfmpegReport, audioHints, analyzeAudio, findWhisper, transcribe };
