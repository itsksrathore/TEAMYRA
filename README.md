# TEAMYRA

TEAMYRA is a local-first, provider-agnostic multi-agent engineering control plane.

It is evolving from the existing AI worker bridge into a full desktop system that can coordinate Claude Code, Codex, Antigravity, and future agents from one control desk.

## Current capabilities
- Claude Code as supervisor/orchestrator.
- Codex account 1 and isolated Codex account 2.
- Antigravity worker.
- automatic rate/quota cooldown and fallback.
- detached and resumable worker jobs.
- compact final results with full local logs.
- isolated Git worktrees for parallel tasks.
- live local job dashboard.
- MCP worker bridge.

## Target capabilities
- Nami-style desktop UI.
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

## Existing bridge layout
- `bridge/server.py` — MCP bridge and worker orchestration.
- `bridge/runner.py` — detached worker job execution.
- `bridge/dashboard.py` — current local dashboard.
- `bridge/config.json` — current worker configuration.

Runtime data such as profiles, logs, jobs, results, and worktrees is intentionally not committed.

## Security
TEAMYRA should reuse provider-native authentication and isolated profile homes instead of copying account secrets into application state.
