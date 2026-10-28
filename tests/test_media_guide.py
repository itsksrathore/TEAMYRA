import sys
import unittest
from unittest.mock import patch
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "bridge"))
import media_guide
import server


class MediaGuideTests(unittest.TestCase):
    def test_every_client_gets_the_fast_paths_on_connect(self):
        result = server.handle({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}})["result"]
        self.assertIn("media_batch", result["instructions"])
        self.assertIn("codex_image_batch", result["instructions"])

    def test_guide_tool_is_listed_and_answers(self):
        names = {tool["name"] for tool in server.mcp_tools()}
        self.assertTrue({"media_guide", "codex_image_batch", "codex_image_status", "codex_image_cancel"} <= names)
        answer = server.tool_call("media_guide", {})
        self.assertIn("codex_image_batch", answer["guide"])
        self.assertIn("flow_tabs", answer["capacity"])

    def test_capacity_counts_accounts_times_tabs(self):
        import json
        import tempfile
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            for name, enabled in (("acct-a", True), ("acct-b", True), ("acct-off", False)):
                (root / "profiles" / "google-media" / name).mkdir(parents=True)
                (root / "profiles" / "google-media" / name / "teamyra-profile.json").write_text(
                    json.dumps({"name": name, "enabled": enabled}), encoding="utf-8")
            (root / "profiles" / "google-media" / "builtin-google.json").write_text(
                json.dumps({"enabled": True, "name": "Main"}), encoding="utf-8")
            (root / "media").mkdir()
            (root / "media" / "connection.json").write_text(json.dumps({"connected": True, "profiles": {
                "acct-a": {"connected": True}, "acct-b": {"connected": True, "challenged": True},
                "acct-off": {"connected": True}}}), encoding="utf-8")
            with patch.dict("os.environ", {"TEAMYRA_FLOW_LANES": "3"}):
                result = media_guide.capacity(root)
        self.assertEqual([item["profile_id"] for item in result["flow_accounts"]], ["google", "acct-a", "acct-b", "acct-off"])
        self.assertEqual(result["flow_accounts_working"], 2, "built-in (top-level state) and acct-a; challenged and disabled do not count")
        self.assertEqual(result["flow_tabs_per_account"], 3)
        self.assertEqual(result["flow_tabs"], 6)
        self.assertEqual(result["flow_accounts"][0]["name"], "Main")
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "profiles" / "google-media").mkdir(parents=True)
            (root / "profiles" / "google-media" / "builtin-google.json").write_text(
                json.dumps({"enabled": False}), encoding="utf-8")
            off = media_guide.capacity(root)
        self.assertFalse(off["flow_accounts"][0]["enabled"], "the built-in account can be disabled")
        self.assertEqual(off["flow_accounts_working"], 0)

    def test_worker_image_jobs_get_a_hint(self):
        task = "Follow 00_bible/CHARSHEET_TASK.md. Use your BUILT-IN IMAGE GENERATION TOOL (gpt-image / imagegen) only."
        self.assertIn("codex_image_batch", media_guide.image_task_hint(task, "codex2"))
        self.assertIsNotNone(media_guide.image_task_hint("Generate 4 images of the castle", "auto"))
        self.assertIsNone(media_guide.image_task_hint("Fix the failing image upload test", "codex1"))
        self.assertIsNone(media_guide.image_task_hint(task, "claude"), "only Codex jobs are redirected")

    def test_tool_descriptions_point_to_the_fast_paths(self):
        tools = {tool["name"]: tool["description"] for tool in server.mcp_tools()}
        self.assertIn("codex_image_batch", tools["start_task"])
        self.assertIn("media_batch", tools["media_generate"])


if __name__ == "__main__":
    unittest.main()
