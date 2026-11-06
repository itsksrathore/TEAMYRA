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

Planned. Page findings so far:
- The message box is a rich editor (`[contenteditable][aria-label="Message Grok"]`).
- The model menu (`Model: <name>`) offers Fast, **Build**, Auto, Expert and Heavy. Grok's Build Mode makes and previews websites and apps. Grok's model menu ignores scripted clicks, so TEAMYRA has to choose Build with real input events.
- A new chat starts on the saved mode (`modes-selected-id`).
- The page draws nothing, and its app does not start, while its window is hidden or covered; it needs the frame drawing used for Muse.

## GLM (z.ai): not added as a web worker

On chat.z.ai (checked 2026-11-06, free plan):
- the models are GLM-5.3-Flash, **GLM-5.3** and GLM-5.2, with Effort up to Max;
- GLM-5.3 was refused at peak hours ("Currently in peak hours … switch to GLM-5.3-Flash");
- an Alibaba Cloud slider captcha came up for **every message, even within one chat**.

A job sends tens of messages, so every one would wait for a person. TEAMYRA does not solve captchas. GLM should be added through Z.ai's official API instead (API key, no captcha).
