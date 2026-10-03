# TEAMYRA Desktop UI

## Product rule

The desktop application has exactly two permanent primary destinations:

1. **Tasks** — start work and watch agents work.
2. **Agents** — connect, open, and manage available workers.

Do not add Worktrees, Observability, Memory, Settings, Connections, ChatGPT, logs, usage, or other backend subsystems back into permanent primary navigation without a strong product reason. Those capabilities remain available through TEAMYRA Core/MCP/CLI/IPC and should surface contextually only when the user needs them.

The UI should answer two questions immediately:

- **What is working right now?**
- **Which agents can I use?**

## Tasks

Tasks are rendered as live work tiles rather than a dashboard of metrics.

Each tile should show only:
- agent identity;
- task title;
- small state indicator;
- live/recent transcript tail;
- workspace;
- Stop while active.

The New Task flow stays deliberately small:
- one task prompt;
- one workspace;
- one worker choice, defaulting to Auto.

Execution must continue through the existing TEAMYRA job store and `server.start_job`. The frontend must not create a second orchestration path.

## Agents

The Agents shelf shows provider/account readiness with minimal actions.

Each provider card should primarily expose:
- provider identity;
- connected/not-connected state;
- account rows;
- Open/Connect;
- Add Account only where TEAMYRA has verified profile isolation.

Provider-specific tuning remains backend/profile state unless a user action genuinely requires surfacing it.

ChatGPT Normal is an agent, not a third primary menu. Opening it replaces the Agents shelf with the embedded ChatGPT detail surface, and Back returns to Agents.

## Visual language

The current visual direction is adapted from the open-source Nami Glass workbench (Apache-2.0). See `THIRD_PARTY_NOTICES.md`.

Core characteristics:
- bright aurora desktop background;
- frosted translucent surfaces;
- subtle white rims and inset highlights;
- coral primary accent;
- compact monospaced micro-labels;
- rounded capsule controls;
- soft floating cards instead of dashboard boxes;
- restrained status dots/pills;
- minimal explanatory copy.

The renderer should feel like one workbench rather than a web admin dashboard.

## Complexity budget

When adding a feature, prefer this order:

1. backend-only behavior;
2. contextual action inside an existing task/agent surface;
3. small modal/popover;
4. only as a last resort, a new persistent section.

A feature being technically available is not sufficient reason to keep it permanently visible.

## Advanced capabilities retained

The simplified frontend does **not** remove TEAMYRA's existing:
- worktree/conflict-resolution backend;
- observability/timeline/log search;
- project memory;
- usage/readiness data;
- MCP/CLI;
- auto-update;
- terminal bridge;
- ChatGPT workspace tools and sandbox;
- review/handoff/orchestration systems.

These remain part of TEAMYRA and can be surfaced contextually later without expanding permanent navigation.
