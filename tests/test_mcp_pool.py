import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "bridge"))

import mcp_pool
import server


FAKE_SERVER = r'''
import json, os, sys

TOOLS = [
    {
        "name": "pid",
        "description": "Return the fake server process id.",
        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
    {
        "name": "echo",
        "description": "Echo arguments.",
        "inputSchema": {"type": "object", "properties": {"value": {}}, "additionalProperties": True},
    },
]

def send(payload):
    sys.stdout.write(json.dumps(payload, separators=(",", ":")) + "\n")
    sys.stdout.flush()

for raw in sys.stdin:
    raw = raw.strip()
    if not raw:
        continue
    msg = json.loads(raw)
    method = msg.get("method")
    req_id = msg.get("id")
    if method == "initialize":
        send({
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {
                "protocolVersion": "2025-06-18",
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "fake-mcp", "version": "1"},
            },
        })
    elif method == "notifications/initialized":
        pass
    elif method == "tools/list":
        send({"jsonrpc": "2.0", "id": req_id, "result": {"tools": TOOLS}})
    elif method == "tools/call":
        params = msg.get("params") or {}
        name = params.get("name")
        args = params.get("arguments") or {}
        if name == "pid":
            text = str(os.getpid())
        elif name == "echo":
            text = json.dumps(args, sort_keys=True)
        else:
            send({"jsonrpc": "2.0", "id": req_id, "error": {"code": -32602, "message": "unknown tool"}})
            continue
        send({
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {"content": [{"type": "text", "text": text}]},
        })
    else:
        if req_id is not None:
            send({"jsonrpc": "2.0", "id": req_id, "error": {"code": -32601, "message": "unknown method"}})
'''


class MCPPoolTests(unittest.TestCase):
    def tearDown(self):
        # Tests that patch server.ROOT do not own the process-wide default manager.
        pass

    def make_fake(self, root):
        path = Path(root) / "fake_mcp.py"
        path.write_text(FAKE_SERVER, encoding="utf-8")
        return path

    def text_result(self, response):
        result = response["result"]
        return result["content"][0]["text"]

    def test_register_config_is_runtime_only_and_redacts_env_values(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            fake = self.make_fake(root)
            public = mcp_pool.register(
                root,
                "fake",
                [sys.executable, str(fake)],
                cwd=root,
                env={"SECRET_TOKEN": "do-not-expose"},
                timeout_seconds=10,
            )
            self.assertEqual(public["name"], "fake")
            self.assertEqual(public["env_keys"], ["SECRET_TOKEN"])
            self.assertNotIn("SECRET_TOKEN", json.dumps(public).replace('"SECRET_TOKEN"', ''))

            config_path = root / "profiles" / "mcp-pool.json"
            self.assertTrue(config_path.exists())
            raw = json.loads(config_path.read_text(encoding="utf-8"))
            self.assertEqual(raw["servers"]["fake"]["env"]["SECRET_TOKEN"], "do-not-expose")
            listed = mcp_pool.list_servers(root)["servers"][0]
            self.assertEqual(listed["env_keys"], ["SECRET_TOKEN"])
            self.assertNotIn("do-not-expose", json.dumps(listed))
            mcp_pool.shutdown(root)

    def test_pool_reuses_one_process_and_restart_reinitializes(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            fake = self.make_fake(root)
            mcp_pool.register(root, "fake", [sys.executable, str(fake)], cwd=root, timeout_seconds=10)
            try:
                tools = mcp_pool.list_tools(root, "fake")
                self.assertEqual({item["name"] for item in tools["tools"]}, {"pid", "echo"})
                first = mcp_pool.call_tool(root, "fake", "pid")
                second = mcp_pool.call_tool(root, "fake", "pid")
                pid1 = int(self.text_result(first))
                pid2 = int(self.text_result(second))
                self.assertEqual(pid1, pid2)
                self.assertEqual(first["pid"], second["pid"])

                echo = mcp_pool.call_tool(root, "fake", "echo", {"value": "hello"})
                self.assertIn('"value": "hello"', self.text_result(echo))

                restarted = mcp_pool.restart(root, "fake")
                self.assertTrue(restarted["running"])
                third = mcp_pool.call_tool(root, "fake", "pid")
                pid3 = int(self.text_result(third))
                self.assertNotEqual(pid1, pid3)

                status = mcp_pool.list_servers(root)["servers"][0]
                self.assertTrue(status["running"])
                self.assertGreaterEqual(status["request_count"], 2)
                self.assertGreaterEqual(status["restart_count"], 1)
            finally:
                mcp_pool.shutdown(root)

    def test_listing_can_be_compact_or_limited_to_named_tools(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            fake = self.make_fake(root)
            mcp_pool.register(root, "fake", [sys.executable, str(fake)], cwd=root, timeout_seconds=10)
            try:
                small = mcp_pool.list_tools(root, "fake", detail="auto")
                self.assertEqual(small["detail"], "full")
                self.assertIn("inputSchema", small["tools"][0])

                compact = mcp_pool.list_tools(root, "fake", detail="compact")
                self.assertEqual(compact["detail"], "compact")
                self.assertEqual(compact["count"], 2)
                self.assertNotIn("inputSchema", compact["tools"][0])

                named = mcp_pool.list_tools(root, "fake", detail="compact", tool_names=["echo", "nope"])
                self.assertEqual([tool["name"] for tool in named["tools"]], ["echo"])
                self.assertEqual(named["missing"], ["nope"])
                self.assertEqual(named["total"], 2)

                with self.assertRaisesRegex(ValueError, "detail must be one of"):
                    mcp_pool.list_tools(root, "fake", detail="everything")
            finally:
                mcp_pool.shutdown(root)

    def test_auto_listing_drops_schemas_only_when_too_large(self):
        big_schema = {"type": "object", "required": ["prompt"],
                      "properties": {"prompt": {"type": "string", "description": "x" * mcp_pool.FULL_LISTING_LIMIT}}}
        tools = [
            {"name": "huge", "description": "Line one.\n\n" + "y" * 500, "inputSchema": big_schema,
             "annotations": {"readOnlyHint": False, "destructiveHint": True, "title": "Huge"}},
            {"name": "small", "description": "Small tool.", "inputSchema": {"type": "object"}},
        ]
        auto = mcp_pool.shape_tools(tools, "auto")
        self.assertEqual(auto["detail"], "compact")
        self.assertIn("tool_names", auto["note"])
        self.assertEqual(auto["tools"][0], {
            "name": "huge",
            "description": auto["tools"][0]["description"],
            "required": ["prompt"],
            "readOnlyHint": False,
            "destructiveHint": True,
        })
        self.assertLessEqual(len(auto["tools"][0]["description"]), mcp_pool.SUMMARY_DESCRIPTION_CHARS)
        self.assertNotIn("\n", auto["tools"][0]["description"])
        self.assertLess(len(json.dumps(auto)), 2000)

        # Asking for a tool by name always returns its full schema, however large.
        named = mcp_pool.shape_tools(tools, "auto", ["huge"])
        self.assertEqual(named["detail"], "full")
        self.assertEqual(named["tools"][0]["inputSchema"], big_schema)
        self.assertNotIn("note", named)

    def test_unknown_tool_is_rejected_after_refresh(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            fake = self.make_fake(root)
            mcp_pool.register(root, "fake", [sys.executable, str(fake)], cwd=root, timeout_seconds=10)
            try:
                with self.assertRaisesRegex(ValueError, "no tool named missing"):
                    mcp_pool.call_tool(root, "fake", "missing")
            finally:
                mcp_pool.shutdown(root)

    def test_remove_stops_process_and_deletes_runtime_config(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            fake = self.make_fake(root)
            mcp_pool.register(root, "fake", [sys.executable, str(fake)], cwd=root, timeout_seconds=10)
            call = mcp_pool.call_tool(root, "fake", "pid")
            pid = call["pid"]
            self.assertIsNotNone(pid)
            result = mcp_pool.remove(root, "fake")
            self.assertTrue(result["ok"])
            self.assertEqual(mcp_pool.list_servers(root)["count"], 0)


    def test_public_status_does_not_expose_command_arguments(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            fake = self.make_fake(root)
            mcp_pool.register(
                root,
                "fake",
                [sys.executable, str(fake), "--token=super-secret"],
                cwd=root,
                env={"API_TOKEN": "also-secret"},
                timeout_seconds=10,
            )
            status = mcp_pool.list_servers(root)["servers"][0]
            dumped = json.dumps(status)
            self.assertEqual(status["command_executable"], sys.executable)
            self.assertEqual(status["argv_count"], 3)
            self.assertIn("API_TOKEN", status["env_keys"])
            self.assertNotIn("super-secret", dumped)
            self.assertNotIn("also-secret", dumped)
            mcp_pool.shutdown(root)

    def test_server_pool_tools_are_namespaced_and_mutations_require_confirmation(self):
        names = {tool["name"] for tool in server.mcp_tools(include_legacy=False)}
        for name in (
            "teamyra.mcp_pool_list",
            "teamyra.mcp_pool_tools",
            "teamyra.mcp_pool_call",
            "teamyra.mcp_pool_register",
            "teamyra.mcp_pool_restart",
            "teamyra.mcp_pool_remove",
        ):
            self.assertIn(name, names)

        with patch.object(server.mcp_pool, "register") as register:
            with self.assertRaisesRegex(ValueError, "confirm=true"):
                server.tool_call("mcp_pool_register", {
                    "server": "x",
                    "command": ["python"],
                    "confirm": False,
                })
            register.assert_not_called()

        with patch.object(server.mcp_pool, "restart") as restart:
            with self.assertRaisesRegex(ValueError, "confirm=true"):
                server.tool_call("mcp_pool_restart", {"server": "x", "confirm": False})
            restart.assert_not_called()

        with patch.object(server.mcp_pool, "remove") as remove:
            with self.assertRaisesRegex(ValueError, "confirm=true"):
                server.tool_call("mcp_pool_remove", {"server": "x", "confirm": False})
            remove.assert_not_called()

    def test_server_read_calls_delegate_to_pool(self):
        with patch.object(server.mcp_pool, "list_servers", return_value={"servers": []}) as listing:
            self.assertEqual(server.tool_call("mcp_pool_list", {}), {"servers": []})
            listing.assert_called_once_with(server.ROOT)

        with patch.object(server.mcp_pool, "list_tools", return_value={"tools": []}) as tools:
            server.tool_call("mcp_pool_tools", {"server": "fake", "refresh": True})
            tools.assert_called_once_with(server.ROOT, "fake", True, "auto", None)

        with patch.object(server.mcp_pool, "list_tools", return_value={"tools": []}) as tools:
            server.tool_call("mcp_pool_tools", {"server": "fake", "tool_names": ["echo"]})
            tools.assert_called_once_with(server.ROOT, "fake", False, "auto", ["echo"])

        with patch.object(server.mcp_pool, "call_tool", return_value={"result": {}}) as call:
            server.tool_call("mcp_pool_call", {
                "server": "fake",
                "tool_name": "echo",
                "arguments": {"x": 1},
                "timeout_seconds": 7,
            })
            call.assert_called_once_with(server.ROOT, "fake", "echo", {"x": 1}, 7)


if __name__ == "__main__":
    unittest.main()
