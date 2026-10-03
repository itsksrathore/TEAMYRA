import subprocess
import tempfile
import unittest
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "bridge"))

import worktree_manager


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


if __name__ == "__main__":
    unittest.main()
