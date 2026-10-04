import json
import tempfile
import unittest
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "bridge"))

import media_engine


class MediaEngineTests(unittest.TestCase):
    def make_project(self, root):
        project = Path(root) / "project"
        project.mkdir(parents=True)
        return project

    def test_router_and_project_folder_creation(self):
        with tempfile.TemporaryDirectory() as td:
            project = self.make_project(td)
            self.assertEqual(media_engine.route_for_type("image"), "visual")
            self.assertEqual(media_engine.route_for_type("video"), "visual")
            self.assertEqual(media_engine.route_for_type("sound_effect"), "visual")
            self.assertEqual(media_engine.route_for_type("music"), "music")
            folders = media_engine.ensure_project_folders(td, project)["folders"]
            for name in (
                "Images", "Videos", "Music", "Sound Effects",
                "References", "Frames", "Characters", "Metadata",
            ):
                self.assertTrue(Path(folders[name]).is_dir())

    def test_sfx_prompt_enforces_audio_only_constraints(self):
        with tempfile.TemporaryDirectory() as td:
            project = self.make_project(td)
            job = media_engine.create_job(td, {
                "type": "sound_effect",
                "prompt": "single heavy medieval sword impact on steel",
                "project_path": str(project),
            })
            stored = media_engine.load_job(td, job["job_id"])
            provider_prompt = stored["request"]["provider_prompt"]
            self.assertIn("No background music.", provider_prompt)
            self.assertIn("No spoken dialogue.", provider_prompt)
            self.assertIn("only the requested sound event", provider_prompt)

    def test_sfx_prompt_preserves_explicit_music_or_voice_intent(self):
        with tempfile.TemporaryDirectory() as td:
            project = self.make_project(td)
            job = media_engine.create_job(td, {
                "type": "sound_effect",
                "prompt": "battle ambience with distant spoken commands and a requested drum score",
                "project_path": str(project),
            })
            stored = media_engine.load_job(td, job["job_id"])
            provider_prompt = stored["request"]["provider_prompt"]
            self.assertNotIn("No background music.", provider_prompt)
            self.assertNotIn("No spoken dialogue.", provider_prompt)

    def test_job_persistence_claim_and_cancel(self):
        with tempfile.TemporaryDirectory() as td:
            project = self.make_project(td)
            created = media_engine.create_job(td, {
                "type": "video",
                "prompt": "wide cavalry charge",
                "project_path": str(project),
                "duration": 8,
                "aspect_ratio": "16:9",
            })
            claimed = media_engine.claim_next_job(td, "visual", "visual-worker-1")
            self.assertEqual(claimed["job_id"], created["job_id"])
            self.assertEqual(claimed["state"], "preparing")
            cancelled = media_engine.cancel_job(td, created["job_id"])
            self.assertEqual(cancelled["status"], "cancelled")
            self.assertTrue(cancelled["cancel_requested"])

    def test_visual_and_music_lanes_claim_independently(self):
        with tempfile.TemporaryDirectory() as td:
            project = self.make_project(td)
            video = media_engine.create_job(td, {
                "type": "video", "prompt": "scene", "project_path": str(project),
            })
            music = media_engine.create_job(td, {
                "type": "music", "prompt": "score", "project_path": str(project),
            })
            visual_claim = media_engine.claim_next_job(td, "visual", "visual-worker")
            music_claim = media_engine.claim_next_job(td, "music", "music-worker")
            self.assertEqual(visual_claim["job_id"], video["job_id"])
            self.assertEqual(music_claim["job_id"], music["job_id"])

    def test_output_naming_is_semantic_ordered_and_non_overwriting(self):
        with tempfile.TemporaryDirectory() as td:
            project = self.make_project(td)
            first = media_engine.create_job(td, {
                "type": "image",
                "prompt": "Generate cinematic Tanaji fort battle",
                "project_path": str(project),
            })
            planned = media_engine.prepare_output(td, first["job_id"])
            self.assertTrue(Path(planned["path"]).name.startswith("001_tanaji_fort_battle"))
            Path(planned["path"]).write_bytes(b"image")
            second = media_engine.create_job(td, {
                "type": "image",
                "prompt": "Generate cinematic Tanaji fort battle",
                "project_path": str(project),
            })
            planned2 = media_engine.prepare_output(td, second["job_id"])
            self.assertTrue(Path(planned2["path"]).name.startswith("002_tanaji_fort_battle"))

    def test_sfx_output_uses_runtime_staging_not_project_temp(self):
        with tempfile.TemporaryDirectory() as td:
            project = self.make_project(td)
            job = media_engine.create_job(td, {
                "type": "sound_effect", "prompt": "horse gallop", "project_path": str(project),
            })
            planned = media_engine.prepare_output(td, job["job_id"])
            self.assertIn(str(Path(td) / "media" / "staging"), planned["temporary_video_path"])
            self.assertNotIn(str(project / "Generated Assets"), planned["temporary_video_path"])
            self.assertIn(str(project / "Generated Assets" / "Sound Effects"), planned["path"])

    def test_asset_registry_ids_and_lineage(self):
        with tempfile.TemporaryDirectory() as td:
            project = self.make_project(td)
            parent_job = media_engine.create_job(td, {
                "type": "image", "prompt": "warrior portrait", "project_path": str(project),
            })
            parent_plan = media_engine.prepare_output(td, parent_job["job_id"])
            parent_file = Path(parent_plan["path"])
            parent_file.write_bytes(b"png")
            parent = media_engine.register_asset(td, parent_job["job_id"], parent_file)
            self.assertEqual(parent["asset_id"], "TYR-IMG-000001")

            child_job = media_engine.create_transform_job(td, {
                "operation": "image_variation",
                "asset_id": parent["asset_id"],
                "prompt": "same warrior in rain",
            })
            child_plan = media_engine.prepare_output(td, child_job["job_id"])
            child_file = Path(child_plan["path"])
            child_file.write_bytes(b"png2")
            child = media_engine.register_asset(td, child_job["job_id"], child_file)
            self.assertEqual(child["asset_id"], "TYR-IMG-000002")
            self.assertEqual(child["parent_asset_ids"], [parent["asset_id"]])

    def test_asset_reference_resolves_exact_file_and_provider_metadata(self):
        with tempfile.TemporaryDirectory() as td:
            project = self.make_project(td)
            job = media_engine.create_job(td, {
                "type": "video", "prompt": "clip", "project_path": str(project),
            })
            plan = media_engine.prepare_output(td, job["job_id"])
            path = Path(plan["path"])
            path.write_bytes(b"video")
            asset = media_engine.register_asset(
                td, job["job_id"], path,
                provider_asset_id="provider-17",
                provider_project_id="project-5",
                provider_url="https://flow.google.com/example",
            )
            follow = media_engine.create_job(td, {
                "type": "video",
                "prompt": "extend character",
                "project_path": str(project),
                "references": [asset["asset_id"]],
            })
            stored = media_engine.load_job(td, follow["job_id"])
            ref = stored["resolved_references"][0]
            self.assertEqual(ref["asset_id"], asset["asset_id"])
            self.assertEqual(ref["provider_asset_id"], "provider-17")
            self.assertEqual(ref["path"], str(path.resolve()))

    def test_reference_outside_project_is_rejected(self):
        with tempfile.TemporaryDirectory() as td:
            project = self.make_project(td)
            outside = Path(td) / "outside.png"
            outside.write_bytes(b"x")
            with self.assertRaises(PermissionError):
                media_engine.create_job(td, {
                    "type": "image",
                    "prompt": "variation",
                    "project_path": str(project),
                    "references": [str(outside)],
                })

    def test_completed_asset_must_be_in_generated_assets(self):
        with tempfile.TemporaryDirectory() as td:
            project = self.make_project(td)
            job = media_engine.create_job(td, {
                "type": "image", "prompt": "portrait", "project_path": str(project),
            })
            bad = project / "bad.png"
            bad.write_bytes(b"x")
            with self.assertRaises(PermissionError):
                media_engine.register_asset(td, job["job_id"], bad)

    def test_recovery_never_blindly_resubmits_possible_provider_submission(self):
        with tempfile.TemporaryDirectory() as td:
            project = self.make_project(td)
            job = media_engine.create_job(td, {
                "type": "video", "prompt": "clip", "project_path": str(project),
            })
            media_engine.update_job_state(td, job["job_id"], "submitting", extra={
                "provider_submission": {"submitted_at": 123.0, "provider_project_id": "p1"},
            })
            report = media_engine.recover_incomplete_jobs(td)
            self.assertIn(job["job_id"], report["reconcile_required"])
            stored = media_engine.load_job(td, job["job_id"])
            self.assertEqual(stored["state"], "waiting_for_browser")
            self.assertTrue(stored["reconcile_required"])
            self.assertEqual(stored["provider_submission"]["provider_project_id"], "p1")


    def test_recovered_submitted_job_is_reclaimed_for_reconciliation_only(self):
        with tempfile.TemporaryDirectory() as td:
            project = self.make_project(td)
            job = media_engine.create_job(td, {
                "type": "image", "prompt": "resume provider job", "project_path": str(project),
            })
            media_engine.update_job_state(td, job["job_id"], "generating", extra={
                "provider_submission": {
                    "submitted_at": 123.0,
                    "provider_url": "https://flow.google.com/project/test-project",
                },
            })
            report = media_engine.recover_incomplete_jobs(td)
            self.assertIn(job["job_id"], report["reconcile_required"])
            claimed = media_engine.claim_next_job(td, "visual", "resume-worker")
            self.assertIsNotNone(claimed)
            self.assertEqual(claimed["job_id"], job["job_id"])
            self.assertTrue(claimed["reconcile_required"])
            self.assertEqual(claimed["provider_submission"]["submitted_at"], 123.0)
            self.assertEqual(claimed["state"], "preparing")

    def test_recovery_requeues_unsubmitted_preparing_job(self):
        with tempfile.TemporaryDirectory() as td:
            project = self.make_project(td)
            job = media_engine.create_job(td, {
                "type": "music", "prompt": "score", "project_path": str(project),
            })
            media_engine.claim_next_job(td, "music", "music-worker")
            report = media_engine.recover_incomplete_jobs(td)
            self.assertIn(job["job_id"], report["requeued"])
            self.assertEqual(media_engine.load_job(td, job["job_id"])["state"], "queued")

    def test_connection_status_redacts_browser_secrets_by_construction(self):
        with tempfile.TemporaryDirectory() as td:
            status = media_engine.write_connection_status(td, {
                "connected": True,
                "flow_ready": True,
                "cookies": "must-not-be-stored",
                "auth_token": "must-not-be-stored",
            })
            self.assertTrue(status["connected"])
            raw = (Path(td) / "media" / "connection.json").read_text(encoding="utf-8")
            self.assertNotIn("cookies", raw)
            self.assertNotIn("auth_token", raw)

    def test_batch_creates_durable_jobs(self):
        with tempfile.TemporaryDirectory() as td:
            project = self.make_project(td)
            result = media_engine.create_batch(td, [
                {"type": "image", "prompt": "one", "project_path": str(project)},
                {"type": "music", "prompt": "two", "project_path": str(project)},
            ])
            self.assertEqual(result["count"], 2)
            self.assertTrue(all(media_engine.load_job(td, row["job_id"]) for row in result["jobs"]))


    def test_rate_limited_unsubmitted_job_retries_after_cooldown(self):
        with tempfile.TemporaryDirectory() as td:
            project = self.make_project(td)
            job = media_engine.create_job(td, {
                "type": "image", "prompt": "retry me", "project_path": str(project),
            })
            media_engine.update_job_state(td, job["job_id"], "rate_limited", "pre-submit", {
                "retry_after": 1,
            })
            claimed = media_engine.claim_next_job(td, "visual", "other-google-profile")
            self.assertEqual(claimed["job_id"], job["job_id"])
            self.assertEqual(claimed["state"], "preparing")

    def test_rate_limited_submitted_job_is_not_reclaimed(self):
        with tempfile.TemporaryDirectory() as td:
            project = self.make_project(td)
            job = media_engine.create_job(td, {
                "type": "video", "prompt": "do not duplicate", "project_path": str(project),
            })
            media_engine.update_job_state(td, job["job_id"], "rate_limited", "post-submit", {
                "retry_after": 1,
                "provider_submission": {"submitted_at": 1.0, "provider_url": "https://flow.google.com/example"},
                "reconcile_required": True,
            })
            self.assertIsNone(media_engine.claim_next_job(td, "visual", "other-google-profile"))


if __name__ == "__main__":
    unittest.main()
