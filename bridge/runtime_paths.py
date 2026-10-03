"""Resolve TEAMYRA runtime executables without user-specific hard-coded paths."""
import os
import shutil
from pathlib import Path


def first_existing(values):
    for value in values:
        if not value:
            continue
        path = Path(value)
        if path.exists():
            return str(path)
    return ""


def which(name, env):
    return shutil.which(name, path=(env or {}).get("PATH"))


def find_node(env=None, home=None):
    env = env or os.environ
    home = Path(home) if home else Path.home()
    return (
        env.get("TEAMYRA_NODE")
        or which("node", env)
        or first_existing([
            Path(env.get("ProgramFiles", r"C:\Program Files")) / "nodejs" / "node.exe",
            home / "AppData" / "Local" / "Programs" / "nodejs" / "node.exe",
        ])
    )


def find_codex_js(env=None, home=None):
    env = env or os.environ
    home = Path(home) if home else Path.home()
    appdata = env.get("APPDATA")
    return (
        env.get("TEAMYRA_CODEX_JS")
        or first_existing([
            Path(appdata) / "npm" / "node_modules" / "@openai" / "codex" / "bin" / "codex.js"
            if appdata else None,
            home / "AppData" / "Roaming" / "npm" / "node_modules" / "@openai" / "codex" / "bin" / "codex.js",
        ])
    )


def codex_launch(env=None, home=None):
    env = env or os.environ
    explicit = env.get("TEAMYRA_CODEX")
    if explicit:
        return [explicit]
    node = find_node(env, home)
    script = find_codex_js(env, home)
    if node and script:
        return [node, script]
    binary = which("codex", env)
    return [binary] if binary else []


def agy_launch(env=None, home=None):
    env = env or os.environ
    home = Path(home) if home else Path.home()
    local = env.get("LOCALAPPDATA")
    binary = (
        env.get("TEAMYRA_AGY")
        or which("agy", env)
        or first_existing([
            Path(local) / "agy" / "bin" / "agy.exe" if local else None,
            home / "AppData" / "Local" / "agy" / "bin" / "agy.exe",
        ])
    )
    return [binary] if binary else []


def claude_launch(env=None, home=None):
    env = env or os.environ
    home = Path(home) if home else Path.home()
    appdata = env.get("APPDATA")
    binary = (
        env.get("TEAMYRA_CLAUDE")
        or which("claude", env)
        or first_existing([
            Path(appdata) / "npm" / "claude.cmd" if appdata else None,
            home / "AppData" / "Roaming" / "npm" / "claude.cmd",
            home / ".local" / "bin" / "claude.exe",
            home / ".local" / "bin" / "claude",
        ])
    )
    return [binary] if binary else []
