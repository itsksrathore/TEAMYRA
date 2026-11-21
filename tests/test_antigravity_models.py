"""Antigravity model choice: default model, per-job model and MCP tools (2026-11-12)."""
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "bridge"))

import server  # noqa: E402

AGY_OUT = ("Fetching available models...\n"
           "gemini-4-carbon-medium\tGemini 4 Carbon (Medium)\n"
           "gemini-4-carbon-high\tGemini 4 Carbon (High)\n"
           "gemini-4-argon-high\tGemini 4 Argon (High)\n")


class AntigravityModelTests(unittest.TestCase):
    def setUp(self):
        server._AGY_MODELS.update(at=0.0, models=[])

    def test_models_are_read_from_agy_models(self):
        with patch.object(server, "agy_launch", return_value=["agy"]), \
             patch.object(server, "run", return_value=(0, AGY_OUT, "")):
            models = server.antigravity_models(refresh=True)
        self.assertEqual([m["id"] for m in models], ["gemini-4-carbon-medium", "gemini-4-carbon-high",
                                                     "gemini-4-argon-high"])
        self.assertEqual(models[1]["label"], "Gemini 4 Carbon (High)")

    def test_set_model_writes_config_and_refuses_unknown_models(self):
        with tempfile.TemporaryDirectory() as td:
            config = Path(td) / "config.json"
            config.write_text(json.dumps({"antigravity": {"model": "gemini-4-argon-high", "mode": "accept-edits"}}),
                              encoding="utf-8")
            with patch.object(server, "CONFIG", config), patch.object(server, "agy_launch", return_value=["agy"]), \
                 patch.object(server, "run", return_value=(0, AGY_OUT, "")):
                state = server.set_antigravity_model("gemini-4-carbon-high")
                self.assertEqual(state["current"], "gemini-4-carbon-high")
                saved = json.loads(config.read_text(encoding="utf-8"))["antigravity"]
                self.assertEqual((saved["model"], saved["mode"]), ("gemini-4-carbon-high", "accept-edits"))
                with self.assertRaisesRegex(ValueError, "unknown Antigravity model"):
                    server.set_antigravity_model("gemini-9-imaginary")
                cmd = server.agy_cmd("t", "D:/p", True, 600)
                self.assertEqual(cmd[cmd.index("--model") + 1], "gemini-4-carbon-high")
                cmd = server.agy_cmd("t", "D:/p", True, 600, model="gemini-4-carbon-medium")
                self.assertEqual(cmd[cmd.index("--model") + 1], "gemini-4-carbon-medium", "a job's own model wins")

    def test_mcp_tools_are_listed_and_take_a_model(self):
        tools = {tool["name"]: tool for tool in server.TOOLS}
        self.assertIn("antigravity_models", tools)
        self.assertIn("antigravity_set_model", tools)
        for name in ("start_task", "run_ai_worker"):
            self.assertIn("model", tools[name]["inputSchema"]["properties"])
        task_item = tools["run_ai_parallel"]["inputSchema"]["properties"]["tasks"]["items"]
        self.assertIn("model", task_item["properties"])



class CodexModelTests(unittest.TestCase):
    def test_codex_models_come_from_its_cache_and_set_model_saves(self):
        with tempfile.TemporaryDirectory() as td:
            home = Path(td) / ".codex"
            home.mkdir()
            (home / "models_cache.json").write_text(json.dumps({"models": [
                {"slug": "gpt-6.2-sol", "display_name": "GPT-6.2-Sol", "visibility": "list"},
                {"slug": "gpt-6.2-astra", "display_name": "GPT-6.2-Astra", "visibility": "list"},
                {"slug": "gpt-reserve", "display_name": "GPT-Reserve", "visibility": "hide"}]}), encoding="utf-8")
            config = Path(td) / "config.json"
            config.write_text(json.dumps({"codex": {"model": "gpt-6.1-sol", "effort": "high"}}), encoding="utf-8")
            with patch.dict("os.environ", {"CODEX_HOME": str(home)}), patch.object(server, "CONFIG", config):
                self.assertEqual([m["id"] for m in server.codex_models()], ["gpt-6.2-sol", "gpt-6.2-astra"])
                state = server.set_codex_model("gpt-6.2-astra")
                self.assertEqual((state["current"], state["effort"]), ("gpt-6.2-astra", "high"))
                with self.assertRaisesRegex(ValueError, "unknown Codex model"):
                    server.set_codex_model("gpt-reserve")
        tools = {tool["name"] for tool in server.TOOLS}
        self.assertTrue({"codex_models", "codex_set_model"} <= tools)


if __name__ == "__main__":
    unittest.main()
