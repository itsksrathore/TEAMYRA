# OpenCode workers (free models)

TEAMYRA runs OpenCode's free models as CLI workers, next to Codex, Claude Code
and Antigravity. Added 2026-11-08 with OpenCode 1.18.34.

## Setup

- Install the CLI: `npm i -g opencode-ai` (the OpenCode desktop app alone is not
  enough). TEAMYRA calls `%APPDATA%\npm\node_modules\opencode-ai\bin\opencode.exe`
  directly; set `TEAMYRA_OPENCODE` to use another binary.
- No sign-in is needed for the free models.
- On start, the core creates one account per free model under
  `profiles/opencode/<model>/teamyra-profile.json` (`name`, `model`, `enabled`,
  `priority`). An existing folder is never changed, so your own settings stay.

## Workers

Worker id: `opencode-<model>`, for example `opencode-glm-5.3-flash-free`. Enabled
at first: GLM 5.3 Flash, DeepSeek V4.1 Flash, MiMo V2.6 Flash, Nemotron 3.5
Super and Big Pickle. Lightning, Flint 40B, Beam, Crouton Alpha, Iceman and
Inkling 2 Small start disabled; turn them on in the Agents panel. Priority 600
puts them after Codex, Claude and the web-chat workers in automatic routing.

To use another OpenCode model (also a paid provider you signed in to in
OpenCode), add an account under OpenCode in the Agents panel and set its model
to `provider/model` as `opencode models` prints it.

## How a job runs

```
opencode run --model <model> --format json --dir <project> --auto <task>     (write job)
opencode run --model <model> --format json --dir <project> --agent plan <task>  (write=false)
```

- `--auto` approves OpenCode's own permission questions: a TEAMYRA job runs
  unattended. Read-only jobs use OpenCode's `plan` agent, which does not edit.
- `job_message` and the auto-resume after a crash continue the same OpenCode
  session (`--session <id>`); the session id comes from the JSON events.
- The runner reads `text` (the final message), `tool_use` (commands and their
  output), `step_finish` (tokens, cost) and `error` events. An error that names
  a rate limit or quota ends the job as `usage_or_rate_limit`, even with exit
  code 0, so the failover moves it.
- A worker counts as ready when `opencode models` lists its model (one shared
  call, cached for 2 minutes).

## Keep in mind

- Free models have rate limits, and their providers may keep or train on
  prompts. Do not send secrets or code that must stay private.
- They are smaller models: give them small, clear tasks and check the result.
