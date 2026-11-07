const assert = require('node:assert/strict');
const { readOnlyCommandProblem: problem } = require('../src/read-only-commands');

// Allowed in a read-only job: tests, checks and read-only git.
for (const argv of [
  ['npm', 'test'], ['npm', 'run', 'test:unit'], ['npm', 'run', 'lint'], ['npm', 'run', 'typecheck'],
  ['C:/Program Files/nodejs/npx.cmd', 'tsc', '--noEmit'], ['npx', 'vitest', 'run'], ['npx', 'prettier', '--check', '.'],
  ['node', '--test'], ['node', 'tests/chatgpt-job-loop.test.js'], ['python', '-m', 'pytest', '-q'],
  ['python', '-m', 'unittest', 'discover'], ['py', '-m', 'ruff', 'check'], ['git', 'status', '--short'],
  ['git', '-C', 'D:/x', 'diff', '--stat'], ['git', 'log', '-5', '--oneline'], ['git', 'branch', '--show-current'],
  ['cargo', 'test'], ['go', 'vet', './...']
]) assert.equal(problem(argv), '', argv.join(' '));

// Refused: anything that can change files.
for (const argv of [
  ['powershell', '-Command', 'Remove-Item x'], ['C:/Program Files/Git/bin/bash.exe', '-lc', 'npm test'], ['cmd', '/c', 'dir'],
  ['python', '-c', 'open("x","w")'], ['node', '-e', 'require("fs").rmSync("x")'], ['node', 'scripts/migrate.js'],
  ['npm', 'install'], ['npm', 'run', 'build'], ['npx', 'eslint', '--fix', '.'], ['npx', 'prettier', '--write', '.'],
  ['npx', 'jest', '-u'], ['git', 'checkout', 'main'], ['git', 'commit', '-m', 'x'], ['git', 'branch', '-D', 'x'],
  ['git', 'reset', '--hard'], ['rm', '-rf', 'x'], ['del', 'x'], []
]) assert.notEqual(problem(argv), '', argv.join(' '));

console.log('read-only command tests passed');
