# Normal ChatGPT Web Agent

TEAMYRA's **ChatGPT Normal** worker uses the user's normal ChatGPT website session inside the Electron desktop application. It does **not** use the OpenAI API.

## Architecture

```
TEAMYRA Orchestrator / Claude Manager
             |
      worker=chatgpt-normal
             |
       TEAMYRA job store
             |
     ChatGPTWebProvider
       /      |       \
Session   Automation   WorkspaceBridge
Manager    Adapter          |
   |          |       TEAMYRA Core
WebContentsView       WorkspaceToolService
   |                       |
chatgpt.com          Files / Terminal / Git
```

The browser implementation is isolated from orchestration. Python core code never manipulates ChatGPT DOM selectors, and the ChatGPT DOM adapter never implements filesystem or Git behavior.

## Embedded browser

- Electron `WebContentsView` is lazy-created inside the main TEAMYRA window.
- Partition: `persist:teamyra-chatgpt-profile`.
- Cookies/session storage are owned by Chromium. TEAMYRA does not store ChatGPT usernames or passwords.
- `nodeIntegration=false`, `contextIsolation=true`, and `sandbox=true`.
- Browser permission checks/requests are denied by default, and unsolicited web downloads are cancelled.
- Normal ChatGPT browsing and authentication stay inside the sandboxed embedded `WebContentsView`; TEAMYRA does not open an external browser for ChatGPT sign-in.
- The default account keeps the backward-compatible `persist:teamyra-chatgpt-profile` partition. Extra ChatGPT accounts use their own persistent partitions derived from a safe profile ID, so cookies/local storage and logins remain isolated.
- The Agents shelf can create additional ChatGPT accounts. Each account owns an isolated persistent Chromium partition and its own background worker view, so multiple Normal ChatGPT accounts can execute delegated jobs concurrently instead of waiting on one shared browser.
- Delegated ChatGPT jobs wake/load their worker view hidden. Starting or routing a task never makes the ChatGPT surface visible; the user sees it only after explicitly opening that account from Agents (or an explicit `chatgpt_control` visibility/open command).
- Every delegated job carries its own `project_path`/workspace assignment. TEAMYRA sandboxes that job's filesystem, Git, and terminal tools to the assigned project directory, so an agent may work in a different approved folder without changing the UI's default workspace first.
- New delegated jobs start in a fresh ChatGPT conversation by default; only explicit resume/handoff jobs reuse a prior conversation session.
- Credentials are entered directly into the ChatGPT/OpenAI authentication pages rendered by Chromium; TEAMYRA does not store passwords.
- Unapproved popup/navigation destinations remain denied.
- CAPTCHA/human-verification pages are surfaced to the user. TEAMYRA does not attempt to bypass them.

## Worker routing

The default worker ID is `chatgpt-normal`, provider `chatgpt-web`. Extra accounts are discovered as separate `chatgpt-<profile-id>` workers.

Each profile writes its own readiness entry into shared runtime status. Core routing can queue work for any signed-in profile; its background view initializes on demand. The task's `project_path` is the assigned workspace for that job.

If TEAMYRA Desktop is closed, the worker becomes unavailable rather than pretending a headless browser worker exists.

ChatGPT jobs use the normal TEAMYRA job store, transcripts, events, cancellation, failover lineage, observability, and worktree paths. The desktop provider consumes jobs in `waiting_for_desktop` state. While a delegated job is running, manual input into the embedded page and workspace-changing controls are temporarily locked to prevent the user from accidentally switching the conversation underneath the automation. The Stop control writes the normal TEAMYRA job cancellation signal and also stops current web generation.

## Worker conversations

New delegated jobs start in fresh conversations so unrelated tasks and parallel agents do not inherit stale context. TEAMYRA records the successful conversation ID/URL as runtime metadata. Explicit resume/follow-up jobs carry a session ID and may reopen that exact conversation.

Conversation metadata is runtime state only and contains no password.

## Shared local tools

ChatGPT does not receive unrestricted Node.js or OS access. It requests tools through a text protocol handled by `ChatGPTAutomationAdapter`; TEAMYRA validates the request and executes it through the same `WorkspaceToolService` exposed to MCP callers.

Supported tools:

- `filesystem.list`
- `filesystem.stat`
- `filesystem.read` (paged with `offset` / `max_bytes` for bounded prompts)
- `filesystem.search`
- `filesystem.create`
- `filesystem.write`
- `filesystem.patch`
- `filesystem.move`
- `filesystem.rename`
- `filesystem.delete`
- `terminal.run`
- `git.status`
- `git.diff`
- `git.log`
- `git.add`
- `git.commit`
- `git.restore`

MCP callers use the same implementation through `teamyra.workspace_tool`; they do not mutate the selected ChatGPT workspace. MCP callers cannot self-authorize destructive/per-command confirmations. Their terminal surface is limited to the same bounded automatic inspection commands unless a future user-approval subsystem grants a capability explicitly.

Desktop-backed controls are also exposed through MCP without exposing browser cookies or provider credentials:
- `provider_list` — provider/account inventory for ChatGPT, Codex, Claude and Antigravity.
- `agent_account_create` / `agent_account_update` — managed account creation and routing/model/effort/permission settings where that provider supports isolated profiles.
- `chatgpt_control` — explicit ChatGPT profile status, open/close, reload/reconnect, new chat, stop/send, conversation navigation, visibility/bounds, workspace status/configuration, changes/revert and file attachment.
- Existing `start_task`, `job_*`, `worker_status`, `run_ai_parallel`, `review_*`, `handoff_*`, `worktree_*`, memory and observability tools remain the normal MCP control plane for all coding agents.

## Workspace sandbox

Every path is canonicalized before use.

By default:
- delegated jobs resolve relative paths against that task's assigned `project_path`; interactive ChatGPT tools use the UI-selected default workspace;
- an orchestrating agent can assign a different existing project directory when it starts a task;
- `..\..\` traversal outside the assigned workspace is denied;
- absolute paths outside the assigned workspace are denied;
- filesystem/drive roots and the user's home root cannot be assigned as a workspace;
- access beyond the assigned workspace requires assigning that other project location as the task workspace;
- TEAMYRA runtime/profile stores and common credential/provider/browser stores remain blocked even when they are physically nested under the selected workspace;
- credential-like files such as `.env`, provider auth JSON, private key/certificate files, and SSH private-key names are blocked (example/sample env templates remain usable).

Blocked sensitive locations include SSH/GPG, AWS/Azure/GCloud/Kubernetes/Docker credentials, Claude/Codex/Antigravity provider homes, Windows credential/protect stores, Chrome/Edge profiles, Firefox profiles, TEAMYRA's own Electron userData/browser partition (including the persistent ChatGPT cookies/session), Windows system directories, and the TEAMYRA local-agent token directory.

## Permissions

Persisted with the current selected ChatGPT workspace. When the user switches to a different workspace, high-risk permissions are reset to safe defaults instead of being carried over:

- Read files
- Search files
- Create files
- Edit files
- Terminal
- Git
- Access outside workspace (shown for forward compatibility but disabled in v1)
- Destructive operations without confirmation (off by default)

Terminal access is also off by default. Enabling destructive-without-confirmation requires an explicit typed UI acknowledgement. The automation tool loop always submits `confirm=false`.

`git.restore` and filesystem deletion are confirmation-gated unless the user explicitly opted into the destructive policy. The automated ChatGPT terminal path is intentionally limited to version checks (for example `node --version`) and read-only Git inspection. Other terminal commands, including interpreters, build/package scripts, shells, eval and destructive commands, require explicit per-command confirmation and therefore cannot be silently executed by the automated ChatGPT loop. Mutating Git commands are rejected through `terminal.run` and must use TEAMYRA's normalized Git tools. Drive formatting/system-management executables are blocked, and TEAMYRA-created commits use `--no-verify` so repository hooks are not executed implicitly.

## Recoverability and audit

Existing files up to 50 MiB receive a recovery copy before TEAMYRA write/patch operations; larger overwrite targets are refused instead of being modified without recovery. Delete operations and confirmed destination overwrites are moved into a runtime recovery/trash area rather than being permanently removed. Recovery state lives under ignored TEAMYRA runtime `backups/` paths and is itself inaccessible through ChatGPT workspace tools.

Tool results injected back into ChatGPT are also hard-capped; large results instruct the agent to request a narrower path/query/range instead of flooding the embedded prompt.

Audit records are JSONL under `logs/workspace-tools.jsonl` and include:
- timestamp;
- agent identity;
- tool;
- target;
- success/error.

File contents, browser cookies and the local-agent token are not written to the audit record.

Terminal subprocesses receive a scrubbed environment that removes variables whose names contain token/secret/password/API-key markers.

## File attachments

TEAMYRA validates the requested file through `filesystem.stat`, obtaining its canonical workspace-approved path. Electron then uses Chromium DevTools Protocol only to populate ChatGPT's existing semantic `input[type=file]`; it does not grant the webpage arbitrary filesystem access.

## DOM automation policy

Automation is isolated in `ChatGPTAutomationAdapter`.

It prefers semantic selectors:
- stable IDs;
- `data-testid`;
- accessibility labels;
- content-editable prompt elements.

No screen coordinates or pixel clicking are used.

If ChatGPT's page structure changes, TEAMYRA reports prompt/send/stop failures and leaves the embedded page interactive for the user. Reconnect performs an in-view navigation reload. External Chrome is used only for an approved authentication handoff when sign-in is required; it does not bypass authentication, CAPTCHAs, service limits or security controls.

## Remote-device direction

The current tool bridge is local and invoked by TEAMYRA Desktop/Core. No unauthenticated LAN or Internet filesystem/terminal listener is added.

A future remote-device implementation should keep `WorkspaceToolService` unchanged and place an authenticated device agent in front of it:

```
teamyra-local-agent
        |
 outbound authenticated encrypted channel
        v
 TEAMYRA relay
        |
 TEAMYRA orchestrator
```

The device initiates the connection; no inbound port is required. Capability/session authentication and per-workspace permission policy must remain mandatory.

## Verification

Automated CI verifies:
- Python workspace sandbox/tool tests on Windows and Linux;
- traversal/outside/system-root rejection;
- file lifecycle, search, terminal and Git behavior;
- recovery backups;
- token authentication and audit identity;
- terminal secret scrubbing;
- ChatGPT worker registration and desktop heartbeat routing;
- queued desktop-backed jobs do not spawn a fake ChatGPT CLI runner;
- Electron IPC/renderer contracts;
- persistent partition and sandbox flags;
- semantic/non-coordinate automation;
- desktop JavaScript syntax and renderer bundle;
- no OpenAI API integration in the ChatGPT web subsystem.

Live acceptance additionally requires a real TEAMYRA Windows desktop session and user ChatGPT account to verify login, restart persistence and the current chatgpt.com page against production UI. These checks must not be marked passed without running them on a live desktop.
