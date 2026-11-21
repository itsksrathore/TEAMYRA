"""Gemini (gemini.google.com) runs as a TEAMYRA Desktop web-chat worker in the
Google Media accounts: one worker per Google Media account, in that account's
browser profile, with its readiness in ROOT/gemini/status.json.
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

import job_transfer
import scheduler
import server
from web_sites import WEB_SITES, site_name
from worker_registry import build_worker_registry


def media_account(root, folder, **meta):
    path = Path(root) / "profiles" / "google-media" / folder
    path.mkdir(parents=True, exist_ok=True)
    (path / "teamyra-profile.json").write_text(json.dumps({"provider": "google-media", **meta}), encoding="utf-8")
    return path


def write_status(root, profiles):
    path = Path(root) / "gemini" / "status.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"heartbeat_at": time.time(), "active_profile_id": "web", "profiles": profiles}),
                    encoding="utf-8")


class GeminiWorkerTests(unittest.TestCase):
    def test_site_table(self):
        site = WEB_SITES["gemini-web"]
        self.assertEqual(site["folder"], "gemini")
        self.assertEqual(site["builtin"], "gemini-normal")
        self.assertEqual(site["accounts_from"], "google-media")
        self.assertEqual(site_name("gemini-web"), "Gemini")
        self.assertEqual(scheduler.WEB_STATUS_DIRS["gemini-web"], "gemini")
        self.assertIn("gemini-web", scheduler.DESKTOP_PROVIDERS)
        self.assertIn("gemini-web", job_transfer.DEFAULTS["providers"])

    def test_one_worker_per_google_media_account(self):
        with tempfile.TemporaryDirectory() as td:
            media_account(td, "google-media-2-479f", name="Google Media 2")
            media_account(td, "google-media-3-3207", name="Google Media 3", gemini_model="4 Neon", gemini_priority=50)
            media_account(td, "google-media-4-4f72", name="Google Media 4", gemini_enabled=False)
            media = Path(td) / "profiles" / "google-media"
            (media / "builtin-google.json").write_text(json.dumps({"enabled": True, "gemini_model": "4 Carbon"}),
                                                       encoding="utf-8")
            (media / "vids-workspaces.json").write_text("{}", encoding="utf-8")
            registry = build_worker_registry(td, home=td)
            gemini = {wid: info for wid, info in registry.items() if info["provider"] == "gemini-web"}
            self.assertEqual(set(gemini), {"gemini-normal", "gemini-google-media-2-479f",
                                           "gemini-google-media-3-3207", "gemini-google-media-4-4f72"})
            builtin = gemini["gemini-normal"]
            self.assertEqual((builtin["profile_id"], builtin["execution"]), ("web", "desktop-web"))
            self.assertEqual(builtin["settings"], {"model": "4 Carbon"})
            two = gemini["gemini-google-media-2-479f"]
            self.assertEqual(two["profile_id"], "google-media-2-479f")
            self.assertEqual(two["label"], "Gemini (Google Media 2)")
            self.assertTrue(two["enabled"])
            self.assertNotIn("settings", two)
            self.assertEqual(gemini["gemini-google-media-3-3207"]["settings"], {"model": "4 Neon"})
            self.assertEqual(gemini["gemini-google-media-3-3207"]["priority"], 50)
            self.assertFalse(gemini["gemini-google-media-4-4f72"]["enabled"])
            # Nothing is created: no profiles/gemini-web folder, media files unchanged.
            self.assertFalse((Path(td) / "profiles" / "gemini-web").exists())
            # Google Media itself still has no worker of its own.
            self.assertFalse(any(info["provider"] == "google-media" for info in registry.values()))

    def test_without_google_media_only_the_builtin_worker(self):
        with tempfile.TemporaryDirectory() as td:
            registry = build_worker_registry(td, home=td)
            self.assertEqual([wid for wid, info in registry.items() if info["provider"] == "gemini-web"], ["gemini-normal"])
            self.assertTrue(registry["gemini-normal"]["enabled"])

    def test_readiness_is_per_account_from_geminis_status(self):
        with tempfile.TemporaryDirectory() as td:
            media_account(td, "google-media-2-479f", name="Google Media 2")
            registry = build_worker_registry(td, home=td)
            builtin, second = registry["gemini-normal"], registry["gemini-google-media-2-479f"]
            write_status(td, {"web": {"automation_ready": True, "lanes": 2},
                              "google-media-2-479f": {"session_present": False, "login_visible": True}})
            self.assertTrue(scheduler.chatgpt_ready(td, builtin))
            self.assertFalse(scheduler.chatgpt_ready(td, second), "a signed-out Google account is not ready")
            self.assertEqual(scheduler.worker_capacity(td, builtin), 2)
            # Another site's status never counts.
            other = Path(td) / "qwen" / "status.json"
            other.parent.mkdir(parents=True)
            other.write_text(json.dumps({"heartbeat_at": time.time(), "profiles": {
                "google-media-2-479f": {"automation_ready": True}}}), encoding="utf-8")
            self.assertFalse(scheduler.chatgpt_ready(td, second))
            with patch.object(server, "ROOT", Path(td)):
                ready, detail = server.worker_auth_status(builtin, use_cache=False)
            self.assertTrue(ready, detail)
            self.assertIn("Gemini", detail)

    def test_queued_gemini_jobs_rotate_over_ready_accounts(self):
        with tempfile.TemporaryDirectory() as td, patch.object(scheduler, "WEB_PACING_SECONDS", 0):
            media_account(td, "google-media-2-479f", name="Google Media 2")
            write_status(td, {"web": {"automation_ready": True, "session_present": True, "lanes": 1},
                              "google-media-2-479f": {"automation_ready": True, "session_present": True, "lanes": 1}})
            registry = {wid: info for wid, info in build_worker_registry(td, home=td).items()
                        if info["provider"] == "gemini-web"}
            for n in range(2):
                job = Path(td) / "jobs" / f"q{n}"
                job.mkdir(parents=True)
                (job / "meta.json").write_text(json.dumps({
                    "id": f"q{n}", "worker": "gemini-normal", "provider": "gemini-web", "profile_id": "web",
                    "state": "queued", "queued_at": n, "queue_order": n + 1, "created": n, "pool": True,
                    "cwd": td, "timeout_s": 600}), encoding="utf-8")
                (job / "spec.json").write_text(json.dumps({"worker": "gemini-normal", "provider": "gemini-web", "cmd": [],
                                                            "profile_id": "web", "pool": True}), encoding="utf-8")
            scheduler.dispatch_once(td, spawn=lambda *a, **k: 1, registry=registry, is_ready=lambda w: True)
            metas = [json.loads((Path(td) / "jobs" / f"q{n}" / "meta.json").read_text(encoding="utf-8")) for n in range(2)]
            self.assertEqual({m["state"] for m in metas}, {"waiting_for_desktop"})
            self.assertEqual({m["worker"] for m in metas}, {"gemini-normal", "gemini-google-media-2-479f"})

    def test_mcp_schemas_name_gemini(self):
        tools = {tool["name"]: tool for tool in server.TOOLS}
        self.assertTrue(any("gemini-web" in json.dumps(tool["inputSchema"]) for tool in tools.values()))


if __name__ == "__main__":
    unittest.main()
