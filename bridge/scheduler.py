"""Per-worker FIFO queues with optional provider pooling for TEAMYRA.

A job created with queue=true while its worker already has an active job is
persisted in state ``queued`` (jobs/<id>/meta.json, with ``queue_position``)
and nothing is spawned. ``dispatch_once()`` starts the oldest queued job of
every free worker: it spawns runner.py for CLI providers and sets
``waiting_for_desktop`` for chatgpt-web. It is called from the MCP server's
background thread, from runner.py when a job ends, from recovery and right
after a job is enqueued.

Double dispatch is prevented by an OS-level exclusive lock on
jobs/_scheduler.lock (released automatically when a holder process dies) plus
an in-process thread lock; the decision "worker is free" and the state change
of the dispatched job happen while the lock is held.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path
from worker_registry import build_worker_registry

QUEUED = "queued"
# A worker with a job in one of these states (and no DONE file) is busy.
ACTIVE_STATES = {"starting", "running", "waiting", "waiting_for_desktop", "needs_user"}
DESKTOP_PROVIDERS = {"chatgpt-web"}
COOLDOWN_SECONDS = 1800
LOCK_NAME = "_scheduler.lock"
LOCK_WAIT_SECONDS = 15.0
INTERNAL_PROCESS_MODES = {"runner.py": "__runner"}

_THREAD_LOCK = threading.Lock()


# --- filesystem helpers -------------------------------------------------------------
def _jobs_dir(root):
    return Path(root) / "jobs"


def _read_json(path):
    for _ in range(5):  # writers replace meta.json atomically; retry a torn read
        try:
            return json.loads(Path(path).read_text(encoding="utf-8"))
        except FileNotFoundError:
            return None
        except (ValueError, OSError):
            time.sleep(0.05)
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except Exception:
        return None


def _write_meta(job_dir, meta):
    meta["updated"] = time.time()
    path = Path(job_dir) / "meta.json"
    tmp = path.with_name(path.name + f".tmp-sched-{os.getpid()}-{uuid.uuid4().hex[:6]}")
    tmp.write_text(json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8")
    for attempt in range(20):
        try:
            os.replace(tmp, path)
            break
        except PermissionError:  # Windows: a reader or another writer holds meta.json for a moment
            if attempt == 19:
                try:
                    tmp.unlink()
                except OSError:
                    pass
                raise
            time.sleep(0.05)
    return meta


def _write_spec(job_dir, spec):
    path = Path(job_dir) / "spec.json"
    tmp = path.with_name(path.name + f".tmp-sched-{uuid.uuid4().hex}")
    try:
        tmp.write_text(json.dumps(spec, ensure_ascii=False, indent=1), encoding="utf-8")
        os.replace(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)


def chatgpt_ready(root, info):
    """A pool recipient must have a fresh, ready desktop account."""
    status = _read_json(Path(root) / "chatgpt" / "status.json") or {}
    if time.time() - float(status.get("heartbeat_at") or 0) > 20:
        return False
    profile = str(info.get("profile_id") or "web")
    account = (status.get("profiles") or {}).get(profile) or {}
    if profile == str(status.get("active_profile_id") or "web"):
        return bool(status.get("worker_ready") or account.get("automation_ready") or account.get("session_present"))
    return bool(account.get("automation_ready") or account.get("session_present"))


def _reassign_job(root, meta, worker, info):
    """Publish spec before meta while the dispatch lock protects the pair.

    Desktop consumers only read dispatched metas; both files are replaced before
    the state can leave queued. If publishing meta fails, restore the old spec.
    """
    job_dir = _jobs_dir(root) / meta["id"]
    fresh = _read_json(job_dir / "meta.json")
    spec = _read_json(job_dir / "spec.json")
    if not isinstance(fresh, dict) or not isinstance(spec, dict) or not is_queued(fresh):
        return False
    if fresh.get("pin") or spec.get("pin") or (job_dir / "DONE").exists():
        return False
    old_worker = fresh["worker"]
    updated_spec = dict(spec, worker=worker, profile_id=info.get("profile_id"))
    # Preserve the job's command/settings, but use the recipient's account.
    env = dict(spec.get("env") or {})
    if fresh.get("provider") == "codex":
        env["CODEX_HOME"] = str(info["home"])
    elif fresh.get("provider") == "claude":
        env.pop("CLAUDE_CONFIG_DIR", None)
        if not info.get("native"):
            env["CLAUDE_CONFIG_DIR"] = str(info["home"])
    updated_spec["env"] = env
    previous = list(fresh.get("previous_workers") or [])
    previous.append(old_worker)
    fresh.update(worker=worker, worker_label=info.get("label"), profile_id=info.get("profile_id"),
                 previous_workers=previous)
    _write_spec(job_dir, updated_spec)
    try:
        _write_meta(job_dir, fresh)
    except Exception:
        _write_spec(job_dir, spec)
        raise
    _append_event(job_dir, "pool_reassigned", f"pool reassigned {old_worker} -> {worker}")
    meta.update(fresh)
    return True


def patch_meta(root, job_id, **changes):
    job_dir = _jobs_dir(root) / job_id
    meta = _read_json(job_dir / "meta.json")
    if not isinstance(meta, dict):
        raise ValueError(f"no such job: {job_id}")
    meta.update(changes)
    return _write_meta(job_dir, meta)


def _valid_job_id(job_id):
    return bool(job_id) and not any(c in str(job_id) for c in "/\\") and ".." not in str(job_id)


def is_done(root, job_id):
    return (_jobs_dir(root) / job_id / "DONE").exists()


def load_jobs(root):
    """All job metas (dicts with an ``id``), oldest first."""
    jobs = _jobs_dir(root)
    out = []
    if not jobs.exists():
        return out
    for folder in jobs.iterdir():
        if not folder.is_dir():
            continue
        meta = _read_json(folder / "meta.json")
        if isinstance(meta, dict):
            meta.setdefault("id", folder.name)
            meta["_done"] = (folder / "DONE").exists()
            out.append(meta)
    out.sort(key=lambda m: (float(m.get("created") or 0), str(m.get("id"))))
    return out


def is_active(meta):
    return not meta.get("_done") and str(meta.get("state") or "") in ACTIVE_STATES


def is_queued(meta):
    return not meta.get("_done") and meta.get("state") == QUEUED


def queue_key(meta):
    order = meta.get("queue_order")
    try:
        order = float(order)
    except (TypeError, ValueError):
        order = float(meta.get("created") or 0)
    return (order, float(meta.get("created") or 0), str(meta.get("id")))


def queued_jobs(root, worker=None, metas=None):
    metas = load_jobs(root) if metas is None else metas
    rows = [m for m in metas if is_queued(m) and (worker is None or m.get("worker") == worker)]
    rows.sort(key=queue_key)
    return rows


def active_jobs(root, worker=None, metas=None):
    metas = load_jobs(root) if metas is None else metas
    return [m for m in metas if is_active(m) and (worker is None or m.get("worker") == worker)]


def worker_busy(root, worker, metas=None):
    return bool(active_jobs(root, worker, metas))


def cooldown_left(root, worker, metas=None):
    try:
        cleared = json.loads((_jobs_dir(root) / "_cooldown_cleared.json").read_text(encoding="utf-8")).get(worker, 0)
    except Exception:
        cleared = 0
    metas = load_jobs(root) if metas is None else metas
    for meta in sorted(metas, key=lambda m: float(m.get("created") or 0), reverse=True):
        if meta.get("worker") == worker and meta.get("reason") == "usage_or_rate_limit":
            ended = float(meta.get("ended") or 0)
            if ended > float(cleared or 0):
                return max(0, int(ended + COOLDOWN_SECONDS - time.time()))
            break
    return 0


# --- the scheduler lock --------------------------------------------------------------
class SchedulerLock:
    """Exclusive cross-process + cross-thread lock on jobs/_scheduler.lock."""

    def __init__(self, root, timeout=LOCK_WAIT_SECONDS):
        self.path = _jobs_dir(root) / LOCK_NAME
        self.timeout = float(timeout)
        self.handle = None
        self.thread_locked = False

    def _try_os_lock(self):
        handle = open(self.path, "a+b")
        try:
            if os.name == "nt":
                import msvcrt
                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            handle.close()
            return None
        return handle

    def acquire(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        deadline = time.time() + self.timeout
        if not _THREAD_LOCK.acquire(timeout=max(0.0, self.timeout)):
            return False
        self.thread_locked = True
        while True:
            handle = self._try_os_lock()
            if handle is not None:
                self.handle = handle
                return True
            if time.time() >= deadline:
                self.release()
                return False
            time.sleep(0.05)

    def release(self):
        if self.handle is not None:
            try:
                if os.name == "nt":
                    import msvcrt
                    self.handle.seek(0)
                    msvcrt.locking(self.handle.fileno(), msvcrt.LK_UNLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(self.handle.fileno(), fcntl.LOCK_UN)
            except OSError:
                pass
            try:
                self.handle.close()
            except OSError:
                pass
            self.handle = None
        if self.thread_locked:
            self.thread_locked = False
            _THREAD_LOCK.release()

    def __enter__(self):
        if not self.acquire():
            raise TimeoutError("TEAMYRA scheduler lock is busy")
        return self

    def __exit__(self, *exc):
        self.release()
        return False


# --- spawning ------------------------------------------------------------------------
def runtime_command(bridge, python_exe, script_name, *args):
    mode = INTERNAL_PROCESS_MODES.get(str(script_name))
    frozen_exe = os.environ.get("TEAMYRA_CORE_EXE")
    if mode and (frozen_exe or getattr(sys, "frozen", False)):
        return [str(frozen_exe or sys.executable), mode, *map(str, args)]
    return [str(python_exe or sys.executable), str(Path(bridge) / str(script_name)), *map(str, args)]


def default_spawn(bridge, python_exe):
    bridge = Path(bridge or Path(__file__).resolve().parent)

    def spawn(job_dir, meta):
        job_dir = Path(job_dir)
        flags = getattr(subprocess, "CREATE_NO_WINDOW", 0) | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
        cmd = runtime_command(bridge, python_exe, "runner.py", job_dir)
        cwd = meta.get("cwd") or str(job_dir)
        log = open(job_dir / "runner.log", "a", encoding="utf-8")
        try:
            kwargs = dict(cwd=str(cwd), stdin=subprocess.DEVNULL, stdout=log, stderr=log, close_fds=True)
            try:  # break away from the caller's job object so its exit does not kill the job
                proc = subprocess.Popen(cmd, creationflags=flags | 0x01000000, **kwargs)
            except OSError:
                proc = subprocess.Popen(cmd, creationflags=flags, **kwargs)
        finally:
            log.close()
        return proc.pid

    return spawn


def _append_event(job_dir, kind, text):
    try:
        with open(Path(job_dir) / "events.jsonl", "a", encoding="utf-8") as handle:
            handle.write(json.dumps({"ts": time.time(), "kind": kind, "text": str(text)[:4000]},
                                    ensure_ascii=False) + "\n")
        with open(Path(job_dir) / "transcript.md", "a", encoding="utf-8") as handle:
            handle.write(f"[{time.strftime('%H:%M:%S')}] -- {text}\n")
    except OSError:
        pass


def _finish(job_dir, meta, state, reason, message):
    now = time.time()
    meta.update(state=state, reason=reason, exit_code=0 if state == "done" else 1, ended=now,
                queue_position=None, last_event=message, runner_pid=None)
    _write_meta(job_dir, meta)
    _append_event(job_dir, "done", message)
    (Path(job_dir) / "DONE").write_text(state, encoding="utf-8")


# --- queue maintenance (callers hold the lock) ------------------------------------------
def _renumber(root, worker, metas):
    """Rewrite queue_order/queue_position 1..n for one worker's queue."""
    rows = queued_jobs(root, worker, metas)
    blockers = active_jobs(root, worker, metas)
    blocker = blockers[0]["id"] if blockers else None
    for index, meta in enumerate(rows, 1):
        changed = meta.get("queue_position") != index or meta.get("queue_order") != index
        if not changed:
            continue
        job_dir = _jobs_dir(root) / meta["id"]
        fresh = _read_json(job_dir / "meta.json")
        if not isinstance(fresh, dict) or fresh.get("state") != QUEUED:
            continue
        fresh["queue_order"] = index
        fresh["queue_position"] = index
        fresh["last_event"] = (f"queued #{index} for {worker}" +
                               (f" behind {blocker}" if blocker else ""))
        _write_meta(job_dir, fresh)
        meta.update(queue_order=index, queue_position=index)
    return rows


def _dispatch_job(root, meta, spawn):
    job_dir = _jobs_dir(root) / meta["id"]
    fresh = _read_json(job_dir / "meta.json")
    if not isinstance(fresh, dict) or fresh.get("state") != QUEUED or (job_dir / "DONE").exists():
        return None
    if (job_dir / "CANCEL").exists():
        _finish(job_dir, fresh, "cancelled", "cancelled", "cancelled while queued")
        return {"job_id": meta["id"], "worker": fresh.get("worker"), "action": "cancelled"}
    now = time.time()
    provider = fresh.get("provider")
    waited = int(now - float(fresh.get("queued_at") or fresh.get("created") or now))
    common = dict(queue_position=None, dispatched_at=now, queue_wait_s=waited)
    if provider in DESKTOP_PROVIDERS:
        fresh.update(state="waiting_for_desktop", last_event="queued for embedded ChatGPT", runner_pid=None,
                     **common)
        _write_meta(job_dir, fresh)
        _append_event(job_dir, "info", f"dispatched from queue after {waited} s; waiting for TEAMYRA Desktop")
        return {"job_id": meta["id"], "worker": fresh.get("worker"), "action": "waiting_for_desktop"}
    # Mark the job as started before spawning, under the lock, so no other
    # dispatcher can see the worker as free or the job as still queued.
    fresh.update(state="starting", last_event="dispatched from queue", **common)
    _write_meta(job_dir, fresh)
    _append_event(job_dir, "info", f"dispatched from queue after {waited} s")
    try:
        pid = spawn(job_dir, fresh)
    except Exception as exc:
        _finish(job_dir, fresh, "failed", "dispatch_error", f"dispatch failed: {exc}")
        return {"job_id": meta["id"], "worker": fresh.get("worker"), "action": "dispatch_error", "error": str(exc)}
    try:
        current = _read_json(job_dir / "meta.json") or fresh
        if not current.get("runner_pid"):
            current["runner_pid"] = pid
            _write_meta(job_dir, current)
    except Exception:
        pass
    return {"job_id": meta["id"], "worker": fresh.get("worker"), "action": "spawned", "runner_pid": pid}


def dispatch_once(root, bridge=None, python_exe=None, spawn=None, is_ready=None, workers=None,
                  lock_timeout=LOCK_WAIT_SECONDS, registry=None):
    """Start the oldest queued job of every free worker. Safe to call concurrently."""
    root = Path(root)
    report = {"dispatched": [], "waiting": [], "skipped": None}
    if not _jobs_dir(root).exists():
        return report
    spawn = spawn or default_spawn(bridge, python_exe)
    lock = SchedulerLock(root, lock_timeout)
    if not lock.acquire():
        report["skipped"] = "locked"
        return report
    try:
        metas = load_jobs(root)
        registry = build_worker_registry(root) if registry is None else registry
        names = sorted({m.get("worker") for m in metas if is_queued(m) and m.get("worker")} |
                       {w for w, info in registry.items() if info.get("enabled", True)})
        if workers is not None:
            wanted = set(workers)
            names = [w for w in names if w in wanted]
        # Give idle owners their own work before offering spare capacity to
        # other queues. Busy/not-ready owners leave their jobs in the pool.
        names.sort(key=lambda w: (not queued_jobs(root, w, metas), w))
        for worker in names:
            rows = queued_jobs(root, worker, metas)
            info = registry.get(worker) or {}
            borrowed = False
            if not rows:
                # Own queues take precedence. Across queues, creation time is
                # comparable; queue_order is only meaningful within one worker.
                rows = [m for m in metas if is_queued(m) and m.get("worker") != worker
                        and m.get("provider") == info.get("provider") and not m.get("pin")
                        and (m.get("provider") == "chatgpt-web" or m.get("pool") is True)
                        and registry.get(m.get("worker"), {}).get("provider") == info.get("provider")]
                rows.sort(key=lambda m: (float(m.get("queued_at") or m.get("created") or 0),
                                         str(m.get("id"))))
                borrowed = True
                if not rows:
                    continue
            reason = None
            if worker_busy(root, worker, metas):
                reason = "busy"
            elif cooldown_left(root, worker, metas):
                reason = "cooldown"
            elif is_ready is not None:
                try:
                    if not is_ready(worker):
                        reason = "not_ready"
                except Exception:
                    reason = "not_ready"
            elif borrowed:
                if info.get("provider") == "chatgpt-web" and not chatgpt_ready(root, info):
                    reason = "not_ready"
            if reason is None:
                if borrowed:
                    old_worker = rows[0]["worker"]
                    if not _reassign_job(root, rows[0], worker, info):
                        continue
                    _renumber(root, old_worker, load_jobs(root))
                result = _dispatch_job(root, rows[0], spawn)
                if result:
                    report["dispatched"].append(result)
                    metas = load_jobs(root)
                    if result["action"] == "cancelled":
                        # The worker is still free; try the next queued job.
                        rest = queued_jobs(root, worker, metas)
                        if rest:
                            again = _dispatch_job(root, rest[0], spawn)
                            if again:
                                report["dispatched"].append(again)
                                metas = load_jobs(root)
            else:
                report["waiting"].append({"worker": worker, "reason": reason, "queued": len(rows)})
            _renumber(root, worker, metas)
        return report
    finally:
        lock.release()


# --- queue operations ---------------------------------------------------------------
def enqueue(root, job_id, worker):
    """Mark a freshly created job as queued at the end of its worker's queue."""
    with SchedulerLock(root):
        metas = load_jobs(root)
        rows = queued_jobs(root, worker, metas)
        order = max([queue_key(m)[0] for m in rows] + [0]) + 1
        now = time.time()
        meta = patch_meta(root, job_id, state=QUEUED, queued_at=now, queue_order=order,
                          queue_position=len(rows) + 1, runner_pid=None,
                          last_event=f"queued #{len(rows) + 1} for {worker}")
        return meta


def queue_list(root, worker=None):
    metas = load_jobs(root)
    workers = sorted({m.get("worker") for m in metas if is_queued(m) and m.get("worker")})
    if worker:
        workers = [w for w in workers if w == worker] or [worker]
    out = []
    for name in workers:
        rows = queued_jobs(root, name, metas)
        active = active_jobs(root, name, metas)
        out.append({
            "worker": name,
            "current_job": ({k: active[0].get(k) for k in ("id", "label", "state", "last_event")}
                            if active else None),
            "queue": [{
                "job_id": m["id"], "label": m.get("label"), "position": index,
                "queued_at": m.get("queued_at") or m.get("created"),
                "wait_s": int(time.time() - float(m.get("queued_at") or m.get("created") or time.time())),
            } for index, m in enumerate(rows, 1)],
        })
    return {"workers": out, "total_queued": sum(len(item["queue"]) for item in out)}


def queue_cancel(root, job_id):
    if not _valid_job_id(job_id):
        raise ValueError(f"bad job id: {job_id}")
    with SchedulerLock(root):
        job_dir = _jobs_dir(root) / job_id
        meta = _read_json(job_dir / "meta.json")
        if not isinstance(meta, dict):
            raise ValueError(f"no such job: {job_id}")
        if meta.get("state") != QUEUED or (job_dir / "DONE").exists():
            raise ValueError(f"job {job_id} is not queued (state {meta.get('state')}); use job_cancel")
        _finish(job_dir, meta, "cancelled", "cancelled", "cancelled while queued")
        _renumber(root, meta.get("worker"), load_jobs(root))
    return {"ok": True, "job_id": job_id, "state": "cancelled"}


def queue_move(root, job_id, position):
    if not _valid_job_id(job_id):
        raise ValueError(f"bad job id: {job_id}")
    position = int(position)
    if position < 1:
        raise ValueError("position must be >= 1")
    with SchedulerLock(root):
        metas = load_jobs(root)
        target = next((m for m in metas if m.get("id") == job_id), None)
        if target is None:
            raise ValueError(f"no such job: {job_id}")
        if not is_queued(target):
            raise ValueError(f"job {job_id} is not queued (state {target.get('state')})")
        worker = target.get("worker")
        rows = [m for m in queued_jobs(root, worker, metas) if m["id"] != job_id]
        position = min(position, len(rows) + 1)
        rows.insert(position - 1, target)
        for index, meta in enumerate(rows, 1):
            meta["queue_order"] = index
            meta["queue_position"] = None  # force _renumber to rewrite every entry
        _renumber(root, worker, metas)
    return {"ok": True, "job_id": job_id, "worker": worker, "position": position,
            "queue": [m["id"] for m in rows]}


# --- background loop ------------------------------------------------------------------
_LOOP_STARTED = {}
_LOOP_GUARD = threading.Lock()


def start_background_dispatcher(root, bridge=None, python_exe=None, spawn=None, is_ready=None, interval=5.0):
    """Start one daemon thread per root that calls dispatch_once every ``interval`` seconds."""
    key = str(Path(root).resolve())
    with _LOOP_GUARD:
        if _LOOP_STARTED.get(key):
            return False
        stop = threading.Event()
        _LOOP_STARTED[key] = stop

    def loop():
        while not stop.is_set():
            try:
                dispatch_once(root, bridge, python_exe, spawn=spawn, is_ready=is_ready, lock_timeout=2)
            except Exception as exc:
                print("TEAMYRA scheduler error:", exc, file=sys.stderr, flush=True)
            stop.wait(max(0.5, float(interval)))

    threading.Thread(target=loop, daemon=True, name="teamyra-scheduler").start()
    return True


def stop_background_dispatcher(root):
    key = str(Path(root).resolve())
    with _LOOP_GUARD:
        stop = _LOOP_STARTED.pop(key, None)
    if stop:
        stop.set()
    return bool(stop)
