"""Unified observability primitives for TEAMYRA.

The module is intentionally filesystem-backed and provider-agnostic. It reads
TEAMYRA's persisted runtime artifacts and returns bounded JSON-safe summaries for
MCP, CLI, and desktop callers.
"""
from __future__ import annotations

import json
import os
import time
from collections import deque
from pathlib import Path


MAX_TIMELINE_LIMIT = 500
MAX_TIMELINE_JOBS = 400
MAX_EVENTS_PER_JOB = 500
MAX_SEARCH_RESULTS = 200
MAX_SEARCH_FILES = 800
MAX_TEXT = 1200


def _read_json(path):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8", errors="replace"))
    except Exception:
        return None


def _clip(value, limit=MAX_TEXT):
    text = str(value or "").strip()
    if len(text) <= limit:
        return text
    return text[: max(0, limit - 14)] + " …[clipped]"


def _norm_path(value):
    if not value:
        return None
    try:
        return str(Path(value).resolve()).lower()
    except Exception:
        return str(value).lower()


def _project_matches(item_path, project_path):
    if not project_path:
        return True
    left = _norm_path(item_path)
    right = _norm_path(project_path)
    if not left or not right:
        return False
    return left == right or left.startswith(right + os.sep) or right.startswith(left + os.sep)


def _query_matches(item, query):
    if not query:
        return True
    needle = str(query).strip().lower()
    if not needle:
        return True
    hay = " ".join(
        str(item.get(key) or "")
        for key in ("type", "kind", "label", "worker", "state", "message", "path", "branch")
    ).lower()
    return needle in hay


def _job_timeline(root):
    jobs = Path(root) / "jobs"
    rows = []
    if not jobs.exists():
        return rows

    folders = [folder for folder in jobs.iterdir() if folder.is_dir()]
    folders.sort(key=lambda folder: folder.stat().st_mtime, reverse=True)

    for folder in folders[:MAX_TIMELINE_JOBS]:
        meta = _read_json(folder / "meta.json")
        if not isinstance(meta, dict):
            continue
        job_id = meta.get("id") or folder.name
        cwd = meta.get("cwd")
        base = {
            "source": "job",
            "source_id": job_id,
            "job_id": job_id,
            "label": meta.get("label") or job_id,
            "worker": meta.get("worker"),
            "provider": meta.get("provider"),
            "state": meta.get("state"),
            "project_path": cwd,
            "branch": meta.get("branch"),
            "parent": meta.get("parent"),
        }
        created = meta.get("created")
        if isinstance(created, (int, float)):
            rows.append({
                **base,
                "ts": float(created),
                "kind": "job.created",
                "message": f"Job created for {meta.get('worker') or 'worker'}",
            })
        started = meta.get("started")
        if isinstance(started, (int, float)):
            rows.append({
                **base,
                "ts": float(started),
                "kind": "job.started",
                "message": f"Job started on {meta.get('worker') or 'worker'}",
            })

        events_path = folder / "events.jsonl"
        if events_path.exists():
            try:
                with events_path.open("r", encoding="utf-8", errors="replace") as handle:
                    recent_lines = deque(handle, maxlen=MAX_EVENTS_PER_JOB)
                for line in recent_lines:
                    try:
                        event = json.loads(line)
                    except Exception:
                        continue
                    ts = event.get("ts")
                    if not isinstance(ts, (int, float)):
                        continue
                    kind = str(event.get("kind") or "event")
                    rows.append({
                        **base,
                        "ts": float(ts),
                        "kind": "job." + kind,
                        "message": _clip(event.get("text"), 900),
                    })
            except OSError:
                pass

        ended = meta.get("ended")
        if isinstance(ended, (int, float)):
            reason = meta.get("reason")
            message = f"Job {meta.get('state') or 'finished'}"
            if reason:
                message += f" ({reason})"
            rows.append({
                **base,
                "ts": float(ended),
                "kind": "job.ended",
                "message": message,
            })
    return rows


def _graph_timeline(root):
    tasks = Path(root) / "tasks"
    rows = []
    if not tasks.exists():
        return rows
    for path in tasks.glob("graph-*.json"):
        graph = _read_json(path)
        if not isinstance(graph, dict):
            continue
        graph_id = graph.get("id") or path.stem
        project_path = graph.get("project_path")
        base = {
            "source": "graph",
            "source_id": graph_id,
            "graph_id": graph_id,
            "label": graph.get("title") or graph_id,
            "state": graph.get("state"),
            "project_path": project_path,
        }
        created = graph.get("created_at")
        if isinstance(created, (int, float)):
            rows.append({
                **base,
                "ts": float(created),
                "kind": "graph.created",
                "message": _clip(graph.get("objective") or "Task graph created", 900),
            })
        updated = graph.get("updated_at")
        if isinstance(updated, (int, float)) and updated != created:
            rows.append({
                **base,
                "ts": float(updated),
                "kind": "graph.updated",
                "message": f"Graph state: {graph.get('state') or 'unknown'}",
            })

        for node in graph.get("nodes") or []:
            node_id = node.get("id")
            node_base = {
                **base,
                "node_id": node_id,
                "label": node.get("label") or node_id or base["label"],
                "worker": node.get("worker"),
                "state": node.get("status"),
            }
            started = node.get("started_at")
            if isinstance(started, (int, float)):
                rows.append({
                    **node_base,
                    "ts": float(started),
                    "kind": "graph.node.started",
                    "message": f"Node {node_id} started",
                })
            approved = node.get("approved_at")
            if isinstance(approved, (int, float)):
                rows.append({
                    **node_base,
                    "ts": float(approved),
                    "kind": "graph.node.approved",
                    "message": _clip(node.get("approval_note") or f"Node {node_id} approved", 900),
                })
            ended = node.get("ended_at")
            if isinstance(ended, (int, float)):
                message = f"Node {node_id} {node.get('status') or 'finished'}"
                if node.get("error"):
                    message += ": " + _clip(node.get("error"), 700)
                rows.append({
                    **node_base,
                    "ts": float(ended),
                    "kind": "graph.node.ended",
                    "message": message,
                })
    return rows


def _review_timeline(root):
    directory = Path(root) / "tasks" / "reviews"
    rows = []
    if not directory.exists():
        return rows
    for path in directory.glob("review-*.json"):
        state = _read_json(path)
        if not isinstance(state, dict):
            continue
        review_id = state.get("id") or path.stem
        base = {
            "source": "review",
            "source_id": review_id,
            "review_id": review_id,
            "label": f"Review {review_id}",
            "state": state.get("state"),
            "source_job_id": state.get("source_job_id"),
            "worker": state.get("reviewer_worker"),
        }
        created = state.get("created_at")
        if isinstance(created, (int, float)):
            rows.append({
                **base,
                "ts": float(created),
                "kind": "review.created",
                "message": f"Review cycle created for {state.get('source_job_id')}",
            })
        updated = state.get("updated_at")
        if isinstance(updated, (int, float)) and updated != created:
            decision = state.get("decision")
            message = f"Review state: {state.get('state') or 'unknown'}"
            if decision:
                message += f" · {decision}"
            if state.get("error"):
                message += ": " + _clip(state.get("error"), 700)
            rows.append({
                **base,
                "ts": float(updated),
                "kind": "review.updated",
                "message": message,
            })
    return rows


def _handoff_timeline(root):
    directory = Path(root) / "tasks" / "handoffs"
    rows = []
    if not directory.exists():
        return rows
    for path in directory.glob("handoff-*.json"):
        record = _read_json(path)
        if not isinstance(record, dict):
            continue
        handoff_id = record.get("id") or path.stem
        target_job_id = record.get("target_job_id")
        base = {
            "source": "handoff",
            "source_id": handoff_id,
            "handoff_id": handoff_id,
            "source_job_id": record.get("source_job_id"),
            "job_id": target_job_id,
            "label": record.get("label") or handoff_id,
            "worker": record.get("target_worker"),
            "project_path": record.get("project_path"),
            "state": "dispatched" if target_job_id else "created",
        }
        created = record.get("created_at")
        if isinstance(created, (int, float)):
            rows.append({
                **base,
                "ts": float(created),
                "kind": "handoff.created",
                "message": _clip(record.get("objective") or record.get("message") or "Structured handoff created", 900),
            })
        updated = record.get("updated_at")
        if target_job_id and isinstance(updated, (int, float)) and updated != created:
            rows.append({
                **base,
                "ts": float(updated),
                "kind": "handoff.target.attached",
                "message": f"Dispatched to {record.get('target_worker') or 'worker'} as {target_job_id}",
            })
    return rows


def _worktree_timeline(root):
    directory = Path(root) / "worktrees" / ".teamyra"
    rows = []
    if not directory.exists():
        return rows
    for path in directory.glob("wt-*.json"):
        meta = _read_json(path)
        if not isinstance(meta, dict):
            continue
        worktree_id = meta.get("id") or path.stem
        base = {
            "source": "worktree",
            "source_id": worktree_id,
            "worktree_id": worktree_id,
            "label": meta.get("label") or worktree_id,
            "project_path": meta.get("repo_root"),
            "path": meta.get("path"),
            "branch": meta.get("branch"),
            "state": "merged" if meta.get("merged_at") else "active",
        }
        created = meta.get("created_at")
        if isinstance(created, (int, float)):
            rows.append({
                **base,
                "ts": float(created),
                "kind": "worktree.created",
                "message": f"Worktree created on {meta.get('branch') or 'branch'}",
            })
        rebased = meta.get("rebased_at")
        if isinstance(rebased, (int, float)):
            rows.append({
                **base,
                "ts": float(rebased),
                "kind": "worktree.rebased",
                "message": f"Worktree rebased onto {meta.get('target_branch') or 'target'}",
            })
        merged = meta.get("merged_at")
        if isinstance(merged, (int, float)):
            rows.append({
                **base,
                "ts": float(merged),
                "kind": "worktree.merged",
                "message": f"Worktree merged into {meta.get('target_branch') or 'target'}",
            })
    return rows



def _media_timeline(root):
    directory = Path(root) / "media" / "jobs"
    rows = []
    if not directory.exists():
        return rows
    for path in directory.glob("media-*.json"):
        job = _read_json(path)
        if not isinstance(job, dict):
            continue
        job_id = job.get("job_id") or path.stem
        request = job.get("request") or {}
        base = {
            "source": "media",
            "source_id": job_id,
            "media_job_id": job_id,
            "label": f"{request.get('type') or 'media'} · {job_id}",
            "state": job.get("state"),
            "project_path": request.get("project_path"),
            "provider": job.get("provider_surface"),
            "asset_id": job.get("asset_id"),
        }
        history = job.get("history") or []
        for event in history[-MAX_EVENTS_PER_JOB:]:
            ts = event.get("ts")
            if not isinstance(ts, (int, float)):
                continue
            state = str(event.get("state") or job.get("state") or "unknown")
            rows.append({
                **base,
                "ts": float(ts),
                "kind": "media." + state,
                "message": _clip(event.get("detail") or state, 900),
                "state": state,
            })
    return rows

def timeline(root, limit=100, project_path=None, worker=None, sources=None, query=None, since=None):
    limit = max(1, min(int(limit or 100), MAX_TIMELINE_LIMIT))
    source_filter = {str(item) for item in (sources or []) if str(item).strip()}
    rows = []
    rows.extend(_job_timeline(root))
    rows.extend(_graph_timeline(root))
    rows.extend(_review_timeline(root))
    rows.extend(_handoff_timeline(root))
    rows.extend(_worktree_timeline(root))
    rows.extend(_media_timeline(root))

    filtered = []
    for item in rows:
        if source_filter and item.get("source") not in source_filter:
            continue
        if worker and item.get("worker") != worker:
            continue
        if since is not None:
            try:
                if float(item.get("ts") or 0) < float(since):
                    continue
            except Exception:
                pass
        if project_path and not _project_matches(item.get("project_path"), project_path):
            continue
        if not _query_matches(item, query):
            continue
        filtered.append(item)

    filtered.sort(key=lambda item: (float(item.get("ts") or 0), str(item.get("source_id") or "")), reverse=True)
    return {
        "items": filtered[:limit],
        "count": min(len(filtered), limit),
        "total_matches": len(filtered),
        "clipped": len(filtered) > limit,
        "generated_at": time.time(),
    }


def _iter_log_files(root):
    jobs = Path(root) / "jobs"
    if not jobs.exists():
        return
    folders = [folder for folder in jobs.iterdir() if folder.is_dir()]
    folders.sort(key=lambda folder: folder.stat().st_mtime, reverse=True)
    for folder in folders[:MAX_SEARCH_FILES]:
        meta = _read_json(folder / "meta.json") or {}
        for name in ("events.jsonl", "transcript.md", "stderr.txt", "runner.log", "task.txt"):
            path = folder / name
            if path.exists() and path.is_file():
                yield folder.name, meta, name, path


def search_logs(root, query, limit=50, project_path=None, worker=None, kinds=None):
    needle = str(query or "").strip().lower()
    if not needle:
        raise ValueError("query is required")
    limit = max(1, min(int(limit or 50), MAX_SEARCH_RESULTS))
    kind_filter = {str(item) for item in (kinds or []) if str(item).strip()}
    results = []

    for job_id, meta, file_kind, path in _iter_log_files(root):
        if worker and meta.get("worker") != worker:
            continue
        if project_path and not _project_matches(meta.get("cwd"), project_path):
            continue
        if kind_filter and file_kind not in kind_filter:
            continue
        try:
            with path.open("r", encoding="utf-8", errors="replace") as handle:
                for line_no, line in enumerate(handle, 1):
                    if needle not in line.lower():
                        continue
                    text = line.rstrip("\r\n")
                    if file_kind == "events.jsonl":
                        try:
                            event = json.loads(text)
                            text = str(event.get("text") or text)
                        except Exception:
                            pass
                    results.append({
                        "job_id": job_id,
                        "worker": meta.get("worker"),
                        "label": meta.get("label"),
                        "project_path": meta.get("cwd"),
                        "file": file_kind,
                        "line": line_no,
                        "text": _clip(text, 1000),
                        "updated": meta.get("updated") or meta.get("ended") or meta.get("created"),
                    })
                    if len(results) >= limit:
                        return {
                            "query": query,
                            "results": results,
                            "count": len(results),
                            "clipped": True,
                        }
        except OSError:
            continue

    return {
        "query": query,
        "results": results,
        "count": len(results),
        "clipped": False,
    }


TOKEN_KEYS = (
    "input_tokens",
    "cached_input_tokens",
    "cache_write_input_tokens",
    "cache_read_tokens",
    "output_tokens",
    "reasoning_output_tokens",
    "thinking_tokens",
    "total_tokens",
)


def _usage_numbers(value):
    usage = value if isinstance(value, dict) else {}
    out = {}
    for key in TOKEN_KEYS:
        raw = usage.get(key)
        if isinstance(raw, (int, float)):
            out[key] = int(raw)
    return out


def _provider_name(explicit, worker):
    value = str(explicit or "").strip().lower()
    if value and value != "unknown":
        return value
    worker_id = str(worker or "").strip().lower()
    if worker_id.startswith("codex"):
        return "codex"
    if worker_id.startswith("claude"):
        return "claude"
    if worker_id.startswith("antigravity") or worker_id.startswith("agy"):
        return "antigravity"
    return "unknown"


def usage_snapshot(root, worker_rows=None, project_path=None):
    jobs = Path(root) / "jobs"
    by_worker = {}
    by_provider = {}
    total_jobs = 0

    if jobs.exists():
        for folder in jobs.iterdir():
            if not folder.is_dir():
                continue
            meta = _read_json(folder / "meta.json")
            if not isinstance(meta, dict):
                continue
            if project_path and not _project_matches(meta.get("cwd"), project_path):
                continue

            worker = str(meta.get("worker") or "unknown")
            provider = _provider_name(meta.get("provider"), worker)
            row = by_worker.setdefault(worker, {
                "worker": worker,
                "provider": provider,
                "jobs": 0,
                "running": 0,
                "done": 0,
                "failed": 0,
                "cancelled": 0,
                "tokens": {},
                "latest_job_id": None,
                "latest_created": 0,
                "latest_usage": {},
            })
            row["jobs"] += 1
            total_jobs += 1
            state = str(meta.get("state") or "")
            if state in row:
                row[state] += 1
            elif state in {"starting"}:
                row["running"] += 1

            usage = _usage_numbers(meta.get("usage"))
            for key, value in usage.items():
                row["tokens"][key] = row["tokens"].get(key, 0) + value
            created = float(meta.get("created") or 0)
            if created >= row["latest_created"]:
                row["latest_created"] = created
                row["latest_job_id"] = meta.get("id") or folder.name
                row["latest_usage"] = usage

            provider_row = by_provider.setdefault(provider, {
                "provider": provider,
                "jobs": 0,
                "tokens": {},
            })
            provider_row["jobs"] += 1
            for key, value in usage.items():
                provider_row["tokens"][key] = provider_row["tokens"].get(key, 0) + value

    live = {str(row.get("worker")): row for row in (worker_rows or []) if row.get("worker")}
    for worker, row in by_worker.items():
        status = live.get(worker) or {}
        row["ready"] = status.get("ready")
        row["cooldown_seconds"] = int(status.get("cooldown_seconds") or 0)
        row["model"] = status.get("model")
        row["effort"] = status.get("effort")
        row["running_jobs"] = list(status.get("running_jobs") or [])
        if not row.get("provider") or row.get("provider") == "unknown":
            row["provider"] = status.get("provider") or row.get("provider")
        tokens = row["tokens"]
        input_tokens = tokens.get("input_tokens", 0)
        cached = tokens.get("cached_input_tokens", 0) + tokens.get("cache_read_tokens", 0)
        # Provider counters do not all share identical semantics. Only render a
        # percentage when cached tokens are a valid subset of input tokens.
        row["cache_ratio"] = (
            round(cached / input_tokens, 4)
            if input_tokens and 0 <= cached <= input_tokens
            else None
        )

    for worker, status in live.items():
        if worker in by_worker:
            continue
        by_worker[worker] = {
            "worker": worker,
            "provider": status.get("provider"),
            "jobs": 0,
            "running": len(status.get("running_jobs") or []),
            "done": 0,
            "failed": 0,
            "cancelled": 0,
            "tokens": {},
            "latest_job_id": None,
            "latest_created": 0,
            "latest_usage": {},
            "ready": status.get("ready"),
            "cooldown_seconds": int(status.get("cooldown_seconds") or 0),
            "model": status.get("model"),
            "effort": status.get("effort"),
            "running_jobs": list(status.get("running_jobs") or []),
            "cache_ratio": None,
        }

    workers = sorted(
        by_worker.values(),
        key=lambda row: (row.get("provider") or "", row.get("worker") or ""),
    )
    providers = sorted(by_provider.values(), key=lambda row: row["provider"])
    return {
        "generated_at": time.time(),
        "project_path": str(project_path) if project_path else None,
        "jobs": total_jobs,
        "workers": workers,
        "providers": providers,
        "note": "Quota visibility uses real readiness/cooldown telemetry. Exact provider quota percentages are not fabricated when unavailable.",
    }
