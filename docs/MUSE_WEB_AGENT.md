# Muse Web Agent

TEAMYRA's **Muse** worker will use the user's normal Muse app session (Meta's personal agent, https://muse.ai) inside the Electron desktop, the same way the ChatGPT Normal worker uses chatgpt.com (see `CHATGPT_WEB_AGENT.md`). It uses the user's Muse app subscription, not Muse Code or the Meta Model API.

## How it is built

- **Shared worker:** Muse reuses the ChatGPT Normal worker unchanged: queue and dispatch, desktop wake, job loop, page recovery, desktop-restart resume, the tool loop and the final report. `ChatGPTWebProvider` takes a `site` description (`CHATGPT_SITE` by default), and `MuseWebProvider` (`apps/desktop/src/muse-web-provider.js`) passes `MUSE_SITE`.
- **Page adapter:** `MuseAutomationAdapter` (`apps/desktop/src/muse-automation-adapter.js`) extends the ChatGPT adapter and overrides only the page-specific parts: probe, new side chat, send, stop, reply and last-user reads.
- **Workers:**
  - `muse-normal` (provider `muse-web`, default account `web`), plus `muse-<profile>` for accounts under `profiles/muse-web/`;
  - browser profile `persist:teamyra-muse-profile[-<profile>]`;
  - readiness in `ROOT/muse/status.json` (git-ignored and blocked for workspace tools, like `chatgpt/`).
- **Desktop:** Muse accounts live in the same provider map as ChatGPT accounts under the key `muse:<profile>`, so the embedded panel (open, size, new chat, stop, workspace) serves both. The Agents screen has a Muse card.
- **Jobs:** `start_task` / `run_ai_worker` with `worker: "muse-normal"`, then `job_status` / `job_wait` / `job_result`, exactly as for `chatgpt-normal`.
- **Allowed hosts:** every load passes Meta's account check (`muse.ai -> auth.muse.ai -> www.facebook.com -> www.instagram.com -> auth.meta.com -> auth.muse.ai -> muse.ai`). The Muse view therefore allows muse.ai, meta.com, facebook.com and instagram.com with their subdomains (plus Google/Apple sign-in); blocking any hop fails the load with `ERR_FAILED`.

## Local work

Every Muse user has its own Linux computer in Meta's cloud ("Muse Secure VM"), with a browser and terminal, and connected apps. By default Muse does tasks there, not on the user's PC. TEAMYRA jobs must therefore:

- tell Muse that the project is on the user's Windows PC and that it must not use its Secure VM, browser, terminal, connected apps or built-in tools for the job;
- use the same `TEAMYRA_TOOL_REQUEST` / `TEAMYRA_TOOL_RESULT` text protocol and `WorkspaceToolService` sandbox as ChatGPT.

Live check: Muse was given the ChatGPT bootstrap prompt plus the Secure VM rule in a new side chat. It replied with exactly one line, `TEAMYRA_TOOL_REQUEST {"tool":"filesystem.list","args":{"path":"."}}`. After the `TEAMYRA_TOOL_RESULT`, it gave the correct final answer without the marker, about 7 s per turn.

## Page structure (muse.ai, 2026-11-06)

- **Sign-in:** a "Mobile number or email" box, then a code. The main chat page has the title "Chat — Muse" and the `textarea[aria-label="Message"]` composer. Signed-out pages show the "Log in or create an account" heading instead.
- **Conversations:**
  - The main chat at `/` is the user's long-running agent chat with memory; jobs must not use it.
  - Jobs use **side chats**. Open the panel with `[data-testid="hatch-chat-switcher-trigger"]` ("Chats / Open chat and side chats"), then use the "New side chat" button inside `[data-testid="hatch-side-chats-panel-shell"]`. This opens `/thread/new`, and the first message turns it into `/thread/<uuid>`, the job's conversation id for resume.
- **Composer:** `textarea[aria-label="Message"]` (a plain textarea, React-controlled). A `button[aria-label="Send"]` appears only when the box has text. `button[aria-label="Attach file"]` attaches files.
- **Generation state:** `button[aria-label="Stop"]` is present while Muse is working and is gone when the reply is finished.
- **Messages:** `[data-message-item]` inside the `[role=log]` "Chat messages" list, with:
  - `data-message-role` = `user` or `assistant`;
  - `data-message-id`;
  - `data-message-turn-id` (one reply can span several message items with the same turn id; `data-message-group-position` first/last);
  - read the reply text with `innerText`.

  A user message shows `aria-busy=true` children while it is sending.
- **Approvals:** Muse asks the user to approve some actions (purchases, emails) in its Approvals panel. Local work through TEAMYRA tools does not use them, but a reply that waits on an approval must be surfaced as `needs_user`, not as a finished job.
