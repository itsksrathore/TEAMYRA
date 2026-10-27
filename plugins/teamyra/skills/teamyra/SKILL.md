---
name: teamyra
description: Use TEAMYRA MCP to delegate coding work across local agents, run dependency graphs, enforce independent review and deterministic tests, manage isolated Git worktrees, and generate media and images fast in bulk (Google Flow, Codex gpt-image).
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
- Before substantial project work, use `teamyra.memory_context` when prior architecture, decisions, handoffs, or project facts could materially affect the task.
- After a verified architecture/design decision or durable project fact changes, add or update structured project memory with `teamyra.memory_add` / `teamyra.memory_update`.
- Keep memory concise and project-scoped. Never store passwords, access tokens, API keys, session cookies, private auth state, or other secrets in TEAMYRA memory.
- Prefer archive over deletion when a memory becomes obsolete so decision history remains auditable.

## Media and image generation

- Read `teamyra.media_guide` first: it says which tool to use and shows live capacity.
- Google Flow videos, images and sound effects: `teamyra.media_generate` for one, `teamyra.media_batch` for two or more (one call, run in several Flow tabs at once). Poll `teamyra.media_status({batch_id})` every 20-30 s; recover with `media_recover` / `media_resume_download` or hand problems to a helper with `media_report_issue` instead of resubmitting.
- Codex/gpt-image stills (character sheets, turnarounds, look frames): `teamyra.codex_image_batch` with every image of the wave in one call (prompt, output file, references, size), then `teamyra.codex_image_status`. About 1-2 min per image, several in parallel, full quality.
- Never start a worker job (`start_task`, `run_ai_worker`) just to draw images: it makes them one by one at 2-5 min each and blocks the account.
- Images that build on earlier ones: batch the base images first, then a second batch that lists them as references.
