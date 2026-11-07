# Handing a task over to another agent

A task on a web-chat agent (ChatGPT Normal, Muse, DeepSeek, GLM, Qwen, Grok) sometimes cannot go on. TEAMYRA then moves it to another agent by itself. The new agent continues where the old one stopped, and the lead does nothing and spends no tokens explaining the task again.

Code: `bridge/job_transfer.py` (core), `apps/desktop/src/limit-detect.js` and `chatgpt-web-provider.js` (desktop). Tests: `tests/test_job_transfer.py`, `apps/desktop/tests/limit-detect.test.js`, and the hand-over cases in `apps/desktop/tests/chatgpt-job-loop.test.js`.

## When a task moves

| What happened | How TEAMYRA notices | Job ends with reason |
|---|---|---|
| The site hit its usage limit | A short limit notice on the page while a reply is at least 30 s overdue, a reply that is only the site's limit message, or a Send button blocked by one | `usage_or_rate_limit` (the account also cools down for 30 min) |
| The site refuses this PC for now (ChatGPT: "Our systems have detected unusual activity coming from your system") | The same notice in the chat while a reply is overdue | `site_blocked`: the job goes to **another site**, and every account of the blocked site is skipped for 30 min, because the block is for the PC, not one account. Queued jobs leave the site too. |
| A captcha, human check or sign-in nobody completed | The job has been paused for it for 5 min, another agent is ready, and the chat is not open in TEAMYRA (you may be solving it) | `needs_user_timeout` |
| The page stayed broken after its reloads | Existing page recovery gives up | `page_unresponsive` |
| The chat failed in another way, or the model kept sending broken tool requests | Existing errors | `worker_error`, `tool_parse_error`, … |

A task that is still **queued**, or was given to an account that never started it, only changes accounts. That happens when its account shows a sign-in or check, or cools down after a limit, for 5 min. Nothing has run yet, so there is nothing to carry over.

These do not move a task: a cancel, the task's own time limit, a job started with `transfer: false`, and jobs of the older auto-failover chain (`worker: "auto"` CLI jobs).

## Where it goes

1. An agent with a **free tab** comes before a busy one.
2. Among those, **another account of the same site** comes first, then the other sites in this order: ChatGPT, Muse, DeepSeek, GLM, Qwen, Grok.
3. Skipped: agents already tried for this task, signed out, showing a check, or cooling down after a limit. If the lead gave the task a `worker_order`, only those agents are used.

If no agent is ready, the task waits up to 30 min and moves as soon as one is. Its card says **Moving…** meanwhile. After that it stays failed. A task moves at most 3 times.

## What the new agent gets

Its task is a context pack built from the files of every job in the chain:

- why the task moved, and the instruction to check the folder first and not start over;
- the **original task**, in full;
- **every step done so far**, newest kept if long: files read, files written or edited, and commands with their exit code (and error text when they failed);
- the list of files created or changed;
- the old agent's **last reply** (its latest plan or report);
- the **folder state**: commits since the task started, the diff summary and `git status`.

The work itself stays on disk in the same folder. The old chat's own memory (what it thought but did not write down) cannot move between accounts or sites, so the pack replaces it.

## For the lead

Nothing changes. `job_wait`, `job_result` and `job_status` on the first job id follow the hand-overs to the job that finishes. `job_result` lists the chain in `failover_chain`. `job_wait` does not report the failure while a hand-over is still coming. Pass `transfer: false` to `start_task` / `run_ai_worker` to keep a task where it is.

In the Tasks view the old card shows **Moved** ("Moved to DeepSeek 2: it continues there…"). The new card says which agent's task it continues.

## Settings

Optional, in `bridge/config.json`:

```json
"transfer": {
  "enabled": true,
  "max_transfers": 3,
  "pause_minutes": 5,
  "wait_minutes": 30,
  "providers": ["chatgpt-web", "muse-web", "deepseek-web", "glm-web", "qwen-web", "grok-web"],
  "pack_chars": 14000
}
```

- `enabled`: turns hand-overs on or off.
- `max_transfers`: how many times one task can move.
- `pause_minutes`: how long a check, sign-in or blocked account may hold a task before it moves.
- `wait_minutes`: how long a stopped task waits for a ready agent.
- `providers`: the order of the other sites.
- `pack_chars`: the size of the step list and last reply in the pack. The original task always comes in full.
