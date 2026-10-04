const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

const HOME = os.homedir();
const SOURCE_ROOT = path.resolve(__dirname, '..', '..', '..');
const ROOT = path.resolve(process.env.TEAMYRA_ROOT || SOURCE_ROOT);
const PROFILES_ROOT = path.join(ROOT, 'profiles');

const PROVIDERS = [
  {
    id: 'claude',
    name: 'Claude Code',
    bin: 'claude',
    nativeHome: path.join(HOME, '.claude'),
    status: { kind: 'command', argv: ['auth', 'status', '--json'] },
    managed: { verified: true, env: 'CLAUDE_CONFIG_DIR', loginArgv: ['auth', 'login'] },
    color: 'amber'
  },
  {
    id: 'codex',
    name: 'Codex',
    bin: 'codex',
    nativeHome: path.join(HOME, '.codex'),
    status: { kind: 'files', files: [path.join(HOME, '.codex', 'auth.json')] },
    managed: { verified: true, env: 'CODEX_HOME', loginArgv: ['login', '--device-auth'] },
    color: 'green'
  },
  {
    id: 'antigravity',
    name: 'Antigravity',
    bin: 'agy',
    nativeHome: path.join(HOME, '.gemini'),
    status: { kind: 'command', argv: ['models'], timeout: 30000, successLabel: 'Existing local login detected' },
    managed: { verified: false, env: null },
    color: 'violet'
  },
  {
    id: 'chatgpt-web',
    name: 'ChatGPT Normal',
    kind: 'web',
    bin: null,
    nativeHome: null,
    status: { kind: 'web' },
    managed: { verified: false, env: null },
    color: 'blue'
  }
];

function fileExists(file) {
  try { return fs.existsSync(file); } catch { return false; }
}

function fallbackBinDirs() {
  const dirs = [];
  const add = value => { if (value && !dirs.includes(value)) dirs.push(value); };
  add(process.env.APPDATA && path.join(process.env.APPDATA, 'npm'));
  add(process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'agy', 'bin'));
  add(path.join(HOME, 'AppData', 'Roaming', 'npm'));
  add(path.join(HOME, 'AppData', 'Local', 'agy', 'bin'));
  add(path.join(HOME, '.local', 'bin'));
  return dirs;
}

function findOnDisk(bin) {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of fallbackBinDirs()) {
    for (const ext of exts) {
      const candidate = path.join(dir, bin + ext);
      if (fileExists(candidate)) return candidate;
    }
  }
  return '';
}

function whereBinary(bin) {
  return new Promise((resolve) => {
    const resolver = process.platform === 'win32' ? 'where.exe' : 'which';
    execFile(resolver, [bin], { timeout: 4000, windowsHide: true }, (err, stdout) => {
      const found = !err
        ? String(stdout || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean)
        : [];
      const preferred = process.platform === 'win32'
        ? found.find(s => /\.(exe|cmd|bat)$/i.test(s)) || found[0]
        : found[0];
      resolve(preferred || findOnDisk(bin));
    });
  });
}

function commandStatus(binary, status) {
  return new Promise((resolve) => {
    const useShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(binary);
    try {
      execFile(binary, status.argv, { timeout: status.timeout || 10000, windowsHide: true, shell: useShell }, (err, stdout, stderr) => {
        const raw = String(stdout || stderr || '').trim();
        if (err) return resolve({ signedIn: false, label: raw || 'Sign-in needed' });
        let label = status.successLabel || 'Existing local login detected';
        try {
          const data = JSON.parse(raw || '{}');
          label = data.email || data.account || data.authMethod || data.auth_method || label;
        } catch {}
        resolve({ signedIn: true, label });
      });
    } catch (error) {
      resolve({ signedIn: false, label: error.message || 'Sign-in needed' });
    }
  });
}

async function nativeStatus(provider, binary) {
  if (provider.status.kind === 'command') return commandStatus(binary, provider.status);
  const signedIn = provider.status.files.some(fileExists);
  return { signedIn, label: signedIn ? 'Existing local login detected' : 'Sign-in needed' };
}

function profileMetadata(dir, fallbackName) {
  let data = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, 'teamyra-profile.json'), 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) data = parsed;
  } catch {}

  const rawPriority = Number.parseInt(data.priority, 10);
  return {
    name: typeof data.name === 'string' && data.name.trim() ? data.name.trim() : fallbackName,
    enabled: data.enabled !== false,
    priority: Number.isFinite(rawPriority) ? Math.max(0, Math.min(rawPriority, 10000)) : 100,
    model: typeof data.model === 'string' ? data.model : '',
    effort: typeof data.effort === 'string' ? data.effort : '',
    permissionMode: typeof data.permission_mode === 'string' ? data.permission_mode : ''
  };
}

function managedProfiles(provider) {
  const profiles = [];
  const root = path.join(PROFILES_ROOT, provider.id);

  if (fileExists(root)) {
    try {
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const dir = path.join(root, entry.name);
        const signedIn = provider.id === 'codex'
          ? fileExists(path.join(dir, 'auth.json'))
          : provider.id === 'claude'
            ? fileExists(path.join(dir, '.credentials.json'))
            : false;
        const meta = profileMetadata(dir, entry.name);
        profiles.push({
          id: entry.name,
          name: meta.name,
          kind: 'managed',
          path: dir,
          signedIn,
          editable: true,
          enabled: meta.enabled,
          priority: meta.priority,
          model: meta.model,
          effort: meta.effort,
          permissionMode: meta.permissionMode
        });
      }
    } catch {}
  }

  if (provider.id === 'codex') {
    const legacy = path.join(PROFILES_ROOT, 'codex2');
    if (fileExists(legacy) && !profiles.some(profile => profile.path === legacy)) {
      const meta = profileMetadata(legacy, 'Codex 2');
      profiles.push({
        id: 'codex2',
        name: meta.name,
        kind: 'legacy',
        path: legacy,
        signedIn: fileExists(path.join(legacy, 'auth.json')),
        editable: true,
        enabled: meta.enabled,
        priority: meta.priority,
        model: meta.model,
        effort: meta.effort,
        permissionMode: meta.permissionMode
      });
    }
  }

  return profiles;
}

async function detectProviders() {
  return Promise.all(PROVIDERS.map(async (provider) => {
    if (provider.kind === 'web') {
      return {
        id: provider.id,
        name: provider.name,
        color: provider.color,
        installed: true,
        binary: 'Embedded Chromium · persistent session',
        signedIn: false,
        status: 'Open inside TEAMYRA to connect',
        managedProfilesVerified: false,
        managedProfileEnv: null,
        profiles: [{
          id: 'web',
          name: 'Teamyra Worker — ChatGPT',
          kind: 'web',
          path: '',
          signedIn: false,
          editable: false,
          enabled: true,
          priority: 250,
          model: '',
          effort: '',
          permissionMode: ''
        }]
      };
    }
    const binary = await whereBinary(provider.bin);
    const status = binary
      ? await nativeStatus(provider, binary)
      : { signedIn: false, label: 'CLI not installed' };

    const profiles = [];
    if (binary && status.signedIn) {
      profiles.push({
        id: 'native',
        name: 'Default',
        kind: 'native',
        path: provider.nativeHome,
        signedIn: true,
        editable: false,
        enabled: true,
        priority: null,
        model: '',
        effort: '',
        permissionMode: ''
      });
    }
    profiles.push(...managedProfiles(provider));

    return {
      id: provider.id,
      name: provider.name,
      color: provider.color,
      installed: Boolean(binary),
      binary,
      signedIn: status.signedIn,
      status: status.label,
      managedProfilesVerified: provider.managed.verified,
      managedProfileEnv: provider.managed.env,
      profiles
    };
  }));
}

function providerById(id) {
  return PROVIDERS.find(provider => provider.id === id) || null;
}

function profileRoot(providerId) {
  return path.join(PROFILES_ROOT, providerId);
}

module.exports = { PROVIDERS, PROFILES_ROOT, detectProviders, providerById, profileRoot, whereBinary };
