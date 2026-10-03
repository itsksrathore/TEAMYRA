import http.client
import json
import sys
import tempfile
import threading
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "bridge"))

import http_mcp
import server


class HttpMcpTests(unittest.TestCase):
    def setUp(self):
        self.httpd = http_mcp.create_server("127.0.0.1", 0)
        self.port = self.httpd.server_address[1]
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(timeout=3)

    def request(self, method, path="/mcp", payload=None, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        body = None if payload is None else json.dumps(payload).encode("utf-8")
        request_headers = dict(headers or {})
        if body is not None:
            request_headers.setdefault("Content-Type", "application/json")
            request_headers.setdefault("Accept", "application/json, text/event-stream")
        conn.request(method, path, body=body, headers=request_headers)
        response = conn.getresponse()
        raw = response.read()
        data = json.loads(raw.decode("utf-8")) if raw else None
        headers_out = dict(response.getheaders())
        status = response.status
        conn.close()
        return status, headers_out, data

    def test_initialize_negotiates_supported_handshake_version(self):
        status, headers, data = self.request("POST", payload={
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2026-07-28",
                "capabilities": {},
                "clientInfo": {"name": "test", "version": "1"},
            },
        })
        self.assertEqual(status, 200)
        self.assertEqual(data["result"]["protocolVersion"], server.MCP_DEFAULT_PROTOCOL)
        self.assertEqual(headers["MCP-Protocol-Version"], server.MCP_DEFAULT_PROTOCOL)
        self.assertEqual(data["result"]["serverInfo"]["name"], "teamyra")

    def test_tools_list_and_namespaced_call(self):
        headers = {"MCP-Protocol-Version": server.MCP_DEFAULT_PROTOCOL}
        status, _, listing = self.request("POST", payload={
            "jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {},
        }, headers=headers)
        self.assertEqual(status, 200)
        names = {tool["name"] for tool in listing["result"]["tools"]}
        self.assertIn("teamyra.test_run", names)
        self.assertIn("test_run", names)

        with tempfile.TemporaryDirectory() as td:
            status, _, called = self.request("POST", payload={
                "jsonrpc": "2.0",
                "id": 3,
                "method": "tools/call",
                "params": {
                    "name": "teamyra.test_run",
                    "arguments": {
                        "project_path": td,
                        "tests": [{
                            "name": "http-smoke",
                            "argv": [sys.executable, "-c", "print('TEAMYRA_HTTP_OK')"],
                            "timeout_seconds": 10,
                        }],
                    },
                },
            }, headers=headers)
        self.assertEqual(status, 200)
        self.assertFalse(called["result"]["isError"])
        result = json.loads(called["result"]["content"][0]["text"])
        self.assertTrue(result["ok"])
        self.assertIn("TEAMYRA_HTTP_OK", result["steps"][0]["stdout_tail"])

    def test_notification_returns_202(self):
        status, _, data = self.request("POST", payload={
            "jsonrpc": "2.0",
            "method": "notifications/initialized",
            "params": {},
        })
        self.assertEqual(status, 202)
        self.assertIsNone(data)

    def test_get_is_405_in_json_response_mode(self):
        status, headers, data = self.request("GET")
        self.assertEqual(status, 405)
        self.assertEqual(headers.get("Allow"), "POST")
        self.assertIn("POST JSON response mode", data["error"]["message"])

    def test_invalid_accept_is_rejected(self):
        status, _, data = self.request("POST", payload={
            "jsonrpc": "2.0", "id": 4, "method": "ping",
        }, headers={"Accept": "application/json"})
        self.assertEqual(status, 406)
        self.assertIn("Accept", data["error"]["message"])

    def test_invalid_host_header_is_rejected(self):
        status, _, data = self.request("POST", payload={
            "jsonrpc": "2.0", "id": 5, "method": "ping",
        }, headers={"Host": "evil.example", "Accept": "application/json, text/event-stream"})
        self.assertEqual(status, 421)
        self.assertIn("Host", data["error"]["message"])

    def test_unsupported_protocol_header_is_rejected(self):
        status, _, data = self.request("POST", payload={
            "jsonrpc": "2.0", "id": 6, "method": "ping",
        }, headers={
            "MCP-Protocol-Version": "2026-07-28",
            "Accept": "application/json, text/event-stream",
        })
        self.assertEqual(status, 400)
        self.assertIn("Unsupported MCP-Protocol-Version", data["error"]["message"])


if __name__ == "__main__":
    unittest.main()
