"""Suno (suno.com) in TEAMYRA's durable media queue.

Suno makes songs in its own embedded-browser accounts (profiles/suno/<id>,
plus the built-in account "suno"); the desktop worker (apps/desktop/src/media/
suno-*.js) drives the Create page. This module owns the Python side:

- request validation for engine="suno" (media_generate / media_batch),
- the Suno accounts and their last observed sign-in state,
- preview assets: each generated clip is saved from the audio the Suno page
  itself streams for playback (no Download click, no download credit) and
  registered as a media asset marked preview=True,
- official downloads (suno_download): a separate job that clicks Suno's own
  Download for one clip in the account that made it (this one does use the
  account's download allowance) and registers the final asset linked to its
  preview,
- per-account cooldowns after Suno's credit / download-limit / rate-limit
  messages (scopes: generate, download, all).
"""
from __future__ import annotations

import json
import re
import time
from pathlib import Path

import media_engine as me

ENGINE = "suno"
SURFACE = "suno"
PROVIDER = "suno"
BUILTIN_PROFILE = "suno"
SUNO_MODES = {"simple", "custom"}
SUNO_VOCAL_GENDERS = {"male", "female"}
SUNO_DOWNLOAD_FORMATS = {"mp3", "wav"}
SUNO_SCOPES = {"all", "generate", "download"}
SUNO_CLIPS_PER_REQUEST = 2
MAX_LYRICS = 20000
MAX_STYLE = 1000
MAX_TITLE = 120
MAX_OPTIONS = 12
_CLIP_ID_RE = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
SUNO_KEYS = ("suno_mode", "suno_style", "suno_title", "suno_model", "suno_vocal_gender", "suno_exclude_styles",
             "suno_weirdness", "suno_style_influence", "suno_options")
PREVIEW_FOLDER = ("Music", "Previews")


def is_suno_engine(value):
    return str(value or "").strip().lower() in {"suno", "suno-ai", "suno_ai"}


def valid_clip_id(value):
    return bool(_CLIP_ID_RE.fullmatch(str(value or "").strip()))


# ---- accounts ---------------------------------------------------------------

def _profiles_dir(root):
    return Path(root) / "profiles" / "suno"


def builtin_meta_file(root):
    return _profiles_dir(root) / "builtin-suno.json"


def _status_file(root):
    return me._media_root(root) / "suno-accounts.json"


def _read(path):
    try:
        value = json.loads(Path(path).read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except Exception:
        return {}


def suno_accounts(root):
    """Every Suno account: id, name, enabled, last observed sign-in state, cooldowns."""
    builtin = _read(builtin_meta_file(root))
    accounts = [{"profile_id": BUILTIN_PROFILE, "name": str(builtin.get("name") or "Suno Account 1"),
                 "enabled": builtin.get("enabled") is not False}]
    try:
        entries = sorted(_profiles_dir(root).iterdir())
    except OSError:
        entries = []
    for entry in entries:
        if not entry.is_dir() or entry.name == BUILTIN_PROFILE:
            continue
        meta = _read(entry / "teamyra-profile.json")
        accounts.append({"profile_id": entry.name, "name": str(meta.get("name") or entry.name),
                         "enabled": meta.get("enabled") is not False})
    status = _read(_status_file(root)).get("profiles") or {}
    cooldowns = me.engine_cooldowns(root, ENGINE)
    for item in accounts:
        state = status.get(item["profile_id"]) if isinstance(status, dict) else None
        state = state if isinstance(state, dict) else {}
        item["signed_in"] = state.get("signed_in") is True
        item["checked_at"] = state.get("checked_at")
        if state.get("credits") is not None:
            item["credits"] = state.get("credits")
        if state.get("detail"):
            item["detail"] = str(state.get("detail"))[:300]
        item["cooldowns"] = [{"scope": row.get("scope"), "until": row.get("until"), "reason": row.get("reason")}
                             for row in cooldowns if me._profile_id(row.get("profile_id")) == item["profile_id"]]
    return accounts


def write_account_status(root, profile_id, patch):
    """The desktop reports what it saw of one Suno account (signed in, credits)."""
    if not isinstance(patch, dict):
        raise ValueError("patch must be an object")
    profile = me._profile_id(profile_id or BUILTIN_PROFILE)
    with me._state_lock(root):
        data = _read(_status_file(root))
        profiles = data.get("profiles") if isinstance(data.get("profiles"), dict) else {}
        entry = dict(profiles.get(profile) or {})
        for key in ("signed_in", "credits", "detail", "user"):
            if key in patch:
                entry[key] = patch[key]
        entry["checked_at"] = time.time()
        profiles[profile] = entry
        me._atomic_write(_status_file(root), {"version": 1, "profiles": profiles})
    return entry


def resolve_suno_accounts(root, values):
    """Account ids for a job's `accounts` (ids or unique names of Suno accounts)."""
    if isinstance(values, str):
        values = [values]
    if not isinstance(values, list) or not values:
        raise ValueError("accounts must be a non-empty array of Suno account ids or names")
    accounts = suno_accounts(root)
    chosen = []
    for value in values:
        text = str(value or "").strip()
        match = [item for item in accounts if item["profile_id"] == text] or \
            [item for item in accounts if item["name"].lower() == text.lower()]
        if not match:
            raise ValueError(f"unknown Suno account: {text}; known: " +
                             ", ".join(f"{item['profile_id']} ({item['name']})" for item in accounts))
        if len(match) > 1:
            raise ValueError(f"several Suno accounts are named {text!r}; use an id: " +
                             ", ".join(item["profile_id"] for item in match))
        item = match[0]
        if not item["enabled"]:
            raise ValueError(f"Suno account {item['profile_id']} ({item['name']}) is turned off in the Agents panel")
        if item["profile_id"] not in chosen:
            chosen.append(item["profile_id"])
    return chosen


# ---- requests ---------------------------------------------------------------

def _text(request, key, limit):
    value = request.get(key)
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError(f"{key} must be a string")
    value = value.strip()
    if len(value) > limit:
        raise ValueError(f"{key} is longer than {limit} characters")
    return value or None


def _slider(request, key):
    value = request.get(key)
    if value is None or value == "":
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        raise ValueError(f"{key} must be a number from 0 to 100 (percent, as Suno's slider shows it)") from None
    if number < 0 or number > 100:
        raise ValueError(f"{key} must be from 0 to 100")
    return round(number)


def _options(value):
    if value in (None, {}):
        return {}
    if not isinstance(value, dict):
        raise ValueError("suno_options must be an object of {option name: value}")
    if len(value) > MAX_OPTIONS:
        raise ValueError(f"suno_options takes at most {MAX_OPTIONS} options")
    result = {}
    for key, item in value.items():
        name = re.sub(r"\s+", " ", str(key or "")).strip()[:60]
        if not name:
            raise ValueError("suno_options names must not be empty")
        if not isinstance(item, (str, int, float, bool)):
            raise ValueError(f"suno_options[{name!r}] must be a string, number or boolean")
        result[name] = item.strip()[:400] if isinstance(item, str) else item
    return result


def normalize_request(root, request, media_type, project, prompt):
    """A Suno generation: simple (song description) or custom (lyrics, style,
    title) with the model and the Create page's other options by name."""
    if media_type not in me.MUSIC_TYPES:
        raise ValueError("engine=suno makes songs: use type music, song, instrumental, background_music (or audio)")
    for key in ("gemini_model", "gemini_mode", "gemini_tool", "gemini_thinking", "vids_mode", "source_video",
                "first_frame", "last_frame", "character_reference", "video_reference", "audio_reference"):
        if request.get(key):
            raise ValueError(f"{key} is not supported with engine=suno")
    if request.get("references"):
        raise ValueError("engine=suno takes no references (upload/cover/extend are not automated)")
    lyrics = _text(request, "lyrics", MAX_LYRICS)
    style = _text(request, "suno_style", MAX_STYLE)
    title = _text(request, "suno_title", MAX_TITLE)
    mode = str(request.get("suno_mode") or "").strip().lower() or ("custom" if (lyrics or style or title) else "simple")
    if mode not in SUNO_MODES:
        raise ValueError("suno_mode must be simple (song description) or custom (lyrics, style, title)")
    instrumental = request.get("instrumental") is True or media_type in {"instrumental", "background_music"}
    if instrumental and request.get("vocals") is True:
        raise ValueError("instrumental and vocals cannot both be true")
    if instrumental and request.get("instrumental") is False:
        raise ValueError(f"type={media_type} is instrumental; drop instrumental=false")
    if mode == "simple":
        if lyrics or style or title:
            raise ValueError("lyrics, suno_style and suno_title need suno_mode=custom")
    else:
        if not lyrics and not instrumental:
            # Custom mode without lyrics: the prompt is the lyrics.
            lyrics = prompt
        if instrumental and lyrics:
            raise ValueError("an instrumental takes no lyrics; drop lyrics or instrumental")
        if not style and not lyrics:
            raise ValueError("custom mode needs suno_style (style of music) or lyrics")
    gender = str(request.get("suno_vocal_gender") or "").strip().lower() or None
    if gender and gender not in SUNO_VOCAL_GENDERS:
        raise ValueError("suno_vocal_gender must be male or female")
    if gender and instrumental:
        raise ValueError("suno_vocal_gender does not apply to an instrumental")
    model = re.sub(r"\s+", " ", str(request.get("suno_model") or "")).strip()[:40] or None
    fmt = str(request.get("format") or "").strip().lower().lstrip(".")
    if fmt and fmt != "m4a":
        raise ValueError("engine=suno generation saves previews as the page streams them (m4a); "
                         "choose mp3 or wav in suno_download for the official file")
    if request.get("output_count") not in (None, SUNO_CLIPS_PER_REQUEST):
        raise ValueError("Suno makes 2 clips per request; output_count cannot be changed")
    settings = {"engine": "suno", "suno_mode": mode, "suno_model": model or "page default",
                "instrumental": instrumental, "preview_only": True, "download": "suno_download (separate, uses the download allowance)"}
    result = {
        "type": media_type,
        "prompt": prompt,
        "provider_prompt": prompt,
        "project_path": str(project),
        "surface": SURFACE,
        "engine": ENGINE,
        "suno_action": "generate",
        "suno_mode": mode,
        "lyrics": lyrics if mode == "custom" else None,
        "suno_style": style,
        "suno_title": title,
        "suno_model": model,
        "suno_vocal_gender": gender,
        "suno_exclude_styles": _text(request, "suno_exclude_styles", MAX_STYLE),
        "suno_weirdness": _slider(request, "suno_weirdness"),
        "suno_style_influence": _slider(request, "suno_style_influence"),
        "suno_options": _options(request.get("suno_options")),
        "instrumental": instrumental,
        "vocals": not instrumental,
        "aspect_ratio": None,
        "duration": None,
        "format": "m4a",
        "references": [],
        "output_count": SUNO_CLIPS_PER_REQUEST,
        "model_preference": model or "page default",
        "reference_mode": "none",
        "generation_settings": settings,
    }
    if request.get("max_parallel") is not None:
        result["max_parallel"] = max(1, min(int(request.get("max_parallel")), me.MAX_PARALLEL))
    if request.get("accounts"):
        result["accounts"] = resolve_suno_accounts(root, request.get("accounts"))
    ensure_folders(root, project)
    return result


def ensure_folders(root, project):
    folders = me.ensure_project_folders(root, project)
    previews = Path(folders["generated_assets"]).joinpath(*PREVIEW_FOLDER)
    previews.mkdir(parents=True, exist_ok=True)
    return previews


# ---- preview assets -------------------------------------------------------------

def preview_paths(root, job_id, clips):
    """Destinations for a job's preview clips: Generated Assets/Music/Previews/
    <title>_<clip id>.preview.<ext> (clip ids are unique, so no reservation)."""
    job = me.load_job(root, job_id)
    request = job["request"]
    folder = ensure_folders(root, request["project_path"])
    result = {}
    for clip in clips or []:
        clip_id = str((clip or {}).get("clip_id") or "").strip()
        if not valid_clip_id(clip_id):
            raise ValueError(f"invalid Suno clip id: {clip_id!r}")
        ext = str((clip or {}).get("ext") or "m4a").lower().lstrip(".")
        if ext not in {"m4a", "mp4", "mp3", "webm", "ogg", "wav", "aac"}:
            raise ValueError(f"unexpected preview audio type: {ext}")
        if ext == "mp4":
            ext = "m4a"
        slug = me.slugify((clip or {}).get("title") or request.get("suno_title") or request.get("prompt"), "song", 48)
        result[clip_id] = str(folder / f"{slug}_{clip_id[:8]}.preview.{ext}")
    return {"paths": result, "folder": str(folder)}


def register_previews(root, job_id, clips):
    """Register every clip of a Suno job as a preview asset and complete the job.

    clips: [{clip_id, local_path, title, provider_url, metadata}]. The first
    clip's asset becomes the job's asset_id; all of them are in asset_ids."""
    if not isinstance(clips, list) or not clips:
        raise ValueError("clips must be a non-empty array")
    job = me.load_job(root, job_id)
    project = Path(job["request"]["project_path"]).resolve()
    generated = (project / "Generated Assets").resolve()
    checked = []
    for clip in clips:
        clip_id = str(clip.get("clip_id") or "").strip()
        if not valid_clip_id(clip_id):
            raise ValueError(f"invalid Suno clip id: {clip_id!r}")
        local = Path(str(clip.get("local_path") or "")).resolve()
        if not me._is_relative_to(local, generated):
            raise PermissionError("preview audio must be inside the project Generated Assets folder")
        if not local.is_file() or local.stat().st_size <= 0:
            raise ValueError(f"preview file for clip {clip_id} is missing or empty")
        checked.append((clip_id, local, clip))
    with me._state_lock(root):
        job = me.load_job(root, job_id)
        if job.get("asset_ids"):
            return {"assets": [me.get_asset(root, item) for item in job["asset_ids"]], "job": me.public_job(job)}
        if job.get("cancel_requested") or job.get("state") == "cancelled":
            raise ValueError("cancelled media job cannot register assets")
        registry = me._load_assets(root)
        now = time.time()
        assets = []
        submission = job.get("provider_submission") or {}
        for index, (clip_id, local, clip) in enumerate(checked):
            asset_id = me._allocate_asset_id(registry, job["request"]["type"])
            metadata = dict(clip.get("metadata") or {}) if isinstance(clip.get("metadata"), dict) else {}
            metadata.update({"preview": True, "suno_clip_id": clip_id, "clip_index": index,
                             "suno_profile_id": submission.get("profile_id") or job.get("claimed_profile"),
                             "title": clip.get("title") or metadata.get("title")})
            asset = {
                "asset_id": asset_id,
                "type": job["request"]["type"],
                "provider": PROVIDER,
                "prompt": job["request"].get("prompt"),
                "project_path": str(project),
                "local_path": str(local),
                "provider_asset_id": clip_id,
                "provider_project_id": None,
                "provider_url": clip.get("provider_url") or f"https://suno.com/song/{clip_id}",
                "parent_asset_ids": list(job.get("parent_asset_ids") or []),
                "created_at": now,
                "generation_settings": job["request"].get("generation_settings") or {},
                "status": "preview",
                "preview": True,
                "job_id": job_id,
                "metadata": metadata,
            }
            registry["assets"][asset_id] = asset
            assets.append(asset)
        for asset in assets:
            asset["metadata"]["sibling_asset_ids"] = [item["asset_id"] for item in assets if item is not asset]
        me._save_assets(root, registry)
        job["asset_id"] = assets[0]["asset_id"]
        job["asset_ids"] = [item["asset_id"] for item in assets]
        job["state"] = "completed"
        job["error"] = None
        job["reconcile_required"] = False
        job.setdefault("history", []).append(me._event(
            "completed", "Registered previews " + ", ".join(job["asset_ids"]) + " (no download credit used)"))
        me._save_job(root, job)
        return {"assets": assets, "job": me.public_job(job)}


def link_final(registry, job, asset_id):
    """Inside register_asset's lock: a finished suno_download points its preview at it."""
    request = job.get("request") or {}
    if request.get("suno_action") != "download":
        return
    fmt = str(request.get("format") or "").lower()
    for parent in job.get("parent_asset_ids") or []:
        preview = registry["assets"].get(parent)
        if isinstance(preview, dict):
            meta = preview.setdefault("metadata", {})
            finals = meta.get("final_assets") if isinstance(meta.get("final_assets"), dict) else {}
            finals[fmt] = asset_id
            meta["final_assets"] = finals


# ---- official download --------------------------------------------------------------

def _preview_for_clip(root, clip_id):
    rows = [asset for asset in me._assets_snapshot(root).values()
            if isinstance(asset, dict) and asset.get("provider") == PROVIDER and asset.get("provider_asset_id") == clip_id
            and (asset.get("preview") or (asset.get("metadata") or {}).get("preview"))]
    rows.sort(key=lambda item: float(item.get("created_at") or 0), reverse=True)
    return rows[0] if rows else None


def create_download_job(root, args):
    """suno_download: queue Suno's own Download of one clip (uses the account's
    download allowance) in the account that made it. An existing final file of
    the same format, or a download of it already queued, is returned instead."""
    args = dict(args or {})
    fmt = str(args.get("format") or "mp3").strip().lower().lstrip(".")
    if fmt not in SUNO_DOWNLOAD_FORMATS:
        raise ValueError("format must be mp3 or wav (Suno's Download menu: MP3 audio, WAV audio)")
    preview = None
    if args.get("asset_id"):
        preview = me.get_asset(root, args["asset_id"])
        if preview.get("provider") != PROVIDER or not valid_clip_id(preview.get("provider_asset_id")):
            raise ValueError(f"{preview['asset_id']} is not a Suno clip asset")
        clip_id = preview["provider_asset_id"]
        if args.get("clip_id") and str(args["clip_id"]).strip() != clip_id:
            raise ValueError("asset_id and clip_id name different clips")
        if not (preview.get("preview") or (preview.get("metadata") or {}).get("preview")):
            # Already a final asset: follow it back to its preview.
            parents = [me.get_asset(root, item) for item in preview.get("parent_asset_ids") or []]
            preview = next((item for item in parents if item.get("provider_asset_id") == clip_id), preview)
    else:
        clip_id = str(args.get("clip_id") or "").strip()
        if not valid_clip_id(clip_id):
            raise ValueError("asset_id (a Suno preview asset) or clip_id (Suno song id, a UUID) is required")
        preview = _preview_for_clip(root, clip_id)
    meta = (preview or {}).get("metadata") or {}
    if preview:
        project = me._validate_project(root, preview.get("project_path"))
        account = me._profile_id(meta.get("suno_profile_id") or BUILTIN_PROFILE)
        if args.get("account"):
            chosen = resolve_suno_accounts(root, args["account"])[0]
            if chosen != account:
                raise ValueError(f"clip {clip_id} was made in Suno account {account}; it can only be downloaded there")
        finals = meta.get("final_assets") if isinstance(meta.get("final_assets"), dict) else {}
        if finals.get(fmt):
            try:
                final = me.get_asset(root, finals[fmt])
                if Path(final.get("local_path") or "").is_file():
                    return {"already_downloaded": True, "asset": final, "preview_asset_id": preview["asset_id"],
                            "note": "This clip was already downloaded in this format; no download was used."}
            except ValueError:
                pass
    else:
        if not args.get("project_path"):
            raise ValueError("clip " + clip_id + " has no TEAMYRA preview asset: pass project_path (and account if it is not the built-in Suno account)")
        project = me._validate_project(root, args.get("project_path"))
        account = resolve_suno_accounts(root, args.get("account") or BUILTIN_PROFILE)[0]
    # A download of this clip in this format already queued or running: return it.
    for summary in me._job_summaries(root):
        request = summary.get("request") or {}
        if summary.get("state") in me.TERMINAL_STATES or request.get("suno_action") != "download":
            continue
        job = me._read_json(me._job_path(root, summary["job_id"]), None)
        if isinstance(job, dict) and (job.get("request") or {}).get("suno_clip_id") == clip_id and \
                (job.get("request") or {}).get("format") == fmt:
            return {"already_queued": True, **me.public_job(job)}
    title = str(meta.get("title") or args.get("title") or "").strip()[:MAX_TITLE]
    media_type = (preview or {}).get("type") if (preview or {}).get("type") in me.MUSIC_TYPES else "song"
    ensure_folders(root, project)
    normalized = {
        "type": media_type,
        "prompt": title or f"suno {clip_id[:8]}",
        "provider_prompt": None,
        "project_path": str(project),
        "surface": SURFACE,
        "engine": ENGINE,
        "suno_action": "download",
        "suno_clip_id": clip_id,
        "suno_title": title or None,
        "source_prompt": (preview or {}).get("prompt"),
        "format": fmt,
        "references": [],
        "output_count": 1,
        "instrumental": bool(meta.get("instrumental")),
        "vocals": not bool(meta.get("instrumental")),
        "aspect_ratio": None,
        "duration": None,
        "accounts": [account],
        "model_preference": meta.get("model") or "",
        "reference_mode": "none",
        "generation_settings": {"engine": "suno", "suno_action": "download", "download_format": fmt,
                                "uses_download_allowance": True},
    }
    parents = [preview["asset_id"]] if preview else []
    job = me.create_job(root, None, prepared=(normalized, [], parents))
    job["preview_asset_id"] = parents[0] if parents else None
    job["note"] = ("Queued Suno's own Download (" + fmt.upper() + ") in account " + account +
                   "; this uses that account's download allowance. Poll media_status with this job_id.")
    return job


# ---- clips listing ------------------------------------------------------------

def known_clips(root, account=None, limit=50):
    """Clips TEAMYRA knows from its preview/final assets, newest first."""
    rows = {}
    for asset in me._assets_snapshot(root).values():
        if not isinstance(asset, dict) or asset.get("provider") != PROVIDER:
            continue
        clip_id = asset.get("provider_asset_id")
        if not valid_clip_id(clip_id):
            continue
        meta = asset.get("metadata") or {}
        profile = meta.get("suno_profile_id")
        if account and profile and profile != account:
            continue
        row = rows.setdefault(clip_id, {"clip_id": clip_id, "account": profile, "title": meta.get("title"),
                                        "url": asset.get("provider_url"), "preview_asset_id": None,
                                        "final_assets": {}, "created_at": 0})
        row["created_at"] = max(row["created_at"], float(asset.get("created_at") or 0))
        if asset.get("preview") or meta.get("preview"):
            row["preview_asset_id"] = asset["asset_id"]
            row["preview_path"] = asset.get("local_path")
            row["duration"] = meta.get("duration")
            row["style"] = meta.get("style")
            row["model"] = meta.get("model")
            row["verdict_hints"] = meta.get("verification", {}).get("hints") if isinstance(meta.get("verification"), dict) else None
            row["final_assets"].update(meta.get("final_assets") or {})
        else:
            row["final_assets"].setdefault(str((asset.get("generation_settings") or {}).get("download_format") or
                                               Path(asset.get("local_path") or "").suffix.lstrip(".")), asset["asset_id"])
    result = sorted(rows.values(), key=lambda item: item["created_at"], reverse=True)
    return result[:max(1, min(int(limit or 50), 200))]


def merge_clips(live, known):
    """Live clips from the Suno page, with what TEAMYRA has of each."""
    by_id = {item["clip_id"]: item for item in known}
    merged = []
    for clip in live or []:
        if not isinstance(clip, dict) or not valid_clip_id(clip.get("clip_id")):
            continue
        item = dict(clip)
        mine = by_id.get(clip["clip_id"])
        if mine:
            item["preview_asset_id"] = mine.get("preview_asset_id")
            item["final_assets"] = mine.get("final_assets") or {}
        merged.append(item)
    return merged


# ---- limits --------------------------------------------------------------------

def limit_handoff(root, job_id, profile_id, *, seconds=3600, reason=None, scope=None):
    """Suno said this account is out of credits / at its download limit /
    rate limited: rest the account (generate, download or all) and give the
    job back to the queue. A generation moves to another Suno account; a
    download waits for this account (the clip lives only there)."""
    job = me.load_job(root, job_id)
    action = (job.get("request") or {}).get("suno_action") or "generate"
    scope = scope or action
    if scope not in SUNO_SCOPES:
        raise ValueError("scope must be generate, download or all")
    note = ("; the download waits until this account's limit resets (the clip exists only in this account)"
            if action == "download" else "; the job moves to another Suno account (or waits until this one rests)")
    return me.engine_limit_handoff(root, ENGINE, job_id, profile_id, seconds=seconds, reason=reason, scope=scope,
                                   label="Suno limit", note=note,
                                   wait_for_cooldown=action == "download")


CAPABILITIES = {
    "engine": "suno",
    "site": "https://suno.com/create",
    "accounts": "Suno accounts of the Agents panel (built-in 'suno' + '+ Account'), each its own embedded browser session; "
                "the user signs in with Open. Signed-out or turned-off accounts take no work",
    "types": ["music", "song", "instrumental", "background_music", "audio (alias of music)"],
    "suno_mode": {"simple": "prompt = the song description", "custom": "lyrics, suno_style (style of music), suno_title"},
    "options": {"instrumental": "true/false (Instrumental switch)",
                "suno_model": "A model the Create page lists, by name (e.g. v4.5, v5, v6); default the page's current one; missing: option_unavailable with the list",
                "suno_vocal_gender": "male | female (custom mode, when the page shows it)",
                "suno_exclude_styles": "Exclude styles text",
                "suno_weirdness": "0-100 slider", "suno_style_influence": "0-100 slider",
                "suno_options": "{name: value} for any other visible Create-page option by its label"},
    "clips_per_request": SUNO_CLIPS_PER_REQUEST,
    "preview": "Each clip is saved from the audio the Suno page streams for playback (no Download click, no download credit): "
               "Generated Assets/Music/Previews/<title>_<clip>.preview.m4a, registered with preview=true and verification "
               "data (duration, bitrate, loudness, silence, lyrics/style/title Suno shows, transcript when a local whisper exists)",
    "download": "suno_download {asset_id or clip_id, format mp3|wav}: Suno's own Download in the account that made the clip "
                "(uses its download allowance); saved to Generated Assets/Music and linked to the preview",
    "clips": "suno_clips {account?, limit}: recent clips with ids and status",
    "usage_limits": "Out of credits / download limit / rate limit: that account rests (generate, download or all); "
                    "queued generations move to another Suno account",
    "failure_categories": {"login_required": "sign the Suno account in with Open in the Agents panel",
                           "option_unavailable": "not recoverable: choose an option the error lists",
                           "rate_limited": "the account rests; generations move to another account",
                           "selector_failure": "recoverable", "generation_failure": "inspect; Suno may have failed the clip",
                           "policy_refusal": "reword (Suno refused the lyrics/style)", "download_failure": "recoverable"},
}
