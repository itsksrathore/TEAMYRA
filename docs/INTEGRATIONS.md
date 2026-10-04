# TEAMYRA Provider Integrations

TEAMYRA exposes one local MCP endpoint to supported coding agents:

```text
http://127.0.0.1:8787/mcp
```

When TEAMYRA Desktop starts, it ensures a lightweight localhost wake gateway is available at this endpoint. The heavy MCP core is not kept alive unnecessarily: the first real MCP POST from Claude/Codex/Antigravity wakes it, active jobs keep it awake, and after 10 minutes without MCP activity and without active TEAMYRA jobs the core shuts down cleanly. Health/status checks do not wake the core. The hidden Electron UI also exits after 10 quiet minutes when no task, terminal, or ChatGPT job is active; the wake gateway remains available so the next coding-agent call can start the core again.

For development or manual troubleshooting, the endpoint can still be started directly:

```powershell
npm run mcp:http
```

The HTTP server is localhost-only in this build. Provider account credentials stay in the provider's own native storage; TEAMYRA integration files contain no account secrets.

## One-click desktop connection

Open **Agents** in TEAMYRA. Claude Code, Codex, and Antigravity each expose a **Connect Teamyra** action when their local CLI is installed.

The button:
- makes sure the local TEAMYRA MCP is running,
- installs a user-level TEAMYRA MCP entry for Claude Code or Codex,
- merges the TEAMYRA entry into Antigravity's global MCP config without deleting other servers,
- verifies that the provider now points at `http://127.0.0.1:8787/mcp`,
- shows **MCP Connected** after verification.

Existing provider login/account controls remain separate from MCP registration. TEAMYRA will not silently replace a Claude/Codex MCP entry named `teamyra` if it already points somewhere else.

## Claude Code

The repository includes a project-scoped `.mcp.json`:

```json
{
  "mcpServers": {
    "teamyra": {
      "type": "http",
      "url": "http://127.0.0.1:8787/mcp"
    }
  }
}
```

From the TEAMYRA repository, Claude Code discovers this automatically. On first use Claude may show TEAMYRA as **Pending approval**. Approve the project MCP in Claude Code before using its tools.

Verify:

```powershell
claude mcp list
```

## Codex

TEAMYRA ships a local Codex plugin at:

```text
plugins/teamyra
```

and a repository marketplace at:

```text
.agents/plugins/marketplace.json
```

Add the repository as a local marketplace and install the plugin:

```powershell
codex plugin marketplace add .
codex plugin add teamyra@teamyra-local
codex plugin list
```

The plugin contains:

- `.codex-plugin/plugin.json`
- `.mcp.json` pointing at the local TEAMYRA HTTP MCP
- `skills/teamyra/SKILL.md`

For isolated validation or development, set a separate `CODEX_HOME` before running the marketplace/plugin commands.

## Antigravity

The same `plugins/teamyra` directory is also an Antigravity-compatible plugin. It includes:

- `plugin.json`
- `mcp_config.json`
- `skills/teamyra/SKILL.md`

Validate and install:

```powershell
agy plugin validate .\plugins\teamyra
agy plugin install .\plugins\teamyra
agy plugin enable teamyra
```

Remove it with:

```powershell
agy plugin uninstall teamyra
```

The Antigravity MCP entry uses the current CLI's `serverUrl` format and points to the same localhost TEAMYRA endpoint.

## Any MCP-compatible coding app

TEAMYRA is not limited to the three provider CLIs above. Any local coding application, IDE extension, agent framework, or CLI that supports a custom **Streamable HTTP MCP server** can point at:

```text
http://127.0.0.1:8787/mcp
```

Use the client application's normal MCP configuration screen/file and add TEAMYRA as an HTTP MCP server. The exact configuration format belongs to that client, so TEAMYRA does not guess unsupported provider-specific settings.

After connecting, call `teamyra.worker_status` first to inspect the workers TEAMYRA can actually use on this machine.

## Recommended agent workflow

Once connected, agents should prefer the canonical `teamyra.*` tools:

1. `teamyra.worker_status` for account/provider readiness.
2. `teamyra.start_task` for one independent delegation.
3. `teamyra.graph_create` + `teamyra.graph_start` for dependency-aware work.
4. Approval gates for sensitive/destructive nodes.
5. `teamyra.test_run` or graph-node deterministic tests before merge.
6. Independent reviewer/fixer loops for material changes.
7. TEAMYRA-managed worktree diff/rebase/merge/discard for isolated Git changes.

Legacy un-namespaced MCP aliases remain available for compatibility, but new integrations should use `teamyra.*`.

## Idle / wake policy

- Public endpoint: `127.0.0.1:8787/mcp` (lightweight wake gateway).
- Internal heavy core: `127.0.0.1:8788/mcp`, started on demand.
- Default heavy-core idle timeout: 600 seconds (`TEAMYRA_IDLE_SECONDS`).
- Default hidden-desktop idle timeout: 600 seconds (`TEAMYRA_DESKTOP_IDLE_SECONDS`).
- Active TEAMYRA jobs prevent core sleep. Active desktop jobs, terminals, or ChatGPT work prevent hidden UI exit.
- The gateway `/healthz` endpoint reports awake/sleep state without waking the core.
