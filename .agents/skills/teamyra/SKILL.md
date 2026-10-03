---
name: teamyra
description: Orchestrate local coding agents through TEAMYRA MCP for delegation, dependency graphs, reviews, deterministic tests, worktrees, routing, and failover.
---

# TEAMYRA

Use TEAMYRA when work benefits from delegation, independent review, deterministic testing, or isolated Git worktrees.

## Operating rules

- Use `teamyra.worker_status` before important delegation when account readiness, cooldowns, or routing matter.
- Prefer `teamyra.graph_create` + `teamyra.graph_start` for multi-step work with dependencies.
- Use `teamyra.start_task` for one independent delegated task.
- Keep destructive work behind TEAMYRA approval gates. Never bypass a required approval.
- Prefer a different worker/account for review. Use TEAMYRA review flows before declaring substantial changes ready.
- Use deterministic `teamyra.test_run` steps or graph-node tests to validate code rather than relying only on an agent's final message.
- Use TEAMYRA-managed worktrees for parallel write tasks. Inspect diffs before merge.
- Merge, rebase, or discard only through guarded TEAMYRA worktree actions when TEAMYRA owns the worktree.
- Prefer compact job status/results first; inspect full transcripts only when debugging needs them.
- Preserve correct partial work during failover and continuation instead of restarting completed steps.
- Before substantial project work, use `teamyra.memory_context` when prior architecture, decisions, handoffs, or project facts could materially affect the task.
- After a verified architecture/design decision or durable project fact changes, add or update structured project memory with `teamyra.memory_add` / `teamyra.memory_update`.
- Keep memory concise and project-scoped. Never store passwords, access tokens, API keys, session cookies, private auth state, or other secrets in TEAMYRA memory.
- Prefer archive over deletion when a memory becomes obsolete so decision history remains auditable.

## Suggested flow

1. Check workers with `teamyra.worker_status`.
2. Create a task graph for non-trivial work.
3. Start the graph and monitor `teamyra.graph_status`.
4. Resolve explicit approval gates when required.
5. Run deterministic tests.
6. Use independent review for material changes.
7. Inspect managed worktree diff and merge only after tests/review pass.
