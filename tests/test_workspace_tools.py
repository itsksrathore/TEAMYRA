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
            service.configure(workspace, {"outside_workspace": True}, token="x" * 64)
            with self.assertRaises(PermissionError):
                service.execute("filesystem.list", {"path": os.environ.get("WINDIR", r"C:\Windows")}, token="x" * 64)

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
            with self.assertRaises(PermissionError):
                service.execute(
                    "terminal.run", {"argv": ["git", "log", "-p"]}, token="x" * 64
                )

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
                with self.assertRaises(PermissionError):
                    service.execute(
                        "terminal.run",
                        {"argv": [sys.executable, "env_check.py"]},
                        token="x" * 64,
                    )
                result = service.execute(
                    "terminal.run",
                    {"argv": [sys.executable, "env_check.py"]},
                    token="x" * 64,
                    confirm=True,
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
            script.write_text("print('no automatic arbitrary code')", encoding="utf-8")
            with self.assertRaises(PermissionError):
                service.execute(
                    "terminal.run", {"argv": [sys.executable, "script.py"]}, token="x" * 64
                )

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
                {"terminal": True, "destructive_without_confirmation": True},
                token=token,
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
            service.configure(workspace, {"outside_workspace": True}, token="x" * 64)
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


if __name__ == "__main__":
    unittest.main()
