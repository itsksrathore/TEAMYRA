"""Local, project-scoped structured memory for TEAMYRA.

Runtime memory lives under TEAMYRA's ignored memory/ directory rather than inside
user repositories. Entries are file-per-record for resilient updates and easy
inspection. No provider credentials or auth state are copied into this store.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import time
import uuid
from pathlib import Path

KINDS = {"decision", "architecture", "fact", "note", "handoff", "todo"}
IMPORTANCE = {"low": 0, "normal": 1, "high": 2, "critical": 3}
ID_RE = re.compile(r"^mem-[A-Za-z0-9._-]{1,96}$")
MAX_CONTENT = 12000
MAX_TITLE = 200
MAX_ENTRIES = 5000


def _run_git(cwd, *args):
    try:
        cp = subprocess.run(
            ["git", "-C", str(cwd), *args],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=10,
        )
        return cp.stdout.strip() if cp.returncode == 0 else None
    except Exception:
        return None


def project_identity(project_path):
    raw = str(project_path or "").strip()
    if not raw:
        raise ValueError("project_path is required")
    path = Path(raw).expanduser().resolve()
    if not path.exists():
        raise ValueError(f"project path not found: {path}")
    git_root = _run_git(path, "rev-parse", "--show-toplevel")
    root = Path(git_root).resolve() if git_root else path

    # A user's home directory can itself accidentally be a Git repository.
    # Do not collapse every unrelated nested folder under that repo into one
    # TEAMYRA memory namespace unless the caller explicitly selected the home
    # repository itself.
    try:
        home = Path.home().resolve()
    except Exception:
        home = None
    if home is not None and root == home and path != home:
        root = path
        git_root = None

    remote = _run_git(root, "config", "--get", "remote.origin.url") if git_root else None
    identity = (remote or str(root)).strip().lower().replace("\\", "/")
    return {
        "key": hashlib.sha256(identity.encode("utf-8")).hexdigest()[:20],
        "identity": identity,
        "project_path": str(root),
        "remote": remote or None,
    }


def project_key(project_path):
    return project_identity(project_path)["key"]


def _project_dir(runtime_root, project_path, create=True):
    ident = project_identity(project_path)
    path = Path(runtime_root) / "memory" / "projects" / ident["key"]
    if create:
        (path / "entries").mkdir(parents=True, exist_ok=True)
        meta = path / "project.json"
        if not meta.exists():
            _atomic_write(meta, {
                "version": 1,
                "project": ident,
                "created_at": time.time(),
                "updated_at": time.time(),
            })
    return path, ident


def _entry_path(runtime_root, project_path, memory_id, create_project=False):
    if not ID_RE.fullmatch(str(memory_id or "")):
        raise ValueError("invalid memory id")
    path, ident = _project_dir(runtime_root, project_path, create=create_project)
    return path / "entries" / f"{memory_id}.json", ident


def _atomic_write(path, payload):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + f".tmp-{os.getpid()}-{uuid.uuid4().hex[:6]}")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, path)


def _normalize_kind(kind):
    value = str(kind or "").strip().lower()
    if value not in KINDS:
        raise ValueError("kind must be one of: " + ", ".join(sorted(KINDS)))
    return value


def _normalize_importance(value):
    value = str(value or "normal").strip().lower()
    if value not in IMPORTANCE:
        raise ValueError("importance must be one of: " + ", ".join(IMPORTANCE))
    return value


def _normalize_tags(tags):
    out = []
    for raw in tags or []:
        tag = str(raw or "").strip().lower()
        if not tag or tag in out:
            continue
        out.append(tag[:64])
        if len(out) >= 20:
            break
    return out


def _all_entries(runtime_root, project_path):
    directory, _ = _project_dir(runtime_root, project_path, create=False)
    rows = []
    entries_dir = directory / "entries"
    if not entries_dir.exists():
        return rows
    for path in entries_dir.glob("mem-*.json"):
        try:
            item = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            continue
        if isinstance(item, dict):
            rows.append(item)
    return rows


def add(
    runtime_root,
    project_path,
    kind,
    title,
    content,
    tags=None,
    importance="normal",
    source_job_id=None,
    source_graph_id=None,
):
    kind = _normalize_kind(kind)
    importance = _normalize_importance(importance)
    title = str(title or "").strip()
    content = str(content or "").strip()
    if not title:
        raise ValueError("title is required")
    if not content:
        raise ValueError("content is required")

    existing = _all_entries(runtime_root, project_path)
    if len(existing) >= MAX_ENTRIES:
        raise ValueError(f"project memory limit reached ({MAX_ENTRIES})")

    now = time.time()
    memory_id = "mem-" + time.strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:6]
    _, ident = _project_dir(runtime_root, project_path)
    entry = {
        "id": memory_id,
        "project_key": ident["key"],
        "project_path": ident["project_path"],
        "kind": kind,
        "title": title[:MAX_TITLE],
        "content": content[:MAX_CONTENT],
        "tags": _normalize_tags(tags),
        "importance": importance,
        "status": "active",
        "archive_reason": None,
        "source_job_id": str(source_job_id or "").strip()[:120] or None,
        "source_graph_id": str(source_graph_id or "").strip()[:120] or None,
        "created_at": now,
        "updated_at": now,
        "archived_at": None,
    }
    path, _ = _entry_path(runtime_root, project_path, memory_id)
    _atomic_write(path, entry)
    return entry


def get(runtime_root, project_path, memory_id):
    path, _ = _entry_path(runtime_root, project_path, memory_id)
    if not path.exists():
        raise ValueError(f"no such memory: {memory_id}")
    try:
        entry = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        raise ValueError(f"memory entry is unreadable: {exc}")
    if not isinstance(entry, dict):
        raise ValueError("memory entry has invalid format")
    return entry


def update(runtime_root, project_path, memory_id, **patch):
    entry = get(runtime_root, project_path, memory_id)
    if entry.get("status") == "archived":
        raise ValueError("archived memory cannot be updated")

    allowed = {"title", "content", "tags", "importance", "kind"}
    unknown = set(patch) - allowed
    if unknown:
        raise ValueError("unsupported fields: " + ", ".join(sorted(unknown)))

    if "title" in patch:
        value = str(patch["title"] or "").strip()
        if not value:
            raise ValueError("title cannot be empty")
        entry["title"] = value[:MAX_TITLE]
    if "content" in patch:
        value = str(patch["content"] or "").strip()
        if not value:
            raise ValueError("content cannot be empty")
        entry["content"] = value[:MAX_CONTENT]
    if "tags" in patch:
        entry["tags"] = _normalize_tags(patch["tags"])
    if "importance" in patch:
        entry["importance"] = _normalize_importance(patch["importance"])
    if "kind" in patch:
        entry["kind"] = _normalize_kind(patch["kind"])

    entry["updated_at"] = time.time()
    path, _ = _entry_path(runtime_root, project_path, memory_id)
    _atomic_write(path, entry)
    return entry


def archive(runtime_root, project_path, memory_id, reason=None):
    entry = get(runtime_root, project_path, memory_id)
    if entry.get("status") == "archived":
        return entry
    now = time.time()
    entry["status"] = "archived"
    entry["archive_reason"] = str(reason or "").strip()[:500] or None
    entry["archived_at"] = now
    entry["updated_at"] = now
    path, _ = _entry_path(runtime_root, project_path, memory_id)
    _atomic_write(path, entry)
    return entry


def _status_matches(entry, status):
    status = str(status or "active").strip().lower()
    if status not in {"active", "archived", "all"}:
        raise ValueError("status must be active, archived, or all")
    return status == "all" or entry.get("status", "active") == status


def _sort_key(entry):
    return (
        IMPORTANCE.get(entry.get("importance", "normal"), 1),
        float(entry.get("updated_at") or 0),
    )


def list_entries(runtime_root, project_path, kind=None, status="active", tag=None, limit=100):
    limit = max(1, min(int(limit or 100), 500))
    kind = _normalize_kind(kind) if kind else None
    tag = str(tag or "").strip().lower() or None
    rows = []
    for entry in _all_entries(runtime_root, project_path):
        if not _status_matches(entry, status):
            continue
        if kind and entry.get("kind") != kind:
            continue
        if tag and tag not in set(entry.get("tags") or []):
            continue
        rows.append(entry)
    rows.sort(key=_sort_key, reverse=True)
    _, ident = _project_dir(runtime_root, project_path, create=False)
    return {
        "project": ident,
        "items": rows[:limit],
        "count": min(len(rows), limit),
        "total_matches": len(rows),
        "clipped": len(rows) > limit,
    }


def _search_score(entry, terms):
    title = str(entry.get("title") or "").lower()
    content = str(entry.get("content") or "").lower()
    tags = [str(tag).lower() for tag in entry.get("tags") or []]
    kind = str(entry.get("kind") or "").lower()
    score = IMPORTANCE.get(entry.get("importance", "normal"), 1) * 5
    for term in terms:
        if term in title:
            score += 25
        if any(term in tag for tag in tags):
            score += 18
        if term in content:
            score += 10
        if term in kind:
            score += 5
    return score


def search(runtime_root, project_path, query, kinds=None, tags=None, status="active", limit=50):
    query = str(query or "").strip()
    if not query:
        raise ValueError("query is required")
    limit = max(1, min(int(limit or 50), 200))
    normalized_kinds = {_normalize_kind(kind) for kind in (kinds or [])}
    required_tags = {str(tag).strip().lower() for tag in (tags or []) if str(tag).strip()}
    terms = [part for part in re.split(r"\s+", query.lower()) if part]

    rows = []
    for entry in _all_entries(runtime_root, project_path):
        if not _status_matches(entry, status):
            continue
        if normalized_kinds and entry.get("kind") not in normalized_kinds:
            continue
        entry_tags = set(entry.get("tags") or [])
        if required_tags and not required_tags.issubset(entry_tags):
            continue
        score = _search_score(entry, terms)
        if score <= IMPORTANCE.get(entry.get("importance", "normal"), 1) * 5:
            continue
        rows.append((score, entry))

    rows.sort(key=lambda item: (item[0], _sort_key(item[1])), reverse=True)
    _, ident = _project_dir(runtime_root, project_path, create=False)
    items = [entry for _, entry in rows]
    return {
        "project": ident,
        "query": query,
        "items": items[:limit],
        "count": min(len(items), limit),
        "total_matches": len(items),
        "clipped": len(items) > limit,
    }


def context_pack(
    runtime_root,
    project_path,
    query=None,
    kinds=None,
    tags=None,
    max_chars=8000,
    limit=40,
):
    max_chars = max(1000, min(int(max_chars or 8000), 24000))
    limit = max(1, min(int(limit or 40), 100))
    if query:
        source = search(
            runtime_root,
            project_path,
            query,
            kinds=kinds,
            tags=tags,
            status="active",
            limit=limit,
        )["items"]
    else:
        normalized_kinds = {_normalize_kind(kind) for kind in (kinds or [])}
        required_tags = {str(tag).strip().lower() for tag in (tags or []) if str(tag).strip()}
        source = [
            entry
            for entry in _all_entries(runtime_root, project_path)
            if entry.get("status", "active") == "active"
            and (not normalized_kinds or entry.get("kind") in normalized_kinds)
            and (not required_tags or required_tags.issubset(set(entry.get("tags") or [])))
        ]
        source.sort(key=_sort_key, reverse=True)
        source = source[:limit]

    lines = []
    memory_ids = []
    used = 0
    clipped = False
    for entry in source:
        line = (
            f"- [{entry.get('importance','normal')}/{entry.get('kind','note')}] "
            f"{entry.get('title')}: {entry.get('content')}"
        )
        tags_value = entry.get("tags") or []
        if tags_value:
            line += " (tags: " + ", ".join(tags_value) + ")"
        projected = used + len(line) + (1 if lines else 0)
        if projected > max_chars:
            clipped = True
            continue
        lines.append(line)
        memory_ids.append(entry["id"])
        used = projected

    if len(memory_ids) < len(source):
        clipped = True
    _, ident = _project_dir(runtime_root, project_path, create=False)
    text = "\n".join(lines)
    return {
        "project": ident,
        "text": text,
        "memory_ids": memory_ids,
        "count": len(memory_ids),
        "total_entries": len(source),
        "chars": len(text),
        "clipped": clipped,
    }
