const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

const SOURCE_ROOT = path.resolve(__dirname, '..', '..', '..');
const ROOT = path.resolve(process.env.TEAMYRA_ROOT || SOURCE_ROOT);
const DESKTOP_API = path.join(SOURCE_ROOT, 'bridge', 'desktop_api.py');
const PACKAGED_CORE = process.env.TEAMYRA_CORE_EXE ||
  (process.resourcesPath ? path.join(process.resourcesPath, 'teamyra-core', 'teamyra-core.exe') : '');
let cachedPython = null;

function execFilePromise(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, {
      windowsHide: true,
      timeout: options.timeout || 30000,
      maxBuffer: options.maxBuffer || 4 * 1024 * 1024,
      encoding: 'utf8',
      ...options
    }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout || '';
        error.stderr = stderr || '';
        reject(error);
        return;
      }
      resolve({ stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

function windowsPythonCandidates() {
  const candidates = [];
  const add = value => {
    if (value && !candidates.some(item => item.file === value)) {
      candidates.push({ file: value, prefix: [] });
    }
  };

  add(process.env.TEAMYRA_PYTHON);

  const local = process.env.LOCALAPPDATA;
  if (local) {
    const base = path.join(local, 'Programs', 'Python');
    try {
      const dirs = fs.readdirSync(base, { withFileTypes: true })
        .filter(entry => entry.isDirectory() && /^Python/i.test(entry.name))
        .sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }));
      for (const dir of dirs) add(path.join(base, dir.name, 'python.exe'));
    } catch {}
  }

  return candidates.filter(item => {
    try { return fs.existsSync(item.file); } catch { return false; }
  });
}

async function resolvePython() {
  if (cachedPython) return cachedPython;

  const direct = [];
  if (process.env.TEAMYRA_PYTHON) {
    direct.push({ file: process.env.TEAMYRA_PYTHON, prefix: [] });
  }
  direct.push(
    { file: process.platform === 'win32' ? 'python.exe' : 'python3', prefix: [] },
    { file: 'python', prefix: [] }
  );
  if (process.platform === 'win32') {
    direct.push({ file: 'py.exe', prefix: ['-3'] }, ...windowsPythonCandidates());
  }

  for (const candidate of direct) {
    try {
      await execFilePromise(candidate.file, [...candidate.prefix, '--version'], { timeout: 5000 });
      cachedPython = candidate;
      return candidate;
    } catch {}
  }
  throw new Error('Python 3 was not found. Set TEAMYRA_PYTHON to the Python executable.');
}

async function callCore(action, payload = {}, options = {}) {
  if (!/^[a-z0-9.-]+$/i.test(String(action || ''))) {
    throw new Error('Invalid core action');
  }

  let file;
  let args;
  if (process.env.TEAMYRA_CORE_EXE) {
    if (!PACKAGED_CORE || !fs.existsSync(PACKAGED_CORE)) {
      throw new Error('Bundled TEAMYRA Core is missing: ' + String(PACKAGED_CORE || process.env.TEAMYRA_CORE_EXE));
    }
    file = PACKAGED_CORE;
    args = ['__desktop-api', action, JSON.stringify(payload || {})];
  } else if (PACKAGED_CORE && fs.existsSync(PACKAGED_CORE)) {
    file = PACKAGED_CORE;
    args = ['__desktop-api', action, JSON.stringify(payload || {})];
  } else {
    const python = await resolvePython();
    file = python.file;
    args = [
      ...python.prefix,
      DESKTOP_API,
      action,
      JSON.stringify(payload || {})
    ];
  }

  const { stdout, stderr } = await execFilePromise(file, args, {
    timeout: options.timeout || 45000,
    maxBuffer: options.maxBuffer || 8 * 1024 * 1024,
    env: {
      ...process.env,
      TEAMYRA_ROOT: ROOT,
      ...(PACKAGED_CORE && fs.existsSync(PACKAGED_CORE) ? { TEAMYRA_CORE_EXE: PACKAGED_CORE } : {}),
      ...(options.env || {})
    }
  });

  let response;
  try {
    response = JSON.parse(stdout);
  } catch {
    throw new Error('TEAMYRA Core returned invalid JSON' + (stderr ? ': ' + stderr.trim() : ''));
  }
  if (!response || response.ok !== true) {
    throw new Error(response?.error || stderr.trim() || 'TEAMYRA Core request failed');
  }
  return response.result;
}

module.exports = { ROOT, SOURCE_ROOT, PACKAGED_CORE, callCore, resolvePython };
