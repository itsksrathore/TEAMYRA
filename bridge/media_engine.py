"""Durable media-generation primitives for TEAMYRA.

The Python core owns provider-agnostic media jobs, asset metadata, routing intent,
filesystem organization, cancellation and restart reconciliation. Browser-specific
Google Flow/Flow Music automation stays in Electron.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import time
import uuid
from contextlib import contextmanager
from pathlib import Path

MEDIA_TYPES = {
    "image", "video", "music", "background_music", "instrumental", "song", "sound_effect"
}
VISUAL_TYPES = {"image", "video", "sound_effect"}
MUSIC_TYPES = {"music", "background_music", "instrumental", "song"}
TRANSFORM_OPERATIONS = {
    "image_edit", "image_variation", "video_extend", "video_edit", "video_to_video",
    "music_remix", "music_extend", "music_replace_section",
}
JOB_STATES = {
    "queued", "preparing", "waiting_for_browser", "submitting", "generating",
    "processing", "downloading", "extracting_audio", "organizing", "completed",
    "failed", "cancelled", "needs_user_auth", "rate_limited",
}
TERMINAL_STATES = {"completed", "failed", "cancelled"}
ASSET_PREFIX = {
    "image": "IMG",
    "video": "VID",
    "music": "MUS",
    "background_music": "MUS",
    "instrumental": "MUS",
    "song": "MUS",
    "sound_effect": "SFX",
}
ASSET_FOLDER = {
    "image": "Images",
    "video": "Videos",
    "music": "Music",
    "background_music": "Music",
    "instrumental": "Music",
    "song": "Music",
    "sound_effect": "Sound Effects",
}
DEFAULT_EXTENSION = {
    "image": ".png",
    "video": ".mp4",
    "music": ".wav",
    "background_music": ".wav",
    "instrumental": ".wav",
    "song": ".wav",
    "sound_effect": ".wav",
}
SAFE_FORMATS = {
    "image": {"png", "jpg", "jpeg", "webp"},
    "video": {"mp4", "webm"},
    "music": {"wav", "mp3", "m4a"},
    "background_music": {"wav", "mp3", "m4a"},
    "instrumental": {"wav", "mp3", "m4a"},
    "song": {"wav", "mp3", "m4a"},
    "sound_effect": {"wav", "mp3", "m4a"},
}
RUNTIME_IN_PROGRESS = {
    "preparing", "waiting_for_browser", "submitting", "generating", "processing",
    "downloading", "extracting_audio", "organizing",
}
MAX_PROMPT = 24000
MAX_REFERENCES = 24
MAX_HISTORY = 120

_SLUG_RE = re.compile(r"[^a-z0-9]+")
_ASSET_ID_RE = re.compile(r"^TYR-(IMG|VID|MUS|SFX)-(\d{6,})$")
_JOB_ID_RE = re.compile(r"^media-[A-Za-z0-9._-]{8,96}$")


def _media_root(root):
    path = Path(root).resolve() / "media"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _jobs_dir(root):
    path = _media_root(root) / "jobs"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _staging_root(root):
    path = _media_root(root) / "staging"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _assets_file(root):
    return _media_root(root) / "assets.json"


def _connection_file(root):
    return _media_root(root) / "connection.json"


def _lock_file(root):
    return _media_root(root) / ".state.lock"


def _read_json(path, default=None):
    try:
        value = json.loads(Path(path).read_text(encoding="utf-8"))
        return value
    except Exception:
        return default


def _atomic_write(path, payload):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + f".tmp-{os.getpid()}-{uuid.uuid4().hex[:6]}")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, path)


@contextmanager
def _state_lock(root, timeout=5.0):
    lock = _lock_file(root)
    deadline = time.time() + timeout
    fd = None
    while fd is None:
        try:
            fd = os.open(str(lock), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            os.write(fd, f"{os.getpid()} {time.time()}".encode("ascii", errors="ignore"))
        except FileExistsError:
            try:
                age = time.time() - lock.stat().st_mtime
                if age > 30:
                    lock.unlink(missing_ok=True)
                    continue
            except OSError:
                pass
            if time.time() >= deadline:
                raise TimeoutError("TEAMYRA media state is busy")
            time.sleep(0.03)
    try:
        yield
    finally:
        try:
            os.close(fd)
        except Exception:
            pass
        try:
            lock.unlink(missing_ok=True)
        except OSError:
            pass


def _is_relative_to(path, parent):
    try:
        Path(path).resolve().relative_to(Path(parent).resolve())
        return True
    except (ValueError, OSError):
        return False


def _validate_project(root, value):
    raw = str(value or "").strip()
    if not raw:
        raise ValueError("project_path is required")
    path = Path(raw).expanduser().resolve()
    if not path.exists() or not path.is_dir():
        raise ValueError("project_path must be an existing directory")
    if path == Path(path.anchor).resolve() or path == Path.home().resolve():
        raise PermissionError("project_path is too broad; choose a project directory")

    root = Path(root).resolve()
    sensitive = [
        root / "profiles", root / "jobs", root / "logs", root / "results",
        root / "worktrees", root / "tasks", root / "memory", root / "backups",
        root / "media", root / ".teamyra-desktop",
        Path.home() / ".ssh", Path.home() / ".gnupg", Path.home() / ".aws",
        Path.home() / ".azure", Path.home() / ".kube", Path.home() / ".docker",
        Path.home() / ".codex", Path.home() / ".claude", Path.home() / ".gemini",
    ]
    for blocked in sensitive:
        try:
            blocked = blocked.resolve()
        except OSError:
            continue
        if path == blocked or _is_relative_to(path, blocked):
            raise PermissionError("TEAMYRA runtime, system, or credential directories cannot be media projects")
    return path


def ensure_project_folders(root, project_path):
    project = _validate_project(root, project_path)
    base = project / "Generated Assets"
    folders = {}
    for name in ("Images", "Videos", "Music", "Sound Effects", "References", "Frames", "Characters", "Metadata"):
        item = base / name
        item.mkdir(parents=True, exist_ok=True)
        folders[name] = str(item)
    return {"project_path": str(project), "generated_assets": str(base), "folders": folders}


def slugify(value, fallback="asset", max_length=64):
    text = str(value or "").strip().lower()
    text = _SLUG_RE.sub("_", text).strip("_")
    text = re.sub(r"_+", "_", text)
    return (text[:max_length].strip("_") or fallback)


def _prompt_slug(prompt, media_type):
    words = re.findall(r"[A-Za-z0-9]+", str(prompt or "").lower())
    filtered = [
        word for word in words
        if word not in {"generate", "create", "make", "cinematic", "realistic", "detailed", "a", "an", "the", "with", "and", "for", "of", "to"}
    ]
    return slugify("_".join(filtered[:7]), ASSET_FOLDER[media_type].lower().replace(" ", "_"), 56)


def route_for_type(media_type):
    if media_type in MUSIC_TYPES:
        return "music"
    if media_type in VISUAL_TYPES:
        return "visual"
    raise ValueError(f"unsupported media type: {media_type}")


def _normalize_format(media_type, value):
    raw = str(value or "").strip().lower().lstrip(".")
    if not raw:
        return DEFAULT_EXTENSION[media_type].lstrip(".")
    if raw not in SAFE_FORMATS[media_type]:
        raise ValueError(f"unsupported {media_type} format: {raw}")
    return raw


def _normalize_references(values):
    refs = values or []
    if not isinstance(refs, list):
        raise ValueError("references must be an array")
    if len(refs) > MAX_REFERENCES:
        raise ValueError(f"references supports at most {MAX_REFERENCES} items")
    normalized = []
    for value in refs:
        text = str(value or "").strip()
        if not text:
            continue
        if len(text) > 2048:
            raise ValueError("reference value is too long")
        normalized.append(text)
    return normalized


def _sfx_prompt(prompt):
    base = str(prompt or "").strip()
    lowered = base.lower()
    # Preserve explicitly requested multi-sound ambience and dialogue/music intent.
    wants_music = any(word in lowered for word in ("music", "score", "song", "instrumental", "melody"))
    wants_voice = any(word in lowered for word in ("dialogue", "speech", "spoken", "narration", "voice"))
    constraints = ["Generate ONLY the requested sound effect/audio event."]
    if not wants_music:
        constraints += ["No background music.", "No musical score.", "No instruments.", "No soundtrack.", "No singing."]
    if not wants_voice:
        constraints += ["No spoken dialogue.", "No narration."]
    constraints += [
        "No unrelated ambient sounds unless explicitly requested.",
        "The audio should contain only the requested sound event(s): " + base,
    ]
    return base + "\n\nAUDIO CONSTRAINTS:\n" + "\n".join(constraints)


def normalize_generate_request(root, request):
    if not isinstance(request, dict):
        raise ValueError("media request must be an object")
    media_type = str(request.get("type") or "").strip().lower()
    if media_type not in MEDIA_TYPES:
        raise ValueError("type must be image, video, music, background_music, instrumental, song, or sound_effect")
    project = _validate_project(root, request.get("project_path"))
    prompt = str(request.get("prompt") or "").strip()
    if not prompt:
        raise ValueError("prompt is required")
    if len(prompt) > MAX_PROMPT:
        raise ValueError("prompt is too long")

    result = {
        "type": media_type,
        "prompt": prompt,
        "provider_prompt": _sfx_prompt(prompt) if media_type == "sound_effect" else prompt,
        "project_path": str(project),
        "surface": route_for_type(media_type),
        "aspect_ratio": str(request.get("aspect_ratio") or "").strip()[:32] or None,
        "duration": None,
        "format": _normalize_format(media_type, request.get("format")),
        "references": _normalize_references(request.get("references")),
        "output_count": max(1, min(int(request.get("output_count") or 1), 8)),
        "instrumental": request.get("instrumental") is True or media_type in {"instrumental", "background_music"},
        "vocals": request.get("vocals") is True,
        "lyrics": str(request.get("lyrics") or "").strip()[:MAX_PROMPT] or None,
        "model_preference": str(request.get("model_preference") or "").strip()[:120] or None,
        "generation_settings": {},
    }
    if request.get("duration") is not None:
        duration = float(request.get("duration"))
        if duration <= 0 or duration > 1800:
            raise ValueError("duration must be greater than 0 and at most 1800 seconds")
        result["duration"] = duration

    for key in ("first_frame", "last_frame", "character_reference", "audio_reference", "video_reference"):
        value = str(request.get(key) or "").strip()
        if value:
            result[key] = value

    settings = request.get("generation_settings")
    if settings is not None:
        if not isinstance(settings, dict):
            raise ValueError("generation_settings must be an object")
        # Generic, bounded settings only. Google-specific DOM controls are not part of this contract.
        result["generation_settings"] = {
            str(key)[:80]: value
            for key, value in list(settings.items())[:32]
            if isinstance(value, (str, int, float, bool)) or value is None
        }
    ensure_project_folders(root, project)
    return result


def _load_assets(root):
    data = _read_json(_assets_file(root), None)
    if not isinstance(data, dict):
        data = {}
    assets = data.get("assets")
    counters = data.get("counters")
    if not isinstance(assets, dict):
        assets = {}
    if not isinstance(counters, dict):
        counters = {}
    return {"version": 1, "assets": assets, "counters": counters}


def _save_assets(root, data):
    data = dict(data)
    data["version"] = 1
    data["updated_at"] = time.time()
    _atomic_write(_assets_file(root), data)


def get_asset(root, asset_id):
    asset_id = str(asset_id or "").strip().upper()
    if not _ASSET_ID_RE.fullmatch(asset_id):
        raise ValueError("invalid TEAMYRA asset id")
    asset = _load_assets(root)["assets"].get(asset_id)
    if not isinstance(asset, dict):
        raise ValueError(f"no such media asset: {asset_id}")
    return asset


def list_assets(root, project_path=None, asset_id=None, media_type=None, limit=100):
    if asset_id:
        return {"items": [get_asset(root, asset_id)], "count": 1}
    project_norm = str(Path(project_path).expanduser().resolve()).lower() if project_path else None
    media_type = str(media_type or "").strip().lower()
    if media_type and media_type not in MEDIA_TYPES:
        raise ValueError("invalid media type")
    rows = []
    for asset in _load_assets(root)["assets"].values():
        if not isinstance(asset, dict):
            continue
        if project_norm and str(asset.get("project_path") or "").lower() != project_norm:
            continue
        if media_type and asset.get("type") != media_type:
            continue
        rows.append(asset)
    rows.sort(key=lambda item: float(item.get("created_at") or 0), reverse=True)
    limit = max(1, min(int(limit or 100), 500))
    return {"items": rows[:limit], "count": min(len(rows), limit), "total": len(rows)}


def _resolve_reference(root, project, value):
    text = str(value or "").strip()
    if _ASSET_ID_RE.fullmatch(text.upper()):
        asset = get_asset(root, text.upper())
        path = Path(asset.get("local_path") or "").resolve()
        if not path.exists() or not path.is_file():
            raise ValueError(f"asset file is unavailable: {text}")
        return {
            "kind": "asset",
            "asset_id": asset["asset_id"],
            "path": str(path),
            "provider_asset_id": asset.get("provider_asset_id"),
            "provider_project_id": asset.get("provider_project_id"),
            "provider_url": asset.get("provider_url"),
            "type": asset.get("type"),
        }

    candidate = Path(text).expanduser()
    if not candidate.is_absolute():
        candidate = project / candidate
    candidate = candidate.resolve()
    if not _is_relative_to(candidate, project):
        raise PermissionError("reference path is outside project_path")
    if not candidate.exists() or not candidate.is_file():
        raise ValueError(f"reference file does not exist: {text}")
    if candidate.name.lower() in {".env", "auth.json", ".credentials.json", "credentials.json", "secrets.json"}:
        raise PermissionError("credential-like files cannot be used as media references")
    return {"kind": "file", "path": str(candidate)}


def resolve_request_references(root, request):
    project = Path(request["project_path"]).resolve()
    values = list(request.get("references") or [])
    for key in ("first_frame", "last_frame", "character_reference", "audio_reference", "video_reference"):
        if request.get(key):
            values.append(request[key])
    resolved = []
    seen = set()
    for value in values:
        item = _resolve_reference(root, project, value)
        identity = (item.get("asset_id") or "", item["path"])
        if identity in seen:
            continue
        seen.add(identity)
        resolved.append(item)
    return resolved


def _job_path(root, job_id):
    job_id = str(job_id or "").strip()
    if not _JOB_ID_RE.fullmatch(job_id):
        raise ValueError("invalid media job id")
    return _jobs_dir(root) / f"{job_id}.json"


def _new_job_id():
    return "media-" + time.strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:8]


def _event(state, detail=None):
    item = {"ts": time.time(), "state": state}
    if detail:
        item["detail"] = str(detail)[:1000]
    return item


def create_job(root, request, *, operation=None, source_asset=None):
    normalized = normalize_generate_request(root, request)
    refs = resolve_request_references(root, normalized)
    parent_ids = [item["asset_id"] for item in refs if item.get("asset_id")]
    if source_asset and source_asset.get("asset_id") not in parent_ids:
        parent_ids.insert(0, source_asset["asset_id"])
    job_id = _new_job_id()
    now = time.time()
    job = {
        "job_id": job_id,
        "state": "queued",
        "created_at": now,
        "updated_at": now,
        "attempt": 0,
        "cancel_requested": False,
        "claimed_by": None,
        "claimed_at": None,
        "reconcile_required": False,
        "operation": operation,
        "request": normalized,
        "resolved_references": refs,
        "parent_asset_ids": parent_ids,
        "provider": None,
        "provider_surface": "google-flow-music" if normalized["surface"] == "music" else "google-flow",
        "provider_submission": {},
        "planned_output": None,
        "asset_id": None,
        "error": None,
        "history": [_event("queued", "Media job created")],
    }
    _atomic_write(_job_path(root, job_id), job)
    return public_job(job)


def create_batch(root, requests):
    if not isinstance(requests, list) or not requests:
        raise ValueError("requests must be a non-empty array")
    if len(requests) > 50:
        raise ValueError("media_batch accepts at most 50 requests")
    jobs = [create_job(root, item) for item in requests]
    return {"jobs": jobs, "count": len(jobs)}


def create_transform_job(root, request):
    if not isinstance(request, dict):
        raise ValueError("transform request must be an object")
    operation = str(request.get("operation") or "").strip().lower()
    if operation not in TRANSFORM_OPERATIONS:
        raise ValueError("unsupported media transform operation")
    asset = get_asset(root, request.get("asset_id"))
    target_type = {
        "image_edit": "image",
        "image_variation": "image",
        "video_extend": "video",
        "video_edit": "video",
        "video_to_video": "video",
        "music_remix": "music",
        "music_extend": "music",
        "music_replace_section": "music",
    }[operation]
    generate = {
        "type": target_type,
        "prompt": str(request.get("prompt") or f"{operation} {asset['asset_id']}"),
        "project_path": request.get("project_path") or asset.get("project_path"),
        "references": [asset["asset_id"], *(request.get("references") or [])],
        "duration": request.get("duration"),
        "aspect_ratio": request.get("aspect_ratio"),
        "format": request.get("format"),
        "generation_settings": request.get("generation_settings") or {},
    }
    for key in ("first_frame", "last_frame", "character_reference", "audio_reference", "video_reference"):
        if request.get(key):
            generate[key] = request[key]
    if target_type == "music":
        generate["instrumental"] = request.get("instrumental") is True
    return create_job(root, generate, operation=operation, source_asset=asset)


def load_job(root, job_id):
    path = _job_path(root, job_id)
    if not path.exists():
        raise ValueError(f"no such media job: {job_id}")
    job = _read_json(path, None)
    if not isinstance(job, dict):
        raise ValueError(f"media job is corrupt: {job_id}")
    return job


def _save_job(root, job):
    job["updated_at"] = time.time()
    history = job.get("history")
    if isinstance(history, list) and len(history) > MAX_HISTORY:
        job["history"] = history[-MAX_HISTORY:]
    _atomic_write(_job_path(root, job["job_id"]), job)
    return job


def public_job(job):
    result = {
        "job_id": job.get("job_id"),
        "status": job.get("state"),
        "type": job.get("request", {}).get("type"),
        "operation": job.get("operation"),
        "project_path": job.get("request", {}).get("project_path"),
        "provider_surface": job.get("provider_surface"),
        "asset_id": job.get("asset_id"),
        "error": job.get("error"),
        "cancel_requested": job.get("cancel_requested") is True,
        "created_at": job.get("created_at"),
        "updated_at": job.get("updated_at"),
    }
    if job.get("asset_id"):
        try:
            result["asset"] = get_asset(Path(job.get("_root")) if job.get("_root") else ".", job["asset_id"])
        except Exception:
            pass
    return result


def job_status(root, job_id=None, limit=30):
    if job_id:
        job = load_job(root, job_id)
        result = public_job(job)
        if job.get("asset_id"):
            try:
                result["asset"] = get_asset(root, job["asset_id"])
            except Exception:
                pass
        result["history"] = list(job.get("history") or [])[-30:]
        result["provider_submission"] = dict(job.get("provider_submission") or {})
        return result
    rows = []
    for path in _jobs_dir(root).glob("media-*.json"):
        job = _read_json(path, None)
        if isinstance(job, dict):
            rows.append(public_job(job))
    rows.sort(key=lambda item: float(item.get("created_at") or 0), reverse=True)
    limit = max(1, min(int(limit or 30), 200))
    return {"jobs": rows[:limit], "count": min(len(rows), limit), "total": len(rows)}


def update_job_state(root, job_id, state, detail=None, extra=None):
    state = str(state or "").strip()
    if state not in JOB_STATES:
        raise ValueError(f"invalid media job state: {state}")
    with _state_lock(root):
        job = load_job(root, job_id)
        if job.get("state") in TERMINAL_STATES and state != job.get("state"):
            raise ValueError(f"media job is already {job.get('state')}")
        job["state"] = state
        if detail:
            job["detail"] = str(detail)[:1000]
        if state == "failed":
            job["error"] = str(detail or "media generation failed")[:2000]
        elif state not in {"rate_limited", "needs_user_auth"}:
            job["error"] = None
        if isinstance(extra, dict):
            allowed = {
                "provider", "provider_surface", "provider_submission", "planned_output", "asset_id",
                "retry_after", "capabilities", "reconcile_required", "claimed_by", "claimed_at",
                "attempt", "download", "processing", "result_metadata",
            }
            for key, value in extra.items():
                if key in allowed:
                    job[key] = value
        job.setdefault("history", []).append(_event(state, detail))
        return _save_job(root, job)


def append_job_metadata(root, job_id, patch):
    if not isinstance(patch, dict):
        raise ValueError("patch must be an object")
    with _state_lock(root):
        job = load_job(root, job_id)
        allowed = {
            "provider", "provider_surface", "provider_submission", "planned_output",
            "retry_after", "capabilities", "reconcile_required", "download",
            "processing", "result_metadata",
        }
        for key, value in patch.items():
            if key in allowed:
                job[key] = value
        return _save_job(root, job)


def claim_next_job(root, surface, worker):
    surface = str(surface or "").strip().lower()
    if surface not in {"visual", "music"}:
        raise ValueError("surface must be visual or music")
    with _state_lock(root):
        candidates = []
        now = time.time()
        for path in _jobs_dir(root).glob("media-*.json"):
            job = _read_json(path, None)
            if not isinstance(job, dict):
                continue
            state = job.get("state")
            if state == "queued":
                eligible = True
            elif state == "rate_limited":
                submitted = bool((job.get("provider_submission") or {}).get("submitted_at"))
                retry_after = float(job.get("retry_after") or 0)
                eligible = not submitted and retry_after > 0 and retry_after <= now
            elif state == "waiting_for_browser":
                submitted = bool((job.get("provider_submission") or {}).get("submitted_at"))
                eligible = job.get("reconcile_required") is True and submitted
            else:
                eligible = False
            if not eligible:
                continue
            if job.get("cancel_requested"):
                continue
            if job.get("request", {}).get("surface") != surface:
                continue
            candidates.append(job)
        candidates.sort(key=lambda item: float(item.get("created_at") or 0))
        if not candidates:
            return None
        job = candidates[0]
        job["state"] = "preparing"
        job["claimed_by"] = str(worker or surface)[:120]
        job["claimed_at"] = time.time()
        job["attempt"] = int(job.get("attempt") or 0) + 1
        job.setdefault("history", []).append(_event("preparing", f"Claimed by {job['claimed_by']}"))
        _save_job(root, job)
        return job


def cancel_job(root, job_id):
    with _state_lock(root):
        job = load_job(root, job_id)
        if job.get("state") in TERMINAL_STATES:
            return public_job(job)
        job["cancel_requested"] = True
        if job.get("state") in {"queued", "preparing", "waiting_for_browser", "rate_limited", "needs_user_auth"}:
            job["state"] = "cancelled"
            job.setdefault("history", []).append(_event("cancelled", "Cancellation requested before provider execution"))
        else:
            job.setdefault("history", []).append(_event(job.get("state"), "Cancellation requested"))
        _save_job(root, job)
        return public_job(job)


def _next_destination_index(folder):
    highest = 0
    try:
        for item in Path(folder).iterdir():
            match = re.match(r"^(\d{3,6})_", item.name)
            if match:
                highest = max(highest, int(match.group(1)))
    except OSError:
        pass
    return highest + 1


def prepare_output(root, job_id):
    with _state_lock(root):
        job = load_job(root, job_id)
        if job.get("planned_output"):
            return dict(job["planned_output"])
        request = job["request"]
        folders = ensure_project_folders(root, request["project_path"])["folders"]
        media_type = request["type"]
        ext = "." + _normalize_format(media_type, request.get("format"))
        folder = Path(folders[ASSET_FOLDER[media_type]])
        index = _next_destination_index(folder)
        slug = _prompt_slug(request.get("prompt"), media_type)
        name = f"{index:03d}_{slug}{ext}"
        destination = folder / name
        while destination.exists():
            index += 1
            name = f"{index:03d}_{slug}{ext}"
            destination = folder / name
        planned = {
            "path": str(destination),
            "filename": destination.name,
            "format": ext.lstrip("."),
            "staging_dir": str(_staging_root(root) / job_id),
        }
        if media_type == "sound_effect":
            staging = Path(planned["staging_dir"])
            staging.mkdir(parents=True, exist_ok=True)
            planned["temporary_video_path"] = str(staging / "source.mp4")
        job["planned_output"] = planned
        job.setdefault("history", []).append(_event(job.get("state"), "Output path reserved"))
        _save_job(root, job)
        return dict(planned)


def _allocate_asset_id(data, media_type):
    prefix = ASSET_PREFIX[media_type]
    counters = data.setdefault("counters", {})
    current = int(counters.get(prefix) or 0) + 1
    asset_id = f"TYR-{prefix}-{current:06d}"
    while asset_id in data.setdefault("assets", {}):
        current += 1
        asset_id = f"TYR-{prefix}-{current:06d}"
    counters[prefix] = current
    return asset_id


def register_asset(
    root,
    job_id,
    local_path,
    *,
    provider="google-flow",
    provider_asset_id=None,
    provider_project_id=None,
    provider_url=None,
    generation_settings=None,
    metadata=None,
):
    local = Path(local_path).resolve()
    job = load_job(root, job_id)
    project = Path(job["request"]["project_path"]).resolve()
    generated = (project / "Generated Assets").resolve()
    if not _is_relative_to(local, generated):
        raise PermissionError("completed media must be inside the project Generated Assets folder")
    if not local.exists() or not local.is_file() or local.stat().st_size <= 0:
        raise ValueError("completed media file is missing or empty")

    with _state_lock(root):
        # Re-read inside the lock to avoid duplicate IDs on concurrent completion.
        job = load_job(root, job_id)
        if job.get("asset_id"):
            return get_asset(root, job["asset_id"])
        registry = _load_assets(root)
        asset_id = _allocate_asset_id(registry, job["request"]["type"])
        now = time.time()
        asset = {
            "asset_id": asset_id,
            "type": job["request"]["type"],
            "provider": str(provider or job.get("provider_surface") or "google-flow"),
            "prompt": job["request"].get("prompt"),
            "project_path": str(project),
            "local_path": str(local),
            "provider_asset_id": provider_asset_id,
            "provider_project_id": provider_project_id,
            "provider_url": provider_url,
            "parent_asset_ids": list(job.get("parent_asset_ids") or []),
            "created_at": now,
            "generation_settings": generation_settings if isinstance(generation_settings, dict) else job["request"].get("generation_settings") or {},
            "status": "completed",
            "job_id": job_id,
            "metadata": metadata if isinstance(metadata, dict) else {},
        }
        registry["assets"][asset_id] = asset
        _save_assets(root, registry)
        job["asset_id"] = asset_id
        job["state"] = "completed"
        job["error"] = None
        job["reconcile_required"] = False
        job.setdefault("history", []).append(_event("completed", f"Registered {asset_id}"))
        _save_job(root, job)
        return asset


def cleanup_staging(root, job_id):
    target = _staging_root(root) / str(job_id)
    if target.exists():
        shutil.rmtree(target, ignore_errors=True)
    return {"ok": not target.exists(), "path": str(target)}


def connection_status(root):
    data = _read_json(_connection_file(root), {})
    if not isinstance(data, dict):
        data = {}
    return {
        "provider": "google-media",
        "connected": data.get("connected") is True,
        "needs_user_auth": data.get("needs_user_auth") is True,
        "challenged": data.get("challenged") is True,
        "flow_ready": data.get("flow_ready") is True,
        "music_ready": data.get("music_ready") is True,
        "music_signed_in": data.get("music_signed_in") is True,
        "capabilities": data.get("capabilities") if isinstance(data.get("capabilities"), dict) else {},
        "detail": str(data.get("detail") or "Google Media browser session has not reported status yet"),
        "updated_at": data.get("updated_at"),
    }


def write_connection_status(root, patch):
    current = _read_json(_connection_file(root), {})
    if not isinstance(current, dict):
        current = {}
    allowed = {
        "connected", "needs_user_auth", "challenged", "flow_ready", "music_ready", "music_signed_in",
        "capabilities", "detail", "flow_url", "music_url",
    }
    for key, value in (patch or {}).items():
        if key in allowed:
            current[key] = value
    current["provider"] = "google-media"
    current["updated_at"] = time.time()
    _atomic_write(_connection_file(root), current)
    return connection_status(root)


def recover_incomplete_jobs(root):
    report = {"requeued": [], "reconcile_required": [], "unchanged": [], "errors": []}
    for path in _jobs_dir(root).glob("media-*.json"):
        try:
            job = _read_json(path, None)
            if not isinstance(job, dict):
                continue
            state = job.get("state")
            if state not in RUNTIME_IN_PROGRESS:
                report["unchanged"].append(job.get("job_id") or path.stem)
                continue
            submitted = bool((job.get("provider_submission") or {}).get("submitted_at"))
            if state == "preparing" and not submitted:
                job["state"] = "queued"
                job["claimed_by"] = None
                job["claimed_at"] = None
                job["reconcile_required"] = False
                job.setdefault("history", []).append(_event("queued", "Recovered before provider submission"))
                report["requeued"].append(job["job_id"])
            else:
                # Never blindly resubmit once submission may have occurred.
                job["state"] = "waiting_for_browser"
                job["reconcile_required"] = True
                job.setdefault("history", []).append(_event(
                    "waiting_for_browser",
                    "Restart recovery requires provider reconciliation before any resubmission",
                ))
                report["reconcile_required"].append(job["job_id"])
            _save_job(root, job)
        except Exception as exc:
            report["errors"].append({"path": str(path), "error": str(exc)[:1000]})
    return report


def mark_reconciled(root, job_id, *, provider_submission=None, resume_state="generating"):
    if resume_state not in {"generating", "downloading", "processing", "queued", "failed"}:
        raise ValueError("invalid reconciliation state")
    extra = {
        "reconcile_required": False,
        "provider_submission": provider_submission or load_job(root, job_id).get("provider_submission") or {},
    }
    return update_job_state(root, job_id, resume_state, "Provider state reconciled after restart", extra)



def resume_auth_jobs(root):
    """Requeue only auth-blocked jobs that were never submitted to a provider."""
    resumed = []
    preserved = []
    for path in _jobs_dir(root).glob("media-*.json"):
        job = _read_json(path, None)
        if not isinstance(job, dict) or job.get("state") != "needs_user_auth":
            continue
        submitted = bool((job.get("provider_submission") or {}).get("submitted_at"))
        if submitted:
            job["state"] = "waiting_for_browser"
            job["reconcile_required"] = True
            job.setdefault("history", []).append(_event("waiting_for_browser", "Authentication restored; provider reconciliation required"))
            _save_job(root, job)
            preserved.append(job["job_id"])
        else:
            job["state"] = "queued"
            job["claimed_by"] = None
            job["claimed_at"] = None
            job["reconcile_required"] = False
            job.setdefault("history", []).append(_event("queued", "Authentication restored; safe to retry before submission"))
            _save_job(root, job)
            resumed.append(job["job_id"])
    return {"resumed": resumed, "reconcile_required": preserved}

def summary(root):
    jobs = job_status(root, None, 200)["jobs"]
    counts = {}
    for job in jobs:
        counts[job.get("status") or "unknown"] = counts.get(job.get("status") or "unknown", 0) + 1
    return {
        "jobs": counts,
        "assets": len(_load_assets(root)["assets"]),
        "connection": connection_status(root),
    }
