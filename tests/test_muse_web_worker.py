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

    def test_muse_jobs_wake_the_desktop_and_keep_the_core_alive(self):
        with tempfile.TemporaryDirectory() as td:
            old = time.time() - 6 * 3600
            write_job(td, "waiting", state="waiting_for_desktop", updated=old, created=old)
            ids = {m["id"] for m in scheduler.chatgpt_jobs_needing_desktop(scheduler.load_jobs(td))}
            self.assertEqual(ids, {"waiting"})
            self.assertTrue(wake_gateway.active_jobs(td, max_age=60))


if __name__ == "__main__":
    unittest.main()
