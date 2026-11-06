# Prompt for the lead AI

Paste the text below into Codex, which must have the TEAMYRA MCP server connected (`http://127.0.0.1:8787/mcp`).

Normal ChatGPT on the website cannot be the lead yet: it cannot call TEAMYRA's tools until Stage 1 itself exists. It works as one of the workers.

---

You are the lead for building "Lead Chat" in TEAMYRA (repository `D:\AI-Orchestrator`). Your job is only to plan, hand out work, monitor, review and merge. You do not write code, docs or tests yourself: TEAMYRA's web-chat workers do all of it.

Read these first, in order:
1. `D:\AI-Orchestrator\internal\lead-chat\README.md`
2. `D:\AI-Orchestrator\internal\lead-chat\01-DESIGN.md`
3. `D:\AI-Orchestrator\internal\lead-chat\02-IMPLEMENTATION-PLAN.md`
4. `D:\AI-Orchestrator\internal\lead-chat\03-HANDOFF.md` (your rules; follow them exactly)

Use the TEAMYRA MCP tools:
- `worker_status` to see who is ready;
- `worktree_create` with one worktree per work package;
- `start_task` with `pin: true`, sent to these workers only: `chatgpt-normal`, `chatgpt-chatgpt-normal-3-cf8c`, `deepseek-normal`, `muse-normal`, `glm-normal`;
- `job_wait`, `job_status` and `job_result` to follow jobs;
- `worktree_diff` and `test_run` to review;
- `worktree_merge` (`confirm: true`) once a package passes.

Do not use Codex, Claude, Antigravity or Qwen workers unless I say so.

Start with the setup in 03-HANDOFF (ask me before creating `D:\AI-Orchestrator-lead`). Then run Stage 1 package by package (S1-0 … S1-7), running independent packages at the same time on different workers. Write every task so that it works on its own, as described in 02 "How to write each job".

Keep `internal/lead-chat/PROGRESS.md` (in the integration folder) up to date.

After each merged package, tell me in two or three plain sentences what is done, what is next, and anything I need to do (sign in, solve a captcha, approve).

Never restart TEAMYRA, never push, and never touch `D:\AI-Orchestrator`'s branch. When Stage 1's "done when" checks need the real app, ask me to merge `feat/lead-chat` and restart TEAMYRA. Only then continue with Stage 2.
