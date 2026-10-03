# TEAMYRA Architecture

## Product shape
TEAMYRA is not a single MCP server or a single plugin. It is the orchestration platform that exposes multiple surfaces:

- Desktop UI
- Core orchestration engine
- Provider adapters
- MCP server
- CLI
- Plugins / skills

## Layer model

### 1. Desktop
The visual control desk. It should show:
- providers and accounts
- installed / signed-in state
- running and historical tasks
- live logs and events
- worktrees and diffs
- approvals
- usage and quota state
- connections and MCPs

### 2. Core
The source of truth for:
- tasks
- sessions
- workers
- routing
- cooldowns
- retries
- worktrees
- approvals
- memory
- state persistence

### 3. Provider adapters
Every agent provider implements a common interface:
- detect()
- status()
- listProfiles()
- createProfile()
- login()
- launch()
- resume()
- usage()
- cancel()

Initial adapters:
- Claude Code
- Codex
- Antigravity

Future adapters should be addable without changing the orchestration core.

### 4. MCP
TEAMYRA exposes its capabilities to external MCP clients.

Target tool families:
- agent.*
- account.*
- task.*
- session.*
- worktree.*
- usage.*
- route.*

### 5. CLI
Headless access for scripts, CI, and advanced users.

### 6. Plugins / Skills
Ecosystem-specific packaging that teaches supported agents when and how to use TEAMYRA.

## Authentication principles
- Reuse provider-native authentication.
- Never commit provider credentials.
- Avoid copying secrets into ordinary TEAMYRA app state.
- Use isolated provider homes/config roots for managed accounts when officially or technically supported.
- Keep unsupported account-isolation methods disabled until verified.

## Existing implementation to preserve
The current Python bridge already provides:
- worker delegation
- multiple Codex identities
- Antigravity execution
- cooldown/fallback
- detached jobs
- resumable sessions
- live job events
- parallel worktrees

It becomes the first implementation of TEAMYRA Core rather than being discarded.
