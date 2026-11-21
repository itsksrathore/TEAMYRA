"""Image generation with the ChatGPT web profiles in TEAMYRA Desktop.

The fallback for codex_image_batch when the Codex accounts are at their usage
limit. Every image is one ChatGPT web job (start_job with a chatgpt-web
worker): the reference images are attached to its first message, ChatGPT
draws the picture with its own image generation, and the desktop worker saves
it from the conversation with chatgpt.save_image (format and size checked by
apps/desktop/src/image-file.js; written inside project_path only, through the
core's filesystem.write checks).

There is no runner process: the batch file maps each image to its job, and
batch_status reads the jobs' state. An image whose ChatGPT account hit its
limit (the job ended usage_or_rate_limit, which also cools that account down
in the scheduler) is started again on another ChatGPT account that is not
cooling down, when status is read; with none left it stays ``rate_limited``
with the time the limit resets, when the site said so.
"""
import json
import re
import secrets
import struct
import time
from datetime import datetime, timedelta
from pathlib import Path

import codex_images
import scheduler
from job_transfer import site_block_left

PROVIDER = "chatgpt-web"
MAX_BATCH = 50
MAX_ATTEMPTS = 3
JOB_TIMEOUT_MINUTES = 20
STATES = ("queued", "running", "done", "failed", "rate_limited", "cancelled")
TERMINAL = {"done", "failed", "cancelled"}
LIMIT_REASONS = {"usage_or_rate_limit", "site_blocked", "site_down"}
_BATCH_RE = re.compile(r"^gimg-\d{8}-\d{6}-[0-9a-f]{6}$")
SHAPES = {
    "1536x1024": "landscape, 3:2 (1536x1024)",
    "1024x1536": "portrait, 2:3 (1024x1536)",
    "1024x1024": "square, 1:1 (1024x1024)",
    "auto": "whatever shape suits the prompt best",
}

TASK = """Generate exactly one image with your own image generation (not code, not a chart, not a description).
Shape: {shape}.{refs}
Image prompt:
{prompt}

Use the prompt in full and keep the highest image quality. Do not read, list or write any other file and do not \
run commands. Once the image is shown in your reply, save it in your next reply with exactly one line:
TEAMYRA_TOOL_REQUEST {save}
When the save succeeded, reply with one line: DONE {output}. If the image service refuses the request, reply \
with one line: REFUSED: <reason>."""


def _root_dir(root):
    return Path(root) / "chatgpt-images"


def _batch_dir(root, batch_id):
    batch_id = str(batch_id or "").strip()
    if not _BATCH_RE.fullmatch(batch_id):
        raise ValueError("invalid chatgpt image batch id")
    return _root_dir(root) / batch_id


def _read_meta(root, job_id):
    folder = Path(root) / "jobs" / str(job_id or "")
    meta = codex_images._read_json(folder / "meta.json")
    if not isinstance(meta, dict):
        return None
    meta.setdefault("id", job_id)
    meta["_done"] = (folder / "DONE").exists()
    return meta


# --- accounts ------------------------------------------------------------------------

def chatgpt_accounts(registry):
    """ChatGPT web workers, default account first: [(worker_id, info)]."""
    rows = [(worker, info) for worker, info in registry.items()
            if info.get("provider") == PROVIDER and info.get("execution", "desktop-web") == "desktop-web"]
    rows.sort(key=lambda row: (str(row[1].get("profile_id") or "") != "web", row[1].get("priority", 100), row[0]))
    return rows


def resolve_account(registry, account):
    """A ChatGPT worker named by id ("chatgpt-normal", "chatgpt-2") or label."""
    wanted = str(account or "").strip()
    rows = chatgpt_accounts(registry)
    for worker, info in rows:
        if wanted == worker:
            return worker
    matches = [worker for worker, info in rows if str(info.get("label") or "").strip().lower() == wanted.lower()]
    if len(matches) == 1:
        return matches[0]
    raise ValueError(f"unknown ChatGPT account: {wanted}; use one of {[worker for worker, _ in rows]}")


def account_limits(root, registry, metas, now=None):
    """Seconds each ChatGPT account still rests after a limit (0 = usable)."""
    now = time.time() if now is None else now
    blocked = site_block_left(metas, PROVIDER, now)
    return {worker: max(blocked, scheduler.cooldown_left(root, worker, metas))
            for worker, _ in chatgpt_accounts(registry)}


def usable_accounts(root, registry, metas, wanted=None, exclude=(), now=None):
    """Enabled ChatGPT accounts that are not resting after a limit, best first."""
    limits = account_limits(root, registry, metas, now)
    rows = []
    for worker, info in chatgpt_accounts(registry):
        if wanted and worker != wanted:
            continue
        if not wanted and info.get("enabled", True) is False:
            continue
        if worker in exclude or limits.get(worker):
            continue
        rows.append((not scheduler.chatgpt_ready(root, dict(info, id=worker)), worker))
    # Accounts whose page is ready first; start_job wakes the desktop for the others.
    return [worker for _, worker in sorted(rows, key=lambda row: row[0])]


# --- reset time ----------------------------------------------------------------------

_IN_RE = re.compile(r"\b(?:in|after)\s+(?:about\s+|around\s+)?(\d+(?:\.\d+)?)\s*"
                    r"(seconds?|secs?|minutes?|mins?|hours?|hrs?|h|days?)\b", re.I)
_AT_RE = re.compile(r"\b(?:at|after|until|by)\s+(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)?(?![\w:])", re.I)
_UNITS = {"s": 1, "m": 60, "h": 3600, "d": 86400}


def limit_reset(text, ended=None, now=None):
    """When a limit notice says the limit resets, as epoch seconds, or None.
    Understands "try again in 3 hours", "resets in 45 minutes" and "after 5:30 PM"."""
    text = str(text or "")
    base = float(ended or now or time.time())
    found = _IN_RE.search(text)
    if found:
        unit = found.group(2).lower()
        seconds = _UNITS["m" if unit.startswith("min") else unit[0]]
        return base + float(found.group(1)) * seconds
    found = _AT_RE.search(text)
    if found and (found.group(2) or found.group(3)):
        hour, minute = int(found.group(1)), int(found.group(2) or 0)
        meridiem = (found.group(3) or "").lower().replace(".", "")
        if meridiem == "pm" and hour < 12:
            hour += 12
        elif meridiem == "am" and hour == 12:
            hour = 0
        if hour > 23 or minute > 59:
            return None
        start = datetime.fromtimestamp(base)
        moment = start.replace(hour=hour, minute=minute, second=0, microsecond=0)
        if moment <= start:
            moment += timedelta(days=1)
        return moment.timestamp()
    return None


def _limit_info(meta):
    notice = str(meta.get("limit_notice") or "")
    if not notice:
        event = str(meta.get("last_event") or "")
        notice = re.sub(r"^error:\s*", "", event)
    return notice[:400], limit_reset(notice, meta.get("ended"))


# --- the batch -----------------------------------------------------------------------

def _relative(project, file_path):
    return Path(file_path).resolve().relative_to(Path(project).resolve()).as_posix()


def task_text(item, project):
    output = _relative(project, item["output"])
    refs = ""
    if item["references"]:
        count = len(item["references"])
        refs = (" The attached image" + (f"s (Image 1 to Image {count})" if count > 1 else " (Image 1)") +
                " are the reference images, in that order.")
    save = json.dumps({"tool": "chatgpt.save_image", "args": {"path": output, "index": 0}})
    return TASK.format(shape=SHAPES.get(item["size"], item["size"]), refs=refs, prompt=item["prompt"],
                       save=save, output=output)


def create_batch(root, requests, project_path, account=None, *, start_job, registry, metas=None):
    """Queue one ChatGPT web job per image. ``start_job`` is server.start_job."""
    if not isinstance(requests, list) or not requests:
        raise ValueError("requests must be a non-empty array")
    if len(requests) > MAX_BATCH:
        raise ValueError(f"a chatgpt image batch takes at most {MAX_BATCH} images")
    project = Path(str(project_path or "")).expanduser()
    if not project_path or not project.is_dir():
        raise ValueError("project_path must be an existing folder")
    project = project.resolve()
    items = [codex_images._normalize(request, project, index) for index, request in enumerate(requests)]
    outputs = [item["output"].lower() for item in items]
    if len(set(outputs)) != len(outputs):
        raise ValueError("every request needs its own output path")
    for item in items:
        for ref in item["references"]:
            if not codex_images._inside(ref, project):
                raise ValueError(f"requests[{item['index']}] reference images must be inside project_path "
                                 "(ChatGPT jobs attach workspace files only)")
    fixed = resolve_account(registry, account) if account else None
    for item in items:
        item.update(status="queued", job_id=None, jobs=[], worker=None, attempts=0, error=None,
                    reset_at=None, retry_at=None)
    batch_id = time.strftime("gimg-%Y%m%d-%H%M%S-") + secrets.token_hex(3)
    folder = _batch_dir(root, batch_id)
    folder.mkdir(parents=True)
    batch = {"batch_id": batch_id, "project_path": str(project), "created_at": time.time(),
             "account": fixed, "cancel_requested": False, "items": items}
    with codex_images._lock(folder):
        metas = scheduler.load_jobs(root) if metas is None else metas
        for item in items:
            _start(root, batch, item, start_job, registry, metas)
        codex_images._write_json(folder / "batch.json", batch)
    return batch_status(root, batch_id, start_job=None, registry=registry)


def _start(root, batch, item, start_job, registry, metas, exclude=()):
    """Start (or restart) one image's job on a usable ChatGPT account."""
    fixed = batch.get("account")
    if item["attempts"] >= MAX_ATTEMPTS:
        item.update(status="failed", error=(item.get("error") or "") + f" (gave up after {MAX_ATTEMPTS} attempts)")
        return False
    accounts = usable_accounts(root, registry, metas, wanted=fixed, exclude=exclude)
    if not accounts:
        _rest(root, batch, item, registry, metas)
        return False
    # Unpinned on the default account: the scheduler spreads the jobs over
    # the ready ChatGPT accounts (rotate_web_queues). A named account, or any
    # account when the default one rests, is pinned.
    worker = accounts[0]
    pinned = bool(fixed) or str(registry[worker].get("profile_id") or "web") != "web"
    project = batch["project_path"]
    output = _relative(project, item["output"])
    try:
        job_id, worker = start_job(
            worker, task_text(item, project), project,
            label=f"ChatGPT image {item['index'] + 1}: {output}"[:80], timeout_minutes=JOB_TIMEOUT_MINUTES,
            write=True, queue=True, pin=pinned, account_fixed=pinned, transfer=False,
            expect_files=[output], attachments=[_relative(project, ref) for ref in item["references"]])
    except Exception as exc:  # not signed in, cooling down meanwhile ...
        item.update(status="failed", error=f"could not start a ChatGPT job: {exc}"[:600])
        return False
    item.update(status="queued", job_id=job_id, worker=worker, attempts=item["attempts"] + 1,
                started=time.time(), retry_at=None)
    item["jobs"] = [*item.get("jobs", []), job_id]
    return True


def _rest(root, batch, item, registry, metas):
    """No ChatGPT account is usable now: rate_limited until one rests out."""
    limits = account_limits(root, registry, metas)
    wanted = batch.get("account")
    waits = [left for worker, left in limits.items() if left and (not wanted or worker == wanted)]
    usable = [worker for worker, info in chatgpt_accounts(registry)
              if (worker == wanted if wanted else info.get("enabled", True) is not False)]
    if not usable:
        item.update(status="failed", error="no enabled ChatGPT account")
        return
    retry_at = time.time() + min(waits) if waits else None
    if item.get("reset_at") is None:
        notices = [m for m in metas if m.get("provider") == PROVIDER and m.get("reason") in LIMIT_REASONS
                   and (not wanted or m.get("worker") == wanted)]
        if notices:
            latest = max(notices, key=lambda m: float(m.get("ended") or 0))
            notice, reset_at = _limit_info(latest)
            item.update(reset_at=reset_at, error=item.get("error") or f"ChatGPT limit: {notice}"[:600])
    item.update(status="rate_limited", job_id=None, retry_at=retry_at,
                error=item.get("error") or "every ChatGPT account is resting after a usage limit")


def _output_image(item):
    """(width, height, bytes) of the saved output when it is a real image
    written by this item's job, else None."""
    path = Path(item["output"])
    try:
        stat = path.stat()
    except OSError:
        return None
    if stat.st_size <= 0 or stat.st_mtime < float(item.get("started") or 0) - 5:
        return None
    head = path.read_bytes()[:64 * 1024]
    size = image_header_size(head)
    if not size:
        return None
    return size[0], size[1], stat.st_size


def image_header_size(data):
    """(width, height) from a PNG, JPEG, WebP or GIF header, or None."""
    if data[:8] == b"\x89PNG\r\n\x1a\n" and len(data) >= 24:
        return struct.unpack(">II", data[16:24])
    if data[:6] in (b"GIF87a", b"GIF89a") and len(data) >= 10:
        return struct.unpack("<HH", data[6:10])
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP" and len(data) >= 30:
        kind = data[12:16]
        if kind == b"VP8X":
            return 1 + int.from_bytes(data[24:27], "little"), 1 + int.from_bytes(data[27:30], "little")
        if kind == b"VP8 ":
            return struct.unpack("<H", data[26:28])[0] & 0x3FFF, struct.unpack("<H", data[28:30])[0] & 0x3FFF
        if kind == b"VP8L" and len(data) >= 25:
            bits = int.from_bytes(data[21:25], "little")
            return (bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1
        return None
    if data[:2] == b"\xff\xd8":
        index = 2
        while index + 9 < len(data):
            if data[index] != 0xFF:
                index += 1
                continue
            marker = data[index + 1]
            if marker in (0xD8, 0x01) or 0xD0 <= marker <= 0xD7:
                index += 2
                continue
            length = struct.unpack(">H", data[index + 2:index + 4])[0]
            if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):
                height, width = struct.unpack(">HH", data[index + 5:index + 9])
                return width, height
            index += 2 + length
    return None


def _refresh(root, batch, item, start_job, registry, metas):
    """Bring one item up to date with its job; restart it after a limit."""
    if item["status"] in TERMINAL:
        return
    if item["status"] == "rate_limited" and not item.get("job_id"):
        if batch.get("cancel_requested"):
            item.update(status="cancelled")
        elif start_job is not None:
            _start(root, batch, item, start_job, registry, metas)
        return
    meta = _read_meta(root, item.get("job_id"))
    if meta is None:
        item.update(status="failed", error=f"job {item.get('job_id')} is missing")
        return
    state = str(meta.get("state") or "")
    if not meta["_done"] and state not in ("done", "failed", "cancelled"):
        item["status"] = "running" if state in ("running", "waiting", "needs_user") else "queued"
        item["attention"] = meta.get("attention") or (meta.get("last_event") if state == "needs_user" else None)
        return
    item["attention"] = None
    item["ended"] = float(meta.get("ended") or time.time())
    reason = meta.get("reason")
    if state == "done":
        image = _output_image(item)
        if image:
            item.update(status="done", width=image[0], height=image[1], bytes=image[2], error=None,
                        seconds=round(item["ended"] - float(item.get("started") or item["ended"])))
        else:
            item.update(status="failed", error="the ChatGPT job finished but no new image was saved at the output: " +
                        str(meta.get("last_event") or "")[:300])
        return
    if state == "cancelled" or reason == "cancelled":
        item.update(status="cancelled", error=None)
        return
    if reason in LIMIT_REASONS:
        notice, reset_at = _limit_info(meta)
        item.update(error=f"{meta.get('worker_label') or meta.get('worker')}: {notice}"[:600], reset_at=reset_at)
        if batch.get("cancel_requested"):
            item.update(status="cancelled")
            return
        # The account that hit its limit now rests (scheduler.cooldown_left);
        # another one takes the image.
        item.update(status="rate_limited", job_id=None)
        if start_job is not None:
            _start(root, batch, item, start_job, registry, metas, exclude=(meta.get("worker"),))
        return
    final = str(meta.get("last_event") or reason or "failed")
    item.update(status="failed", error=f"{reason or 'failed'}: {final}"[:600])


def batch_status(root, batch_id, *, start_job=None, registry=None):
    """Per-image status; with ``start_job`` images that hit a limit are
    started again on another ChatGPT account."""
    folder = _batch_dir(root, batch_id)
    if not (folder / "batch.json").exists():
        raise ValueError(f"no such chatgpt image batch: {batch_id}")
    with codex_images._lock(folder):
        batch = codex_images._read_json(folder / "batch.json")
        if not isinstance(batch, dict):
            raise ValueError(f"no such chatgpt image batch: {batch_id}")
        metas = scheduler.load_jobs(root) if registry is not None else []
        for item in batch["items"]:
            _refresh(root, batch, item, start_job if registry is not None else None, registry or {}, metas)
        codex_images._write_json(folder / "batch.json", batch)
    counts = {}
    for item in batch["items"]:
        counts[item["status"]] = counts.get(item["status"], 0) + 1
    done = all(item["status"] in TERMINAL for item in batch["items"])
    ended = max((item.get("ended") or 0 for item in batch["items"]), default=0)
    waiting = [item.get("retry_at") for item in batch["items"] if item["status"] == "rate_limited" and item.get("retry_at")]
    result = {
        "batch_id": batch["batch_id"], "project_path": batch["project_path"], "total": len(batch["items"]),
        "account": batch.get("account"), "counts": counts, "done": done,
        "elapsed_seconds": round((ended if done else time.time()) - batch["created_at"]),
        "items": [{key: item.get(key) for key in ("index", "status", "output", "job_id", "worker", "attempts",
                                                  "seconds", "width", "height", "bytes", "error", "attention",
                                                  "reset_at", "retry_at")} for item in batch["items"]],
    }
    if waiting:
        result["next_retry_at"] = min(waiting)
        result["note"] = ("Every usable ChatGPT account is at its limit: rate_limited images start again on the "
                          "next chatgpt_image_status call after next_retry_at (reset_at is the site's own reset "
                          "time when it gave one).")
    return result


def cancel_batch(root, batch_id, cancel_job):
    """Cancel the batch: queued and running jobs are cancelled (``cancel_job``
    is the job_cancel tool), images waiting out a limit are not started."""
    folder = _batch_dir(root, batch_id)
    with codex_images._lock(folder):
        batch = codex_images._read_json(folder / "batch.json")
        if not isinstance(batch, dict):
            raise ValueError(f"no such chatgpt image batch: {batch_id}")
        batch["cancel_requested"] = True
        jobs = []
        for item in batch["items"]:
            if item["status"] == "rate_limited" and not item.get("job_id"):
                item["status"] = "cancelled"
            elif item["status"] not in TERMINAL and item.get("job_id"):
                jobs.append(item["job_id"])
        codex_images._write_json(folder / "batch.json", batch)
    errors = []
    for job_id in jobs:
        try:
            cancel_job(job_id)
        except Exception as exc:
            errors.append(f"{job_id}: {exc}")
    result = batch_status(root, batch_id)
    if errors:
        result["cancel_errors"] = errors
    return result
