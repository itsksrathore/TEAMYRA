---
name: teamyra
description: Use TEAMYRA MCP to delegate coding work across local agents, run dependency graphs, enforce independent review and deterministic tests, and manage isolated Git worktrees.
---

# TEAMYRA orchestration

Use TEAMYRA as the control plane instead of manually juggling multiple local agent sessions.

- Check `teamyra.worker_status` when readiness or account routing matters.
- Use `teamyra.graph_create` and `teamyra.graph_start` for dependent multi-step work.
- Use `teamyra.start_task` for a single delegated task.
- Do not bypass graph approval gates.
- Prefer independent reviewer/fixer flows for substantial changes.
- Run deterministic `teamyra.test_run` checks before treating implementation as merge-ready.
- Use managed worktree diff/rebase/merge/discard tools for isolated branches.
- Use compact results first; open full transcripts only for debugging.
- Preserve valid partial work during failover.
