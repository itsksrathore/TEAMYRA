import importlib
import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "bridge"))

import dashboard
import observability
import server


def write_job(root, job_id, *, worker="codex1", provider="codex", state="running", created=0.0,
              done=False, **extra):
    job = Path(root) / "jobs" / job_id
    job.mkdir(parents=True, exist_ok=True)
    meta = {"id": job_id, "worker": worker, "provider": provider, "state": state, "label": f"label {job_id}",
            "cwd": str(root), "created": created}
    meta.update(extra)
    (job / "meta.json").write_text(json.dumps(meta), encoding="utf-8")
    if done:
        (job / "DONE").write_text(state, encoding="utf-8")
    return job


def build_runtime(root):
    now = time.time()
    for index in range(6):
        write_job(root, f"old-{index}", state="failed" if index % 2 else "done", done=True,
                  created=now - 1000 + index, ended=now - 900 + index,
                  reason="worker_error" if index % 2 else None, exit_code=1 if index % 2 else 0,
                  usage={"input_tokens": 10, "output_tokens": 5})
    write_job(root, "current", state="running", created=now - 60, started=now - 50,
              last_event="command: npm test")
    write_job(root, "q2", state="queued", created=now - 20, queue_order=2, queue_position=2, queued_at=now - 20)
    write_job(root, "q1", state="queued", created=now - 10, queue_order=1, queue_position=1, queued_at=now - 10)
    attention = {"kind": "chatgpt_verification", "since": now - 30, "message": "Solve the ChatGPT check"}
    write_job(root, "chat", worker="chatgpt-normal", provider="chatgpt-web", state="needs_user",
              created=now - 40, started=now - 35, attention=attention, reason="chatgpt_verification",
              usage={"chars_sent": 100, "chars_received": 400, "turns": 2})
    write_job(root, "chat-done", worker="chatgpt-normal", provider="chatgpt-web", state="done", done=True,
              created=now - 500, ended=now - 400, exit_code=0,
              usage={"chars_sent": 50, "chars_received": 70, "turns": 1})


WORKER_ROWS = [
    {"worker": "codex1", "provider": "codex", "label": "Codex Default", "model": "gpt-x", "effort": "high",
     "ready": True, "detail": "logged in", "cooldown_seconds": 0, "running_jobs": ["current"]},
    {"worker": "chatgpt-normal", "provider": "chatgpt-web", "label": "ChatGPT Normal", "ready": True,
     "detail": "embedded ChatGPT session ready", "cooldown_seconds": 0, "running_jobs": ["chat"]},
    {"worker": "claude1", "provider": "claude", "label": "Claude Default", "ready": False,
     "detail": "Claude Code CLI not found", "cooldown_seconds": 0, "running_jobs": []},
]


class TeamReportTests(unittest.TestCase):
    def test_report_lists_every_worker_with_current_job_queue_history_and_usage(self):
        with tempfile.TemporaryDirectory() as td:
            build_runtime(td)
            report = observability.team_report(td, WORKER_ROWS)
            workers = {row["worker"]: row for row in report["workers"]}
            self.assertEqual(set(workers), {"codex1", "chatgpt-normal", "claude1"})

            codex = workers["codex1"]
            self.assertEqual((codex["label"], codex["model"], codex["effort"]), ("Codex Default", "gpt-x", "high"))
            self.assertTrue(codex["ready"])
            self.assertEqual(codex["current_job"]["id"], "current")
            self.assertEqual(codex["current_job"]["last_event"], "command: npm test")
            self.assertGreaterEqual(codex["current_job"]["elapsed_s"], 49)
            self.assertEqual([(q["id"], q["position"]) for q in codex["queue"]], [("q1", 1), ("q2", 2)])
            self.assertEqual(len(codex["recent_jobs"]), 5)
            self.assertEqual(codex["recent_jobs"][0]["id"], "old-5")
            self.assertEqual(codex["recent_jobs"][0]["reason"], "worker_error")
            self.assertEqual(codex["recent_jobs"][0]["exit_code"], 1)
            self.assertEqual(codex["usage"]["tokens"]["input_tokens"], 60)

            chat = workers["chatgpt-normal"]
            self.assertEqual(chat["current_job"]["attention"]["kind"], "chatgpt_verification")
            self.assertEqual(chat["usage"]["tokens"], {"chars_sent": 150, "chars_received": 470, "turns": 3})

            claude = workers["claude1"]
            self.assertFalse(claude["ready"])
            self.assertIn("not found", claude["detail"])
            self.assertIsNone(claude["current_job"])
            self.assertEqual(claude["queue"], [])

            self.assertEqual([item["id"] for item in report["needs_user"]], ["chat"])
            self.assertEqual(report["needs_user"][0]["attention"]["message"], "Solve the ChatGPT check")
            self.assertEqual(report["totals"], {"workers": 3, "ready": 2, "busy": 2, "queued": 2, "needs_user": 1})
            providers = {row["provider"]: row for row in report["usage_totals"]}
            self.assertEqual(providers["chatgpt-web"]["tokens"]["turns"], 3)

    def test_recent_is_bounded_and_unknown_workers_with_open_jobs_appear(self):
        with tempfile.TemporaryDirectory() as td:
            build_runtime(td)
            write_job(td, "ghost", worker="removed-worker", state="queued", created=time.time())
            report = observability.team_report(td, WORKER_ROWS[:1], recent=2)
            workers = {row["worker"]: row for row in report["workers"]}
            self.assertEqual(len(workers["codex1"]["recent_jobs"]), 2)
            self.assertIn("removed-worker", workers)
            self.assertIn("chatgpt-normal", workers)  # it has an open (needs_user) job

    def test_team_report_tool_uses_live_worker_status(self):
        with tempfile.TemporaryDirectory() as td:
            build_runtime(td)
            with patch.object(server, "JOBS", Path(td) / "jobs"), \
                 patch.object(server, "worker_status", return_value=WORKER_ROWS) as status:
                report = server.tool_call("team_report", {"recent": 3})
            status.assert_called_once_with()
            self.assertEqual(len(report["workers"]), 3)
            self.assertEqual(len(report["workers"][0]["recent_jobs"]), 3)

    def test_timeline_includes_queue_and_attention_events(self):
        with tempfile.TemporaryDirectory() as td:
            now = time.time()
            write_job(td, "j", created=now - 100, queued_at=now - 100, dispatched_at=now - 50, queue_wait_s=50,
                      started=now - 49,
                      attention={"kind": "chatgpt_verification", "since": now - 10, "message": "verify"})
            kinds = [item["kind"] for item in observability.timeline(td, sources=["job"])["items"]]
            for kind in ("job.queued", "job.dispatched", "job.started", "job.needs_user"):
                self.assertIn(kind, kinds)

    def test_usage_snapshot_counts_queued_and_desktop_states(self):
        with tempfile.TemporaryDirectory() as td:
            write_job(td, "a", state="queued")
            write_job(td, "b", state="waiting_for_desktop", worker="chatgpt-normal", provider="chatgpt-web")
            rows = {row["worker"]: row for row in observability.usage_snapshot(td)["workers"]}
            self.assertEqual(rows["codex1"]["queued"], 1)
            self.assertEqual(rows["chatgpt-normal"]["running"], 1)


class DashboardTests(unittest.TestCase):
    def test_dashboard_respects_teamyra_root(self):
        with tempfile.TemporaryDirectory() as td:
            with patch.dict(os.environ, {"TEAMYRA_ROOT": td}):
                module = importlib.reload(dashboard)
                self.assertEqual(module.JOBS, Path(td).resolve() / "jobs")
            importlib.reload(dashboard)
        default = Path(os.environ.get("TEAMYRA_ROOT") or Path(dashboard.__file__).resolve().parent.parent)
        self.assertEqual(dashboard.JOBS, default.resolve() / "jobs")

    def test_dashboard_shows_queue_attention_and_current_job(self):
        with tempfile.TemporaryDirectory() as td:
            build_runtime(td)
            with patch.object(dashboard, "JOBS", Path(td) / "jobs"):
                jobs = {row["id"]: row for row in dashboard.list_jobs()}
                workers = {row["worker"]: row for row in dashboard.list_workers()}
            self.assertEqual(jobs["q1"]["queue_position"], 1)
            self.assertEqual(jobs["chat"]["attention"]["kind"], "chatgpt_verification")
            self.assertIn("exit_code", jobs["old-1"])
            self.assertEqual(workers["codex1"]["current"]["id"], "current")
            self.assertEqual([item["id"] for item in workers["codex1"]["queued"]], ["q1", "q2"])
            self.assertEqual(workers["chatgpt-normal"]["current"]["state"], "needs_user")
            self.assertIn("/api/workers", dashboard.PAGE)
            self.assertIn("needs you", dashboard.PAGE)


if __name__ == "__main__":
    unittest.main()
