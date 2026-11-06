# DeepSeek Web Agent

TEAMYRA's **DeepSeek** worker uses the user's normal DeepSeek account (https://chat.deepseek.com) inside TEAMYRA Desktop, the same way ChatGPT Normal and Muse do (see `CHATGPT_WEB_AGENT.md`, `MUSE_WEB_AGENT.md`). It shares their job loop, tool protocol, recovery after a desktop restart, page recovery, process and page-check tools, and 5 jobs at once per account (each in its own chat).

## How it is built

- `apps/desktop/src/deepseek-web-provider.js` (site description `DEEPSEEK_SITE`) and `apps/desktop/src/deepseek-automation-adapter.js` (page driver, extends the ChatGPT adapter).
- **Workers:**
  - `deepseek-normal` (provider `deepseek-web`, account `web`), plus `deepseek-<profile>` for accounts under `profiles/deepseek-web/`;
  - browser profile `persist:teamyra-deepseek-profile[-<profile>]`;
  - readiness in `ROOT/deepseek/status.json` (git-ignored and blocked for workspace tools).
- **Desktop and core:** desktop accounts are keyed `deepseek:<profile>`. The core's site table is `bridge/web_sites.py`, and the desktop's is `WEB_CHAT_SITES` in `main.js` and `renderer/app.mjs`.
- **Signed in:** DeepSeek keeps its login in the page's storage. Its only token-like cookie is AWS's human-check one (`aws-waf-token`), so "signed in" is what the page showed when it was last loaded (`sessionFromPage`): the message box, and no sign-in form.

## Modes

**DeepThink** and **Search** are switched on before every message (`.ds-toggle-button`, `aria-pressed`); they apply per message. The bootstrap prompt tells DeepSeek:
- to keep citations and `[reference:N]` markers out of tool requests and files;
- to put tool requests in its answer, not in its thinking.

## Page structure (2026-11-06)

- **Composer:** `textarea[placeholder*="DeepSeek"]`. The round primary button (`.ds-button--primary.ds-button--filled.ds-button--circle`) has three states:
  - it sends;
  - it shows Stop, and is enabled with an empty box, while DeepSeek writes;
  - it is disabled (`ds-button--disabled`) when DeepSeek is done.
- **Messages:** virtual-list items `[data-virtual-list-item-key]`.
  - A reply's key is its message id (2, 4, ...); the user message before it has the negative key.
  - The answer is `.ds-assistant-message-main-content`. The thinking (`.ds-think-content`) is never part of the reply.
- **Conversation:** `/a/chat/s/<uuid>`. `/api/v0/chat/history_messages?chat_session_id=<uuid>` (Bearer token from `localStorage.userToken`) gives each message's `status` (`WIP`, `FINISHED`) and its exact `RESPONSE` text.

## Long tasks and errors

- **Exact tool requests:** the page shows rendered Markdown, so a tool request is parsed from the reply as written (the API's `RESPONSE` text, by message id, citation markers removed), falling back to the page text.
- **Continue:** a reply that stops at DeepSeek's length limit shows a Continue button. While waiting for a reply, TEAMYRA clicks it (up to 30 times per reply) and keeps waiting, so nobody has to press it.
- **Server busy:** a reply of "The server is busy. Please try again later." is not an answer. TEAMYRA waits (15 s, 30 s, 45 s) and asks again, up to 3 times.
- **Human check:** an AWS WAF captcha pauses the job as `needs_user` (DeepSeek verification), like ChatGPT's.

Not yet checked inside TEAMYRA Desktop: the Continue button's exact label (TEAMYRA matches "Continue" / "Continue generating" / 继续 / 继续生成), and the page in a hidden worker view.
