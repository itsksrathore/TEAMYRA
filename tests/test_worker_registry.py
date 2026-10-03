import json
import tempfile
import unittest
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "bridge"))

from worker_registry import build_worker_registry, safe_worker_part


class WorkerRegistryTests(unittest.TestCase):
    def test_default_workers_are_always_present(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            workers = build_worker_registry(root, home=root / "home")
            self.assertIn("antigravity", workers)
            self.assertIn("codex1", workers)
            self.assertIn("chatgpt-normal", workers)
            self.assertEqual(workers["codex1"]["provider"], "codex")
            self.assertEqual(workers["chatgpt-normal"]["provider"], "chatgpt-web")
            self.assertEqual(workers["chatgpt-normal"]["execution"], "desktop-web")

    def test_legacy_codex2_is_discovered(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            (root / "profiles" / "codex2").mkdir(parents=True)
            workers = build_worker_registry(root, home=root / "home")
            self.assertIn("codex2", workers)
            self.assertTrue(workers["codex2"]["legacy"])

    def test_legacy_codex2_metadata_controls_routing(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            profile = root / "profiles" / "codex2"
            profile.mkdir(parents=True)
            (profile / "teamyra-profile.json").write_text(
                json.dumps({
                    "name": "Codex Backup",
                    "enabled": False,
                    "priority": 7,
                    "model": "gpt-test",
                    "effort": "medium",
                }),
                encoding="utf-8",
            )
            item = build_worker_registry(root, home=root / "home")["codex2"]
            self.assertEqual(item["label"], "Codex Backup")
            self.assertFalse(item["enabled"])
            self.assertEqual(item["priority"], 7)
            self.assertEqual(item["settings"]["model"], "gpt-test")
            self.assertEqual(item["settings"]["effort"], "medium")

    def test_managed_codex_profiles_are_discovered_with_label(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            profile = root / "profiles" / "codex" / "client-one-ab12"
            profile.mkdir(parents=True)
            (profile / "teamyra-profile.json").write_text(
                json.dumps({"name": "Client One"}), encoding="utf-8"
            )
            workers = build_worker_registry(root, home=root / "home")
            self.assertIn("codex-client-one-ab12", workers)
            item = workers["codex-client-one-ab12"]
            self.assertEqual(item["label"], "Client One")
            self.assertEqual(item["profile_id"], "client-one-ab12")

    def test_managed_claude_profiles_are_discovered(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            profile = root / "profiles" / "claude" / "work-aa11"
            profile.mkdir(parents=True)
            (profile / "teamyra-profile.json").write_text(
                json.dumps({"name": "Claude Work"}), encoding="utf-8"
            )
            workers = build_worker_registry(root, home=root / "home")
            self.assertIn("claude1", workers)
            self.assertIn("claude-work-aa11", workers)
            item = workers["claude-work-aa11"]
            self.assertEqual(item["provider"], "claude")
            self.assertEqual(item["label"], "Claude Work")

    def test_worker_parts_are_path_safe(self):
        self.assertEqual(safe_worker_part("My Account / #2"), "My-Account-2")


if __name__ == "__main__":
    unittest.main()
