"""Muse (muse.ai) runs as a TEAMYRA Desktop web-chat worker like ChatGPT Normal.

The core must route, wake and keep alive Muse jobs exactly as it does ChatGPT
jobs, reading Muse's own readiness file (ROOT/muse/status.json).
"""
import json
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "bridge"))

import runner
import scheduler
import server
import wake_gateway
from worker_registry import build_worker_registry


def write_status(root, folder, **profile):
    path = Path(root) / folder / "status.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"heartbeat_at": time.time(), "active_profile_id": "web",
                                "profiles": {"web": profile}}), encoding="utf-8")


def write_job(root, job_id, *, state, provider="muse-web", worker="muse-normal", **extra):
    job = Path(root) / "jobs" / job_id
    job.mkdir(parents=True, exist_ok=True)
    meta = {"id": job_id, "worker": worker, "provider": provider, "profile_id": "web", "state": state,
            "created": time.time(), "updated": time.time(), "timeout_s": 600, "cwd": str(root), **extra}
    (job / "meta.json").write_text(json.dumps(meta), encoding="utf-8")
    (job / "spec.json").write_text(json.dumps({"worker": worker, "provider": provider, "cmd": []}), encoding="utf-8")
    return job


class MuseWorkerTests(unittest.TestCase):
    def test_registry_has_muse_workers(self):
        with tempfile.TemporaryDirectory() as td:
            account = Path(td) / "profiles" / "muse-web" / "team-1a2b"
            account.mkdir(parents=True)
            (account / "teamyra-profile.json").write_text(json.dumps({"name": "Muse Team", "provider": "muse-web"}),
                                                          encoding="utf-8")
            registry = build_worker_registry(td, home=td)
            self.assertEqual(registry["muse-normal"]["provider"], "muse-web")
            self.assertEqual(registry["muse-normal"]["execution"], "desktop-web")
            self.assertEqual(registry["muse-team-1a2b"]["provider"], "muse-web")
            self.assertEqual(registry["muse-team-1a2b"]["label"], "Muse Team")
            self.assertEqual(registry["chatgpt-normal"]["provider"], "chatgpt-web")

    def test_readiness_comes_from_muses_own_status_file(self):
        with tempfile.TemporaryDirectory() as td:
            info = {"id": "muse-normal", "provider": "muse-web", "profile_id": "web"}
            # A ready ChatGPT does not make Muse ready.
            write_status(td, "chatgpt", automation_ready=True)
            self.assertFalse(scheduler.chatgpt_ready(td, info))
            write_status(td, "muse", automation_ready=True)
            self.assertTrue(scheduler.chatgpt_ready(td, info))
            with patch.object(server, "ROOT", Path(td)):
                ready, detail = server.worker_auth_status(info, use_cache=False)
            self.assertTrue(ready)
            self.assertIn("Muse", detail)

    def test_signed_in_accounts_stay_ready_while_the_desktop_is_closed(self):
        # After an idle exit every web worker said "worker is closed" and was
        # not ready, so callers that check worker_status gave it no jobs, though
        # start_task starts the desktop.
        with tempfile.TemporaryDirectory() as td:
            for folder, provider, worker in (("chatgpt", "chatgpt-web", "chatgpt-normal"), ("muse", "muse-web", "muse-normal")):
                path = Path(td) / folder / "status.json"
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(json.dumps({"heartbeat_at": time.time() - 600, "active_profile_id": "web", "detail": "closed",
                                            "profiles": {"web": {"session_present": True, "automation_ready": False},
                                                         "other": {"session_present": False}}}), encoding="utf-8")
                with patch.object(server, "ROOT", Path(td)):
                    ready, detail = server.worker_auth_status({"id": worker, "provider": provider, "profile_id": "web"}, use_cache=False)
                    self.assertTrue(ready, detail)
                    self.assertIn("starts the", detail)
                    signed_out, _ = server.worker_auth_status({"id": worker + "-x", "provider": provider, "profile_id": "other"},
                                                              use_cache=False)
                    self.assertFalse(signed_out, "a signed-out account is never reported ready")

    def test_muse_jobs_wake_the_desktop_and_keep_the_core_alive(self):
        with tempfile.TemporaryDirectory() as td:
            old = time.time() - 6 * 3600
            write_job(td, "waiting", state="waiting_for_desktop", updated=old, created=old)
            ids = {m["id"] for m in scheduler.chatgpt_jobs_needing_desktop(scheduler.load_jobs(td))}
            self.assertEqual(ids, {"waiting"})
            self.assertTrue(wake_gateway.active_jobs(td, max_age=60))

    def test_runner_hands_desktop_jobs_to_the_desktop(self):
        # An older core process dispatched a Muse job to a CLI runner, which
        # crashed with WinError 87 on the empty command (1106-105430).
        with tempfile.TemporaryDirectory() as td:
            job = write_job(td, "dispatched", state="starting")
            (job / "transcript.md").write_text("", encoding="utf-8")
            runner.Job(str(job)).run()
            meta = json.loads((job / "meta.json").read_text(encoding="utf-8"))
            self.assertEqual(meta["state"], "waiting_for_desktop")
            self.assertEqual(meta["last_event"], "queued for embedded Muse")
            self.assertFalse((job / "DONE").exists())


if __name__ == "__main__":
    unittest.main()
