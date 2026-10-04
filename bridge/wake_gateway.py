"""Lightweight localhost wake gateway for TEAMYRA MCP.

The gateway owns public localhost port 8787 and lazily starts the full TEAMYRA
HTTP MCP core on an internal port only when an MCP POST arrives. The heavy core
is stopped after an idle period when no TEAMYRA jobs are active.
"""
from __future__ import annotations

import http.client
import json
import os
import secrets
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

PUBLIC_HOST = "127.0.0.1"
PUBLIC_PORT = 8787
BACKEND_HOST = "127.0.0.1"
BACKEND_PORT = 8788
MCP_PATH = "/mcp"
HEALTH_PATH = "/healthz"
SHUTDOWN_PATH = "/__teamyra_shutdown"
DEFAULT_IDLE_SECONDS = 600
MAX_BODY = 4 * 1024 * 1024
ACTIVE_JOB_STATES = {"queued", "starting", "running", "waiting", "waiting_for_desktop"}


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


def process_alive(pid):
    try:
        pid = int(pid or 0)
    except Exception:
        return False
    if pid <= 0:
        return False
    if os.name == "nt":
        try:
            import ctypes
            handle = ctypes.windll.kernel32.OpenProcess(0x1000, False, pid)
            if not handle:
                return False
            try:
                code = ctypes.c_ulong()
                if not ctypes.windll.kernel32.GetExitCodeProcess(handle, ctypes.byref(code)):
                    return False
                return code.value == 259
            finally:
                ctypes.windll.kernel32.CloseHandle(handle)
        except Exception:
            return False
    try:
        os.kill(pid, 0)
        return True
    except Exception:
        return False


def active_jobs(runtime_root, max_age=600):
    jobs = Path(runtime_root) / "jobs"
    if not jobs.exists():
        return False
    now = time.time()
    for meta in jobs.glob("*/meta.json"):
        try:
            data = json.loads(meta.read_text(encoding="utf-8"))
        except Exception:
            continue
        if str(data.get("state") or "").lower() not in ACTIVE_JOB_STATES:
            continue
        if process_alive(data.get("runner_pid")) or process_alive(data.get("worker_pid")):
            return True
        try:
            heartbeat = float(data.get("heartbeat_at") or data.get("updated") or data.get("started") or data.get("created") or 0)
        except Exception:
            heartbeat = 0
        if heartbeat > 0 and now - heartbeat <= max(30, int(max_age)):
            return True
    return False


class BackendManager:
    def __init__(self, runtime_root, bridge_dir, idle_seconds=None, backend_port=BACKEND_PORT):
        self.runtime_root = Path(runtime_root).resolve()
        self.bridge_dir = Path(bridge_dir).resolve()
        self.backend_port = int(backend_port)
        configured = idle_seconds if idle_seconds is not None else os.environ.get("TEAMYRA_IDLE_SECONDS", DEFAULT_IDLE_SECONDS)
        self.idle_seconds = max(30, int(configured))
        self.process = None
        self.shutdown_token = ""
        self.last_activity = time.monotonic()
        self.active_requests = 0
        self.lock = threading.RLock()
        self.starting = threading.Condition(self.lock)
        self.start_in_progress = False
        self.stop_event = threading.Event()
        self.monitor = threading.Thread(target=self._monitor_loop, daemon=True)

    def start_monitor(self):
        if not self.monitor.is_alive():
            self.monitor.start()

    def touch(self):
        with self.lock:
            self.last_activity = time.monotonic()

    def backend_alive(self):
        with self.lock:
            return self.process is not None and self.process.poll() is None

    def status(self):
        with self.lock:
            running = self.process is not None and self.process.poll() is None
            idle_for = max(0, int(time.monotonic() - self.last_activity))
            pid = self.process.pid if running else None
        return {
            "service": "teamyra-wake-gateway",
            "gateway_running": True,
            "backend_running": running,
            "backend_pid": pid,
            "idle_seconds": self.idle_seconds,
            "idle_for_seconds": idle_for,
            "active_jobs": active_jobs(self.runtime_root, self.idle_seconds),
        }

    def _backend_command(self):
        frozen_exe = os.environ.get("TEAMYRA_CORE_EXE")
        if frozen_exe or getattr(sys, "frozen", False):
            return [str(frozen_exe or sys.executable), "mcp", "http", "--host", BACKEND_HOST, "--port", str(self.backend_port)]
        return [
            sys.executable,
            str(self.bridge_dir / "teamyra_cli.py"),
            "mcp",
            "http",
            "--host",
            BACKEND_HOST,
            "--port",
            str(self.backend_port),
        ]

    def _backend_ready(self, timeout=0.8):
        try:
            conn = http.client.HTTPConnection(BACKEND_HOST, self.backend_port, timeout=timeout)
            payload = _json_bytes({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": "2025-11-25",
                    "capabilities": {},
                    "clientInfo": {"name": "teamyra-wake-gateway", "version": "0.1"},
                },
            })
            conn.request("POST", MCP_PATH, body=payload, headers={
                "Content-Type": "application/json",
                "Accept": "application/json, text/event-stream",
            })
            response = conn.getresponse()
            raw = response.read()
            conn.close()
            if response.status != 200:
                return False
            data = json.loads(raw.decode("utf-8"))
            return data.get("result", {}).get("serverInfo", {}).get("name") == "teamyra"
        except Exception:
            return False

    def ensure_backend(self):
        with self.starting:
            if self.process is not None and self.process.poll() is None:
                self.last_activity = time.monotonic()
                return
            if self.start_in_progress:
                deadline = time.monotonic() + 20
                while self.start_in_progress and time.monotonic() < deadline:
                    self.starting.wait(timeout=0.25)
                if self.process is not None and self.process.poll() is None:
                    self.last_activity = time.monotonic()
                    return
                raise RuntimeError("TEAMYRA backend failed to start")
            self.start_in_progress = True

        try:
            token = secrets.token_urlsafe(32)
            env = os.environ.copy()
            env["TEAMYRA_ROOT"] = str(self.runtime_root)
            env["TEAMYRA_INTERNAL_SHUTDOWN_TOKEN"] = token
            flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
            proc = subprocess.Popen(
                self._backend_command(),
                cwd=str(self.bridge_dir.parent),
                env=env,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                creationflags=flags,
            )
            with self.lock:
                self.process = proc
                self.shutdown_token = token
                self.last_activity = time.monotonic()

            deadline = time.monotonic() + 15
            while time.monotonic() < deadline:
                if proc.poll() is not None:
                    raise RuntimeError(f"TEAMYRA backend exited with code {proc.returncode}")
                if self._backend_ready():
                    return
                time.sleep(0.2)
            raise RuntimeError("TEAMYRA backend did not become ready")
        except Exception:
            self._force_clear_backend()
            raise
        finally:
            with self.starting:
                self.start_in_progress = False
                self.starting.notify_all()

    def begin_request(self):
        self.ensure_backend()
        with self.lock:
            self.active_requests += 1
            self.last_activity = time.monotonic()

    def end_request(self):
        with self.lock:
            self.active_requests = max(0, self.active_requests - 1)
            self.last_activity = time.monotonic()

    def _force_clear_backend(self):
        with self.lock:
            proc = self.process
            self.process = None
            self.shutdown_token = ""
        if proc is not None and proc.poll() is None:
            try:
                proc.kill()
            except Exception:
                pass

    def stop_backend(self):
        with self.lock:
            proc = self.process
            token = self.shutdown_token
            if proc is None or proc.poll() is not None:
                self.process = None
                self.shutdown_token = ""
                return False
            if self.active_requests:
                return False

        try:
            conn = http.client.HTTPConnection(BACKEND_HOST, self.backend_port, timeout=2)
            conn.request("POST", SHUTDOWN_PATH, body=b"", headers={"X-Teamyra-Shutdown-Token": token})
            response = conn.getresponse()
            response.read()
            conn.close()
        except Exception:
            pass

        try:
            proc.wait(timeout=5)
        except Exception:
            try:
                proc.terminate()
                proc.wait(timeout=2)
            except Exception:
                try:
                    proc.kill()
                except Exception:
                    pass
        with self.lock:
            if self.process is proc:
                self.process = None
                self.shutdown_token = ""
        return True

    def _monitor_loop(self):
        while not self.stop_event.wait(5):
            with self.lock:
                proc = self.process
                active_requests = self.active_requests
                idle_for = time.monotonic() - self.last_activity
            if proc is None:
                continue
            if proc.poll() is not None:
                with self.lock:
                    if self.process is proc:
                        self.process = None
                        self.shutdown_token = ""
                continue
            if active_requests or idle_for < self.idle_seconds:
                continue
            if active_jobs(self.runtime_root, self.idle_seconds):
                self.touch()
                continue
            self.stop_backend()

    def close(self):
        self.stop_event.set()
        self.stop_backend()


class WakeServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address, handler, manager):
        super().__init__(address, handler)
        self.manager = manager


class Handler(BaseHTTPRequestHandler):
    server_version = "TEAMYRA-Wake/0.1"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        return

    def _send(self, status, body=b"", headers=None):
        self.send_response(status)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        if body:
            self.wfile.write(body)

    def _reject_host(self):
        if _allowed_host(self.headers.get("Host")):
            return False
        body = _json_bytes({"error": "Invalid Host header"})
        self._send(421, body, {"Content-Type": "application/json; charset=utf-8"})
        return True

    def do_GET(self):
        if self._reject_host():
            return
        if self.path == HEALTH_PATH:
            body = _json_bytes(self.server.manager.status())
            self._send(200, body, {"Content-Type": "application/json; charset=utf-8"})
            return
        if self.path == MCP_PATH:
            body = _json_bytes({"jsonrpc": "2.0", "id": None, "error": {"code": -32000, "message": "TEAMYRA HTTP MCP uses POST JSON response mode"}})
            self._send(405, body, {"Content-Type": "application/json; charset=utf-8", "Allow": "POST"})
            return
        self._send(404)

    def do_OPTIONS(self):
        if self._reject_host():
            return
        if self.path != MCP_PATH:
            self._send(404)
            return
        self._send(204, headers={"Allow": "POST, GET, DELETE, OPTIONS"})

    def do_DELETE(self):
        if self._reject_host():
            return
        if self.path != MCP_PATH:
            self._send(404)
            return
        body = _json_bytes({"jsonrpc": "2.0", "id": None, "error": {"code": -32000, "message": "Stateless TEAMYRA HTTP MCP has no session to delete"}})
        self._send(405, body, {"Content-Type": "application/json; charset=utf-8", "Allow": "POST"})

    def do_POST(self):
        if self._reject_host():
            return
        if self.path != MCP_PATH:
            self._send(404)
            return
        try:
            length = int(self.headers.get("Content-Length") or "0")
        except ValueError:
            length = -1
        if length < 0 or length > MAX_BODY:
            self._send(413)
            return
        body = self.rfile.read(length)

        manager = self.server.manager
        try:
            manager.begin_request()
            conn = http.client.HTTPConnection(BACKEND_HOST, manager.backend_port, timeout=310)
            headers = {
                key: value for key, value in self.headers.items()
                if key.lower() not in {"host", "connection", "content-length"}
            }
            headers["Host"] = f"{BACKEND_HOST}:{manager.backend_port}"
            headers["Content-Length"] = str(len(body))
            conn.request("POST", MCP_PATH, body=body, headers=headers)
            response = conn.getresponse()
            response_body = response.read()
            response_headers = {}
            for key, value in response.getheaders():
                if key.lower() in {"content-type", "mcp-protocol-version", "allow"}:
                    response_headers[key] = value
            status = response.status
            conn.close()
            self._send(status, response_body, response_headers)
        except Exception as exc:
            payload = _json_bytes({
                "jsonrpc": "2.0",
                "id": None,
                "error": {"code": -32603, "message": "TEAMYRA wake failed", "data": str(exc)},
            })
            self._send(503, payload, {"Content-Type": "application/json; charset=utf-8"})
        finally:
            manager.end_request()


def create_server(host=PUBLIC_HOST, port=PUBLIC_PORT, runtime_root=None, bridge_dir=None, idle_seconds=None, backend_port=BACKEND_PORT):
    if str(host).lower() not in {"127.0.0.1", "localhost"}:
        raise ValueError("TEAMYRA wake gateway is localhost-only")
    bridge_dir = Path(bridge_dir or Path(__file__).resolve().parent)
    runtime_root = Path(runtime_root or os.environ.get("TEAMYRA_ROOT") or bridge_dir.parent)
    manager = BackendManager(runtime_root, bridge_dir, idle_seconds=idle_seconds, backend_port=backend_port)
    server = WakeServer((host, int(port)), Handler, manager)
    manager.start_monitor()
    return server


def serve(host=PUBLIC_HOST, port=PUBLIC_PORT):
    server = create_server(host, port)
    actual_host, actual_port = server.server_address[:2]
    print(f"TEAMYRA wake gateway listening on http://{actual_host}:{actual_port}{MCP_PATH}", flush=True)
    try:
        server.serve_forever(poll_interval=0.25)
    except KeyboardInterrupt:
        pass
    finally:
        server.manager.close()
        server.server_close()


if __name__ == "__main__":
    serve()
