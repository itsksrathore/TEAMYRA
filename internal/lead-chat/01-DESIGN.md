# Lead Chat: design

## What exists today (build on it, do not rebuild it)

- **Web-chat workers.**
  - `apps/desktop/src/chatgpt-web-provider.js` (`ChatGPTWebProvider`) drives a site in an Electron `WebContentsView`, one provider per account and tab ("lane", up to 5 per account).
  - The sites are ChatGPT (`chatgpt-web`), Muse (`muse-web-provider.js`), DeepSeek (`deepseek-web-provider.js`), Qwen, Grok and GLM (`qwen-`, `grok-`, `glm-web-provider.js`, all on the settings-based `chat-site-adapter.js`).
  - Desktop site table: `WEB_CHAT_SITES` in `apps/desktop/src/main.js` and `apps/desktop/renderer/app.mjs`. Core site table: `bridge/web_sites.py`.
- **Job loop.** `runDelegatedJob()` in `chatgpt-web-provider.js`:
  - The bootstrap prompt teaches the text tool protocol: one `TEAMYRA_TOOL_REQUEST {json}` line per reply, answered with `TEAMYRA_TOOL_RESULT {json}`.
  - Each reply is parsed from the exact reply text when the site keeps one (`rawReplyText`), else from the page text.
  - Tools run through `workspaceBridge.executeInWorkspace` (core action `chatgpt.tool.execute-in-workspace`, `bridge/workspace_tools.py`), `jobProcesses` (`process.*`) and `JobInspector` (`page.check`, `screen.capture`).
  - Results are cut to about 40,000 characters (`boundToolResult`).
  - Also present: recovery after a desktop restart (`chatgpt-state.json`, `resumeExchange`), page recovery, busy/"server busy" retries, and nudges when expected files are missing.
- **Core calls from the desktop.** `apps/desktop/src/core-api.js` (`callCore`) talks to one long-lived `bridge/desktop_api.py --serve` process. `desktop_api.handle(action, payload)` has `task.start`, `worktree.*` and `memory.*`, but **no** job status, wait, result or worker-status actions.
- **Orchestration tools** (MCP, `bridge/server.py`, `tool_call(name, args)`): `start_task`, `job_status`, `job_wait`, `job_result`, `job_cancel`, `job_message`, `worker_status`, `team_report`, `queue_list`, `worktree_create`, `worktree_diff`, `worktree_merge`, `worktree_discard`, `test_run`, `memory_*`, `review_start`. MCP endpoint: `http://127.0.0.1:8787/mcp`.
- **Hand-overs.** A web-chat job that hits a usage limit, an unsolved captcha or a broken chat moves to another account or model by itself, with a context pack of everything done so far (`bridge/job_transfer.py`, `apps/desktop/src/limit-detect.js`, `docs/AGENT_HANDOVER.md`). `job_wait` / `job_result` on the first job id follow it.
- **Memory and task graphs.** `memory_add`, `memory_search` and `memory_context` (`bridge/project_memory.py`) keep project facts and decisions across sessions. `graph_*` (`bridge/task_graph.py`) runs dependency graphs of jobs. Reuse these; do not add another memory or task system.
- **Panel.** The renderer (`renderer/app.mjs`, `#chatgptDetail`, `openChatgptDetail()`) shows an account's view. Main-process IPC is in `main.js` (`teamyra:chatgpt-*`). The view blocks manual input only while a job runs (`before-input-event` and `busy`).

## Stage 1: Lead mode in the site panel

Today the user can chat in a site panel, but tool requests are only acted on inside TEAMYRA jobs. Lead mode makes TEAMYRA act on them in a conversation the user drives.

### Behaviour

1. **Turning it on.** The panel header gets a **Lead mode** switch, per account. Turning it on:
   - opens a dedicated **lead tab** for that account, provider key `<account key>#lead`, separate from the job lanes so jobs never take over the lead conversation;
   - shows the lead tab in the panel;
   - sends the **lead bootstrap** as the first message of a new chat (the job bootstrap rules plus the lead tools and lead rules, below).
2. **The user chats normally** in the site's own message box: the view is visible and input is not blocked.
3. **Running tool requests.** TEAMYRA watches the lead tab:
   - When a finished reply (not generating, stable) contains `TEAMYRA_TOOL_REQUEST`, TEAMYRA parses it (exact text first, as in jobs), runs it, and sends `TEAMYRA_TOOL_RESULT …` into the same chat.
   - While a tool runs, the panel shows "running <tool>…" and blocks input, then unblocks it.
   - A reply without a tool request is the model talking to the user; TEAMYRA does nothing.
4. **Tools for the lead.**
   - Workspace tools: everything a job has (filesystem, terminal, git, process, page.check, screen.capture), in the workspace chosen in the panel.
   - Lead tools, new: `lead.start_task`, `lead.job_status`, `lead.job_wait` (at most 120 s per call, so the chat never hangs), `lead.job_result`, `lead.job_cancel`, `lead.job_message`, `lead.worker_status`, `lead.team_report`, `lead.queue_list`, `lead.worktree_create`, `lead.worktree_diff`, `lead.worktree_merge`, `lead.worktree_discard`, `lead.test_run`, `lead.memory_search`, `lead.memory_add`.
   - Each maps one to one to the MCP tool of the same name without `lead.`, with the same arguments.
   - Two run in the desktop itself: `lead.guide {topic}` (a section of the lead rules) and `lead.state {set | append}` (the session's `state.md`).
   - After Track C, the workspace tools also include `code.map` and `code.symbol`.
5. **Approvals.** `lead.worktree_merge`, `lead.worktree_discard`, `lead.job_cancel`, any `git push`, and `filesystem.delete` outside the workspace show a TEAMYRA approval dialog (renderer modal: what, where, Allow / Deny). Denied returns `{ok:false, error:"denied by the user"}`.
6. **Saved state.** `ROOT/lead/<session id>.json` holds the account, conversation URL and id, workspace, created time, the last 50 tool calls (tool, args summary, ok, time) and the pending approval. After a desktop restart the lead tab reopens the conversation; a tool that was running is reported as "outcome unknown", exactly as for jobs.

### How it plugs into the code

- **Executor.** A `LeadSession` class (new, `apps/desktop/src/lead-session.js`) owns one lead tab.
  - Reuse the job loop's pieces: the adapter (`assistantSnapshot`, `waitForAssistantReply`, `rawReplyText`, `parseToolRequestDetailed`, `sendTask`), `boundToolResult`, `jobProcesses` and `JobInspector`.
  - Do not reuse `runDelegatedJob` itself; the lead loop never ends on its own.
  - The loop: wait for a new, finished reply. If it has a tool request, approve when needed, run it and send the result. Otherwise wait again.
  - Use `noProgressMs` and the site's busy handling as jobs do.
- **Core action.** New `lead.tool` in `bridge/desktop_api.py`: `{name, args}` → `server.tool_call(name, args)` for an allowlist of the tools above, without the `lead.` prefix.
  - Import `server` lazily inside the action; the `--serve` process stays warm.
  - Audit every call in `logs/lead-tools.jsonl`.
- **Desktop wiring.**
  - `main.js`: create `#lead` providers, add IPC (`teamyra:lead-start`, `teamyra:lead-stop`, `teamyra:lead-status`, `teamyra:lead-approval`), and keep the lead tab out of job scanning (a provider flag `lead: true` that skips `processPendingJobsOnce`).
  - `preload.js`: expose these IPC calls.
  - `renderer/app.mjs` and `index.html`: the switch, a status line and the approval modal.
- **Prompt.** `leadBootstrap()` builds on the job bootstrap text:
  - you lead; you do not write code yourself;
  - hand work to TEAMYRA workers with `lead.start_task`, each job self-contained and in its own worktree;
  - follow with `lead.job_wait`, review with `lead.worktree_diff` and `lead.test_run`, merge with `lead.worktree_merge`;
  - report to the user in plain language.

### Keeping the lead's context small (S1-3, S1-8, S1-9)

A web model leading a long build forgets early details once the chat is long, and every tool result adds to the chat. Three parts keep it small:
- **Short bootstrap, rules on demand.** The bootstrap names the tools and the role. The detailed rules (how to write a job, review, merge, worktrees, memory, hand-overs, approvals) come from `lead.guide {topic}` when needed, the same idea as Agent Skills.
- **State file and rollover.** `ROOT/lead/<id>/state.md` holds the goal, decisions, the work package table and open items; the lead keeps it current with `lead.state`. A chat past 60 turns or about 150,000 characters sent rolls over to a fresh chat. The fresh chat gets the bootstrap, `state.md`, the running jobs and the last 6 messages. Decisions worth keeping also go to `memory_add`.
- **Lead hand-over.** A limit or an unsolved check on the lead's site moves the session to another account, as jobs move today, and the session continues from `state.md`.

## Track C: code intelligence for every job

Built before most of Stage 1, because it makes every later job cheaper (02, Checkpoint A).
- **`code.map {path, budget_chars?, focus?}`** gives a compact map of a folder: files with their top-level symbols and line numbers, cut to a budget. Files imported by the most others rank first, and recently changed and `focus` files come before the rest (Aider's repo map).
- **`code.symbol {path, name}`** returns one definition (its body, at most 300 lines) and up to 30 reference lines, so a worker reads one function instead of a whole file (the Serena idea).
- **`terminal.run` digest:** long output comes back as the command, exit code, head, error and summary lines with context, and tail, plus the path of the full log (the RTK idea).

Parsing uses tree-sitter (`tree-sitter-language-pack`) when it is installed, and a regex extractor otherwise, so nothing new has to be installed or packaged. Everything lives in `bridge/code_intel.py` and `bridge/workspace_tools.py`; there is no new service or database.

## From the outside research: what we use and what we skip

**Used, as ideas built into TEAMYRA's own code (no new dependency):**
- Aider repo map → `code.map`;
- Serena (symbol-level reads) → `code.symbol`;
- RTK (output compression) → the `terminal.run` digest;
- Agent Skills (rules on demand) → `lead.guide`;
- Claude-Mem and Beads ideas (session memory, task state) → `state.md`, rollover, the existing `memory_*` and `graph_*`;
- Gas Town ideas (handoffs, single owner per change) → the existing worktrees, one writer per worktree, and the hand-overs;
- a dashboard of runs → S2-8 session numbers.

**Optional:** tree-sitter, used when installed. ripgrep and ast-grep are not on this PC. Workers can use them through `terminal.run` once the user installs them, and nothing depends on them.

**Skipped, and why:**
- LangGraph, BullMQ, CrewAI, Ruflo, OpenHands, Gas Town as frameworks: TEAMYRA already has the queue, scheduler, worktrees, failover, hand-overs and task graphs. Moving onto a framework would take weeks and gain nothing for this build.
- Mem0, Graphiti, Cognee, Supermemory, Letta: they need an LLM API and often a graph or vector database. The existing memory plus `state.md` cover this build.
- Claude-Mem, ccusage, Context7, Claude Agent SDK, Vercel AI SDK, LiteLLM: they are tied to Claude Code or to API keys. TEAMYRA's leads and workers are web chats and CLIs.
- Langfuse and Phoenix: separate servers; TEAMYRA's timeline and job metas are enough for now.
- GitNexus: its license is non-commercial. codebase-memory-mcp, Graphify and CodeGraphContext overlap with `code.map` / `code.symbol`. Look at them later if the built-in tools fall short on very large projects.

### Out of scope for Stage 1

TEAMYRA's own chat window, Codex/Claude as the lead model, and switching models mid-session. All of these are Stage 2.

## Stage 2: TEAMYRA's own chat window

### Behaviour

- **The view.** A **Chat** view in the TEAMYRA sidebar has:
  - a session list;
  - a message list;
  - a composer;
  - a **model picker**: ChatGPT Normal (each signed-in account), Muse, DeepSeek, GLM, Grok (when signed in), Codex, Claude.
- **Web models.** The session runs in that site's lead tab (Stage 1's `LeadSession`, now headless). The user's message is sent with `sendTask`, the reply is read (exact text when available) and shown in TEAMYRA. Tool requests run exactly as in Stage 1 and appear as collapsible tool cards.
- **CLI models (Codex, Claude).** One CLI process per turn with the session resumed, using the CLIs' own resume options; check the exact flags with `codex exec --help` and `claude --help` on this PC. They reach TEAMYRA through their MCP configuration, so the lead tools are the MCP tools.
- **Model switch in a session.** TEAMYRA writes a handoff summary:
  - It asks the outgoing model for one ("Summarise this work for another model: goal, decisions, done, open items, files, jobs"); if that fails, it builds one from the session's tool log and job list.
  - The incoming model gets the lead bootstrap, the summary and the last 10 messages.
- **Sessions.** `ROOT/lead-sessions/<id>/` holds:
  - `session.json`: title, models used, workspace, created;
  - `messages.jsonl`: role, model, text, time, tool calls;
  - `summary.md`: the latest handoff summary.

  Sessions survive restarts and can be reopened and continued.
- **Approvals:** the same rules and modal as Stage 1, inline in the chat.
- **Jobs in the chat.** A side panel lists the session's jobs (`start_task` calls it made) with live state from `job_status`, and opens each job's transcript.

### How it plugs into the code

- Main process: `apps/desktop/src/lead-chat.js` (session store, model routing, summaries, CLI runner) on top of `LeadSession`.
- Renderer: `renderer/lead-chat.mjs` and the markup in `index.html`. Follow `docs/UI_DESIGN.md`.
- Core: no new orchestration logic. Reuse `lead.tool`.

## Constraints that apply to both stages

- One tool request per reply, results of about 40,000 characters at most, and exact reply text for parsing. These are existing protocol rules; do not change them.
- Never block the user's input in the panel except while a tool runs.
- Human checks (captchas) pause the session and notify the user. Nothing may try to solve or avoid them.
- Do not restart TEAMYRA Desktop or the core while jobs run.
- New code needs tests in the existing style: Node tests in `apps/desktop/tests` (add them to `npm run desktop:check`) and Python `unittest` in `tests/`. Keep `docs/CHATGPT_WEB_AGENT.md` and `docs/ORCHESTRATION.md` current.
