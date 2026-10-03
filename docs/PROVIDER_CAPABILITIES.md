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

## Antigravity

- Native CLI/session detection: supported.
- Models and execution: supported.
- TEAMYRA plugin/skill/MCP integration: supported.
- Managed multi-account/profile isolation: disabled. The currently verified `agy` CLI exposes no account/profile/auth selector or documented per-profile home override that TEAMYRA can safely use.
- Add Account UI: intentionally disabled until a verifiable provider-supported isolation mechanism exists.
- Reliable live context-window telemetry: currently not exposed through the verified CLI surface.

## Policy

When a provider later exposes a stable capability, TEAMYRA should add it behind an adapter-level capability flag, add automated tests, verify it on the target OS, and only then expose it in routing or UI.
