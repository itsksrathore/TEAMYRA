import subprocess
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "bridge"))

import worktree_manager
import server
import desktop_api


def git(cwd, *args):
    cp = subprocess.run(
        ["git", "-C", str(cwd), *args],
        text=True,
        capture_output=True,
        encoding="utf-8",
        errors="replace",
    )
    if cp.returncode != 0:
        raise RuntimeError(cp.stderr or cp.stdout)
    return cp.stdout.strip()


class WorktreeManagerTests(unittest.TestCase):
    def make_repo(self, root):
        repo = root / "repo"
        repo.mkdir()
        git(repo, "init", "-b", "main")
        git(repo, "config", "user.email", "teamyra@example.test")
        git(repo, "config", "user.name", "TEAMYRA Test")
        (repo / "app.txt").write_text("base\n", encoding="utf-8")
        git(repo, "add", "app.txt")
        git(repo, "commit", "-m", "base")
        return repo

    def test_create_status_diff_merge_and_discard(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            repo = self.make_repo(root)
            storage = root / "worktrees"

            created = worktree_manager.create(repo, storage, "feature")
            self.assertTrue(created["exists"])
            self.assertEqual(created["target_branch"], "main")
            self.assertFalse(created["dirty"])

            wt = Path(created["path"])
            (wt / "app.txt").write_text("base\nfeature\n", encoding="utf-8")
            git(wt, "add", "app.txt")
            git(wt, "commit", "-m", "feature")

            status = worktree_manager.status(storage, created["id"])
            self.assertEqual(len(status["commits"]), 1)
            self.assertIn("app.txt", status["diffstat"])

            diff = worktree_manager.diff(storage, created["id"])
            self.assertIn("+feature", diff["diff"])
            self.assertFalse(diff["clipped"])

            merged = worktree_manager.merge(storage, created["id"])
            self.assertTrue(merged["ok"])
            self.assertEqual((repo / "app.txt").read_text(encoding="utf-8"), "base\nfeature\n")

            removed = worktree_manager.discard(storage, created["id"])
            self.assertTrue(removed["removed"])
            self.assertFalse(wt.exists())

    def test_merge_rejects_uncommitted_worktree_changes(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            repo = self.make_repo(root)
            storage = root / "worktrees"
            created = worktree_manager.create(repo, storage, "dirty")
            wt = Path(created["path"])
            (wt / "dirty.txt").write_text("dirty\n", encoding="utf-8")

            with self.assertRaisesRegex(ValueError, "uncommitted"):
                worktree_manager.merge(storage, created["id"])

            worktree_manager.discard(storage, created["id"], force=True)
            self.assertFalse(wt.exists())

    def test_discard_rejects_unmerged_branch_without_force(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            repo = self.make_repo(root)
            storage = root / "worktrees"
            created = worktree_manager.create(repo, storage, "unmerged")
            wt = Path(created["path"])
            (wt / "new.txt").write_text("new\n", encoding="utf-8")
            git(wt, "add", "new.txt")
            git(wt, "commit", "-m", "new")

            with self.assertRaisesRegex(ValueError, "not merged"):
                worktree_manager.discard(storage, created["id"])

            forced = worktree_manager.discard(storage, created["id"], force=True)
            self.assertTrue(forced["forced"])

    def test_target_repository_must_be_clean_before_merge(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            repo = self.make_repo(root)
            storage = root / "worktrees"
            created = worktree_manager.create(repo, storage, "target-dirty")
            wt = Path(created["path"])
            (wt / "app.txt").write_text("base\nworktree\n", encoding="utf-8")
            git(wt, "add", "app.txt")
            git(wt, "commit", "-m", "worktree")

            (repo / "local.txt").write_text("local\n", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "target repository has uncommitted"):
                worktree_manager.merge(storage, created["id"])

            (repo / "local.txt").unlink()
            worktree_manager.discard(storage, created["id"], force=True)


    def test_worktree_mcp_tools_are_registered_once(self):
        names = [tool["name"] for tool in server.TOOLS]
        for name in (
            "worktree_create",
            "worktree_list",
            "worktree_status",
            "worktree_diff",
            "worktree_merge",
            "worktree_discard",
        ):
            self.assertEqual(names.count(name), 1, name)

    def test_merge_requires_explicit_confirmation(self):
        with patch.object(server.worktree_manager, "merge") as merge:
            with self.assertRaisesRegex(ValueError, "confirm=true"):
                server.tool_call("worktree_merge", {
                    "worktree_id": "wt-test",
                    "confirm": False,
                })
            merge.assert_not_called()

    def test_discard_requires_explicit_confirmation(self):
        with patch.object(server.worktree_manager, "discard") as discard:
            with self.assertRaisesRegex(ValueError, "confirm=true"):
                server.tool_call("worktree_discard", {
                    "worktree_id": "wt-test",
                    "confirm": False,
                })
            discard.assert_not_called()

    def test_confirmed_merge_and_discard_delegate_to_manager(self):
        with patch.object(server.worktree_manager, "merge", return_value={"ok": True}) as merge:
            result = server.tool_call("worktree_merge", {
                "worktree_id": "wt-test",
                "confirm": True,
            })
            self.assertTrue(result["ok"])
            merge.assert_called_once_with(server.WORKTREES, "wt-test")

        with patch.object(server.worktree_manager, "discard", return_value={"ok": True}) as discard:
            result = server.tool_call("worktree_discard", {
                "worktree_id": "wt-test",
                "confirm": True,
                "force": True,
            })
            self.assertTrue(result["ok"])
            discard.assert_called_once_with(server.WORKTREES, "wt-test", True)


    def test_run_ai_parallel_returns_and_persists_managed_worktree_id(self):
        wt = {
            "id": "wt-test-managed",
            "path": "/tmp/worktree",
            "branch": "teamyra/test/branch",
        }
        with patch.object(server, "pick_worker", return_value="codex1"), \
             patch.object(server, "create_worktree", return_value=wt) as create, \
             patch.object(server, "start_job", return_value=("job-1", "codex1")) as start, \
             patch.object(server, "patch_job_meta") as patch_meta, \
             patch.object(server, "follow_info", return_value={}):
            result = server.tool_call("run_ai_parallel", {
                "project_path": "/tmp/project",
                "tasks": [{"task": "Implement feature", "worker": "auto"}],
                "write": True,
            })
            self.assertEqual(result[0]["worktree_id"], "wt-test-managed")
            self.assertEqual(result[0]["branch"], "teamyra/test/branch")
            create.assert_called_once()
            start.assert_called_once()
            patch_meta.assert_called_once_with(
                "job-1",
                worktree_id="wt-test-managed",
                worktree_branch="teamyra/test/branch",
            )


    def test_desktop_api_requires_confirmation_for_destructive_actions(self):
        with patch.object(desktop_api.worktree_manager, "merge") as merge:
            with self.assertRaisesRegex(ValueError, "confirm=true"):
                desktop_api.handle("worktree.merge", {
                    "worktree_id": "wt-test",
                    "confirm": False,
                })
            merge.assert_not_called()

        with patch.object(desktop_api.worktree_manager, "discard") as discard:
            with self.assertRaisesRegex(ValueError, "confirm=true"):
                desktop_api.handle("worktree.discard", {
                    "worktree_id": "wt-test",
                    "confirm": False,
                })
            discard.assert_not_called()

    def test_desktop_api_delegates_read_actions_to_core_manager(self):
        with patch.object(desktop_api.worktree_manager, "list_managed", return_value=[{"id": "wt-1"}]) as listing:
            result = desktop_api.handle("worktree.list", {})
            self.assertEqual(result, [{"id": "wt-1"}])
            listing.assert_called_once_with(desktop_api.WORKTREES)

        with patch.object(desktop_api.worktree_manager, "diff", return_value={"diff": "x"}) as diff:
            result = desktop_api.handle("worktree.diff", {
                "worktree_id": "wt-1",
                "max_chars": 12345,
            })
            self.assertEqual(result["diff"], "x")
            diff.assert_called_once_with(desktop_api.WORKTREES, "wt-1", 12345)


if __name__ == "__main__":
    unittest.main()
