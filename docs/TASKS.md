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
- [x] Antigravity Add Account safety decision — managed Add Account remains intentionally disabled because the verified `agy` CLI exposes no safe isolated account/profile mechanism.
- [x] Live jobs list/status.
- [x] Live job transcript streaming.
- [x] Embedded terminals — Windows verified: PTY spawn/input/output/resize/exit + xterm UI + IPC.
- [x] Foundation CI: Python compile/tests + npm clean install + desktop syntax + renderer build.

## Phase 2 — Multi-account Engine
- [x] Dynamic Claude/Codex provider profile discovery in desktop and worker bridge.
- [x] N Codex profiles plus legacy Codex 2 compatibility.
- [x] Verified Claude profile isolation with CLAUDE_CONFIG_DIR on Windows.
- [x] Claude profiles available as independent bridge workers.
- [x] Antigravity profile-isolation verification — unsupported by the current verified CLI surface; TEAMYRA safely exposes only the native session until upstream isolation exists.
- [x] Initial account-aware routing/cooldowns across discovered workers.
- [x] Bounded automatic reassignment/failover for eligible worker/provider failures, with lineage tracking.
- [x] Per-account model/effort UI and persisted settings, with enabled/priority routing controls.

## Phase 3 — Orchestration
- [x] Conductor foundation — detached sequential dependency scheduler.
- [x] Persistent dependency task graph with cycle validation and MCP create/start/status/cancel tools.
- [x] Parent/child worker lineage for graph nodes and failover chains.
- [x] Bounded retry/failover loop for eligible provider/worker failures.
- [x] Bounded automated reviewer/fixer loop with explicit PASS/CHANGES marker.
- [x] Structured cross-agent job handoff for review/continuation/testing.
- [x] Dedicated deterministic no-shell tester stage with per-step timeout/failure gating before merge.
- [x] Approval gates for sensitive/destructive graph nodes via MCP approve/deny.
- [x] Safe parallel graph execution with max_parallel, managed worktrees, snapshot commits, rebase and deterministic merge.

## Phase 4 — Git Workspace
- [x] First-class managed worktree lifecycle backend.
- [x] Managed worktree status, commits, diffstat, conflict detection and bounded unified diff.
- [x] Safe merge/discard backend with explicit confirmation and dirty/unmerged protection.
- [x] Parallel worker jobs use managed worktree IDs and persist worktree metadata.
- [x] Desktop Worktrees screen + visual diff viewer — Electron runtime verified on Windows.
- [x] Guarded merge/discard/update-branch controls — backend + IPC + renderer contracts + Windows runtime verified.
- [x] Rebase/update-branch workflow with automatic abort on conflict.
- [x] Bounded untracked text previews; binary/large untracked content is not dumped.
- [x] Windows runtime verification: create/diff/rebase/merge/discard lifecycle validated end-to-end.
- [x] Interactive conflict-resolution UI — paused rebase state, per-file target/worktree/manual resolution, continue/abort controls, and real Git tests.

## Phase 5 — MCP / CLI / Plugins
- [x] Canonical TEAMYRA MCP namespace with legacy aliases.
- [x] Local stdio MCP runtime verified on Windows.
- [x] Localhost Streamable HTTP MCP JSON-response transport verified on Windows.
- [x] TEAMYRA CLI with doctor/workers/jobs/run/wait/result/test/graph/worktree/MCP commands.
- [x] Codex local plugin + repository marketplace; isolated install/runtime discovery verified.
- [x] Claude project MCP integration; repository discovery verified (first-use approval remains provider-controlled).
- [x] Antigravity plugin + skill + MCP integration; live agent MCP tool call verified.

## Phase 6 — Observability / Memory
- [x] Unified timeline across jobs, graphs, reviews, and managed worktrees — MCP/CLI/Desktop + Windows runtime verified.
- [x] Usage/quota dashboard — real persisted token usage + live readiness/cooldowns; unavailable provider quota percentages are not guessed.
- [x] Context-window capability handling — current verified provider CLIs do not expose reliable live context telemetry, so TEAMYRA shows unavailable rather than guessed values.
- [x] Searchable logs — bounded job events/transcripts/stderr/runner/task search via MCP/CLI/Desktop.
- [x] Project memory — local per-project structured decisions/facts/notes/handoffs/TODOs with MCP/CLI/Desktop CRUD, ranked search, archive lifecycle, and bounded agent context packs; Windows runtime verified.
- [x] MCP pooling - shared lazy external stdio MCP processes behind the long-lived TEAMYRA HTTP gateway, with runtime-only config, reuse/restart, redacted status, MCP tools, CLI admin surface, and Windows HTTP runtime verification.
- [x] Crash recovery - heartbeat/PID-aware startup reconciliation; same-job provider-session resume; graph/failover monitor restart; safe manual-resume preservation for non-terminal review loops.

## Phase 7 — Distribution
- [x] Tests — Python/unit/desktop contract suites run in CI on Linux and Windows.
- [x] CI — GitHub Actions Linux + Windows matrix verifies Python compile/tests, desktop syntax, npm clean install, and renderer build.
- [x] Windows installer — PyInstaller bundled core + Electron/NSIS installer; fresh build, install, packaged UI/core, provider detection, runtime location, and uninstall preservation verified on Windows.
- [x] Auto-update — electron-updater GitHub release channel wired with update status/check/install IPC plus tag-based release workflow metadata publishing.
- [x] Docs/examples — Windows distribution architecture, build/release flow, and packaged runtime behavior documented.
- [x] Open-source hardening — MIT license, contribution/security policy, provider capability boundaries, public release checklist, runtime dependency audit gate, and stable-tag signing/Authenticode enforcement.


## Phase 8 — Normal ChatGPT Web Agent
- [x] Inspect existing desktop/core/provider/MCP/orchestration architecture before changes.
- [x] Add `ChatGPTWebProvider`, session manager, semantic automation adapter and workspace bridge.
- [x] Embed normal ChatGPT in one lazy WebContentsView; no external Chrome/Edge window.
- [x] Persist normal ChatGPT browser session in `persist:teamyra-chatgpt-profile`.
- [x] Register `chatgpt-normal` in worker registry and queue desktop-backed jobs in the existing TEAMYRA job store.
- [x] Reuse one normalized WorkspaceToolService for ChatGPT and MCP callers.
- [x] Filesystem list/stat/read/search/create/write/patch/move/rename/delete.
- [x] Terminal run + Git status/diff/log/add/commit/restore.
- [x] Workspace sandbox, sensitive-root blocking, permission UI, auth token, audit log and bounded recovery backups.
- [x] ChatGPT UI controls, workspace status, changed-files/diff view, guarded revert and file attachment.
- [x] Dedicated worker conversation persistence and existing `job_message` session-resume path.
- [x] First functional/security review and fixes.
- [x] Second architecture/security review and fixes.
- [ ] Live Windows ChatGPT account acceptance (requires an online desktop/user session; do not mark passed from CI alone).


## Phase 9 — Minimal Nami-style Desktop
- [x] Two-view primary shell: Tasks + Agents.
- [x] Nami Glass-inspired visual rebuild with aurora background, translucent panes, coral accents, capsule controls, compact typography, native hidden-titlebar treatment, and agent brand glyphs.
- [x] Live task tiles with incremental transcript tails and active Stop control.
- [x] Minimal New Task composer with workspace + worker selector using the existing TEAMYRA job engine.
- [x] Clean provider/account connection shelf with connect/open and verified Add Account flows.
- [x] ChatGPT Normal embedded as an Agents detail surface with minimal workspace/tool controls.
- [x] Remove Worktrees, Observability, Memory, Connections, Settings, and dashboard metrics from permanent primary navigation while preserving their backend APIs.
- [x] Preserve updater, terminal, provider login, worktree/conflict, memory, observability, MCP/CLI, review/handoff, and orchestration contracts.
- [x] Add desktop task-action regression tests and simplified UI contract tests.
- [x] Complete functional plus complexity/maintainability review passes.
- [x] Retain Nami Apache-2.0 attribution/license for adapted visual implementation.
- [x] Windows + Linux automated validation for the rebuilt renderer and existing backend.
- [ ] Live Windows visual/runtime acceptance of the rebuilt UI.
