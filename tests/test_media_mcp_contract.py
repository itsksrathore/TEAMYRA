import tempfile
import unittest
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "bridge"))

import media_engine
import observability
import server


class MediaMcpContractTests(unittest.TestCase):
    def test_public_media_tools_are_namespaced(self):
        names = {tool["name"] for tool in server.mcp_tools(include_legacy=False)}
        for name in (
            "teamyra.media_generate", "teamyra.media_batch", "teamyra.media_transform",
            "teamyra.media_status", "teamyra.media_assets", "teamyra.media_cancel",
        ):
            self.assertIn(name, names)

    def test_media_tool_schema_does_not_expose_browser_clicks(self):
        tools = {tool["name"]: tool for tool in server.mcp_tools(include_legacy=False)}
        raw = str(tools["teamyra.media_generate"]).lower()
        self.assertNotIn("selector", raw)
        self.assertNotIn("click", raw)
        self.assertNotIn("google_flow", raw)

    def test_auth_resume_requeues_only_unsubmitted_jobs(self):
        with tempfile.TemporaryDirectory() as td:
            project = Path(td) / "project"
            project.mkdir()
            unsubmitted = media_engine.create_job(td, {
                "type": "image", "prompt": "portrait", "project_path": str(project),
            })
            media_engine.update_job_state(td, unsubmitted["job_id"], "needs_user_auth", "login_required")

            submitted = media_engine.create_job(td, {
                "type": "video", "prompt": "scene", "project_path": str(project),
            })
            media_engine.update_job_state(td, submitted["job_id"], "submitting", extra={
                "provider_submission": {"submitted_at": 123.0, "provider_url": "https://flow.google/project"}
            })
            media_engine.update_job_state(td, submitted["job_id"], "needs_user_auth", "login_required")

            result = media_engine.resume_auth_jobs(td)
            self.assertIn(unsubmitted["job_id"], result["resumed"])
            self.assertIn(submitted["job_id"], result["reconcile_required"])
            self.assertEqual(media_engine.load_job(td, unsubmitted["job_id"])["state"], "queued")
            recovered = media_engine.load_job(td, submitted["job_id"])
            self.assertEqual(recovered["state"], "waiting_for_browser")
            self.assertTrue(recovered["reconcile_required"])

    def test_media_events_appear_in_unified_timeline(self):
        with tempfile.TemporaryDirectory() as td:
            project = Path(td) / "project"
            project.mkdir()
            job = media_engine.create_job(td, {
                "type": "music", "prompt": "dark score", "project_path": str(project),
            })
            timeline = observability.timeline(td, sources=["media"])
            self.assertTrue(any(item.get("media_job_id") == job["job_id"] for item in timeline["items"]))


if __name__ == "__main__":
    unittest.main()
