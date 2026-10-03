import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "bridge"))

import server


class FailoverTests(unittest.TestCase):
    def make_job(self, jobs, job_id, *, state="failed", reason="worker_error",
                 worker="codex1", failover_root=None, failover_job_id=None,
                 auto_failover_enabled=True, failover_complete=False):
        directory = jobs / job_id
        directory.mkdir(parents=True)
        meta = {
            "id": job_id,
            "label": "test task",
            "worker": worker,
            "provider": "codex",
            "state": state,
            "reason": reason,
            "cwd": str(ROOT),
            "write": True,
            "timeout_s": 5400,
            "failover_root": failover_root or job_id,
            "failover_attempt": 0,
            "auto_failover_enabled": auto_failover_enabled,
            "failover_complete": failover_complete,
        }
        if failover_job_id:
            meta["failover_job_id"] = failover_job_id
        (directory / "meta.json").write_text(json.dumps(meta), encoding="utf-8")
        (directory / "task.txt").write_text("Implement the feature.", encoding="utf-8")
        (directory / "DONE").write_text(state, encoding="utf-8")
        return meta

    def test_only_safe_failure_reasons_are_auto_failover_eligible(self):
        for reason in ("usage_or_rate_limit", "worker_error", "runner_crash", "worker_reported_error"):
            self.assertTrue(server.failover_eligible({"state": "failed", "reason": reason}))
        for reason in ("permission_denied", "timeout", "cancelled", None):
            self.assertFalse(server.failover_eligible({"state": "failed", "reason": reason}))
        self.assertFalse(server.failover_eligible({"state": "done", "reason": None}))

    def test_pick_worker_excludes_previous_workers(self):
        registry = {
            "codex1": {"id": "codex1", "provider": "codex", "enabled": True, "priority": 0},
            "codex2": {"id": "codex2", "provider": "codex", "enabled": True, "priority": 10},
            "claude1": {"id": "claude1", "provider": "claude", "enabled": True, "priority": 20},
        }
        with patch.object(server, "worker_registry", return_value=registry),              patch.object(server, "config", return_value={"auto_order": ["codex1", "codex2", "claude1"]}),              patch.object(server, "cooldown_left", return_value=0),              patch.object(server, "running_jobs", return_value=[]),              patch.object(server, "worker_auth_status", return_value=(True, "ready")):
            self.assertEqual(server.pick_worker("auto", exclude={"codex1"}), "codex2")
            self.assertEqual(server.pick_worker("auto", exclude={"codex1", "codex2"}), "claude1")

    def test_failover_task_tells_replacement_to_continue_existing_work(self):
        text = server.failover_task(
            {"worker": "codex1", "reason": "worker_error"},
            "Build the feature.",
        )
        self.assertIn("Inspect git status", text)
        self.assertIn("do not redo finished steps", text)
        self.assertIn("Build the feature.", text)

    def test_failover_chain_follows_child_lineage(self):
        with tempfile.TemporaryDirectory() as td:
            jobs = Path(td)
            self.make_job(jobs, "root", failover_job_id="child", failover_complete=True)
            self.make_job(
                jobs, "child", state="done", reason=None, worker="codex2",
                failover_root="root", auto_failover_enabled=False, failover_complete=True,
            )
            with patch.object(server, "JOBS", jobs):
                chain = server.failover_chain("root")
                self.assertEqual([item["id"] for item in chain], ["root", "child"])
                self.assertEqual(server.failover_terminal_job_id("root"), "child")
                self.assertTrue(server.chain_is_complete("root"))

    def test_start_failover_creates_child_on_new_worker_and_links_parent(self):
        with tempfile.TemporaryDirectory() as td:
            jobs = Path(td)
            self.make_job(jobs, "root")
            with patch.object(server, "JOBS", jobs),                  patch.object(server, "pick_worker", return_value="codex2") as pick,                  patch.object(server, "start_job", return_value=("child", "codex2")) as start:
                info = server.start_failover_from_job(
                    "root",
                    root_job_id="root",
                    attempt=1,
                    max_failovers=2,
                    previous_workers=["codex1"],
                )
                self.assertEqual(info["job_id"], "child")
                self.assertEqual(info["worker"], "codex2")
                pick.assert_called_once_with("auto", exclude=["codex1"])
                args = start.call_args.args
                self.assertEqual(args[0], "codex2")
                self.assertIn("ORIGINAL TASK", args[1])
                self.assertEqual(args[7], "root")
                updated = json.loads((jobs / "root" / "meta.json").read_text(encoding="utf-8"))
                self.assertEqual(updated["failover_job_id"], "child")
                self.assertEqual(updated["failover_worker"], "codex2")


    def test_chain_result_uses_terminal_child_output(self):
        with tempfile.TemporaryDirectory() as td:
            jobs = Path(td)
            self.make_job(jobs, "root", failover_job_id="child", failover_complete=True)
            self.make_job(
                jobs, "child", state="done", reason=None, worker="claude1",
                failover_root="root", auto_failover_enabled=False, failover_complete=True,
            )
            (jobs / "child" / "final.txt").write_text("terminal result", encoding="utf-8")
            with patch.object(server, "JOBS", jobs):
                result = server.job_result("root")
                self.assertEqual(result["requested_job_id"], "root")
                self.assertEqual(result["terminal_job_id"], "child")
                self.assertEqual(result["final_message"], "terminal result")
                self.assertEqual(len(result["failover_chain"]), 2)

    def test_chain_not_complete_until_monitor_marks_root_complete(self):
        with tempfile.TemporaryDirectory() as td:
            jobs = Path(td)
            self.make_job(jobs, "root", failover_job_id="child", failover_complete=False)
            self.make_job(
                jobs, "child", state="done", reason=None, worker="codex2",
                failover_root="root", auto_failover_enabled=False, failover_complete=True,
            )
            with patch.object(server, "JOBS", jobs):
                self.assertFalse(server.chain_is_complete("root"))
                root_meta = json.loads((jobs / "root" / "meta.json").read_text(encoding="utf-8"))
                root_meta["failover_complete"] = True
                (jobs / "root" / "meta.json").write_text(json.dumps(root_meta), encoding="utf-8")
                self.assertTrue(server.chain_is_complete("root"))

    def test_start_task_auto_worker_defaults_to_failover(self):
        with patch.object(server, "start_job", return_value=("job-1", "codex1")) as start,              patch.object(server, "follow_info", return_value={}):
            result = server.tool_call("start_task", {
                "project_path": ".",
                "task": "test",
            })
            self.assertTrue(result["auto_failover"])
            self.assertTrue(start.call_args.kwargs["auto_failover"])

    def test_start_task_explicit_worker_defaults_to_no_failover(self):
        with patch.object(server, "start_job", return_value=("job-1", "codex1")) as start,              patch.object(server, "follow_info", return_value={}):
            result = server.tool_call("start_task", {
                "worker": "codex1",
                "project_path": ".",
                "task": "test",
            })
            self.assertFalse(result["auto_failover"])
            self.assertFalse(start.call_args.kwargs["auto_failover"])


if __name__ == "__main__":
    unittest.main()
