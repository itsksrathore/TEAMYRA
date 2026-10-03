"""Dynamic TEAMYRA worker registry.

Keeps compatibility with the original codex1/codex2 worker IDs while discovering
new Codex profiles created by the desktop app under profiles/codex/<profile>.
"""
import json
import re
from pathlib import Path


def safe_worker_part(value):
    value = re.sub(r"[^A-Za-z0-9._-]+", "-", str(value or "").strip())
    value = value.strip(".-_")
    return (value or "account")[:48]


def profile_metadata(path):
    data = {}
    try:
        parsed = json.loads((path / "teamyra-profile.json").read_text(encoding="utf-8"))
        if isinstance(parsed, dict):
            data = parsed
    except Exception:
        pass

    name = str(data.get("name") or path.name).strip() or path.name
    try:
        priority = int(data.get("priority", 100))
    except (TypeError, ValueError):
        priority = 100

    return {
        "name": name,
        "enabled": data.get("enabled", True) is not False,
        "priority": max(0, min(priority, 10000)),
        "model": data.get("model"),
        "effort": data.get("effort"),
        "permission_mode": data.get("permission_mode"),
    }


def profile_label(path):
    return profile_metadata(path)["name"]


def build_worker_registry(root, home=None):
    root = Path(root)
    home = Path(home) if home else Path.home()
    profiles = root / "profiles"

    workers = {
        "claude1": {
            "id": "claude1",
            "provider": "claude",
            "label": "Claude Default",
            "profile_id": "native",
            "home": str(home / ".claude"),
            "native": True,
        },
        "antigravity": {
            "id": "antigravity",
            "provider": "antigravity",
            "label": "Antigravity",
            "profile_id": "native",
            "home": None,
            "native": True,
        },
        "codex1": {
            "id": "codex1",
            "provider": "codex",
            "label": "Codex Default",
            "profile_id": "native",
            "home": str(home / ".codex"),
            "native": True,
        },
    }

    legacy = profiles / "codex2"
    if legacy.exists():
        workers["codex2"] = {
            "id": "codex2",
            "provider": "codex",
            "label": "Codex 2",
            "profile_id": "codex2",
            "home": str(legacy),
            "native": False,
            "legacy": True,
        }

    managed = profiles / "codex"
    if managed.exists():
        for path in sorted((p for p in managed.iterdir() if p.is_dir()), key=lambda p: p.name.lower()):
            part = safe_worker_part(path.name)
            worker_id = "codex-" + part
            if worker_id in workers:
                continue
            meta = profile_metadata(path)
            workers[worker_id] = {
                "id": worker_id,
                "provider": "codex",
                "label": meta["name"],
                "profile_id": path.name,
                "home": str(path),
                "native": False,
                "enabled": meta["enabled"],
                "priority": meta["priority"],
                "settings": {k: meta[k] for k in ("model", "effort", "permission_mode") if meta[k] is not None},
            }

    claude_profiles = profiles / "claude"
    if claude_profiles.exists():
        for path in sorted((p for p in claude_profiles.iterdir() if p.is_dir()), key=lambda p: p.name.lower()):
            part = safe_worker_part(path.name)
            worker_id = "claude-" + part
            if worker_id in workers:
                continue
            meta = profile_metadata(path)
            workers[worker_id] = {
                "id": worker_id,
                "provider": "claude",
                "label": meta["name"],
                "profile_id": path.name,
                "home": str(path),
                "native": False,
                "enabled": meta["enabled"],
                "priority": meta["priority"],
                "settings": {k: meta[k] for k in ("model", "effort", "permission_mode") if meta[k] is not None},
            }

    return workers


def worker_ids(root, home=None):
    return tuple(build_worker_registry(root, home).keys())
