import json
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
import media_suno
import server

CLIP_A = "4eed94d1-9d36-4a8b-aa74-71250bbb8b0f"
CLIP_B = "c1a16429-f3fe-4d99-bdcf-61ee13ed6f00"


class MediaSunoTests(unittest.TestCase):
    def setUp(self):
        self._td = tempfile.TemporaryDirectory()
        self.td = self._td.name
        self.project = Path(self.td) / "project"
        self.project.mkdir()

    def tearDown(self):
        self._td.cleanup()

    def suno(self, **extra):
        request = {"type": "song", "prompt": "An upbeat pop song about monsoon rain", "project_path": str(self.project),
                   "engine": "suno"}
        request.update(extra)
        return request

    def add_account(self, profile_id, name, enabled=True):
        folder = Path(self.td) / "profiles" / "suno" / profile_id
        folder.mkdir(parents=True)
        (folder / "teamyra-profile.json").write_text(json.dumps({"name": name, "enabled": enabled}), encoding="utf-8")

    def claim(self, profile="suno", worker="suno-test"):
        return media_engine.claim_next_job(self.td, "suno", worker, profile_id=profile, main=profile == "suno")

    # --- request validation ---------------------------------------------------
    def test_simple_request_defaults(self):
        job = media_engine.create_job(self.td, self.suno())
        self.assertEqual(job["provider_surface"], "suno")
        request = media_engine.load_job(self.td, job["job_id"])["request"]
        self.assertEqual((request["surface"], request["engine"], request["suno_action"]), ("suno", "suno", "generate"))
        self.assertEqual(request["suno_mode"], "custom", "Advanced mode by default (owner, 2026-11-21)")
        self.assertEqual(request["lyrics"], request["prompt"], "without lyrics the prompt is the lyrics")
        simple = media_engine.load_job(self.td, media_engine.create_job(self.td, self.suno(suno_mode="simple"))["job_id"])["request"]
        self.assertEqual(simple["suno_mode"], "simple")
        self.assertIsNone(simple["lyrics"])
        self.assertIsNone(request["suno_model"], "the page's current model is kept unless one is named")
        self.assertEqual(request["output_count"], 2, "Suno makes two clips per request")
        self.assertEqual(request["format"], "m4a")
        self.assertFalse(request["instrumental"])
        self.assertTrue((self.project / "Generated Assets" / "Music" / "Previews").is_dir())

    def test_v6_more_options(self):
        job = media_engine.create_job(self.td, self.suno(suno_duration="2:30", suno_max_mode=True, suno_variety="off",
                                                          suno_personalize=False, suno_mode="advanced"))
        request = media_engine.load_job(self.td, job["job_id"])["request"]
        self.assertEqual((request["suno_mode"], request["suno_duration"], request["suno_max_mode"], request["suno_variety"],
                          request["suno_personalize"]), ("custom", 150, True, 0, False))
        auto = media_engine.load_job(self.td, media_engine.create_job(self.td, self.suno(suno_duration="auto"))["job_id"])["request"]
        self.assertEqual(auto["suno_duration"], "auto")
        inst = media_engine.load_job(self.td, media_engine.create_job(self.td, self.suno(type="instrumental"))["job_id"])["request"]
        self.assertTrue(inst["instrumental"])
        self.assertFalse(inst["lyrics"])
        self.assertTrue(inst["suno_style"], "an instrumental without a style uses the prompt as its style")

    def test_custom_request_and_options(self):
        request = media_engine.normalize_generate_request(self.td, self.suno(
            type="audio", lyrics="[Verse]\nRain on the roof", suno_style="indie pop, female vocals", suno_title="Monsoon",
            suno_model=" v4.5 ", suno_vocal_gender="Female", suno_exclude_styles="metal", suno_weirdness=35,
            suno_style_influence="80", suno_options={"Lyrics Mode": "Manual", "Audio Influence": 40}))
        self.assertEqual(request["type"], "music", "audio is Suno's alias of music")
        self.assertEqual(request["suno_mode"], "custom")
        self.assertEqual((request["suno_title"], request["suno_model"], request["suno_vocal_gender"]), ("Monsoon", "v4.5", "female"))
        self.assertEqual((request["suno_weirdness"], request["suno_style_influence"]), (35, 80))
        self.assertEqual(request["suno_options"], {"Lyrics Mode": "Manual", "Audio Influence": 40})
        # Custom mode without lyrics: the prompt becomes the lyrics.
        lyric = media_engine.normalize_generate_request(self.td, self.suno(suno_mode="custom", suno_style="lofi"))
        self.assertEqual(lyric["lyrics"], "An upbeat pop song about monsoon rain")
        instrumental = media_engine.normalize_generate_request(self.td, self.suno(type="instrumental", suno_style="lofi beats"))
        self.assertTrue(instrumental["instrumental"])
        self.assertIsNone(instrumental["lyrics"])

    def test_validation_errors(self):
        cases = [
            (self.suno(type="video"), "makes songs"),
            (self.suno(suno_mode="studio"), "custom/advanced .* or simple"),
            (self.suno(suno_duration=500), "10-360 seconds"),
            (self.suno(suno_variety=7), "0-4"),
            (self.suno(suno_max_mode="maybe"), "true or false"),
            (self.suno(suno_mode="simple", lyrics="la la"), "need suno_mode=custom"),
            (self.suno(instrumental=True, vocals=True), "cannot both"),
            (self.suno(instrumental=True, lyrics="la"), "takes no lyrics"),
            (self.suno(suno_vocal_gender="robot"), "male or female"),
            (self.suno(instrumental=True, suno_style="x", suno_vocal_gender="male"), "does not apply"),
            (self.suno(suno_weirdness=140), "from 0 to 100"),
            (self.suno(format="mp3"), "suno_download"),
            (self.suno(output_count=4), "2 clips"),
            (self.suno(references=["a.png"]), "no references"),
            (self.suno(gemini_model="Auto"), "not supported with engine=suno"),
            (self.suno(suno_options=["x"]), "suno_options must be an object"),
            (self.suno(accounts=["nobody"]), "unknown Suno account"),
            ({"type": "song", "prompt": "x", "project_path": str(self.project), "suno_style": "pop"}, "only for engine=suno"),
            ({"type": "audio", "prompt": "x", "project_path": str(self.project)}, "type=audio is for engine=suno"),
        ]
        for request, message in cases:
            with self.subTest(message=message):
                with self.assertRaisesRegex(ValueError, message):
                    media_engine.create_job(self.td, request)

    def test_accounts_resolve_by_id_or_name(self):
        self.add_account("suno-2-ab12", "Second Suno")
        self.add_account("suno-3-cd34", "Off Suno", enabled=False)
        accounts = media_suno.suno_accounts(self.td)
        self.assertEqual([item["profile_id"] for item in accounts], ["suno", "suno-2-ab12", "suno-3-cd34"])
        self.assertEqual(media_suno.resolve_suno_accounts(self.td, ["second suno", "suno"]), ["suno-2-ab12", "suno"])
        with self.assertRaisesRegex(ValueError, "turned off"):
            media_suno.resolve_suno_accounts(self.td, ["suno-3-cd34"])
        with patch.object(desktop_api, "ROOT", Path(self.td)):
            desktop_api.handle("media.suno-account-status", {"profile_id": "suno-2-ab12", "patch": {"signed_in": True, "credits": 50}})
            listed = desktop_api.handle("media.suno-accounts", {})["accounts"]
        second = next(item for item in listed if item["profile_id"] == "suno-2-ab12")
        self.assertTrue(second["signed_in"])
        self.assertEqual(second["credits"], 50)

    # --- queue -------------------------------------------------------------
    def test_any_signed_in_account_claims_and_limits_move_jobs(self):
        self.add_account("suno-2-ab12", "Second Suno")
        job = media_engine.create_job(self.td, self.suno())
        self.assertIsNone(media_engine.claim_next_job(self.td, "gemini", "g", profile_id="google"), "other surfaces never take Suno work")
        claimed = self.claim("suno-2-ab12")
        self.assertEqual(claimed["job_id"], job["job_id"], "single Suno jobs run in any account")
        result = media_suno.limit_handoff(self.td, job["job_id"], "suno-2-ab12", seconds=7200,
                                          reason="You're out of credits")
        self.assertEqual(result["cooldown"]["scope"], "generate")
        saved = media_engine.load_job(self.td, job["job_id"])
        self.assertEqual(saved["state"], "rate_limited")
        self.assertEqual(saved["failure"]["category"], "rate_limited")
        plan = media_engine.recovery_plan(saved)
        self.assertEqual(plan["action"], "wait")
        self.assertIn("another signed-in Suno account", plan["instruction"])
        media_engine._atomic_write(media_engine._job_path(self.td, job["job_id"]), {**saved, "retry_after": time.time() - 1})
        self.assertIsNone(self.claim("suno-2-ab12"), "the resting account takes no new generation")
        self.assertEqual(self.claim("suno")["job_id"], job["job_id"], "another Suno account takes it")
        cooldowns = media_suno.suno_accounts(self.td)[1]["cooldowns"]
        self.assertEqual(cooldowns[0]["scope"], "generate")

    def test_option_unavailable_plan_names_suno(self):
        job = media_engine.create_job(self.td, self.suno(suno_model="v9"))
        media_engine.update_job_state(self.td, job["job_id"], "failed",
                                      "option_unavailable: Suno model \"v9\" is not offered; it offers: v4.5, v5",
                                      extra={"failure": {"category": "option_unavailable"}})
        plan = media_engine.recovery_plan(media_engine.load_job(self.td, job["job_id"]))
        self.assertEqual(plan["action"], "revise_request")
        self.assertTrue(plan["instruction"].startswith("Suno does not offer"))

    # --- previews and downloads ------------------------------------------------
    def make_previews(self, profile="suno"):
        job = media_engine.create_job(self.td, self.suno(suno_title="Monsoon", suno_style="pop"))
        claimed = self.claim(profile)
        media_engine.append_job_metadata(self.td, job["job_id"], {"provider_submission": {
            "submitted_at": time.time(), "profile_id": profile, "clip_ids": [CLIP_A, CLIP_B]}})
        with patch.object(desktop_api, "ROOT", Path(self.td)):
            paths = desktop_api.handle("media.suno-preview-paths", {"job_id": claimed["job_id"], "clips": [
                {"clip_id": CLIP_A, "title": "Monsoon", "ext": "mp4"}, {"clip_id": CLIP_B, "title": "Monsoon"}]})["paths"]
            self.assertTrue(paths[CLIP_A].endswith("monsoon_4eed94d1.preview.m4a"))
            self.assertIn(str(Path("Generated Assets") / "Music" / "Previews"), paths[CLIP_B])
            clips = []
            for clip_id in (CLIP_A, CLIP_B):
                Path(paths[clip_id]).write_bytes(b"\x00\x00\x00\x1cftypiso6" + b"\x00" * 4096)
                clips.append({"clip_id": clip_id, "local_path": paths[clip_id], "title": "Monsoon",
                              "metadata": {"duration": 182.4, "bitrate_kbps": 128, "lyrics": "[Verse] rain", "style": "pop",
                                           "model": "v4.5", "verification": {"hints": []}}})
            result = desktop_api.handle("media.suno-register-previews", {"job_id": job["job_id"], "clips": clips})
        return job, result

    def test_previews_register_two_assets_and_complete_the_job(self):
        job, result = self.make_previews()
        assets = result["assets"]
        self.assertEqual(len(assets), 2)
        self.assertTrue(all(item["preview"] and item["metadata"]["preview"] for item in assets))
        self.assertEqual(assets[0]["provider_asset_id"], CLIP_A)
        self.assertEqual(assets[0]["metadata"]["suno_profile_id"], "suno")
        self.assertEqual(assets[0]["metadata"]["sibling_asset_ids"], [assets[1]["asset_id"]])
        self.assertTrue(assets[0]["asset_id"].startswith("TYR-MUS-"))
        status = media_engine.job_status(self.td, job["job_id"])
        self.assertEqual(status["status"], "completed")
        self.assertEqual(status["asset_ids"], [item["asset_id"] for item in assets])
        self.assertEqual(len(status["assets"]), 2)
        with self.assertRaises(PermissionError):
            media_suno.register_previews(self.td, media_engine.create_job(self.td, self.suno())["job_id"],
                                         [{"clip_id": CLIP_A, "local_path": str(Path(self.td) / "outside.m4a")}])

    def test_download_job_runs_in_the_owner_account_and_links_the_final(self):
        self.add_account("suno-2-ab12", "Second Suno")
        _, result = self.make_previews(profile="suno-2-ab12")
        preview = result["assets"][1]
        download = server.tool_call("suno_download", {"asset_id": preview["asset_id"], "format": "wav"}) \
            if False else media_suno.create_download_job(self.td, {"asset_id": preview["asset_id"], "format": "wav"})
        self.assertEqual(download["provider_surface"], "suno")
        self.assertEqual(download["parent_asset_ids"], [preview["asset_id"]])
        request = media_engine.load_job(self.td, download["job_id"])["request"]
        self.assertEqual((request["suno_action"], request["suno_clip_id"], request["format"]), ("download", CLIP_B, "wav"))
        self.assertEqual(request["accounts"], ["suno-2-ab12"])
        again = media_suno.create_download_job(self.td, {"clip_id": CLIP_B, "format": "wav"})
        self.assertTrue(again["already_queued"], "a second request for the same file never spends another download")
        self.assertIsNone(self.claim("suno"), "only the account that made the clip can download it")
        claimed = self.claim("suno-2-ab12")
        self.assertEqual(claimed["job_id"], download["job_id"])
        planned = media_engine.prepare_output(self.td, download["job_id"])
        self.assertTrue(planned["path"].endswith(".wav"))
        self.assertEqual(Path(planned["path"]).parent.name, "Music")
        Path(planned["path"]).write_bytes(b"RIFF" + b"\x00" * 64)
        final = media_engine.register_asset(self.td, download["job_id"], planned["path"], provider="suno",
                                            provider_asset_id=CLIP_B, metadata={"official_download": True})
        refreshed = media_engine.get_asset(self.td, preview["asset_id"])
        self.assertEqual(refreshed["metadata"]["final_assets"], {"wav": final["asset_id"]})
        repeat = media_suno.create_download_job(self.td, {"asset_id": preview["asset_id"], "format": "wav"})
        self.assertTrue(repeat["already_downloaded"])
        self.assertEqual(repeat["asset"]["asset_id"], final["asset_id"])
        with self.assertRaisesRegex(ValueError, "mp3 or wav"):
            media_suno.create_download_job(self.td, {"asset_id": preview["asset_id"], "format": "flac"})
        with self.assertRaisesRegex(ValueError, "only be downloaded there"):
            media_suno.create_download_job(self.td, {"asset_id": preview["asset_id"], "account": "suno"})

    def test_download_limit_waits_for_the_same_account(self):
        _, result = self.make_previews()
        download = media_suno.create_download_job(self.td, {"asset_id": result["assets"][0]["asset_id"]})
        self.claim("suno")
        handoff = media_suno.limit_handoff(self.td, download["job_id"], "suno", seconds=3600,
                                           reason="You have reached your download limit")
        self.assertEqual(handoff["cooldown"]["scope"], "download")
        saved = media_engine.load_job(self.td, download["job_id"])
        self.assertGreater(saved["retry_after"], time.time() + 3000, "a download is not retried before the limit resets")
        plan = media_engine.recovery_plan(saved)
        self.assertIn("download limit", plan["instruction"])
        # A generation still runs in that account (only downloads rest).
        job = media_engine.create_job(self.td, self.suno())
        self.assertEqual(self.claim("suno")["job_id"], job["job_id"])

    def test_download_needs_project_for_unknown_clip(self):
        with self.assertRaisesRegex(ValueError, "project_path"):
            media_suno.create_download_job(self.td, {"clip_id": CLIP_A})
        with self.assertRaisesRegex(ValueError, "asset_id .* or clip_id"):
            media_suno.create_download_job(self.td, {"clip_id": "not-a-uuid"})
        job = media_suno.create_download_job(self.td, {"clip_id": CLIP_A, "project_path": str(self.project), "format": "mp3"})
        self.assertEqual(media_engine.load_job(self.td, job["job_id"])["request"]["accounts"], ["suno"])

    # --- MCP surface ----------------------------------------------------------
    def test_tools_guide_and_capabilities(self):
        tools = {tool["name"]: tool for tool in server.TOOLS}
        self.assertIn("suno", tools["media_generate"]["inputSchema"]["properties"]["engine"]["enum"])
        for key in ("suno_mode", "suno_style", "suno_title", "suno_model", "suno_vocal_gender", "suno_exclude_styles",
                    "suno_weirdness", "suno_style_influence", "suno_options"):
            self.assertIn(key, tools["media_batch"]["inputSchema"]["properties"]["requests"]["items"]["properties"])
        self.assertEqual(tools["suno_download"]["inputSchema"]["properties"]["format"]["enum"], ["mp3", "wav"])
        self.assertIn("limit", tools["suno_clips"]["inputSchema"]["properties"])
        self.assertIn("suno", tools["agent_account_create"]["inputSchema"]["properties"]["provider"]["enum"])
        self.assertIn("engine=\"suno\"", media_guide.INSTRUCTIONS)
        self.assertIn("## Suno", media_guide.GUIDE)
        with patch.object(server, "ROOT", Path(self.td)):
            caps = server.tool_call("media_capabilities", {})
            capacity = media_guide.capacity(self.td)
        self.assertEqual(caps["suno"]["clips_per_request"], 2)
        self.assertEqual(capacity["suno_accounts"][0]["profile_id"], "suno")
        self.assertEqual(server.media_wake_surface("suno"), "suno")

    def test_generate_tool_wakes_the_suno_surface(self):
        with patch.object(server, "ROOT", Path(self.td)), \
                patch.object(server, "desktop_control", return_value={"accounts": [{"profile_id": "suno"}]}) as wake:
            result = server.tool_call("media_generate", self.suno())
            self.assertEqual(result["runtime"]["surface"], "suno")
            self.assertEqual(wake.call_args.args[:2], ("media.wake", {"surface": "suno"}))

    def test_suno_clips_merges_live_and_known(self):
        self.make_previews()
        live = {"signed_in": True, "source": "network", "clips": [
            {"clip_id": CLIP_A, "title": "Monsoon", "status": "complete"},
            {"clip_id": "11111111-2222-3333-4444-555555555555", "title": "Other", "status": "streaming"}]}
        with patch.object(server, "ROOT", Path(self.td)), patch.object(server, "desktop_control", return_value=live):
            result = server.tool_call("suno_clips", {"limit": 5})
        self.assertTrue(result["live"])
        self.assertEqual(result["clips"][0]["preview_asset_id"][:8], "TYR-MUS-")
        self.assertNotIn("preview_asset_id", result["clips"][1])
        self.assertEqual([item["clip_id"] for item in result["known"]], [CLIP_B])
        with patch.object(server, "ROOT", Path(self.td)), patch.object(server, "desktop_control", side_effect=TimeoutError("no desktop")):
            offline = server.tool_call("suno_clips", {})
        self.assertFalse(offline["live"])
        self.assertEqual({item["clip_id"] for item in offline["clips"]}, {CLIP_A, CLIP_B})


if __name__ == "__main__":
    unittest.main()
