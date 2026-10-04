"""Crash/startup recovery for TEAMYRA persisted orchestration state."""
from __future__ import annotations

import ctypes
import json
import os
import subprocess
import sys
import time
from pathlib import Path

import media_engine


TERMINAL_GRAPH_STATES = {"done", "failed", "cancelled"}
TERMINAL_REVIEW_STATES = {"done", "failed", "cancelled", "exhausted", "interrupted"}
INTERNAL_PROCESS_MODES = {
    "runner.py": "__runner",
    "conductor_monitor.py": "__conductor-monitor",
    "review_monitor.py": "__review-monitor",
    "failover_monitor.py": "__failover-monitor",
}


def runtime_command(bridge, python_exe, script_name, *args):
    mode = INTERNAL_PROCESS_MODES.get(str(script_name))
    frozen_exe = os.environ.get("TEAMYRA_CORE_EXE")
    if mode and (frozen_exe or getattr(sys, "frozen", False)):
        return [str(frozen_exe or sys.executable), mode, *map(str, args)]
    return [str(python_exe), str(Path(bridge) / str(script_name)), *map(str, args)]


def process_alive(pid):
    try:
        pid = int(pid or 0)
    except Exception:
        return False
    if pid <= 0:
        return False
    if os.name == "nt":
        PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
        handle = ctypes.windll.kernel32.OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION, False, pid
        )
        if not handle:
            return False
        try:
            code = ctypes.c_ulong()
            if not ctypes.windll.kernel32.GetExitCodeProcess(handle, ctypes.byref(code)):
                return False
            return code.value == 259  # STILL_ACTIVE
        finally:
            ctypes.windll.kernel32.CloseHandle(handle)
    try:
        os.kill(pid, 0)
        return True
    except Exception:
        return False


def _recent(value, max_age=45):
    try:
        value = float(value or 0)
    except Exception:
        return False
    return value > 0 and time.time() - value <= max_age


def _read_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def _atomic_write(path, payload):
    path = Path(path)
    tmp = path.with_name(path.name + f".tmp-recovery-{os.getpid()}-{int(time.time()*1000)}")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, path)


def _spawn_detached(command, cwd, log_path):
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0) | getattr(
        subprocess, "CREATE_NEW_PROCESS_GROUP", 0
    )
    log = open(log_path, "a", encoding="utf-8")
    try:
        kwargs = dict(
            cwd=str(cwd),
            stdin=subprocess.DEVNULL,
            stdout=log,
            stderr=log,
            close_fds=True,
            creationflags=flags,
        )
        try:
            return subprocess.Popen(command, **{**kwargs, "creationflags": flags | 0x01000000})
        except OSError:
            return subprocess.Popen(command, **kwargs)
    finally:
        log.close()


def recover_job(root, bridge, python_exe, job_dir):
    job_dir = Path(job_dir)
    meta_path = job_dir / "meta.json"
    spec_path = job_dir / "spec.json"
    done_path = job_dir / "DONE"
    if done_path.exists() or not meta_path.exists() or not spec_path.exists():
        return {"kind": "job", "id": job_dir.name, "action": "unchanged"}

    meta = _read_json(meta_path)
    runner_pid = meta.get("runner_pid")
    worker_pid = meta.get("worker_pid")
    heartbeat = meta.get("heartbeat_at") or meta.get("updated")
    runner_is_alive = process_alive(runner_pid)
    if runner_is_alive and _recent(heartbeat):
        return {
            "kind": "job",
            "id": job_dir.name,
            "action": "alive",
            "runner_pid": runner_pid,
            "worker_pid": worker_pid,
            "heartbeat_at": heartbeat,
        }
    if runner_is_alive:
        return {
            "kind": "job",
            "id": job_dir.name,
            "action": "stale_pid_unverified",
            "runner_pid": runner_pid,
            "worker_pid": worker_pid,
            "heartbeat_at": heartbeat,
            "requires_manual_check": True,
        }

    spec = _read_json(spec_path)
    session_id = meta.get("session_id")
    resume_cmd = spec.get("resume_cmd")
    if session_id and isinstance(resume_cmd, list) and resume_cmd:
        spec["cmd"] = [session_id if part == "{SESSION}" else part for part in resume_cmd]
        spec["recovery_resume"] = True
        _atomic_write(spec_path, spec)
        meta["state"] = "starting"
        meta["reason"] = None
        meta["ended"] = None
        meta["runner_pid"] = None
        meta["worker_pid"] = None
        meta["recovery_requested"] = True
        meta["recovery_state"] = "starting"
        meta["recovery_count"] = int(meta.get("recovery_count") or 0) + 1
        meta["recovered_at"] = time.time()
        _atomic_write(meta_path, meta)
        proc = _spawn_detached(
            runtime_command(bridge, python_exe, "runner.py", job_dir),
            meta.get("cwd") or root,
            job_dir / "runner.log",
        )
        meta = _read_json(meta_path)
        meta["runner_pid"] = proc.pid
        _atomic_write(meta_path, meta)
        return {
            "kind": "job",
            "id": job_dir.name,
            "action": "resumed",
            "runner_pid": proc.pid,
            "session_id": session_id,
        }

    meta["state"] = "failed"
    meta["reason"] = "crash_recovery_session_missing"
    meta["ended"] = time.time()
    meta["runner_pid"] = None
    meta["worker_pid"] = None
    meta["recovery_state"] = "manual_retry_required"
    meta["recovery_error"] = (
        "TEAMYRA found this job without a live runner/worker after restart, "
        "but no resumable provider session was persisted. Original work was not blindly rerun."
    )
    _atomic_write(meta_path, meta)
    done_path.write_text("failed", encoding="utf-8")
    return {
        "kind": "job",
        "id": job_dir.name,
        "action": "manual_retry_required",
        "reason": meta["reason"],
    }


def recover_graph(root, bridge, python_exe, graph_path):
    graph_path = Path(graph_path)
    graph = _read_json(graph_path)
    graph_id = graph.get("id") or graph_path.stem
    if graph.get("state") in TERMINAL_GRAPH_STATES or graph.get("state") == "draft":
        return {"kind": "graph", "id": graph_id, "action": "unchanged"}
    conductor_alive = process_alive(graph.get("conductor_pid"))
    heartbeat = graph.get("conductor_heartbeat_at") or graph.get("updated_at")
    if conductor_alive and _recent(heartbeat):
        return {
            "kind": "graph", "id": graph_id, "action": "alive",
            "pid": graph.get("conductor_pid"),
        }
    if conductor_alive:
        return {
            "kind": "graph", "id": graph_id, "action": "stale_pid_unverified",
            "pid": graph.get("conductor_pid"), "requires_manual_check": True,
        }

    proc = _spawn_detached(
        runtime_command(bridge, python_exe, "conductor_monitor.py", graph_id),
        root,
        Path(root) / "tasks" / f"{graph_id}.conductor.log",
    )
    graph["conductor_pid"] = proc.pid
    graph["recovery_count"] = int(graph.get("recovery_count") or 0) + 1
    graph["recovered_at"] = time.time()
    graph["error"] = None
    _atomic_write(graph_path, graph)
    return {"kind": "graph", "id": graph_id, "action": "monitor_restarted", "pid": proc.pid}


def recover_review(root, review_path):
    review_path = Path(review_path)
    state = _read_json(review_path)
    review_id = state.get("id") or review_path.stem
    if state.get("state") in TERMINAL_REVIEW_STATES:
        return {"kind": "review", "id": review_id, "action": "unchanged"}
    monitor_alive = process_alive(state.get("monitor_pid"))
    heartbeat = state.get("monitor_heartbeat_at") or state.get("updated_at")
    if monitor_alive and _recent(heartbeat):
        return {
            "kind": "review", "id": review_id, "action": "alive",
            "pid": state.get("monitor_pid"),
        }
    if monitor_alive:
        return {
            "kind": "review", "id": review_id, "action": "stale_pid_unverified",
            "pid": state.get("monitor_pid"), "requires_manual_check": True,
        }

    # review_monitor is a multi-step state machine. Re-entering it at the top
    # can duplicate reviewer/fixer jobs. Preserve state and require an explicit
    # future resume implementation rather than silently repeating work.
    state["state"] = "interrupted"
    state["monitor_pid"] = None
    state["recovery_state"] = "manual_resume_required"
    state["recovery_error"] = (
        "Review monitor was not alive after restart. TEAMYRA preserved review state "
        "instead of spawning a duplicate reviewer/fixer loop."
    )
    state["updated_at"] = time.time()
    _atomic_write(review_path, state)
    return {
        "kind": "review",
        "id": review_id,
        "action": "manual_resume_required",
        "active_job_id": state.get("active_job_id"),
    }


def recover_failover_monitor(root, bridge, python_exe, meta_path):
    meta_path = Path(meta_path)
    meta = _read_json(meta_path)
    job_id = meta.get("id") or meta_path.parent.name
    if not meta.get("auto_failover_enabled") or meta.get("failover_complete"):
        return None
    failover_alive = process_alive(meta.get("failover_monitor_pid"))
    heartbeat = meta.get("failover_monitor_heartbeat_at") or meta.get("updated")
    if failover_alive and _recent(heartbeat):
        return {
            "kind": "failover", "id": job_id, "action": "alive",
            "pid": meta.get("failover_monitor_pid"),
        }
    if failover_alive:
        return {
            "kind": "failover", "id": job_id, "action": "stale_pid_unverified",
            "pid": meta.get("failover_monitor_pid"), "requires_manual_check": True,
        }
    max_failovers = max(0, min(int(meta.get("max_failovers") or 0), 5))
    if max_failovers <= 0:
        return None
    proc = _spawn_detached(
        runtime_command(bridge, python_exe, "failover_monitor.py", job_id, max_failovers),
        meta.get("cwd") or root,
        meta_path.parent / "failover-monitor.log",
    )
    meta = _read_json(meta_path)
    meta["failover_monitor_pid"] = proc.pid
    meta["failover_monitor_recovered_at"] = time.time()
    _atomic_write(meta_path, meta)
    return {"kind": "failover", "id": job_id, "action": "monitor_restarted", "pid": proc.pid}


def recover_all(root, bridge, python_exe):
    root = Path(root)
    report = {
        "started_at": time.time(),
        "jobs": [],
        "graphs": [],
        "reviews": [],
        "failovers": [],
        "media": [],
        "errors": [],
    }

    jobs_dir = root / "jobs"
    if jobs_dir.exists():
        for job_dir in sorted(jobs_dir.iterdir()):
            if not job_dir.is_dir() or not (job_dir / "meta.json").exists():
                continue
            try:
                report["jobs"].append(recover_job(root, bridge, python_exe, job_dir))
            except Exception as exc:
                report["errors"].append({"kind": "job", "id": job_dir.name, "error": str(exc)})

    tasks_dir = root / "tasks"
    if tasks_dir.exists():
        for graph_path in sorted(tasks_dir.glob("graph-*.json")):
            try:
                report["graphs"].append(recover_graph(root, bridge, python_exe, graph_path))
            except Exception as exc:
                report["errors"].append({"kind": "graph", "id": graph_path.stem, "error": str(exc)})

        reviews_dir = tasks_dir / "reviews"
        if reviews_dir.exists():
            for review_path in sorted(reviews_dir.glob("review-*.json")):
                try:
                    report["reviews"].append(recover_review(root, review_path))
                except Exception as exc:
                    report["errors"].append({"kind": "review", "id": review_path.stem, "error": str(exc)})

    # Failover monitors are repaired after jobs so root/terminal job state has
    # already been reconciled.
    if jobs_dir.exists():
        for job_dir in sorted(jobs_dir.iterdir()):
            meta_path = job_dir / "meta.json"
            if not meta_path.exists():
                continue
            try:
                item = recover_failover_monitor(root, bridge, python_exe, meta_path)
                if item:
                    report["failovers"].append(item)
            except Exception as exc:
                report["errors"].append({"kind": "failover", "id": job_dir.name, "error": str(exc)})

    try:
        media_report = media_engine.recover_incomplete_jobs(root)
        for job_id in media_report.get("requeued", []):
            report["media"].append({"kind": "media", "id": job_id, "action": "requeued"})
        for job_id in media_report.get("reconcile_required", []):
            report["media"].append({"kind": "media", "id": job_id, "action": "reconcile_required"})
        for error in media_report.get("errors", []):
            report["errors"].append({"kind": "media", **error})
    except Exception as exc:
        report["errors"].append({"kind": "media", "id": "media", "error": str(exc)})

    report["ended_at"] = time.time()
    report["ok"] = not report["errors"]
    report["actions"] = {
        key: sum(1 for item in report[key] if item.get("action") not in {"unchanged", "alive"})
        for key in ("jobs", "graphs", "reviews", "failovers", "media")
    }
    return report
