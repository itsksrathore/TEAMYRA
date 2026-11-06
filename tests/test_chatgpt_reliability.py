"""Regression tests for the bridge side of ChatGPT worker reliability.

Each test names the job records that showed the failure (jobs/<id>/meta.json).
"""
import json
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "bridge"))

import scheduler
import server
import wake_gateway


def write_job(root, job_id, *, state, provider="chatgpt-web", worker="chatgpt-normal", done=False, **extra):
    job = Path(root) / "jobs" / job_id
    job.mkdir(parents=True, exist_ok=True)
    meta = {"id": job_id, "worker": worker, "provider": provider, "profile_id": "web", "state": state,
            "created": time.time(), "updated": time.time(), "timeout_s": 600, "cwd": str(root)}
    meta.update(extra)
    (job / "meta.json").write_text(json.dumps(meta), encoding="utf-8")
    (job / "spec.json").write_text(json.dumps({"worker": worker, "provider": provider, "cmd": [], "cwd": str(root)}),
                                   encoding="utf-8")
    if done:
        (job / "DONE").write_text(state, encoding="utf-8")
    return job


def read_meta(root, job_id):
    return json.loads((Path(root) / "jobs" / job_id / "meta.json").read_text(encoding="utf-8"))


class DesktopWakeTests(unittest.TestCase):
    """Jobs 1008-130743-...-0318 / 1027-191533-...-e9f9 sat for 7-13 hours: the
    desktop had idle-exited and nothing restarted it for ChatGPT jobs."""

    def test_jobs_needing_desktop(self):
        with tempfile.TemporaryDirectory() as td:
            write_job(td, "queued", state="queued")
            write_job(td, "waiting", state="waiting_for_desktop")
            write_job(td, "user", state="needs_user")
            write_job(td, "finished", state="running", done=True)
            write_job(td, "codex", state="queued", provider="codex", worker="codex1")
            ids = {m["id"] for m in scheduler.chatgpt_jobs_needing_desktop(scheduler.load_jobs(td))}
            self.assertEqual(ids, {"queued", "waiting", "user"})

    def test_watch_wakes_desktop_only_when_down_and_needed(self):
        with tempfile.TemporaryDirectory() as td:
            woke = []
            wake = lambda root: woke.append(root) or True
            # Nothing pending: never wakes.
            report = server.chatgpt_desktop_watch(td, wake=wake, desktop_ready=lambda root: False)
            self.assertFalse(report["woke"])
            write_job(td, "queued", state="queued", queued_at=time.time() - 4 * 3600)
            # Desktop is up: nothing to do.
            report = server.chatgpt_desktop_watch(td, wake=wake, desktop_ready=lambda root: True)
            self.assertFalse(report["woke"])
            # Desktop is down with a queued ChatGPT job hours old: wake it.
            report = server.chatgpt_desktop_watch(td, wake=wake, desktop_ready=lambda root: False)
            self.assertTrue(report["woke"])
            self.assertEqual(len(woke), 1)

    def test_watch_expires_waiting_job_past_deadline_while_desktop_is_down(self):
        with tempfile.TemporaryDirectory() as td:
            write_job(td, "late", state="waiting_for_desktop", dispatched_at=time.time() - 7200, timeout_s=3600)
            write_job(td, "fresh", state="waiting_for_desktop", dispatched_at=time.time(), timeout_s=3600)
            woke = []
            report = server.chatgpt_desktop_watch(td, wake=lambda root: woke.append(1) or True,
                                                  desktop_ready=lambda root: False)
            self.assertEqual(report["expired"], ["late"])
            late = read_meta(td, "late")
            self.assertEqual((late["state"], late["reason"]), ("failed", "timeout"))
            self.assertTrue((Path(td) / "jobs" / "late" / "DONE").exists())
            self.assertEqual(read_meta(td, "fresh")["state"], "waiting_for_desktop")
            self.assertEqual(woke, [1], "the remaining job still needs the desktop")

    def test_wake_is_rate_limited(self):
        calls = []
        started = threading.Event()

        def fake_ready(root):
            calls.append(root)
            started.set()

        with patch.object(server.desktop_runtime, "ensure_desktop_ready", fake_ready), \
                patch.dict(server._DESKTOP_WAKE, {"at": 0.0, "running": False}):
            self.assertTrue(server._wake_desktop_async("root"))
            started.wait(2)
            deadline = time.time() + 2
            while server._DESKTOP_WAKE["running"] and time.time() < deadline:
                time.sleep(0.01)
            self.assertFalse(server._wake_desktop_async("root"))
        self.assertEqual(calls, ["root"])

    def test_dispatcher_tick_hook_runs_and_survives_errors(self):
        with tempfile.TemporaryDirectory() as td:
            (Path(td) / "jobs").mkdir()
            ticks = []

            def tick(root):
                ticks.append(root)
                raise RuntimeError("boom")

            self.assertTrue(scheduler.start_background_dispatcher(td, spawn=lambda *a: 1, is_ready=lambda w: True,
                                                                  interval=0.5, on_tick=tick))
            try:
                deadline = time.time() + 5
                while len(ticks) < 2 and time.time() < deadline:
                    time.sleep(0.05)
                self.assertGreaterEqual(len(ticks), 2, "an on_tick error must not stop the loop")
            finally:
                scheduler.stop_background_dispatcher(td)
                time.sleep(0.6)

    def test_start_job_wakes_desktop_instead_of_refusing(self):
        info = {"id": "chatgpt-normal", "provider": "chatgpt-web", "profile_id": "web"}
        answers = iter([(False, "stale heartbeat"), (True, "embedded ChatGPT session ready")])
        with patch.object(server.desktop_runtime, "ensure_desktop_ready", return_value={"state": "ready"}) as ensure, \
                patch.object(server, "worker_auth_status", side_effect=lambda *a, **k: next(answers)):
            ready, detail = server.wake_chatgpt_worker(info, heartbeat_wait=5)
        self.assertTrue(ready)
        ensure.assert_called_once()

    def test_start_job_wake_failure_is_reported(self):
        info = {"id": "chatgpt-normal", "provider": "chatgpt-web", "profile_id": "web"}
        with patch.object(server.desktop_runtime, "ensure_desktop_ready", side_effect=TimeoutError("no start")):
            ready, detail = server.wake_chatgpt_worker(info, heartbeat_wait=0)
        self.assertFalse(ready)
        self.assertIn("could not be started", detail)


class GatewayKeepAliveTests(unittest.TestCase):
    def test_unfinished_chatgpt_job_keeps_core_alive_however_old(self):
        with tempfile.TemporaryDirectory() as td:
            old = time.time() - 6 * 3600
            write_job(td, "waiting", state="waiting_for_desktop", updated=old, created=old)
            self.assertTrue(wake_gateway.active_jobs(td, max_age=60))
            (Path(td) / "jobs" / "waiting" / "DONE").write_text("failed", encoding="utf-8")
            self.assertFalse(wake_gateway.active_jobs(td, max_age=60))
            # Other providers keep the age rule.
            write_job(td, "codex", state="running", provider="codex", worker="codex1", updated=old, created=old)
            self.assertFalse(wake_gateway.active_jobs(td, max_age=60))


class FullReportTests(unittest.TestCase):
    """job_result clipped every report at 6000 characters without saying so."""

    def test_long_report_is_flagged_and_can_be_read_in_full(self):
        with tempfile.TemporaryDirectory() as td:
            jobs = Path(td) / "jobs"
            write_job(td, "j1", state="done", done=True)
            report = "line of the final report\n" * 1000
            (jobs / "j1" / "final.txt").write_text(report, encoding="utf-8")
            with patch.object(server, "JOBS", jobs):
                short = server.job_result("j1")
                full = server.job_result("j1", max_chars=200000)
            self.assertTrue(short["final_message_truncated"])
            self.assertEqual(short["final_message_chars"], len(report))
            self.assertTrue(short["final_path"].endswith("final.txt"))
            self.assertFalse(full["final_message_truncated"])
            self.assertEqual(full["final_message"], report.strip())

    def test_tool_schema_accepts_max_chars(self):
        tool = next(t for t in server.TOOLS if t["name"] == "job_result")
        self.assertIn("max_chars", tool["inputSchema"]["properties"])


if __name__ == "__main__":
    unittest.main()
