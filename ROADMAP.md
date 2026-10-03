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
- [x] Verify Antigravity profile isolation capability — current `agy` CLI exposes no safe account/profile isolation mechanism, so managed multi-account is explicitly disabled pending upstream support.
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
- [x] Interactive conflict-resolution experience with paused rebases, per-file resolution, and continue/abort controls.

## Phase 5 — MCP, CLI, and Plugins
- [x] Evolve the existing worker bridge into canonical TEAMYRA MCP.
- [x] Define stable namespaced TEAMYRA tool schemas with legacy aliases.
- [x] Support local stdio MCP.
- [x] Add localhost Streamable HTTP MCP JSON-response transport.
- [x] Build and Windows-verify TEAMYRA CLI.
- [x] Build local Codex and Antigravity plugin/skill integrations.
- [x] Add Claude/Codex/Antigravity project bootstrap files for agent interoperability.

## Phase 6 — Observability and Memory
- [x] Unified task timeline across jobs, graphs, reviews, and managed worktrees.
- [x] Real token usage plus live readiness/cooldown visibility without fabricated quota percentages.
- [x] Provider context-window capability handling — reliable live telemetry is not exposed by the verified CLIs, so TEAMYRA reports it as unavailable instead of fabricating values.
- [x] Searchable bounded job logs and transcripts.
- [x] Local project memory and architecture decisions with structured entries, provenance, archive lifecycle, ranked search, MCP/CLI/Desktop access, and bounded context packs.
- [x] Shared structured handoffs with persistent envelopes, lineage, acceptance criteria, artifacts, and bounded project-memory context.
- [x] MCP pooling for shared external stdio MCP processes through the long-lived TEAMYRA HTTP gateway.
- [x] Crash recovery with heartbeat/PID-aware job reconciliation, same-session resume, graph/failover monitor restart, and duplicate-safe interrupted review preservation.

## Phase 7 — Distribution
- [x] Automated tests and CI on Linux + Windows via GitHub Actions matrix.
- [x] Windows installer with bundled standalone core and verified installed-app runtime.
- [x] GitHub Release update pipeline with electron-updater wiring and generated NSIS update metadata.
- [x] Documentation and examples for Windows packaging, runtime layout, and release acceptance.
- [x] Open-source release hardening — MIT license, contribution/security policy, provider capability boundaries, public release checklist, runtime dependency audit gate, and signed/verified stable release channel.


## Phase 8 — Normal ChatGPT Web Agent
- [x] Architecture inspection and provider extension design.
- [x] Desktop-backed `chatgpt-normal` worker/provider registration.
- [x] Embedded Electron WebContentsView with dedicated persistent ChatGPT session.
- [x] Shared workspace-scoped filesystem, terminal and Git tool layer.
- [x] Permission gates, canonical path sandboxing, sensitive-root blocking, audit logs and recovery backups.
- [x] ChatGPT panel with workspace, permissions, status, diff/change, attach, stop/reload/reconnect controls.
- [x] Existing TEAMYRA task/job/handoff/failover integration and persistent worker-conversation metadata.
- [x] Automated Windows/Linux contract, routing and security tests.
- [ ] Live Windows acceptance with a real logged-in ChatGPT account: sign-in, restart persistence, manual chat, and current production DOM automation.


## Phase 9 — Minimal Nami-style Desktop
- [x] Reduce permanent primary navigation to Tasks and Agents only.
- [x] Replace dashboard metrics/sections with live agent task tiles and transcript tails.
- [x] Add a compact New Task flow backed by the existing `server.start_job` and cancellation lifecycle.
- [x] Replace provider settings dashboard with a clean agent/account connection shelf.
- [x] Nest ChatGPT Normal inside Agents instead of giving it a separate primary menu.
- [x] Keep Worktrees, conflict resolution, Observability, Memory, MCP/CLI, updates, and orchestration intact behind the simplified frontend.
- [x] Port the Nami Glass visual language: aurora desk, frosted panes, coral accent, capsule controls, status pills, and floating task/agent cards.
- [x] Add UI architecture guardrails and Apache-2.0 attribution for the adapted Nami visual system.
- [x] Verify Python/unit contracts, desktop JavaScript checks, runtime dependency audit, and renderer build on GitHub CI.


## Phase 9 — Desktop UI Simplification
- [x] Replace the multi-menu dashboard with exactly two permanent primary views: Tasks and Agents.
- [x] Rebuild the desktop visual system around the Nami-inspired Glass workbench language with proper Apache-2.0 attribution.
- [x] Render running/recent jobs as live agent work tiles with transcript tails and stop controls.
- [x] Wire the minimal New Task composer to the existing TEAMYRA job/orchestration backend.
- [x] Collapse provider/account management into a clean Agents shelf.
- [x] Keep ChatGPT Normal inside Agents as an embedded detail surface rather than a separate primary menu.
- [x] Keep Worktrees, Observability, Memory, conflict tools, and other advanced capabilities available in backend/IPC while removing permanent frontend clutter.
- [x] Add regression contracts that enforce the two-view information architecture and preserve backend capabilities.
- [ ] Live Windows visual acceptance of the rebuilt desktop, including resize behavior, agent login flows, live task tiles, and embedded ChatGPT placement.
