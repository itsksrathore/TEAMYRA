"""Workspace-scoped local tool service shared by TEAMYRA agents.

The service is deliberately independent of ChatGPT/Electron.  Desktop callers
authenticate with a runtime token; the in-process MCP server can call the same
implementation as a trusted TEAMYRA component.
"""
from __future__ import annotations

import hmac
import json
import os
import re
import shutil
import subprocess
import tempfile
import time
import uuid
from pathlib import Path

DEFAULT_PERMISSIONS = {
    "read": True,
    "search": True,
    "create": True,
    "write": True,
    "git": True,
    "terminal": True,
    "outside_workspace": False,
    "destructive_without_confirmation": False,
    "full_access": False,
}

# High-risk switches that only the user can turn on: from the TEAMYRA Desktop
# settings (desktop_api ``access`` + ``user_confirmed``) or the interactive
# ``teamyra chatgpt-access`` command.  Tool calls, jobs and MCP paths may only
# keep or lower them.
USER_ONLY_PERMISSIONS = ("full_access", "outside_workspace", "destructive_without_confirmation")

PERMISSION_BY_TOOL = {
    "filesystem.list": "read",
    "filesystem.stat": "read",
    "filesystem.read": "read",
    "filesystem.search": "search",
    "filesystem.create": "create",
    "filesystem.write": "write",
    "filesystem.patch": "write",
    "filesystem.move": "write",
    "filesystem.rename": "write",
    "filesystem.delete": "write",
    "terminal.run": "terminal",
    "git.status": "git",
    "git.diff": "git",
    "git.log": "git",
    "git.show": "git",
    "git.add": "git",
    "git.commit": "git",
    "git.restore": "git",
}

# Strict argument contract for the normalized Git tools: unknown keys are an
# error that lists the allowed keys instead of being silently ignored.
GIT_TOOL_ARGS = {
    "git.status": {"path", "paths"},
    "git.diff": {"base", "head", "range", "stat", "name_only", "path", "paths", "staged", "unified"},
    "git.log": {"max_count", "limit", "range", "path", "paths", "since"},
    "git.show": {"ref", "path", "paths", "stat"},
    "git.add": {"paths"},
    "git.commit": {"message"},
    "git.restore": {"paths", "staged"},
}

DESTRUCTIVE_TOOLS = {"filesystem.delete", "git.restore"}
# Executables are compared by base name without .exe/.cmd/.bat/.com.
HARD_BLOCKED_EXECUTABLES = {
    "format", "diskpart", "shutdown", "reboot", "bcdedit", "reg", "regedit",
    "cipher", "takeown", "icacls", "wmic", "sudo", "runas", "dd", "mount",
    "umount", "vssadmin", "sdelete", "format-volume", "clear-disk",
    "initialize-disk", "remove-partition",
}
READ_ONLY_REG_SUBCOMMANDS = {"query", "export", "compare"}
SHELL_EXECUTABLES = {"cmd", "powershell", "pwsh", "bash", "sh", "zsh"}
DESTRUCTIVE_EXECUTABLES = {"rm", "rmdir", "rd", "unlink", "del", "erase", "remove-item", "ri", "rimraf"}
INLINE_EVAL_FLAGS = {"-e", "--eval", "-c", "-command", "--command", "-p", "--print"}
PYTHON_EXECUTABLES = {"python", "python3", "py"}
NETWORK_EXECUTABLES = {
    "curl", "wget", "invoke-webrequest", "iwr", "invoke-restmethod", "irm", "ssh", "scp",
    "sftp", "ftp", "tftp", "nc", "ncat", "netcat", "telnet", "rsync", "bitsadmin",
    "certutil", "start-bitstransfer", "gh", "az", "aws", "gcloud",
}
# Package managers: name -> subcommands that install/remove/download packages.
# ``None`` means every invocation counts as a package operation.
PACKAGE_MANAGERS = {
    "npm": {"install", "i", "ci", "add", "update", "up", "upgrade", "remove", "rm", "uninstall",
            "un", "r", "link", "ln", "publish", "exec", "x", "create", "init", "dedupe", "prune"},
    "pnpm": {"install", "i", "add", "update", "up", "remove", "rm", "uninstall", "link", "publish",
             "exec", "dlx", "create", "dedupe", "prune"},
    "yarn": {"install", "add", "upgrade", "up", "remove", "link", "publish", "dlx", "create", "global"},
    "bun": {"install", "i", "add", "update", "remove", "rm", "link", "publish", "x", "create"},
    "npx": None, "pnpx": None, "bunx": None,
    "pip": {"install", "uninstall", "download", "wheel"},
    "pip3": {"install", "uninstall", "download", "wheel"},
    "pipx": None,
    "uv": {"pip", "add", "remove", "sync", "tool", "run", "init"},
    "poetry": {"add", "install", "remove", "update"},
    "pdm": {"add", "install", "remove", "update", "sync"},
    "conda": {"install", "create", "remove", "update"},
    "mamba": {"install", "create", "remove", "update"},
    "cargo": {"install", "add"},
    "go": {"install", "get"},
    "gem": {"install"},
    "dotnet": {"tool", "add"},
    "composer": {"install", "require", "update"},
    "choco": None, "winget": None, "scoop": None, "apt": None, "apt-get": None,
    "yum": None, "dnf": None, "brew": None, "nuget": None,
}
PYTHON_INSTALL_MODULES = {"pip", "ensurepip", "uv", "pipx"}
GIT_NETWORK_SUBCOMMANDS = {"push", "pull", "fetch", "clone", "ls-remote", "submodule"}
GIT_GLOBAL_OPTIONS_WITH_VALUE = {"-c", "-C", "--git-dir", "--work-tree", "--namespace", "--exec-path"}
SANDBOX_READ_ONLY_GIT = {
    "status", "rev-parse", "show", "log", "diff", "blame", "ls-files", "grep", "branch", "rev-list",
}
# Options that make read-only Git commands write files, read outside the
# repository or run external programs.
GIT_FORBIDDEN_OPTIONS = {"--no-index", "--ext-diff", "--textconv"}
GIT_FORBIDDEN_OPTION_PREFIXES = ("--output", "--open-files-in-pager", "-O", "--exec", "--upload-pack")
GIT_BRANCH_LIST_FLAGS = {
    "--list", "-l", "-a", "--all", "-r", "--remotes", "-v", "-vv", "--verbose", "--show-current",
    "--no-color", "--color", "--column", "--no-column", "-i", "--ignore-case",
}
GIT_BRANCH_LIST_PREFIXES = ("--format=", "--sort=", "--contains", "--no-contains", "--merged",
                            "--no-merged", "--points-at", "--abbrev")
BATCH_METACHARACTERS = set('&|<>^%!"\r\n')

SENSITIVE_FILE_NAMES = {
    "auth.json", ".credentials.json", "credentials.json", "secrets.json",
    "id_rsa", "id_ed25519", ".netrc", "_netrc", ".npmrc", ".pypirc",
    ".git-credentials", ".gitconfig.local", ".claude.json",
}
SENSITIVE_SUFFIXES = {".pem", ".pfx", ".p12", ".key"}
# Exclude pathspecs appended to read-only terminal Git commands so commit
# history cannot leak credential-like files that the filesystem tools hide.
GIT_SENSITIVE_EXCLUDES = [
    f":(exclude,glob,icase,top)**/{pattern}" for pattern in (
        ".env", ".env.*", "auth.json", ".credentials.json", "credentials.json", "secrets.json",
        "id_rsa", "id_ed25519", ".netrc", "_netrc", ".npmrc", ".pypirc", ".git-credentials",
        ".gitconfig.local", ".claude.json", "*.pem", "*.pfx", "*.p12", "*.key",
    )
]

SANDBOX_TERMINAL_HINT = (
    "automatic terminal access covers version checks, read-only Git (status, rev-parse, show, log, "
    "diff, blame, ls-files, grep, branch --list, rev-list), git add <files>, git commit -m, "
    "node <script>, npx tsx <script>, npm run <script>, npm test, python -m unittest|pytest and "
    "python <script> inside the workspace"
)


class WorkspaceToolError(ValueError):
    pass


def _user_only_message(key):
    return (
        f"{key} can only be enabled by the user from TEAMYRA Desktop settings or with "
        "`teamyra chatgpt-access --full` on an interactive terminal"
    )


def _exe_name(value) -> str:
    name = Path(str(value)).name.lower()
    for suffix in (".exe", ".cmd", ".bat", ".com"):
        if name.endswith(suffix):
            return name[: -len(suffix)]
    return name


def _outside_allowed(permissions) -> bool:
    return bool(permissions.get("full_access") and permissions.get("outside_workspace"))


def _write_json_atomic(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.name + f".tmp-{os.getpid()}-{uuid.uuid4().hex[:6]}")
    temp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(temp, path)


def _is_relative_to(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def _safe_permissions(value=None) -> dict:
    source = value if isinstance(value, dict) else {}
    # outside_workspace is honoured only together with full_access (see
    # _outside_allowed); both are user-only switches persisted in the global
    # workspace config, which no workspace tool can read or write.
    return {key: bool(source.get(key, default)) for key, default in DEFAULT_PERMISSIONS.items()}


class WorkspaceToolService:
    def __init__(self, root):
        self.root = Path(root).resolve()
        self.state_root = self.root / "chatgpt"
        self.settings_file = self.state_root / "workspace.json"
        token_file = os.environ.get("TEAMYRA_LOCAL_AGENT_TOKEN_FILE")
        self.token_file = Path(token_file).resolve() if token_file else self.state_root / "local-agent.token"
        self.audit_file = self.root / "logs" / "workspace-tools.jsonl"
        self.trash_root = self.root / "backups" / "workspace-tools-trash"

    def _verify_token(self, supplied, trusted=False):
        if trusted:
            return
        if not isinstance(supplied, str) or len(supplied) < 32:
            raise PermissionError("local-agent authentication failed")
        try:
            expected = self.token_file.read_text(encoding="utf-8").strip()
        except OSError as exc:
            raise PermissionError("local-agent authentication is not initialized") from exc
        if not hmac.compare_digest(expected, supplied):
            raise PermissionError("local-agent authentication failed")

    def _load(self):
        try:
            data = json.loads(self.settings_file.read_text(encoding="utf-8"))
        except Exception:
            data = {}
        workspace = data.get("workspace")
        permissions = _safe_permissions(data.get("permissions"))
        return {
            "workspace": str(workspace or ""),
            "permissions": permissions,
            "updated_at": data.get("updated_at"),
        }

    def _apply_access(self, permissions, access, user_confirmed):
        """Merge user-only switches into ``permissions`` in place.

        Turning a switch off is always allowed.  Turning one on requires
        ``user_confirmed`` which only the desktop settings UI and the
        interactive CLI pass."""
        if access is None:
            return
        if not isinstance(access, dict):
            raise WorkspaceToolError("access must be an object")
        unknown = sorted(set(access) - set(USER_ONLY_PERMISSIONS))
        if unknown:
            raise WorkspaceToolError(
                f"unknown access keys: {', '.join(unknown)}; allowed: {', '.join(USER_ONLY_PERMISSIONS)}"
            )
        for key in USER_ONLY_PERMISSIONS:
            if key not in access:
                continue
            if not isinstance(access[key], bool):
                raise WorkspaceToolError(f"access.{key} must be true or false")
            value = access[key]
            if value and not permissions.get(key) and user_confirmed is not True:
                raise PermissionError(_user_only_message(key))
            permissions[key] = value

    def configure(
        self, workspace, permissions=None, *, token=None, trusted=False, actor="teamyra",
        access=None, user_confirmed=False,
    ):
        """Select the default workspace and its regular permissions.

        ``permissions`` may keep or lower the user-only switches but never
        raise them; that needs ``access`` together with ``user_confirmed``."""
        self._verify_token(token, trusted)
        path = Path(str(workspace or "")).expanduser().resolve()
        if not path.exists() or not path.is_dir():
            raise WorkspaceToolError("workspace must be an existing directory")
        if path == Path(path.anchor).resolve() or path == Path.home().resolve():
            raise PermissionError("workspace is too broad; select a project directory")
        for blocked in self._sensitive_roots():
            if path == blocked or _is_relative_to(path, blocked):
                raise PermissionError("system or credential directories cannot be selected as workspaces")
        current = self._load()
        current_workspace = Path(current["workspace"]).resolve() if current["workspace"] else None
        same_workspace = bool(current_workspace and os.path.normcase(str(current_workspace)) == os.path.normcase(str(path)))
        if same_workspace:
            merged = dict(current["permissions"])
        else:
            # A new workspace starts from safe defaults; the global PC-access
            # switches are not workspace-specific and stay as the user set them.
            merged = _safe_permissions()
            merged["full_access"] = current["permissions"]["full_access"]
            merged["outside_workspace"] = current["permissions"]["outside_workspace"]
        try:
            if isinstance(permissions, dict):
                for key in DEFAULT_PERMISSIONS:
                    if key not in permissions:
                        continue
                    value = bool(permissions[key])
                    if key in USER_ONLY_PERMISSIONS and value and not merged.get(key):
                        raise PermissionError(_user_only_message(key))
                    merged[key] = value
            self._apply_access(merged, access, user_confirmed)
        except Exception as exc:
            self._audit(actor, "workspace.configure", str(path), False, exc)
            raise
        data = {"workspace": str(path), "permissions": merged, "updated_at": time.time()}
        _write_json_atomic(self.settings_file, data)
        self._audit(actor, "workspace.configure", str(path), True, extra={
            "access": {key: merged[key] for key in USER_ONLY_PERMISSIONS},
        })
        return data

    def set_access(self, access, *, token=None, trusted=False, actor="teamyra", user_confirmed=False):
        """Change only the user-only switches (no workspace selection needed)."""
        self._verify_token(token, trusted)
        current = self._load()
        merged = dict(current["permissions"])
        try:
            self._apply_access(merged, access, user_confirmed)
        except Exception as exc:
            self._audit(actor, "workspace.access", str(self.settings_file), False, exc)
            raise
        data = {"workspace": current["workspace"], "permissions": merged, "updated_at": time.time()}
        _write_json_atomic(self.settings_file, data)
        self._audit(actor, "workspace.access", str(self.settings_file), True, extra={
            "access": {key: merged[key] for key in USER_ONLY_PERMISSIONS},
        })
        return data

    def status(self, *, token=None, trusted=False):
        self._verify_token(token, trusted)
        data = self._load()
        path = Path(data["workspace"]).resolve() if data["workspace"] else None
        return {
            **data,
            "available": bool(path and path.exists() and path.is_dir()),
            "local_agent": "connected",
            "access_mode": "full" if data["permissions"]["full_access"] else "sandboxed",
        }

    def _effective_permissions(self, requested=None):
        """Permissions for an explicit-workspace call (MCP, delegated jobs).

        Regular keys come from ``requested`` (defaults when omitted).  The
        user-only switches always come from the persisted user setting; a
        caller may lower them but any attempt to raise one is rejected."""
        stored = self._load()["permissions"]
        source = requested if isinstance(requested, dict) else {}
        permissions = _safe_permissions(source)
        for key in USER_ONLY_PERMISSIONS:
            allowed = bool(stored.get(key))
            if key in source and bool(source[key]) and not allowed:
                raise PermissionError(_user_only_message(key))
            permissions[key] = allowed and (bool(source[key]) if key in source else True)
        return permissions

    def _workspace(self):
        data = self._load()
        if not data["workspace"]:
            raise WorkspaceToolError("no workspace selected")
        path = Path(data["workspace"]).resolve()
        if not path.exists() or not path.is_dir():
            raise WorkspaceToolError("selected workspace is unavailable")
        return path, data["permissions"]

    def _sensitive_roots(self, full_access=False):
        """Locations no workspace tool may touch.  With Full PC access the
        credential denylist stays; only the blanket Windows directory block is
        narrowed to the registry hives in System32\\config."""
        roots = [
            self.state_root,
            self.root / "profiles",
            self.root / "jobs",
            self.root / "logs",
            self.root / "results",
            self.root / "worktrees",
            self.root / "tasks",
            self.root / "memory",
            self.root / "backups",
        ]
        home = Path.home().resolve()
        roots.extend([
            home / ".ssh", home / ".gnupg", home / ".aws", home / ".azure",
            home / ".kube", home / ".docker", home / ".codex", home / ".claude",
            home / ".claude.json", home / ".gemini", home / ".config" / "gcloud",
            home / ".config" / "gh", home / ".mozilla",
            home / ".config" / "google-chrome", home / ".config" / "chromium",
        ])
        for env_name in ("WINDIR", "SystemRoot"):
            value = os.environ.get(env_name)
            if value:
                windows = Path(value)
                roots.append((windows / "System32" / "config") if full_access else windows)
        appdata = os.environ.get("APPDATA")
        local = os.environ.get("LOCALAPPDATA")
        if appdata:
            roots.extend([
                Path(appdata) / "Microsoft" / "Credentials",
                Path(appdata) / "Microsoft" / "Protect",
                Path(appdata) / "Mozilla" / "Firefox" / "Profiles",
                Path(appdata) / "Opera Software",
                Path(appdata) / "GitHub CLI",
                Path(appdata) / "Claude",
                Path(appdata) / "Antigravity",
            ])
        if local:
            roots.extend([
                Path(local) / "Google" / "Chrome" / "User Data",
                Path(local) / "Microsoft" / "Edge" / "User Data",
                Path(local) / "BraveSoftware" / "Brave-Browser" / "User Data",
                Path(local) / "Chromium" / "User Data",
                Path(local) / "Microsoft" / "Credentials",
                Path(local) / "Microsoft" / "Vault",
            ])
        token_file = os.environ.get("TEAMYRA_LOCAL_AGENT_TOKEN_FILE")
        if token_file:
            roots.append(Path(token_file).expanduser().resolve().parent)
        desktop_user_data = os.environ.get("TEAMYRA_DESKTOP_USER_DATA")
        if desktop_user_data:
            roots.append(Path(desktop_user_data).expanduser().resolve())
        return [p.resolve() for p in roots]

    def _sensitive_name(self, path: Path):
        name = path.name.lower()
        if name in SENSITIVE_FILE_NAMES:
            return True
        if name == ".env" or (name.startswith(".env.") and name not in {
            ".env.example", ".env.sample", ".env.template"
        }):
            return True
        return path.suffix.lower() in SENSITIVE_SUFFIXES

    def _path(self, raw, workspace, permissions, *, must_exist=False):
        text = str(raw or ".")
        candidate = Path(text).expanduser()
        if not candidate.is_absolute():
            candidate = workspace / candidate
        try:
            candidate = candidate.resolve(strict=must_exist)
        except FileNotFoundError as exc:
            raise WorkspaceToolError("path does not exist") from exc

        outside_ok = _outside_allowed(permissions)
        inside = _is_relative_to(candidate, workspace)
        if not inside and not outside_ok:
            raise PermissionError("path is outside the selected workspace")
        if inside:
            relative = candidate.relative_to(workspace)
            if relative.parts and relative.parts[0].lower() == ".git":
                raise PermissionError("direct filesystem access to Git internals is blocked; use TEAMYRA git tools")
        for blocked in self._sensitive_roots(full_access=outside_ok):
            if candidate == blocked or _is_relative_to(candidate, blocked):
                raise PermissionError("access to TEAMYRA runtime, system, or credential storage is blocked")
        if self._sensitive_name(candidate):
            raise PermissionError("access to credential-like files is blocked")
        return candidate

    def _visible_filter(self, workspace, permissions):
        """Predicate for directory listing / search results (resolved paths)."""
        outside_ok = _outside_allowed(permissions)
        roots = self._sensitive_roots(full_access=outside_ok)

        def visible(resolved: Path) -> bool:
            if not outside_ok and not _is_relative_to(resolved, workspace):
                return False
            if self._sensitive_name(resolved):
                return False
            return not any(resolved == blocked or _is_relative_to(resolved, blocked) for blocked in roots)

        return visible

    def _check(self, tool, permissions, *, confirm=False):
        permission = PERMISSION_BY_TOOL.get(tool)
        if not permission:
            raise WorkspaceToolError(f"unsupported workspace tool: {tool}")
        if not permissions.get(permission):
            raise PermissionError(f"{permission} permission is disabled")
        if tool in DESTRUCTIVE_TOOLS and not (
            permissions.get("destructive_without_confirmation") or confirm
        ):
            raise PermissionError("destructive operation requires explicit confirmation")

    def _audit(self, actor, tool, target, success, error=None, extra=None):
        self.audit_file.parent.mkdir(parents=True, exist_ok=True)
        record = {
            "ts": time.time(),
            "agent": str(actor or "unknown")[:100],
            "tool": str(tool)[:100],
            "target": str(target or "")[:1000],
            "result": "success" if success else "error",
        }
        if extra:
            record.update(extra)
        if error:
            record["error"] = str(error)[:1000]
        with self.audit_file.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(record, ensure_ascii=False) + "\n")

    def _backup_file(self, path: Path, workspace: Path):
        if not path.exists() or not path.is_file():
            return None
        try:
            size = path.stat().st_size
        except OSError as exc:
            raise WorkspaceToolError("could not inspect existing file for backup") from exc
        if size > 50 * 1024 * 1024:
            raise WorkspaceToolError("existing file is too large for a safe automatic backup")
        relative = path.relative_to(workspace) if _is_relative_to(path, workspace) else Path(path.name)
        safe = "__".join(relative.parts)
        backup_root = self.root / "backups" / "workspace-tools"
        backup_root.mkdir(parents=True, exist_ok=True)
        destination = backup_root / f"{int(time.time() * 1000)}-{uuid.uuid4().hex[:6]}-{safe}"
        shutil.copy2(path, destination)
        return str(destination)

    @staticmethod
    def _is_protected_root(path: Path):
        """Drive roots and the home directory are never moved or deleted."""
        try:
            return path == Path(path.anchor).resolve() or path == Path.home().resolve()
        except OSError:
            return True

    def _move_to_trash(self, path: Path, workspace: Path):
        relative = path.relative_to(workspace) if _is_relative_to(path, workspace) else Path(path.name)
        destination = self.trash_root / f"{int(time.time() * 1000)}-{uuid.uuid4().hex[:6]}" / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(path), str(destination))
        return str(destination)

    def _scrubbed_env(self):
        secret_markers = (
            "TOKEN", "SECRET", "PASSWORD", "PASSWD", "API_KEY", "APIKEY",
            "ACCESS_KEY", "PRIVATE_KEY", "CREDENTIAL", "AUTH", "COOKIE", "SESSION",
        )
        blocked_exact = {
            "GIT_EXTERNAL_DIFF", "GIT_DIFF_OPTS", "GIT_ASKPASS", "SSH_ASKPASS",
            "GIT_SSH_COMMAND", "TEAMYRA_LOCAL_AGENT_TOKEN_FILE",
        }
        return {
            key: value for key, value in os.environ.items()
            if key not in blocked_exact
            and not any(marker in key.upper() for marker in secret_markers)
        }

    def _atomic_text(self, path: Path, content: str):
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, temp_name = tempfile.mkstemp(prefix=f".{path.name}.teamyra-", dir=str(path.parent))
        try:
            with os.fdopen(fd, "w", encoding="utf-8", newline="") as handle:
                handle.write(content)
            os.replace(temp_name, path)
        except Exception:
            try:
                os.unlink(temp_name)
            except OSError:
                pass
            raise

    def execute(self, tool, args=None, *, token=None, trusted=False, actor="teamyra", confirm=False):
        self._verify_token(token, trusted)
        workspace, permissions = self._workspace()
        return self._execute_scoped(tool, args, workspace, permissions, actor, confirm)

    def execute_in_workspace(
        self, workspace, tool, args=None, permissions=None, *,
        token=None, trusted=False, actor="teamyra", confirm=False,
    ):
        """Run the shared implementation against an explicit workspace without
        mutating the persisted ChatGPT workspace selection."""
        self._verify_token(token, trusted)
        scoped = Path(str(workspace or "")).expanduser().resolve()
        if not scoped.exists() or not scoped.is_dir():
            raise WorkspaceToolError("workspace must be an existing directory")
        if scoped == Path(scoped.anchor).resolve() or scoped == Path.home().resolve():
            raise PermissionError("workspace is too broad; assign a project directory")
        for blocked in self._sensitive_roots():
            if scoped == blocked or _is_relative_to(scoped, blocked):
                raise PermissionError("system or credential directories cannot be assigned as workspaces")
        try:
            scoped_permissions = self._effective_permissions(permissions)
        except PermissionError as exc:
            self._audit(actor, tool, str(scoped), False, exc, extra={"attempt": "raise_user_only_permission"})
            raise
        return self._execute_scoped(
            tool, args, scoped, scoped_permissions, actor, confirm
        )

    def _execute_scoped(self, tool, args, workspace, permissions, actor, confirm):
        args = args if isinstance(args, dict) else {}
        target = args.get("path") or args.get("cwd") or str(workspace)
        # Every call (terminal, writes, reads), including denied ones, is audited.
        extra = {
            "mode": "full_access" if permissions.get("full_access") else "sandboxed",
            "confirm": bool(confirm),
        }
        if tool == "terminal.run":
            argv = args.get("argv")
            extra["argv"] = (json.dumps(argv, ensure_ascii=False) if isinstance(argv, list) else str(argv))[:1000]
        try:
            self._check(tool, permissions, confirm=confirm)
            result = self._execute(tool, args, workspace, permissions, confirm)
            if tool == "terminal.run" and isinstance(result, dict):
                extra["exit_code"] = result.get("exit_code")
            self._audit(actor, tool, target, True, extra=extra)
            return result
        except Exception as exc:
            self._audit(actor, tool, target, False, exc, extra=extra)
            raise

    def _execute(self, tool, args, workspace, permissions, confirm):
        if tool == "filesystem.list":
            path = self._path(args.get("path", "."), workspace, permissions, must_exist=True)
            if not path.is_dir():
                raise WorkspaceToolError("path is not a directory")
            limit = max(1, min(int(args.get("limit", 500)), 2000))
            items = []
            visible = self._visible_filter(workspace, permissions)
            for child in sorted(path.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower())):
                if len(items) >= limit:
                    break
                if child.name.lower() == ".git":
                    continue
                try:
                    resolved_child = child.resolve(strict=True)
                    if not visible(resolved_child):
                        continue
                    stat = resolved_child.stat()
                except (OSError, PermissionError):
                    continue
                items.append({
                    "name": child.name,
                    "path": str(child.relative_to(workspace)) if _is_relative_to(child, workspace) else str(child),
                    "type": "directory" if child.is_dir() else "file",
                    "size": stat.st_size if child.is_file() else None,
                    "modified": stat.st_mtime,
                })
            return {"path": str(path), "items": items, "clipped": len(items) >= limit}

        if tool == "filesystem.stat":
            path = self._path(args.get("path"), workspace, permissions, must_exist=True)
            stat = path.stat()
            return {
                "path": str(path),
                "type": "directory" if path.is_dir() else "file",
                "size": stat.st_size if path.is_file() else None,
                "modified": stat.st_mtime,
            }

        if tool == "filesystem.read":
            path = self._path(args.get("path"), workspace, permissions, must_exist=True)
            if not path.is_file():
                raise WorkspaceToolError("path is not a file")
            total_bytes = path.stat().st_size
            offset = max(0, min(int(args.get("offset", 0)), total_bytes))
            max_bytes = max(1, min(int(args.get("max_bytes", 128 * 1024)), 512 * 1024))
            with path.open("rb") as handle:
                header = handle.read(8192)
                if b"\x00" in header:
                    raise WorkspaceToolError("binary files are not returned as text")
                handle.seek(offset)
                data = handle.read(max_bytes + 1)
            clipped = len(data) > max_bytes or offset + len(data) < total_bytes
            chunk = data[:max_bytes]
            text = chunk.decode("utf-8", errors="replace")
            next_offset = offset + len(chunk) if clipped else None
            return {
                "path": str(path),
                "content": text,
                "bytes": total_bytes,
                "offset": offset,
                "next_offset": next_offset,
                "clipped": clipped,
            }

        if tool == "filesystem.search":
            query = str(args.get("query") or "")
            if not query:
                raise WorkspaceToolError("query is required")
            root = self._path(args.get("path", "."), workspace, permissions, must_exist=True)
            if not root.is_dir():
                raise WorkspaceToolError("search path is not a directory")
            pattern = str(args.get("glob") or "*")
            pattern_path = Path(pattern)
            if pattern_path.is_absolute() or ".." in pattern_path.parts:
                raise WorkspaceToolError("search glob must stay inside the workspace")
            limit = max(1, min(int(args.get("limit", 100)), 500))
            needle = query.casefold()
            results, scanned = [], 0
            skipped_dirs = {".git", "node_modules", "dist", "build", ".next", "__pycache__"}
            visible = self._visible_filter(workspace, permissions)
            for file in root.rglob(pattern):
                if any(part in skipped_dirs for part in file.parts):
                    continue
                if not file.is_file():
                    continue
                try:
                    resolved_file = file.resolve(strict=True)
                except OSError:
                    continue
                if not visible(resolved_file):
                    continue
                scanned += 1
                if scanned > 5000:
                    break
                try:
                    if file.stat().st_size > 1024 * 1024:
                        continue
                    raw = file.read_bytes()
                    if b"\x00" in raw[:8192]:
                        continue
                    text = raw.decode("utf-8", errors="replace")
                except OSError:
                    continue
                for line_no, line in enumerate(text.splitlines(), 1):
                    if needle in line.casefold():
                        results.append({
                            "path": str(file.relative_to(workspace)) if _is_relative_to(file, workspace) else str(file),
                            "line": line_no,
                            "text": line[:1000],
                        })
                        if len(results) >= limit:
                            return {"results": results, "clipped": True, "scanned_files": scanned}
            return {"results": results, "clipped": scanned > 5000, "scanned_files": scanned}

        if tool in {"filesystem.create", "filesystem.write"}:
            path = self._path(args.get("path"), workspace, permissions)
            if tool == "filesystem.create" and path.exists():
                raise WorkspaceToolError("file already exists")
            if path.exists() and path.is_dir():
                raise WorkspaceToolError("path is a directory")
            content = str(args.get("content") or "")
            if len(content.encode("utf-8")) > 2 * 1024 * 1024:
                raise WorkspaceToolError("write exceeds 2 MiB")
            backup = self._backup_file(path, workspace)
            self._atomic_text(path, content)
            return {"path": str(path), "bytes": len(content.encode("utf-8")), "backup": backup}

        if tool == "filesystem.patch":
            path = self._path(args.get("path"), workspace, permissions, must_exist=True)
            if not path.is_file():
                raise WorkspaceToolError("path is not a file")
            raw = path.read_bytes()
            if len(raw) > 2 * 1024 * 1024:
                raise WorkspaceToolError("patch target exceeds 2 MiB")
            if b"\x00" in raw[:8192]:
                raise WorkspaceToolError("binary files cannot be patched as text")
            text = raw.decode("utf-8", errors="strict")
            replacements = args.get("replacements")
            if not isinstance(replacements, list) or not replacements or len(replacements) > 100:
                raise WorkspaceToolError("replacements must be a non-empty list of at most 100 items")
            for item in replacements:
                if not isinstance(item, dict):
                    raise WorkspaceToolError("invalid replacement")
                old = str(item.get("find") or "")
                new = str(item.get("replace") or "")
                if not old:
                    raise WorkspaceToolError("replacement find text is required")
                actual = text.count(old)
                expected = item.get("expected")
                if expected is not None and actual != int(expected):
                    raise WorkspaceToolError(f"expected {expected} matches but found {actual}")
                if actual == 0:
                    raise WorkspaceToolError("patch find text was not found")
                count = item.get("count")
                text = text.replace(old, new, int(count)) if count is not None else text.replace(old, new)
            backup = self._backup_file(path, workspace)
            self._atomic_text(path, text)
            return {"path": str(path), "bytes": len(text.encode("utf-8")), "backup": backup}

        if tool in {"filesystem.move", "filesystem.rename"}:
            src = self._path(args.get("path"), workspace, permissions, must_exist=True)
            if src == workspace or self._is_protected_root(src):
                raise PermissionError("moving or renaming the workspace root is blocked")
            destination_raw = args.get("destination") or args.get("new_name")
            if tool == "filesystem.rename" and destination_raw and not Path(str(destination_raw)).is_absolute():
                dst = self._path(str(src.parent / str(destination_raw)), workspace, permissions)
            else:
                dst = self._path(destination_raw, workspace, permissions)
            if dst.exists() and not confirm:
                raise PermissionError("overwriting an existing destination requires confirmation")
            overwritten_backup = self._move_to_trash(dst, workspace) if dst.exists() else None
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(src), str(dst))
            return {"from": str(src), "to": str(dst), "overwritten_backup": overwritten_backup}

        if tool == "filesystem.delete":
            path = self._path(args.get("path"), workspace, permissions, must_exist=True)
            if path == workspace or self._is_protected_root(path):
                raise PermissionError("deleting the workspace root is blocked")
            if path.is_dir() and not args.get("recursive"):
                raise WorkspaceToolError("directory deletion requires recursive=true")
            recoverable_at = self._move_to_trash(path, workspace)
            return {"deleted": str(path), "recoverable_at": recoverable_at, "backup": recoverable_at}

        if tool == "terminal.run":
            return self._terminal(args, workspace, permissions, confirm)

        if tool.startswith("git."):
            return self._git(tool, args, workspace, permissions, confirm)

        raise WorkspaceToolError(f"unsupported workspace tool: {tool}")

    # ------------------------------------------------------------------ terminal

    def _command_tags(self, argv):
        """Classify a command (and, for shells, every command inside the shell
        script) as ``hard`` (system management), ``destructive``, ``delete``
        (any file removal) or ``network`` (network tools / package installs).

        Shell scripts are scanned heuristically: every word of every
        ``;``/``&&``/``|`` chunk is treated as a possible command start."""
        tags = set()
        candidates = [[str(value) for value in argv]]
        if _exe_name(argv[0]) in SHELL_EXECUTABLES:
            script = " ".join(str(value) for value in argv[1:])
            for chunk in re.split(r"&&|\|\||[;&|\r\n`]|\$\(", script):
                words = chunk.replace('"', " ").replace("'", " ").replace("(", " ").replace(")", " ").split()
                candidates.extend(words[index:] for index in range(len(words)))
        for tokens in candidates:
            if tokens:
                tags |= self._classify_command(tokens)
        return tags

    def _classify_command(self, tokens):
        exe = _exe_name(tokens[0])
        args = [value.lower() for value in tokens[1:]]
        tags = set()
        if exe in HARD_BLOCKED_EXECUTABLES or exe.startswith("mkfs"):
            tags.add("hard")
            if not (exe == "reg" and args[:1] and args[0] in READ_ONLY_REG_SUBCOMMANDS):
                tags.add("destructive")
        if exe in DESTRUCTIVE_EXECUTABLES:
            tags.add("delete")
            recursive = any(
                arg in {"--recursive", "/s", "-recurse", "-recursive", "-r"}
                or (arg.startswith("-") and not arg.startswith("--") and "r" in arg[1:] and exe in {"rm", "rimraf"})
                for arg in args
            )
            wildcard = any("*" in arg or "?" in arg for arg in args)
            if exe in {"rmdir", "rd", "rimraf"} or recursive or wildcard:
                tags.add("destructive")
        if exe in {"set-itemproperty", "new-itemproperty", "remove-itemproperty", "new-item",
                   "remove-item", "set-item", "rename-itemproperty"} and any(
            arg.startswith(("hklm:", "hkcu:", "hkcr:", "hku:", "registry::", "hkey_")) for arg in args
        ):
            tags.add("destructive")
        if exe in NETWORK_EXECUTABLES:
            tags.add("network")
        if exe in PACKAGE_MANAGERS:
            subcommands = PACKAGE_MANAGERS[exe]
            positional = [arg for arg in args if not arg.startswith("-")]
            global_flag = any(arg in {"-g", "--global", "--location=global"} for arg in args)
            npx_tsx = exe == "npx" and [arg for arg in args if arg != "--no"][:1] == ["tsx"]
            if npx_tsx:
                pass
            elif subcommands is None or global_flag or (positional and positional[0] in subcommands):
                tags.add("network")
            elif exe == "yarn" and not positional:
                tags.add("network")  # bare `yarn` installs dependencies
        if exe in PYTHON_EXECUTABLES and "-m" in args:
            index = args.index("-m")
            if index + 1 < len(args) and args[index + 1] in PYTHON_INSTALL_MODULES:
                tags.add("network")
        if exe == "git":
            sub, rest = self._git_subcommand(args)
            if sub in GIT_NETWORK_SUBCOMMANDS or (sub == "remote" and rest[:1] in (["update"], ["prune"], ["show"])):
                tags.add("network")
            if self._git_is_destructive(sub, rest):
                tags.add("destructive")
        return tags

    @staticmethod
    def _git_subcommand(args):
        index = 0
        while index < len(args) and args[index].startswith("-"):
            index += 2 if args[index] in {item.lower() for item in GIT_GLOBAL_OPTIONS_WITH_VALUE} else 1
        if index >= len(args):
            return "", []
        return args[index], args[index + 1:]

    @staticmethod
    def _git_is_destructive(sub, rest):
        short_flags = [arg for arg in rest if arg.startswith("-") and not arg.startswith("--")]
        if sub == "reset":
            return "--hard" in rest or "--merge" in rest or "--keep" in rest
        if sub == "clean":
            return "--force" in rest or any("f" in arg for arg in short_flags)
        if sub == "push":
            return any(
                arg in {"--force", "-f", "--mirror", "--delete", "-d", "--prune"}
                or arg.startswith("--force-with-lease") or arg.startswith("--force-if-includes")
                or (arg.startswith("+") and len(arg) > 1) or (arg.startswith(":") and len(arg) > 1)
                for arg in rest
            )
        if sub in {"checkout", "switch"}:
            return any(arg in {"-f", "--force", "--discard-changes", "--", "."} for arg in rest)
        if sub == "restore":
            return not ("--staged" in rest and not any(arg in {"--worktree", "-w"} for arg in rest))
        if sub == "branch":
            return any(arg in {"-d", "--delete", "-f", "--force", "-m", "--move"} for arg in rest)
        if sub == "stash":
            return rest[:1] in (["drop"], ["clear"])
        if sub == "reflog":
            return rest[:1] in (["expire"], ["delete"])
        if sub == "gc":
            return any(arg.startswith("--prune") for arg in rest)
        if sub == "update-ref":
            return "-d" in rest
        return sub in {"filter-branch", "filter-repo", "rm"}

    def _resolve_executable(self, value, env):
        text = str(value)
        if os.path.dirname(text):
            return text
        return shutil.which(text, path=(env or {}).get("PATH")) or text

    def _workspace_script(self, raw, cwd, workspace, permissions):
        """True when ``raw`` names an existing file inside the workspace.
        Raises PermissionError for paths outside it or credential-like files."""
        candidate = Path(str(raw).strip('"'))
        if not candidate.is_absolute():
            candidate = cwd / candidate
        try:
            path = self._path(str(candidate), workspace, permissions, must_exist=True)
        except WorkspaceToolError:
            return False
        return path.is_file() and _is_relative_to(path, workspace)

    def _sandbox_auto_argv(self, argv, cwd, workspace, permissions):
        """Return the argv to run for commands on the sandboxed dev allowlist,
        or None when the command needs per-command confirmation."""
        exe = _exe_name(argv[0])
        rest = argv[1:]
        if exe in {"node", "npm", "npx"} and rest in (["--version"], ["-v"]):
            return argv
        if exe in PYTHON_EXECUTABLES and rest in (["--version"], ["-V"]):
            return argv
        if exe == "node" and rest and not rest[0].startswith("-") \
                and self._workspace_script(rest[0], cwd, workspace, permissions):
            return argv
        if exe == "npx":
            tail = rest[1:] if rest[:1] == ["--no"] else rest
            if tail[:1] == ["tsx"] and len(tail) > 1 and not tail[1].startswith("-") \
                    and self._workspace_script(tail[1], cwd, workspace, permissions):
                # --no: never download a missing package automatically.
                return [argv[0], "--no", *tail]
            return None
        if exe == "npm":
            if rest[:1] in (["test"], ["t"]):
                before_separator = rest[1:rest.index("--")] if "--" in rest else rest[1:]
                return argv if not any(value.startswith("-") for value in before_separator) else None
            if rest[:1] in (["run"], ["run-script"]):
                tail = rest[1:]
                while tail and tail[0] in {"--silent", "-s", "--if-present"}:
                    tail = tail[1:]
                if not tail or tail[0].startswith("-"):
                    return None
                before_separator = tail[1:tail.index("--")] if "--" in tail else tail[1:]
                return argv if not any(value.startswith("-") for value in before_separator) else None
            return None
        if exe in PYTHON_EXECUTABLES:
            if rest[:1] == ["-m"] and len(rest) > 1 and rest[1] in {"unittest", "pytest"}:
                return argv
            if rest and not rest[0].startswith("-") \
                    and self._workspace_script(rest[0], cwd, workspace, permissions):
                return argv
        return None

    def _sandbox_git(self, argv, cwd, workspace, permissions):
        """Terminal Git while full access is off: read-only inspection runs
        with sensitive paths excluded; git add/commit go through the same
        checks as the git.add/git.commit tools; everything else is refused."""
        refused = (
            "terminal Git in the workspace sandbox is limited to read-only inspection (status, rev-parse, "
            "show, log, diff, blame, ls-files, grep, branch --list, rev-list) plus git add <files> and "
            "git commit -m; use TEAMYRA git tools for other changes"
        )
        if len(argv) < 2:
            raise PermissionError(refused)
        sub = argv[1].lower()
        rest = argv[2:]
        if sub.startswith("-"):
            raise PermissionError("Git global options (-c, -C, --git-dir, ...) need Full PC access in terminal.run")
        if sub == "add":
            separator = rest.index("--") if "--" in rest else len(rest)
            files = rest[:separator] + rest[separator + 1:]
            if not files or any(value.startswith("-") for value in rest[:separator]):
                raise PermissionError("terminal git add accepts explicit file paths only (no options or directories)")
            paths = [str((cwd / value) if not Path(value).is_absolute() else Path(value)) for value in files]
            return ("tool", "git.add", {"paths": paths})
        if sub == "commit":
            messages, index = [], 0
            while index < len(rest):
                value = rest[index]
                if value in {"-m", "--message"} and index + 1 < len(rest):
                    messages.append(rest[index + 1])
                    index += 2
                    continue
                if value.startswith("--message="):
                    messages.append(value.split("=", 1)[1])
                elif value.startswith("-m") and len(value) > 2:
                    messages.append(value[2:])
                elif value not in {"-q", "--quiet"}:
                    raise PermissionError(
                        "terminal git commit accepts only -m <message> (no --amend, -a or other options)"
                    )
                index += 1
            if not messages:
                raise PermissionError("terminal git commit requires -m <message>")
            return ("tool", "git.commit", {"message": "\n\n".join(messages)})
        if sub not in SANDBOX_READ_ONLY_GIT:
            raise PermissionError(refused)
        for value in rest:
            if value in GIT_FORBIDDEN_OPTIONS or value.lower() in GIT_FORBIDDEN_OPTIONS \
                    or any(value.startswith(prefix) for prefix in GIT_FORBIDDEN_OPTION_PREFIXES):
                raise PermissionError(f"git option {value} is not allowed in the workspace sandbox")
        if sub == "branch":
            listing = "--list" in rest or "-l" in rest
            for value in rest:
                if value.startswith("-"):
                    if value not in GIT_BRANCH_LIST_FLAGS and not value.startswith(GIT_BRANCH_LIST_PREFIXES):
                        raise PermissionError("terminal git branch is limited to listing (git branch --list)")
                elif not listing:
                    raise PermissionError("terminal git branch is limited to listing (git branch --list)")
        object_paths = False
        for value in rest:
            if value.startswith("-") or value == "--":
                continue
            if ":" in value and not value.startswith(":(") and not Path(value).is_absolute():
                object_paths = True
                inner = value.split(":", 1)[1]
                if inner and self._sensitive_name(Path(inner)):
                    raise PermissionError("access to credential-like files is blocked")
                continue
            candidate = Path(value) if Path(value).is_absolute() else cwd / value
            if candidate.exists():
                self._path(str(candidate), workspace, permissions, must_exist=False)
        out = [argv[0], "-c", "core.fsmonitor=false", sub]
        if sub in {"diff", "log", "show"}:
            out.extend(["--no-ext-diff", "--no-textconv"])
        out.extend(rest)
        if sub in {"diff", "log", "show", "grep"} and not object_paths:
            if "--" not in rest:
                out.extend(["--", "." if sub == "grep" else ":/"])
            out.extend(GIT_SENSITIVE_EXCLUDES)
        return ("run", out)

    def _terminal(self, args, workspace, permissions, confirm):
        argv = args.get("argv")
        if not isinstance(argv, list) or not argv or len(argv) > 64:
            raise WorkspaceToolError("argv must be a non-empty list")
        argv = [str(value) for value in argv]
        if any("\x00" in value for value in argv):
            raise WorkspaceToolError("argv must not contain NUL characters")
        exe = _exe_name(argv[0])
        full = bool(permissions.get("full_access"))
        destructive_ok = bool(permissions.get("destructive_without_confirmation")) or confirm
        tags = self._command_tags(argv)
        cwd = self._path(args.get("cwd", "."), workspace, permissions, must_exist=True)
        if not cwd.is_dir():
            raise WorkspaceToolError("cwd is not a directory")
        for arg in argv[1:]:
            maybe = Path(arg.strip('"'))
            if maybe.is_absolute():
                self._path(str(maybe), workspace, permissions, must_exist=False)

        delegated = None
        run_argv = argv
        if full:
            if "destructive" in tags and not destructive_ok:
                raise PermissionError(
                    "destructive command requires explicit confirmation even with Full PC access "
                    "(unless 'destructive commands without confirmation' is enabled)"
                )
        else:
            if "hard" in tags:
                raise PermissionError("command is blocked by TEAMYRA safety policy")
            if "network" in tags:
                raise PermissionError(
                    "package installs and network tools are blocked unless the user enables Full PC access"
                )
            if exe == "git":
                plan = self._sandbox_git(argv, cwd, workspace, permissions)
                if plan[0] == "tool":
                    delegated = plan[1:]
                else:
                    run_argv = plan[1]
            else:
                auto = self._sandbox_auto_argv(argv, cwd, workspace, permissions)
                sensitive_command = (
                    exe in SHELL_EXECUTABLES
                    or "delete" in tags
                    or "destructive" in tags
                    or (
                        exe in {"node", "python", "python3", "py", "ruby", "perl", "deno", "bun"}
                        and any(arg.lower() in INLINE_EVAL_FLAGS for arg in argv[1:2])
                    )
                )
                if sensitive_command and not confirm:
                    raise PermissionError("destructive/shell/eval command requires explicit per-command confirmation")
                if auto is None and not confirm:
                    raise PermissionError(
                        "terminal command requires explicit per-command confirmation; " + SANDBOX_TERMINAL_HINT
                    )
                run_argv = auto or argv

        if delegated:
            tool, tool_args = delegated
            self._check(tool, permissions, confirm=confirm)
            result = self._git(tool, tool_args, workspace, permissions, confirm)
            return {**result, "argv": argv, "cwd": str(cwd), "delegated_tool": tool}

        terminal_env = self._scrubbed_env()
        executable = self._resolve_executable(run_argv[0], terminal_env)
        if not full and executable.lower().endswith((".cmd", ".bat")) and any(
            char in BATCH_METACHARACTERS for arg in run_argv[1:] for char in arg
        ):
            raise PermissionError(
                "arguments with shell metacharacters cannot be passed to batch-file launchers in the sandbox"
            )
        timeout = max(1, min(int(args.get("timeout_seconds", 60)), 120))
        cp = subprocess.run(
            [executable, *run_argv[1:]],
            cwd=str(cwd),
            env=terminal_env,
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
            shell=False,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        return {
            "argv": run_argv,
            "cwd": str(cwd),
            "exit_code": cp.returncode,
            "stdout": (cp.stdout or "")[:500000],
            "stderr": (cp.stderr or "")[:200000],
        }

    def _git(self, tool, args, workspace, permissions, confirm):
        allowed_args = GIT_TOOL_ARGS.get(tool)
        if allowed_args is None:
            raise WorkspaceToolError(f"unsupported git tool: {tool}")
        unknown = sorted(str(key) for key in args if key not in allowed_args)
        if unknown:
            raise WorkspaceToolError(
                f"{tool} does not accept argument(s): {', '.join(unknown)}; "
                f"allowed arguments: {', '.join(sorted(allowed_args))}"
            )
        hooks_dir = self.root / "backups" / "git-empty-hooks"
        hooks_dir.mkdir(parents=True, exist_ok=True)
        base = [
            "git",
            "-c", "core.fsmonitor=false",
            "-c", "commit.gpgSign=false",
            "-c", f"core.hooksPath={hooks_dir}",
            "-C", str(workspace),
        ]
        git_env = self._scrubbed_env()

        def run_git(argv, timeout=60):
            return subprocess.run(
                argv,
                cwd=str(workspace),
                env=git_env,
                stdin=subprocess.DEVNULL,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=timeout,
                shell=False,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )

        def safe_names(names):
            safe, blocked = [], []
            for raw in names:
                try:
                    path = self._path(raw, workspace, permissions, must_exist=False)
                    safe.append(os.path.relpath(path, workspace))
                except PermissionError:
                    blocked.append(raw)
            return safe, blocked

        def changed_paths(staged=False, revisions=()):
            argv = [*base, "diff", "--name-only", "-z", "--no-ext-diff", "--no-textconv"]
            if staged:
                argv.append("--cached")
            argv.extend(revisions)
            argv.append("--")
            cp = run_git(argv)
            if cp.returncode != 0:
                raise WorkspaceToolError((cp.stderr or cp.stdout or "git diff name scan failed").strip())
            return safe_names([item for item in cp.stdout.split("\x00") if item])

        def verify_ref(key, ref):
            if not isinstance(ref, str) or not ref.strip() or ref.startswith("-") or "\x00" in ref or len(ref) > 256:
                raise WorkspaceToolError(f"{tool} {key} must be a valid commit ref")
            resolved = run_git([*base, "rev-parse", "--verify", "--end-of-options", ref + "^{commit}"])
            if resolved.returncode != 0:
                raise WorkspaceToolError(f"{tool} {key}: unknown commit ref {ref!r}")
            return resolved.stdout.strip()

        def verify_range(value):
            if not isinstance(value, str) or "\x00" in value:
                raise WorkspaceToolError(f"{tool} range must be a string like A..B or A...B")
            separator = "..." if "..." in value else ".." if ".." in value else None
            if not separator:
                raise WorkspaceToolError(f"{tool} range must look like A..B or A...B")
            left, right = value.split(separator, 1)
            if ".." in right:
                raise WorkspaceToolError(f"{tool} range must contain exactly one .. or ... separator")
            return f"{verify_ref('range', left or 'HEAD')}{separator}{verify_ref('range', right or 'HEAD')}"

        def requested_paths():
            raw = []
            if args.get("path") is not None:
                raw.append(args["path"])
            if args.get("paths") is not None:
                if not isinstance(args["paths"], list) or len(args["paths"]) > 200:
                    raise WorkspaceToolError(f"{tool} paths must be a list of at most 200 paths")
                raw.extend(args["paths"])
            out = []
            for item in raw:
                if not isinstance(item, str) or not item.strip():
                    raise WorkspaceToolError(f"{tool} path values must be non-empty strings")
                path = self._path(item, workspace, permissions, must_exist=False)
                out.append(os.path.relpath(path, workspace))
            return out

        def int_arg(key, default, low, high):
            value = args.get(key, default)
            if isinstance(value, bool):
                raise WorkspaceToolError(f"{tool} {key} must be an integer")
            try:
                number = int(value)
            except (TypeError, ValueError) as exc:
                raise WorkspaceToolError(f"{tool} {key} must be an integer") from exc
            return max(low, min(number, high))

        if tool == "git.status":
            argv = [*base, "status", "--porcelain=v1", "--branch"]
            blocked_paths = []
            paths = requested_paths()
            if paths:
                argv.extend(["--", *paths])
        elif tool == "git.diff":
            blocked_paths = []
            argv = [*base, "diff", "--no-ext-diff", "--no-textconv"]
            staged = bool(args.get("staged"))
            revisions = []
            if args.get("range") is not None and (args.get("base") is not None or args.get("head") is not None):
                raise WorkspaceToolError("git.diff range cannot be combined with base/head")
            if args.get("head") and not args.get("base"):
                raise WorkspaceToolError("git.diff head requires base")
            if staged and args.get("head"):
                raise WorkspaceToolError("git.diff staged cannot be combined with head")
            if staged and args.get("range") is not None:
                raise WorkspaceToolError("git.diff staged cannot be combined with range")
            for key in ("base", "head"):
                ref = args.get(key)
                if ref is None:
                    continue
                revisions.append(verify_ref(key, ref))
            if args.get("range") is not None:
                revisions.append(verify_range(args["range"]))
            if staged:
                argv.append("--cached")
            if args.get("stat"):
                argv.append("--stat")
            if args.get("name_only"):
                argv.append("--name-only")
            if args.get("unified") is not None:
                argv.append(f"-U{int_arg('unified', 3, 0, 1000)}")
            argv.extend(revisions)
            safe_paths = requested_paths()
            if not safe_paths:
                safe_paths, blocked_paths = changed_paths(staged, revisions)
            if not safe_paths:
                return {
                    "argv": argv[len(base):],
                    "exit_code": 0,
                    "stdout": "",
                    "stderr": "",
                    "blocked_paths": blocked_paths,
                }
            argv.extend(["--", *safe_paths])
        elif tool == "git.log":
            blocked_paths = []
            limit = int_arg("max_count", args.get("limit", 20), 1, 100)
            argv = [*base, "log", f"-{limit}", "--date=iso-strict", "--pretty=format:%h%x09%ad%x09%an%x09%s"]
            since = args.get("since")
            if since is not None:
                if not isinstance(since, str) or not since.strip() or since.startswith("-") \
                        or "\x00" in since or len(since) > 100:
                    raise WorkspaceToolError("git.log since must be a date string such as 2026-01-31 or '2 weeks ago'")
                argv.append(f"--since={since}")
            if args.get("range") is not None:
                argv.append(verify_range(args["range"]))
            paths = requested_paths()
            if paths:
                argv.extend(["--", *paths])
        elif tool == "git.show":
            commit = verify_ref("ref", args.get("ref", "HEAD"))
            argv = [*base, "show", "--no-ext-diff", "--no-textconv", "--date=iso-strict"]
            if args.get("stat"):
                argv.append("--stat")
            paths = requested_paths()
            blocked_paths = []
            if not paths:
                names = run_git([*base, "show", "--no-ext-diff", "--no-textconv", "--name-only", "-z",
                                 "--format=", commit])
                if names.returncode != 0:
                    raise WorkspaceToolError((names.stderr or names.stdout or "git show name scan failed").strip())
                paths, blocked_paths = safe_names(
                    [item.strip("\n") for item in names.stdout.split("\x00") if item.strip("\n")]
                )
                if blocked_paths and not paths:
                    argv.append("--no-patch")
            argv.append(commit)
            if paths:
                argv.extend(["--", *paths])
        elif tool == "git.add":
            blocked_paths = []
            paths = args.get("paths")
            if not isinstance(paths, list) or not paths or len(paths) > 200:
                raise WorkspaceToolError("git.add requires a non-empty explicit file path list")
            rel = []
            for raw in paths:
                path = self._path(raw, workspace, permissions, must_exist=False)
                if path.exists() and path.is_dir():
                    raise PermissionError("git.add requires explicit file paths; directory-wide staging is blocked")
                rel.append(os.path.relpath(path, workspace))
            attr = run_git([*base, "check-attr", "-z", "filter", "--", *rel])
            if attr.returncode != 0:
                raise WorkspaceToolError((attr.stderr or attr.stdout or "git attribute check failed").strip())
            fields = attr.stdout.split("\x00")
            for index in range(0, max(0, len(fields) - 2), 3):
                file_name, attribute, value = fields[index:index + 3]
                if attribute == "filter" and value not in {"", "unspecified", "unset"}:
                    raise PermissionError(
                        f"git.add blocked for {file_name}: repository clean filters are not executed by TEAMYRA"
                    )
            argv = [*base, "add", "--", *rel]
        elif tool == "git.commit":
            blocked_paths = []
            message = str(args.get("message") or "").strip()
            if not message or len(message) > 500:
                raise WorkspaceToolError("commit message is required and must be <= 500 characters")
            staged_paths, blocked_paths = changed_paths(True)
            if blocked_paths:
                raise PermissionError(
                    "commit includes credential-like or blocked staged paths; unstage them before TEAMYRA commit"
                )
            if not staged_paths:
                raise WorkspaceToolError("no safe staged changes to commit")
            argv = [*base, "commit", "--no-verify", "-m", message]
        elif tool == "git.restore":
            blocked_paths = []
            paths = args.get("paths") or ["."]
            if not isinstance(paths, list) or len(paths) > 200:
                raise WorkspaceToolError("paths must be a list")
            rel = []
            for raw in paths:
                path = self._path(raw, workspace, permissions, must_exist=False)
                rel.append(os.path.relpath(path, workspace))
            argv = [*base, "restore"]
            if args.get("staged"):
                argv.extend(["--staged", "--worktree"])
            else:
                argv.append("--worktree")
            argv.extend(["--", *rel])
        else:
            raise WorkspaceToolError(f"unsupported git tool: {tool}")

        cp = run_git(argv)
        return {
            "argv": argv[len(base):],
            "exit_code": cp.returncode,
            "stdout": (cp.stdout or "")[:500000],
            "stderr": (cp.stderr or "")[:200000],
            "blocked_paths": blocked_paths,
        }

