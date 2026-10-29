# Provider Capability Boundaries

TEAMYRA only enables provider features that can be verified through the provider's installed CLI/runtime. It does not infer account isolation, quota percentages, or context-window state from undocumented files.

## Claude Code

- Native login detection: supported.
- Managed profile isolation: supported through `CLAUDE_CONFIG_DIR` and verified on Windows.
- Multiple TEAMYRA-managed profiles: supported.
- Reliable live context-window telemetry: currently not exposed through the CLI surface TEAMYRA can verify, so the UI does not fabricate a value.

## Codex

- Native login detection: supported.
- Managed profile isolation: supported through `CODEX_HOME`.
- Multiple TEAMYRA-managed profiles: supported.
- Reliable live context-window telemetry: currently not exposed through the CLI surface TEAMYRA can verify, so the UI does not fabricate a value.
- Windows sandbox: extra Codex homes link their `.sandbox`, `.sandbox-secrets` and `.sandbox-bin` to the main home (`%USERPROFILE%\.codex`) before a worker starts. The sandbox users are machine-wide; with separate copies every account switch re-provisioned them and raised a UAC prompt for `codex-windows-sandbox-setup.exe`. The account's own copy is kept beside it as `.sandbox*.local-<time>`.
- Image generation (`codex_image_batch`, `codex_image_status`, `codex_image_cancel`): up to 50 images per batch with Codex's built-in image tool. Each image is one short `codex exec` (reference images attached with `-i`, the configured model and reasoning effort, read-only sandbox; Codex looks at the result once and retries once if it clearly misses), and two run at once per signed-in Codex account. TEAMYRA copies the image from that account's `generated_images/<thread>` folder to the requested output (PNG, or converted to JPEG/WebP) and records its size. An account that hits its usage limit rests 15 minutes and its images move to the other account; a refusal is reported as `refused`, not retried. A worker job that drew images one at a time took 2–5 minutes per image; a direct image takes about 1 minute.

## Antigravity

- Native CLI/session detection: supported.
- Models and execution: supported.
- TEAMYRA plugin/skill/MCP integration: supported.
- Managed multi-account/profile isolation: disabled. The currently verified `agy` CLI exposes no account/profile/auth selector or documented per-profile home override that TEAMYRA can safely use.
- Add Account UI: intentionally disabled until a verifiable provider-supported isolation mechanism exists.
- Reliable live context-window telemetry: currently not exposed through the verified CLI surface.

## Normal ChatGPT Web

- Normal logged-in ChatGPT website account: supported through TEAMYRA Desktop; no OpenAI API key is used.
- Embedded UI: Electron `WebContentsView` inside TEAMYRA.
- Persistent login/session storage: dedicated Chromium `persist:teamyra-chatgpt-profile` partition.
- Local project tools: supported through the shared workspace-scoped TEAMYRA tool layer.
- Worker ID: `chatgpt-normal`; routing readiness requires a fresh desktop heartbeat and interactive prompt.
- Headless/server-only execution: intentionally unavailable because this provider depends on the user-owned embedded web session.
- CAPTCHA, login and human-verification handling: user-interactive only; TEAMYRA does not bypass provider security.
- DOM automation reliability: semantic selector fallbacks are implemented, but production UI changes can require adapter maintenance.

## Policy

When a provider later exposes a stable capability, TEAMYRA should add it behind an adapter-level capability flag, add automated tests, verify it on the target OS, and only then expose it in routing or UI.
