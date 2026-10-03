# AI Orchestrator

Location: D:\AI-Orchestrator

## Architecture
Claude Code is the master planner/orchestrator.
The user-scope MCP server `ai-workers` exposes:
- worker_status
- run_ai_worker
- run_ai_parallel
- resume_ai_worker
- clear_worker_cooldown

Workers:
- codex1 -> existing authenticated Codex CLI profile at C:\Users\kiran\.codex
- codex2 -> isolated profile at D:\AI-Orchestrator\profiles\codex2
- antigravity -> C:\Users\kiran\AppData\Local\agy\bin\agy.exe

## Routing
Auto order: Antigravity -> Codex 1 -> Codex 2.
Claude can explicitly choose a worker.
Rate/quota errors place a worker in temporary cooldown and auto routing continues.

## Token/context behavior
Worker raw logs stay under D:\AI-Orchestrator\logs.
Compact final results are returned to Claude.
Worker session IDs are returned so Claude can resume a worker without resending full prior context.

## Parallel safety
run_ai_parallel creates isolated Git worktrees under:
D:\AI-Orchestrator\worktrees

Each parallel task gets a separate branch/worktree.
Claude should review diffs and merge deliberately.

## Authentication helpers
Login-Codex2.cmd
- authenticates the isolated second ChatGPT/Codex account.

Login-Claude-Code.cmd
- starts Claude Code so /login can be completed if the standalone CLI is not authenticated.

Start-Claude-Code.cmd
- starts Claude Code with CLI paths prepared.
- default project is D:\Ai-editing.
- pass another project path as the first argument to start elsewhere.

## Important files
bridge\server.py                 MCP bridge
profiles\codex2\config.toml     isolated Codex 2 credential store
logs\                            full worker logs
results\                         compact/final Codex messages
worktrees\                       isolated parallel task worktrees

## Security
Do not commit auth.json files.
The bridge does not use dangerous bypass flags.
Codex write tasks use --approve-for-me.
Antigravity uses sandbox mode.
