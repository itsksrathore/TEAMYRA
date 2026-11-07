"""Deterministic no-shell test-policy runner for TEAMYRA."""
import os
import shutil
import subprocess
import time
from pathlib import Path


MAX_STEPS = 12
MAX_ARGS = 32
MAX_OUTPUT = 12000


def normalize_steps(raw_steps):
    if raw_steps in (None, []):
        return []
    if not isinstance(raw_steps, list):
        raise ValueError("tests must be an array")
    if len(raw_steps) > MAX_STEPS:
        raise ValueError(f"tests supports at most {MAX_STEPS} steps")

    normalized = []
    for index, raw in enumerate(raw_steps, 1):
        if not isinstance(raw, dict):
            raise ValueError(f"test step {index} must be an object")
        argv = raw.get("argv")
        if not isinstance(argv, list) or not argv or len(argv) > MAX_ARGS:
            raise ValueError(f"test step {index} argv must contain 1..{MAX_ARGS} arguments")
        args = []
        for arg in argv:
            if not isinstance(arg, str) or not arg:
                raise ValueError(f"test step {index} argv entries must be non-empty strings")
            args.append(arg)
        timeout = max(1, min(int(raw.get("timeout_seconds") or 300), 1800))
        normalized.append({
            "name": str(raw.get("name") or f"test-{index}").strip()[:120] or f"test-{index}",
            "argv": args,
            "timeout_seconds": timeout,
        })
    return normalized


NODE_SCRIPTS = {"npm": "npm-cli.js", "npx": "npx-cli.js"}


def resolve_argv(argv, which=shutil.which, platform=os.name):
    """The argv to start without a shell. On Windows a bare ``npm`` is the
    batch file ``npm.cmd``, which CreateProcess cannot start ("WinError 2"),
    and batch files must not be run through cmd.exe with model-written
    arguments. So: a name on PATH becomes its full path; ``npm``/``npx`` run
    as ``node.exe <npm>/bin/npm-cli.js`` (what npm.cmd does); any other
    batch file is refused with a clear message."""
    argv = list(argv)
    if platform != "nt" or not argv:
        return argv
    exe = argv[0]
    found = which(exe)
    if not found:
        raise ValueError(f"{exe} was not found on PATH; pass the full path of the program")
    suffix = Path(found).suffix.lower()
    if suffix in (".exe", ".com", ""):
        return [found, *argv[1:]]
    if suffix in (".cmd", ".bat"):
        name = Path(found).stem.lower()
        script = NODE_SCRIPTS.get(name)
        if script:
            folder = Path(found).parent
            node = folder / "node.exe"
            node = str(node) if node.exists() else which("node")
            cli = folder / "node_modules" / "npm" / "bin" / script
            if node and cli.exists():
                return [node, str(cli), *argv[1:]]
        raise ValueError(f"{exe} is a batch file ({found}); TEAMYRA runs tests without a shell, "
                         "so pass the real program (for example node.exe and its script)")
    return [found, *argv[1:]]


def _clip(text, limit=MAX_OUTPUT):
    text = str(text or "")
    return text if len(text) <= limit else text[-limit:]


def run_steps(raw_steps, cwd):
    steps = normalize_steps(raw_steps)
    cwd = Path(cwd).resolve()
    if not cwd.exists() or not cwd.is_dir():
        raise ValueError(f"test cwd not found: {cwd}")

    results = []
    started = time.time()
    for step in steps:
        step_started = time.time()
        timed_out = False
        try:
            cp = subprocess.run(
                resolve_argv(step["argv"]),
                cwd=str(cwd),
                stdin=subprocess.DEVNULL,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=step["timeout_seconds"],
                shell=False,
            )
            exit_code = cp.returncode
            stdout = cp.stdout or ""
            stderr = cp.stderr or ""
        except subprocess.TimeoutExpired as exc:
            timed_out = True
            exit_code = None
            stdout = exc.stdout or ""
            stderr = exc.stderr or ""
            if isinstance(stdout, bytes):
                stdout = stdout.decode("utf-8", errors="replace")
            if isinstance(stderr, bytes):
                stderr = stderr.decode("utf-8", errors="replace")

        ok = not timed_out and exit_code == 0
        result = {
            "name": step["name"],
            "argv": step["argv"],
            "ok": ok,
            "exit_code": exit_code,
            "timed_out": timed_out,
            "elapsed_s": round(time.time() - step_started, 3),
            "stdout_tail": _clip(stdout),
            "stderr_tail": _clip(stderr),
        }
        results.append(result)
        if not ok:
            return {
                "ok": False,
                "state": "failed",
                "cwd": str(cwd),
                "elapsed_s": round(time.time() - started, 3),
                "failed_step": step["name"],
                "steps": results,
            }

    return {
        "ok": True,
        "state": "passed",
        "cwd": str(cwd),
        "elapsed_s": round(time.time() - started, 3),
        "failed_step": None,
        "steps": results,
    }
