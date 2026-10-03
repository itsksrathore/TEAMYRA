# TEAMYRA

TEAMYRA is a local-first, provider-agnostic multi-agent engineering control plane.

It is evolving from the existing AI worker bridge into a full desktop system that can coordinate Claude Code, Codex, Antigravity, and future agents from one control desk.

## Current capabilities
- Minimal Nami-inspired Glass desktop with only Tasks and Agents as permanent primary views.
- Live task tiles with transcript tails plus a compact New Task flow backed by the existing TEAMYRA job engine.
- Clean agent connection shelf for Claude, Codex, Antigravity, and embedded ChatGPT Normal.
- Claude Code as supervisor/orchestrator.
- Codex account 1 and isolated Codex account 2.
- Antigravity worker.
- Normal ChatGPT web worker embedded inside TEAMYRA (no OpenAI API).
- automatic rate/quota cooldown and fallback.
- detached and resumable worker jobs.
- compact final results with full local logs.
- isolated Git worktrees for parallel tasks.
- live local job dashboard.
- canonical `teamyra.*` MCP tools with legacy aliases.
- local stdio MCP and localhost Streamable HTTP MCP.
- TEAMYRA CLI for workers, jobs, tests, graphs, and worktrees.

## Quick start

```powershell
npm ci
npm run desktop
npm run teamyra -- doctor
npm run mcp:stdio
npm run mcp:http -- --port 8787
```

The HTTP endpoint is `http://127.0.0.1:8787/mcp` by default and is intentionally localhost-only in this build.

Provider-specific Claude Code, Codex, and Antigravity setup is documented in [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md).
The embedded normal ChatGPT web worker, workspace tool bridge, permissions, and security model are documented in [docs/CHATGPT_WEB_AGENT.md](docs/CHATGPT_WEB_AGENT.md).
Windows packaging, installer/runtime layout, acceptance checks, and the release/update path are documented in [docs/WINDOWS_DISTRIBUTION.md](docs/WINDOWS_DISTRIBUTION.md).
The desktop information architecture and visual rules are documented in [docs/UI_DESIGN.md](docs/UI_DESIGN.md). Nami visual-design attribution is retained in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Windows distribution

```powershell
npm run core:build
npm run desktop:dist:win
```

The packaged desktop embeds `teamyra-core.exe`, so end users do not need a separate Python installation. Runtime jobs, logs, worktrees, memory, and managed profiles live under Electron user data rather than the installation directory. Tagged `v*` pushes run the Windows release workflow. Stable tags require Windows signing credentials, verify Authenticode signatures before publication, and upload the verified NSIS installer plus update metadata to GitHub Releases.

## Target capabilities
- automatic detection of installed agents and existing local logins.
- multiple managed accounts per provider where isolation is supported.
- account-aware routing and failover.
- Conductor/supervisor workflows.
- task graph, review loops, approvals, and worker messaging.
- visual Git worktree/diff/merge controls.
- TEAMYRA MCP, CLI, plugins, and skills.
- usage/quota/context observability.
- project memory and shared handoffs.
- Windows installer and update pipeline.

## Project plan
See [ROADMAP.md](ROADMAP.md). Completed work is checked off there phase by phase.

## Contributing and security
TEAMYRA is MIT licensed. See [CONTRIBUTING.md](CONTRIBUTING.md) before submitting changes and [SECURITY.md](SECURITY.md) for private vulnerability reporting and credential-handling guidance. Provider capability boundaries are documented in [docs/PROVIDER_CAPABILITIES.md](docs/PROVIDER_CAPABILITIES.md), and public releases follow [docs/RELEASE_CHECKLIST.md](docs/RELEASE_CHECKLIST.md).

## Existing bridge layout
- `bridge/server.py` — MCP bridge and worker orchestration.
- `bridge/runner.py` — detached worker job execution.
- `bridge/dashboard.py` — current local dashboard.
- `bridge/config.json` — current worker configuration.

Runtime data such as profiles, logs, jobs, results, and worktrees is intentionally not committed.

## Security
TEAMYRA should reuse provider-native authentication and isolated profile homes instead of copying account secrets into application state.
