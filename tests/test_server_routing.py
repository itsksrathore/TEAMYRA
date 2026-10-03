import unittest
from unittest.mock import patch
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "bridge"))

import server


class RoutingTests(unittest.TestCase):
    def test_auto_excludes_disabled_and_uses_priority(self):
        registry = {
            "disabled": {"id": "disabled", "provider": "codex", "enabled": False, "priority": 0},
            "later": {"id": "later", "provider": "codex", "enabled": True, "priority": 50},
            "first": {"id": "first", "provider": "codex", "enabled": True, "priority": 10},
        }
        with patch.object(server, "worker_registry", return_value=registry),              patch.object(server, "config", return_value={"auto_order": []}),              patch.object(server, "cooldown_left", return_value=0),              patch.object(server, "running_jobs", return_value=[]),              patch.object(server, "worker_auth_status", return_value=(True, "ready")):
            self.assertEqual(server.pick_worker("auto"), "first")

    def test_explicit_worker_selection_is_not_blocked_by_auto_enabled_flag(self):
        registry = {
            "disabled": {"id": "disabled", "provider": "codex", "enabled": False, "priority": 0},
        }
        with patch.object(server, "worker_registry", return_value=registry):
            self.assertEqual(server.pick_worker("disabled"), "disabled")


    def test_job_handoff_auto_excludes_source_worker(self):
        source_meta = {
            "id": "source-terminal",
            "worker": "codex1",
            "cwd": ".",
            "label": "source",
            "state": "done",
        }
        with patch.object(server, "failover_terminal_job_id", return_value="source-terminal"), \
             patch.object(server, "read_meta", return_value=source_meta), \
             patch.object(server, "chain_is_complete", return_value=True), \
             patch.object(server, "pick_worker", return_value="claude1") as pick, \
             patch.object(server, "handoff_task", return_value="handoff prompt"), \
             patch.object(server, "start_job", return_value=("handoff-job", "claude1")) as start, \
             patch.object(server, "patch_job_meta") as patch_meta, \
             patch.object(server, "follow_info", return_value={}):
            result = server.tool_call("job_handoff", {
                "job_id": "source-root",
                "message": "Review the implementation",
            })
            self.assertEqual(result["worker"], "claude1")
            pick.assert_called_once_with("auto", exclude=["codex1"])
            self.assertEqual(start.call_args.kwargs["parent"], "source-terminal")
            self.assertTrue(start.call_args.kwargs["auto_failover"])
            patch_meta.assert_called_once()
            self.assertEqual(
                patch_meta.call_args.kwargs["handoff_from_worker"],
                "codex1",
            )

    def test_handoff_prompt_contains_compact_source_context(self):
        with patch.object(server, "failover_terminal_job_id", return_value="terminal"), \
             patch.object(server, "read_meta", return_value={"worker": "codex1", "state": "done"}), \
             patch.object(server, "job_result", return_value={
                 "final_message": "Implemented feature",
                 "git_status": [" M app.py"],
                 "diffstat": "1 file changed",
             }):
            prompt = server.handoff_task("root", "Please review")
            self.assertIn("Implemented feature", prompt)
            self.assertIn("Please review", prompt)
            self.assertIn("Inspect the actual workspace", prompt)


if __name__ == "__main__":
    unittest.main()
