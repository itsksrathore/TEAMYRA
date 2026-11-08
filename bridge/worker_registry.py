"""Dynamic TEAMYRA worker registry.

Keeps compatibility with the original codex1/codex2 worker IDs while discovering
new Codex profiles created by the desktop app under profiles/codex/<profile>.
"""
import json
import re
from pathlib import Path

from web_sites import WEB_SITES


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


# OpenCode's free models (opencode models, 2026-11-08). Each is one TEAMYRA
# worker, an "account" under profiles/opencode/<slug> that can be enabled,
# disabled or renamed like any other; its "model" is what opencode run -m uses.
OPENCODE_DEFAULT_MODELS = (
    # (model, label, enabled)
    ("opencode/glm-5.3-flash-free", "OpenCode GLM 5.3 Flash", True),
    ("opencode/deepseek-v4.1-flash-free", "OpenCode DeepSeek V4.1 Flash", True),
    ("opencode/mimo-v2.6-flash-free", "OpenCode MiMo V2.6 Flash", True),
    ("opencode/nemotron-3.5-super-vl-free", "OpenCode Nemotron 3.5 Super", True),
    ("opencode/big-pickle", "OpenCode Big Pickle", True),
    ("opencode/nemotron-3.5-lightning-free", "OpenCode Nemotron 3.5 Lightning", False),
    ("opencode/flint-40b-free", "OpenCode Flint 40B", False),
    ("opencode/beam-free", "OpenCode Beam", False),
    ("opencode/crouton-alpha-free", "OpenCode Crouton Alpha", False),
    ("opencode/iceman-free", "OpenCode Iceman", False),
    ("opencode/inkling-2-small-free", "OpenCode Inkling 2 Small", False),
)
OPENCODE_PRIORITY = 600  # after the Codex, Claude and web-chat workers


def opencode_slug(model):
    return safe_worker_part(str(model).split("/", 1)[-1])


def seed_opencode_profiles(root):
    """Create profiles/opencode/<slug> for each default free model once (an
    existing folder, and so the user's own settings, is never touched)."""
    base = Path(root) / "profiles" / "opencode"
    created = []
    for model, label, enabled in OPENCODE_DEFAULT_MODELS:
        folder = base / opencode_slug(model)
        if folder.exists():
            continue
        folder.mkdir(parents=True, exist_ok=True)
        (folder / "teamyra-profile.json").write_text(json.dumps({
            "name": label, "provider": "opencode", "model": model, "enabled": enabled,
            "priority": OPENCODE_PRIORITY}, indent=2), encoding="utf-8")
        created.append(folder.name)
    return created


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
        "chatgpt-normal": {
            "id": "chatgpt-normal",
            "provider": "chatgpt-web",
            "label": "ChatGPT Normal",
            "profile_id": "web",
            "home": None,
            "native": True,
            "execution": "desktop-web",
            "enabled": True,
            "priority": 250,
        },
    }
    # Every other web-chat site's default account (Muse, DeepSeek, Grok).
    for provider, site in WEB_SITES.items():
        if provider == "chatgpt-web":
            continue
        workers[site["builtin"]] = {
            "id": site["builtin"],
            "provider": provider,
            "label": site["label"],
            "profile_id": "web",
            "home": None,
            "native": True,
            "execution": "desktop-web",
            "enabled": True,
            "priority": site["priority"],
        }

    legacy = profiles / "codex2"
    if legacy.exists():
        meta = profile_metadata(legacy)
        workers["codex2"] = {
            "id": "codex2",
            "provider": "codex",
            "label": meta["name"] if meta["name"] != "codex2" else "Codex 2",
            "profile_id": "codex2",
            "home": str(legacy),
            "native": False,
            "legacy": True,
            "enabled": meta["enabled"],
            "priority": meta["priority"],
            "settings": {k: meta[k] for k in ("model", "effort", "permission_mode") if meta[k] is not None},
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

    opencode = profiles / "opencode"
    if opencode.exists():
        for path in sorted((p for p in opencode.iterdir() if p.is_dir()), key=lambda p: p.name.lower()):
            worker_id = "opencode-" + safe_worker_part(path.name)
            if worker_id in workers:
                continue
            meta = profile_metadata(path)
            model = meta["model"] or ("opencode/" + path.name)
            workers[worker_id] = {
                "id": worker_id,
                "provider": "opencode",
                "label": meta["name"],
                "profile_id": path.name,
                "home": None,
                "native": False,
                "enabled": meta["enabled"],
                "priority": meta["priority"],
                "settings": {"model": model},
            }

    for provider, prefix in ((provider, site["prefix"]) for provider, site in WEB_SITES.items()):
        web_profiles = profiles / provider
        if not web_profiles.exists():
            continue
        for path in sorted((p for p in web_profiles.iterdir() if p.is_dir()), key=lambda p: p.name.lower()):
            part = safe_worker_part(path.name)
            worker_id = prefix + part
            if worker_id in workers:
                continue
            meta = profile_metadata(path)
            workers[worker_id] = {
                "id": worker_id,
                "provider": provider,
                "label": meta["name"],
                "profile_id": path.name,
                "home": None,
                "native": False,
                "execution": "desktop-web",
                "enabled": meta["enabled"],
                "priority": meta["priority"],
            }

    return workers


def worker_ids(root, home=None):
    return tuple(build_worker_registry(root, home).keys())
