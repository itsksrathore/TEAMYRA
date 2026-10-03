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
- New-window requests never create a visible external BrowserWindow. Approved HTTPS authentication popups are hosted in a sibling WebContentsView overlay inside the same TEAMYRA window; unapproved destinations are denied.
- No Chrome/Edge process is launched as a user-visible external browser.
- If login expires, the normal ChatGPT login experience is shown in the embedded panel.
- CAPTCHA/human-verification pages are surfaced to the user. TEAMYRA does not attempt to bypass them.

## Worker routing

The core worker ID is `chatgpt-normal`, provider `chatgpt-web`.

A desktop heartbeat is written to runtime state. Core routing considers the worker ready only while:
1. the heartbeat is fresh;
2. the embedded page exposes an interactive ChatGPT prompt; and
3. a valid Teamyra workspace bridge is selected.

If TEAMYRA Desktop is closed, the worker becomes unavailable rather than pretending a headless browser worker exists.

ChatGPT jobs use the normal TEAMYRA job store, transcripts, events, cancellation, failover lineage, observability, and worktree paths. The desktop provider consumes jobs in `waiting_for_desktop` state. While a delegated job is running, manual input into the embedded page and workspace-changing controls are temporarily locked to prevent the user from accidentally switching the conversation underneath the automation. The Stop control writes the normal TEAMYRA job cancellation signal and also stops current web generation.

## Dedicated worker conversation

TEAMYRA maintains one runtime-only worker conversation record. A new worker conversation is created when none exists; its ChatGPT conversation ID/URL is remembered after a successful response. Existing `job_message` follow-ups carry the session ID so the same ChatGPT conversation can be reopened.

The conversation record is runtime state only and contains no password.

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

## Workspace sandbox

Every path is canonicalized before use.

By default:
- relative paths resolve against the selected workspace;
- `..\..\` traversal outside the workspace is denied;
- absolute paths outside the workspace are denied;
- filesystem/drive roots and the user's home root cannot be selected as a workspace;
- outside-workspace access is disabled in the current implementation;
- TEAMYRA runtime/profile stores and common credential/provider/browser stores remain blocked even when they are physically nested under the selected workspace;
- credential-like files such as `.env`, provider auth JSON, private key/certificate files, and SSH private-key names are blocked (example/sample env templates remain usable).

Blocked sensitive locations include SSH/GPG, AWS/Azure/GCloud/Kubernetes/Docker credentials, Claude/Codex/Antigravity provider homes, Windows credential/protect stores, Chrome/Edge profiles, Firefox profiles, Windows system directories, and the TEAMYRA local-agent token directory.

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

If ChatGPT's page structure changes, TEAMYRA reports prompt/send/stop failures and leaves the embedded page interactive for the user. Reconnect performs an actual in-view navigation reload without opening an external browser. It does not bypass authentication, CAPTCHAs, service limits or security controls.

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
