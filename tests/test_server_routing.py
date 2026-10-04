import json
import tempfile
import time
import unittest
from unittest.mock import patch
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "bridge"))

import server


class RoutingTests(unittest.TestCase):

    def test_chatgpt_worker_readiness_uses_fresh_desktop_heartbeat(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            status_dir = root / "chatgpt"
            status_dir.mkdir()
            (status_dir / "status.json").write_text(json.dumps({
                "heartbeat_at": time.time(),
                "automation_ready": True,
                "worker_ready": True,
                "workspace": str(root / "project"),
                "detail": "embedded ChatGPT session is active",
            }), encoding="utf-8")
            info = {"id": "chatgpt-normal", "provider": "chatgpt-web"}
            server.AUTH_CACHE.clear()
            with patch.object(server, "ROOT", root):
                ready, detail = server.worker_auth_status(info, use_cache=False)
            self.assertTrue(ready)
            self.assertIn("ChatGPT", detail)

    def test_explicit_chatgpt_worker_uses_task_project_as_assigned_workspace(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            jobs = root / "jobs"
            project = root / "project"
            other = root / "other"
            jobs.mkdir()
            project.mkdir()
            other.mkdir()
            registry = {
                "chatgpt-normal": {
                    "id": "chatgpt-normal",
                    "provider": "chatgpt-web",
                    "label": "ChatGPT Normal",
                    "profile_id": "web",
                    "native": True,
                    "enabled": True,
                }
            }
            with patch.object(server, "ROOT", root), \
                 patch.object(server, "JOBS", jobs), \
                 patch.object(server, "worker_registry", return_value=registry), \
                 patch.object(server, "worker_auth_status", return_value=(True, "ready")), \
                 patch.object(server, "worker_settings", return_value={}), \
                 patch.object(server, "cooldown_left", return_value=0), \
                 patch.object(server, "git", return_value="head"), \
                 patch.object(server, "config", return_value={"auto_resume": 2, "max_failovers": 2}):
                job_id, worker = server.start_job("chatgpt-normal", "Inspect", project, auto_failover=False)
            self.assertEqual(worker, "chatgpt-normal")
            spec = json.loads((jobs / job_id / "spec.json").read_text(encoding="utf-8"))
            self.assertEqual(Path(spec["cwd"]), project.resolve())

    def test_auto_routing_can_pick_chatgpt_for_any_assigned_project(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            jobs = root / "jobs"
            project = root / "project"
            jobs.mkdir()
            project.mkdir()
            registry = {
                "chatgpt-normal": {"id": "chatgpt-normal", "provider": "chatgpt-web", "enabled": True, "priority": 1, "profile_id": "web"},
                "codex1": {"id": "codex1", "provider": "codex", "enabled": True, "priority": 2, "home": str(root / "codex")},
            }
            with patch.object(server, "ROOT", root), \
                 patch.object(server, "JOBS", jobs), \
                 patch.object(server, "worker_registry", return_value=registry), \
                 patch.object(server, "worker_auth_status", return_value=(True, "ready")), \
                 patch.object(server, "worker_settings", return_value={}), \
                 patch.object(server, "cooldown_left", return_value=0), \
                 patch.object(server, "running_jobs", return_value=[]), \
                 patch.object(server, "config", return_value={"auto_order": [], "auto_resume": 2, "max_failovers": 2}), \
                 patch.object(server, "git", return_value="head"), \
                 patch.object(server.subprocess, "Popen") as popen:
                job_id, worker = server.start_job("auto", "Inspect", project, auto_failover=False)
            self.assertEqual(worker, "chatgpt-normal")
            meta = json.loads((jobs / job_id / "meta.json").read_text(encoding="utf-8"))
            self.assertEqual(meta["state"], "waiting_for_desktop")
            popen.assert_not_called()

    def test_chatgpt_job_queues_for_desktop_instead_of_spawning_cli_runner(self):
        with tempfile.TemporaryDirectory() as td:
            jobs = Path(td) / "jobs"
            jobs.mkdir()
            project = Path(td) / "project"
            project.mkdir()
            registry = {
                "chatgpt-normal": {
                    "id": "chatgpt-normal",
                    "provider": "chatgpt-web",
                    "label": "ChatGPT Normal",
                    "profile_id": "web",
                    "native": True,
                    "enabled": True,
                }
            }
            with patch.object(server, "JOBS", jobs), \
                 patch.object(server, "worker_registry", return_value=registry), \
                 patch.object(server, "worker_auth_status", return_value=(True, "ready")), \
                 patch.object(server, "worker_settings", return_value={}), \
                 patch.object(server, "cooldown_left", return_value=0), \
                 patch.object(server, "git", return_value="head"), \
                 patch.object(server, "config", return_value={"auto_resume": 2, "max_failovers": 2}), \
                 patch.object(server.subprocess, "Popen") as popen:
                job_id, worker = server.start_job(
                    "chatgpt-normal", "Inspect the project", project, auto_failover=False
                )
            self.assertEqual(worker, "chatgpt-normal")
            meta = json.loads((jobs / job_id / "meta.json").read_text(encoding="utf-8"))
            spec = json.loads((jobs / job_id / "spec.json").read_text(encoding="utf-8"))
            self.assertEqual(meta["state"], "waiting_for_desktop")
            self.assertEqual(meta["provider"], "chatgpt-web")
            self.assertEqual(spec["cmd"], [])
            popen.assert_not_called()

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
        record = {
            "id": "handoff-test",
            "label": "handoff from source",
            "message": "Review the implementation",
        }
        with patch.object(server, "failover_terminal_job_id", return_value="source-terminal"), \
             patch.object(server, "read_meta", return_value=source_meta), \
             patch.object(server, "chain_is_complete", return_value=True), \
             patch.object(server, "pick_worker", return_value="claude1") as pick, \
             patch.object(server, "prepare_handoff_record", return_value=(record, source_meta, "source-terminal")), \
             patch.object(server, "handoff_task", return_value="handoff prompt"), \
             patch.object(server, "start_job", return_value=("handoff-job", "claude1")) as start, \
             patch.object(server.handoff_store, "attach_target_job", return_value={**record, "target_job_id": "handoff-job", "target_worker": "claude1"}), \
             patch.object(server.handoff_store, "summary", return_value={"id": "handoff-test"}), \
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
