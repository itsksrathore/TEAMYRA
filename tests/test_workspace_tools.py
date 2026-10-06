import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "bridge"))

from workspace_tools import WorkspaceToolService


class WorkspaceToolTests(unittest.TestCase):
    def make_service(self, root, workspace):
        service = WorkspaceToolService(root)
        service.state_root.mkdir(parents=True, exist_ok=True)
        service.token_file.write_text("x" * 64, encoding="utf-8")
        service.configure(workspace, token="x" * 64, actor="test")
        return service

    def enable_full_access(self, service, destructive=False):
        return service.set_access(
            {"full_access": True, "outside_workspace": True, "destructive_without_confirmation": destructive},
            token="x" * 64, actor="user-test", user_confirmed=True,
        )

    def init_repo(self, workspace):
        def git(*args):
            return subprocess.run(
                ["git", *args], cwd=workspace, check=True, capture_output=True, text=True
            ).stdout.strip()
        git("init")
        git("config", "user.email", "test@example.com")
        git("config", "user.name", "Test")
        return git

    def test_filesystem_lifecycle_and_search(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "runtime"
            workspace = Path(td) / "project"
            workspace.mkdir()
            service = self.make_service(root, workspace)
            token = "x" * 64

            service.execute("filesystem.create", {"path": "a.txt", "content": "hello\n"}, token=token, actor="chatgpt-normal")
            stat = service.execute("filesystem.stat", {"path": "a.txt"}, token=token)
            self.assertEqual(stat["type"], "file")
            self.assertEqual(stat["size"], len("hello\n"))
            read = service.execute("filesystem.read", {"path": "a.txt"}, token=token)
            self.assertEqual(read["content"], "hello\n")

            patched = service.execute("filesystem.patch", {
                "path": "a.txt",
                "replacements": [{"find": "hello", "replace": "world", "expected": 1}],
            }, token=token)
            self.assertTrue(patched["backup"])
            self.assertTrue(Path(patched["backup"]).is_file())
            found = service.execute("filesystem.search", {"query": "world"}, token=token)
            self.assertEqual(found["results"][0]["path"], "a.txt")

            service.execute("filesystem.rename", {"path": "a.txt", "new_name": "b.txt"}, token=token)
            self.assertTrue((workspace / "b.txt").exists())
            service.execute("filesystem.move", {"path": "b.txt", "destination": "nested/c.txt"}, token=token)
            self.assertTrue((workspace / "nested" / "c.txt").exists())

            with self.assertRaises(PermissionError):
                service.execute("filesystem.delete", {"path": "nested/c.txt"}, token=token)
            deleted = service.execute("filesystem.delete", {"path": "nested/c.txt"}, token=token, confirm=True)
            self.assertFalse((workspace / "nested" / "c.txt").exists())
            self.assertTrue(Path(deleted["recoverable_at"]).is_file())


    def test_workspace_root_and_home_are_rejected(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "runtime"
            service = WorkspaceToolService(root)
            service.state_root.mkdir(parents=True, exist_ok=True)
            service.token_file.write_text("x" * 64, encoding="utf-8")
            with self.assertRaises(PermissionError):
                service.configure(Path.home(), token="x" * 64)
            filesystem_root = Path(Path(td).anchor)
            with self.assertRaises(PermissionError):
                service.configure(filesystem_root, token="x" * 64)

    def test_large_reads_are_paged(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "runtime"
            workspace = Path(td) / "project"
            workspace.mkdir()
            (workspace / "large.txt").write_text("A" * 300000, encoding="utf-8")
            service = self.make_service(root, workspace)
            first = service.execute(
                "filesystem.read",
                {"path": "large.txt", "max_bytes": 100000},
                token="x" * 64,
            )
            self.assertTrue(first["clipped"])
            self.assertEqual(first["offset"], 0)
            self.assertEqual(first["next_offset"], 100000)
            second = service.execute(
                "filesystem.read",
                {"path": "large.txt", "offset": first["next_offset"], "max_bytes": 100000},
                token="x" * 64,
            )
            self.assertEqual(second["offset"], 100000)
            self.assertEqual(len(second["content"]), 100000)

    def test_path_traversal_and_outside_access_are_blocked(self):
        with tempfile.TemporaryDirectory() as td:
            base = Path(td)
            root = base / "runtime"
            workspace = base / "project"
            outside = base / "outside.txt"
            workspace.mkdir()
            outside.write_text("secret", encoding="utf-8")
            service = self.make_service(root, workspace)
            token = "x" * 64

            for target in ("../outside.txt", str(outside)):
                with self.assertRaises(PermissionError):
                    service.execute("filesystem.read", {"path": target}, token=token)

    @unittest.skipUnless(os.name == "nt", "Windows system path check")
    def test_windows_system_directory_is_blocked_even_if_outside_permission_enabled(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "runtime"
            workspace = Path(td) / "project"
            workspace.mkdir()
            service = self.make_service(root, workspace)
            windir = os.environ.get("WINDIR", r"C:\Windows")
            with self.assertRaises(PermissionError):
                service.configure(workspace, {"outside_workspace": True}, token="x" * 64)
            with self.assertRaises(PermissionError):
                service.execute("filesystem.list", {"path": windir}, token="x" * 64)
            self.enable_full_access(service)
            with self.assertRaises(PermissionError):
                service.execute(
                    "filesystem.list", {"path": str(Path(windir) / "System32" / "config")}, token="x" * 64
                )

    def test_terminal_and_git_are_workspace_scoped(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "runtime"
            workspace = Path(td) / "project"
            workspace.mkdir()
            subprocess.run(["git", "init"], cwd=workspace, check=True, capture_output=True)
            subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=workspace, check=True)
            subprocess.run(["git", "config", "user.name", "Test"], cwd=workspace, check=True)
            (workspace / "tracked.txt").write_text("one\n", encoding="utf-8")
            subprocess.run(["git", "add", "tracked.txt"], cwd=workspace, check=True)
            subprocess.run(["git", "commit", "-m", "init"], cwd=workspace, check=True, capture_output=True)
            service = self.make_service(root, workspace)
            token = "x" * 64
            service.configure(workspace, {"terminal": True}, token=token)

            terminal = service.execute("terminal.run", {"argv": ["git", "status", "--short"]}, token=token)
            self.assertEqual(terminal["exit_code"], 0)

            (workspace / "tracked.txt").write_text("two\n", encoding="utf-8")
            status = service.execute("git.status", {}, token=token)
            self.assertIn("tracked.txt", status["stdout"])
            diff = service.execute("git.diff", {}, token=token)
            self.assertIn("-one", diff["stdout"])
            self.assertIn("+two", diff["stdout"])
            with self.assertRaises(PermissionError):
                service.execute("git.restore", {"paths": ["tracked.txt"]}, token=token)
            service.execute("git.restore", {"paths": ["tracked.txt"]}, token=token, confirm=True)
            self.assertEqual((workspace / "tracked.txt").read_text(encoding="utf-8"), "one\n")
            (workspace / "tracked.txt").write_text("two\n", encoding="utf-8")
            service.execute("git.add", {"paths": ["tracked.txt"]}, token=token)
            commit = service.execute("git.commit", {"message": "update"}, token=token)
            self.assertEqual(commit["exit_code"], 0)
            log = service.execute("git.log", {"limit": 2}, token=token)
            self.assertIn("update", log["stdout"])

    def test_git_diff_compares_commits_in_clean_tree_and_filters_secrets(self):
        with tempfile.TemporaryDirectory() as td:
            workspace = Path(td) / "project"
            workspace.mkdir()
            def git(*args):
                return subprocess.run(["git", *args], cwd=workspace, check=True, capture_output=True, text=True).stdout.strip()
            git("init")
            git("config", "user.email", "test@example.com")
            git("config", "user.name", "Test")
            (workspace / "safe.txt").write_text("before\n", encoding="utf-8")
            (workspace / ".env").write_text("SECRET=before\n", encoding="utf-8")
            git("add", "safe.txt", ".env")
            git("commit", "-m", "before")
            before = git("rev-parse", "HEAD")
            (workspace / "safe.txt").write_text("after\n", encoding="utf-8")
            (workspace / ".env").write_text("SECRET=after\n", encoding="utf-8")
            git("add", "safe.txt", ".env")
            git("commit", "-m", "after")
            service = self.make_service(Path(td) / "runtime", workspace)
            args = {"base": before, "head": "HEAD"}
            result = service.execute("git.diff", args, token="x" * 64)
            self.assertIn("-before", result["stdout"])
            self.assertIn("+after", result["stdout"])
            self.assertNotIn("SECRET", result["stdout"])
            self.assertIn(".env", result["blocked_paths"])
            stat = service.execute("git.diff", {**args, "stat": True}, token="x" * 64)
            self.assertIn("safe.txt", stat["stdout"])
            self.assertNotIn(".env", stat["stdout"])
            for bad in ({"base": "--output=leak"}, {"base": "missing-ref"}, {"head": "HEAD"}, {**args, "staged": True}):
                with self.assertRaises(ValueError):
                    service.execute("git.diff", bad, token="x" * 64)

    def test_git_diff_and_commit_do_not_expose_staged_sensitive_files(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "runtime"
            workspace = Path(td) / "project"
            workspace.mkdir()
            subprocess.run(["git", "init"], cwd=workspace, check=True, capture_output=True)
            subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=workspace, check=True)
            subprocess.run(["git", "config", "user.name", "Test"], cwd=workspace, check=True)
            (workspace / "safe.txt").write_text("safe\n", encoding="utf-8")
            (workspace / ".env").write_text("TOP_SECRET=value\n", encoding="utf-8")
            subprocess.run(["git", "add", "safe.txt", ".env"], cwd=workspace, check=True)
            subprocess.run(["git", "commit", "-m", "init"], cwd=workspace, check=True, capture_output=True)
            (workspace / "safe.txt").write_text("safe changed\n", encoding="utf-8")
            (workspace / ".env").write_text("TOP_SECRET=changed-secret\n", encoding="utf-8")

            service = self.make_service(root, workspace)
            token = "x" * 64
            diff = service.execute("git.diff", {}, token=token)
            self.assertIn("safe changed", diff["stdout"])
            self.assertNotIn("changed-secret", diff["stdout"])
            self.assertIn(".env", diff["blocked_paths"])

            subprocess.run(["git", "add", ".env"], cwd=workspace, check=True)
            with self.assertRaises(PermissionError):
                service.execute("git.commit", {"message": "should block"}, token=token)

    def test_terminal_git_bypass_commands_are_blocked(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "runtime"
            workspace = Path(td) / "project"
            workspace.mkdir()
            subprocess.run(["git", "init"], cwd=workspace, check=True, capture_output=True)
            service = self.make_service(root, workspace)
            service.configure(workspace, {"terminal": True}, token="x" * 64)
            for argv in (
                ["git", "-c", "core.pager=evil", "log"],
                ["git", "config", "core.fsmonitor", "evil"],
                ["git", "diff", "--no-index", "../outside.txt", "a.txt"],
                ["git", "log", "--output=leak.txt"],
                ["git", "branch", "new-branch"],
                ["git", "commit", "--amend", "-m", "x"],
                ["git", "add", "-A"],
                ["git", "push", "--force"],
            ):
                with self.assertRaises(PermissionError, msg=argv):
                    service.execute("terminal.run", {"argv": argv}, token="x" * 64, confirm=True)

    def test_shell_wrappers_require_explicit_confirmation(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "runtime"
            workspace = Path(td) / "project"
            workspace.mkdir()
            service = self.make_service(root, workspace)
            service.configure(workspace, {"terminal": True}, token="x" * 64)
            shell = "cmd.exe" if os.name == "nt" else "sh"
            argv = [shell, "/c", "echo ok"] if os.name == "nt" else [shell, "-c", "echo ok"]
            with self.assertRaises(PermissionError):
                service.execute("terminal.run", {"argv": argv}, token="x" * 64)


    def test_explicit_workspace_execution_does_not_replace_chatgpt_selection(self):
        with tempfile.TemporaryDirectory() as td:
            base = Path(td)
            root = base / "runtime"
            selected = base / "selected"
            other = base / "other"
            selected.mkdir()
            other.mkdir()
            (other / "item.txt").write_text("shared", encoding="utf-8")
            service = self.make_service(root, selected)
            result = service.execute_in_workspace(
                other,
                "filesystem.read",
                {"path": "item.txt"},
                trusted=True,
                actor="teamyra-mcp",
            )
            self.assertEqual(result["content"], "shared")
            self.assertEqual(service.status(token="x" * 64)["workspace"], str(selected.resolve()))

    def test_destructive_terminal_commands_require_confirmation(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "runtime"
            workspace = Path(td) / "project"
            workspace.mkdir()
            service = self.make_service(root, workspace)
            service.configure(workspace, {"terminal": True}, token="x" * 64)
            command = ["git", "reset", "--hard", "HEAD"]
            with self.assertRaises(PermissionError):
                service.execute("terminal.run", {"argv": command}, token="x" * 64)


    def test_terminal_environment_scrubs_bridge_and_secret_variables(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "runtime"
            workspace = Path(td) / "project"
            workspace.mkdir()
            service = self.make_service(root, workspace)
            service.configure(workspace, {"terminal": True}, token="x" * 64)
            script = workspace / "env_check.py"
            script.write_text(
                "import os; print(os.getenv('TEAMYRA_LOCAL_AGENT_TOKEN_FILE')); print(os.getenv('MY_API_KEY'))",
                encoding="utf-8",
            )
            old_token = os.environ.get("TEAMYRA_LOCAL_AGENT_TOKEN_FILE")
            old_key = os.environ.get("MY_API_KEY")
            os.environ["TEAMYRA_LOCAL_AGENT_TOKEN_FILE"] = str(Path(td) / "security" / "token")
            os.environ["MY_API_KEY"] = "do-not-leak"
            try:
                result = service.execute(
                    "terminal.run",
                    {"argv": [sys.executable, "env_check.py"]},
                    token="x" * 64,
                )
            finally:
                if old_token is None:
                    os.environ.pop("TEAMYRA_LOCAL_AGENT_TOKEN_FILE", None)
                else:
                    os.environ["TEAMYRA_LOCAL_AGENT_TOKEN_FILE"] = old_token
                if old_key is None:
                    os.environ.pop("MY_API_KEY", None)
                else:
                    os.environ["MY_API_KEY"] = old_key
            self.assertEqual(result["exit_code"], 0)
            self.assertNotIn("do-not-leak", result["stdout"])
            self.assertNotIn("security", result["stdout"])

    def test_teamyra_runtime_and_credential_like_files_are_blocked(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "runtime"
            root.mkdir()
            (root / "profiles" / "codex").mkdir(parents=True)
            (root / "profiles" / "codex" / "auth.json").write_text("secret", encoding="utf-8")
            (root / ".env").write_text("TOKEN=secret", encoding="utf-8")
            service = WorkspaceToolService(root)
            service.state_root.mkdir(parents=True, exist_ok=True)
            service.token_file.write_text("x" * 64, encoding="utf-8")
            service.configure(root, token="x" * 64)

            for target in ("profiles/codex/auth.json", "chatgpt/local-agent.token", ".env"):
                with self.assertRaises(PermissionError, msg=target):
                    service.execute("filesystem.read", {"path": target}, token="x" * 64)

            listing = service.execute("filesystem.list", {}, token="x" * 64)
            names = {item["name"] for item in listing["items"]}
            self.assertNotIn("profiles", names)
            self.assertNotIn("chatgpt", names)
            self.assertNotIn(".env", names)

    def test_terminal_auto_mode_allows_only_bounded_inspection(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "runtime"
            workspace = Path(td) / "project"
            workspace.mkdir()
            service = self.make_service(root, workspace)
            service.configure(workspace, {"terminal": True}, token="x" * 64)

            version = service.execute(
                "terminal.run", {"argv": [sys.executable, "--version"]}, token="x" * 64
            )
            self.assertEqual(version["exit_code"], 0)

            script = workspace / "script.py"
            script.write_text("print('workspace script')", encoding="utf-8")
            ran = service.execute(
                "terminal.run", {"argv": [sys.executable, "script.py"]}, token="x" * 64
            )
            self.assertIn("workspace script", ran["stdout"])
            for argv in (
                [sys.executable, "-c", "print(1)"],
                [sys.executable, "-m", "http.server"],
                ["node", "-e", "1"],
            ):
                with self.assertRaises(PermissionError, msg=argv):
                    service.execute("terminal.run", {"argv": argv}, token="x" * 64)

    def test_default_terminal_permission_is_on_but_stays_guarded(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "runtime"
            workspace = Path(td) / "project"
            workspace.mkdir()
            service = self.make_service(root, workspace)
            result = service.execute(
                "terminal.run", {"argv": [sys.executable, "--version"]}, token="x" * 64
            )
            self.assertEqual(result["exit_code"], 0)

    def test_switching_workspace_keeps_full_tools_but_resets_destructive_bypass(self):
        with tempfile.TemporaryDirectory() as td:
            base = Path(td)
            root = base / "runtime"
            first = base / "first"
            second = base / "second"
            first.mkdir()
            second.mkdir()
            service = self.make_service(root, first)
            token = "x" * 64
            service.configure(
                first,
                {"terminal": True},
                token=token,
                access={"destructive_without_confirmation": True},
                user_confirmed=True,
            )
            self.assertTrue(service.status(token=token)["permissions"]["terminal"])
            service.configure(second, {}, token=token)
            permissions = service.status(token=token)["permissions"]
            self.assertTrue(permissions["terminal"])
            self.assertFalse(permissions["destructive_without_confirmation"])

    def test_explicit_workspace_execution_does_not_change_chatgpt_selection(self):
        with tempfile.TemporaryDirectory() as td:
            base = Path(td)
            runtime = base / "runtime"
            selected = base / "selected"
            other = base / "other"
            selected.mkdir()
            other.mkdir()
            service = self.make_service(runtime, selected)

            result = service.execute_in_workspace(
                other, "filesystem.create", {"path": "shared.txt", "content": "ok"}, trusted=True,
                actor="teamyra-mcp:test",
            )
            self.assertTrue(Path(result["path"]).exists())
            status = service.status(token="x" * 64)
            self.assertEqual(Path(status["workspace"]), selected.resolve())

    def test_outside_workspace_flag_cannot_disable_sandbox(self):
        with tempfile.TemporaryDirectory() as td:
            base = Path(td)
            root = base / "runtime"
            workspace = base / "project"
            outside = base / "outside.txt"
            workspace.mkdir()
            outside.write_text("secret", encoding="utf-8")
            service = self.make_service(root, workspace)
            with self.assertRaises(PermissionError):
                service.configure(workspace, {"outside_workspace": True}, token="x" * 64)
            # outside_workspace alone (even if set by the user) is not honoured without full_access
            service.set_access({"outside_workspace": True}, token="x" * 64, user_confirmed=True)
            with self.assertRaises(PermissionError):
                service.execute("filesystem.read", {"path": str(outside)}, token="x" * 64)

    def test_patch_preserves_crlf_bytes(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "runtime"
            workspace = Path(td) / "project"
            workspace.mkdir()
            target = workspace / "crlf.txt"
            target.write_bytes(b"one\r\ntwo\r\n")
            service = self.make_service(root, workspace)
            service.execute("filesystem.patch", {
                "path": "crlf.txt",
                "replacements": [{"find": "two", "replace": "three", "expected": 1}],
            }, token="x" * 64)
            self.assertEqual(target.read_bytes(), b"one\r\nthree\r\n")

    def test_search_does_not_follow_symlink_outside_workspace(self):
        if not hasattr(os, "symlink"):
            self.skipTest("symlink unsupported")
        with tempfile.TemporaryDirectory() as td:
            base = Path(td)
            root = base / "runtime"
            workspace = base / "project"
            workspace.mkdir()
            outside = base / "outside.txt"
            outside.write_text("TOP-SECRET-SEARCH-TOKEN", encoding="utf-8")
            link = workspace / "linked.txt"
            try:
                os.symlink(outside, link)
            except OSError:
                self.skipTest("symlink creation not permitted")
            service = self.make_service(root, workspace)
            result = service.execute("filesystem.search", {"query": "TOP-SECRET-SEARCH-TOKEN"}, token="x" * 64)
            self.assertEqual(result["results"], [])

    def test_teamyra_desktop_user_data_is_blocked(self):
        with tempfile.TemporaryDirectory() as td:
            base = Path(td)
            root = base / "runtime"
            workspace = base / "project"
            user_data = base / "desktop-user-data"
            workspace.mkdir()
            user_data.mkdir()
            (user_data / "Cookies").write_text("session", encoding="utf-8")
            old = os.environ.get("TEAMYRA_DESKTOP_USER_DATA")
            os.environ["TEAMYRA_DESKTOP_USER_DATA"] = str(user_data)
            try:
                service = self.make_service(root, workspace)
                with self.assertRaises(PermissionError):
                    service.execute(
                        "filesystem.read",
                        {"path": str(user_data / "Cookies")},
                        token="x" * 64,
                    )
                with self.assertRaises(PermissionError):
                    service.configure(user_data, token="x" * 64)
            finally:
                if old is None:
                    os.environ.pop("TEAMYRA_DESKTOP_USER_DATA", None)
                else:
                    os.environ["TEAMYRA_DESKTOP_USER_DATA"] = old

    def test_git_internal_files_are_hidden_from_filesystem_tools(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "runtime"
            workspace = Path(td) / "project"
            workspace.mkdir()
            subprocess.run(["git", "init"], cwd=workspace, check=True, capture_output=True)
            service = self.make_service(root, workspace)
            token = "x" * 64

            listing = service.execute("filesystem.list", {}, token=token)
            self.assertNotIn(".git", {item["name"] for item in listing["items"]})
            with self.assertRaises(PermissionError):
                service.execute("filesystem.read", {"path": ".git/config"}, token=token)

    def test_workspace_root_cannot_be_moved_or_renamed(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "runtime"
            workspace = Path(td) / "project"
            workspace.mkdir()
            service = self.make_service(root, workspace)
            token = "x" * 64
            for tool, args in (
                ("filesystem.move", {"path": ".", "destination": "moved"}),
                ("filesystem.rename", {"path": ".", "new_name": "renamed"}),
            ):
                with self.assertRaises(PermissionError, msg=tool):
                    service.execute(tool, args, token=token)

    def test_git_add_requires_explicit_files_and_blocks_credential_like_paths(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "runtime"
            workspace = Path(td) / "project"
            workspace.mkdir()
            subprocess.run(["git", "init"], cwd=workspace, check=True, capture_output=True)
            service = self.make_service(root, workspace)
            token = "x" * 64
            (workspace / "safe.txt").write_text("ok", encoding="utf-8")
            (workspace / ".npmrc").write_text("_authToken=secret", encoding="utf-8")

            with self.assertRaises(PermissionError):
                service.execute("git.add", {"paths": ["."]}, token=token)
            with self.assertRaises(PermissionError):
                service.execute("git.add", {"paths": [".npmrc"]}, token=token)

            added = service.execute("git.add", {"paths": ["safe.txt"]}, token=token)
            self.assertEqual(added["exit_code"], 0)

    def test_git_add_blocks_repository_clean_filters(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "runtime"
            workspace = Path(td) / "project"
            workspace.mkdir()
            subprocess.run(["git", "init"], cwd=workspace, check=True, capture_output=True)
            (workspace / ".gitattributes").write_text("filtered.txt filter=unsafe\n", encoding="utf-8")
            (workspace / "filtered.txt").write_text("payload\n", encoding="utf-8")
            service = self.make_service(root, workspace)
            token = "x" * 64

            with self.assertRaisesRegex(PermissionError, "clean filters"):
                service.execute("git.add", {"paths": ["filtered.txt"]}, token=token)

    def test_authentication_and_audit_log(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "runtime"
            workspace = Path(td) / "project"
            workspace.mkdir()
            service = self.make_service(root, workspace)
            with self.assertRaises(PermissionError):
                service.status(token="wrong")
            service.execute("filesystem.list", {}, token="x" * 64, actor="chatgpt-normal")
            rows = [json.loads(line) for line in service.audit_file.read_text(encoding="utf-8").splitlines()]
            self.assertEqual(rows[-1]["agent"], "chatgpt-normal")
            self.assertEqual(rows[-1]["tool"], "filesystem.list")
            self.assertEqual(rows[-1]["result"], "success")

    def make_history(self, td):
        workspace = Path(td) / "project"
        workspace.mkdir()
        git = self.init_repo(workspace)
        (workspace / "safe.txt").write_text("one\n", encoding="utf-8")
        (workspace / ".env").write_text("SECRET=first\n", encoding="utf-8")
        git("add", "safe.txt", ".env")
        git("commit", "-m", "first")
        first = git("rev-parse", "HEAD")
        (workspace / "safe.txt").write_text("two\n", encoding="utf-8")
        (workspace / ".env").write_text("SECRET=second\n", encoding="utf-8")
        (workspace / "other.txt").write_text("other\n", encoding="utf-8")
        git("add", "safe.txt", ".env", "other.txt")
        git("commit", "-m", "second")
        service = self.make_service(Path(td) / "runtime", workspace)
        return workspace, git, service, first

    def test_git_tools_reject_unknown_args_and_list_allowed_keys(self):
        with tempfile.TemporaryDirectory() as td:
            _, _, service, _ = self.make_history(td)
            for tool, args in (
                ("git.diff", {"rangee": "HEAD~1..HEAD"}),
                ("git.log", {"count": 3}),
                ("git.status", {"porcelain": True}),
                ("git.show", {"commit": "HEAD"}),
                ("git.commit", {"message": "x", "amend": True}),
            ):
                with self.assertRaises(ValueError, msg=tool) as caught:
                    service.execute(tool, args, token="x" * 64)
                self.assertIn("allowed arguments", str(caught.exception))
            with self.assertRaisesRegex(ValueError, "range"):
                service.execute("git.diff", {"base": "HEAD~1", "range": "HEAD~1..HEAD"}, token="x" * 64)
            for bad in ("HEAD", "missing..HEAD", "--output=x..HEAD", "A..B..C"):
                with self.assertRaises(ValueError, msg=bad):
                    service.execute("git.diff", {"range": bad}, token="x" * 64)

    def test_git_diff_range_name_only_unified_and_paths(self):
        with tempfile.TemporaryDirectory() as td:
            _, _, service, first = self.make_history(td)
            token = "x" * 64
            for value in (f"{first}..HEAD", f"{first}...HEAD", "HEAD~1.."):
                result = service.execute("git.diff", {"range": value}, token=token)
                self.assertIn("+two", result["stdout"], value)
                self.assertNotIn("SECRET", result["stdout"], value)
                self.assertIn(".env", result["blocked_paths"])
            names = service.execute("git.diff", {"range": f"{first}..HEAD", "name_only": True}, token=token)
            self.assertEqual(sorted(names["stdout"].split()), ["other.txt", "safe.txt"])
            narrow = service.execute(
                "git.diff", {"range": f"{first}..HEAD", "paths": ["safe.txt"], "unified": 0}, token=token
            )
            self.assertIn("-U0", narrow["argv"])
            self.assertIn("+two", narrow["stdout"])
            self.assertNotIn("other", narrow["stdout"])
            with self.assertRaises(PermissionError):
                service.execute("git.diff", {"range": f"{first}..HEAD", "path": ".env"}, token=token)

    def test_git_log_show_and_status_args(self):
        with tempfile.TemporaryDirectory() as td:
            workspace, _, service, first = self.make_history(td)
            token = "x" * 64
            log = service.execute("git.log", {"max_count": 1}, token=token)
            self.assertIn("second", log["stdout"])
            self.assertNotIn("first", log["stdout"])
            ranged = service.execute("git.log", {"range": f"{first}..HEAD", "since": "2000-01-01"}, token=token)
            self.assertIn("second", ranged["stdout"])
            self.assertNotIn("first", ranged["stdout"])
            by_path = service.execute("git.log", {"path": "other.txt"}, token=token)
            self.assertEqual(len(by_path["stdout"].splitlines()), 1)
            with self.assertRaises(ValueError):
                service.execute("git.log", {"since": "--all"}, token=token)

            shown = service.execute("git.show", {}, token=token)
            self.assertIn("second", shown["stdout"])
            self.assertIn("+two", shown["stdout"])
            self.assertNotIn("SECRET", shown["stdout"])
            self.assertIn(".env", shown["blocked_paths"])
            stat = service.execute("git.show", {"ref": first, "stat": True, "path": "safe.txt"}, token=token)
            self.assertIn("safe.txt", stat["stdout"])
            self.assertNotIn(".env", stat["stdout"])
            with self.assertRaises(PermissionError):
                service.execute("git.show", {"path": ".env"}, token=token)
            with self.assertRaises(ValueError):
                service.execute("git.show", {"ref": "no-such-ref"}, token=token)

            (workspace / "safe.txt").write_text("three\n", encoding="utf-8")
            (workspace / "other.txt").write_text("changed\n", encoding="utf-8")
            status = service.execute("git.status", {"paths": ["safe.txt"]}, token=token)
            self.assertIn("safe.txt", status["stdout"])
            self.assertNotIn("other.txt", status["stdout"])

    def test_terminal_read_only_git_runs_without_confirmation_and_hides_secrets(self):
        with tempfile.TemporaryDirectory() as td:
            workspace, _, service, first = self.make_history(td)
            token = "x" * 64
            for argv in (
                ["git", "log", "-p"],
                ["git", "show", "HEAD"],
                ["git", "diff", first, "HEAD"],
                ["git", "grep", "-n", "SECRET", "HEAD"],
            ):
                result = service.execute("terminal.run", {"argv": argv}, token=token)
                self.assertIn(result["exit_code"], (0, 1), argv)
                self.assertNotIn("SECRET=", result["stdout"], argv)
            log = service.execute("terminal.run", {"argv": ["git", "log", "-p", "--", "safe.txt"]}, token=token)
            self.assertIn("+two", log["stdout"])
            for argv in (
                ["git", "blame", "safe.txt"],
                ["git", "ls-files"],
                ["git", "branch", "--list"],
                ["git", "rev-list", "--count", "HEAD"],
                ["git", "status", "--short"],
                ["git", "rev-parse", "HEAD"],
            ):
                result = service.execute("terminal.run", {"argv": argv}, token=token)
                self.assertEqual(result["exit_code"], 0, argv)
            for argv in (["git", "show", "HEAD:.env"], ["git", "blame", ".env"]):
                with self.assertRaises(PermissionError, msg=argv):
                    service.execute("terminal.run", {"argv": argv}, token=token)

    def test_terminal_git_add_and_commit_use_git_tool_checks(self):
        with tempfile.TemporaryDirectory() as td:
            workspace, git, service, _ = self.make_history(td)
            token = "x" * 64
            (workspace / "safe.txt").write_text("three\n", encoding="utf-8")
            added = service.execute("terminal.run", {"argv": ["git", "add", "safe.txt"]}, token=token)
            self.assertEqual(added["delegated_tool"], "git.add")
            committed = service.execute(
                "terminal.run", {"argv": ["git", "commit", "-m", "third"]}, token=token
            )
            self.assertEqual(committed["exit_code"], 0)
            self.assertEqual(git("log", "-1", "--format=%s"), "third")
            with self.assertRaises(PermissionError):
                service.execute("terminal.run", {"argv": ["git", "add", ".env"]}, token=token)
            (workspace / ".env").write_text("SECRET=third\n", encoding="utf-8")
            git("add", ".env")
            with self.assertRaises(PermissionError):
                service.execute("terminal.run", {"argv": ["git", "commit", "-m", "leak"]}, token=token)

    def test_sandbox_dev_allowlist_and_blocked_installs(self):
        with tempfile.TemporaryDirectory() as td:
            base = Path(td)
            workspace = base / "project"
            (workspace / "tests").mkdir(parents=True)
            (workspace / "tests" / "test_ok.py").write_text(
                "import unittest\nclass T(unittest.TestCase):\n    def test_ok(self):\n        self.assertTrue(True)\n",
                encoding="utf-8",
            )
            (base / "outside.py").write_text("print('outside')", encoding="utf-8")
            service = self.make_service(base / "runtime", workspace)
            token = "x" * 64
            result = service.execute(
                "terminal.run",
                {"argv": [sys.executable, "-m", "unittest", "discover", "-s", "tests"]},
                token=token,
            )
            self.assertEqual(result["exit_code"], 0, result["stderr"])
            (workspace / "args.py").write_text("import sys; print(sys.argv[1:])", encoding="utf-8")
            script_args = service.execute(
                "terminal.run", {"argv": [sys.executable, "args.py", "-c", "cfg"]}, token=token
            )
            self.assertIn("'-c', 'cfg'", script_args["stdout"])
            with self.assertRaises(PermissionError):
                service.execute("terminal.run", {"argv": [sys.executable, str(base / "outside.py")]}, token=token)
            with self.assertRaises(PermissionError):
                service.execute(
                    "terminal.run", {"argv": [sys.executable, "outside.py"], "cwd": str(base)}, token=token
                )
            for argv in (
                ["npm", "install", "left-pad"],
                ["npm", "i", "-g", "x"],
                ["npx", "cowsay"],
                ["pip", "install", "requests"],
                [sys.executable, "-m", "pip", "install", "requests"],
                ["curl", "https://example.com"],
                ["git", "fetch"],
                ["winget", "install", "x"],
                ["cmd.exe", "/c", "npm install x"],
            ):
                with self.assertRaisesRegex(PermissionError, "Full PC access", msg=argv):
                    service.execute("terminal.run", {"argv": argv}, token=token, confirm=True)
            auto = service._sandbox_auto_argv
            perms = service._load()["permissions"]
            ws = workspace.resolve()
            (ws / "tool.ts").write_text("console.log(1)", encoding="utf-8")
            self.assertEqual(auto(["npx", "tsx", "tool.ts"], ws, ws, perms), ["npx", "--no", "tsx", "tool.ts"])
            self.assertIsNotNone(auto(["npm", "run", "build", "--", "--watch"], ws, ws, perms))
            self.assertIsNotNone(auto(["npm", "test"], ws, ws, perms))
            self.assertIsNone(auto(["npm", "run", "build", "--prefix", "C:/x"], ws, ws, perms))
            self.assertIsNotNone(auto(["node", "tool.ts"], ws, ws, perms))
            self.assertIsNone(auto(["node", "--require", "x", "tool.ts"], ws, ws, perms))

    @unittest.skipUnless(os.name == "nt", "batch launcher quoting is Windows-specific")
    def test_batch_launcher_rejects_shell_metacharacters_in_sandbox(self):
        with tempfile.TemporaryDirectory() as td:
            workspace = Path(td) / "project"
            workspace.mkdir()
            launcher = workspace / "tool.cmd"
            launcher.write_text("@echo %1\n", encoding="utf-8")
            service = self.make_service(Path(td) / "runtime", workspace)
            with self.assertRaisesRegex(PermissionError, "metacharacters"):
                service.execute(
                    "terminal.run", {"argv": [str(launcher), "a&whoami"]}, token="x" * 64, confirm=True
                )

    def test_full_access_cannot_be_enabled_by_tool_or_mcp_paths(self):
        with tempfile.TemporaryDirectory() as td:
            base = Path(td)
            workspace = base / "project"
            workspace.mkdir()
            service = self.make_service(base / "runtime", workspace)
            token = "x" * 64
            for key in ("full_access", "outside_workspace", "destructive_without_confirmation"):
                with self.assertRaisesRegex(PermissionError, "only be enabled by the user", msg=key):
                    service.configure(workspace, {key: True}, token=token)
                with self.assertRaisesRegex(PermissionError, "only be enabled by the user", msg=key):
                    service.configure(workspace, token=token, access={key: True})
                with self.assertRaisesRegex(PermissionError, "only be enabled by the user", msg=key):
                    service.set_access({key: True}, trusted=True)
                with self.assertRaisesRegex(PermissionError, "only be enabled by the user", msg=key):
                    service.execute_in_workspace(
                        workspace, "filesystem.list", {}, permissions={key: True}, trusted=True, actor="teamyra-mcp"
                    )
            with self.assertRaises(ValueError):
                service.set_access({"full_access": "false"}, trusted=True, user_confirmed=True)
            with self.assertRaises(ValueError):
                service.set_access({"admin": True}, trusted=True, user_confirmed=True)
            # tool args cannot smuggle settings either
            with self.assertRaises(ValueError):
                service.execute("git.status", {"full_access": True}, token=token)
            with self.assertRaises(ValueError):
                service.execute("workspace.configure", {"full_access": True}, token=token)
            permissions = service.status(token=token)["permissions"]
            for key in ("full_access", "outside_workspace", "destructive_without_confirmation"):
                self.assertFalse(permissions[key], key)
            rows = [json.loads(line) for line in service.audit_file.read_text(encoding="utf-8").splitlines()]
            denied = [row for row in rows if row["result"] == "error" and "only be enabled" in row.get("error", "")]
            self.assertGreaterEqual(len(denied), 12)

    def test_user_enabled_full_access_is_inherited_but_never_raised_by_callers(self):
        with tempfile.TemporaryDirectory() as td:
            base = Path(td)
            workspace = base / "project"
            other = base / "elsewhere"
            workspace.mkdir()
            other.mkdir()
            (other / "notes.txt").write_text("outside", encoding="utf-8")
            service = self.make_service(base / "runtime", workspace)
            token = "x" * 64
            self.enable_full_access(service)
            self.assertEqual(service.status(token=token)["access_mode"], "full")
            read = service.execute("filesystem.read", {"path": str(other / "notes.txt")}, token=token)
            self.assertEqual(read["content"], "outside")
            listing = service.execute("filesystem.list", {"path": str(other)}, token=token)
            self.assertEqual([item["name"] for item in listing["items"]], ["notes.txt"])
            inherited = service.execute_in_workspace(
                workspace, "filesystem.read", {"path": str(other / "notes.txt")}, trusted=True
            )
            self.assertEqual(inherited["content"], "outside")
            # a caller may lower the user switch
            with self.assertRaises(PermissionError):
                service.execute_in_workspace(
                    workspace, "filesystem.read", {"path": str(other / "notes.txt")},
                    permissions={"full_access": False}, trusted=True,
                )
            # re-sending the stored value is fine, the off switch always works
            service.configure(workspace, {"full_access": True}, token=token)
            service.set_access({"full_access": False}, trusted=True)
            with self.assertRaises(PermissionError):
                service.execute("filesystem.read", {"path": str(other / "notes.txt")}, token=token)

    def test_credential_denylist_stays_enforced_with_full_access(self):
        with tempfile.TemporaryDirectory() as td:
            base = Path(td)
            workspace = base / "project"
            workspace.mkdir()
            security = base / "security"
            security.mkdir()
            (security / "local-agent.token").write_text("x" * 64, encoding="utf-8")
            (base / "elsewhere").mkdir()
            (base / "elsewhere" / "auth.json").write_text("{}", encoding="utf-8")
            (base / "elsewhere" / ".env").write_text("SECRET=1", encoding="utf-8")
            old = os.environ.get("TEAMYRA_LOCAL_AGENT_TOKEN_FILE")
            os.environ["TEAMYRA_LOCAL_AGENT_TOKEN_FILE"] = str(security / "local-agent.token")
            try:
                service = WorkspaceToolService(base / "runtime")
                service.configure(workspace, trusted=True)
                self.enable_full_access(service, destructive=True)
                for target in (
                    security / "local-agent.token",
                    base / "elsewhere" / "auth.json",
                    base / "elsewhere" / ".env",
                    service.settings_file,
                    service.audit_file,
                ):
                    with self.assertRaises(PermissionError, msg=str(target)):
                        service.execute("filesystem.write", {"path": str(target), "content": "x"}, trusted=True)
                permissions = service._load()["permissions"]
                self.assertTrue(permissions["full_access"])
                home = Path.home()
                for target in (
                    home / ".ssh" / "id_test", home / ".gnupg" / "x", home / ".aws" / "credentials",
                    home / ".azure" / "x", home / ".codex" / "auth.json", home / ".claude" / ".credentials.json",
                    home / ".claude.json", home / ".config" / "gh" / "hosts.yml",
                ):
                    with self.assertRaises(PermissionError, msg=str(target)):
                        service._path(str(target), workspace.resolve(), permissions)
                if os.name == "nt":
                    windir = Path(os.environ.get("WINDIR", "C:/Windows"))
                    with self.assertRaises(PermissionError):
                        service._path(str(windir / "System32" / "config" / "SAM"), workspace.resolve(), permissions)
                    local = os.environ.get("LOCALAPPDATA")
                    if local:
                        with self.assertRaises(PermissionError):
                            service._path(
                                str(Path(local) / "Google" / "Chrome" / "User Data" / "Default"),
                                workspace.resolve(), permissions,
                            )
                with self.assertRaises(PermissionError):
                    service.execute(
                        "terminal.run",
                        {"argv": [sys.executable, "-c", "pass", str(security / "local-agent.token")]},
                        trusted=True,
                    )
                with self.assertRaises(PermissionError):
                    service.execute(
                        "terminal.run", {"argv": [sys.executable, "--version"], "cwd": str(security)}, trusted=True
                    )
            finally:
                if old is None:
                    os.environ.pop("TEAMYRA_LOCAL_AGENT_TOKEN_FILE", None)
                else:
                    os.environ["TEAMYRA_LOCAL_AGENT_TOKEN_FILE"] = old

    def test_full_access_terminal_runs_anywhere_but_destructive_needs_confirmation(self):
        with tempfile.TemporaryDirectory() as td:
            base = Path(td)
            workspace = base / "project"
            workspace.mkdir()
            elsewhere = base / "elsewhere"
            elsewhere.mkdir()
            (elsewhere / "script.py").write_text("import os; print(os.getcwd())", encoding="utf-8")
            service = self.make_service(base / "runtime", workspace)
            token = "x" * 64
            pip_version = [sys.executable, "-m", "pip", "--version"]
            with self.assertRaises(PermissionError):
                service.execute("terminal.run", {"argv": pip_version}, token=token, confirm=True)
            self.enable_full_access(service)
            ran = service.execute(
                "terminal.run", {"argv": [sys.executable, "-c", "print('eval ok')"], "cwd": str(elsewhere)}, token=token
            )
            self.assertIn("eval ok", ran["stdout"])
            script = service.execute(
                "terminal.run", {"argv": [sys.executable, str(elsewhere / "script.py")], "cwd": str(elsewhere)},
                token=token,
            )
            self.assertEqual(Path(script["stdout"].strip()).resolve(), elsewhere.resolve())
            self.assertEqual(service.execute("terminal.run", {"argv": pip_version}, token=token)["exit_code"], 0)
            destructive = (
                ["git", "push", "--force"],
                ["git", "reset", "--hard", "HEAD"],
                ["git", "clean", "-fdx"],
                ["rm", "-rf", "build"],
                ["cmd", "/c", "rd /s /q build"],
                ["powershell", "-Command", "Remove-Item -Recurse -Force build"],
                ["reg", "add", "HKCU\\Software\\X"],
                ["format", "D:"],
            )
            for argv in destructive:
                with self.assertRaisesRegex(PermissionError, "confirmation", msg=argv):
                    service.execute("terminal.run", {"argv": argv, "cwd": str(elsewhere)}, token=token)
            self.assertNotIn("destructive", service._command_tags(["reg", "query", "HKCU\\Software"]))
            self.assertNotIn("destructive", service._command_tags(["git", "push"]))
            self.assertIn("destructive", service._command_tags(["bash", "-c", "echo hi && rm -rf /tmp/x"]))
            self.enable_full_access(service, destructive=True)
            (elsewhere / "build").mkdir()
            removed = service.execute(
                "terminal.run",
                {"argv": [sys.executable, "-c", "import shutil; shutil.rmtree('build')"], "cwd": str(elsewhere)},
                token=token,
            )
            self.assertEqual(removed["exit_code"], 0)

    def test_every_terminal_and_write_call_is_audited(self):
        with tempfile.TemporaryDirectory() as td:
            base = Path(td)
            workspace = base / "project"
            workspace.mkdir()
            service = self.make_service(base / "runtime", workspace)
            token = "x" * 64
            service.execute("filesystem.write", {"path": "a.txt", "content": "1"}, token=token, actor="agent-a")
            service.execute("terminal.run", {"argv": [sys.executable, "--version"]}, token=token, actor="agent-a")
            with self.assertRaises(PermissionError):
                service.execute("terminal.run", {"argv": ["curl", "x"]}, token=token, actor="agent-a")
            with self.assertRaises(PermissionError):
                service.execute("filesystem.write", {"path": "../x.txt", "content": "1"}, token=token, actor="agent-a")
            self.enable_full_access(service)
            service.execute(
                "filesystem.write", {"path": str(base / "outside.txt"), "content": "1"}, token=token, actor="agent-a"
            )
            rows = [json.loads(line) for line in service.audit_file.read_text(encoding="utf-8").splitlines()]
            calls = [row for row in rows if row["agent"] == "agent-a"]
            self.assertEqual(
                [(row["tool"], row["result"], row["mode"]) for row in calls],
                [
                    ("filesystem.write", "success", "sandboxed"),
                    ("terminal.run", "success", "sandboxed"),
                    ("terminal.run", "error", "sandboxed"),
                    ("filesystem.write", "error", "sandboxed"),
                    ("filesystem.write", "success", "full_access"),
                ],
            )
            self.assertIn("--version", calls[1]["argv"])
            self.assertEqual(calls[1]["exit_code"], 0)
            self.assertIn("curl", calls[2]["argv"])
            access_rows = [row for row in rows if row["tool"] == "workspace.access"]
            self.assertTrue(access_rows[-1]["access"]["full_access"])


if __name__ == "__main__":
    unittest.main()
