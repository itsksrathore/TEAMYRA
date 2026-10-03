# TEAMYRA Execution Board

This checklist is updated as implementation lands.

## Phase 0 — Foundation
- [x] Existing bridge uploaded to GitHub.
- [x] Runtime credentials and session data excluded.
- [x] TEAMYRA identity established.
- [x] Product roadmap committed.
- [x] Architecture committed.
- [x] Execution board committed.

## Phase 1 — Desktop Control Desk
- [x] Desktop app shell.
- [x] Provider adapter registry.
- [x] Installed CLI detection.
- [x] Existing local login detection.
- [x] Agent/account cards.
- [x] Codex Add Account flow (isolated CODEX_HOME profile + provider login launch).
- [x] Claude Add Account flow using documented CLAUDE_CONFIG_DIR isolation.
- [ ] Antigravity Add Account flow after profile-isolation verification.
- [x] Live jobs list/status.
- [x] Live job transcript streaming.
- [x] Embedded terminals — Windows verified: PTY spawn/input/output/resize/exit + xterm UI + IPC.
- [x] Foundation CI: Python compile/tests + npm clean install + desktop syntax + renderer build.

## Phase 2 — Multi-account Engine
- [x] Dynamic Claude/Codex provider profile discovery in desktop and worker bridge.
- [x] N Codex profiles plus legacy Codex 2 compatibility.
- [x] Verified Claude profile isolation with CLAUDE_CONFIG_DIR on Windows.
- [x] Claude profiles available as independent bridge workers.
- [ ] Verified Antigravity profile isolation.
- [x] Initial account-aware routing/cooldowns across discovered workers.
- [x] Bounded automatic reassignment/failover for eligible worker/provider failures, with lineage tracking.
- [x] Per-account model/effort UI and persisted settings, with enabled/priority routing controls.

## Phase 3 — Orchestration
- [x] Conductor foundation — detached sequential dependency scheduler.
- [x] Persistent dependency task graph with cycle validation and MCP create/start/status/cancel tools.
- [x] Parent/child worker lineage for graph nodes and failover chains.
- [x] Bounded retry/failover loop for eligible provider/worker failures.
- [ ] Automated reviewer/tester loops.
- [x] Approval gates for sensitive/destructive graph nodes via MCP approve/deny.
- [ ] Parallel graph execution after Phase 4 worktree merge/rebase semantics are implemented.

## Phase 4 — Git Workspace
- [ ] Worktree manager.
- [ ] Visual diff.
- [ ] Merge/discard/rebase.
- [ ] Conflict handling.

## Phase 5 — MCP / CLI / Plugins
- [ ] TEAMYRA MCP namespace.
- [ ] Stdio MCP.
- [ ] HTTP MCP.
- [ ] TEAMYRA CLI.
- [ ] Codex plugin.
- [ ] Claude integration.
- [ ] Antigravity integration.

## Phase 6 — Observability / Memory
- [ ] Unified timeline.
- [ ] Usage/quota/context dashboard.
- [ ] Searchable logs.
- [ ] Project memory.
- [ ] MCP pooling.
- [ ] Crash recovery.

## Phase 7 — Distribution
- [ ] Tests.
- [ ] CI.
- [ ] Windows installer.
- [ ] Auto-update.
- [ ] Docs/examples.
