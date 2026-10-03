"""Persistent state and parsing helpers for TEAMYRA review cycles."""
import json
import os
import re
import time
import uuid
from pathlib import Path

REVIEW_ID_RE = re.compile(r"^review-[A-Za-z0-9._-]{1,96}$")
DECISION_RE = re.compile(r"TEAMYRA_REVIEW:\s*(PASS|CHANGES)\b", re.IGNORECASE)


def _dir(root):
    path = Path(root) / "tasks" / "reviews"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _path(root, review_id):
    if not REVIEW_ID_RE.fullmatch(str(review_id or "")):
        raise ValueError("invalid review id")
    return _dir(root) / f"{review_id}.json"


def _atomic_write(path, data):
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, path)


def parse_decision(text):
    matches = list(DECISION_RE.finditer(str(text or "")))
    return matches[-1].group(1).upper() if matches else None


def create(root, source_job_id, reviewer_worker="auto", max_rounds=2):
    review_id = "review-" + time.strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:6]
    state = {
        "id": review_id,
        "source_job_id": str(source_job_id),
        "reviewer_worker": str(reviewer_worker or "auto"),
        "max_rounds": max(1, min(int(max_rounds), 5)),
        "round": 0,
        "state": "draft",
        "decision": None,
        "active_job_id": None,
        "implementation_job_id": str(source_job_id),
        "review_jobs": [],
        "fix_jobs": [],
        "cancel_requested": False,
        "error": None,
        "created_at": time.time(),
        "updated_at": time.time(),
    }
    _atomic_write(_path(root, review_id), state)
    return state


def load(root, review_id):
    path = _path(root, review_id)
    if not path.exists():
        raise ValueError(f"no such review cycle: {review_id}")
    return json.loads(path.read_text(encoding="utf-8"))


def save(root, state):
    state["updated_at"] = time.time()
    _atomic_write(_path(root, state["id"]), state)
    return state


def summary(state):
    return {
        "id": state["id"],
        "source_job_id": state.get("source_job_id"),
        "implementation_job_id": state.get("implementation_job_id"),
        "reviewer_worker": state.get("reviewer_worker"),
        "max_rounds": state.get("max_rounds"),
        "round": state.get("round"),
        "state": state.get("state"),
        "decision": state.get("decision"),
        "active_job_id": state.get("active_job_id"),
        "review_jobs": list(state.get("review_jobs") or []),
        "fix_jobs": list(state.get("fix_jobs") or []),
        "cancel_requested": state.get("cancel_requested", False),
        "error": state.get("error"),
    }
