"""A worktree TEAMYRA created (ROOT/worktrees/<name>, registered in
ROOT/worktrees/.teamyra) can be a job's workspace; the registry, other
worktrees and the rest of the runtime stay blocked (maintenance issue
ISS-20261107-103235-0e56e6)."""
import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "bridge"))

from workspace_tools import WorkspaceToolService

TOKEN = "x" * 64


class ManagedWorktreeTests(unittest.TestCase):
    def setUp(self):
        self.td = tempfile.TemporaryDirectory()
        base = Path(self.td.name)
        self.root = base / "runtime"
        self.worktrees = self.root / "worktrees"
        registry = self.worktrees / ".teamyra"
        registry.mkdir(parents=True)
        self.managed = self.worktrees / "repo-c1-abc123"
        self.sibling = self.worktrees / "repo-c2-def456"
        self.unregistered = self.worktrees / "stray-folder"
        for path in (self.managed, self.sibling, self.unregistered):
            path.mkdir()
            (path / "a.txt").write_text("hello " + path.name, encoding="utf-8")
        for wt_id, path in (("wt-1", self.managed), ("wt-2", self.sibling)):
            (registry / f"{wt_id}.json").write_text(json.dumps({"id": wt_id, "path": str(path)}), encoding="utf-8")
        self.service = WorkspaceToolService(self.root)
        self.service.state_root.mkdir(parents=True, exist_ok=True)
        self.service.token_file.write_text(TOKEN, encoding="utf-8")

    def tearDown(self):
        self.td.cleanup()

    def run_tool(self, workspace, tool, args):
        return self.service.execute_in_workspace(workspace, tool, args, token=TOKEN, actor="test")

    def test_registered_worktree_is_a_usable_workspace(self):
        read = self.run_tool(self.managed, "filesystem.read", {"path": "a.txt"})
        self.assertIn("hello repo-c1", read["content"])
        self.run_tool(self.managed, "filesystem.create", {"path": "src/new.py", "content": "x = 1\n"})
        self.assertTrue((self.managed / "src" / "new.py").exists())
        listing = self.run_tool(self.managed, "filesystem.list", {"path": "."})
        self.assertIn("a.txt", [item["name"] for item in listing["items"]])

    def test_registry_siblings_and_unregistered_folders_stay_blocked(self):
        with self.assertRaises(PermissionError):
            self.run_tool(self.unregistered, "filesystem.read", {"path": "a.txt"})
        with self.assertRaises(PermissionError):
            self.run_tool(self.worktrees, "filesystem.list", {"path": "."})
        with self.assertRaises(PermissionError):
            self.run_tool(self.worktrees / ".teamyra", "filesystem.list", {"path": "."})
        # From inside a managed worktree, its siblings and the registry are out of reach.
        with self.assertRaises(PermissionError):
            self.run_tool(self.managed, "filesystem.read", {"path": str(self.sibling / "a.txt")})
        with self.assertRaises(PermissionError):
            self.run_tool(self.managed, "filesystem.read", {"path": "../.teamyra/wt-1.json"})
        # Other runtime folders stay blocked as before.
        (self.root / "jobs").mkdir()
        with self.assertRaises(PermissionError):
            self.run_tool(self.root / "jobs", "filesystem.list", {"path": "."})


if __name__ == "__main__":
    unittest.main()
