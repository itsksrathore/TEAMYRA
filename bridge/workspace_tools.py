"""Workspace-scoped local tool service shared by TEAMYRA agents.

The service is deliberately independent of ChatGPT/Electron.  Desktop callers
authenticate with a runtime token; the in-process MCP server can call the same
implementation as a trusted TEAMYRA component.
"""
from __future__ import annotations

import hmac
import json
import os
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
    "terminal": False,
    "outside_workspace": False,
    "destructive_without_confirmation": False,
}

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
    "git.add": "git",
    "git.commit": "git",
    "git.restore": "git",
}

DESTRUCTIVE_TOOLS = {"filesystem.delete", "git.restore"}
HARD_BLOCKED_EXECUTABLES = {
    "format", "format.com", "diskpart", "shutdown", "shutdown.exe", "reboot",
    "bcdedit", "reg", "reg.exe", "cipher", "takeown", "icacls", "wmic",
    "sudo", "runas", "dd", "mount", "umount",
}
SHELL_EXECUTABLES = {"cmd", "cmd.exe", "powershell", "powershell.exe", "pwsh", "pwsh.exe", "bash", "sh", "zsh"}
DESTRUCTIVE_EXECUTABLES = {"rm", "rmdir", "unlink", "del", "erase"}
INLINE_EVAL_FLAGS = {"-e", "--eval", "-c", "-command", "--command"}


class WorkspaceToolError(ValueError):
    pass


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
    permissions = {key: bool(source.get(key, default)) for key, default in DEFAULT_PERMISSIONS.items()}
    # Web/local tools are intentionally workspace-scoped in v1. Keep the field
    # for forward-compatible settings, but never let persisted state unlock it.
    permissions["outside_workspace"] = False
    return permissions


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

    def configure(self, workspace, permissions=None, *, token=None, trusted=False, actor="teamyra"):
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
        merged = dict(current["permissions"])
        if isinstance(permissions, dict):
            for key in DEFAULT_PERMISSIONS:
                if key in permissions:
                    merged[key] = bool(permissions[key])
        data = {"workspace": str(path), "permissions": merged, "updated_at": time.time()}
        _write_json_atomic(self.settings_file, data)
        self._audit(actor, "workspace.configure", str(path), True)
        return data

    def status(self, *, token=None, trusted=False):
        self._verify_token(token, trusted)
        data = self._load()
        path = Path(data["workspace"]).resolve() if data["workspace"] else None
        return {
            **data,
            "available": bool(path and path.exists() and path.is_dir()),
            "local_agent": "connected",
        }

    def _workspace(self):
        data = self._load()
        if not data["workspace"]:
            raise WorkspaceToolError("no workspace selected")
        path = Path(data["workspace"]).resolve()
        if not path.exists() or not path.is_dir():
            raise WorkspaceToolError("selected workspace is unavailable")
        return path, data["permissions"]

    def _sensitive_roots(self):
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
            home / ".gemini", home / ".config" / "gcloud",
        ])
        for env_name in ("WINDIR", "SystemRoot"):
            value = os.environ.get(env_name)
            if value:
                roots.append(Path(value).resolve())
        appdata = os.environ.get("APPDATA")
        local = os.environ.get("LOCALAPPDATA")
        if appdata:
            roots.extend([
                Path(appdata) / "Microsoft" / "Credentials",
                Path(appdata) / "Microsoft" / "Protect",
                Path(appdata) / "Mozilla" / "Firefox" / "Profiles",
            ])
        if local:
            roots.extend([
                Path(local) / "Google" / "Chrome" / "User Data",
                Path(local) / "Microsoft" / "Edge" / "User Data",
            ])
        token_file = os.environ.get("TEAMYRA_LOCAL_AGENT_TOKEN_FILE")
        if token_file:
            roots.append(Path(token_file).expanduser().resolve().parent)
        return [p.resolve() for p in roots]

    def _sensitive_name(self, path: Path):
        name = path.name.lower()
        if name in {"auth.json", ".credentials.json", "credentials.json", "secrets.json",
                    "id_rsa", "id_ed25519"}:
            return True
        if name == ".env" or (name.startswith(".env.") and name not in {
            ".env.example", ".env.sample", ".env.template"
        }):
            return True
        return path.suffix.lower() in {".pem", ".pfx", ".p12", ".key"}

    def _path(self, raw, workspace, permissions, *, must_exist=False):
        text = str(raw or ".")
        candidate = Path(text).expanduser()
        if not candidate.is_absolute():
            candidate = workspace / candidate
        try:
            candidate = candidate.resolve(strict=must_exist)
        except FileNotFoundError as exc:
            raise WorkspaceToolError("path does not exist") from exc

        inside = _is_relative_to(candidate, workspace)
        if not inside:
            raise PermissionError("path is outside the selected workspace")
        relative = candidate.relative_to(workspace)
        if relative.parts and relative.parts[0].lower() == ".git":
            raise PermissionError("direct filesystem access to Git internals is blocked; use TEAMYRA git tools")
        for blocked in self._sensitive_roots():
            if candidate == blocked or _is_relative_to(candidate, blocked):
                raise PermissionError("access to TEAMYRA runtime, system, or credential storage is blocked")
        if self._sensitive_name(candidate):
            raise PermissionError("access to credential-like files is blocked")
        return candidate

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

    def _audit(self, actor, tool, target, success, error=None):
        self.audit_file.parent.mkdir(parents=True, exist_ok=True)
        record = {
            "ts": time.time(),
            "agent": str(actor or "unknown")[:100],
            "tool": str(tool)[:100],
            "target": str(target or "")[:1000],
            "result": "success" if success else "error",
        }
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

    def _move_to_trash(self, path: Path, workspace: Path):
        relative = path.relative_to(workspace) if _is_relative_to(path, workspace) else Path(path.name)
        destination = self.trash_root / f"{int(time.time() * 1000)}-{uuid.uuid4().hex[:6]}" / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(path), str(destination))
        return str(destination)

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
        scoped_permissions = _safe_permissions(permissions)
        scoped_permissions["outside_workspace"] = False
        return self._execute_scoped(
            tool, args, scoped, scoped_permissions, actor, confirm
        )

    def _execute_scoped(self, tool, args, workspace, permissions, actor, confirm):
        args = args if isinstance(args, dict) else {}
        self._check(tool, permissions, confirm=confirm)
        target = args.get("path") or args.get("cwd") or str(workspace)
        try:
            result = self._execute(tool, args, workspace, permissions, confirm)
            self._audit(actor, tool, target, True)
            return result
        except Exception as exc:
            self._audit(actor, tool, target, False, exc)
            raise

    def _execute(self, tool, args, workspace, permissions, confirm):
        if tool == "filesystem.list":
            path = self._path(args.get("path", "."), workspace, permissions, must_exist=True)
            if not path.is_dir():
                raise WorkspaceToolError("path is not a directory")
            limit = max(1, min(int(args.get("limit", 500)), 2000))
            items = []
            for child in sorted(path.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower())):
                if len(items) >= limit:
                    break
                if child.name.lower() == ".git":
                    continue
                try:
                    resolved_child = child.resolve(strict=True)
                    if not _is_relative_to(resolved_child, workspace):
                        continue
                    if self._sensitive_name(resolved_child):
                        continue
                    if any(resolved_child == blocked or _is_relative_to(resolved_child, blocked)
                           for blocked in self._sensitive_roots()):
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
            max_bytes = max(1, min(int(args.get("max_bytes", 1024 * 1024)), 2 * 1024 * 1024))
            data = path.read_bytes()
            if b"\x00" in data[:8192]:
                raise WorkspaceToolError("binary files are not returned as text")
            clipped = len(data) > max_bytes
            text = data[:max_bytes].decode("utf-8", errors="replace")
            return {"path": str(path), "content": text, "bytes": len(data), "clipped": clipped}

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
            for file in root.rglob(pattern):
                if any(part in skipped_dirs for part in file.parts):
                    continue
                if not file.is_file():
                    continue
                try:
                    resolved_file = file.resolve(strict=True)
                except OSError:
                    continue
                if not _is_relative_to(resolved_file, workspace):
                    continue
                if any(resolved_file == blocked or _is_relative_to(resolved_file, blocked)
                       for blocked in self._sensitive_roots()):
                    continue
                if self._sensitive_name(resolved_file):
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
            if path == workspace:
                raise PermissionError("deleting the workspace root is blocked")
            if path.is_dir() and not args.get("recursive"):
                raise WorkspaceToolError("directory deletion requires recursive=true")
            recoverable_at = self._move_to_trash(path, workspace)
            return {"deleted": str(path), "recoverable_at": recoverable_at, "backup": recoverable_at}

        if tool == "terminal.run":
            argv = args.get("argv")
            if not isinstance(argv, list) or not argv or len(argv) > 64:
                raise WorkspaceToolError("argv must be a non-empty list")
            argv = [str(value) for value in argv]
            exe = Path(argv[0]).name.lower()
            if exe in HARD_BLOCKED_EXECUTABLES or exe.startswith("mkfs"):
                raise PermissionError("command is blocked by TEAMYRA safety policy")
            git_args = [value.lower() for value in argv[1:]]
            destructive_git = exe in {"git", "git.exe"} and (
                ("reset" in git_args and "--hard" in git_args)
                or ("clean" in git_args and any(flag in git_args for flag in ("-f", "-fd", "-df", "-fx", "-xfd")))
                or ("checkout" in git_args and "--force" in git_args)
                or ("branch" in git_args and "-d" in git_args)
                or ("branch" in git_args and "-D" in argv[1:])
            )
            if exe in {"git", "git.exe"}:
                subcommand = argv[1].lower() if len(argv) > 1 else ""
                if subcommand not in {"status", "diff", "log", "show", "rev-parse"}:
                    raise PermissionError("mutating Git commands must use TEAMYRA git tools")
            version_only = (
                (exe in {"node", "node.exe", "npm", "npm.cmd"} and argv[1:] in (["--version"], ["-v"]))
                or (exe in {"python", "python.exe", "python3"} and argv[1:] in (["--version"], ["-V"]))
            )
            read_only_git = exe in {"git", "git.exe"} and bool(argv[1:]) and argv[1].lower() in {
                "status", "diff", "log", "show", "rev-parse"
            }
            sensitive_command = (
                exe in SHELL_EXECUTABLES
                or exe in DESTRUCTIVE_EXECUTABLES
                or destructive_git
                or (
                    exe in {"node", "node.exe", "python", "python.exe", "python3", "ruby", "perl"}
                    and any(arg.lower() in INLINE_EVAL_FLAGS for arg in argv[1:3])
                )
            )
            if not confirm and not (version_only or read_only_git):
                raise PermissionError(
                    "terminal command requires explicit per-command confirmation; "
                    "automated ChatGPT terminal access is limited to version checks and read-only Git inspection"
                )
            if sensitive_command and not confirm:
                raise PermissionError("destructive/shell/eval command requires explicit per-command confirmation")
            cwd = self._path(args.get("cwd", "."), workspace, permissions, must_exist=True)
            if not cwd.is_dir():
                raise WorkspaceToolError("cwd is not a directory")
            for arg in argv[1:]:
                maybe = Path(arg.strip('"'))
                if maybe.is_absolute():
                    self._path(str(maybe), workspace, permissions, must_exist=False)
            timeout = max(1, min(int(args.get("timeout_seconds", 60)), 120))
            terminal_env = {
                key: value for key, value in os.environ.items()
                if key != "TEAMYRA_LOCAL_AGENT_TOKEN_FILE"
                and not any(marker in key.upper() for marker in ("TOKEN", "SECRET", "PASSWORD", "API_KEY"))
            }
            cp = subprocess.run(
                argv,
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
                "argv": argv,
                "cwd": str(cwd),
                "exit_code": cp.returncode,
                "stdout": (cp.stdout or "")[:500000],
                "stderr": (cp.stderr or "")[:200000],
            }

        if tool.startswith("git."):
            return self._git(tool, args, workspace, permissions, confirm)

        raise WorkspaceToolError(f"unsupported workspace tool: {tool}")

    def _git(self, tool, args, workspace, permissions, confirm):
        base = ["git", "-C", str(workspace)]
        if tool == "git.status":
            argv = [*base, "status", "--porcelain=v1", "--branch"]
        elif tool == "git.diff":
            argv = [*base, "diff"]
            if args.get("staged"):
                argv.append("--cached")
            if args.get("path"):
                path = self._path(args["path"], workspace, permissions, must_exist=False)
                argv.extend(["--", os.path.relpath(path, workspace)])
        elif tool == "git.log":
            limit = max(1, min(int(args.get("limit", 20)), 100))
            argv = [*base, "log", f"-{limit}", "--date=iso-strict", "--pretty=format:%h%x09%ad%x09%an%x09%s"]
        elif tool == "git.add":
            paths = args.get("paths") or ["."]
            if not isinstance(paths, list) or len(paths) > 200:
                raise WorkspaceToolError("paths must be a list")
            rel = []
            for raw in paths:
                path = self._path(raw, workspace, permissions, must_exist=False)
                rel.append(os.path.relpath(path, workspace))
            argv = [*base, "add", "--", *rel]
        elif tool == "git.commit":
            message = str(args.get("message") or "").strip()
            if not message or len(message) > 500:
                raise WorkspaceToolError("commit message is required and must be <= 500 characters")
            argv = [*base, "commit", "--no-verify", "-m", message]
        elif tool == "git.restore":
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

        cp = subprocess.run(
            argv,
            cwd=str(workspace),
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=60,
            shell=False,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        return {
            "argv": argv[2:],
            "exit_code": cp.returncode,
            "stdout": (cp.stdout or "")[:500000],
            "stderr": (cp.stderr or "")[:200000],
        }
