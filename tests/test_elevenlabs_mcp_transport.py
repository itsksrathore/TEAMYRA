"""Exercise the installed OAuth HTTP adapter through the real TEAMYRA stdio pool.

The remote peer is a local fake MCP endpoint; no ElevenLabs account or credits
are used. Both Node and Electron's Node mode must support this protocol path.
"""
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "bridge"))
import mcp_pool


class FakeRemote(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_GET(self):
        self.send_response(405)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_POST(self):
        message = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
        method = message.get("method")
        if "id" not in message:
            self.send_response(202)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if method == "initialize":
            result = {"protocolVersion": "2025-06-18", "capabilities": {"tools": {}},
                      "serverInfo": {"name": "local-transport-fixture", "version": "1"}}
        elif method == "tools/list":
            result = {"tools": [{"name": "echo", "description": "Echo test input",
                                  "inputSchema": {"type": "object", "properties": {"text": {"type": "string"}}}}]}
        elif method == "tools/call":
            result = {"content": [{"type": "text", "text": message["params"]["arguments"]["text"]}]}
        elif method == "ping":
            result = {}
        else:
            result = {}
        body = json.dumps({"jsonrpc": "2.0", "id": message["id"], "result": result}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


class ElevenLabsMcpTransportTests(unittest.TestCase):
    def exercise(self, runtime):
        adapter = ROOT / "node_modules" / "mcp-remote" / "dist" / "proxy.js"
        if not runtime or not adapter.is_file():
            self.skipTest("MCP transport runtime/dependency is not installed")
        base = ROOT / ".teamyra-desktop" / "mcp-transport-tests"
        base.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="case-", dir=base) as folder:
            self.assertTrue(Path(folder).resolve().is_relative_to(base.resolve()))
            remote = ThreadingHTTPServer(("127.0.0.1", 0), FakeRemote)
            thread = threading.Thread(target=remote.serve_forever, daemon=True)
            thread.start()
            try:
                spec = mcp_pool.register(folder, "elevenlabs-test", [
                    str(runtime), str(adapter), f"http://127.0.0.1:{remote.server_port}/mcp",
                    "--allow-http", "--transport", "http-only"],
                    env={"ELECTRON_RUN_AS_NODE": "1", "MCP_REMOTE_CONFIG_DIR": str(Path(folder) / "oauth")},
                    timeout_seconds=30)
                self.assertEqual(spec["name"], "elevenlabs-test")
                try:
                    listing = mcp_pool.list_tools(folder, "elevenlabs-test")
                except Exception as exc:
                    detail = mcp_pool.manager(folder).get("elevenlabs-test").status()["stderr_tail"]
                    raise AssertionError("Local MCP transport failed: " + "\n".join(detail)) from exc
                self.assertEqual([t["name"] for t in listing["tools"]], ["echo"])
                result = mcp_pool.call_tool(folder, "elevenlabs-test", "echo", {"text": "namaste"})
                self.assertEqual(result["result"]["content"][0]["text"], "namaste")
                self.assertEqual(listing["pid"], result["pid"], "The adapter process must be shared")
            finally:
                mcp_pool.shutdown(folder)
                remote.shutdown()
                remote.server_close()
                thread.join(timeout=2)

    def test_node_transport(self):
        self.exercise(shutil.which("node"))

    def test_electron_node_transport(self):
        runtime = ROOT / "node_modules" / "electron" / "dist" / ("electron.exe" if os.name == "nt" else "electron")
        self.exercise(runtime if runtime.is_file() else None)


if __name__ == "__main__":
    unittest.main()
