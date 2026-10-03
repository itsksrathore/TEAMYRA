"""Persistent structured handoff records for TEAMYRA."""
from __future__ import annotations

import json
import os
import re
import time
import uuid
from pathlib import Path

HANDOFF_ID_RE = re.compile(r"^handoff-[A-Za-z0-9._-]{1,96}$")
MAX_ITEMS = 24
MAX_ITEM_CHARS = 1200
MAX_MESSAGE = 8000
MAX_SUMMARY = 6000
MAX_SECTION = 5000
MAX_PROMPT = 24000


def _dir(root):
    path = Path(root) / "tasks" / "handoffs"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _path(root, handoff_id):
    if not HANDOFF_ID_RE.fullmatch(str(handoff_id or "")):
        raise ValueError("invalid handoff id")
    return _dir(root) / f"{handoff_id}.json"


def _atomic_write(path, payload):
    tmp = path.with_name(path.name + f".tmp-{os.getpid()}-{uuid.uuid4().hex[:6]}")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, path)


def _text(value, limit):
    return str(value or "").strip()[:limit]


def _items(values):
    out = []
    for value in values or []:
        item = _text(value, MAX_ITEM_CHARS)
        if not item or item in out:
            continue
        out.append(item)
        if len(out) >= MAX_ITEMS:
            break
    return out


def create(
    root,
    *,
    project_path,
    source_job_id,
    terminal_job_id,
    source_worker,
    target_worker,
    message,
    objective=None,
    constraints=None,
    acceptance_criteria=None,
    artifacts=None,
    notes=None,
    source_state=None,
    source_final_message=None,
    git_status=None,
    diffstat=None,
    memory_context=None,
    write=False,
    label=None,
):
    message = _text(message, MAX_MESSAGE)
    if not message:
        raise ValueError("handoff message is required")
    now = time.time()
    handoff_id = "handoff-" + time.strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:6]
    record = {
        "id": handoff_id,
        "project_path": str(Path(project_path).resolve()),
        "source_job_id": str(source_job_id),
        "terminal_job_id": str(terminal_job_id),
        "source_worker": str(source_worker or ""),
        "target_worker": str(target_worker or ""),
        "target_job_id": None,
        "label": _text(label or f"handoff from {source_job_id}", 120),
        "objective": _text(objective, 2000) or None,
        "message": message,
        "constraints": _items(constraints),
        "acceptance_criteria": _items(acceptance_criteria),
        "artifacts": _items(artifacts),
        "notes": _text(notes, 4000) or None,
        "write": bool(write),
        "source_state": _text(source_state, 80) or None,
        "source_final_message": _text(source_final_message, MAX_SUMMARY) or None,
        "git_status": _items(git_status),
        "diffstat": _text(diffstat, 2000) or None,
        "memory_context": _text(memory_context, 8000) or None,
        "memory_context_chars": len(_text(memory_context, 8000)),
        "created_at": now,
        "updated_at": now,
    }
    _atomic_write(_path(root, handoff_id), record)
    return record


def load(root, handoff_id):
    path = _path(root, handoff_id)
    if not path.exists():
        raise ValueError(f"no such handoff: {handoff_id}")
    try:
        record = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        raise ValueError(f"handoff record is unreadable: {exc}")
    if not isinstance(record, dict):
        raise ValueError("handoff record has invalid format")
    return record


def save(root, record):
    record["updated_at"] = time.time()
    _atomic_write(_path(root, record["id"]), record)
    return record


def attach_target_job(root, handoff_id, target_job_id, target_worker=None):
    record = load(root, handoff_id)
    record["target_job_id"] = str(target_job_id)
    if target_worker:
        record["target_worker"] = str(target_worker)
    return save(root, record)


def list_records(root, project_path=None, source_job_id=None, target_worker=None, limit=100):
    limit = max(1, min(int(limit or 100), 500))
    project = str(Path(project_path).resolve()).lower() if project_path else None
    rows = []
    for path in _dir(root).glob("handoff-*.json"):
        try:
            record = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            continue
        if not isinstance(record, dict):
            continue
        if project and str(record.get("project_path") or "").lower() != project:
            continue
        if source_job_id and record.get("source_job_id") != source_job_id:
            continue
        if target_worker and record.get("target_worker") != target_worker:
            continue
        rows.append(record)
    rows.sort(key=lambda item: float(item.get("created_at") or 0), reverse=True)
    return {
        "items": [summary(item) for item in rows[:limit]],
        "count": min(len(rows), limit),
        "total_matches": len(rows),
        "clipped": len(rows) > limit,
    }


def summary(record):
    return {
        key: record.get(key)
        for key in (
            "id", "project_path", "source_job_id", "terminal_job_id",
            "source_worker", "target_worker", "target_job_id", "label",
            "objective", "message", "constraints", "acceptance_criteria",
            "artifacts", "notes", "write", "source_state", "diffstat",
            "memory_context_chars", "memory_entry_id", "memory_persist_error",
            "created_at", "updated_at",
        )
    }


def render_prompt(record):
    def section(title, values):
        if not values:
            return ""
        if isinstance(values, str):
            body = values
        else:
            body = "\n".join(f"- {item}" for item in values)
        body = _text(body, MAX_SECTION)
        return f"\n{title}:\n{body}\n"

    body = f"""TEAMYRA structured handoff.

Handoff ID: {record.get('id')}
Source job: {record.get('source_job_id')}
Terminal job: {record.get('terminal_job_id')}
Source worker: {record.get('source_worker')}
Target worker: {record.get('target_worker')}
Source state: {record.get('source_state')}
Diffstat: {record.get('diffstat') or '(none)'}
Write access requested: {'yes' if record.get('write') else 'no'}
"""
    body += section("Objective", record.get("objective"))
    body += section("Requested action", record.get("message"))
    body += section("Constraints", record.get("constraints"))
    body += section("Acceptance criteria", record.get("acceptance_criteria"))
    body += section("Relevant artifacts", record.get("artifacts"))
    body += section("Additional notes", record.get("notes"))
    body += section("Project memory context", record.get("memory_context"))
    body += section("Source worker final message", record.get("source_final_message"))
    body += section("Git status", record.get("git_status"))

    instruction = """
Inspect the actual workspace before acting. Treat handoff summaries and project memory as context, not proof that the code is correct.
Preserve valid completed work. Verify constraints and acceptance criteria against the real files/tests before declaring completion.
"""
    budget = max(0, MAX_PROMPT - len(instruction) - 32)
    if len(body) > budget:
        body = body[:budget] + "\n...[handoff context clipped]\n"
    return body + instruction
