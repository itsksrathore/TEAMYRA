'use strict';

// Which terminal.run commands a read-only job (write=false) may still run:
// tests, linters and type checks in check mode, and git commands that only
// read. Files stay read-only otherwise; shells, inline code (python -c,
// node -e) and fix/write flags are refused, since they can change anything.
// (2026-11-07: review jobs could not run their tests at all.)

const SHELLS = new Set(['powershell', 'pwsh', 'cmd', 'bash', 'sh', 'zsh', 'wsl', 'git-bash']);
const WRITE_FLAGS = /^(?:--fix(?:=.*)?|--fix-dry-run=false|--write|-w|--update-snapshot|-u|--updateSnapshot|--in-place|-i|--apply|--save)$/;
const GIT_READ = new Set(['status', 'diff', 'log', 'show', 'grep', 'rev-parse', 'ls-files', 'blame', 'describe',
  'shortlog', 'rev-list', 'merge-base', 'cat-file', 'ls-tree', 'name-rev']);
const PY_MODULES = new Set(['pytest', 'unittest', 'py_compile', 'compileall', 'mypy', 'pyflakes', 'pylint', 'doctest']);
const NPM_SCRIPT = /^(?:test|lint|check|typecheck|type-check|tsc|verify|validate)(?:[:\-][\w:.-]+)?$/;

function exeName(value) {
  return String(value || '').replace(/\\/g, '/').split('/').pop().toLowerCase().replace(/\.(?:exe|cmd|bat|ps1)$/, '');
}

// '' when allowed, else the reason it is not.
function readOnlyCommandProblem(argv) {
  if (!Array.isArray(argv) || !argv.length) return 'argv must be a non-empty list';
  const args = argv.map(String);
  const exe = exeName(args[0]);
  const rest = args.slice(1);
  if (SHELLS.has(exe)) return `${exe} can run any command; run the test command itself`;
  if (rest.some(arg => WRITE_FLAGS.test(arg))) return 'fix or write flags are not allowed in a read-only job';
  const sub = (rest.find(arg => !arg.startsWith('-')) || '').toLowerCase();
  if (exe === 'git') {
    // git -C <dir> <command>: skip global options.
    let index = 0;
    while (index < rest.length && rest[index].startsWith('-')) index += rest[index] === '-C' || rest[index] === '-c' ? 2 : 1;
    const command = (rest[index] || '').toLowerCase();
    if (GIT_READ.has(command)) return '';
    if (command === 'branch' && rest.slice(index + 1).every(arg => /^(?:--show-current|-a|-v|-vv|-r|--list|--contains|--merged)$/.test(arg))) return '';
    return `git ${command || ''} is not a read-only git command`.replace(/\s+/g, ' ');
  }
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(exe)) {
    if (sub === 'test' || sub === 't') return '';
    if (sub === 'run' || exe === 'yarn') {
      const script = sub === 'run' ? rest[rest.indexOf('run') + 1] : sub;
      if (NPM_SCRIPT.test(String(script || ''))) return '';
    }
    return `${exe} ${sub} is not a test/check script (allowed: test, lint, check, typecheck…)`;
  }
  if (exe === 'npx' || exe === 'pnpx') {
    const tool = exeName(rest.find(arg => !arg.startsWith('-')) || '');
    if (['tsc', 'eslint', 'vitest', 'jest', 'mocha', 'playwright', 'prettier', 'stylelint'].includes(tool)) {
      if (tool === 'prettier' && !rest.includes('--check')) return 'prettier is allowed only with --check';
      return '';
    }
    return `npx ${tool} is not a test/check tool`;
  }
  if (exe === 'node') {
    if (rest[0] === '--test' || rest[0] === '--check') return '';
    const script = rest.find(arg => !arg.startsWith('-')) || '';
    if (/(^|\/)tests?\//i.test(script.replace(/\\/g, '/')) || /\.test\.[cm]?js$/i.test(script)) return '';
    return 'node may run --test, --check or a test file only';
  }
  if (['python', 'python3', 'py'].includes(exe)) {
    const at = rest.indexOf('-m');
    const flags = rest.filter(arg => arg.startsWith('-'));
    if (flags.includes('-c')) return 'python -c runs arbitrary code';
    if (at >= 0 && PY_MODULES.has(String(rest[at + 1] || '').split('.')[0])) return '';
    if (at >= 0 && rest[at + 1] === 'ruff' && rest[at + 2] === 'check') return '';
    return 'python may run -m pytest, unittest, py_compile, mypy… only';
  }
  if (['pytest', 'mypy', 'tsc', 'eslint', 'vitest', 'jest', 'pyflakes', 'pylint'].includes(exe)) return '';
  if (exe === 'ruff' && sub === 'check') return '';
  if (exe === 'cargo' && ['test', 'check', 'clippy'].includes(sub)) return '';
  if (exe === 'go' && ['test', 'vet'].includes(sub)) return '';
  if (exe === 'dotnet' && sub === 'test') return '';
  return `${exe} is not a test or check command`;
}

module.exports = { readOnlyCommandProblem };
