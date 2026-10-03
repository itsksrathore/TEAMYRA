# TEAMYRA Roadmap

TEAMYRA is a local-first, provider-agnostic multi-agent engineering control plane.

## Phase 0 — Foundation
- [x] Import the existing bridge into GitHub.
- [x] Keep runtime data, local profiles, logs, results, and worktrees out of source control.
- [x] Preserve the existing worker bridge as the starting implementation.
- [x] Define the product architecture and phased execution plan.
- [x] Establish this roadmap as the project source of truth.

## Phase 1 — Desktop Control Desk
- [x] Build the desktop shell and premium control-desk UI.
- [x] Add provider adapters for Claude Code, Codex, and Antigravity.
- [x] Auto-detect installed CLIs.
- [x] Detect existing local signed-in sessions without importing secrets.
- [x] Show providers, accounts, jobs, status, and live task transcripts.
- [x] Add account-management UI for providers with verified isolated profiles.
- [x] Add embedded terminal panes and verify them on Windows.

## Phase 2 — Multi-account Engine
- [x] Replace fixed Claude/Codex worker assumptions with dynamic provider profiles.
- [x] Support multiple isolated Codex profiles.
- [x] Support multiple isolated Claude profiles and expose them as bridge workers.
- [ ] Verify and implement Antigravity profile isolation.
- [x] Add initial account-aware routing and cooldown handling across discovered workers.
- [x] Add bounded automatic reassignment/failover after eligible worker/provider failure, preserving job lineage.
- [x] Add per-profile model/effort settings plus enabled/priority routing controls.

## Phase 3 — Orchestration
- [x] Add detached Conductor foundation for dependency-ordered graph execution.
- [x] Add persistent task graphs with cycle validation and MCP controls.
- [x] Add graph node → child job lineage plus failover lineage.
- [x] Add bounded automatic retry/reassignment for eligible provider/worker failures.
- [x] Add bounded automated reviewer/fixer loops with provider-session continuation.
- [x] Add structured cross-agent handoff for review, continuation and testing tasks.
- [x] Add deterministic no-shell tester stages with explicit argv commands, timeout handling and merge gating.
- [x] Add approval gates for sensitive graph nodes with explicit approve/deny decisions.
- [x] Enable safe parallel graph execution with managed worktree isolation and deterministic integration.

## Phase 4 — Git Workspace System
- [x] First-class managed Git worktree lifecycle backend.
- [x] Parallel task isolation tracked with stable worktree IDs.
- [x] Safe diff/status plus guarded merge/discard/cleanup backend.
- [x] Desktop visual diff/worktree review code path with guarded merge/discard/update actions.
- [x] Rebase/update-branch backend with automatic conflict abort.
- [x] Windows runtime UX verification for Phase 4 desktop actions.
- [ ] Interactive conflict-resolution experience.

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
