import tempfile
import time
import unittest
from pathlib import Path
import sys
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "bridge"))

import desktop_api
import media_engine
import media_guide
import server


class MediaGeminiTests(unittest.TestCase):
    def setUp(self):
        self._td = tempfile.TemporaryDirectory()
        self.td = self._td.name
        self.project = Path(self.td) / "project"
        self.project.mkdir()

    def tearDown(self):
        self._td.cleanup()

    def gemini(self, **extra):
        request = {"type": "text", "prompt": "Explain tides", "project_path": str(self.project), "engine": "gemini"}
        request.update(extra)
        return request

    # --- job creation and validation ----------------------------------------
    def test_text_job_defaults(self):
        job = media_engine.create_job(self.td, self.gemini())
        self.assertEqual(job["provider_surface"], "google-gemini")
        full = media_engine.load_job(self.td, job["job_id"])
        request = full["request"]
        self.assertEqual(request["surface"], "gemini")
        self.assertEqual((request["gemini_model"], request["gemini_mode"], request["gemini_tool"]), ("Auto", "chat", "none"))
        self.assertEqual(request["format"], "md")
        self.assertEqual(request["generation_settings"]["engine"], "google-gemini")
        self.assertTrue((self.project / "Generated Assets" / "Documents").is_dir())

    def test_tool_follows_type_and_aliases(self):
        image = media_engine.normalize_generate_request(self.td, self.gemini(type="image"))
        self.assertEqual(image["gemini_tool"], "image")
        video = media_engine.normalize_generate_request(self.td, self.gemini(type="video", gemini_tool="Veo"))
        self.assertEqual(video["gemini_tool"], "video")
        research = media_engine.normalize_generate_request(self.td, self.gemini(gemini_tool="Deep Research"))
        self.assertEqual(research["gemini_tool"], "deep_research")
        other = media_engine.normalize_generate_request(self.td, self.gemini(gemini_tool="Guided Learning"))
        self.assertEqual(other["gemini_tool"], "guided_learning")
        model = media_engine.normalize_generate_request(self.td, self.gemini(gemini_model="  4   Neon ", gemini_mode="TASK"))
        self.assertEqual((model["gemini_model"], model["gemini_mode"]), ("4 Neon", "task"))

    def test_validation_errors(self):
        cases = [
            (self.gemini(type="image", gemini_tool="deep_research"), "makes type=text"),
            (self.gemini(gemini_tool="image"), "makes type=image"),
            (self.gemini(gemini_mode="agent"), "chat or task"),
            (self.gemini(gemini_tool="x" * 50), "gemini_tool"),
            (self.gemini(aspect_ratio="16:9"), "aspect_ratio"),
            (self.gemini(vids_mode="extend"), "not supported"),
            (self.gemini(format="png"), "unsupported text format"),
            (self.gemini(references=[f"r{i}.txt" for i in range(11)]), "at most 10"),
            ({"type": "text", "prompt": "x", "project_path": str(self.project)}, "engine=gemini"),
            ({"type": "image", "prompt": "x", "project_path": str(self.project), "gemini_model": "Auto"}, "only for engine=gemini"),
        ]
        for request, message in cases:
            with self.subTest(message=message):
                with self.assertRaisesRegex(ValueError, message):
                    media_engine.create_job(self.td, request)

    def test_references_must_be_uploadable_project_files(self):
        (self.project / "brief.pdf").write_bytes(b"%PDF-1.4")
        (self.project / "tool.exe").write_bytes(b"MZ")
        job = media_engine.create_job(self.td, self.gemini(references=["brief.pdf"]))
        refs = media_engine.load_job(self.td, job["job_id"])["resolved_references"]
        self.assertTrue(refs[0]["path"].endswith("brief.pdf"))
        with self.assertRaisesRegex(ValueError, "cannot upload tool.exe"):
            media_engine.create_job(self.td, self.gemini(references=["tool.exe"]))
        outside = Path(self.td) / "outside.txt"
        outside.write_text("x")
        with self.assertRaises(PermissionError):
            media_engine.create_job(self.td, self.gemini(references=[str(outside)]))

    # --- claiming ------------------------------------------------------------
    def test_claimed_only_by_gemini_surface_and_any_account(self):
        job = media_engine.create_job(self.td, self.gemini())
        flow = media_engine.create_job(self.td, {"type": "image", "prompt": "fox", "project_path": str(self.project)})
        self.assertIsNone(media_engine.claim_next_job(self.td, "vids", "w"))
        # A single Gemini job may run in a second account's tab (no project affinity).
        claimed = media_engine.claim_next_job(self.td, "gemini", "w", profile_id="acct-2", main=False)
        self.assertEqual(claimed["job_id"], job["job_id"])
        self.assertIsNone(media_engine.claim_next_job(self.td, "gemini", "w", profile_id="acct-3", main=False))
        visual = media_engine.claim_next_job(self.td, "visual", "w")
        self.assertEqual(visual["job_id"], flow["job_id"])

    def test_resting_account_takes_no_new_gemini_work_of_that_tool(self):
        text = media_engine.create_job(self.td, self.gemini())
        video = media_engine.create_job(self.td, self.gemini(type="video", prompt="A wave"))
        media_engine.set_engine_cooldown(self.td, "gemini", "acct-2", 3600, "video limit", scope="video")
        first = media_engine.claim_next_job(self.td, "gemini", "w", profile_id="acct-2", main=False)
        self.assertEqual(first["job_id"], text["job_id"])
        self.assertIsNone(media_engine.claim_next_job(self.td, "gemini", "w", profile_id="acct-2", main=False))
        other = media_engine.claim_next_job(self.td, "gemini", "w", profile_id="google")
        self.assertEqual(other["job_id"], video["job_id"])

    def test_limit_handoff_moves_job_to_another_account(self):
        job = media_engine.create_job(self.td, self.gemini(type="image", prompt="A fox"))
        claimed = media_engine.claim_next_job(self.td, "gemini", "w", profile_id="acct-2", main=False)
        media_engine.update_job_state(self.td, claimed["job_id"], "submitting")
        media_engine.append_job_metadata(self.td, claimed["job_id"], {"submission_phase": "submitted", "provider_submission": {
            "submitted_at": time.time(), "provider_url": "https://gemini.google.com/app/abc123", "profile_id": "acct-2"}})
        with patch.object(desktop_api, "ROOT", Path(self.td)):
            result = desktop_api.handle("media.gemini-limit", {
                "job_id": job["job_id"], "profile_id": "acct-2", "seconds": 7200,
                "reason": "You've reached your limit", "scope": "image"})
        status = media_engine.job_status(self.td, job["job_id"])
        self.assertEqual(status["status"], "rate_limited")
        self.assertEqual(status["provider_submission"], {})
        plan = status["recovery_plan"]
        self.assertEqual((plan["category"], plan["action"]), ("rate_limited", "wait"))
        self.assertIn("another signed-in account", plan["instruction"])
        cooldowns = media_engine.engine_cooldowns(self.td, "gemini")
        self.assertEqual([(item["profile_id"], item["scope"]) for item in cooldowns], [("acct-2", "image")])
        self.assertGreater(cooldowns[0]["until"], time.time() + 7000)
        with patch.object(media_engine.time, "time", return_value=time.time() + 5):
            self.assertIsNone(media_engine.claim_next_job(self.td, "gemini", "w", profile_id="acct-2", main=False))
            again = media_engine.claim_next_job(self.td, "gemini", "w", profile_id="google")
        self.assertEqual(again["job_id"], job["job_id"])
        self.assertEqual(again["previous_submission"]["profile_id"], "acct-2")
        # Once rested, the account takes Gemini work again.
        media_engine.clear_engine_cooldown(self.td, "gemini", "acct-2")
        self.assertEqual(media_engine.engine_cooldowns(self.td, "gemini"), [])
        self.assertIsNotNone(result)

    def test_submitted_job_resumes_only_in_its_account(self):
        job = media_engine.create_job(self.td, self.gemini())
        media_engine.claim_next_job(self.td, "gemini", "w", profile_id="acct-2", main=False)
        media_engine.update_job_state(self.td, job["job_id"], "submitting")
        media_engine.update_job_state(self.td, job["job_id"], "failed", "generation_failure: timed out waiting", extra={
            "provider_submission": {"submitted_at": time.time(), "provider_url": "https://gemini.google.com/app/abc123",
                                    "profile_id": "acct-2", "lane": 0},
            "failure": {"category": "generation_failure"}})
        plan = media_engine.job_status(self.td, job["job_id"])["recovery_plan"]
        self.assertEqual(plan["action"], "resume_existing_submission")
        self.assertTrue(media_engine.recover_job(self.td, job["job_id"])["recovered"])
        self.assertIsNone(media_engine.claim_next_job(self.td, "gemini", "w", profile_id="google"))
        resumed = media_engine.claim_next_job(self.td, "gemini", "w", profile_id="acct-2", main=False)
        self.assertEqual(resumed["job_id"], job["job_id"])

    # --- recovery categories -------------------------------------------------
    def test_recovery_categories(self):
        expectations = {
            "selector_failure": (True, "retry_before_submission"),
            "reference_attach_failed": (True, "retry_before_submission"),
            "option_unavailable": (False, "revise_request"),
            "policy_refusal": (False, "revise_request"),
        }
        for category, (recoverable, action) in expectations.items():
            with self.subTest(category=category):
                job = media_engine.create_job(self.td, self.gemini())
                media_engine.update_job_state(self.td, job["job_id"], "failed", f"{category}: test",
                                              extra={"failure": {"category": category}})
                plan = media_engine.job_status(self.td, job["job_id"])["recovery_plan"]
                self.assertEqual((plan["can_recover"], plan["action"]), (recoverable, action))

    def test_text_asset_registration(self):
        job = media_engine.create_job(self.td, self.gemini())
        planned = media_engine.prepare_output(self.td, job["job_id"])
        self.assertTrue(planned["path"].endswith(".md"))
        self.assertIn("Documents", planned["path"])
        Path(planned["path"]).write_text("# Tides\n", encoding="utf-8")
        asset = media_engine.register_asset(self.td, job["job_id"], planned["path"], provider="google-gemini",
                                            metadata={"engine": "google-gemini"})
        self.assertRegex(asset["asset_id"], r"^TYR-DOC-\d{6}$")
        self.assertEqual(media_engine.get_asset(self.td, asset["asset_id"])["type"], "text")
        self.assertEqual(media_engine.list_assets(self.td, media_type="text")["count"], 1)

    # --- MCP surface -----------------------------------------------------------
    def test_schema_guide_and_wake(self):
        tools = {tool["name"]: tool for tool in server.mcp_tools(include_legacy=False)}
        props = tools["teamyra.media_generate"]["inputSchema"]["properties"]
        self.assertIn("gemini", props["engine"]["enum"])
        self.assertEqual(props["gemini_mode"]["enum"], ["chat", "task"])
        self.assertIn("gemini_model", props)
        self.assertIn("gemini_tool", props)
        self.assertIn("text", props["type"]["enum"])
        batch_items = tools["teamyra.media_batch"]["inputSchema"]["properties"]["requests"]["items"]["properties"]
        self.assertIn("gemini_tool", batch_items)
        self.assertEqual(server.media_wake_surface("google-gemini"), "gemini")
        self.assertIn('engine="gemini"', media_guide.INSTRUCTIONS)
        self.assertIn("## Google Gemini", media_guide.GUIDE)
        with patch.object(server, "ROOT", Path(self.td)):
            caps = server.tool_call("media_capabilities", {})
            self.assertIn("deep_research", caps["gemini"]["gemini_tool"])
            capacity = media_guide.capacity(self.td)
        self.assertIn("gemini_tabs_per_account", capacity)
        self.assertEqual(capacity["gemini_cooldowns"], [])

    def test_batch_wakes_gemini_surface(self):
        with patch.object(server, "ROOT", Path(self.td)), \
                patch.object(server, "desktop_control", return_value={"waking": True}) as wake:
            result = server.tool_call("media_batch", {"requests": [
                self.gemini(), self.gemini(type="image", prompt="A fox", gemini_model="4 Hydrogen")]})
        self.assertEqual(result["count"], 2)
        self.assertEqual({call.args[1]["surface"] for call in wake.call_args_list}, {"gemini"})


if __name__ == "__main__":
    unittest.main()
