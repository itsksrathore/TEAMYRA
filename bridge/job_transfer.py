"""Hand an unfinished web-chat job over to another account or model.

When a job on a web-chat worker (ChatGPT, Muse, DeepSeek, GLM, Qwen, Grok)
cannot go on, because the site hit a usage limit, a human check or sign-in was
not done in time, the page broke, or the chat failed, TEAMYRA continues it on
the best other worker without the lead having to step in:

1. The desktop ends the stuck job as ``failed`` with a reason from
   TRANSFER_REASONS (and asks the core to dispatch, which runs ``sweep``).
2. ``sweep`` picks the next worker: one with a free tab first; among those
   another account of the same site first, then the other sites in
   ``transfer.providers`` order. Workers already tried in the chain, signed
   out, showing a check or cooling down after a limit are skipped.
3. It starts a continuation job there whose task is a context pack built from
   the files of every job in the chain: the original task, each step taken
   (files read and written, commands and their exit codes), the last reply,
   and the git state of the folder. The work on disk stays where it is.

The chain is linked like the existing failover chain (``failover_job_id`` on
the old job, ``failover_root`` / ``failover_attempt`` / ``parent`` on the new
one), so ``job_wait`` / ``job_result`` / ``job_status`` on the first job id
follow it to the job that finishes. ``transfer_expected`` keeps ``job_wait``
from reporting a failure while a hand-over is still coming.

Settings (``transfer`` in bridge/config.json, all optional):
  enabled (true), max_transfers (3), wait_minutes (30, how long a failed job
  waits for a ready worker), providers (site order), pack_chars (14000).
A job started with ``transfer: false`` is never handed over.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import time
from pathlib import Path

import scheduler
from web_sites import WEB_SITES, site_name
from worker_registry import build_worker_registry

BRIDGE = Path(__file__).resolve().parent

TRANSFER_REASONS = {
    "usage_or_rate_limit",   # the site's usage limit
    "site_blocked",          # the site refuses this PC for now (ChatGPT "unusual activity")
    "site_down",             # the site keeps failing its own requests (Z.ai 405 error pages)
    "needs_user_timeout",    # a human check / sign-in not done in time
    "account_unavailable",   # the account never became usable for a waiting job
    "page_unresponsive",     # the page stayed broken after reloads
    "worker_error",          # the chat failed in another way
    "worker_reported_error",
    "runner_crash",
    "tool_parse_error",      # the model kept sending unusable tool requests
}
ACCOUNT_REASONS = {"usage_or_rate_limit", "needs_user_timeout", "account_unavailable"}
REASON_TEXT = {
    "usage_or_rate_limit": "its site reported a usage limit",
    "site_blocked": "its site refused this PC for now (\"unusual activity\")",
    "site_down": "its site was not answering (server errors)",
    "moved_by_request": "the lead or the user moved it to you",
    "needs_user_timeout": "it was paused on a human check or sign-in that nobody completed",
    "account_unavailable": "its account was not usable (human check, sign-in or a broken page)",
    "page_unresponsive": "its chat page stopped responding",
    "worker_error": "its chat failed",
    "worker_reported_error": "it reported an error",
    "runner_crash": "its runner crashed",
    "tool_parse_error": "it could not send valid tool requests",
}
DEFAULTS = {
    "enabled": True,
    "max_transfers": 3,
    "wait_minutes": 30,
    "providers": ["chatgpt-web", "muse-web", "deepseek-web", "glm-web", "qwen-web", "grok-web"],
    "pack_chars": 14000,
    "pause_minutes": 5,
}
CLAIM_FILE = "TRANSFER.claim"
CLAIM_STALE_SECONDS = 600


def load_config():
    try:
        return json.loads((BRIDGE / "config.json").read_text(encoding="utf-8"))
    except Exception:
        return {}


def settings(config=None):
    """The ``transfer`` settings from a parsed config (read from disk if None)."""
    if config is None:
        config = load_config()
    raw = config.get("transfer") if isinstance(config, dict) else None
    out = dict(DEFAULTS)
    if isinstance(raw, dict):
        out.update({k: v for k, v in raw.items() if k in DEFAULTS and v is not None})
    out["max_transfers"] = max(0, min(int(out["max_transfers"]), 8))
    out["wait_minutes"] = max(1, min(float(out["wait_minutes"]), 24 * 60))
    out["pack_chars"] = max(4000, min(int(out["pack_chars"]), 60000))
    out["pause_minutes"] = max(0.5, min(float(out["pause_minutes"]), 24 * 60))
    return out


# --- which jobs ----------------------------------------------------------------------
def _attempt(meta):
    try:
        return int(meta.get("failover_attempt") or 0)
    except (TypeError, ValueError):
        return 0


def transfer_expected(meta, now=None, config=None, done=True):
    """A finished job that the sweep will still hand over (or is trying to)."""
    cfg = settings(config)
    if not cfg["enabled"] or not done or not isinstance(meta, dict):
        return False
    if meta.get("provider") not in WEB_SITES or meta.get("state") != "failed":
        return False
    if meta.get("reason") not in TRANSFER_REASONS or meta.get("transfer") is False:
        return False
    if meta.get("auto_failover_enabled"):
        return False  # the older failover monitor owns this chain
    if meta.get("failover_job_id") or meta.get("transfer_exhausted"):
        return False
    if _attempt(meta) >= cfg["max_transfers"]:
        return False
    ended = float(meta.get("ended") or meta.get("updated") or 0)
    now = time.time() if now is None else now
    return bool(ended) and now - ended <= cfg["wait_minutes"] * 60


def transferable_now(meta, config=None):
    """For a running job: may it be handed over if it stops (desktop asks)?"""
    cfg = settings(config)
    return bool(cfg["enabled"] and meta.get("provider") in WEB_SITES and meta.get("transfer") is not False
                and not meta.get("auto_failover_enabled") and _attempt(meta) < cfg["max_transfers"])


# --- which worker ----------------------------------------------------------------------
def _chain(root, meta):
    """Jobs of the chain from the first one to ``meta`` (by ``parent`` links)."""
    jobs = Path(root) / "jobs"
    chain = [meta]
    seen = {meta.get("id")}
    current = meta
    while current.get("parent") and _attempt(current) > 0 and len(chain) < 12:
        parent = scheduler._read_json(jobs / current["parent"] / "meta.json")
        if not isinstance(parent, dict) or parent.get("id") in seen:
            break
        seen.add(parent.get("id"))
        chain.insert(0, parent)
        current = parent
    return chain


SITE_BLOCK_SECONDS = 1800


def blocked_sites(metas, now=None):
    """Sites that refused this PC in the last 30 minutes (a job ended site_blocked).
    Every account of such a site is skipped: the block is for the PC, not one account."""
    now = time.time() if now is None else now
    return {m.get("provider") for m in metas
            if m.get("reason") in ("site_blocked", "site_down") and now - float(m.get("ended") or 0) < SITE_BLOCK_SECONDS}


def site_block_left(metas, provider, now=None):
    """Seconds this site stays skipped after a job ended site_blocked/site_down (0 = usable)."""
    now = time.time() if now is None else now
    ends = [float(m.get("ended") or 0) for m in metas
            if m.get("provider") == provider and m.get("reason") in ("site_blocked", "site_down")]
    return max(0, int(max(ends, default=0) + SITE_BLOCK_SECONDS - now))


def candidates(root, meta, config=None, metas=None, registry=None):
    """Ready workers for a hand-over, best first: [(worker_id, info, free)]."""
    cfg = settings(config)
    registry = registry if registry is not None else build_worker_registry(root)
    metas = scheduler.load_jobs(root) if metas is None else metas
    blocked = blocked_sites(metas)
    tried = set(meta.get("previous_workers") or [])
    for item in _chain(root, meta):
        if item.get("worker"):
            tried.add(item["worker"])
    allowed = set(meta.get("worker_order") or [])
    order = [p for p in cfg["providers"] if p in WEB_SITES] + [p for p in WEB_SITES if p not in cfg["providers"]]
    own = meta.get("provider")
    # A limit, a check or a sign-in belongs to one account: another account of
    # the same site comes first. A broken page, a failed chat or unusable tool
    # requests are more likely the site or model itself: other sites first,
    # the same site last (Qwen's page hung on both accounts, 2026-11-07).
    account_problem = meta.get("reason") in ACCOUNT_REASONS or not meta.get("reason")
    rows = []
    for worker, info in registry.items():
        provider = info.get("provider")
        if provider not in WEB_SITES or worker in tried or info.get("enabled", True) is False:
            continue
        if provider in blocked:
            continue
        if allowed and worker not in allowed:
            continue
        if not scheduler.chatgpt_ready(root, info) or scheduler.cooldown_left(root, worker, metas):
            continue
        active = len(scheduler.active_jobs(root, worker, metas))
        queued = len(scheduler.queued_jobs(root, worker, metas))
        capacity = scheduler.worker_capacity(root, info)
        free = active + queued < capacity
        if provider == own:
            rank = 0 if account_problem else len(order) + 1
        else:
            rank = 1 + order.index(provider)
        key = (0 if free else 1, rank, (active + queued) / capacity, int(info.get("priority") or 100), worker)
        rows.append((key, worker, info, free))
    rows.sort(key=lambda row: row[0])
    return [(worker, info, free) for _, worker, info, free in rows]


# --- the context pack -------------------------------------------------------------------
def _events(job_dir):
    path = Path(job_dir) / "events.jsonl"
    out = []
    try:
        with open(path, encoding="utf-8", errors="replace") as handle:
            for line in handle:
                try:
                    event = json.loads(line)
                except ValueError:
                    continue
                if isinstance(event, dict):
                    out.append(event)
    except OSError:
        pass
    return out


def _json_or_none(text):
    try:
        value = json.loads(text)
        return value if isinstance(value, dict) else None
    except ValueError:
        return None


def _short(text, limit):
    text = re.sub(r"\s+", " ", str(text or "")).strip()
    return text if len(text) <= limit else text[: limit - 1] + "…"


def _command_line(text):
    """'tool {args}' from a command event -> (tool, args dict or None, raw args)."""
    tool, _, raw = str(text or "").partition(" ")
    return tool, _json_or_none(raw), raw


def _describe_step(tool, args, raw):
    args = args or {}
    path = args.get("path") or args.get("file") or args.get("dir") or ""
    if tool in ("filesystem.read", "filesystem.read_many"):
        return f"read {path or _short(raw, 120)}"
    if tool in ("filesystem.list", "filesystem.tree", "filesystem.search", "filesystem.find", "filesystem.grep"):
        query = args.get("query") or args.get("pattern") or ""
        return f"{tool.split('.')[1]} {path}{(' ' + repr(_short(query, 60))) if query else ''}".strip()
    if tool in ("filesystem.create", "filesystem.write"):
        size = len(str(args.get("content") or ""))
        return f"wrote {path}" + (f" ({size} chars)" if size else "")
    if tool == "filesystem.patch":
        return f"edited {path}"
    if tool in ("filesystem.move", "filesystem.rename"):
        return f"moved {args.get('from') or args.get('source') or path} -> {args.get('to') or args.get('destination') or ''}"
    if tool == "filesystem.delete":
        return f"deleted {path}"
    if tool in ("terminal.run", "process.start"):
        argv = args.get("argv") or args.get("command") or args.get("cmd") or raw
        command = " ".join(str(part) for part in argv) if isinstance(argv, list) else str(argv)
        return f"ran `{_short(command, 220)}`"
    return f"{tool} {_short(raw, 160)}".strip()


def _describe_result(text):
    data = _json_or_none(text)
    if data is None:
        code = re.search(r'"exit_code"\s*:\s*(-?\d+)', str(text or ""))
        error = re.search(r'"error"\s*:\s*"([^"]{0,160})', str(text or ""))
        if error:
            return "failed: " + error.group(1)
        return f"exit {code.group(1)}" if code else ""
    if data.get("ok") is False or data.get("error"):
        return "failed: " + _short(data.get("error") or data.get("message") or "error", 160)
    if "exit_code" in data:
        code = data.get("exit_code")
        tail = _short((data.get("stderr") or "") if code else "", 140)
        return f"exit {code}" + (f" ({tail})" if tail else "")
    return "ok"


WRITE_TOOLS = {"filesystem.create", "filesystem.write", "filesystem.patch", "filesystem.move",
               "filesystem.rename", "filesystem.delete"}


def _steps(job_dir):
    """Steps of one job: list of (text, wrote_path or None)."""
    steps = []
    pending = None
    for event in _events(job_dir):
        kind = event.get("kind")
        if kind == "command":
            if pending:
                steps.append(pending)
            tool, args, raw = _command_line(event.get("text"))
            wrote = None
            if tool in WRITE_TOOLS and isinstance(args, dict):
                wrote = args.get("path") or args.get("to") or args.get("destination")
            pending = [_describe_step(tool, args, raw), wrote, ""]
        elif kind == "result" and pending:
            pending[2] = _describe_result(event.get("text"))
            steps.append(pending)
            pending = None
    if pending:
        pending[2] = "no result (the job stopped here)"
        steps.append(pending)
    return [(text + (f" -> {result}" if result else ""), wrote) for text, wrote, result in steps]


def _last_reply(job_dir):
    state = scheduler._read_json(Path(job_dir) / "chatgpt-state.json") or {}
    reply = str(state.get("reply") or "").strip()
    if not reply:
        for event in reversed(_events(job_dir)):
            if event.get("kind") == "message":
                reply = str(event.get("text") or "").strip()
                break
    return reply


def _git(cwd, *args):
    try:
        out = subprocess.run(["git", "-C", str(cwd), *args], capture_output=True, text=True, timeout=20,
                             encoding="utf-8", errors="replace",
                             creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        return out.stdout.strip() if out.returncode == 0 else ""
    except Exception:
        return ""


def original_task(root, chain):
    first = chain[0]
    path = Path(root) / "jobs" / first["id"] / "task.txt"
    try:
        return path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""


def build_pack(root, meta, config=None):
    """The continuation task for the job after ``meta`` (the failed one)."""
    cfg = settings(config)
    budget = cfg["pack_chars"]
    chain = _chain(root, meta)
    task = original_task(root, chain)
    jobs = Path(root) / "jobs"
    cwd = meta.get("cwd") or ""
    who = f"{meta.get('worker_label') or meta.get('worker')} ({site_name(meta.get('provider'))})"
    why = REASON_TEXT.get(meta.get("reason"), "it stopped")
    detail = _short(meta.get("last_event") or "", 200)

    steps, written = [], []
    for item in chain:
        label = f"{item.get('worker_label') or item.get('worker')} ({site_name(item.get('provider'))})"
        for text, wrote in _steps(jobs / item["id"]):
            steps.append(f"[{label}] {text}")
            if wrote and wrote not in written:
                written.append(wrote)

    # Keep the newest steps; summarise the rest by count.
    step_budget = budget // 2
    shown, used = [], 0
    for line in reversed(steps):
        line = _short(line, 300)
        if used + len(line) + 3 > step_budget:
            break
        shown.insert(0, line)
        used += len(line) + 3
    skipped = len(steps) - len(shown)

    reply = _last_reply(jobs / meta["id"])
    reply = reply[-3000:] if len(reply) > 3000 else reply

    head = chain[0].get("head_start") or meta.get("head_start")
    status = _git(cwd, "status", "--short") if cwd else ""
    status_lines = status.splitlines()
    diffstat = _git(cwd, "diff", "--shortstat", head) if cwd and head else ""
    commits = _git(cwd, "log", "--oneline", f"{head}..HEAD") if cwd and head else ""

    parts = [
        "TEAMYRA HANDOVER: continue an unfinished task.",
        "",
        f"Another agent, {who}, was working on the task below and had to stop because {why}"
        + (f" (last state: {detail})" if detail else "") + ". TEAMYRA moved the task to you.",
        f"Its work is still on disk in {cwd}. Do not start over: first check the current state of the files "
        "it touched (read them, git status), keep the work that is correct and finished, then do what is left. "
        "Repeat a step only if its result below is missing or failed. Use the same TEAMYRA tools as it did.",
        "",
        "## Original task",
        task.strip() or "(the original task text is missing; work from the steps and the folder)",
        "",
        "## What was already done (oldest first)",
    ]
    if skipped > 0:
        parts.append(f"({skipped} earlier steps are not listed.)")
    parts.extend("- " + line for line in shown) if shown else parts.append("- nothing yet: no tool step was run.")
    if written:
        parts += ["", "## Files it created or changed", *("- " + w for w in written[:80])]
        if len(written) > 80:
            parts.append(f"- … and {len(written) - 80} more")
    if reply:
        parts += ["", "## Its last reply", reply]
    if status_lines or diffstat or commits:
        parts += ["", "## Folder state now"]
        if commits:
            parts += ["Commits since the task started:", *commits.splitlines()[:20]]
        if diffstat:
            parts.append("Changes since the task started: " + diffstat)
        if status_lines:
            parts += ["git status --short:", *status_lines[:40]]
            if len(status_lines) > 40:
                parts.append(f"… and {len(status_lines) - 40} more")
    parts += ["", "When the task is complete, reply with the final report the original task asks for, "
              "covering the work of the earlier agent(s) as well as yours."]
    return "\n".join(parts)


# --- doing it ---------------------------------------------------------------------------
def _claim(job_dir):
    path = Path(job_dir) / CLAIM_FILE
    try:
        if path.exists() and time.time() - path.stat().st_mtime > CLAIM_STALE_SECONDS:
            path.unlink()
    except OSError:
        pass
    try:
        fd = os.open(str(path), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    except OSError:
        return None
    os.write(fd, str(os.getpid()).encode())
    os.close(fd)
    return path


def transfer_one(root, meta, start_job, config=None, metas=None):
    """Hand one failed job over. Returns a result dict, or None if it waits."""
    cfg = settings(config)
    jobs = Path(root) / "jobs"
    job_dir = jobs / meta["id"]
    claim = _claim(job_dir)
    if not claim:
        return None
    try:
        fresh = scheduler._read_json(job_dir / "meta.json") or {}
        fresh.setdefault("id", meta["id"])
        if not transfer_expected(fresh, config=config):
            return None
        options = candidates(root, fresh, config, metas)
        if not options:
            if not fresh.get("transfer_waiting_since"):
                scheduler.patch_meta(root, fresh["id"], transfer_waiting_since=time.time(),
                                     last_event="waiting for a free agent to take this task over")
                scheduler._append_event(job_dir, "transfer", "no other agent is ready yet; the task will move "
                                        "as soon as one is (for up to %d min)" % cfg["wait_minutes"])
            return None
        return _launch(root, fresh, options, start_job, config)
    finally:
        try:
            claim.unlink()
        except OSError:
            pass


def _launch(root, fresh, options, start_job, config=None):
    """Start the continuation of ``fresh`` on the first of ``options`` that
    takes it, and link the chain. Returns a result dict or None."""
    jobs = Path(root) / "jobs"
    job_dir = jobs / fresh["id"]
    chain = _chain(root, fresh)
    root_id = fresh.get("failover_root") or chain[0]["id"]
    attempt = _attempt(fresh) + 1
    previous = list(dict.fromkeys([*(fresh.get("previous_workers") or []),
                                   *(item.get("worker") for item in chain if item.get("worker"))]))
    pack = build_pack(root, fresh, config)
    remaining = fresh.get("timeout_s") or 5400
    label = f"{chain[0].get('label') or root_id}"[:72] + f" (moved {attempt})"
    last_error = None
    for worker, info, _free in options[:4]:
        try:
            new_id, chosen = start_job(
                worker, pack, fresh["cwd"], label=label,
                timeout_minutes=max(5, min(int(remaining / 60), 720)), write=fresh.get("write", True),
                parent=fresh["id"], auto_failover=False, max_failovers=0,
                failover_attempt=attempt, failover_root=root_id, previous_workers=previous,
                start_monitor=False, queue=True, pin=True, pool=False,
                expect_files=fresh.get("expect_files") or None,
                worker_order=fresh.get("worker_order") or None,
            )
        except Exception as exc:  # not ready after all, cooling down, …
            last_error = exc
            continue
        to_label = info.get("label") or chosen
        scheduler.patch_meta(root, fresh["id"], failover_job_id=new_id, failover_worker=chosen,
                             failover_worker_label=to_label, transfer_waiting_since=None,
                             transferred_at=time.time(),
                             last_event=f"moved to {to_label} ({site_name(info.get('provider'))}) as {new_id}")
        scheduler._append_event(job_dir, "transfer",
                                f"handed over to {to_label} ({site_name(info.get('provider'))}) as job {new_id}, "
                                f"with the task, every step done so far and the folder state")
        new_dir = jobs / new_id
        scheduler.patch_meta(root, new_id, transfer=fresh.get("transfer", True), transferred_from=fresh["id"],
                             transferred_from_label=fresh.get("worker_label") or fresh.get("worker"),
                             transfer_reason=fresh.get("reason"))
        scheduler._append_event(new_dir, "transfer",
                                f"continues job {fresh['id']} from {fresh.get('worker_label') or fresh.get('worker')} "
                                f"({REASON_TEXT.get(fresh.get('reason'), fresh.get('reason'))})")
        if root_id != fresh["id"]:
            try:
                scheduler.patch_meta(root, root_id, transfer_active_job=new_id, transfer_attempts=attempt)
            except Exception:
                pass
        return {"job_id": fresh["id"], "new_job_id": new_id, "worker": chosen, "attempt": attempt}
    scheduler._append_event(job_dir, "transfer", f"could not start the hand-over: {last_error}")
    return None


def move_options(root, meta, config=None):
    """Where a job could go now: [{worker, label, site, free}], best first."""
    rows = candidates(root, dict(meta, reason="moved_by_request"), config)
    return [{"worker": w, "label": info.get("label") or w, "site": site_name(info.get("provider")), "free": free}
            for w, info, free in rows]


def move_job(root, meta, start_job, worker=None, provider=None, config=None):
    """Continue a stopped job on another account or model, on request (MCP
    job_move). ``worker`` names the account; ``provider`` (e.g. "deepseek-web")
    asks for the best ready account of that site; neither picks the best ready
    web-chat agent. The new job gets the same context pack as a hand-over."""
    # The same claim as an automatic hand-over: job_move and the sweep raced
    # and started two continuations in one worktree (ISS-20261107-173858).
    job_dir = Path(root) / "jobs" / meta["id"]
    claim = None
    deadline = time.time() + 30
    while claim is None:
        claim = _claim(job_dir)
        if claim is None:
            if time.time() > deadline:
                raise ValueError("an automatic hand-over of this job is in progress; check job_status")
            time.sleep(0.5)
    try:
        current = scheduler._read_json(job_dir / "meta.json") or {}
        if current.get("failover_job_id"):
            raise ValueError(f"this job already continues as {current['failover_job_id']} "
                             "(moved automatically); move that job instead")
        return _move_claimed(root, dict(meta, **current), start_job, worker, provider, config)
    finally:
        try:
            claim.unlink()
        except OSError:
            pass


def _move_claimed(root, meta, start_job, worker=None, provider=None, config=None):
    registry = build_worker_registry(root)
    fresh = dict(meta, reason="moved_by_request")
    if worker:
        info = registry.get(worker)
        if not info:
            raise ValueError(f"unknown worker: {worker}")
        options = [(worker, info, True)]
    else:
        options = candidates(root, fresh, config)
        if provider:
            options = [row for row in options if row[1].get("provider") == provider]
    if not options:
        raise ValueError("no ready agent to move this job to" + (f" on {provider}" if provider else ""))
    scheduler.patch_meta(root, meta["id"], reason="moved_by_request", transfer=meta.get("transfer", True))
    result = _launch(root, fresh, options, start_job, config)
    if not result:
        raise ValueError("the move could not start (see the job's events)")
    return result


def pause_over(meta, config=None, now=None):
    """A running job paused for the user (a check, a sign-in) long enough to move."""
    cfg = settings(config)
    attention = meta.get("attention") if isinstance(meta.get("attention"), dict) else {}
    since = float(attention.get("since") or 0)
    now = time.time() if now is None else now
    return bool(since) and now - since >= cfg["pause_minutes"] * 60


def _unusable(root, worker, info, metas):
    """Why a web account cannot take work now ('' when it can)."""
    if (info or {}).get("provider") in blocked_sites(metas):
        return "is on a site that refuses this PC for now"
    if scheduler.cooldown_left(root, worker, metas):
        return "is cooling down after a usage limit"
    if scheduler.web_account_blocked(scheduler._web_account_status(root, info)):
        return "needs a sign-in or a human check"
    # Its page never became ready (DeepSeek 5, 2026-11-07: "page loaded;
    # waiting for an interactive prompt" for 8 min, the job never started).
    if not scheduler.chatgpt_ready(root, info):
        return "did not get its page ready"
    return ""


def move_unstarted(root, config=None, registry=None):
    """Queued jobs, and dispatched jobs whose account never started them, that
    wait on an account that is blocked or cooling down: give them to a ready
    account or model with a free tab. Nothing ran yet, so nothing to carry."""
    config = load_config() if config is None else config
    cfg = settings(config)
    if not cfg["enabled"]:
        return []
    registry = registry if registry is not None else build_worker_registry(root)
    metas = scheduler.load_jobs(root)
    now = time.time()
    jobs = Path(root) / "jobs"
    moved = []
    for meta in metas:
        if meta.get("_done") or meta.get("provider") not in WEB_SITES or meta.get("transfer") is False:
            continue
        if meta.get("auto_failover_enabled") or meta.get("state") not in (scheduler.QUEUED, "waiting_for_desktop"):
            continue
        since = float(meta.get("dispatched_at") if meta.get("state") == "waiting_for_desktop"
                      else meta.get("queued_at") or meta.get("created") or now)
        if now - since < cfg["pause_minutes"] * 60:
            continue
        if (jobs / meta["id"] / "chatgpt-state.json").exists():
            continue  # its account already started it: the desktop moves it (with its context) if needed
        old = meta.get("worker")
        why = _unusable(root, old, registry.get(old) or {}, metas)
        if not why:
            continue
        options = [row for row in candidates(root, meta, config, metas, registry) if row[2]]
        if not options:
            continue
        worker, info, _ = options[0]
        lock = scheduler.SchedulerLock(root, 2)
        if not lock.acquire():
            break
        try:
            job_dir = jobs / meta["id"]
            fresh = scheduler._read_json(job_dir / "meta.json")
            spec = scheduler._read_json(job_dir / "spec.json")
            if (not isinstance(fresh, dict) or not isinstance(spec, dict) or (job_dir / "DONE").exists()
                    or fresh.get("worker") != old or fresh.get("state") != meta.get("state")
                    or (job_dir / "chatgpt-state.json").exists()):
                continue
            label = info.get("label") or worker
            previous = list(dict.fromkeys([*(fresh.get("previous_workers") or []), old]))
            scheduler._write_spec(job_dir, dict(spec, worker=worker, provider=info.get("provider"),
                                                profile_id=info.get("profile_id"), env={}))
            fresh.update(worker=worker, provider=info.get("provider"), worker_label=label,
                         profile_id=info.get("profile_id"), previous_workers=previous,
                         state=scheduler.QUEUED, queued_at=now, attention=None, not_ready_since=None,
                         last_event=f"moved to {label}: {old} {why}")
            scheduler._write_meta(job_dir, fresh)
            scheduler._append_event(job_dir, "transfer", f"{old} {why}; moved to {label} "
                                                         f"({site_name(info.get('provider'))}) before it started")
            moved.append({"job_id": meta["id"], "from": old, "to": worker})
        finally:
            lock.release()
        metas = scheduler.load_jobs(root)
    return moved


def give_up(root, meta, config=None):
    cfg = settings(config)
    scheduler.patch_meta(root, meta["id"], transfer_exhausted=True,
                         last_event=f"no agent was free to take this task over within {int(cfg['wait_minutes'])} min")
    scheduler._append_event(Path(root) / "jobs" / meta["id"], "transfer",
                            "hand-over given up: no other agent became ready in time")


def sweep(root, start_job, config=None):
    """Hand over every failed web-chat job that should move. Cheap when idle."""
    config = load_config() if config is None else config
    cfg = settings(config)
    if not cfg["enabled"]:
        return []
    results = []
    try:
        results.extend(move_unstarted(root, config))
    except Exception as exc:
        print("TEAMYRA hand-over (unstarted jobs) error:", exc, flush=True)
    metas = scheduler.load_jobs(root)
    now = time.time()
    for meta in metas:
        if not meta.get("_done") or meta.get("state") != "failed" or meta.get("provider") not in WEB_SITES:
            continue
        if meta.get("reason") not in TRANSFER_REASONS or meta.get("failover_job_id") or meta.get("transfer_exhausted"):
            continue
        if not transfer_expected(meta, now, config):
            ended = float(meta.get("ended") or 0)
            # Waited too long for a free worker: say so once.
            if (meta.get("transfer_waiting_since") and ended and now - ended > cfg["wait_minutes"] * 60
                    and not meta.get("auto_failover_enabled")):
                give_up(root, meta, config)
            continue
        try:
            done = transfer_one(root, meta, start_job, config, metas)
        except Exception as exc:
            scheduler._append_event(Path(root) / "jobs" / meta["id"], "transfer", f"hand-over error: {exc}")
            continue
        if done:
            results.append(done)
            metas = scheduler.load_jobs(root)
    return results
