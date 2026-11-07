# Lead Chat: implementation plan

Each work package (WP) is one TEAMYRA job for one web worker, in its own worktree, small enough to finish in one job (at most about 30 tool calls). The lead reviews the diff, runs the tests, and merges before the next dependent WP starts. Packages without a dependency between them can run at the same time on different workers.

Workers (worker ids from `worker_status`):
- `chatgpt-normal`, `chatgpt-chatgpt-normal-3-cf8c`: most implementation.
- `deepseek-normal`: core and Python work, tests, debugging.
- `glm-normal`: tests and second implementations.
- `muse-normal`: surveys, docs, reviews.

Up to 5 jobs at once per account. Qwen is not usable (its captcha), Grok only once signed in, and ChatGPT Normal 2 is signed out. A job that hits a limit, an unsolved captcha or a broken chat moves to another worker by itself, with its context (`docs/AGENT_HANDOVER.md`). Keep following the first job id.

## Order: three waves

| Wave | Packages | Why this order |
|---|---|---|
| 1 | S1-0, C-1, C-2 at the same time | Independent files: the survey, plus code tools that make every later job cheaper. |
| 2 | C-3, then **Checkpoint A**; S1-1 in parallel | C-3 turns the code tools on for workers. After Checkpoint A, every later job uses them. |
| 3 | S1-2 … S1-9, then Stage 2 | Lead mode itself, with the new tools available. |

**Checkpoint A:** wait until C-1 … C-3 are merged into `feat/lead-chat` and pass the tests. Then ask the user to merge `feat/lead-chat` into their TEAMYRA and restart it (S1-1's code is harmless while nothing calls it). From then on, workers have `code.map`, `code.symbol` and short test output. If the user says no, continue anyway: only the speed-up is lost.

## Track C: code intelligence for workers and the lead

Workers are web chats with limited context. Today they find code by listing folders and reading whole files, and one test run can return 40,000 characters of log. These three packages give them a project map, symbol-level reads and short command output. They take the core ideas of Aider's repo map, Serena and RTK, built into TEAMYRA's own tools with no new service.

| WP | Goal | Files | Depends | Suggested worker |
|---|---|---|---|---|
| C-1 | **Short command output.** `terminal.run` gets a `digest` option, default `true` when the output is over 6,000 characters. The digest keeps: the command; the exit code; the first 40 lines; every line matching error, fail, panic, traceback, assert or warning, with 2 lines of context; the summary lines of pytest, unittest, node:test, npm, tsc and git; and the last 60 lines. Mark what was cut ("… 812 lines cut …"). Save the full output to `ROOT/logs/terminal/<job>/<n>.txt` and return its path. `digest: false` returns the output as today. | `bridge/workspace_tools.py`, `tests/test_workspace_digest.py` (new) | none | deepseek-normal |
| C-2 | **Code map and symbols, as a library** (no tool registration yet). `bridge/code_intel.py` has two functions. `code_map(path, budget_chars=8000, focus=None)` lists the files with their top-level classes, functions, exports and methods (name, kind, line), cut to the budget like Aider's repo map. Files imported by the most other files rank first, with recently changed and `focus`-matching files ahead of the rest. `find_symbol(path, name)` returns the definition with its line range and body text (at most 300 lines), plus up to 30 reference lines (`file:line: text`). Parsing: use tree-sitter if `import tree_sitter_language_pack` works; otherwise a regex extractor for py, js, mjs, cjs, ts, tsx, jsx, go, rs, java and cs. Never install packages. Skip `node_modules`, `.git`, `dist`, `build`, `__pycache__` and files over 1 MB. Cache per file by mtime in `ROOT/cache/code-intel/`. | `bridge/code_intel.py` (new), `tests/test_code_intel.py` (new, with small py and js/ts fixture projects) | none | chatgpt-normal |
| C-3 | **Turn them on.** Register `code.map {path, budget_chars?, focus?}` and `code.symbol {path, name}` as read tools in `bridge/workspace_tools.py`, with the same permission and path checks as `filesystem.search`. Add them to the tool list in the job bootstrap: the line starting "Available tools:" in `apps/desktop/src/chatgpt-web-provider.js`. Add one sentence there: "Start with code.map to see the project, and use code.symbol to read one function instead of a whole file." Document them in `docs/CHATGPT_WEB_AGENT.md`. | `bridge/workspace_tools.py`, `apps/desktop/src/chatgpt-web-provider.js`, docs, tests | C-1, C-2 | glm-normal |

Tests that every package must keep passing:
- `npm run desktop:check` (repository root);
- `python -m unittest discover -s tests`.

## Stage 1: Lead mode

| WP | Goal | Files | Depends | Suggested worker |
|---|---|---|---|---|
| S1-0 | Survey: read the files named in 01-DESIGN "What exists today" and write `plans-out/LEAD-S1-SURVEY.md` (exact functions to reuse, signatures, how a job loop turn works, where IPC and the panel live, risks). No code changes. | read only | none | muse-normal |
| S1-1 | Core action `lead.tool`: allowlisted `server.tool_call` with the `lead.` prefix removed, audit log, `job_wait` capped at 120 s. | `bridge/desktop_api.py`, `tests/test_lead_tool.py` (new) | S1-0 | deepseek-normal |
| S1-2 | `LeadSession` loop: lead tab, waits for finished replies, parses tool requests (exact text first), runs workspace/process/page tools and `lead.*` (through `callCore('lead.tool')`), sends results, saves `ROOT/lead/<id>.json`, resumes after a restart. No UI. | `apps/desktop/src/lead-session.js` (new), `apps/desktop/tests/lead-session.test.js` (new), `apps/desktop/package.json` (add to `check`) | S1-1 | chatgpt-normal |
| S1-3 | Lead bootstrap text and approval policy. `leadBootstrap(site, workspace)` stays short: the protocol, the lead role, the tool names and `lead.guide`. Add `needsApproval(tool, args, workspace)`. Add **`lead.guide {topic}`**, which returns one section of the lead rules on demand, so the bootstrap stays small (the Agent Skills idea). Topics: `jobs`, `review`, `merge`, `worktrees`, `memory`, `handover`, `approvals`. | `apps/desktop/src/lead-session.js`, `apps/desktop/src/lead-guide.js` (new), tests | S1-2 | glm-normal |
| S1-4 | Desktop wiring: `#lead` providers kept out of job scanning, and IPC `teamyra:lead-start`, `lead-stop`, `lead-status`, `lead-approval`. | `apps/desktop/src/main.js`, `apps/desktop/src/preload.js`, `apps/desktop/src/chatgpt-web-provider.js` (a `lead` flag only) | S1-2 | chatgpt-chatgpt-normal-3-cf8c |
| S1-5 | Panel UI: Lead mode switch per account, status line ("running <tool>…", "waiting for you"), and the approval modal. Rebuild with `npm --workspace @teamyra/desktop run build:renderer`. | `apps/desktop/renderer/app.mjs`, `index.html`, CSS | S1-4 | chatgpt-normal |
| S1-8 | **Lead state and chat rollover.** Each lead session keeps `ROOT/lead/<id>/state.md`: goal, decisions, work package table and open items. The lead writes it with `lead.state {set or append}`, and also saves important decisions with `memory_add` so later sessions find them. TEAMYRA starts a fresh chat in the lead tab when the lead chat passes 60 turns or about 150,000 characters sent, or when a desktop restart cannot reopen it. The fresh chat gets the bootstrap, `state.md`, the running jobs and the last 6 messages, and the panel tells the user. This keeps a long build within what a web model remembers. | `apps/desktop/src/lead-session.js`, test | S1-3 | chatgpt-chatgpt-normal-3-cf8c |
| S1-9 | **Lead hand-over.** The lead's own site can hit its usage limit (`apps/desktop/src/limit-detect.js`) or show a check nobody completes in 5 min. Then the lead session moves to another signed-in account of the same site; if there is none, TEAMYRA asks the user which site to move to. The session continues there from `state.md`, as in S1-8. | `apps/desktop/src/lead-session.js`, `main.js`, test | S1-8, S1-4 | deepseek-normal |
| S1-6 | Docs: `docs/LEAD_MODE.md` (how to use it, tools, approvals, limits), and links from `docs/CHATGPT_WEB_AGENT.md` and `docs/ORCHESTRATION.md`. | docs | S1-5 | muse-normal |
| S1-7 | Review: independent review of the S1 and Track C diff against 01-DESIGN. Findings go in `plans-out/LEAD-S1-REVIEW.md`, and the lead hands fixes to the original workers. | read only | S1-5, S1-9 | deepseek-normal or glm-normal (not the S1-2 author) |

**Stage 1 done when:**
- (a) all tests pass;
- (b) the user turns on Lead mode in the DeepSeek or ChatGPT panel and asks "start a job on muse-normal that lists the files in D:\AI-Orchestrator-tests\deepseek-live and wait for it"; the model calls `lead.start_task` and `lead.job_wait` and reports the result in the chat;
- (c) a `lead.worktree_merge` request shows the approval dialog, and Deny is respected;
- (d) after a desktop restart the lead chat continues in the same conversation;
- (e) workers' jobs use `code.map` / `code.symbol`, and a failing test run comes back as a short digest with the path to the full log;
- (f) with a small rollover limit set for the test, the lead chat rolls over to a fresh chat that still knows the goal and the open items.

## Stage 2: TEAMYRA chat window

| WP | Goal | Files | Depends | Suggested worker |
|---|---|---|---|---|
| S2-0 | Survey: Stage 1 as merged, renderer structure, `docs/UI_DESIGN.md`, and the Codex/Claude CLI resume options on this PC (`codex exec --help`, `claude --help`). Output `plans-out/LEAD-S2-SURVEY.md`. | read only | Stage 1 | muse-normal |
| S2-1 | Session store: `ROOT/lead-sessions/<id>/` (`session.json`, `messages.jsonl`, `summary.md`); create, list, append, load. | `apps/desktop/src/lead-chat-store.js` (new), test | S2-0 | deepseek-normal |
| S2-2 | Web-model routing: a chat turn goes to the chosen site's headless `LeadSession`; the reply and tool cards are recorded in the store. | `apps/desktop/src/lead-chat.js` (new), test | S2-1 | chatgpt-normal |
| S2-3 | CLI-model routing: Codex and Claude turns with session resume; output recorded; TEAMYRA tools through their MCP configuration. | `apps/desktop/src/lead-chat-cli.js` (new), test (with a fake CLI) | S2-1 | deepseek-normal |
| S2-4 | Model switch: handoff summary (ask the outgoing model; if that fails, build it from the store and `state.md`); the incoming model gets bootstrap + summary + last 10 messages. The same switch also runs **by itself** when the session's model hits a limit or a check (as in S1-9), with a note in the chat. | `apps/desktop/src/lead-chat.js`, test | S2-2, S2-3 | glm-normal |
| S2-5 | Chat view UI: sidebar entry, session list, messages with tool cards, composer, model picker, inline approvals, jobs side panel (live `job_status`). | `apps/desktop/renderer/lead-chat.mjs` (new), `index.html`, CSS, IPC in `main.js` and `preload.js` | S2-2 | chatgpt-chatgpt-normal-3-cf8c |
| S2-6 | Docs: `docs/LEAD_CHAT.md`. | docs | S2-5 | muse-normal |
| S2-8 | **Session numbers** in the jobs panel, per session: jobs started, done, failed and moved (hand-overs), characters sent and received (the jobs' `usage`), and time. Read from job metas; no new service. | `apps/desktop/renderer/lead-chat.mjs`, `main.js`, test | S2-5 | chatgpt-normal |
| S2-7 | Review, as in S1-7. Output `plans-out/LEAD-S2-REVIEW.md`. | read only | S2-5 | a worker that did not write S2-2 |

**Stage 2 done when:**
- (a) all tests pass;
- (b) in the Chat view the user starts a session on DeepSeek, has it start and finish a job, switches to ChatGPT Normal mid-session, and ChatGPT continues from the summary;
- (c) a Codex session works the same way while Codex has quota;
- (d) sessions reopen after a restart.

## How to write each job (task text for `start_task`)

Every task must work on its own, because the worker knows nothing else. Include:
1. **Goal:** one paragraph, and the WP id.
2. **What to read first:** exact paths (01-DESIGN and the files it names), and line ranges when known.
3. **What to change:** files and functions.
4. **Rules:**
   - keep existing behaviour and tests;
   - one tool request per reply;
   - read big files in parts;
   - no `git push`;
   - commit in the worktree with a clear message.
5. **Checks to run before finishing:** the test commands above, and the new test file. First, if the worktree has no `node_modules`, link it: `cmd /c mklink /J node_modules D:\AI-Orchestrator\node_modules`, run in the worktree root.
6. **Report:** what changed, the test output, and anything left open.

After Checkpoint A (when these tools exist), also tell every worker: "Start with `code.map` on the folders you work in, and read functions with `code.symbol`. Read a whole file only when you will edit most of it."

Use `expect_files` for survey and review outputs, `project_path` = the WP's worktree, `pin: true`, and `timeout_minutes` 60 to 120.
