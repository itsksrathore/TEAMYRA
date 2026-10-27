---
name: teamyra
description: Orchestrate local coding agents through TEAMYRA MCP for delegation, dependency graphs, reviews, deterministic tests, worktrees, routing, failover, and fast bulk media/image generation (Google Flow, Codex gpt-image).
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

## Media and image generation

- Read `teamyra.media_guide` first: it says which tool to use and shows live capacity.
- Google Flow videos, images and sound effects: `teamyra.media_generate` for one, `teamyra.media_batch` for two or more (one call, run in several Flow tabs at once). Poll `teamyra.media_status({batch_id})` every 20-30 s; recover with `media_recover` / `media_resume_download` or hand problems to a helper with `media_report_issue` instead of resubmitting.
- Codex/gpt-image stills (character sheets, turnarounds, look frames): `teamyra.codex_image_batch` with every image of the wave in one call (prompt, output file, references, size), then `teamyra.codex_image_status`. About 1-2 min per image, several in parallel, full quality.
- Never start a worker job (`start_task`, `run_ai_worker`) just to draw images: it makes them one by one at 2-5 min each and blocks the account.
- Images that build on earlier ones: batch the base images first, then a second batch that lists them as references.

## Suggested flow

1. Check workers with `teamyra.worker_status`.
2. Create a task graph for non-trivial work.
3. Start the graph and monitor `teamyra.graph_status`.
4. Resolve explicit approval gates when required.
5. Run deterministic tests.
6. Use independent review for material changes.
7. Inspect managed worktree diff and merge only after tests/review pass.
