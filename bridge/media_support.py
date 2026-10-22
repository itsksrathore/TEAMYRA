"""TEAMYRA media help desk: an issue log for maintenance and helper tickets.

Agents that hit media generation/download problems report them here instead of
retrying. Every report (and every media job failure) is logged for the
maintenance team. A reported or delegated job gets a helper ticket: a TEAMYRA
helper agent takes the work over, finishes it by hand with the media tools and
delivers the result into the reporter's own job ids, so the reporter only waits
on the same job (or the ticket) and never duplicates the work.
"""
from __future__ import annotations

import time
import uuid
from pathlib import Path

import media_engine

# Helpers are tried in this order; Claude workers only when none of these can run.
HELPER_ORDER = ("codex1", "codex2", "antigravity")
TICKET_KINDS = {"issue", "delegate"}
TICKET_STATES = {"open", "assigned", "working", "delivered", "partially_delivered", "failed", "cancelled"}
FINAL_TICKET_STATES = {"delivered", "partially_delivered", "failed", "cancelled"}
ISSUE_STATES = {"open", "acknowledged", "fixed", "wont_fix"}
MAX_TEXT = 12000
MAX_NOTES = 200


def _support_dir(root, name):
    path = Path(root).resolve() / "media" / "support" / name
    path.mkdir(parents=True, exist_ok=True)
    return path


def _new_id(prefix):
    return prefix + "-" + time.strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:6]


def _clip(value, limit=MAX_TEXT):
    return str(value or "").strip()[:limit]


def _ticket_path(root, ticket_id):
    ticket_id = str(ticket_id or "").strip()
    if not ticket_id.startswith("HLP-") or "/" in ticket_id or "\\" in ticket_id or len(ticket_id) > 80:
        raise ValueError("invalid helper ticket id")
    return _support_dir(root, "tickets") / f"{ticket_id}.json"


def _issue_path(root, issue_id):
    issue_id = str(issue_id or "").strip()
    if not issue_id.startswith(("ISS-", "AUTO-")) or "/" in issue_id or "\\" in issue_id or len(issue_id) > 160:
        raise ValueError("invalid issue id")
    return _support_dir(root, "issues") / f"{issue_id}.json"


def _reporter(value):
    if isinstance(value, dict):
        return {key: _clip(value.get(key), 300) for key in ("name", "session", "worker", "contact") if value.get(key)}
    text = _clip(value, 300)
    return {"name": text} if text else {"name": "unknown agent"}


def job_snapshot(root, job_id):
    """What a helper or maintainer needs to know about one media job."""
    job = media_engine.load_job(root, job_id)
    request = job.get("request") or {}
    submission = job.get("provider_submission") or {}
    return {
        "job_id": job["job_id"],
        "batch_id": job.get("batch_id"),
        "state": job.get("state"),
        "type": request.get("type"),
        "prompt": _clip(request.get("prompt"), 6000),
        "project_path": request.get("project_path"),
        "settings": {key: request.get(key) for key in ("aspect_ratio", "duration", "format", "output_count",
                                                        "model_preference") if request.get(key) is not None},
        "generation_settings": dict(request.get("generation_settings") or {}),
        "references": list(request.get("references") or []),
        "error": job.get("error"),
        "failure": dict(job.get("failure") or {}),
        "recovery_plan": media_engine.recovery_plan(job),
        "provider": {key: submission.get(key) for key in ("provider_url", "result_key", "submitted_at") if submission.get(key)},
        "asset_id": job.get("asset_id"),
        "history": [{"state": item.get("state"), "detail": _clip(item.get("detail"), 300)}
                    for item in list(job.get("history") or [])[-8:]],
    }


# --- issue log -------------------------------------------------------------------------------

AREAS = {"media", "worker", "chatgpt", "mcp", "desktop", "scheduler", "git", "other"}


def log_issue(root, *, source, summary, category=None, job_ids=(), batch_id=None, project_path=None,
              reporter=None, details=None, ticket_id=None, issue_id=None, area="media", severity=None, refs=None):
    now = time.time()
    area = str(area or "media").strip().lower()
    if area not in AREAS:
        area = "other"
    issue = {
        "issue_id": issue_id or _new_id("ISS"),
        "area": area,
        "severity": severity if severity in {"low", "medium", "high", "blocker"} else None,
        "refs": [_clip(item, 300) for item in (refs or [])][:20],
        "source": source,
        "created_at": now,
        "updated_at": now,
        "category": _clip(category, 80) or "unspecified",
        "summary": _clip(summary, 2000),
        "details": _clip(details),
        "reporter": _reporter(reporter) if reporter else None,
        "job_ids": [str(item) for item in job_ids][:50],
        "batch_id": batch_id,
        "project_path": project_path,
        "ticket_id": ticket_id,
        "occurrences": 1,
        "maintenance": {"status": "open", "notes": []},
    }
    media_engine._atomic_write(_issue_path(root, issue["issue_id"]), issue)
    return issue


def log_job_failure(root, job):
    """Automatic maintenance record for a failed media job (one per job and category)."""
    try:
        category = (job.get("failure") or {}).get("category") or media_engine.recovery_plan(job)["category"]
        issue_id = f"AUTO-{job['job_id']}-{category}"[:150]
        path = _issue_path(root, issue_id)
        if path.exists():
            existing = media_engine._read_json(path, None)
            if isinstance(existing, dict):
                existing["occurrences"] = int(existing.get("occurrences") or 1) + 1
                existing["updated_at"] = time.time()
                existing["details"] = _clip(job.get("error"))
                media_engine._atomic_write(path, existing)
            return
        request = job.get("request") or {}
        log_issue(root, source="automatic", category=category, issue_id=issue_id,
                  summary=f"{request.get('type')} job failed: {_clip(job.get('error'), 300)}",
                  details=_clip(job.get("error")), job_ids=[job["job_id"]], batch_id=job.get("batch_id"),
                  project_path=request.get("project_path"), ticket_id=job.get("assisted_by"))
    except Exception:
        # Logging must never break job state updates.
        pass


def list_issues(root, status=None, category=None, source=None, limit=50, area=None):
    rows = []
    for path in _support_dir(root, "issues").glob("*.json"):
        issue = media_engine._read_json(path, None)
        if not isinstance(issue, dict):
            continue
        if area and issue.get("area", "media") != area:
            continue
        if status and issue.get("maintenance", {}).get("status") != status:
            continue
        if category and issue.get("category") != category:
            continue
        if source and issue.get("source") != source:
            continue
        rows.append(issue)
    rows.sort(key=lambda item: float(item.get("updated_at") or 0), reverse=True)
    by_category = {}
    for issue in rows:
        bucket = by_category.setdefault(issue.get("category") or "unspecified", {"count": 0, "occurrences": 0, "open": 0})
        bucket["count"] += 1
        bucket["occurrences"] += int(issue.get("occurrences") or 1)
        bucket["open"] += int(issue.get("maintenance", {}).get("status") == "open")
    limit = max(1, min(int(limit or 50), 500))
    return {"total": len(rows), "by_category": by_category, "issues": rows[:limit]}


def update_issue(root, issue_id, *, status=None, note=None, by=None):
    path = _issue_path(root, issue_id)
    issue = media_engine._read_json(path, None)
    if not isinstance(issue, dict):
        raise ValueError(f"no such issue: {issue_id}")
    maintenance = issue.setdefault("maintenance", {"status": "open", "notes": []})
    if status:
        if status not in ISSUE_STATES:
            raise ValueError("issue status must be open, acknowledged, fixed or wont_fix")
        maintenance["status"] = status
    if note:
        maintenance.setdefault("notes", []).append({"at": time.time(), "by": _clip(by, 120) or "maintenance",
                                                   "text": _clip(note, 4000)})
    issue["updated_at"] = time.time()
    media_engine._atomic_write(path, issue)
    return issue


# --- helper tickets -------------------------------------------------------------------------

def _load_ticket(root, ticket_id):
    ticket = media_engine._read_json(_ticket_path(root, ticket_id), None)
    if not isinstance(ticket, dict):
        raise ValueError(f"no such helper ticket: {ticket_id}")
    return ticket


def _save_ticket(root, ticket):
    ticket["updated_at"] = time.time()
    ticket["notes"] = list(ticket.get("notes") or [])[-MAX_NOTES:]
    media_engine._atomic_write(_ticket_path(root, ticket["ticket_id"]), ticket)
    return ticket


def create_ticket(root, *, kind, reporter, description, project_path=None, job_ids=(), batch_id=None,
                  requests=None, instructions=None):
    if kind not in TICKET_KINDS:
        raise ValueError("ticket kind must be issue or delegate")
    description = _clip(description)
    if not description:
        raise ValueError("description is required")
    job_ids = [str(item).strip() for item in (job_ids or []) if str(item).strip()]
    if batch_id:
        job_ids += [item["job_id"] for item in media_engine.batch_status(root, batch_id)["jobs"]
                    if item["status"] != "completed" and item["job_id"] not in job_ids]
    snapshots = [job_snapshot(root, job_id) for job_id in job_ids[:50]]
    if not project_path and snapshots:
        project_path = snapshots[0]["project_path"]
    if not project_path:
        raise ValueError("project_path is required when no job ids are given")
    project = media_engine._validate_project(root, project_path)
    requests = list(requests or [])
    if len(requests) > media_engine.MAX_BATCH:
        raise ValueError(f"a delegated task takes at most {media_engine.MAX_BATCH} media requests")
    for index, item in enumerate(requests):
        if not isinstance(item, dict) or not str(item.get("prompt") or "").strip() or not item.get("type"):
            raise ValueError(f"requests[{index}] needs at least type and prompt")
    if kind == "issue" and not snapshots:
        raise ValueError("an issue report needs the affected job_ids or batch_id")
    if kind == "delegate" and not requests and not _clip(instructions):
        raise ValueError("a delegated task needs requests or instructions")
    now = time.time()
    ticket = {
        "ticket_id": _new_id("HLP"),
        "kind": kind,
        "status": "open",
        "created_at": now,
        "updated_at": now,
        "reporter": _reporter(reporter),
        "description": description,
        "instructions": _clip(instructions),
        "project_path": str(project),
        "batch_id": batch_id,
        "job_ids": [item["job_id"] for item in snapshots],
        "jobs_at_report": snapshots,
        "requests": requests,
        "issue_id": None,
        "helper": {"worker": None, "job_id": None, "attempts": []},
        "deliveries": [],
        "notes": [],
        "summary": None,
    }
    issue = log_issue(root, source="agent_report" if kind == "issue" else "delegation",
                      category=(snapshots[0]["failure"].get("category") if snapshots else None) or kind,
                      summary=description, details=_clip(instructions), job_ids=ticket["job_ids"],
                      batch_id=batch_id, project_path=str(project), reporter=reporter,
                      ticket_id=ticket["ticket_id"])
    ticket["issue_id"] = issue["issue_id"]
    _save_ticket(root, ticket)
    ticket["assisted_jobs"] = media_engine.assign_helper(root, ticket["job_ids"], ticket["ticket_id"])
    return _save_ticket(root, ticket)


def record_dispatch(root, ticket_id, *, worker=None, job_id=None, error=None):
    ticket = _load_ticket(root, ticket_id)
    attempt = {"at": time.time(), "worker": worker, "job_id": job_id}
    if error:
        attempt["error"] = _clip(error, 800)
    ticket["helper"]["attempts"].append(attempt)
    if job_id:
        ticket["helper"].update(worker=worker, job_id=job_id)
        ticket["status"] = "assigned"
    else:
        ticket.setdefault("notes", []).append({"at": time.time(), "by": "teamyra",
                                               "text": "No helper agent could start: " + _clip(error, 600)})
    return _save_ticket(root, ticket)


def update_ticket(root, ticket_id, *, status=None, note=None, by=None, summary=None):
    ticket = _load_ticket(root, ticket_id)
    if status:
        if status not in TICKET_STATES:
            raise ValueError("invalid ticket status")
        ticket["status"] = status
    if note:
        ticket.setdefault("notes", []).append({"at": time.time(), "by": _clip(by, 120) or "helper", "text": _clip(note, 4000)})
    if summary:
        ticket["summary"] = _clip(summary, 6000)
    if status in FINAL_TICKET_STATES:
        # Jobs the helper did not deliver become ordinary failures again, so
        # their reporter is never left waiting on a closed ticket.
        delivered = {item.get("original_job_id") for item in ticket.get("deliveries") or []}
        media_engine.release_helper(root, [job for job in ticket["job_ids"] if job not in delivered], ticket_id,
                                    "TEAMYRA helper ticket " + status + ": " + _clip(summary or note, 400))
    return _save_ticket(root, ticket)


def deliver(root, ticket_id, asset_id, *, original_job_id=None, item=None, note=None, by=None):
    ticket = _load_ticket(root, ticket_id)
    asset = media_engine.get_asset(root, asset_id)
    if str(asset.get("project_path") or "").lower() != str(ticket["project_path"]).lower():
        raise ValueError("delivered asset must belong to the ticket's project folder")
    if original_job_id:
        if original_job_id not in ticket["job_ids"]:
            raise ValueError("original_job_id is not part of this ticket")
        media_engine.fulfill_job(root, original_job_id, asset["asset_id"], ticket_id)
    delivery = {"at": time.time(), "asset_id": asset["asset_id"], "local_path": asset.get("local_path"),
                "type": asset.get("type"), "original_job_id": original_job_id, "item": item,
                "note": _clip(note, 2000), "by": _clip(by, 120) or "helper"}
    ticket["deliveries"] = [entry for entry in ticket.get("deliveries") or []
                            if not (original_job_id and entry.get("original_job_id") == original_job_id)] + [delivery]
    delivered_jobs = {entry.get("original_job_id") for entry in ticket["deliveries"] if entry.get("original_job_id")}
    if ticket["kind"] == "issue" and ticket["job_ids"] and set(ticket["job_ids"]) <= delivered_jobs:
        ticket["status"] = "delivered"
    elif ticket["status"] in {"open", "assigned"}:
        ticket["status"] = "working"
    return _save_ticket(root, ticket)


def ticket_status(root, ticket_id, helper_state=None):
    ticket = _load_ticket(root, ticket_id)
    jobs = []
    for job_id in ticket["job_ids"]:
        try:
            job = media_engine.load_job(root, job_id)
            jobs.append({"job_id": job_id, "state": job.get("state"), "asset_id": job.get("asset_id"),
                         "fulfilled_by": job.get("fulfilled_by")})
        except ValueError:
            jobs.append({"job_id": job_id, "state": "missing"})
    result = {key: ticket.get(key) for key in (
        "ticket_id", "kind", "status", "reporter", "description", "project_path", "batch_id", "issue_id",
        "helper", "deliveries", "summary", "created_at", "updated_at")}
    result["jobs"] = jobs
    result["requests"] = len(ticket.get("requests") or [])
    result["notes"] = list(ticket.get("notes") or [])[-10:]
    if helper_state:
        result["helper_job"] = helper_state
        # After failover the active helper differs from the first dispatch.
        result["helper"] = {**(ticket.get("helper") or {}), "worker": helper_state.get("worker"),
                            "job_id": helper_state.get("job_id")}
    if ticket["status"] in FINAL_TICKET_STATES:
        result["next"] = "Ticket is " + ticket["status"] + ". Use the delivered asset ids/paths."
    else:
        result["next"] = ("A TEAMYRA helper agent is handling this. Do not retry or resubmit these items; poll this "
                          "ticket or your original job ids. Deliveries appear here and in the jobs themselves.")
    return result


HELPER_TERMINAL = {"done", "failed", "cancelled", "timed_out"}
STALE_TICKET_S = 12 * 3600
UNDISPATCHED_TICKET_S = 30 * 60


def sweep_tickets(root, helper_state):
    """Close tickets whose helper ended without finishing, so no reporter's job
    stays 'assisted' forever. helper_state(ticket) -> terminal-job view or None."""
    closed = []
    for path in _support_dir(root, "tickets").glob("HLP-*.json"):
        ticket = media_engine._read_json(path, None)
        if not isinstance(ticket, dict) or ticket.get("status") in FINAL_TICKET_STATES:
            continue
        age = time.time() - float(ticket.get("created_at") or 0)
        state = helper_state(ticket) if (ticket.get("helper") or {}).get("job_id") else None
        reason = None
        if state and state.get("state") in HELPER_TERMINAL:
            reason = (f"helper {state.get('worker')} ended ({state.get('state')}"
                      + (f": {state.get('reason')}" if state.get("reason") else "") + ") without closing the ticket")
        elif not state and age > UNDISPATCHED_TICKET_S:
            reason = "no helper agent could be started"
        elif age > STALE_TICKET_S:
            reason = "ticket open for more than 12 hours"
        if not reason:
            continue
        status = "partially_delivered" if ticket.get("deliveries") else "failed"
        update_ticket(root, ticket["ticket_id"], status=status, note="Closed by TEAMYRA: " + reason, by="teamyra",
                      summary=ticket.get("summary") or ("Closed: " + reason))
        log_issue(root, source="automatic", category="helper_incomplete", area="media",
                  summary=f"Helper ticket {ticket['ticket_id']} closed: {reason}",
                  job_ids=ticket.get("job_ids") or [], ticket_id=ticket["ticket_id"],
                  issue_id=f"AUTO-{ticket['ticket_id']}-helper_incomplete")
        closed.append({"ticket_id": ticket["ticket_id"], "status": status, "reason": reason})
    return closed


def cli_command():
    """Shell fallback for helpers whose CLI has no TEAMYRA MCP connection."""
    bridge = Path(__file__).resolve().parent
    return f'python "{bridge / "teamyra_cli.py"}" tool'


def helper_task(ticket, worker=None):
    """Instructions for the helper agent working one ticket."""
    import json
    tid = ticket["ticket_id"]
    payload = {key: ticket.get(key) for key in ("ticket_id", "kind", "reporter", "description", "instructions",
                                                "project_path", "batch_id", "job_ids", "requests")}
    payload["jobs_at_report"] = ticket.get("jobs_at_report") or []
    cli = cli_command()
    lines = [
        f"You are a TEAMYRA media helper agent working helper ticket {tid}.",
        "Another AI agent reported a Google media (Flow image/video/sound) problem or handed over a generation task. "
        "Your job: take it over, finish the work by hand with TEAMYRA's media tools, and deliver the results so that "
        "agent does not lose more time. Work carefully and follow the reporter's instructions exactly.",
        "",
        "TOOLS. Use the TEAMYRA MCP tools (names may appear as teamyra.<name> or <name>): media_status, "
        "media_generate, media_batch, media_recover, media_resume_download, media_cancel, media_assets, "
        "media_capabilities, media_ticket_status, media_ticket_update, media_ticket_deliver. If you have no TEAMYRA "
        "MCP tools, call the same tools from the shell: write the arguments to a JSON file and run "
        f"`{cli} <tool_name> --file args.json` (or `--json '<json>'`). Never edit TEAMYRA source code, never import "
        "TEAMYRA modules or call desktop_control/media.diagnose yourself, and never stop or restart TEAMYRA/electron "
        "processes: other agents' jobs run on the same browser page.",
        "",
        "WORKFLOW",
        f"1. Note the issue first: media_ticket_update(ticket_id=\"{tid}\", status=\"working\", note=<what you see "
        "and your plan>).",
        "2. Diagnose with media_status for every job id (error, recovery_plan, history). Never create a job for an item "
        "that is already completed.",
        "3. Do the work:",
        "   - Download/selector/browser/result-matching failures with a known submission: media_recover or "
        f"media_resume_download with ticket_id=\"{tid}\" (you own these jobs; this re-downloads the existing result, "
        "no new credits).",
        "   - 'policy_refusal' (Flow said the prompt might violate its policies) or 'provider_no_result': reword the "
        "prompt minimally (keep subject, style, framing, any spoken dialogue word for word; soften violent/graphic or "
        "sensitive descriptors) and queue a new media_generate with the same project_path, type, aspect_ratio, "
        "duration, download_quality and references.",
        "   - Reference picker/selector failures before Generate: media_recover the job; if it fails again, queue a "
        "new job with the same request.",
        "   - Delegated tasks: queue all requests together with media_batch (same project_path), then handle each "
        "failure as above.",
        "   At most 2 new generations per item unless the instructions allow more.",
        "4. Wait: poll media_status every 20-30 seconds until each job completes or fails.",
        "5. Verify each result: the asset's local_path exists and matches the request (type, aspect ratio, duration; "
        "for dialogue clips, audio present).",
        f"6. Deliver each result immediately: media_ticket_deliver(ticket_id=\"{tid}\", asset_id=<TYR-...>, "
        "original_job_id=<the reporter's job id it replaces, for issue tickets>, item=<request index for delegated "
        "tasks>, note=<what changed, e.g. reworded prompt>). Delivering into the original job id completes that job "
        "for the waiting agent.",
        f"7. Finish: media_ticket_update(ticket_id=\"{tid}\", status=\"delivered\" | \"partially_delivered\" | "
        "\"failed\", summary=<per item: asset id, path, what you did>; add a note describing any TEAMYRA bug you "
        "noticed so maintenance can fix it later).",
        "",
        "TICKET",
        json.dumps(payload, ensure_ascii=False, indent=1)[:60000],
    ]
    return "\n".join(lines)
