# Contributing to TEAMYRA

Thanks for helping improve TEAMYRA.

## Development setup

TEAMYRA is a local-first desktop control plane. Keep credentials, provider sessions, jobs, logs, worktrees, memory, and other runtime state out of commits.

```powershell
npm ci
python -m unittest discover -s tests -p "test_*.py"
npm run desktop:check
npm --workspace @teamyra/desktop run build:renderer
```

On Windows, distribution changes should also verify the bundled core and installer paths documented in `docs/WINDOWS_DISTRIBUTION.md`.

## Change workflow

1. Create a focused branch from `main`.
2. Keep changes scoped and add tests for behavior changes.
3. Run Python tests, desktop syntax checks, renderer build, and `git diff --check`.
4. Never commit credentials, auth files, provider profile contents, generated jobs/logs, or user project data.
5. Open a pull request describing behavior, risk, and verification performed.
6. Resolve required CI/review findings before merge.

## Safety rules

Destructive Git actions must require explicit confirmation and preserve recoverability where practical. Provider integration must reuse provider-native authentication rather than copying secrets into TEAMYRA metadata. Unsupported quota, context-window, account-isolation, or authentication capabilities must be shown as unavailable instead of guessed.

## Reporting security issues

Do not open public issues for suspected vulnerabilities or leaked credentials. Follow `SECURITY.md`.
