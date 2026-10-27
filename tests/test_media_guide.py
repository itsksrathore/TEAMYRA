import sys
import unittest
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
