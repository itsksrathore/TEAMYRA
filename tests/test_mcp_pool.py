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


# Pages its tools/list like the hosted ElevenLabs MCP, whose text-to-speech tool
# is not called text_to_speech.
PAGED_SERVER = r'''
import json, sys

PAGES = {
    None: ({"tools": [
        {"name": "creative_list_voices", "description": "List voices.", "inputSchema": {"type": "object"}},
        {"name": "speech_to_text", "description": "Transcribe speech to text.", "inputSchema": {"type": "object"}},
    ], "nextCursor": "p2"}),
    "p2": ({"tools": [
        {"name": "creative_generate_speech",
         "description": "Convert text into lifelike speech with a chosen voice.",
         "inputSchema": {"type": "object", "required": ["text"],
                         "properties": {"text": {"type": "string"}, "voice_id": {"type": "string"}}}},
        {"name": "speech_history_list", "description": "Generated speech history.", "inputSchema": {"type": "object"}},
    ]}),
}

def send(payload):
    sys.stdout.write(json.dumps(payload, separators=(",", ":")) + "\n")
    sys.stdout.flush()

for raw in sys.stdin:
    raw = raw.strip()
    if not raw:
        continue
    msg = json.loads(raw)
    method, req_id = msg.get("method"), msg.get("id")
    params = msg.get("params") or {}
    if method == "initialize":
        send({"jsonrpc": "2.0", "id": req_id, "result": {"protocolVersion": "2025-06-18", "capabilities": {"tools": {}}}})
    elif method == "tools/list":
        send({"jsonrpc": "2.0", "id": req_id, "result": PAGES[params.get("cursor")]})
    elif method == "tools/call":
        send({"jsonrpc": "2.0", "id": req_id, "result": {"content": [{"type": "text", "text": json.dumps(
            {"name": params.get("name"), "arguments": params.get("arguments")}, sort_keys=True)}]}})
    elif req_id is not None:
        send({"jsonrpc": "2.0", "id": req_id, "error": {"code": -32601, "message": "unknown method"}})
'''


class CapabilityMatchingTests(unittest.TestCase):
    def test_text_to_speech_is_found_by_current_name_or_description(self):
        tools = [
            {"name": "speech_to_text", "description": "Convert speech to text."},
            {"name": "get_speech_history", "description": "Text to speech history."},
            {"name": "text_to_dialogue", "description": "Generate speech for a multi-voice dialogue."},
            {"name": "creative_generate_speech", "description": "Turn text into speech."},
            {"name": "voice_changer", "description": "Speech to speech."},
            {"name": "creative_make_audio", "description": "Converts the given text into spoken audio (TTS)."},
            {"name": "music_compose", "description": "Generate music."},
        ]
        names = [tool["name"] for tool in mcp_pool.find_tools(tools, "text_to_speech")]
        self.assertEqual(names[0], "creative_generate_speech")
        self.assertIn("creative_make_audio", names)
        self.assertIn("text_to_dialogue", names)
        for wrong in ("speech_to_text", "get_speech_history", "voice_changer", "music_compose"):
            self.assertNotIn(wrong, names)
        self.assertEqual(mcp_pool.find_tools([{"name": "text_to_speech"}], "text_to_speech")[0]["name"], "text_to_speech")
        self.assertEqual(mcp_pool.find_tools([{"name": "elevenlabs.tts"}], "text_to_speech")[0]["name"], "elevenlabs.tts")

    def test_old_names_map_to_the_capability_and_unrelated_names_do_not(self):
        for name in ("text_to_speech", "TextToSpeech", "tts", "generate_speech", "elevenlabs_text_to_speech"):
            self.assertEqual(mcp_pool.capability_for_name(name), "text_to_speech", name)
        for name in ("speech_to_text", "list_voices", "echo", "speech_history"):
            self.assertIsNone(mcp_pool.capability_for_name(name), name)

    def test_capability_listing_returns_full_schemas_or_a_clear_note(self):
        tools = [{"name": "creative_generate_speech", "description": "TTS.", "inputSchema": {"type": "object"}},
                 {"name": "echo", "description": "Echo."}]
        found = mcp_pool.shape_tools(tools, "auto", capability="text_to_speech")
        self.assertEqual(found["detail"], "full")
        self.assertEqual([tool["name"] for tool in found["tools"]], ["creative_generate_speech"])
        self.assertIn("inputSchema", found["tools"][0])
        none = mcp_pool.shape_tools([{"name": "echo"}], "auto", capability="text_to_speech")
        self.assertEqual(none["tools"], [])
        self.assertIn("lists no text-to-speech tool", none["note"])
        with self.assertRaisesRegex(ValueError, "capability must be one of"):
            mcp_pool.shape_tools(tools, "auto", capability="teleport")


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

    def make_paged(self, root):
        path = Path(root) / "paged_mcp.py"
        path.write_text(PAGED_SERVER, encoding="utf-8")
        mcp_pool.register(root, "paged", [sys.executable, str(path)], cwd=root, timeout_seconds=10)

    def test_listing_follows_pagination_so_later_tools_are_found(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            self.make_paged(root)
            try:
                listed = mcp_pool.list_tools(root, "paged")
                self.assertEqual(listed["total"], 4)
                self.assertIn("creative_generate_speech", {tool["name"] for tool in listed["tools"]})
                refreshed = mcp_pool.list_tools(root, "paged", refresh=True, capability="text_to_speech")
                self.assertEqual([tool["name"] for tool in refreshed["tools"]], ["creative_generate_speech"])
                self.assertEqual(refreshed["tools"][0]["inputSchema"]["required"], ["text"])
            finally:
                mcp_pool.shutdown(root)

    def test_outdated_text_to_speech_name_calls_the_current_tool(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            self.make_paged(root)
            try:
                result = mcp_pool.call_tool(root, "paged", "text_to_speech", {"text": "Namaste", "voice_id": "v1"})
                self.assertEqual(json.loads(self.text_result(result)),
                                 {"name": "creative_generate_speech", "arguments": {"text": "Namaste", "voice_id": "v1"}})
                self.assertEqual(result["result"]["_teamyra"],
                                 {"requested_tool": "text_to_speech", "called_tool": "creative_generate_speech"})
                # Arguments that do not fit the current tool are refused before any call.
                with self.assertRaisesRegex(ValueError, "creative_generate_speech, which also requires text. Nothing was called"):
                    mcp_pool.call_tool(root, "paged", "text_to_speech", {"prompt": "Namaste"})
                with self.assertRaisesRegex(ValueError, "no tool named speech_to_txt. Similar tools: speech_to_text"):
                    mcp_pool.call_tool(root, "paged", "speech_to_txt", {})
            finally:
                mcp_pool.shutdown(root)

    def test_account_without_text_to_speech_gets_a_clear_error(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            fake = self.make_fake(root)
            mcp_pool.register(root, "fake", [sys.executable, str(fake)], cwd=root, timeout_seconds=10)
            try:
                with self.assertRaisesRegex(ValueError, r"lists no text-to-speech tool \(2 tools listed\).*text_to_speech permission"):
                    mcp_pool.call_tool(root, "fake", "text_to_speech", {"text": "hi"})
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
            tools.assert_called_once_with(server.ROOT, "fake", True, "auto", None, None)

        with patch.object(server.mcp_pool, "list_tools", return_value={"tools": []}) as tools:
            server.tool_call("mcp_pool_tools", {"server": "fake", "tool_names": ["echo"]})
            tools.assert_called_once_with(server.ROOT, "fake", False, "auto", ["echo"], None)

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
