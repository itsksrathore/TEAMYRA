# Lead Chat: handoff rules for the lead AI

You lead and monitor. **TEAMYRA's web-chat workers write all the code, docs and tests.** You do not edit files yourself, except the progress log below.

## Who does the work

- **Use only these workers** (check each with `worker_status`; use only those with `ready: true`):
  - `chatgpt-normal` (ChatGPT Normal) and `chatgpt-chatgpt-normal-3-cf8c` (ChatGPT Normal 3);
  - `deepseek-normal` (DeepSeek, DeepThink + Search);
  - `muse-normal` (Muse);
  - `glm-normal` (GLM on Z.ai, the best GLM model).
- **Don't use:**
  - `qwen-normal`: its captcha blocks it;
  - `chatgpt-chatgpt-normal-2-5e8c`: signed out;
  - `grok-normal`: only if `worker_status` says ready;
  - Codex, Claude and Antigravity workers: the user wants this built by the web workers. Use them only if the user says so.
- **Capacity:** each account runs up to 5 jobs at once. Spread the work: several independent jobs at once across different workers is fine.

## Setup (once, with the user's OK)

1. **Integration folder.** Make a separate checkout, so the TEAMYRA the user runs from `D:\AI-Orchestrator` is never changed:
   ```
   git -C D:\AI-Orchestrator worktree add -b feat/lead-chat D:\AI-Orchestrator-lead codex/flow-all-accounts
   ```
   All work package worktrees are created from `D:\AI-Orchestrator-lead`, so they merge into `feat/lead-chat`.

   A new checkout has no `node_modules`, and the desktop tests need the installed packages (electron, esbuild and others). Link the existing ones instead of installing:
   ```
   cmd /c mklink /J D:\AI-Orchestrator-lead\node_modules D:\AI-Orchestrator\node_modules
   ```
   Do the same in each work package worktree: put this line in every task's "Checks" section, with the worktree path.
2. **Progress log.** Create `D:\AI-Orchestrator-lead\internal\lead-chat\PROGRESS.md`: one line per WP with state, job id, worker, worktree id and review result. You may write only this file and `plans-out/` notes.

## The loop for each work package

1. **Worktree:** `worktree_create {project_path: "D:\\AI-Orchestrator-lead", label: "<WP id>"}`. Note the `worktree_id` and its path.
2. **Start the job:** `start_task {worker, project_path: <worktree path>, label: "<WP id>", pin: true, timeout_minutes: 90, task: <self-contained task, see 02 "How to write each job">, expect_files: [...] for surveys and reviews}`.
3. **Follow it:** `job_wait {job_ids, timeout_seconds: 600}`, repeated. `job_status` or `job_events` show progress.
   - If a job is `needs_user` (sign-in or captcha), tell the user which worker and wait. Never try to get around it. If nobody completes it within 5 min and another agent is free, TEAMYRA moves the job there by itself.
   - TEAMYRA hands a stuck job over to another account or model on its own: on a usage limit, an unsolved check, a broken page or a failed chat. The new agent gets the task, every step done so far and the folder state (docs/AGENT_HANDOVER.md). Keep waiting on the **first** job id: `job_wait` and `job_result` follow the hand-over, and `job_result.failover_chain` lists it. Do not start a duplicate job for a moved task.
   - If a job fails for good (no hand-over left), read `job_result`, then send a corrected job (or `job_message` if the job is still alive), usually to the same worker. After two failures, try another worker.
4. **Review:**
   - `job_result` (the report) and `worktree_diff {worktree_id}` (the real change);
   - `test_run` in the worktree with the two suite commands from 02 plus the new test;
   - check the diff against 01-DESIGN and the WP's goal.

   Small problems go back to the same worker as a follow-up job in the same worktree.
5. **Merge:** `worktree_merge {worktree_id, confirm: true}` only when the tests pass and the diff matches the WP. Then update PROGRESS.md.
6. **Independent review:** S1-7 and S2-7 go to a different worker than the main author.

## Rules

- **Never restart TEAMYRA** Desktop or its core, and never stop processes, while jobs run. If something needs a restart, ask the user.
- **Never push**, never switch branches in `D:\AI-Orchestrator`, never merge into `codex/flow-all-accounts`. The user merges `feat/lead-chat` when they are happy.
- **Keep tasks small:** about 30 tool calls at most. Tool results are capped at about 40,000 characters, so tell workers to read big files in parts and filter command output.
- **Self-contained tasks:** workers know nothing beyond the task. Name every file to read, every file to change, the rules, the tests, and the report you want.
- **Report to the user** after each merged WP, in two or three plain sentences: what is done, what is next, and anything they must do (sign in, solve a check, approve).
- **Live checks** ("done when" in 02): ask the user to merge `feat/lead-chat` into their TEAMYRA and restart it, and to try the check with you, or to give you a separate instance to test.

## Facts you will need

- **TEAMYRA tools (MCP):** `http://127.0.0.1:8787/mcp`, server name `teamyra` (also `ai-workers`). Tools: `worker_status`, `start_task`, `job_wait`, `job_status`, `job_events`, `job_result`, `job_message`, `job_cancel`, `worktree_create`, `worktree_diff`, `worktree_merge`, `worktree_discard`, `test_run`, `team_report`, `queue_list`.
- **Test commands** (in a worktree):
  ```
  npm run desktop:check
  python -m unittest discover -s tests
  ```
  `test_run` takes argv arrays: `["npm","run","desktop:check"]` and `["python","-m","unittest","discover","-s","tests"]`.
- **Docs to give workers:**
  - `internal/lead-chat/01-DESIGN.md` and `02-IMPLEMENTATION-PLAN.md`;
  - `docs/CHATGPT_WEB_AGENT.md` (job loop, tool protocol, lanes);
  - `docs/QWEN_GROK_WEB_AGENTS.md` (settings-based sites);
  - `docs/UI_DESIGN.md` (renderer).
