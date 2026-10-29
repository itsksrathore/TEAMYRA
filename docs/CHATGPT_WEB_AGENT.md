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

Worker prompts must emit a single `TEAMYRA_TOOL_REQUEST` JSON line for local tools; instructions to call native ChatGPT tools conflict with this bridge. Use relative paths with forward slashes. Reply detection follows the last message/turn identity (with a text fallback) because the web page virtualizes older turns and its visible message count can stop growing. Each job has a 256-request bound and uses its assigned job deadline rather than a separate five-minute response deadline.

Git tools use a strict argument contract: an unknown argument is an error that lists the allowed keys (it is never silently ignored). Every ref is verified with `git rev-parse --verify` before use, and the same sensitive-path filtering applies to commit comparisons as to working-tree diffs.

- `git.status`: `path` / `paths`.
- `git.diff`: `base` + optional `head`, or `range` (`"A..B"` or `"A...B"`; an empty side means `HEAD`), `staged` (not with `head`/`range`), `stat`, `name_only`, `unified` (context lines), `path` / `paths`.
- `git.log`: `max_count` (alias `limit`, max 100), `range`, `since` (for example `2026-01-31` or `2 weeks ago`), `path` / `paths`.
- `git.show`: `ref` (default `HEAD`), `stat`, `path` / `paths`. Credential-like files touched by the commit are left out and reported in `blocked_paths`.
- `git.add`: `paths` (explicit files). `git.commit`: `message`. `git.restore`: `paths`, `staged`.

For durable sequential worker queues, `python scripts/teamyra-task-queue.py <manifest.json>` resumes persisted job IDs, waits for each worker to become idle, and validates fresh output artifacts before advancing. Review JSONs require the assigned checkout's exact head. Failed jobs or missing/stale outputs stop that worker's queue and are recorded in `queue.log`; a CLI process exiting successfully alone is not evidence that a review completed. `teamyra run --wait`, `teamyra wait` and `teamyra result` exit with 0 only when the job state is `done`, 1 for `failed`/`cancelled`/`timed_out`, and 2 when the wait expired while a job is still `queued`, `running`, `waiting_for_desktop` or `needs_user`; the final state and reason of every job are printed to stderr.

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
- `git.show`
- `git.add`
- `git.commit`
- `git.restore`

MCP callers use the same implementation through `teamyra.workspace_tool`; they do not mutate the selected ChatGPT workspace. Explicit-workspace calls (`execute_in_workspace`, used by MCP and delegated jobs) take the user-only switches from the persisted user setting: a caller may lower `full_access`, `outside_workspace` or `destructive_without_confirmation`, but any attempt to raise one is rejected and audited. Without Full PC access their terminal surface is the sandboxed dev allowlist described under Permissions.

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

Blocked sensitive locations include SSH/GPG, AWS/Azure/GCloud/Kubernetes/Docker credentials, Claude/Codex/Antigravity/GitHub CLI provider homes and auth files (`~/.codex`, `~/.claude`, `~/.claude.json`, `~/.gemini`, `~/.config/gh`, `%APPDATA%\GitHub CLI`, `%APPDATA%\Claude`), Windows credential/protect/vault stores, Chrome/Edge/Brave/Chromium/Opera/Firefox profiles, TEAMYRA's own Electron userData/browser partition (including the persistent ChatGPT cookies/session), TEAMYRA runtime state (`chatgpt/`, `profiles/`, `jobs/`, `logs/`, `backups/`, ...), Windows system directories, and the TEAMYRA local-agent token directory.

## Full PC access (user-only)

`full_access` is a global switch stored in `ROOT/chatgpt/workspace.json` together with `outside_workspace` and `destructive_without_confirmation`. Only the user can turn these on:

- TEAMYRA Desktop settings: the desktop core action `chatgpt.workspace.configure` with a separate `access` object (`{"full_access": true, "outside_workspace": true, "destructive_without_confirmation": false}`) and `user_confirmed: true`, sent by the settings UI after its confirmation dialog. `access` without `workspace` changes only the switches.
- The interactive CLI: `teamyra chatgpt-access --full [--destructive-without-confirmation]` asks y/N and refuses without a TTY. `teamyra chatgpt-access --off` turns all three off and needs no TTY.

The regular `permissions` object, `execute`, `execute_in_workspace`, MCP tools (including `chatgpt_control` `workspace_configure`) and jobs can keep or lower these switches but never raise them; such attempts raise `PermissionError` and are audited. Switching the selected workspace keeps `full_access`/`outside_workspace` (they are not workspace-specific) and resets `destructive_without_confirmation`.

With Full PC access on:

- with `outside_workspace` also on, any absolute path on any drive is allowed for filesystem tools and as terminal `cwd`/arguments; relative paths still resolve against the workspace;
- the credential denylist above stays enforced (the blanket Windows directory block narrows to `Windows\System32\config`); drive roots and the home directory cannot be moved or deleted;
- `terminal.run` may run any argv, including shells, inline eval, package installs and network tools, without per-command confirmation;
- destructive commands still need `confirm` unless `destructive_without_confirmation` is on: recursive or wildcard deletes (`rm -r`, `rmdir`, `rd /s`, `del /s`, `Remove-Item -Recurse`), format/disk tools, `git push --force`/`--delete`, `git reset --hard`, `git clean -f*`, forced checkout, branch deletion, and registry edits (`reg add/delete/import`, PowerShell `HKLM:`/`HKCU:` writes). Shell scripts are scanned heuristically for these commands.

Terminal argument checks are heuristic: an absolute path argument is checked against the denylist, but a command running with Full PC access can reach anything the user account can.

## Permissions

Persisted with the current selected ChatGPT workspace. When the user switches to a different workspace, high-risk permissions are reset to safe defaults instead of being carried over:

- Read files
- Search files
- Create files
- Edit files
- Terminal
- Git
- Full PC access, Access outside workspace and Destructive operations without confirmation (user-only, off by default; see Full PC access)

The automation tool loop always submits `confirm=false`.

`git.restore` and filesystem deletion are confirmation-gated unless the user explicitly opted into the destructive policy.

With Full PC access off, `terminal.run` runs inside the workspace without confirmation only for this dev allowlist:

- version checks (`node|npm|npx --version`, `python --version`);
- read-only Git: `status`, `rev-parse`, `show`, `log`, `diff`, `blame`, `ls-files`, `grep`, `branch --list`, `rev-list`. TEAMYRA adds `-c core.fsmonitor=false`, `--no-ext-diff --no-textconv` and exclude pathspecs for credential-like files, and rejects Git global options, `--output`, `--no-index`, `--ext-diff`, `--textconv` and `rev:path` reads of credential-like files;
- `git add <files>` and `git commit -m <message>` (no `--amend`, `-a` or other options), executed through the `git.add`/`git.commit` tool checks;
- `node <script in workspace>`, `npx tsx <script in workspace>` (run as `npx --no tsx` so nothing is downloaded), `npm run <script>`, `npm test`, `python -m unittest|pytest`, `python <script in workspace>`.

Package installs (`npm install`, `pip install`, `python -m pip`, `npx <pkg>`, winget, choco, ...), network tools (curl, wget, ssh, `git fetch/pull/push/clone`, ...), drive/system-management executables and other mutating Git commands are refused even with confirmation unless Full PC access is on. Other commands (shells, eval, deletes, other interpreters) need explicit per-command confirmation. Arguments with shell metacharacters are refused for `.cmd`/`.bat` launchers. TEAMYRA-created commits use `--no-verify` so repository hooks are not executed implicitly.

## Recoverability and audit

Existing files up to 50 MiB receive a recovery copy before TEAMYRA write/patch operations; larger overwrite targets are refused instead of being modified without recovery. Delete operations and confirmed destination overwrites are moved into a runtime recovery/trash area rather than being permanently removed. Recovery state lives under ignored TEAMYRA runtime `backups/` paths and is itself inaccessible through ChatGPT workspace tools.

Tool results injected back into ChatGPT are also hard-capped; large results instruct the agent to request a narrower path/query/range instead of flooding the embedded prompt.

Audit records are JSONL under `logs/workspace-tools.jsonl`. Every tool call is recorded, including denied ones, terminal commands and writes. Records include:
- timestamp;
- agent identity;
- tool;
- target;
- success/error;
- access mode (`sandboxed` or `full_access`) and whether `confirm` was set;
- for `terminal.run`, the argv (clipped to 1000 characters) and exit code.

Access changes are recorded as `workspace.configure` / `workspace.access` with the resulting switch values, and rejected attempts to raise a user-only switch are recorded as errors.

File contents, browser cookies and the local-agent token are not written to the audit record.

Terminal subprocesses receive a scrubbed environment that removes variables whose names contain token/secret/password/API-key markers.

## Claude Code CLI discovery

`runtime_paths.claude_launch()` looks for the Claude Code CLI in this order: `TEAMYRA_CLAUDE`; `claude.exe`/`claude.cmd`/`claude.bat` on `PATH`; `where claude`; the npm global prefix from `npm prefix -g` (including the package binary `node_modules/@anthropic-ai/claude-code/bin/claude.exe`); `%APPDATA%\npm`; `%LOCALAPPDATA%\Programs`; `%USERPROFILE%\.claude\local`; `%USERPROFILE%\.local\bin`; and the CLI bundled with Claude desktop (`%APPDATA%\Claude\claude-code\<version>\<build>\claude.exe`, newest version). Extensionless npm shell shims are skipped on Windows. `teamyra doctor` reports the chosen path and how it was found under `claude_cli`.

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
- Full PC access is only enabled by the desktop `access` + `user_confirmed` path or the TTY-only CLI, never by tool/MCP calls, and the credential denylist stays enforced;
- strict Git tool arguments and the sandboxed terminal dev allowlist;
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
