"""Shared external MCP stdio process pool for TEAMYRA.

The long-lived TEAMYRA HTTP MCP process owns this pool, so Claude/Codex/
Antigravity clients can share one external MCP subprocess instead of each
spawning duplicate copies.

Configuration is runtime-only under profiles/mcp-pool.json (profiles/ is
ignored by Git). Commands are argv arrays and are never executed through a shell.
"""
from __future__ import annotations

import json
import os
import queue
import re
import subprocess
import threading
import time
from collections import deque
from pathlib import Path

NAME_RE = re.compile(r"^[A-Za-z0-9._-]{1,64}$")
MAX_SERVERS = 64
MAX_STDERR_LINES = 120
MAX_TOOL_CACHE = 1000
DEFAULT_TIMEOUT = 30
CONFIG_NAME = "mcp-pool.json"


def _config_path(root):
    path = Path(root) / "profiles"
    path.mkdir(parents=True, exist_ok=True)
    return path / CONFIG_NAME


def _atomic_write(path, payload):
    path = Path(path)
    tmp = path.with_name(path.name + f".tmp-{os.getpid()}-{int(time.time()*1000)}")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, path)


def _empty_config():
    return {"version": 1, "servers": {}}


def load_config(root):
    path = _config_path(root)
    if not path.exists():
        return _empty_config()
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        raise ValueError(f"MCP pool config is unreadable: {exc}")
    if not isinstance(data, dict) or not isinstance(data.get("servers"), dict):
        raise ValueError("MCP pool config has invalid format")
    return data


def _normalize_name(name):
    value = str(name or "").strip()
    if not NAME_RE.fullmatch(value):
        raise ValueError("server name must match [A-Za-z0-9._-]{1,64}")
    return value


def _normalize_command(command):
    if not isinstance(command, list) or not command:
        raise ValueError("command must be a non-empty argv array")
    out = []
    for part in command:
        value = str(part)
        if not value or "\x00" in value:
            raise ValueError("command contains an invalid argv value")
        out.append(value)
    if len(out) > 64:
        raise ValueError("command has too many argv items")
    return out


def _normalize_env(env):
    if env is None:
        return {}
    if not isinstance(env, dict):
        raise ValueError("env must be an object")
    out = {}
    for key, value in env.items():
        key = str(key).strip()
        if not key or "\x00" in key or "=" in key:
            raise ValueError("env contains an invalid variable name")
        value = str(value)
        if "\x00" in value:
            raise ValueError("env contains an invalid value")
        out[key] = value
    return out


def register(root, name, command, cwd=None, env=None, enabled=True, timeout_seconds=DEFAULT_TIMEOUT):
    name = _normalize_name(name)
    command = _normalize_command(command)
    cwd_value = str(Path(cwd).resolve()) if cwd else None
    if cwd_value and not Path(cwd_value).exists():
        raise ValueError(f"cwd not found: {cwd_value}")
    timeout = max(2, min(int(timeout_seconds or DEFAULT_TIMEOUT), 300))
    data = load_config(root)
    servers = data["servers"]
    if name not in servers and len(servers) >= MAX_SERVERS:
        raise ValueError(f"MCP pool server limit reached ({MAX_SERVERS})")
    servers[name] = {
        "command": command,
        "cwd": cwd_value,
        "env": _normalize_env(env),
        "enabled": bool(enabled),
        "timeout_seconds": timeout,
        "updated_at": time.time(),
    }
    _atomic_write(_config_path(root), data)
    manager(root).drop(name)
    return public_spec(name, servers[name])


def remove(root, name):
    name = _normalize_name(name)
    data = load_config(root)
    if name not in data["servers"]:
        raise ValueError(f"no such pooled MCP server: {name}")
    manager(root).drop(name)
    del data["servers"][name]
    _atomic_write(_config_path(root), data)
    return {"ok": True, "name": name}


def public_spec(name, spec):
    command = list(spec.get("command") or [])
    return {
        "name": name,
        "command_executable": command[0] if command else None,
        "argv_count": len(command),
        "cwd": spec.get("cwd"),
        "enabled": spec.get("enabled", True) is not False,
        "timeout_seconds": int(spec.get("timeout_seconds") or DEFAULT_TIMEOUT),
        "env_keys": sorted((spec.get("env") or {}).keys()),
        "updated_at": spec.get("updated_at"),
    }


class PooledMCPClient:
    def __init__(self, name, spec):
        self.name = name
        self.spec = dict(spec)
        self.process = None
        self.started_at = None
        self.initialized_at = None
        self.restart_count = 0
        self.request_count = 0
        self.last_error = None
        self.last_used_at = None
        self.tools = []
        self._next_id = 1
        self._pending = {}
        self._pending_lock = threading.Lock()
        self._write_lock = threading.Lock()
        self._lifecycle_lock = threading.RLock()
        self._stderr = deque(maxlen=MAX_STDERR_LINES)
        self._stdout_thread = None
        self._stderr_thread = None

    def alive(self):
        return self.process is not None and self.process.poll() is None

    def _merged_env(self):
        env = os.environ.copy()
        env.update({str(k): str(v) for k, v in (self.spec.get("env") or {}).items()})
        return env

    def start(self):
        with self._lifecycle_lock:
            if self.alive() and self.initialized_at:
                return self
            self.stop()
            command = _normalize_command(self.spec.get("command"))
            cwd = self.spec.get("cwd")
            if cwd and not Path(cwd).exists():
                raise RuntimeError(f"pooled MCP cwd no longer exists: {cwd}")
            flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
            try:
                self.process = subprocess.Popen(
                    command,
                    cwd=cwd or None,
                    env=self._merged_env(),
                    stdin=subprocess.PIPE,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    bufsize=1,
                    shell=False,
                    creationflags=flags,
                )
            except Exception as exc:
                self.process = None
                self.last_error = str(exc)
                raise RuntimeError(f"could not start pooled MCP server {self.name}: {exc}") from exc

            self.started_at = time.time()
            self.initialized_at = None
            self.last_error = None
            self._stdout_thread = threading.Thread(target=self._stdout_loop, daemon=True)
            self._stderr_thread = threading.Thread(target=self._stderr_loop, daemon=True)
            self._stdout_thread.start()
            self._stderr_thread.start()

            timeout = int(self.spec.get("timeout_seconds") or DEFAULT_TIMEOUT)
            init = self.request(
                "initialize",
                {
                    "protocolVersion": "2025-06-18",
                    "capabilities": {},
                    "clientInfo": {"name": "teamyra-mcp-pool", "version": "0.1"},
                },
                timeout=timeout,
                ensure_started=False,
            )
            if not isinstance(init, dict) or "protocolVersion" not in init:
                self.stop()
                raise RuntimeError(f"pooled MCP server {self.name} returned an invalid initialize result")
            self.notify("notifications/initialized", {})
            listing = self.request("tools/list", {}, timeout=timeout, ensure_started=False)
            tools = listing.get("tools") if isinstance(listing, dict) else None
            if not isinstance(tools, list):
                self.stop()
                raise RuntimeError(f"pooled MCP server {self.name} returned an invalid tools/list result")
            self.tools = tools[:MAX_TOOL_CACHE]
            self.initialized_at = time.time()
            return self

    def _stdout_loop(self):
        proc = self.process
        stream = getattr(proc, "stdout", None)
        if stream is None:
            return
        try:
            for raw in stream:
                line = raw.strip()
                if not line:
                    continue
                try:
                    msg = json.loads(line)
                except Exception:
                    continue
                if not isinstance(msg, dict):
                    continue
                msg_id = msg.get("id")
                if msg_id is not None:
                    with self._pending_lock:
                        target = self._pending.get(msg_id)
                    if target is not None:
                        target.put(msg)
                    elif msg.get("method"):
                        self._reply_method_not_found(msg_id, msg.get("method"))
        finally:
            reason = f"pooled MCP server exited with code {proc.poll()}"
            if self.process is proc:
                self.last_error = reason
            with self._pending_lock:
                pending = list(self._pending.values())
            for target in pending:
                try:
                    target.put_nowait({"error": {"code": -32000, "message": reason}})
                except queue.Full:
                    pass

    def _stderr_loop(self):
        proc = self.process
        stream = getattr(proc, "stderr", None)
        if stream is None:
            return
        try:
            for raw in stream:
                line = raw.rstrip("\r\n")
                if line:
                    self._stderr.append(line[-2000:])
        except Exception:
            return

    def _send(self, payload):
        if not self.alive() or self.process.stdin is None:
            raise RuntimeError(f"pooled MCP server {self.name} is not running")
        data = json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n"
        with self._write_lock:
            self.process.stdin.write(data)
            self.process.stdin.flush()

    def _reply_method_not_found(self, msg_id, method):
        try:
            self._send({
                "jsonrpc": "2.0",
                "id": msg_id,
                "error": {"code": -32601, "message": f"TEAMYRA pool does not implement client method {method}"},
            })
        except Exception:
            pass

    def notify(self, method, params=None):
        self._send({"jsonrpc": "2.0", "method": method, "params": params or {}})

    def request(self, method, params=None, timeout=None, ensure_started=True):
        if ensure_started:
            self.start()
        if not self.alive():
            raise RuntimeError(f"pooled MCP server {self.name} is not running")
        with self._pending_lock:
            request_id = self._next_id
            self._next_id += 1
            target = queue.Queue(maxsize=1)
            self._pending[request_id] = target
        try:
            self.request_count += 1
            self.last_used_at = time.time()
            self._send({
                "jsonrpc": "2.0",
                "id": request_id,
                "method": method,
                "params": params or {},
            })
            wait = max(1, min(int(timeout or self.spec.get("timeout_seconds") or DEFAULT_TIMEOUT), 300))
            try:
                msg = target.get(timeout=wait)
            except queue.Empty as exc:
                self.last_error = f"request timeout: {method}"
                raise TimeoutError(f"pooled MCP request timed out after {wait}s: {self.name}.{method}") from exc
            if isinstance(msg, dict) and msg.get("error") is not None:
                error = msg.get("error") or {}
                message = error.get("message") if isinstance(error, dict) else str(error)
                self.last_error = str(message)
                raise RuntimeError(f"{self.name} MCP error: {message}")
            result = msg.get("result") if isinstance(msg, dict) else None
            self.last_error = None
            return result
        finally:
            with self._pending_lock:
                self._pending.pop(request_id, None)

    def refresh_tools(self):
        result = self.request("tools/list", {})
        tools = result.get("tools") if isinstance(result, dict) else None
        if not isinstance(tools, list):
            raise RuntimeError(f"pooled MCP server {self.name} returned invalid tools/list")
        self.tools = tools[:MAX_TOOL_CACHE]
        return self.tools

    def call_tool(self, tool_name, arguments=None, timeout=None):
        tool_name = str(tool_name or "").strip()
        if not tool_name:
            raise ValueError("tool_name is required")
        self.start()
        known = {str(item.get("name")) for item in self.tools if isinstance(item, dict)}
        if tool_name not in known:
            self.refresh_tools()
            known = {str(item.get("name")) for item in self.tools if isinstance(item, dict)}
        if tool_name not in known:
            raise ValueError(f"pooled MCP server {self.name} has no tool named {tool_name}")
        return self.request(
            "tools/call",
            {"name": tool_name, "arguments": arguments or {}},
            timeout=timeout,
        )

    def stop(self):
        with self._lifecycle_lock:
            proc = self.process
            self.process = None
            self.initialized_at = None
            self.tools = []
            if proc is None:
                return
            try:
                if proc.stdin:
                    proc.stdin.close()
            except Exception:
                pass
            try:
                if proc.poll() is None:
                    proc.terminate()
                    proc.wait(timeout=2)
            except Exception:
                try:
                    proc.kill()
                except Exception:
                    pass
            for stream_name in ("stdout", "stderr"):
                try:
                    stream = getattr(proc, stream_name, None)
                    if stream:
                        stream.close()
                except Exception:
                    pass
            current = threading.current_thread()
            for thread in (self._stdout_thread, self._stderr_thread):
                if thread is not None and thread is not current:
                    try:
                        thread.join(timeout=0.75)
                    except Exception:
                        pass
            self._stdout_thread = None
            self._stderr_thread = None

    def restart(self):
        with self._lifecycle_lock:
            self.restart_count += 1
            self.stop()
            self.start()
            return self.status()

    def status(self):
        pid = self.process.pid if self.alive() else None
        return {
            **public_spec(self.name, self.spec),
            "running": self.alive(),
            "pid": pid,
            "started_at": self.started_at,
            "initialized_at": self.initialized_at,
            "restart_count": self.restart_count,
            "request_count": self.request_count,
            "last_used_at": self.last_used_at,
            "last_error": self.last_error,
            "stderr_tail": list(self._stderr)[-12:],
            "tool_count": len(self.tools),
        }


class MCPPoolManager:
    def __init__(self, root):
        self.root = Path(root).resolve()
        self._clients = {}
        self._lock = threading.RLock()

    def _spec(self, name):
        name = _normalize_name(name)
        spec = load_config(self.root)["servers"].get(name)
        if not isinstance(spec, dict):
            raise ValueError(f"no such pooled MCP server: {name}")
        if spec.get("enabled", True) is False:
            raise ValueError(f"pooled MCP server is disabled: {name}")
        return name, spec

    def get(self, name):
        name, spec = self._spec(name)
        with self._lock:
            client = self._clients.get(name)
            if client is None or client.spec != spec:
                if client is not None:
                    client.stop()
                client = PooledMCPClient(name, spec)
                self._clients[name] = client
            return client

    def drop(self, name):
        with self._lock:
            client = self._clients.pop(str(name), None)
        if client is not None:
            client.stop()

    def restart(self, name):
        return self.get(name).restart()

    def status(self):
        config = load_config(self.root)
        rows = []
        with self._lock:
            clients = dict(self._clients)
        for name, spec in sorted(config["servers"].items()):
            client = clients.get(name)
            if client is not None and client.spec == spec:
                rows.append(client.status())
            else:
                rows.append({
                    **public_spec(name, spec),
                    "running": False,
                    "pid": None,
                    "started_at": None,
                    "initialized_at": None,
                    "restart_count": 0,
                    "request_count": 0,
                    "last_used_at": None,
                    "last_error": None,
                    "stderr_tail": [],
                    "tool_count": 0,
                })
        return {"servers": rows, "count": len(rows)}

    def tools(self, name, refresh=False):
        client = self.get(name)
        client.start()
        tools = client.refresh_tools() if refresh else list(client.tools)
        return {
            "server": name,
            "pid": client.process.pid if client.alive() else None,
            "tools": tools,
            "count": len(tools),
        }

    def call(self, name, tool_name, arguments=None, timeout=None):
        client = self.get(name)
        result = client.call_tool(tool_name, arguments or {}, timeout=timeout)
        return {
            "server": name,
            "tool": tool_name,
            "pid": client.process.pid if client.alive() else None,
            "result": result,
        }

    def shutdown(self):
        with self._lock:
            clients = list(self._clients.values())
            self._clients.clear()
        for client in clients:
            client.stop()


_MANAGERS = {}
_MANAGERS_LOCK = threading.Lock()


def manager(root):
    key = str(Path(root).resolve()).lower()
    with _MANAGERS_LOCK:
        value = _MANAGERS.get(key)
        if value is None:
            value = MCPPoolManager(root)
            _MANAGERS[key] = value
        return value


def list_servers(root):
    return manager(root).status()


def list_tools(root, name, refresh=False):
    return manager(root).tools(name, refresh=refresh)


def call_tool(root, name, tool_name, arguments=None, timeout=None):
    return manager(root).call(name, tool_name, arguments, timeout)


def restart(root, name):
    return manager(root).restart(name)


def shutdown(root):
    return manager(root).shutdown()
