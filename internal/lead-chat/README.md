# Lead Chat: handoff package

The goal: when Claude Code or Codex hits its usage limit, the user can keep leading a project from inside TEAMYRA, with a web-chat model (ChatGPT Normal, Muse, DeepSeek, GLM) as the lead. The lead plans the work and hands it to TEAMYRA's workers.

The work is one track plus two stages:
- **Track C, code intelligence** (about 1 day, built first): `code.map` (a project map), `code.symbol` (read one function, not a whole file) and short test/command output, for every worker. Every later job gets cheaper and faster.
- **Stage 1, Lead mode** (about 2 to 3 days): the user chats in TEAMYRA's built-in ChatGPT, Muse, DeepSeek or GLM panel, and TEAMYRA runs the model's tool requests. These include TEAMYRA's own orchestration tools: start jobs, wait for them, read results, review and merge worktrees. The lead's context stays small: rules on demand, a state file, rollover to a fresh chat, and a hand-over to another account on a limit.
- **Stage 2, TEAMYRA chat** (about 1 to 2 weeks): TEAMYRA gets its own chat window with:
  - a model picker (web models and the Codex/Claude CLIs);
  - saved sessions;
  - a summary handed over on a model switch, or by itself on a limit;
  - approvals;
  - the session's jobs and their numbers shown in the chat.

| File | For |
|---|---|
| `01-DESIGN.md` | What to build and how it fits the existing code; what was taken from the outside research and what was skipped |
| `02-IMPLEMENTATION-PLAN.md` | Waves, work packages, files, acceptance checks, which worker |
| `03-HANDOFF.md` | Rules for the AI that leads this build |
| `04-LEAD-PROMPT.md` | The prompt to paste into that AI (Codex recommended) |

Read `01` and `02` before starting. The lead follows `03`.

The repository is `D:\AI-Orchestrator`. Work goes on branch `feat/lead-chat`, created from `codex/flow-all-accounts`.
