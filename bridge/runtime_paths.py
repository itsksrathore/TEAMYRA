"""Resolve TEAMYRA runtime executables without user-specific hard-coded paths."""
import os
import re
import shutil
import subprocess
import time
from pathlib import Path

WINDOWS_LAUNCH_SUFFIXES = (".exe", ".cmd", ".bat", ".com")
CLAUDE_NPM_PACKAGE_EXE = ("node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe")
_COMMAND_CACHE = {}


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


def _launchable(path, windows):
    """A file the OS can start directly (no extensionless sh shims on Windows)."""
    if not path:
        return False
    candidate = Path(path)
    if not candidate.is_file():
        return False
    if windows:
        return candidate.suffix.lower() in WINDOWS_LAUNCH_SUFFIXES
    return os.access(str(candidate), os.X_OK)


def _command_lines(argv, env):
    """stdout lines of a short discovery command (cached per process)."""
    key = (tuple(str(part) for part in argv), (env or {}).get("PATH"))
    if key not in _COMMAND_CACHE:
        merged = dict(os.environ)
        merged.update(env or {})
        try:
            cp = subprocess.run(
                [str(part) for part in argv], capture_output=True, text=True, timeout=15,
                env=merged, stdin=subprocess.DEVNULL, shell=False,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            lines = []
            if cp.returncode == 0:
                lines = [line.strip() for line in (cp.stdout or "").splitlines() if line.strip()]
        except (OSError, subprocess.SubprocessError, ValueError):
            lines = []
        _COMMAND_CACHE[key] = lines
    return _COMMAND_CACHE[key]


def _version_key(name):
    return tuple(int(part) for part in re.findall(r"\d+", name)) or (0,)


def _claude_desktop_bundled(env, home, windows):
    """Claude desktop ships the Claude Code CLI under
    <app data>/Claude/claude-code/<version>/<build>/claude(.exe); newest wins."""
    roots = []
    if windows:
        appdata = env.get("APPDATA")
        roots.append(Path(appdata) / "Claude" / "claude-code" if appdata else None)
        roots.append(home / "AppData" / "Roaming" / "Claude" / "claude-code")
    else:
        roots.append(home / "Library" / "Application Support" / "Claude" / "claude-code")
        roots.append(home / ".config" / "Claude" / "claude-code")
    name = "claude.exe" if windows else "claude"
    for root in roots:
        if not root or not root.is_dir():
            continue
        try:
            versions = sorted((item for item in root.iterdir() if item.is_dir()),
                              key=lambda item: _version_key(item.name), reverse=True)
        except OSError:
            continue
        for version in versions:
            for found in sorted(version.glob(f"*/{name}")) + [version / name]:
                if _launchable(found, windows):
                    return str(found)
    return ""


def find_claude(env=None, home=None, windows=None):
    """Return (path, source) of the Claude Code CLI, or ("", None).

    Order: TEAMYRA_CLAUDE, PATH (PATHEXT variants), `where claude`, the npm
    global prefix (`npm prefix -g`), %APPDATA%/npm, %LOCALAPPDATA%/Programs,
    ~/.claude/local, ~/.local/bin, then the Claude desktop bundled CLI."""
    env = os.environ if env is None else env
    home = Path(home) if home else Path.home()
    windows = (os.name == "nt") if windows is None else windows
    explicit = env.get("TEAMYRA_CLAUDE")
    if explicit:
        return explicit, "TEAMYRA_CLAUDE"
    names = ("claude.exe", "claude.cmd", "claude.bat", "claude") if windows else ("claude",)
    for name in names:
        found = which(name, env)
        if _launchable(found, windows):
            return found, "PATH"
    if windows:
        for line in _command_lines(["where", "claude"], env):
            if _launchable(line, windows):
                return line, "where claude"
    npm = which("npm", env)
    if npm:
        for line in _command_lines([npm, "prefix", "-g"], env)[:1]:
            prefix = Path(line)
            candidates = (
                [prefix / "claude.cmd", prefix / "claude.exe", prefix.joinpath(*CLAUDE_NPM_PACKAGE_EXE)]
                if windows else [prefix / "bin" / "claude"]
            )
            for candidate in candidates:
                if _launchable(candidate, windows):
                    return str(candidate), "npm prefix -g"
    appdata = env.get("APPDATA")
    local = env.get("LOCALAPPDATA")
    static = []
    for npm_root in ([Path(appdata) / "npm"] if appdata else []) + [home / "AppData" / "Roaming" / "npm"]:
        static.append((npm_root / "claude.cmd", "npm global"))
        static.append((npm_root.joinpath(*CLAUDE_NPM_PACKAGE_EXE), "npm global"))
    for programs in ([Path(local) / "Programs"] if local else []) + [home / "AppData" / "Local" / "Programs"]:
        for folder in ("claude", "Claude", "claude-code", "Claude Code"):
            static.append((programs / folder / "claude.exe", "LOCALAPPDATA Programs"))
    for name in ("claude.cmd", "claude.exe", "claude"):
        static.append((home / ".claude" / "local" / name, ".claude/local"))
    for name in ("claude.exe", "claude"):
        static.append((home / ".local" / "bin" / name, ".local/bin"))
    for candidate, source in static:
        if _launchable(candidate, windows):
            return str(candidate), source
    bundled = _claude_desktop_bundled(env, home, windows)
    if bundled:
        return bundled, "Claude desktop bundled CLI"
    return "", None


def claude_launch_info(env=None, home=None, windows=None):
    """Which Claude Code CLI TEAMYRA uses and how it was found."""
    path, source = find_claude(env, home, windows)
    return {"argv": [path] if path else [], "path": path or None, "source": source}


def claude_launch(env=None, home=None):
    path, _ = find_claude(env, home)
    return [path] if path else []


# Codex's elevated Windows sandbox runs as machine-wide users
# (CodexSandboxOffline/Online), but every CODEX_HOME keeps its own setup marker
# and the users' passwords. With two accounts in different homes each run of
# the other account finds the users "incompatible with marker version",
# provisions them again (a UAC prompt) and so breaks the other home's copy.
CODEX_SANDBOX_STATE = (".sandbox", ".sandbox-secrets", ".sandbox-bin")


def _is_link(path):
    try:
        return path.is_symlink() or os.path.isjunction(path)
    except (OSError, AttributeError):
        return False


def _junction(target, link):
    try:
        import _winapi
        _winapi.CreateJunction(str(target), str(link))
    except (ImportError, AttributeError):
        subprocess.run(["cmd", "/c", "mklink", "/J", str(link), str(target)], check=True,
                       capture_output=True, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))


def share_codex_sandbox(home, primary=None):
    """Let an extra Codex account home use the main home's sandbox setup, so the
    one-time elevated setup holds for every account. Returns the shared names."""
    if os.name != "nt" or not home:
        return []
    home = Path(home)
    primary = Path(primary) if primary else Path.home() / ".codex"
    try:
        if home.resolve() == primary.resolve():
            return []
    except OSError:
        return []
    if not (primary / ".sandbox" / "setup_marker.json").is_file() or not home.is_dir():
        return []
    shared = []
    for name in CODEX_SANDBOX_STATE:
        target, link = primary / name, home / name
        if not target.is_dir() or _is_link(link):
            continue
        backup = None
        if link.exists():
            backup = home / f"{name}.local-{time.strftime('%Y%m%d-%H%M%S')}"
            try:
                link.rename(backup)
            except OSError:
                continue  # in use by a running Codex; try again next launch
        try:
            _junction(target, link)
            shared.append(name)
        except (OSError, subprocess.CalledProcessError):
            if backup is not None and not link.exists():
                backup.rename(link)
    return shared
