import json
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ENDPOINT = "http://127.0.0.1:8787/mcp"


class ProviderIntegrationTests(unittest.TestCase):
    def load_json(self, rel):
        return json.loads((ROOT / rel).read_text(encoding="utf-8"))

    def test_claude_project_mcp_uses_local_http_endpoint(self):
        data = self.load_json(".mcp.json")
        entry = data["mcpServers"]["teamyra"]
        self.assertEqual(entry, {"type": "http", "url": ENDPOINT})

    def test_antigravity_plugin_uses_server_url_field(self):
        manifest = self.load_json("plugins/teamyra/plugin.json")
        self.assertEqual(manifest["name"], "teamyra")
        config = self.load_json("plugins/teamyra/mcp_config.json")
        entry = config["mcpServers"]["teamyra"]
        self.assertFalse(entry["disabled"])
        self.assertEqual(entry["serverUrl"], ENDPOINT)
        self.assertNotIn("url", entry)
        self.assertNotIn("httpUrl", entry)

    def test_codex_plugin_manifest_and_local_marketplace_are_consistent(self):
        manifest = self.load_json("plugins/teamyra/.codex-plugin/plugin.json")
        self.assertEqual(manifest["name"], "teamyra")
        self.assertEqual(manifest["mcpServers"], "./.mcp.json")
        self.assertEqual(manifest["skills"], "./skills/")
        self.assertEqual(manifest["interface"]["displayName"], "TEAMYRA")
        self.assertTrue(manifest["interface"]["capabilities"])

        plugin_mcp = self.load_json("plugins/teamyra/.mcp.json")
        self.assertEqual(plugin_mcp["mcpServers"]["teamyra"]["url"], ENDPOINT)

        marketplace = self.load_json(".agents/plugins/marketplace.json")
        self.assertEqual(marketplace["name"], "teamyra-local")
        plugin = marketplace["plugins"][0]
        self.assertEqual(plugin["name"], "teamyra")
        self.assertEqual(plugin["source"]["source"], "local")
        self.assertEqual(plugin["source"]["path"], "./plugins/teamyra")
        self.assertEqual(plugin["policy"]["installation"], "AVAILABLE")

    def test_provider_skills_define_safe_orchestration_contract(self):
        skill_paths = [
            ".agents/skills/teamyra/SKILL.md",
            "plugins/teamyra/skills/teamyra/SKILL.md",
        ]
        for rel in skill_paths:
            text = (ROOT / rel).read_text(encoding="utf-8")
            self.assertIn("teamyra.worker_status", text, rel)
            self.assertIn("teamyra.graph_create", text, rel)
            self.assertIn("teamyra.start_task", text, rel)
            self.assertIn("teamyra.test_run", text, rel)
            self.assertRegex(text.lower(), r"approval")
            self.assertRegex(text.lower(), r"worktree")
            self.assertRegex(text.lower(), r"review")

    def test_local_integration_manifests_do_not_embed_secrets(self):
        files = [
            ".mcp.json",
            ".agents/plugins/marketplace.json",
            "plugins/teamyra/.mcp.json",
            "plugins/teamyra/.codex-plugin/plugin.json",
            "plugins/teamyra/plugin.json",
            "plugins/teamyra/mcp_config.json",
        ]
        forbidden = re.compile(
            r"(bearer\s+[a-z0-9._-]+|api[_-]?key\s*[:=]|access[_-]?token\s*[:=]|client[_-]?secret\s*[:=])",
            re.IGNORECASE,
        )
        for rel in files:
            text = (ROOT / rel).read_text(encoding="utf-8")
            self.assertIsNone(forbidden.search(text), rel)
            self.assertNotIn("kiranbanna12", text.lower(), rel)

    def test_all_provider_bootstraps_share_one_local_endpoint(self):
        urls = {
            self.load_json(".mcp.json")["mcpServers"]["teamyra"]["url"],
            self.load_json("plugins/teamyra/mcp_config.json")["mcpServers"]["teamyra"]["serverUrl"],
            self.load_json("plugins/teamyra/.mcp.json")["mcpServers"]["teamyra"]["url"],
        }
        self.assertEqual(urls, {ENDPOINT})


if __name__ == "__main__":
    unittest.main()
