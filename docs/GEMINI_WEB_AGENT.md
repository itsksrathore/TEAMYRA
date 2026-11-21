# Gemini Web Agent (`gemini-web`)

Google Gemini (https://gemini.google.com/app) runs in TEAMYRA Desktop as a web-chat worker, like Qwen, GLM, DeepSeek and Grok. It uses the same job loop, the same `TEAMYRA_TOOL_REQUEST` text protocol, hand-overs, limit and captcha handling, restart recovery, and tabs (lanes). Its page driver is `ChatSiteAdapter` with a Gemini subclass: `apps/desktop/src/gemini-web-provider.js`.

## Accounts: the Google Media accounts

Gemini has no accounts or sign-in of its own. Each Google Media account is one Gemini worker, and that worker runs in the account's own browser profile (Electron partition), so it is already signed in.

| Google Media account | Gemini profile | Worker | Partition |
| --- | --- | --- | --- |
| built-in (`google`, `profiles/google-media/builtin-google.json`) | `web` | `gemini-normal` | `persist:teamyra-google-media-profile` |
| `profiles/google-media/<id>` | `<id>` | `gemini-<id>` | `persist:teamyra-google-media-<id>` |

- Partition names are the ones `media/google-media-session-manager.js` uses (`partitionForProfile`). A test checks they stay equal.
- The desktop (`main.js` `WEB_CHAT_SITES['gemini-web'].profileIds`) and the core (`bridge/worker_registry.py` `add_google_account_workers`) both read the account list from `profiles/google-media`. Nothing is created: there is no `profiles/gemini-web` folder.
- The Gemini session manager only calls `session.fromPartition`. It installs no permission, download or cookie handlers on the shared session, because those belong to the Google Media engine. TEAMYRA never signs anyone in or out from Gemini, and never writes to the Google session beyond what the Gemini page itself does.
- An account that is not signed in is reported as not ready, and no jobs go to it. The account is signed in under **Google Media**. A job that meets a signed-out page waits with "Google account not signed in (sign it in under Google Media)".
- Accounts rotate like those of the other sites. Each account runs 2 tabs by default.

### Optional per-account settings (read only)

Add these keys by hand to the Google Media account's own file (`profiles/google-media/<id>/teamyra-profile.json`, or `builtin-google.json` for the built-in account). TEAMYRA only reads them.

| Key | Effect |
| --- | --- |
| `gemini_model` | preferred model for this account, e.g. `"4 Neon"` |
| `gemini_enabled` | `false`: no automatic routing to this account's Gemini worker |
| `gemini_priority` | routing priority (default 310) |
| `gemini_lanes` | tabs at once (default 2, at most 8) |

## Model choice (data driven)

Before every message, the settings script opens the mode picker (`Open mode picker, currently …`). It reads the menu items and picks the first usable model from this order:

1. the job's `model=` (`start_task(model=...)`, stored as `meta.model`);
2. the account's `gemini_model`;
3. the default order `4 Carbon`, `4 Neon`, `Auto`. `TEAMYRA_GEMINI_MODELS` (a comma-separated list) replaces it.

How a name is matched:
- Names are compared without case, and without `-`, `_` or a leading "Gemini": `gemini-4-carbon` means `4 Carbon`.
- A menu line that equals the name wins over a whole-word match, so `4 Carbon` never picks a `4 Carbon Ultra`.
- Disabled items are skipped, such as a model that is not offered when signed out or a model at its limit.
- Models the page adds later work by name, with no code change.
- If no listed model is offered, the page's own choice stays.

The script also keeps the chat in **Chat** mode, not Task. On a new chat it presses the Chat toggle. If Task mode's start screen is showing, it presses "Not now".

## Page (checked 2026-11-21, signed out)

- **Message box:** `rich-textarea .ql-editor[role=textbox]` ("Enter a prompt for Gemini", a Quill editor filled with `insertText`).
- **Send / Stop:** `button[aria-label="Send message"]` sends. `button[aria-label="Stop response"]` is shown while Gemini writes.
- **Messages:**
  - your messages are `<user-query>`; their text is in `.query-text-line`, after a hidden "You said" label;
  - replies are `<model-response>`;
  - the answer is `<message-content id="message-content-id-r_<id>">` with `.markdown` inside;
  - the reply id is `r_<id>`.
- **Page text:** code blocks are read as fenced blocks. The page shows a language header instead of the fence.
- **Exact text:** the reply's own **Copy** button gives its Markdown exactly as written. TEAMYRA replaces `navigator.clipboard.write`/`writeText` for that one click and restores them afterwards, so nothing reaches the system clipboard. A live check showed backslashes, `__init__`, `<T>` and `*x*` kept.
- **Conversation URL:** `https://gemini.google.com/app/<hex id>` (also `/u/<n>/app/<id>`).
- **Signed out:** the page still shows its message box. TEAMYRA counts it as signed out when there is no "Google Account" button and a visible "Sign in" link or button.
- **Limits and checks:**
  - "You've reached your limit …" notices are caught by `limit-detect.js`, which also ignores `<user-query>` and `<message-content>` text;
  - human checks are caught by `challenge-detect.js` and the common widget list;
  - Google's "unusual traffic" page (`www.google.com/sorry`) may load in the view, so the user can solve it there.
- **Prompt rules:**
  - do not use Canvas, Deep Research, Task mode, code execution or apps;
  - write `TEAMYRA_TOOL_REQUEST` as plain text;
  - put it in a fenced code block.

## Needs a live signed-in check

The page was inspected signed out only. With a signed-in Google Media account, check these:
- the model menu's names and the trigger label after a pick (`currently 4 Carbon`?);
- extra models, and how a model at its limit is shown: disabled item, banner, or reply;
- Task mode's start screen when signed in;
- whether the Copy button still gives the raw Markdown for long replies;
- the limit wording.
