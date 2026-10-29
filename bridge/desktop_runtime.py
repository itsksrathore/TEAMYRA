"""Cold-start a hidden TEAMYRA desktop only for desktop-dependent requests."""
from contextlib import contextmanager
import json
import os
from pathlib import Path
import subprocess
import threading
import time

from wake_gateway import process_alive

_START_LOCK = threading.Lock()

def _read(path):
    try:
        value = json.loads(Path(path).read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}

def desktop_ready(root):
    root = Path(root).resolve()
    state = _read(root / ".teamyra-desktop" / "runtime.json")
    try:
        age = time.time() - float(state.get("updated_at") or 0)
    except (ValueError, TypeError):
        return False
    return (state.get("ready") is True and state.get("protocol") == 1 and
            str(state.get("runtime_root") or "").lower() == str(root).lower() and
            0 <= age < 30 and process_alive(state.get("pid")))

def desktop_command(root, env=None):
    root = Path(root).resolve()
    env = os.environ if env is None else env
    explicit = env.get("TEAMYRA_DESKTOP_EXE")
    if explicit:
        binary = Path(explicit).expanduser().resolve()
        if not binary.is_file():
            raise FileNotFoundError("TEAMYRA_DESKTOP_EXE does not exist")
        return [str(binary), "--background"]
    app_dir = root / "apps" / "desktop"
    electron = root / "node_modules" / "electron" / "dist" / "electron.exe"
    if electron.is_file() and (app_dir / "package.json").is_file():
        return [str(electron), str(app_dir), "--background"]
    launch = _read(root / ".teamyra-desktop" / "launch.json")
    binary = Path(launch.get("executable") or "")
    if (launch.get("packaged") is True and binary.is_absolute() and binary.is_file() and
            str(launch.get("runtime_root") or "").lower() == str(root).lower()):
        return [str(binary), "--background"]
    for binary in (root.parent / "TEAMYRA.exe", root.parent / "Teamyra.exe"):
        if binary.is_file():
            return [str(binary), "--background"]
    raise FileNotFoundError("TEAMYRA desktop executable unavailable; open the installed app once or set TEAMYRA_DESKTOP_EXE")

@contextmanager
def _process_lock(root, deadline):
    path = Path(root) / ".teamyra-desktop" / "start.lock"
    path.parent.mkdir(parents=True, exist_ok=True)
    while True:
        try:
            with path.open("x", encoding="utf-8") as f:
                json.dump({"pid": os.getpid(), "created": time.time()}, f)
            break
        except FileExistsError:
            owner = _read(path)
            # Never steal a live starter's lock, including slow cold starts.
            try:
                malformed_and_stale = not owner and time.time() - path.stat().st_mtime > 5
            except FileNotFoundError:
                continue
            if (owner and not process_alive(owner.get("pid"))) or malformed_and_stale:
                try:
                    path.unlink()
                except FileNotFoundError:
                    pass
                continue
            if time.monotonic() >= deadline:
                raise TimeoutError("TEAMYRA desktop startup lock timed out")
            time.sleep(0.1)
    try:
        yield
    finally:
        try:
            path.unlink()
        except FileNotFoundError:
            pass

def ensure_desktop_ready(root, timeout_seconds=35):
    root = Path(root).resolve()
    if desktop_ready(root):
        return {"state": "ready", "started": False}
    deadline = time.monotonic() + max(1, min(float(timeout_seconds), 60))
    with _START_LOCK, _process_lock(root, deadline):
        if desktop_ready(root):
            return {"state": "ready", "started": False}
        command = desktop_command(root)
        env = dict(os.environ)
        env["TEAMYRA_ROOT"] = str(root)
        env.pop("ELECTRON_RUN_AS_NODE", None)
        # Child startup must not inherit a frozen core's extraction environment.
        for key in tuple(env):
            if key.startswith("_PYI_"):
                env.pop(key, None)
        logs = root / "logs"
        logs.mkdir(parents=True, exist_ok=True)
        with (logs / "desktop-wake.log").open("ab") as log:
            flags = (getattr(subprocess, "CREATE_NO_WINDOW", 0) |
                     getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0))
            child = subprocess.Popen(command, cwd=str(root), env=env,
                                     stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                                     close_fds=True, creationflags=flags)
        while time.monotonic() < deadline:
            if desktop_ready(root):
                return {"state": "ready", "started": True}
            exit_code = child.poll()
            if exit_code is not None and exit_code != 0:
                raise RuntimeError(f"TEAMYRA desktop startup failed with exit code {exit_code}; see logs/desktop-wake.log")
            time.sleep(0.15)
        raise TimeoutError("TEAMYRA desktop did not become ready; queued media is preserved, see logs/desktop-wake.log")
