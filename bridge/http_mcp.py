"""Localhost-only stateless MCP Streamable HTTP transport for TEAMYRA.

This transport intentionally uses JSON response mode and reuses server.handle()
so stdio and HTTP expose the exact same TEAMYRA tool surface.
"""
import json
import os
import socket
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

import server


MAX_BODY = 4 * 1024 * 1024
MCP_PATH = "/mcp"
SHUTDOWN_PATH = "/__teamyra_shutdown"


def _json_bytes(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def _host_name(value):
    raw = str(value or "").strip()
    if not raw:
        return ""
    try:
        parsed = urlsplit("//" + raw)
        return (parsed.hostname or "").lower()
    except Exception:
        return ""


def _allowed_host(value):
    return _host_name(value) in {"127.0.0.1", "localhost", "::1"}


def _accepts_mcp(value):
    raw = str(value or "").lower()
    if not raw or raw.strip() == "*/*":
        return True
    return "application/json" in raw and "text/event-stream" in raw


def secrets_compare(expected, supplied):
    import hmac
    try:
        return hmac.compare_digest(str(expected), str(supplied))
    except Exception:
        return False


def _json_error(req_id, code, message, data=None):
    error = {"code": int(code), "message": str(message)}
    if data is not None:
        error["data"] = data
    return {"jsonrpc": "2.0", "id": req_id, "error": error}


class TeamyraHTTPServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = os.name != "nt"

    def server_bind(self):
        if os.name == "nt":
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


class Handler(BaseHTTPRequestHandler):
    server_version = "TEAMYRA-MCP/" + server.MCP_SERVER_VERSION
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        # Keep MCP stdout/stderr clean when embedded by other launchers.
        return

    def _send_json(self, status, payload, extra_headers=None):
        body = _json_bytes(payload) if payload is not None else b""
        self.send_response(status)
        if payload is not None:
            self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        for key, value in (extra_headers or {}).items():
            self.send_header(str(key), str(value))
        self.end_headers()
        if body:
            self.wfile.write(body)

    def _reject_host(self):
        if _allowed_host(self.headers.get("Host")):
            return False
        self._send_json(421, _json_error(None, -32000, "Invalid Host header"))
        return True

    def do_GET(self):
        if self.path != MCP_PATH:
            self._send_json(404, _json_error(None, -32601, "Not found"))
            return
        if self._reject_host():
            return
        self._send_json(
            405,
            _json_error(None, -32000, "TEAMYRA HTTP MCP uses POST JSON response mode"),
            {"Allow": "POST"},
        )

    def do_DELETE(self):
        if self.path != MCP_PATH:
            self._send_json(404, _json_error(None, -32601, "Not found"))
            return
        if self._reject_host():
            return
        self._send_json(
            405,
            _json_error(None, -32000, "Stateless TEAMYRA HTTP MCP has no session to delete"),
            {"Allow": "POST"},
        )

    def do_OPTIONS(self):
        if self.path != MCP_PATH:
            self.send_response(404)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if self._reject_host():
            return
        self.send_response(204)
        self.send_header("Allow", "POST, GET, DELETE, OPTIONS")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_POST(self):
        try:
            length = int(self.headers.get("Content-Length") or "0")
        except ValueError:
            length = -1
        if length < 0 or length > MAX_BODY:
            self._send_json(413, _json_error(None, -32600, "Request body is too large"))
            return

        # Consume the bounded body before an early rejection. Closing a socket
        # with unread request bytes can reset it on Windows and lose the error
        # response. Reading bytes does not dispatch or parse the request.
        body = self.rfile.read(length)
        if self.path == SHUTDOWN_PATH:
            if self._reject_host():
                return
            expected = str(os.environ.get("TEAMYRA_INTERNAL_SHUTDOWN_TOKEN") or "")
            supplied = str(self.headers.get("X-Teamyra-Shutdown-Token") or "")
            if not expected or not secrets_compare(expected, supplied):
                self._send_json(403, _json_error(None, -32000, "Forbidden"))
                return
            self._send_json(202, {"ok": True})
            threading.Thread(target=self.server.shutdown, daemon=True).start()
            return
        if self.path != MCP_PATH:
            self._send_json(404, _json_error(None, -32601, "Not found"))
            return
        if self._reject_host():
            return

        content_type = str(self.headers.get("Content-Type") or "").lower()
        if "application/json" not in content_type:
            self._send_json(415, _json_error(None, -32600, "Content-Type must be application/json"))
            return
        if not _accepts_mcp(self.headers.get("Accept")):
            self._send_json(
                406,
                _json_error(None, -32600, "Accept must include application/json and text/event-stream"),
            )
            return

        try:
            msg = json.loads(body.decode("utf-8"))
        except Exception as exc:
            self._send_json(400, _json_error(None, -32700, "Invalid JSON", str(exc)))
            return
        if not isinstance(msg, dict):
            self._send_json(400, _json_error(None, -32600, "JSON-RPC request must be an object"))
            return

        method = msg.get("method")
        requested_version = self.headers.get("MCP-Protocol-Version")
        if requested_version and requested_version not in server.MCP_SUPPORTED_PROTOCOLS:
            self._send_json(
                400,
                _json_error(msg.get("id"), -32600, "Unsupported MCP-Protocol-Version", requested_version),
            )
            return

        # Initialize negotiates the protocol in-band. Later stateless requests may
        # carry MCP-Protocol-Version but do not require a server-side session.
        try:
            response = server.handle(msg)
        except Exception as exc:
            response = _json_error(msg.get("id"), -32603, "Internal error", str(exc))

        if response is None:
            self.send_response(202)
            self.send_header("Content-Length", "0")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Connection", "close")
            self.end_headers()
            return

        headers = {}
        if method == "initialize":
            headers["MCP-Protocol-Version"] = response["result"]["protocolVersion"]
        self._send_json(200, response, headers)


def create_server(host="127.0.0.1", port=8787):
    if str(host).lower() not in {"127.0.0.1", "localhost"}:
        raise ValueError("TEAMYRA HTTP MCP is localhost-only in this build")
    return TeamyraHTTPServer((host, int(port)), Handler)


def serve(host="127.0.0.1", port=8787):
    recovery_report = server.recovery.recover_all(server.ROOT, server.BRIDGE, server.PYTHON)
    if recovery_report.get("errors"):
        print(
            "TEAMYRA recovery scan completed with "
            f"{len(recovery_report['errors'])} error(s)",
            file=__import__("sys").stderr,
            flush=True,
        )
    httpd = create_server(host, port)
    actual_host, actual_port = httpd.server_address[:2]
    print(
        f"TEAMYRA HTTP MCP listening on http://{actual_host}:{actual_port}{MCP_PATH}",
        flush=True,
    )
    try:
        httpd.serve_forever(poll_interval=0.25)
    except KeyboardInterrupt:
        pass
    finally:
        try:
            server.mcp_pool.shutdown(server.ROOT)
        except Exception:
            pass
        httpd.server_close()


if __name__ == "__main__":
    serve()
