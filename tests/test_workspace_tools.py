import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
import sys

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
            service.execute("filesystem.delete", {"path": "nested/c.txt"}, token=token, confirm=True)
            self.assertFalse((workspace / "nested" / "c.txt").exists())


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

    def test_shell_wrappers_require_explicit_confirmation(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "runtime"
            workspace = Path(td) / "project"
            workspace.mkdir()
            service = self.make_service(root, workspace)
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
            command = ["git", "reset", "--hard", "HEAD"]
            with self.assertRaises(PermissionError):
                service.execute("terminal.run", {"argv": command}, token="x" * 64)


    def test_terminal_environment_scrubs_bridge_and_secret_variables(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "runtime"
            workspace = Path(td) / "project"
            workspace.mkdir()
            service = self.make_service(root, workspace)
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
