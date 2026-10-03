import unittest
from unittest.mock import patch
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "bridge"))

import server


class McpNamespaceTests(unittest.TestCase):
    def test_canonical_tools_are_teamyra_namespaced(self):
        tools = server.mcp_tools(include_legacy=False)
        self.assertEqual(len(tools), len(server.TOOLS))
        self.assertTrue(all(tool["name"].startswith("teamyra.") for tool in tools))
        self.assertEqual(len({tool["name"] for tool in tools}), len(tools))

    def test_legacy_aliases_remain_discoverable(self):
        tools = server.mcp_tools(include_legacy=True)
        names = {tool["name"] for tool in tools}
        self.assertIn("teamyra.start_task", names)
        self.assertIn("start_task", names)
        self.assertEqual(server.canonical_tool_name("teamyra.start_task"), "start_task")
        self.assertEqual(server.canonical_tool_name("start_task"), "start_task")

    def test_initialize_identifies_teamyra(self):
        response = server.handle({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {"protocolVersion": "2026-07-28"},
        })
        info = response["result"]["serverInfo"]
        self.assertEqual(info["name"], "teamyra")
        self.assertIn("TEAMYRA", info["title"])

    def test_namespaced_tool_call_routes_to_legacy_handler(self):
        with patch.object(server, "tool_call", return_value={"ok": True}) as call:
            response = server.handle({
                "jsonrpc": "2.0",
                "id": 2,
                "method": "tools/call",
                "params": {
                    "name": "teamyra.worker_status",
                    "arguments": {},
                },
            })
        self.assertFalse(response["result"]["isError"])
        call.assert_called_once_with("worker_status", {})


if __name__ == "__main__":
    unittest.main()
