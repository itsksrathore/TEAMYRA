import json
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "bridge"))

import recovery
import server


class FakeProc:
    def __init__(self, pid=43210):
        self.pid = pid


class RecoveryTests(unittest.TestCase):
    def write_json(self, path, payload):
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    def make_job(self, root, *, session_id="sess-1"):
        root = Path(root)
        job = root / "jobs" / "job-1"
        job.mkdir(parents=True)
        self.write_json(job / "meta.json", {
            "id": "job-1",
            "state": "running",
            "cwd": str(root),
            "worker": "codex1",
            "provider": "codex",
            "session_id": session_id,
            "runner_pid": 111,
            "worker_pid": 222,
            "heartbeat_at": time.time(),
            "started": 1000,
        })
        self.write_json(job / "spec.json", {
            "worker": "codex1",
            "provider": "codex",
            "cmd": ["codex", "exec", "original"],
            "cwd": str(root),
            "env": {},
            "timeout": 3600,
            "resume_cmd": ["codex", "exec", "resume", "{SESSION}", "continue"],
            "auto_resume": 2,
        })
        (job / "transcript.md").write_text("existing transcript\n", encoding="utf-8")
        return job

    def test_orphan_job_resumes_same_job_when_session_exists(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            job = self.make_job(root)
            with patch.object(recovery, "process_alive", return_value=False),                  patch.object(recovery, "_spawn_detached", return_value=FakeProc(9876)) as spawn:
                result = recovery.recover_job(root, ROOT / "bridge", sys.executable, job)

            self.assertEqual(result["action"], "resumed")
            self.assertEqual(result["id"], "job-1")
            self.assertEqual(result["runner_pid"], 9876)
            meta = json.loads((job / "meta.json").read_text(encoding="utf-8"))
            spec = json.loads((job / "spec.json").read_text(encoding="utf-8"))
            self.assertEqual(meta["state"], "starting")
            self.assertEqual(meta["recovery_count"], 1)
            self.assertEqual(meta["runner_pid"], 9876)
            self.assertEqual(spec["cmd"], ["codex", "exec", "resume", "sess-1", "continue"])
            spawn.assert_called_once()

    def test_orphan_job_without_session_is_not_blindly_rerun(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            job = self.make_job(root, session_id=None)
            with patch.object(recovery, "process_alive", return_value=False),                  patch.object(recovery, "_spawn_detached") as spawn:
                result = recovery.recover_job(root, ROOT / "bridge", sys.executable, job)

            self.assertEqual(result["action"], "manual_retry_required")
            meta = json.loads((job / "meta.json").read_text(encoding="utf-8"))
            self.assertEqual(meta["state"], "failed")
            self.assertEqual(meta["reason"], "crash_recovery_session_missing")
            self.assertEqual((job / "DONE").read_text(encoding="utf-8"), "failed")
            spawn.assert_not_called()

    def test_alive_job_is_not_duplicated(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            job = self.make_job(root)
            with patch.object(recovery, "process_alive", side_effect=lambda pid: pid == 111),                  patch.object(recovery, "_spawn_detached") as spawn:
                result = recovery.recover_job(root, ROOT / "bridge", sys.executable, job)
            self.assertEqual(result["action"], "alive")
            spawn.assert_not_called()


    def test_stale_heartbeat_does_not_trust_reused_pid(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            job = self.make_job(root, session_id=None)
            meta_path = job / "meta.json"
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
            meta["heartbeat_at"] = time.time() - 600
            meta_path.write_text(json.dumps(meta), encoding="utf-8")
            with patch.object(recovery, "process_alive", return_value=True), \
                 patch.object(recovery, "_spawn_detached") as spawn:
                result = recovery.recover_job(root, ROOT / "bridge", sys.executable, job)
            self.assertEqual(result["action"], "stale_pid_unverified")
            self.assertTrue(result["requires_manual_check"])
            spawn.assert_not_called()

    def test_dead_graph_monitor_restarts(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            graph_path = root / "tasks" / "graph-x.json"
            self.write_json(graph_path, {
                "id": "graph-x",
                "state": "running",
                "project_path": str(root),
                "nodes": [],
                "conductor_pid": 123,
            })
            with patch.object(recovery, "process_alive", return_value=False),                  patch.object(recovery, "_spawn_detached", return_value=FakeProc(9999)):
                result = recovery.recover_graph(root, ROOT / "bridge", sys.executable, graph_path)
            self.assertEqual(result["action"], "monitor_restarted")
            graph = json.loads(graph_path.read_text(encoding="utf-8"))
            self.assertEqual(graph["conductor_pid"], 9999)
            self.assertEqual(graph["recovery_count"], 1)

    def test_dead_review_monitor_is_preserved_not_duplicated(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            review_path = root / "tasks" / "reviews" / "review-x.json"
            self.write_json(review_path, {
                "id": "review-x",
                "state": "running",
                "active_job_id": "job-review",
                "monitor_pid": 123,
            })
            with patch.object(recovery, "process_alive", return_value=False):
                result = recovery.recover_review(root, review_path)
            self.assertEqual(result["action"], "manual_resume_required")
            state = json.loads(review_path.read_text(encoding="utf-8"))
            self.assertEqual(state["state"], "interrupted")
            self.assertIsNone(state["monitor_pid"])
            self.assertEqual(state["active_job_id"], "job-review")

    def test_server_recovery_tool_is_namespaced_and_delegates(self):
        names = {tool["name"] for tool in server.mcp_tools(include_legacy=False)}
        self.assertIn("teamyra.recovery_scan", names)
        with patch.object(server.recovery, "recover_all", return_value={"ok": True}) as recover_all:
            result = server.tool_call("recovery_scan", {})
        self.assertEqual(result, {"ok": True})
        recover_all.assert_called_once_with(server.ROOT, server.BRIDGE, server.PYTHON)


if __name__ == "__main__":
    unittest.main()
