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
- New-window requests are denied; approved HTTPS authentication/navigation destinations remain in the embedded view.
- No Chrome/Edge process is launched as a user-visible external browser.
- If login expires, the normal ChatGPT login experience is shown in the embedded panel.
- CAPTCHA/human-verification pages are surfaced to the user. TEAMYRA does not attempt to bypass them.

## Worker routing

The core worker ID is `chatgpt-normal`, provider `chatgpt-web`.

A desktop heartbeat is written to runtime state. Core routing considers the worker ready only while:
1. the heartbeat is fresh; and
2. the embedded page exposes an interactive ChatGPT prompt.

If TEAMYRA Desktop is closed, the worker becomes unavailable rather than pretending a headless browser worker exists.

ChatGPT jobs use the normal TEAMYRA job store, transcripts, events, cancellation, failover lineage, observability, and worktree paths. The desktop provider consumes jobs in `waiting_for_desktop` state.

## Dedicated worker conversation

TEAMYRA maintains one runtime-only worker conversation record. A new worker conversation is created when none exists; its ChatGPT conversation ID/URL is remembered after a successful response. Existing `job_message` follow-ups carry the session ID so the same ChatGPT conversation can be reopened.

The conversation record is runtime state only and contains no password.

## Shared local tools

ChatGPT does not receive unrestricted Node.js or OS access. It requests tools through a text protocol handled by `ChatGPTAutomationAdapter`; TEAMYRA validates the request and executes it through the same `WorkspaceToolService` exposed to MCP callers.

Supported tools:

- `filesystem.list`
- `filesystem.stat`
- `filesystem.read`
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

MCP callers use the same implementation through `teamyra.workspace_tool`; they do not mutate the selected ChatGPT workspace.

## Workspace sandbox

Every path is canonicalized before use.

By default:
- relative paths resolve against the selected workspace;
- `..\..\` traversal outside the workspace is denied;
- absolute paths outside the workspace are denied;
- filesystem/drive roots and the user's home root cannot be selected as a workspace;
- common credential/provider/browser stores remain blocked even if outside-workspace access is explicitly enabled.

Blocked sensitive locations include SSH/GPG, AWS/Azure/GCloud/Kubernetes/Docker credentials, Claude/Codex/Antigravity provider homes, Windows credential/protect stores, Chrome/Edge profiles, Firefox profiles, Windows system directories, and the TEAMYRA local-agent token directory.

## Permissions

Persisted per selected ChatGPT workspace:

- Read files
- Search files
- Create files
- Edit files
- Terminal
- Git
- Access outside workspace (off by default)
- Destructive operations without confirmation (off by default)

Enabling the last two requires explicit UI confirmation. The automation tool loop always submits `confirm=false`; therefore destructive actions are denied unless the user explicitly enabled the destructive-without-confirmation policy.

`git.restore`, recursive deletion and destructive terminal/Git patterns are confirmation-gated. Drive formatting/system-management executables are blocked.

## Recoverability and audit

Existing files up to 10 MiB receive a bounded recovery copy before TEAMYRA write/patch/delete operations. Recovery files live under runtime `backups/workspace-tools` and are excluded from source control.

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

If ChatGPT's page structure changes, TEAMYRA reports prompt/send/stop failures and leaves the embedded page interactive for the user. It does not bypass authentication, CAPTCHAs, service limits or security controls.

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
