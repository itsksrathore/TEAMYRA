const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

const HOME = os.homedir();
const ROOT = path.resolve(__dirname, '..', '..', '..');
const PROFILES_ROOT = path.join(ROOT, 'profiles');

const PROVIDERS = [
  {
    id: 'claude',
    name: 'Claude Code',
    bin: 'claude',
    nativeHome: path.join(HOME, '.claude'),
    status: { kind: 'command', argv: ['claude', 'auth', 'status', '--json'] },
    managed: { verified: false, env: 'CLAUDE_CONFIG_DIR' },
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
    status: {
      kind: 'files',
      files: [
        path.join(HOME, '.gemini', 'oauth_creds.json'),
        path.join(HOME, '.gemini', 'google_accounts.json')
      ]
    },
    managed: { verified: false, env: null },
    color: 'violet'
  }
];

function fileExists(file) {
  try { return fs.existsSync(file); } catch { return false; }
}

function whereBinary(bin) {
  return new Promise((resolve) => {
    const resolver = process.platform === 'win32' ? 'where.exe' : 'which';
    execFile(resolver, [bin], { timeout: 4000 }, (err, stdout) => {
      if (err) return resolve('');
      const first = String(stdout || '').split(/\r?\n/).map(s => s.trim()).find(Boolean);
      resolve(first || '');
    });
  });
}

function commandStatus(argv) {
  return new Promise((resolve) => {
    execFile(argv[0], argv.slice(1), { timeout: 6000, windowsHide: true }, (err, stdout, stderr) => {
      const raw = String(stdout || stderr || '').trim();
      if (err) return resolve({ signedIn: false, label: raw || 'Sign-in needed' });
      let label = 'Existing local login detected';
      try {
        const data = JSON.parse(raw || '{}');
        label = data.email || data.account || data.authMethod || data.auth_method || label;
      } catch {}
      resolve({ signedIn: true, label });
    });
  });
}

async function nativeStatus(provider) {
  if (provider.status.kind === 'command') return commandStatus(provider.status.argv);
  const signedIn = provider.status.files.some(fileExists);
  return { signedIn, label: signedIn ? 'Existing local login detected' : 'Sign-in needed' };
}

function managedProfiles(provider) {
  const root = path.join(PROFILES_ROOT, provider.id);
  if (!fileExists(root)) return [];
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => {
        const dir = path.join(root, entry.name);
        const signedIn = provider.id === 'codex'
          ? fileExists(path.join(dir, 'auth.json'))
          : false;
        return {
          id: entry.name,
          name: entry.name,
          kind: 'managed',
          path: dir,
          signedIn
        };
      });
  } catch {
    return [];
  }
}

async function detectProviders() {
  const rows = [];
  for (const provider of PROVIDERS) {
    const binary = await whereBinary(provider.bin);
    const status = binary
      ? await nativeStatus(provider)
      : { signedIn: false, label: 'CLI not installed' };

    const profiles = [];
    if (binary && status.signedIn) {
      profiles.push({
        id: 'native',
        name: 'Default',
        kind: 'native',
        path: provider.nativeHome,
        signedIn: true
      });
    }
    profiles.push(...managedProfiles(provider));

    rows.push({
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
    });
  }
  return rows;
}

function providerById(id) {
  return PROVIDERS.find(provider => provider.id === id) || null;
}

function profileRoot(providerId) {
  return path.join(PROFILES_ROOT, providerId);
}

module.exports = { PROVIDERS, PROFILES_ROOT, detectProviders, providerById, profileRoot };
