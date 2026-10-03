# TEAMYRA MCP Pooling

TEAMYRA can act in both MCP directions:

- **Outward MCP server:** Claude, Codex, Antigravity, and other clients call TEAMYRA tools.
- **Inward MCP client/pool:** TEAMYRA keeps configured external stdio MCP servers alive and reuses them across callers.

## Why pooling exists

Without a shared gateway, each agent may launch its own copy of GitHub, browser, database, or other MCP servers. That wastes memory, creates duplicate authentication/session state, and makes lifecycle management harder.

When agents use the shared TEAMYRA HTTP endpoint at `http://127.0.0.1:8787/mcp`, one long-lived TEAMYRA process owns the pool:

```text
Claude ─┐
Codex ──┼──> TEAMYRA HTTP MCP ──> one pooled external MCP process
Agy ────┘
```

## Runtime configuration

Pool configuration is stored locally at:

```text
profiles/mcp-pool.json
```

The `profiles/` directory is excluded from Git. Environment values may exist in this runtime file, but TEAMYRA status/list responses expose only environment **key names**, never their values. Command arguments are also not returned by status APIs; only the executable and argv count are shown.

## CLI

Register an external stdio MCP server:

```powershell
teamyra pool register github --yes -- python path\to\server.py
```

For commands that have their own flags, place the command after `--`:

```powershell
teamyra pool register browser --yes -- npx @playwright/mcp@latest --headless
```

Inspect configuration/tools:

```powershell
teamyra pool list
teamyra pool tools browser
```

Call a pooled tool:

```powershell
teamyra pool call browser browser_navigate --arguments "{\"url\":\"https://example.com\"}"
```

Restart or remove:

```powershell
teamyra pool restart browser --yes
teamyra pool remove browser --yes
```

The one-shot CLI is primarily an admin/debug surface. **Cross-agent process sharing happens inside the long-lived TEAMYRA HTTP MCP process.**

## MCP tools

Namespaced tools:

- `teamyra.mcp_pool_list`
- `teamyra.mcp_pool_tools`
- `teamyra.mcp_pool_call`
- `teamyra.mcp_pool_register`
- `teamyra.mcp_pool_restart`
- `teamyra.mcp_pool_remove`

Mutating lifecycle actions require `confirm=true`.

## Safety and lifecycle

- External servers launch from argv arrays with `shell=False`.
- Registration validates names, cwd, env, argv length, and timeouts.
- Status responses redact environment values and command arguments.
- The first call lazily starts and initializes a server.
- Tool discovery is cached and can be refreshed.
- Concurrent JSON-RPC requests use unique IDs and a serialized stdin writer.
- If a pooled subprocess dies, a later call lazily starts and initializes it again.
- Explicit restart terminates the old process and creates a fresh one.
- Reader threads and stdio pipes are closed/joined during cleanup.
- Current pooling supports external **stdio MCP servers**. Remote HTTP upstream pooling can be added separately later.

## Runtime verification

The Windows runtime smoke test uses the real TEAMYRA HTTP MCP gateway and a temporary external MCP server. Two separate `teamyra.mcp_pool_call` requests were verified to hit the same external process PID; after `teamyra.mcp_pool_restart`, the next call used a different PID.
