# Qwen and Grok Web Agents (and why GLM is not one)

Qwen and Grok run in TEAMYRA Desktop like ChatGPT Normal, Muse and DeepSeek. They share the same job loop, tool protocol, restart and page recovery, process and page-check tools, and up to 5 jobs at once per account, each in its own chat.

Unlike ChatGPT, Muse and DeepSeek, they are not separate adapters. Each is described by settings for `ChatSiteAdapter` (`apps/desktop/src/chat-site-adapter.js`):
- selectors for the message box, Send, Stop, user and reply messages, and the answer inside a reply (thinking excluded);
- a settings script that switches on the best model and settings before every message;
- where the site keeps each reply's exact text.

A Continue button at a site's length limit is clicked automatically, and "busy" replies are asked again.

## Qwen (`qwen-web`, worker `qwen-normal`)

`apps/desktop/src/qwen-web-provider.js`. Page checked on 2026-11-06, free plan.

- **Model:** the one Qwen labels its flagship ("Qwen3.8-Max: The flagship of Qwen3.8 model"), or else the newest `-Max`. The other choices were Qwen3.7-Plus and Qwen3.8-Omni-Flash.
- **Thinking:** set to **Thinking** (the choices are Auto / Thinking / Fast). Qwen's own web search runs automatically (`auto_search`).
- **Off:** Agent Mode, Web Dev, Deep Research and the image and video modes stay off. They work with Qwen's own tools, not the project.
- **Page:**
  - `textarea.message-input-textarea`, `button.send-button`, `button.stop-button` (shown while Qwen writes);
  - messages `.qwen-chat-message-user` and `.qwen-chat-message-assistant`;
  - reply id from `#chat-response-message-<id>`;
  - answer `.response-message-content.phase-answer`.
- **Exact text:** `/api/v2/chats/<id>` (Bearer `localStorage.token`), `history.messages[<id>].content_list` items with `phase: "answer"` and `status: "finished"`.
- **Signed in:** from the page (`sessionFromPage`); the login token is in page storage.
- **Human check:** Alibaba Cloud's slider captcha (`#aliyunCaptcha-window-popup`) pauses the job as `needs_user`.

## Grok (`grok-web`, worker `grok-normal`)

`apps/desktop/src/grok-web-provider.js` (`GrokAutomationAdapter`). Page checked on 2026-11-06.

- **Mode:** **Build** by default (`TEAMYRA_GROK_MODE` picks Expert, Heavy, Auto or Fast instead).
  - The model menu (`Model: <name>`) offers Fast, Build, Auto, Expert and Heavy, and every new chat starts on Fast.
  - The menu ignores scripted clicks, so TEAMYRA opens it with a real mouse click (`sendInputEvent`) and picks the mode before every message.
- **Page:**
  - message box `[contenteditable][aria-label="Message Grok"]` (rich editor, filled with `insertText`);
  - `button[data-testid="chat-submit"]` sends; `button[data-testid="composer-stop"]` shows while Grok writes;
  - user messages `[data-testid="user-message"]` (with a "You" label);
  - replies `#response-<id>` holding `[data-testid="assistant-message"]`, answer `.response-content-markdown`.
- **Exact text:** `/rest/app-chat/conversations/<id>/responses` gives `message` for each `responseId`, with `partial` while it is being written.
- **Signed in:** cookies `sso` / `sso-rw`.
- **Server errors:** a reply that ends empty with `streamErrors` (for example "Service temporarily unavailable") shows nothing on the page. TEAMYRA reads the error and asks again.
- **Build behaviour:** in a test, Build Mode started a terminal in Grok's own cloud sandbox (`InitTerminalSession`, a grok-sandbox.com preview) instead of answering with a tool request, and then failed with "Service temporarily unavailable". The bootstrap prompt tells it to work only through TEAMYRA tools. If it keeps building in its sandbox, Expert is the mode to use for local projects.
- **Hidden views:** the page draws nothing and its app does not start while its window is hidden or covered, so the adapter draws frames like the Muse one.

## GLM (z.ai): not added as a web worker

On chat.z.ai (checked 2026-11-06, free plan):
- the models are GLM-5.3-Flash, **GLM-5.3** and GLM-5.2, with Effort up to Max;
- GLM-5.3 was refused at peak hours ("Currently in peak hours … switch to GLM-5.3-Flash");
- an Alibaba Cloud slider captcha came up for **every message, even within one chat**.

A job sends tens of messages, so every one would wait for a person. TEAMYRA does not solve captchas. GLM should be added through Z.ai's official API instead (API key, no captcha).
