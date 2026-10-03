# TEAMYRA Roadmap

TEAMYRA is a local-first, provider-agnostic multi-agent engineering control plane.

## Phase 0 — Foundation
- [x] Import the existing bridge into GitHub.
- [x] Keep runtime data, local profiles, logs, results, and worktrees out of source control.
- [x] Preserve the existing worker bridge as the starting implementation.
- [x] Define the product architecture and phased execution plan.
- [x] Establish this roadmap as the project source of truth.

## Phase 1 — Desktop Control Desk
- [ ] Build the desktop shell and premium control-desk UI.
- [ ] Add provider adapters for Claude Code, Codex, and Antigravity.
- [ ] Auto-detect installed CLIs.
- [ ] Detect existing local signed-in sessions without importing secrets.
- [ ] Show providers, accounts, sessions, jobs, status, and logs.
- [ ] Add account-management UI for providers that support isolated profiles.
- [ ] Add embedded terminal panes.

## Phase 2 — Multi-account Engine
- [ ] Replace fixed worker names with dynamic provider profiles.
- [ ] Support multiple isolated Codex profiles.
- [ ] Support multiple isolated Claude profiles after verification.
- [ ] Verify and implement Antigravity profile isolation.
- [ ] Add account-aware routing, cooldowns, and failover.
- [ ] Add per-profile model and effort settings.

## Phase 3 — Orchestration
- [ ] Add Conductor/supervisor mode.
- [ ] Add task decomposition and dependency graphs.
- [ ] Add parent/child sessions and worker messaging.
- [ ] Add automatic retry, reassignment, and review loops.
- [ ] Add approval gates for sensitive actions.

## Phase 4 — Git Workspace System
- [ ] First-class Git worktree manager.
- [ ] One task to one isolated branch/worktree mode.
- [ ] Visual diff and change review.
- [ ] Merge, rebase, discard, conflict handling, and cleanup.

## Phase 5 — MCP, CLI, and Plugins
- [ ] Evolve the existing MCP bridge into TEAMYRA MCP.
- [ ] Define stable TEAMYRA tool schemas.
- [ ] Support local stdio MCP.
- [ ] Add optional HTTP MCP transport.
- [ ] Build TEAMYRA CLI.
- [ ] Build ecosystem plugins/skills where supported.
- [ ] Add project bootstrap files for agent interoperability.

## Phase 6 — Observability and Memory
- [ ] Unified task timeline.
- [ ] Usage, quota, and context visibility.
- [ ] Searchable logs.
- [ ] Project memory and architecture decisions.
- [ ] Shared structured handoffs.
- [ ] MCP pooling and crash recovery.

## Phase 7 — Distribution
- [ ] Automated tests and CI.
- [ ] Windows installer.
- [ ] Update pipeline.
- [ ] Documentation and examples.
- [ ] Open-source release hardening.
