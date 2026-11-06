# Lead Chat: handoff package

The goal is that, when Claude Code or Codex hits its usage limit, the user can keep leading a project from inside TEAMYRA, with a web-chat model (ChatGPT Normal, Muse, DeepSeek, GLM) as the lead. The lead plans the work and hands it to TEAMYRA's workers.

There are two stages:
- **Stage 1, Lead mode** (about 2 to 3 days): the user chats in TEAMYRA's built-in ChatGPT, Muse, DeepSeek or GLM panel. TEAMYRA runs the model's tool requests, including TEAMYRA's own orchestration tools: start jobs, wait for them, read results, review and merge worktrees.
- **Stage 2, TEAMYRA chat** (about 1 to 2 weeks): TEAMYRA gets its own chat window with a model picker (web models and Codex/Claude CLI), saved sessions, a summary handed over on a model switch, approvals for risky actions, and the session's jobs shown in the chat.

| File | For |
|---|---|
| `01-DESIGN.md` | What to build and how it fits the existing code |
| `02-IMPLEMENTATION-PLAN.md` | Work packages: order, files, acceptance checks, which worker |
| `03-HANDOFF.md` | Rules for the AI that leads this build |
| `04-LEAD-PROMPT.md` | The prompt to paste into that AI (Codex recommended) |

Read `01` and `02` before starting. The lead follows `03`.

The repository is `D:\AI-Orchestrator`. Work goes on branch `feat/lead-chat`, created from `codex/flow-all-accounts`.
