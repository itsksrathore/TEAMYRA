# TEAMYRA Verification Policy

Critical TEAMYRA features are not marked done only because code exists.

## Required verification layers

1. Static / automated verification
   - Python compile
   - Python unit tests
   - JavaScript syntax checks
   - renderer bundle build
   - git diff / whitespace checks

2. Runtime verification
   - exercise the feature on a real supported machine
   - confirm the observable result, not only process exit
   - check failure/edge behavior when practical

3. Review
   - inspect the final diff for regressions and credential leakage
   - keep provider credentials in native/provider profile stores
   - do not commit profiles, jobs, logs, results, worktrees, or tokens

## Windows verification — 2026-10-03

Verified on the active TEAMYRA development Windows machine:

- Claude Code CLI detected and native login recognized.
- Codex CLI detected and native login recognized.
- Legacy isolated Codex 2 profile detected and recognized.
- Antigravity CLI detected and authenticated through a live models check.
- Empty CLAUDE_CONFIG_DIR does not inherit the native Claude login.
- Empty CODEX_HOME does not inherit the native Codex login.
- Desktop provider registry renders all three providers.
- Desktop metrics and account cards update from real local state.
- Existing jobs load into the desktop task view.
- PTY spawn, input, output, resize, and clean exit pass on Windows.
- Electron preload IPC can open/write/close a PTY.
- xterm terminal surface renders in the desktop UI.
- Managed Codex and Claude profile creation produces separate unsigned profile state and was smoke-tested with cleanup.
- Codex managed-account login launches the real isolated device-auth flow in the embedded terminal and shows the OpenAI device URL/code prompt.
- Claude stream-json event shapes were captured from the installed CLI.
- Claude runner parser handles session id, text, usage, rate-limit state, result, and permission denial events.
- Claude runner integration is replay-tested through a real subprocess NDJSON stream without consuming extra model quota.

Current automated suite: 13 Python tests passing after merging concurrent routing work, desktop JavaScript syntax passing, renderer build passing, clean npm ci passing with 0 reported vulnerabilities.

## Known pending verification

- Antigravity multi-account/profile-home isolation is not enabled until a supported isolation mechanism is verified.
- Automatic post-failure reassignment/failover is not yet complete.
- Installer/update pipeline is not yet implemented.
