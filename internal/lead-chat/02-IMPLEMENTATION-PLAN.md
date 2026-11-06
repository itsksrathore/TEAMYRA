# Lead Chat: implementation plan

Each work package (WP) is one TEAMYRA job for one web worker, in its own worktree, small enough to finish in one job (at most about 30 tool calls). The lead reviews the diff, runs the tests, and merges before the next dependent WP starts. Packages without a dependency between them can run at the same time on different workers.

Workers (worker ids from `worker_status`):
- `chatgpt-normal`, `chatgpt-chatgpt-normal-3-cf8c`: most implementation.
- `deepseek-normal`: core and Python work, tests, debugging.
- `glm-normal`: tests and second implementations.
- `muse-normal`: surveys, docs, reviews.

Up to 5 jobs at once per account. Qwen is not usable (its captcha), Grok only once signed in, and ChatGPT Normal 2 is signed out.

Tests that every package must keep passing:
- `npm run desktop:check` (repository root);
- `python -m unittest discover -s tests`.

## Stage 1: Lead mode

| WP | Goal | Files | Depends | Suggested worker |
|---|---|---|---|---|
| S1-0 | Survey: read the files named in 01-DESIGN "What exists today" and write `plans-out/LEAD-S1-SURVEY.md` (exact functions to reuse, signatures, how a job loop turn works, where IPC and the panel live, risks). No code changes. | read only | none | muse-normal |
| S1-1 | Core action `lead.tool`: allowlisted `server.tool_call` with the `lead.` prefix removed, audit log, `job_wait` capped at 120 s. | `bridge/desktop_api.py`, `tests/test_lead_tool.py` (new) | S1-0 | deepseek-normal |
| S1-2 | `LeadSession` loop: lead tab, waits for finished replies, parses tool requests (exact text first), runs workspace/process/page tools and `lead.*` (through `callCore('lead.tool')`), sends results, saves `ROOT/lead/<id>.json`, resumes after a restart. No UI. | `apps/desktop/src/lead-session.js` (new), `apps/desktop/tests/lead-session.test.js` (new), `apps/desktop/package.json` (add to `check`) | S1-1 | chatgpt-normal |
| S1-3 | Lead bootstrap text and approval policy: `leadBootstrap(site, workspace)`, `needsApproval(tool, args, workspace)`. | `apps/desktop/src/lead-session.js`, its test | S1-2 | glm-normal |
| S1-4 | Desktop wiring: `#lead` providers kept out of job scanning, and IPC `teamyra:lead-start`, `lead-stop`, `lead-status`, `lead-approval`. | `apps/desktop/src/main.js`, `apps/desktop/src/preload.js`, `apps/desktop/src/chatgpt-web-provider.js` (a `lead` flag only) | S1-2 | chatgpt-chatgpt-normal-3-cf8c |
| S1-5 | Panel UI: Lead mode switch per account, status line ("running <tool>…", "waiting for you"), and the approval modal. Rebuild with `npm --workspace @teamyra/desktop run build:renderer`. | `apps/desktop/renderer/app.mjs`, `index.html`, CSS | S1-4 | chatgpt-normal |
| S1-6 | Docs: `docs/LEAD_MODE.md` (how to use it, tools, approvals, limits), and links from `docs/CHATGPT_WEB_AGENT.md` and `docs/ORCHESTRATION.md`. | docs | S1-5 | muse-normal |
| S1-7 | Review: independent review of the S1 diff against 01-DESIGN. Findings in `plans-out/LEAD-S1-REVIEW.md`. The lead hands fixes to the original workers. | read only | S1-5 | deepseek-normal or glm-normal (not the S1-2 author) |

**Stage 1 done when:**
- (a) all tests pass;
- (b) the user turns on Lead mode in the DeepSeek or ChatGPT panel and asks "start a job on muse-normal that lists the files in D:\AI-Orchestrator-tests\deepseek-live and wait for it"; the model calls `lead.start_task` and `lead.job_wait` and reports the result in the chat;
- (c) a `lead.worktree_merge` request shows the approval dialog, and Deny is respected;
- (d) after a desktop restart the lead chat continues in the same conversation.

## Stage 2: TEAMYRA chat window

| WP | Goal | Files | Depends | Suggested worker |
|---|---|---|---|---|
| S2-0 | Survey: Stage 1 as merged, renderer structure, `docs/UI_DESIGN.md`, and the Codex/Claude CLI resume options on this PC (`codex exec --help`, `claude --help`). Output `plans-out/LEAD-S2-SURVEY.md`. | read only | Stage 1 | muse-normal |
| S2-1 | Session store: `ROOT/lead-sessions/<id>/` (`session.json`, `messages.jsonl`, `summary.md`); create, list, append, load. | `apps/desktop/src/lead-chat-store.js` (new), test | S2-0 | deepseek-normal |
| S2-2 | Web-model routing: a chat turn goes to the chosen site's headless `LeadSession`; the reply and tool cards are recorded in the store. | `apps/desktop/src/lead-chat.js` (new), test | S2-1 | chatgpt-normal |
| S2-3 | CLI-model routing: Codex and Claude turns with session resume; output recorded; TEAMYRA tools through their MCP configuration. | `apps/desktop/src/lead-chat-cli.js` (new), test (with a fake CLI) | S2-1 | deepseek-normal |
| S2-4 | Model switch: handoff summary (ask the outgoing model; if that fails, build it from the store), and the incoming model gets bootstrap + summary + last 10 messages. | `apps/desktop/src/lead-chat.js`, test | S2-2, S2-3 | glm-normal |
| S2-5 | Chat view UI: sidebar entry, session list, messages with tool cards, composer, model picker, inline approvals, jobs side panel (live `job_status`). | `apps/desktop/renderer/lead-chat.mjs` (new), `index.html`, CSS, IPC in `main.js` and `preload.js` | S2-2 | chatgpt-chatgpt-normal-3-cf8c |
| S2-6 | Docs: `docs/LEAD_CHAT.md`. | docs | S2-5 | muse-normal |
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

Use `expect_files` for survey and review outputs, `project_path` = the WP's worktree, `pin: true`, and `timeout_minutes` 60 to 120.
