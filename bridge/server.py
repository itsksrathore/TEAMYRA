"""ai-workers MCP bridge, v2: asynchronous worker jobs with live transcripts.

Every task runs as a job in D:/AI-Orchestrator/jobs/<job_id>/, executed by runner.py
in its own process, so a bridge restart or an MCP timeout never stops a worker.
Claude starts jobs, follows them (follow.py as a background task, or the dashboard),
reads compact results, sends follow-up messages and cancels them.
"""
import json, os, subprocess, sys, threading, time, uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from worker_registry import build_worker_registry
from runtime_paths import codex_launch, agy_launch, claude_launch
import task_graph
import test_policy
import review_cycle
import worktree_manager
import workspace_tools
import observability
import project_memory
import handoff_store
import mcp_pool
import recovery
import scheduler
import media_engine
import media_support
import codex_images
import media_guide
import desktop_runtime
from expected_outputs import validate_expect_files

sys.stdin.reconfigure(encoding="utf-8")
sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")

BRIDGE = Path(__file__).resolve().parent
ROOT = Path(os.environ.get("TEAMYRA_ROOT") or BRIDGE.parent).resolve()
JOBS = ROOT / "jobs"
LOGS = ROOT / "logs"
WORKTREES = ROOT / "worktrees"
CONFIG = BRIDGE / "config.json"
COOLDOWN_FILE = JOBS / "_cooldown_cleared.json"
PYTHON = Path(sys.executable)
COOLDOWN_SECONDS = 1800
FAILOVER_REASONS = {"usage_or_rate_limit", "worker_error", "runner_crash", "worker_reported_error"}
# Sent when runner.py auto-resumes a worker session that died mid-run.
RESUME_MESSAGE = ("Your previous run on this task was interrupted: the worker process exited unexpectedly. "
                  "Check git status, git log and your last steps, then continue the same task from where you "
                  "stopped. Do not redo finished work, and finish everything the original task asked for.")
SEND_LOCK = threading.Lock()
AUTH_CACHE = {}
AUTH_CACHE_SECONDS = 20
# A CLI worker that answered "ready" stays ready for this long when later probes
# only time out, so one slow probe (agy models often takes >8 s) cannot flip it.
AUTH_LAST_GOOD_SECONDS = 600
AUTH_PROBE_TIMEOUTS = {"codex": 8, "claude": 8, "antigravity": 30}
AUTH_REFRESH_SECONDS = 60
CLI_PROVIDERS = {"codex", "claude", "antigravity"}
_AUTH_LOCK = threading.Lock()
_AUTH_INFLIGHT = set()
_BACKGROUND_STARTED = threading.Event()
for p in (JOBS, LOGS, WORKTREES):
    p.mkdir(parents=True, exist_ok=True)


# --- helpers --------------------------------------------------------------------------
def config():
    try:
        return json.loads(CONFIG.read_text(encoding="utf-8"))
    except Exception:
        return {}


def clip(text, n):
    text = (text or "").strip()
    return text if len(text) <= n else text[: n - 15] + " ...[clipped]"


def worker_registry():
    return build_worker_registry(ROOT)


def worker_ids():
    return tuple(worker_registry().keys())


INTERNAL_PROCESS_MODES = {
    "runner.py": "__runner",
    "conductor_monitor.py": "__conductor-monitor",
    "review_monitor.py": "__review-monitor",
    "failover_monitor.py": "__failover-monitor",
    "follow.py": "__follow",
}


def bridge_process_command(script_name, *args):
    mode = INTERNAL_PROCESS_MODES.get(str(script_name))
    frozen_exe = os.environ.get("TEAMYRA_CORE_EXE")
    if mode and (frozen_exe or getattr(sys, "frozen", False)):
        return [str(frozen_exe or sys.executable), mode, *map(str, args)]
    return [str(PYTHON), str(BRIDGE / str(script_name)), *map(str, args)]


def run(cmd, cwd=None, env=None, timeout=60):
    merged = os.environ.copy()
    merged.update(env or {})
    cp = subprocess.run(cmd, cwd=cwd, env=merged, text=True, stdin=subprocess.DEVNULL,
                        capture_output=True, timeout=timeout, encoding="utf-8", errors="replace",
                        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    return cp.returncode, cp.stdout or "", cp.stderr or ""


def worker_settings(info):
    merged = dict(config().get(info["provider"], {}))
    merged.update(info.get("settings") or {})
    return merged


def _probe_worker_auth(info, now):
    """One readiness probe. Returns (ready, detail, transient)."""
    provider = info["provider"]
    timeout = AUTH_PROBE_TIMEOUTS.get(provider, 8)
    try:
        if provider == "codex":
            launch = codex_launch()
            if not launch:
                raise RuntimeError("Codex CLI not found")
            rc, out, err = run([*launch, "login", "status"],
                                env={"CODEX_HOME": str(info["home"])}, timeout=timeout)
            detail = (out + err).strip()
            ready = rc == 0 and "not logged in" not in detail.lower()
        elif provider == "claude":
            launch = claude_launch()
            if not launch:
                raise RuntimeError("Claude Code CLI not found")
            env = {}
            if not info.get("native"):
                env["CLAUDE_CONFIG_DIR"] = str(info["home"])
            rc, out, err = run([*launch, "auth", "status", "--json"], env=env, timeout=timeout)
            detail = (out + err).strip()
            ready = rc == 0
        elif provider == "antigravity":
            launch = agy_launch()
            if not launch:
                raise RuntimeError("Antigravity CLI not found")
            rc, out, err = run([*launch, "models"], timeout=timeout)
            detail = (out + err).strip()
            ready = rc == 0 and bool(out.strip())
        elif provider == "chatgpt-web":
            status_file = ROOT / "chatgpt" / "status.json"
            try:
                status = json.loads(status_file.read_text(encoding="utf-8"))
            except Exception:
                status = {}
            age = now - float(status.get("heartbeat_at") or 0)
            profile_id = str(info.get("profile_id") or "web")
            profile_status = (status.get("profiles") or {}).get(profile_id) or {}
            if profile_id == str(status.get("active_profile_id") or "web"):
                profile_ready = (
                    status.get("worker_ready") is True or
                    profile_status.get("automation_ready") is True or
                    profile_status.get("session_present") is True
                )
                profile_detail = status.get("detail") or profile_status.get("detail")
            else:
                profile_ready = (
                    profile_status.get("automation_ready") is True or
                    profile_status.get("session_present") is True
                )
                profile_detail = profile_status.get("detail")
            ready = age <= 20 and profile_ready
            detail = str(profile_detail or (
                "embedded ChatGPT session ready" if ready else "open this ChatGPT account in TEAMYRA and sign in"
            ))
        else:
            ready, detail = False, "unsupported provider"
        return ready, detail, False
    except subprocess.TimeoutExpired:
        return False, f"{provider} readiness probe timed out after {timeout} s", True
    except Exception as exc:
        return False, str(exc), False


def _store_auth(info, ready, detail, transient, now):
    worker = info["id"]
    previous = AUTH_CACHE.get(worker) or {}
    last_good = previous.get("last_good_at") or 0
    if (not ready and transient and previous.get("ready")
            and now - float(last_good) <= AUTH_LAST_GOOD_SECONDS):
        # Keep the last known good answer; record why it was not refreshed.
        entry = dict(previous, at=now, probe_error=detail, source="last_known_good")
    else:
        entry = {"at": now, "ready": ready, "detail": detail, "source": "probe",
                 "probe_error": detail if transient else None,
                 "last_good_at": now if ready else last_good}
    AUTH_CACHE[worker] = entry
    return entry


def _refresh_auth_async(info):
    worker = info["id"]
    with _AUTH_LOCK:
        if worker in _AUTH_INFLIGHT:
            return False
        _AUTH_INFLIGHT.add(worker)

    def task():
        try:
            worker_auth_status(info, use_cache=False)
        finally:
            with _AUTH_LOCK:
                _AUTH_INFLIGHT.discard(worker)

    threading.Thread(target=task, daemon=True, name=f"teamyra-auth-{worker}").start()
    return True


def worker_auth_status(info, use_cache=True):
    worker = info["id"]
    now = time.time()
    cached = AUTH_CACHE.get(worker)
    if use_cache and cached:
        age = now - cached["at"]
        if age < AUTH_CACHE_SECONDS:
            return cached["ready"], cached["detail"]
        if info.get("provider") in CLI_PROVIDERS and age < AUTH_LAST_GOOD_SECONDS:
            # Serve the cached answer at once and refresh it in the background.
            _refresh_auth_async(info)
            return cached["ready"], cached["detail"]
    ready, detail, transient = _probe_worker_auth(info, now)
    entry = _store_auth(info, ready, detail, transient, now)
    return entry["ready"], entry["detail"]


def auth_snapshot(worker):
    """Cached readiness entry (no probing), or None."""
    entry = AUTH_CACHE.get(worker)
    return dict(entry) if entry else None


def refresh_worker_auth_all():
    """Probe every CLI worker in parallel (background refresher)."""
    items = [info for info in worker_registry().values() if info.get("provider") in CLI_PROVIDERS]
    if not items:
        return 0
    with ThreadPoolExecutor(max_workers=min(8, len(items))) as pool:
        list(pool.map(lambda info: worker_auth_status(info, use_cache=False), items))
    return len(items)


def scheduler_worker_ready(worker):
    """Dispatch gate for the background scheduler: never probes, never blocks."""
    info = worker_registry().get(worker) or {}
    if info.get("provider") == "chatgpt-web":
        return scheduler.chatgpt_ready(jobs_root(), info)
    entry = AUTH_CACHE.get(worker)
    if not entry:
        return True
    return bool(entry.get("ready"))


def start_background_services(scheduler_interval=5.0, auth_interval=AUTH_REFRESH_SECONDS):
    """Start the queue dispatcher and the readiness refresher once per process."""
    if _BACKGROUND_STARTED.is_set():
        return False
    _BACKGROUND_STARTED.set()
    scheduler.start_background_dispatcher(
        jobs_root(), BRIDGE, PYTHON, spawn=scheduler_spawn, is_ready=scheduler_worker_ready,
        interval=scheduler_interval,
    )

    def auth_loop():
        while True:
            try:
                refresh_worker_auth_all()
            except Exception as exc:
                print("TEAMYRA readiness refresh error:", exc, file=sys.stderr, flush=True)
            time.sleep(max(10, int(auth_interval)))

    threading.Thread(target=auth_loop, daemon=True, name="teamyra-auth-refresh").start()
    return True


def git(cwd, *args):
    try:
        rc, out, _ = run(["git", "-C", str(cwd), *args], timeout=30)
        return out.strip() if rc == 0 else None
    except Exception:
        return None


def read_meta(job_id):
    if not job_id or any(c in job_id for c in "/\\") or ".." in job_id:
        raise ValueError(f"bad job id: {job_id}")
    path = JOBS / job_id / "meta.json"
    if not path.exists():
        raise ValueError(f"no such job: {job_id}")
    for _ in range(5):  # the runner replaces meta.json atomically; retry a torn read
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except ValueError:
            time.sleep(0.1)
    return json.loads(path.read_text(encoding="utf-8"))


def patch_job_meta(job_id, **changes):
    path = JOBS / job_id / "meta.json"
    meta = read_meta(job_id)
    meta.update(changes)
    meta["updated"] = time.time()
    tmp = path.with_name(path.name + f".tmp-{os.getpid()}-{uuid.uuid4().hex[:6]}")
    tmp.write_text(json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8")
    for attempt in range(20):
        try:
            os.replace(tmp, path)
            break
        except PermissionError:  # Windows readers/writers may briefly hold meta.json
            if attempt == 19:
                try:
                    tmp.unlink()
                except OSError:
                    pass
                raise
            time.sleep(0.05)
    return meta


def failover_eligible(meta):
    return meta.get("state") == "failed" and meta.get("reason") in FAILOVER_REASONS


def failover_chain(job_id):
    first = read_meta(job_id)
    root = first.get("failover_root") or first["id"]
    chain = []
    current = root
    seen = set()
    while current and current not in seen:
        seen.add(current)
        meta = read_meta(current)
        chain.append(meta)
        current = meta.get("failover_job_id")
    return chain


def failover_terminal_job_id(job_id):
    return failover_chain(job_id)[-1]["id"]


def chain_is_complete(job_id):
    chain = failover_chain(job_id)
    terminal = chain[-1]
    root = chain[0]
    if not is_done(terminal["id"]):
        return False
    if root.get("auto_failover_enabled") and not root.get("failover_complete"):
        return False
    return True


def all_jobs():
    out = []
    for d in JOBS.iterdir():
        if d.is_dir() and (d / "meta.json").exists():
            try:
                out.append(read_meta(d.name))
            except Exception:
                pass
    return sorted(out, key=lambda m: m.get("created", 0), reverse=True)


def is_done(job_id):
    return (JOBS / job_id / "DONE").exists()


def running_jobs(worker=None):
    return [m for m in all_jobs() if not is_done(m["id"]) and (worker is None or m["worker"] == worker)]


def cooldown_left(worker):
    try:
        cleared = json.loads(COOLDOWN_FILE.read_text(encoding="utf-8")).get(worker, 0)
    except Exception:
        cleared = 0
    for m in all_jobs():
        if m["worker"] == worker and m.get("reason") == "usage_or_rate_limit":
            ended = m.get("ended") or 0
            if ended > cleared:
                return max(0, int(ended + COOLDOWN_SECONDS - time.time()))
            break
    return 0


# --- commands -------------------------------------------------------------------------------
TEAMYRA_MCP_URL = os.environ.get("TEAMYRA_MCP_URL", "http://127.0.0.1:8787/mcp")
LONG_TASK_CHARS = 12000


def codex_cmd(task, cwd, write, final_path, session_id=None, settings=None, extra_config=None, skip_git_check=False):
    c = settings or config().get("codex", {})
    launch = codex_launch()
    if not launch:
        raise RuntimeError("Codex CLI not found. Install Codex or set TEAMYRA_CODEX / TEAMYRA_CODEX_JS.")
    base = [*launch,
            "-c", f'model="{c.get("model", "gpt-6.1-sol")}"',
            "-c", f'model_reasoning_effort="{c.get("effort", "high")}"']
    for item in extra_config or []:
        base += ["-c", item]
    if session_id:  # resume has no --approve-for-me / -C: pass the same settings as config
        policy = (["-c", 'approval_policy="on-request"', "-c", 'approvals_reviewer="auto_review"',
                   "-c", 'sandbox_mode="workspace-write"'] if write else ["-c", 'sandbox_mode="read-only"'])
        # Media helpers work in plain project folders, which are not Git repositories.
        skip = ["--skip-git-repo-check"] if skip_git_check else []
        return base + policy + ["exec", "resume", *skip, "--json", "-o", str(final_path), session_id, task]
    mode = ["--approve-for-me"] if write else ["--sandbox", "read-only"]
    skip = ["--skip-git-repo-check"] if skip_git_check else []
    return base + ["exec", *skip, "--json", *mode, "-C", str(cwd), "-o", str(final_path), task]


def claude_cmd(task, cwd, write, session_id=None, settings=None):
    c = settings or config().get("claude", {})
    launch = claude_launch()
    if not launch:
        raise RuntimeError("Claude Code CLI not found. Install Claude Code or set TEAMYRA_CLAUDE.")
    permission_mode = c.get("permission_mode", "auto") if write else "plan"
    cmd = [*launch, "-p", "--output-format", "stream-json", "--verbose",
           "--permission-mode", permission_mode]
    model = c.get("model")
    effort = c.get("effort")
    if model:
        cmd += ["--model", str(model)]
    if effort:
        cmd += ["--effort", str(effort)]
    if session_id:
        cmd += ["--resume", session_id]
    cmd.append(task)
    return cmd


def agy_cmd(task, cwd, write, timeout, session_id=None):
    a = config().get("antigravity", {})
    launch = agy_launch()
    if not launch:
        raise RuntimeError("Antigravity CLI not found. Install agy or set TEAMYRA_AGY.")
    cmd = list(launch)
    if session_id:
        cmd += ["--conversation", session_id]
    cmd += ["-p", task, "--output-format", "stream-json",
            "--model", a.get("model", "gemini-3.1-pro-high"),
            "--mode", a.get("mode", "accept-edits") if write else "plan",
            "--print-timeout", f"{int(timeout)}s", "--add-dir", str(cwd)]
    if a.get("sandbox", True):
        cmd.append("--sandbox")
    return cmd


def helper_worker_order(registry=None):
    """Media helpers: Codex 1, Codex 2, Antigravity; Claude only as the last resort."""
    registry = registry or worker_registry()
    preferred = [w for w in media_support.HELPER_ORDER if w in registry]
    claude = sorted(w for w, info in registry.items() if info.get("provider") == "claude")
    return preferred + claude


def helper_last_resort(order):
    if not order:
        return None
    registry = worker_registry()
    return [w for w in order if (registry.get(w) or {}).get("provider") == "claude"]


def pick_worker(worker, exclude=None, order=None, last_resort=None):
    registry = worker_registry()
    exclude = set(exclude or [])
    if worker != "auto":
        return worker

    if order:
        # An explicit order is a closed list: nothing outside it is tried.
        configured = [w for w in order if w in registry and w not in exclude]
        discovered = []
    else:
        configured = [w for w in config().get("auto_order", [])
                      if w in registry and w not in exclude and registry[w].get("enabled", True)]
        discovered = sorted(
            (w for w in registry if w not in configured and w not in exclude and registry[w].get("enabled", True)),
            key=lambda w: (registry[w].get("priority", 100), w),
        )
    order = configured + discovered
    if not order:
        raise ValueError("no enabled workers are configured or discovered")

    free = [w for w in order if not cooldown_left(w)]
    idle = [w for w in free if not running_jobs(w)]
    # Busy workers last, the shortest queue first (a stable sort keeps the configured order).
    busy = sorted((w for w in free if w not in idle), key=lambda w: len(running_jobs(w)))
    candidates = idle + busy
    if last_resort:
        # Last-resort workers (Claude for media helpers) only when no other one
        # is free of usage limits and signed in, even if the others are busy.
        last = set(last_resort)
        candidates = [w for w in candidates if w not in last] + [w for w in candidates if w in last]
    for candidate in candidates:
        ready, _ = worker_auth_status(registry[candidate])
        if ready:
            return candidate
    raise ValueError("no authenticated worker is currently ready")


def spawn_runner(jdir, cwd):
    """Start runner.py for one job directory, detached from this process; returns its pid."""
    jdir = Path(jdir)
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0) | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
    log = open(jdir / "runner.log", "a", encoding="utf-8")
    try:  # break away from the MCP server's job object so a bridge restart does not kill the job
        try:
            runner_proc = subprocess.Popen(bridge_process_command("runner.py", jdir), cwd=str(cwd),
                                           stdin=subprocess.DEVNULL, stdout=log, stderr=log, close_fds=True,
                                           creationflags=flags | 0x01000000)
        except OSError:
            runner_proc = subprocess.Popen(bridge_process_command("runner.py", jdir), cwd=str(cwd),
                                           stdin=subprocess.DEVNULL, stdout=log, stderr=log, close_fds=True,
                                           creationflags=flags)
    finally:
        log.close()
    return runner_proc.pid


def jobs_root():
    """Runtime root that holds JOBS (ROOT in production; follows a patched JOBS in tests)."""
    return JOBS.parent


def scheduler_spawn(job_dir, meta):
    return spawn_runner(job_dir, meta.get("cwd") or job_dir)


def dispatch_queue(workers=None):
    """Start the oldest queued job of every free worker (see scheduler.dispatch_once)."""
    return scheduler.dispatch_once(jobs_root(), BRIDGE, PYTHON, spawn=scheduler_spawn,
                                   is_ready=scheduler_worker_ready, workers=workers, registry=worker_registry())


def start_job(worker, task, project_path, label=None, timeout_minutes=90, write=True,
              session_id=None, parent=None, auto_failover=False, max_failovers=None,
              failover_attempt=0, failover_root=None, previous_workers=None, start_monitor=True,
              queue=False, pin=False, pool=False, expect_files=None, worker_order=None, teamyra_mcp=False):
    cwd = Path(project_path).resolve()
    if not cwd.exists():
        raise ValueError(f"project_path not found: {cwd}")
    expect_files = validate_expect_files(cwd, expect_files)
    requested_worker = worker
    worker = pick_worker(worker, order=worker_order, last_resort=helper_last_resort(worker_order))
    registry = worker_registry()
    if worker not in registry:
        raise ValueError(f"unknown worker: {worker}")
    worker_info = registry[worker]
    provider = worker_info["provider"]
    # ChatGPT web workers use the task's project_path as their assigned workspace.
    # The desktop bridge validates that path and sandboxes every tool call to it.
    # enabled controls automatic routing only; explicit/manual worker selection remains allowed.
    ready, auth_detail = worker_auth_status(worker_info)
    if not ready:
        raise ValueError(f"{worker} is not authenticated/ready: {clip(auth_detail, 300)}")
    settings = worker_settings(worker_info)
    left = cooldown_left(worker)
    if left:
        raise ValueError(f"{worker} is cooling down after a usage limit ({left} s left); "
                         "use another worker or clear_worker_cooldown")
    timeout = max(60, min(int(timeout_minutes * 60), 6 * 3600))
    job_id = time.strftime("%m%d-%H%M%S") + "-" + worker + "-" + uuid.uuid4().hex[:4]
    jdir = JOBS / job_id
    jdir.mkdir()
    final_path = jdir / "final.txt"
    full_task = task
    if len(task) > LONG_TASK_CHARS:
        # Windows caps a command line at 32,767 characters; long tasks travel as a file.
        task = (f"Your complete task is in the file {jdir / 'task.txt'} ({len(full_task)} characters). "
                "Read the whole file first, then carry out that task exactly.")
    if provider == "codex":
        extra = [f'mcp_servers.teamyra.url="{TEAMYRA_MCP_URL}"'] if teamyra_mcp else None
        cmd = codex_cmd(task, cwd, write, final_path, session_id, settings, extra, skip_git_check=teamyra_mcp)
        env = {"CODEX_HOME": str(worker_info["home"])}
        resume_cmd = codex_cmd(RESUME_MESSAGE, cwd, write, final_path, "{SESSION}", settings, extra,
                               skip_git_check=teamyra_mcp)
    elif provider == "claude":
        cmd = claude_cmd(task, cwd, write, session_id, settings)
        env = {}
        if not worker_info.get("native"):
            env["CLAUDE_CONFIG_DIR"] = str(worker_info["home"])
        resume_cmd = claude_cmd(RESUME_MESSAGE, cwd, write, "{SESSION}", settings)
    elif provider == "antigravity":
        cmd, env = agy_cmd(task, cwd, write, timeout, session_id), {}
        resume_cmd = agy_cmd(RESUME_MESSAGE, cwd, write, timeout, "{SESSION}")
    elif provider == "chatgpt-web":
        cmd, env, resume_cmd = [], {}, []
    else:
        raise ValueError(f"unsupported worker provider: {provider}")
    head = git(cwd, "rev-parse", "HEAD")
    root_id = failover_root or job_id
    max_failovers = int(config().get("max_failovers", 2) if max_failovers is None else max_failovers)
    max_failovers = max(0, min(max_failovers, 5))
    meta = {"id": job_id, "label": label or clip(task.splitlines()[0] if task else job_id, 80),
            "worker": worker, "provider": provider, "worker_label": worker_info.get("label"),
            "profile_id": worker_info.get("profile_id"), "state": "starting", "cwd": str(cwd), "write": write,
            "created": time.time(), "head_start": head, "branch": git(cwd, "rev-parse", "--abbrev-ref", "HEAD"),
            "parent": parent, "resumed_session": session_id, "timeout_s": timeout,
            "failover_root": root_id, "failover_attempt": int(failover_attempt),
            "previous_workers": list(previous_workers or []),
            "auto_failover_enabled": bool(auto_failover), "max_failovers": max_failovers,
            "pin": bool(pin), "pool": bool(pool), "expect_files": expect_files,
            "worker_order": list(worker_order or []), "teamyra_mcp": bool(teamyra_mcp)}
    (jdir / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8")
    (jdir / "task.txt").write_text(full_task, encoding="utf-8")
    (jdir / "spec.json").write_text(json.dumps({"worker": worker, "provider": provider, "cmd": cmd, "cwd": str(cwd), "env": env,
                                                 "profile_id": worker_info.get("profile_id"), "write": write,
                                                 "pin": bool(pin), "pool": bool(pool), "expect_files": expect_files,
                                                 "timeout": timeout, "final_path": str(final_path),
                                                 "session_id": session_id,
                                                 "resume_cmd": resume_cmd,
                                                 "auto_resume": int(config().get("auto_resume", 2))},
                                                ensure_ascii=False, indent=1), encoding="utf-8")
    (jdir / "transcript.md").write_text(f"# {meta['label']}\n{worker} | {cwd} | {meta['branch']} @ {head}\n\n",
                                        encoding="utf-8")
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0) | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
    if queue:
        # FIFO per worker: the job waits as `queued` until its worker is free.
        # dispatch_once decides under the scheduler lock, so concurrent callers
        # never start two jobs on one worker or one job twice.
        scheduler.enqueue(jobs_root(), job_id, worker)
        try:
            dispatch_queue()
        except Exception as exc:
            print("TEAMYRA dispatch error:", exc, file=sys.stderr, flush=True)
    elif provider == "chatgpt-web":
        patch_job_meta(
            job_id,
            state="waiting_for_desktop",
            last_event="queued for embedded ChatGPT",
            runner_pid=None,
        )
    else:
        patch_job_meta(job_id, runner_pid=spawn_runner(jdir, cwd))

    if auto_failover and start_monitor and max_failovers > 0:
        monitor_log = open(jdir / "failover-monitor.log", "a", encoding="utf-8")
        monitor_cmd = bridge_process_command("failover_monitor.py", job_id, max_failovers)
        try:
            try:
                failover_proc = subprocess.Popen(monitor_cmd, cwd=str(cwd), stdin=subprocess.DEVNULL,
                                                 stdout=monitor_log, stderr=monitor_log, close_fds=True,
                                                 creationflags=flags | 0x01000000)
            except OSError:
                failover_proc = subprocess.Popen(monitor_cmd, cwd=str(cwd), stdin=subprocess.DEVNULL,
                                                 stdout=monitor_log, stderr=monitor_log, close_fds=True,
                                                 creationflags=flags)
            patch_job_meta(job_id, failover_monitor_pid=failover_proc.pid)
        finally:
            monitor_log.close()
    return job_id, read_meta(job_id).get("worker", worker)


def failover_task(meta, original_task):
    return (
        "TEAMYRA failover continuation. The previous worker "
        f"{meta.get('worker')} failed with reason {meta.get('reason')}. "
        "Work in the same folder. Inspect git status, git diff, existing files, logs and partial work first. "
        "Preserve correct completed work, repair or continue what is incomplete, and do not redo finished steps. "
        "Then complete the original task below.\n\nORIGINAL TASK:\n" + original_task
    )


def start_failover_from_job(job_id, root_job_id=None, attempt=1, max_failovers=2, previous_workers=None):
    meta = read_meta(job_id)
    if not is_done(job_id):
        raise ValueError("cannot fail over a running job")
    if not failover_eligible(meta):
        raise ValueError(f"job is not eligible for automatic failover: {meta.get('reason')}")

    root_id = root_job_id or meta.get("failover_root") or job_id
    task_path = JOBS / root_id / "task.txt"
    if not task_path.exists():
        raise ValueError("original root task text is missing")
    original_task = task_path.read_text(encoding="utf-8", errors="replace")
    previous = list(previous_workers or [])
    if meta.get("worker") and meta["worker"] not in previous:
        previous.append(meta["worker"])

    order = meta.get("worker_order") or None
    next_worker = (pick_worker("auto", exclude=previous, order=order, last_resort=helper_last_resort(order))
                   if order else pick_worker("auto", exclude=previous))
    continuation = failover_task(meta, original_task)
    timeout_minutes = max(1, min(int((meta.get("timeout_s") or 5400) / 60), 360))
    label = f"failover {attempt}: {meta.get('label') or job_id}"[:80]
    new_id, worker = start_job(
        next_worker,
        continuation,
        meta["cwd"],
        label,
        timeout_minutes,
        meta.get("write", True),
        None,
        job_id,
        False,
        max_failovers,
        attempt,
        root_id,
        previous,
        False,
        expect_files=meta.get("expect_files", []),
        pin=meta.get("pin", False), pool=meta.get("pool", False),
        worker_order=meta.get("worker_order") or None, teamyra_mcp=meta.get("teamyra_mcp", False),
    )
    patch_job_meta(
        job_id,
        failover_job_id=new_id,
        failover_worker=worker,
        failover_attempt_next=attempt,
    )
    return {"job_id": new_id, "worker": worker, "root_job_id": root_id, "attempt": attempt}


# --- views ---------------------------------------------------------------------------------
def summary(m, events=True):
    out = {k: m.get(k) for k in ("id", "label", "worker", "provider", "state", "reason", "branch", "session_id",
                                 "exit_code", "attention", "queue_position", "last_event", "parent",
                                 "expect_files", "missing_outputs", "pin", "pool",
                                 "failover_root", "failover_attempt",
                                 "failover_job_id", "failover_worker", "failover_complete")}
    start = m.get("started") or m.get("dispatched_at") or m.get("created")
    end = m.get("ended") or time.time()
    out["elapsed_s"] = int(end - start) if start else None
    if m.get("usage"):
        out["usage"] = m["usage"]
    if not events:
        out.pop("last_event", None)
    return out


def job_brief(m):
    """Compact view of one job for worker/team reports."""
    start = m.get("started") or m.get("dispatched_at") or m.get("created")
    end = m.get("ended") or time.time()
    return {"id": m.get("id"), "label": m.get("label"), "state": m.get("state"),
            "elapsed_s": int(end - start) if start else None, "last_event": m.get("last_event"),
            "attention": m.get("attention"), "queue_position": m.get("queue_position")}


def follow_info(job_id):
    return {"follow_command": " ".join('"' + part + '"' for part in bridge_process_command("follow.py", job_id, "--runtime-root", ROOT)),
            "dashboard": f"http://127.0.0.1:{config().get('dashboard_port', 8765)}/",
            "transcript": str(JOBS / job_id / "transcript.md")}


def job_result(job_id):
    requested_job_id = job_id
    chain = failover_chain(job_id)
    terminal = chain[-1]
    job_id = terminal["id"]
    m = terminal
    res = summary(m)
    res["requested_job_id"] = requested_job_id
    res["terminal_job_id"] = job_id
    if len(chain) > 1:
        res["failover_chain"] = [summary(item, events=False) for item in chain]
    final = JOBS / job_id / "final.txt"
    res["final_message"] = clip(final.read_text(encoding="utf-8", errors="replace"), 6000) if final.exists() else None
    cwd, head = m.get("cwd"), m.get("head_start")
    if cwd and head:
        res["commits"] = (git(cwd, "log", "--oneline", f"{head}..HEAD") or "").splitlines()[:40]
        res["git_status"] = (git(cwd, "status", "--short") or "").splitlines()[:40]
        res["diffstat"] = (git(cwd, "diff", "--shortstat", head) or "").strip()
    if m.get("denied_actions"):
        res["denied_actions"] = m["denied_actions"]
    err = JOBS / job_id / "stderr.txt"
    if m.get("reason") and err.exists():
        res["stderr_tail"] = clip(err.read_text(encoding="utf-8", errors="replace")[-1500:], 1500)
    res["transcript"] = str(JOBS / job_id / "transcript.md")
    return res

def job_events(job_id, since=0, limit=40):
    read_meta(job_id)
    path = JOBS / job_id / "events.jsonl"
    lines = path.read_text(encoding="utf-8", errors="replace").splitlines() if path.exists() else []
    limit = max(1, min(int(limit), 100))
    chunk = lines[since: since + limit]
    evs = []
    for line in chunk:
        try:
            e = json.loads(line)
            evs.append(f"{time.strftime('%H:%M:%S', time.localtime(e['ts']))} {e['kind']}: {clip(e['text'], 300)}")
        except Exception:
            pass
    return {"events": evs, "next": since + len(chunk), "total": len(lines), "done": is_done(job_id)}


def chain_summary(job_id):
    chain = failover_chain(job_id)
    terminal = chain[-1]
    out = summary(terminal)
    out["requested_job_id"] = job_id
    out["terminal_job_id"] = terminal["id"]
    out["failover_chain"] = [
        {k: item.get(k) for k in ("id", "worker", "state", "reason", "failover_attempt")}
        for item in chain
    ]
    return out


def job_wait(job_ids, mode="all", timeout_seconds=1500):
    ids = [job_ids] if isinstance(job_ids, str) else list(job_ids)
    for j in ids:
        read_meta(j)
    deadline = time.time() + max(5, min(int(timeout_seconds), 3000))
    while time.time() < deadline:
        done = [j for j in ids if chain_is_complete(j)]
        if (mode == "any" and done) or len(done) == len(ids):
            break
        time.sleep(5)

    completed = [chain_is_complete(j) for j in ids]
    rows = []
    for requested_id in ids:
        terminal_id = failover_terminal_job_id(requested_id)
        row = summary(read_meta(terminal_id))
        row["requested_job_id"] = requested_id
        row["terminal_job_id"] = terminal_id
        rows.append(row)
    return {
        "timed_out": not all(completed) if mode == "all" else not any(completed),
        "jobs": rows,
    }

def worker_status():
    registry = worker_registry()
    auth = {}

    def probe(item):
        worker, info = item
        ready, detail = worker_auth_status(info, use_cache=True)
        return worker, ready, detail

    items = list(registry.items())
    if items:
        with ThreadPoolExecutor(max_workers=min(8, len(items))) as pool:
            futures = [pool.submit(probe, item) for item in items]
            for future in as_completed(futures):
                try:
                    worker, ready, detail = future.result()
                    auth[worker] = (ready, detail)
                except Exception as exc:
                    auth[getattr(exc, "worker", "unknown")] = (False, str(exc))

    out = []
    for w, info in items:
        provider = info["provider"]
        ready, text = auth.get(w, (False, "auth probe failed"))
        settings = worker_settings(info)
        out.append({
            "worker": w,
            "provider": provider,
            "label": info.get("label", w),
            "profile_id": info.get("profile_id"),
            "enabled": info.get("enabled", True),
            "priority": info.get("priority", 100),
            "ready": ready,
            "detail": "models available" if provider == "antigravity" and ready else clip(text, 200),
            "model": settings.get("model"),
            "effort": settings.get("effort"),
        })

    for item in out:
        w = item["worker"]
        mine = running_jobs(w)
        active = [m for m in mine if m.get("state") in scheduler.ACTIVE_STATES]
        queued = sorted((m for m in mine if m.get("state") == scheduler.QUEUED), key=scheduler.queue_key)
        item["running_jobs"] = [m["id"] for m in mine if m.get("state") != scheduler.QUEUED]
        item["current_job"] = job_brief(active[0]) if active else None
        item["queue_length"] = len(queued)
        item["queued_jobs"] = [m["id"] for m in queued]
        cached = auth_snapshot(w) or {}
        item["ready_source"] = cached.get("source")
        if cached.get("probe_error"):
            item["probe_error"] = clip(cached["probe_error"], 200)
        item["cooldown_seconds"] = cooldown_left(w)
        if item["cooldown_seconds"]:
            item["ready"] = False
    return out


def create_worktree(project_path, worker, idx):
    return worktree_manager.create(
        project_path,
        WORKTREES,
        label=f"{worker}-{idx}",
        base_ref="HEAD",
    )


def start_conductor(graph_id):
    graph = task_graph.load_graph(ROOT, graph_id)
    if graph.get("state") in {"starting", "running", "awaiting_approval", "waiting_for_worker", "cancelling"}:
        return task_graph.graph_summary(graph)
    if graph.get("state") not in {"draft"}:
        raise ValueError(f"graph cannot be started from state {graph.get('state')}")

    graph["state"] = "starting"
    graph["error"] = None
    task_graph.save_graph(ROOT, graph)

    log_path = ROOT / "tasks" / f"{graph_id}.conductor.log"
    log = open(log_path, "a", encoding="utf-8")
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0) | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
    cmd = bridge_process_command("conductor_monitor.py", graph_id)
    try:
        try:
            try:
                conductor_proc = subprocess.Popen(
                    cmd,
                    cwd=str(ROOT),
                    stdin=subprocess.DEVNULL,
                    stdout=log,
                    stderr=log,
                    close_fds=True,
                    creationflags=flags | 0x01000000,
                )
            except OSError:
                conductor_proc = subprocess.Popen(
                    cmd,
                    cwd=str(ROOT),
                    stdin=subprocess.DEVNULL,
                    stdout=log,
                    stderr=log,
                    close_fds=True,
                    creationflags=flags,
                )
            graph = task_graph.load_graph(ROOT, graph_id)
            graph["conductor_pid"] = conductor_proc.pid
            task_graph.save_graph(ROOT, graph)
        finally:
            log.close()
    except Exception as exc:
        graph = task_graph.load_graph(ROOT, graph_id)
        graph["state"] = "draft"
        graph["error"] = f"conductor start failed: {exc}"
        task_graph.save_graph(ROOT, graph)
        raise
    return task_graph.graph_summary(task_graph.load_graph(ROOT, graph_id))


def start_review_cycle(source_job_id, reviewer_worker="auto", max_rounds=2, allow_self_review=False):
    if not chain_is_complete(source_job_id):
        raise ValueError("source job is still running")
    source = job_result(source_job_id)
    if source.get("state") != "done":
        raise ValueError(f"source job is not reviewable from state {source.get('state')}")

    terminal_id = failover_terminal_job_id(source_job_id)
    implementation_worker = read_meta(terminal_id).get("worker")
    if (reviewer_worker != "auto" and reviewer_worker == implementation_worker and not allow_self_review):
        raise ValueError("reviewer_worker must differ from the implementation worker unless allow_self_review=true")

    state = review_cycle.create(
        ROOT, source_job_id, reviewer_worker, max_rounds, allow_self_review
    )
    log_path = ROOT / "tasks" / "reviews" / f"{state['id']}.monitor.log"
    log = open(log_path, "a", encoding="utf-8")
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0) | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
    cmd = bridge_process_command("review_monitor.py", state["id"])
    try:
        try:
            review_proc = subprocess.Popen(
                cmd,
                cwd=str(ROOT),
                stdin=subprocess.DEVNULL,
                stdout=log,
                stderr=log,
                close_fds=True,
                creationflags=flags | 0x01000000,
            )
        except OSError:
            review_proc = subprocess.Popen(
                cmd,
                cwd=str(ROOT),
                stdin=subprocess.DEVNULL,
                stdout=log,
                stderr=log,
                close_fds=True,
                creationflags=flags,
            )
        state = review_cycle.load(ROOT, state["id"])
        state["monitor_pid"] = review_proc.pid
        review_cycle.save(ROOT, state)
    finally:
        log.close()
    return review_cycle.summary(state)


def handoff_task(source_job_id, message, structured_record=None):
    if structured_record is not None:
        return handoff_store.render_prompt(structured_record)

    # Backward-compatible compact handoff prompt for existing callers/tests.
    terminal_id = failover_terminal_job_id(source_job_id)
    meta = read_meta(terminal_id)
    result = job_result(source_job_id)
    final_message = clip(result.get("final_message") or "", 5000)
    git_status = "\n".join(result.get("git_status") or [])[:2000]
    diffstat = result.get("diffstat") or ""
    return f"""TEAMYRA structured handoff.

Source job: {source_job_id}
Terminal job: {terminal_id}
Source worker: {meta.get('worker')}
Source state: {meta.get('state')}
Diffstat: {diffstat}
Git status:
{git_status or '(clean or unavailable)'}

Source worker final message:
{final_message or '(no final message)'}

Handoff request:
{message}

Inspect the actual workspace before acting. Treat the source summary as context, not as proof that the code is correct.
"""



def prepare_handoff_record(source_job_id, target_worker, payload):
    terminal_id = failover_terminal_job_id(source_job_id)
    source = read_meta(terminal_id)
    result = job_result(source_job_id)

    memory_context = None
    if payload.get("include_project_memory", True):
        try:
            pack = project_memory.context_pack(
                ROOT,
                source["cwd"],
                payload.get("memory_query") or None,
                max_chars=payload.get("memory_max_chars", 6000),
                limit=30,
            )
            memory_context = pack.get("text") or None
        except Exception as exc:
            memory_context = "[Project memory unavailable: " + clip(str(exc), 280) + "]"

    artifacts = list(payload.get("artifacts") or [])
    transcript = result.get("transcript")
    if transcript:
        artifacts.append("Source transcript: " + str(transcript))
    artifacts.append("Workspace: " + str(source.get("cwd") or ""))

    record = handoff_store.create(
        ROOT,
        project_path=source["cwd"],
        source_job_id=source_job_id,
        terminal_job_id=terminal_id,
        source_worker=source.get("worker"),
        target_worker=target_worker,
        message=payload["message"],
        objective=payload.get("objective"),
        constraints=payload.get("constraints"),
        acceptance_criteria=payload.get("acceptance_criteria"),
        artifacts=artifacts,
        notes=payload.get("notes"),
        source_state=source.get("state"),
        source_final_message=result.get("final_message"),
        git_status=result.get("git_status"),
        diffstat=result.get("diffstat"),
        memory_context=memory_context,
        write=payload.get("write", False),
        label=f"handoff from {source.get('label') or source_job_id}"[:120],
    )
    return record, source, terminal_id




def desktop_control(action, payload=None, timeout_seconds=20):
    desktop_runtime.ensure_desktop_ready(ROOT)
    control = ROOT / ".teamyra-desktop" / "control"
    control.mkdir(parents=True, exist_ok=True)
    request_id = uuid.uuid4().hex
    request_file = control / f"{request_id}.request.json"
    response_file = control / f"{request_id}.response.json"
    body = {"id": request_id, "action": str(action), "payload": payload or {}, "created": time.time()}
    request_file.write_text(json.dumps(body, ensure_ascii=False), encoding="utf-8")
    deadline = time.time() + max(1, min(float(timeout_seconds or 20), 60))
    try:
        while time.time() < deadline:
            if response_file.exists():
                data = json.loads(response_file.read_text(encoding="utf-8"))
                if data.get("ok") is not True:
                    raise ValueError(str(data.get("error") or "desktop control failed"))
                return data.get("result")
            time.sleep(0.05)
        raise TimeoutError("TEAMYRA Desktop did not answer the control request")
    finally:
        try: request_file.unlink(missing_ok=True)
        except Exception: pass
        try: response_file.unlink(missing_ok=True)
        except Exception: pass

def wake_media_surface(surface):
    try:
        response = desktop_control("media.wake", {"surface": surface}, 5)
        return {"state": "waking", "surface": surface, "needs_user_auth": response.get("needs_user_auth") is True}
    except Exception as exc:
        # Queue creation is durable. Tell callers why it hasn't started rather
        # than returning an apparently healthy queued job indefinitely.
        return {"state": "unavailable", "surface": surface, "error": str(exc)[:800]}

def dispatch_media_helper(ticket_id):
    """Start the helper agent for a ticket: Codex 1 -> Codex 2 -> Antigravity -> Claude."""
    ticket = media_support._load_ticket(ROOT, ticket_id)
    order = helper_worker_order()
    try:
        job_id, worker = start_job(
            "auto", media_support.helper_task(ticket), ticket["project_path"],
            label=f"media helper {ticket_id} ({ticket['kind']})"[:80], timeout_minutes=120, write=True,
            auto_failover=True, max_failovers=max(0, len(order) - 1), queue=True,
            worker_order=order, teamyra_mcp=True)
    except Exception as exc:
        media_support.record_dispatch(ROOT, ticket_id, error=str(exc))
        return {"started": False, "error": str(exc)[:800], "worker_order": order}
    media_support.record_dispatch(ROOT, ticket_id, worker=worker, job_id=job_id)
    return {"started": True, "worker": worker, "job_id": job_id, "worker_order": order}


def media_helper_state(ticket):
    job_id = (ticket.get("helper") or {}).get("job_id")
    if not job_id:
        return None
    try:
        terminal = failover_terminal_job_id(job_id)
        meta = read_meta(terminal)
        return {"job_id": terminal, "worker": meta.get("worker"), "state": meta.get("state"),
                "reason": meta.get("reason"), "last_event": meta.get("last_event")}
    except Exception as exc:
        return {"job_id": job_id, "state": "unknown", "error": str(exc)[:300]}


# --- MCP tools -------------------------------------------------------------------------------
W_ENUM = {"type": "string", "default": "auto",
          "description": "Use auto or any worker id returned by worker_status. Dynamic profiles and desktop-backed workers are discovered at runtime."}
MEDIA_TYPE_ENUM = ["image", "video", "music", "background_music", "instrumental", "song", "sound_effect"]
MEDIA_FORMAT_ENUM = ["png", "jpg", "jpeg", "webp", "mp4", "webm", "wav", "mp3", "m4a"]
MEDIA_REQUEST_PROPERTIES = {
    "type": {"type": "string", "enum": MEDIA_TYPE_ENUM},
    "prompt": {"type": "string"},
    "project_path": {"type": "string"},
    "duration": {"type": "number", "exclusiveMinimum": 0, "maximum": 1800},
    "aspect_ratio": {"type": "string"},
    "format": {"type": "string", "enum": MEDIA_FORMAT_ENUM},
    "references": {"type": "array", "maxItems": 24, "items": {"type": "string"},
                   "description": "Exact TEAMYRA asset IDs or project-local media files. Omni attaches image identity references directly to the prompt as ingredients; attachments are verified before generation."},
    "reference_mode": {"type": "string", "enum": ["auto", "ingredients"], "default": "auto",
                       "description": "Omni uses prompt ingredients. Exact first/last-frame controls are unsupported; do not request Frames mode."},
    "output_count": {"type": "integer", "minimum": 1, "maximum": 8, "default": 1},
    "instrumental": {"type": "boolean"},
    "vocals": {"type": "boolean"},
    "lyrics": {"type": "string"},
    "model_preference": {"type": "string"},
    "download_quality": {"type": "string", "enum": ["auto", "source", "2x", "4x", "prefer_4x_then_2x", "1080p", "4k"],
                         "description": "Video defaults to 1080p: generate at 720p, then select 1080p Upscaled in Download and wait for the real file. source opts out. Sound effects always download the 360p original and extract audio; no upscale."},
    "generation_resolution": {"type": "string", "enum": ["auto", "360p", "720p"],
                              "description": "Native Flow generation resolution, separate from download quality. Video defaults to 720p; 1080p is a download upscale. Sound effects are always generated at 360p regardless of overrides."},
    "wait_for_upscale": {"type": "boolean"},
    "audio_only": {"type": "boolean"},
    "first_frame": {"type": "string", "description": "Compatibility alias for an Omni prompt image ingredient. No exact first-frame guarantee; prefer references with a TEAMYRA image asset ID or project-local image path."},
    "last_frame": {"type": "string", "description": "Unsupported by Omni. Rejected before generation; use references for image identity ingredients instead."},
    "character_reference": {"type": "string"},
    "audio_reference": {"type": "string"},
    "video_reference": {"type": "string"},
    "generation_settings": {"type": "object"},
    "max_parallel": {"type": "integer", "minimum": 1, "maximum": 30,
                     "description": "Bulk throughput: how many Flow generations this job may share with other queued jobs at once. The desktop worker submits jobs back to back, waits on all of them together and adapts downward if Flow reports it is busy. Default 10."},
}
TOOLS = [
    {"name": "provider_list", "description": "List TEAMYRA providers/accounts as seen by the desktop app, including ChatGPT, Codex, Claude and Antigravity profiles.",
     "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False}},
    {"name": "agent_account_create", "description": "Create an isolated managed account/profile for a supported TEAMYRA provider. Login remains an explicit user action when the provider requires authentication.",
     "inputSchema": {"type": "object", "properties": {
         "provider": {"type": "string", "enum": ["chatgpt-web", "codex", "claude", "antigravity"]},
         "name": {"type": "string"}},
         "required": ["provider"], "additionalProperties": False}},
    {"name": "agent_account_update", "description": "Update a managed agent account/profile name, enabled state, routing priority, model, effort, or Claude permission mode.",
     "inputSchema": {"type": "object", "properties": {
         "provider": {"type": "string", "enum": ["chatgpt-web", "codex", "claude", "antigravity"]},
         "profile_id": {"type": "string"},
         "patch": {"type": "object"}},
         "required": ["provider", "profile_id", "patch"], "additionalProperties": False}},
    {"name": "chatgpt_control", "description": "Control a Normal ChatGPT desktop profile explicitly. Delegated jobs stay background-only; use visible/open only when the user intentionally wants to inspect ChatGPT.",
     "inputSchema": {"type": "object", "properties": {
         "action": {"type": "string", "enum": ["status", "open", "close", "reload", "reconnect", "new_chat", "stop", "send", "conversation", "open_conversation", "visible", "bounds", "workspace_status", "workspace_configure", "changes", "revert", "attach_file"]},
         "profile_id": {"type": "string", "default": "web"},
         "text": {"type": "string"},
         "value": {"type": "string"},
         "visible": {"type": "boolean"},
         "bounds": {"type": "object"},
         "workspace": {"type": "string"},
         "permissions": {"type": "object"},
         "paths": {"type": "array", "items": {"type": "string"}},
         "confirm": {"type": "boolean", "default": False},
         "file_path": {"type": "string"}},
         "required": ["action"], "additionalProperties": False}},
    {"name": "media_generate", "description": "Queue a durable media job and auto-wake the required desktop worker. Video: 720p generation then 1080p upscaled download by default. Sound effect: 360p generation, original-size download, audio extraction. Omni image references attach directly as prompt ingredients; exact first/last Frames are unavailable. Returns job id and effective settings. For two or more generations use media_batch (one call, run in parallel); for Codex/gpt-image stills use codex_image_batch. See media_guide.",
     "inputSchema": {"type": "object", "properties": MEDIA_REQUEST_PROPERTIES,
                     "required": ["type", "prompt", "project_path"], "additionalProperties": False}},
    {"name": "media_batch", "description": "Bulk-generate up to 50 images/videos/sound effects in parallel. Jobs share one batch_id; the desktop worker submits them back to back so Flow generates many at once (e.g. 10-30 videos in minutes rather than one by one), then downloads and verifies each result. Same rules as media_generate: video 720p then 1080p upscale; sound effects 360p original then audio extraction; Omni images attach as prompt ingredients, without first/last Frames. Poll media_status with batch_id. For the fastest turnaround set download_quality='source' (720p video / original image, no upscale wait); default video downloads are 1080p upscales.",
     "inputSchema": {"type": "object", "properties": {
         "requests": {"type": "array", "minItems": 1, "maxItems": 50,
                      "items": {"type": "object", "properties": MEDIA_REQUEST_PROPERTIES,
                                "required": ["type", "prompt", "project_path"], "additionalProperties": False}},
         "max_parallel": {"type": "integer", "minimum": 1, "maximum": 30, "default": 10,
                          "description": "Concurrent Flow generations for this batch; adapts downward automatically when Flow is busy."}},
         "required": ["requests"], "additionalProperties": False}},
    {"name": "media_guide", "description": "Read first before generating media or images: which TEAMYRA tool to use (Flow media_batch, Codex codex_image_batch), how to batch, poll and recover, plus live capacity (Flow tabs, Google connection, Codex image accounts).",
     "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False}},
    {"name": "codex_image_batch", "description": "Generate up to 50 images with Codex's built-in image tool (gpt-image) in parallel and save each to its own file. Each image is its own short Codex run with the reference images attached directly, the usual model and reasoning effort and full image quality (Codex checks the result once and retries once if it clearly misses); several run at once across the signed-in Codex accounts (codex1, codex2), about 1-2 minutes per image instead of a long worker job. Use this instead of a worker job that generates images one by one. Returns a batch_id at once; poll codex_image_status.",
     "inputSchema": {"type": "object", "properties": {
         "project_path": {"type": "string", "description": "Project folder; outputs and relative paths are inside it."},
         "requests": {"type": "array", "minItems": 1, "maxItems": 50, "items": {"type": "object", "properties": {
             "prompt": {"type": "string", "description": "Full image prompt. Refer to references as Image 1, Image 2... in the order given."},
             "output": {"type": "string", "description": "Output file (.png, .jpg or .webp), relative to project_path or absolute inside it."},
             "references": {"type": "array", "maxItems": 10, "items": {"type": "string"}, "description": "Reference image files (relative to project_path or absolute)."},
             "size": {"type": "string", "enum": ["1536x1024", "1024x1536", "1024x1024", "auto"], "default": "1536x1024"}},
             "required": ["prompt", "output"], "additionalProperties": False}},
         "max_parallel": {"type": "integer", "minimum": 1, "maximum": 8, "description": "Images generating at once (default 2 per signed-in Codex account)."},
         "accounts": {"type": "array", "items": {"type": "string"}, "description": "Limit to these Codex workers, e.g. [\"codex2\"]."}},
         "required": ["project_path", "requests"], "additionalProperties": False}},
    {"name": "codex_image_status", "description": "Progress of a codex_image_batch: per image status (queued, generating, completed, refused, failed, cancelled), output path, size, seconds and error.",
     "inputSchema": {"type": "object", "properties": {"batch_id": {"type": "string"}}, "required": ["batch_id"], "additionalProperties": False}},
    {"name": "codex_image_cancel", "description": "Stop a codex_image_batch: images not started yet are cancelled; running ones finish.",
     "inputSchema": {"type": "object", "properties": {"batch_id": {"type": "string"}}, "required": ["batch_id"], "additionalProperties": False}},
    {"name": "media_transform", "description": "Queue an edit/variation/extend/remix operation against an exact TEAMYRA asset id.",
     "inputSchema": {"type": "object", "properties": {
         "operation": {"type": "string", "enum": [
             "image_edit", "image_variation", "video_extend", "video_edit", "video_to_video",
             "music_remix", "music_extend", "music_replace_section"
         ]},
         "asset_id": {"type": "string"},
         "prompt": {"type": "string"},
         "project_path": {"type": "string"},
         "duration": {"type": "number", "exclusiveMinimum": 0, "maximum": 1800},
         "aspect_ratio": {"type": "string"},
         "format": {"type": "string", "enum": MEDIA_FORMAT_ENUM},
         "references": MEDIA_REQUEST_PROPERTIES["references"],
         "reference_mode": MEDIA_REQUEST_PROPERTIES["reference_mode"],
         "instrumental": {"type": "boolean"},
         "first_frame": MEDIA_REQUEST_PROPERTIES["first_frame"],
         "last_frame": MEDIA_REQUEST_PROPERTIES["last_frame"],
         "download_quality": MEDIA_REQUEST_PROPERTIES["download_quality"],
         "generation_resolution": MEDIA_REQUEST_PROPERTIES["generation_resolution"],
         "wait_for_upscale": MEDIA_REQUEST_PROPERTIES["wait_for_upscale"],
         "audio_only": MEDIA_REQUEST_PROPERTIES["audio_only"],
         "character_reference": {"type": "string"},
         "audio_reference": {"type": "string"},
         "video_reference": {"type": "string"},
         "generation_settings": {"type": "object"}},
         "required": ["operation", "asset_id"], "additionalProperties": False}},
    {"name": "media_capabilities", "description": "Read enforced media workflow rules without loading the browser: video native 720p then 1080p upscale; SFX 360p source video then audio extraction; Omni image ingredients with no exact first/end Frames.",
     "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False}},
    {"name": "media_status", "description": "Read media job progress, asset metadata and recovery_plan with error category, safe next action and automatic retry budget. Poll the same job during recovery; do not create replacement generations.",
     "inputSchema": {"type": "object", "properties": {
         "job_id": {"type": "string"},
         "batch_id": {"type": "string", "description": "Summarize every job of a media_batch: counts by status, done flag and per-job assets."},
         "limit": {"type": "integer", "minimum": 1, "maximum": 200, "default": 30}},
         "additionalProperties": False}},
    {"name": "media_assets", "description": "Resolve/list TEAMYRA generated assets by persistent asset id, project, or media type.",
     "inputSchema": {"type": "object", "properties": {
         "asset_id": {"type": "string"},
         "project_path": {"type": "string"},
         "type": {"type": "string", "enum": MEDIA_TYPE_ENUM},
         "limit": {"type": "integer", "minimum": 1, "maximum": 500, "default": 100}},
         "additionalProperties": False}},
    {"name": "media_cancel", "description": "Request cancellation of a queued or in-progress TEAMYRA media job, or every unfinished job of a batch_id.",
     "inputSchema": {"type": "object", "properties": {"job_id": {"type": "string"}, "batch_id": {"type": "string"}},
                     "additionalProperties": False}},
    {"name": "media_resume_auth", "description": "Resume media jobs after Google authentication is restored. Jobs already submitted to a provider are preserved for reconciliation and are never blindly resubmitted.",
     "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False}},
    {"name": "media_report_issue", "description": "Report a media generation/download problem you cannot resolve quickly (stuck, failing, refused, waiting too long). TEAMYRA logs it for maintenance and a TEAMYRA helper agent (Codex 1, Codex 2, Antigravity; Claude as last resort) takes the jobs over, finishes them by hand and delivers the results into your same job ids. After reporting, stop retrying: poll media_ticket_status or your jobs.",
     "inputSchema": {"type": "object", "properties": {
         "description": {"type": "string", "description": "What went wrong and what you need (e.g. 'S10 clip stuck generating 20 min; need it with the English line')."},
         "job_ids": {"type": "array", "maxItems": 50, "items": {"type": "string"}},
         "batch_id": {"type": "string", "description": "Report every unfinished job of a batch."},
         "reporter": {"type": "string", "description": "Your agent/session name so the helper and maintenance know who reported."},
         "instructions": {"type": "string", "description": "Anything the helper must keep (dialogue, style, naming)."},
         "take_over": {"type": "boolean", "default": True, "description": "false only logs the issue for maintenance."}},
         "required": ["description"], "additionalProperties": False}},
    {"name": "media_delegate", "description": "Hand a whole media generation task to a TEAMYRA helper agent. It queues every request (bulk), handles failures (rewording refused prompts, re-downloading), follows your instructions and delivers each asset. Poll media_ticket_status for deliveries instead of generating yourself.",
     "inputSchema": {"type": "object", "properties": {
         "description": {"type": "string"},
         "project_path": {"type": "string"},
         "requests": {"type": "array", "maxItems": 50, "items": {"type": "object", "properties": MEDIA_REQUEST_PROPERTIES,
                      "required": ["type", "prompt"], "additionalProperties": False}},
         "instructions": {"type": "string", "description": "How the helper must do it: naming, rewording limits, quality checks, priorities."},
         "reporter": {"type": "string"}},
         "required": ["description", "project_path"], "additionalProperties": False}},
    {"name": "media_ticket_status", "description": "Status of a helper ticket: helper agent and its progress, notes, per-job state and delivered assets (ids and local paths).",
     "inputSchema": {"type": "object", "properties": {"ticket_id": {"type": "string"}}, "required": ["ticket_id"], "additionalProperties": False}},
    {"name": "media_ticket_update", "description": "Helper agents: record progress notes and set the ticket status (working, delivered, partially_delivered, failed). Failed/cancelled returns undelivered jobs to their reporter as failures.",
     "inputSchema": {"type": "object", "properties": {
         "ticket_id": {"type": "string"}, "status": {"type": "string", "enum": sorted(media_support.TICKET_STATES)},
         "note": {"type": "string"}, "summary": {"type": "string"}, "by": {"type": "string"}},
         "required": ["ticket_id"], "additionalProperties": False}},
    {"name": "media_ticket_deliver", "description": "Helper agents: deliver a finished asset for a ticket. With original_job_id the reporter's job completes with this asset, so the waiting agent receives it on its next poll.",
     "inputSchema": {"type": "object", "properties": {
         "ticket_id": {"type": "string"}, "asset_id": {"type": "string"}, "original_job_id": {"type": "string"},
         "item": {"type": "integer", "minimum": 0}, "note": {"type": "string"}, "by": {"type": "string"}},
         "required": ["ticket_id", "asset_id"], "additionalProperties": False}},
    {"name": "media_issues", "description": "Maintenance view of media issues reported by agents or logged automatically from failures, grouped by category.",
     "inputSchema": {"type": "object", "properties": {
         "status": {"type": "string", "enum": sorted(media_support.ISSUE_STATES)},
         "category": {"type": "string"}, "source": {"type": "string", "enum": ["agent_report", "delegation", "automatic"]},
         "limit": {"type": "integer", "minimum": 1, "maximum": 500, "default": 50}},
         "additionalProperties": False}},
    {"name": "media_issue_update", "description": "Maintenance: acknowledge or close a media issue with a note.",
     "inputSchema": {"type": "object", "properties": {
         "issue_id": {"type": "string"}, "status": {"type": "string", "enum": sorted(media_support.ISSUE_STATES)},
         "note": {"type": "string"}, "by": {"type": "string"}},
         "required": ["issue_id"], "additionalProperties": False}},
    {"name": "media_resume_download", "description": "Resume a failed/auth-blocked/rate-limited media job with an identified provider submission. Reconciles and downloads its existing result without generating again. Helper agents pass their ticket_id to resume jobs assigned to them.",
     "inputSchema": {"type": "object", "properties": {"job_id": {"type": "string"}, "ticket_id": {"type": "string"}}, "required": ["job_id"], "additionalProperties": False}},
    {"name": "maintenance_report", "description": "Any agent: note an error or problem you hit in TEAMYRA or its workers (media, worker CLI, ChatGPT, MCP, desktop, scheduler, git) for the maintenance team. Logging does not stop your work; keep going after reporting.",
     "inputSchema": {"type": "object", "properties": {
         "summary": {"type": "string"}, "details": {"type": "string", "description": "Exact error text, what you were doing, ids."},
         "area": {"type": "string", "enum": ["media", "worker", "chatgpt", "mcp", "desktop", "scheduler", "git", "other"]},
         "severity": {"type": "string", "enum": ["low", "medium", "high", "blocker"]},
         "category": {"type": "string"}, "reporter": {"type": "string"}, "project_path": {"type": "string"},
         "refs": {"type": "array", "maxItems": 20, "items": {"type": "string"}, "description": "Related job/batch/ticket ids or file paths."}},
         "required": ["summary"], "additionalProperties": False}},
    {"name": "maintenance_issues", "description": "Maintenance view of every logged TEAMYRA issue (agent reports and automatic failure records), filterable by area/status and grouped by category.",
     "inputSchema": {"type": "object", "properties": {
         "area": {"type": "string", "enum": ["media", "worker", "chatgpt", "mcp", "desktop", "scheduler", "git", "other"]},
         "status": {"type": "string", "enum": ["open", "acknowledged", "fixed", "wont_fix"]},
         "category": {"type": "string"}, "source": {"type": "string", "enum": ["agent_report", "delegation", "automatic"]},
         "limit": {"type": "integer", "minimum": 1, "maximum": 500, "default": 50}},
         "additionalProperties": False}},
    {"name": "media_recover", "description": "Safely recover a stopped media job using its durable checkpoints. Retries confirmed pre-submission failures or reconciles/downloads an existing submission; never blindly clicks Generate twice. Returns recovery_plan when login, credits, policy refusal or missing identity require attention. Use after inspecting media_status, then poll the same job_id. Helper agents pass their ticket_id to recover jobs assigned to them.",
     "inputSchema": {"type": "object", "properties": {"job_id": {"type": "string"}, "ticket_id": {"type": "string"}}, "required": ["job_id"], "additionalProperties": False}},
    {"name": "review_start", "description": "Start a detached bounded reviewer/fixer loop for a completed implementation job. Reviewer runs read-only and must return TEAMYRA_REVIEW: PASS or CHANGES.",
     "inputSchema": {"type": "object", "properties": {
         "job_id": {"type": "string"},
         "reviewer_worker": W_ENUM,
         "allow_self_review": {"type": "boolean", "default": False,
                               "description": "Allow the implementation worker/account to review its own work. Defaults false."},
         "max_rounds": {"type": "integer", "default": 2, "minimum": 1, "maximum": 5}},
         "required": ["job_id"], "additionalProperties": False}},
    {"name": "review_status", "description": "Read reviewer/fixer loop state, active job, decision and round history.",
     "inputSchema": {"type": "object", "properties": {"review_id": {"type": "string"}},
                     "required": ["review_id"], "additionalProperties": False}},
    {"name": "review_cancel", "description": "Request cancellation of an active review/fix loop.",
     "inputSchema": {"type": "object", "properties": {"review_id": {"type": "string"}},
                     "required": ["review_id"], "additionalProperties": False}},
    {"name": "timeline_list", "description": "Read a bounded unified TEAMYRA timeline across jobs, graphs, reviews, and managed worktrees.",
     "inputSchema": {"type": "object", "properties": {
         "limit": {"type": "integer", "default": 100, "minimum": 1, "maximum": 500},
         "project_path": {"type": "string"},
         "worker": {"type": "string"},
         "sources": {"type": "array", "items": {"type": "string", "enum": ["job", "graph", "review", "handoff", "worktree", "media"]}},
         "query": {"type": "string"},
         "since": {"type": "number"}},
         "additionalProperties": False}},
    {"name": "logs_search", "description": "Search bounded TEAMYRA job events, transcripts, stderr, runner logs, and task text.",
     "inputSchema": {"type": "object", "properties": {
         "query": {"type": "string"},
         "limit": {"type": "integer", "default": 50, "minimum": 1, "maximum": 200},
         "project_path": {"type": "string"},
         "worker": {"type": "string"},
         "kinds": {"type": "array", "items": {"type": "string", "enum": ["events.jsonl", "transcript.md", "stderr.txt", "runner.log", "task.txt"]}}},
         "required": ["query"], "additionalProperties": False}},
    {"name": "usage_snapshot", "description": "Aggregate real worker token usage with current readiness, cooldown, model, and running-job telemetry. Does not fabricate unavailable provider quota percentages.",
     "inputSchema": {"type": "object", "properties": {
         "project_path": {"type": "string"}},
         "additionalProperties": False}},
    {"name": "workspace_tool", "description": "Run one normalized workspace-scoped TEAMYRA local tool. Uses the same sandbox/permission implementation as the ChatGPT web worker.",
     "inputSchema": {"type": "object", "properties": {
         "project_path": {"type": "string"},
         "tool": {"type": "string", "enum": [
             "filesystem.list", "filesystem.stat", "filesystem.read", "filesystem.search", "filesystem.create",
             "filesystem.write", "filesystem.patch", "filesystem.move", "filesystem.rename",
             "filesystem.delete", "terminal.run", "git.status", "git.diff", "git.log",
             "git.add", "git.commit", "git.restore"
         ]},
         "args": {"type": "object"},
         "agent": {"type": "string", "description": "Optional agent identity recorded in workspace-tool audit logs."},
         "confirm": {"type": "boolean", "default": False}},
         "required": ["project_path", "tool"], "additionalProperties": False}},
    {"name": "memory_add", "description": "Add a structured local project memory entry. Runtime memory is stored under TEAMYRA memory/ and excluded from source control.",
     "inputSchema": {"type": "object", "properties": {
         "project_path": {"type": "string"},
         "kind": {"type": "string", "enum": ["decision", "architecture", "fact", "note", "handoff", "todo"]},
         "title": {"type": "string"},
         "content": {"type": "string"},
         "tags": {"type": "array", "items": {"type": "string"}},
         "importance": {"type": "string", "enum": ["low", "normal", "high", "critical"], "default": "normal"},
         "source_job_id": {"type": "string"},
         "source_graph_id": {"type": "string"}},
         "required": ["project_path", "kind", "title", "content"], "additionalProperties": False}},
    {"name": "memory_list", "description": "List structured project memories with optional kind/status/tag filters.",
     "inputSchema": {"type": "object", "properties": {
         "project_path": {"type": "string"},
         "kind": {"type": "string", "enum": ["decision", "architecture", "fact", "note", "handoff", "todo"]},
         "status": {"type": "string", "enum": ["active", "archived", "all"], "default": "active"},
         "tag": {"type": "string"},
         "limit": {"type": "integer", "default": 100, "minimum": 1, "maximum": 500}},
         "required": ["project_path"], "additionalProperties": False}},
    {"name": "memory_search", "description": "Search project memory by title, tags, and content with bounded ranked results.",
     "inputSchema": {"type": "object", "properties": {
         "project_path": {"type": "string"},
         "query": {"type": "string"},
         "kinds": {"type": "array", "items": {"type": "string", "enum": ["decision", "architecture", "fact", "note", "handoff", "todo"]}},
         "tags": {"type": "array", "items": {"type": "string"}},
         "status": {"type": "string", "enum": ["active", "archived", "all"], "default": "active"},
         "limit": {"type": "integer", "default": 50, "minimum": 1, "maximum": 200}},
         "required": ["project_path", "query"], "additionalProperties": False}},
    {"name": "memory_get", "description": "Read one project memory entry by id.",
     "inputSchema": {"type": "object", "properties": {
         "project_path": {"type": "string"}, "memory_id": {"type": "string"}},
         "required": ["project_path", "memory_id"], "additionalProperties": False}},
    {"name": "memory_update", "description": "Update an active project memory entry.",
     "inputSchema": {"type": "object", "properties": {
         "project_path": {"type": "string"}, "memory_id": {"type": "string"},
         "title": {"type": "string"}, "content": {"type": "string"},
         "tags": {"type": "array", "items": {"type": "string"}},
         "importance": {"type": "string", "enum": ["low", "normal", "high", "critical"]},
         "kind": {"type": "string", "enum": ["decision", "architecture", "fact", "note", "handoff", "todo"]}},
         "required": ["project_path", "memory_id"], "additionalProperties": False}},
    {"name": "memory_archive", "description": "Archive a project memory entry while preserving its history.",
     "inputSchema": {"type": "object", "properties": {
         "project_path": {"type": "string"}, "memory_id": {"type": "string"}, "reason": {"type": "string"}},
         "required": ["project_path", "memory_id"], "additionalProperties": False}},
    {"name": "memory_context", "description": "Build a bounded project-memory context pack for an agent without dumping the full memory store.",
     "inputSchema": {"type": "object", "properties": {
         "project_path": {"type": "string"}, "query": {"type": "string"},
         "kinds": {"type": "array", "items": {"type": "string", "enum": ["decision", "architecture", "fact", "note", "handoff", "todo"]}},
         "tags": {"type": "array", "items": {"type": "string"}},
         "max_chars": {"type": "integer", "default": 8000, "minimum": 1000, "maximum": 24000},
         "limit": {"type": "integer", "default": 40, "minimum": 1, "maximum": 100}},
         "required": ["project_path"], "additionalProperties": False}},
    {"name": "recovery_scan", "description": "Reconcile persisted TEAMYRA jobs, task graphs, review cycles, and failover monitors after a process/app/PC restart. Resumes only persisted provider sessions; never blindly reruns an orphaned task.",
     "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False}},
    {"name": "mcp_pool_list", "description": "List configured shared external MCP servers and live pooled-process status. Runtime config lives under ignored profiles/.",
     "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False}},
    {"name": "mcp_pool_tools", "description": "Start/reuse one pooled MCP server and list its tools.",
     "inputSchema": {"type": "object", "properties": {
         "server": {"type": "string"}, "refresh": {"type": "boolean", "default": False}},
         "required": ["server"], "additionalProperties": False}},
    {"name": "mcp_pool_call", "description": "Call one tool on a configured pooled external MCP server. The long-lived process is reused across TEAMYRA clients.",
     "inputSchema": {"type": "object", "properties": {
         "server": {"type": "string"}, "tool_name": {"type": "string"},
         "arguments": {"type": "object"},
         "timeout_seconds": {"type": "integer", "default": 30, "minimum": 1, "maximum": 300}},
         "required": ["server", "tool_name"], "additionalProperties": False}},
    {"name": "mcp_pool_register", "description": "Register or update a runtime-only external stdio MCP server. Requires confirm=true. command is an argv array and is never run through a shell.",
     "inputSchema": {"type": "object", "properties": {
         "server": {"type": "string"},
         "command": {"type": "array", "minItems": 1, "maxItems": 64, "items": {"type": "string"}},
         "cwd": {"type": "string"},
         "env": {"type": "object", "additionalProperties": {"type": "string"}},
         "enabled": {"type": "boolean", "default": True},
         "timeout_seconds": {"type": "integer", "default": 30, "minimum": 2, "maximum": 300},
         "confirm": {"type": "boolean"}},
         "required": ["server", "command", "confirm"], "additionalProperties": False}},
    {"name": "mcp_pool_restart", "description": "Restart one pooled MCP subprocess and reinitialize/tool-discover it. Requires confirm=true.",
     "inputSchema": {"type": "object", "properties": {
         "server": {"type": "string"}, "confirm": {"type": "boolean"}},
         "required": ["server", "confirm"], "additionalProperties": False}},
    {"name": "mcp_pool_remove", "description": "Stop and remove one runtime pooled MCP server configuration. Requires confirm=true.",
     "inputSchema": {"type": "object", "properties": {
         "server": {"type": "string"}, "confirm": {"type": "boolean"}},
         "required": ["server", "confirm"], "additionalProperties": False}},
    {"name": "test_run", "description": "Run deterministic no-shell test steps in a project directory. Commands are argv arrays, run sequentially, and stop on first failure or timeout.",
     "inputSchema": {"type": "object", "properties": {
         "project_path": {"type": "string"},
         "tests": {"type": "array", "minItems": 1, "maxItems": 12, "items": {"type": "object", "properties": {
             "name": {"type": "string"},
             "argv": {"type": "array", "minItems": 1, "maxItems": 32, "items": {"type": "string"}},
             "timeout_seconds": {"type": "integer", "default": 300, "minimum": 1, "maximum": 1800}},
             "required": ["argv"], "additionalProperties": False}}},
         "required": ["project_path", "tests"], "additionalProperties": False}},
    {"name": "graph_create", "description": "Create a persistent dependency task graph. Set max_parallel > 1 to run independent nodes concurrently; write nodes are isolated in managed Git worktrees and integrated deterministically.",
     "inputSchema": {"type": "object", "properties": {
         "title": {"type": "string"},
         "objective": {"type": "string"},
         "project_path": {"type": "string"},
         "max_parallel": {"type": "integer", "default": 1, "minimum": 1, "maximum": 4},
         "nodes": {"type": "array", "minItems": 1, "maxItems": 50, "items": {"type": "object", "properties": {
             "id": {"type": "string"}, "label": {"type": "string"}, "task": {"type": "string"},
             "worker": W_ENUM, "depends_on": {"type": "array", "items": {"type": "string"}},
             "write": {"type": "boolean", "default": True},
             "timeout_minutes": {"type": "integer", "default": 90, "minimum": 1, "maximum": 360},
             "tests": {"type": "array", "maxItems": 12, "items": {"type": "object", "properties": {
                 "name": {"type": "string"},
                 "argv": {"type": "array", "minItems": 1, "maxItems": 32, "items": {"type": "string"}},
                 "timeout_seconds": {"type": "integer", "default": 300, "minimum": 1, "maximum": 1800}},
                 "required": ["argv"], "additionalProperties": False}},
             "requires_approval": {"type": "boolean", "default": False},
             "approval_reason": {"type": "string"}},
             "required": ["id", "task"], "additionalProperties": False}}},
         "required": ["project_path", "nodes"], "additionalProperties": False}},
    {"name": "graph_start", "description": "Start the detached TEAMYRA Conductor for a draft task graph.",
     "inputSchema": {"type": "object", "properties": {"graph_id": {"type": "string"}},
                     "required": ["graph_id"], "additionalProperties": False}},
    {"name": "graph_status", "description": "Read graph state, dependency nodes, workers, child job ids and errors.",
     "inputSchema": {"type": "object", "properties": {"graph_id": {"type": "string"}},
                     "required": ["graph_id"], "additionalProperties": False}},
    {"name": "graph_cancel", "description": "Request cancellation of a graph and its active child job.",
     "inputSchema": {"type": "object", "properties": {"graph_id": {"type": "string"}},
                     "required": ["graph_id"], "additionalProperties": False}},
    {"name": "graph_approve", "description": "Approve or deny the currently gated graph node before the Conductor starts it.",
     "inputSchema": {"type": "object", "properties": {
         "graph_id": {"type": "string"}, "node_id": {"type": "string"},
         "decision": {"type": "string", "enum": ["approve", "deny"]},
         "note": {"type": "string"}},
         "required": ["graph_id", "node_id", "decision"], "additionalProperties": False}},
    {"name": "worktree_create", "description": "Create an isolated TEAMYRA Git worktree/branch from a repository ref.",
     "inputSchema": {"type": "object", "properties": {
         "project_path": {"type": "string"}, "label": {"type": "string"},
         "base_ref": {"type": "string", "default": "HEAD"}},
         "required": ["project_path"], "additionalProperties": False}},
    {"name": "worktree_list", "description": "List TEAMYRA-managed worktrees with branch, dirty state, commits and diffstat.",
     "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False}},
    {"name": "worktree_status", "description": "Read one TEAMYRA-managed worktree status.",
     "inputSchema": {"type": "object", "properties": {"worktree_id": {"type": "string"}},
                     "required": ["worktree_id"], "additionalProperties": False}},
    {"name": "worktree_diff", "description": "Read a bounded unified diff for one TEAMYRA-managed worktree against its base commit.",
     "inputSchema": {"type": "object", "properties": {
         "worktree_id": {"type": "string"},
         "max_chars": {"type": "integer", "default": 50000, "minimum": 1000, "maximum": 200000}},
         "required": ["worktree_id"], "additionalProperties": False}},
    {"name": "worktree_rebase", "description": "Rebase a clean TEAMYRA worktree branch onto the latest captured target branch. Requires confirm=true and aborts automatically on conflict.",
     "inputSchema": {"type": "object", "properties": {
         "worktree_id": {"type": "string"}, "confirm": {"type": "boolean", "default": False}},
         "required": ["worktree_id", "confirm"], "additionalProperties": False}},
    {"name": "worktree_merge", "description": "Merge a clean TEAMYRA worktree branch into its original target branch. Requires confirm=true and refuses dirty targets/worktrees.",
     "inputSchema": {"type": "object", "properties": {
         "worktree_id": {"type": "string"}, "confirm": {"type": "boolean", "default": False}},
         "required": ["worktree_id", "confirm"], "additionalProperties": False}},
    {"name": "worktree_discard", "description": "Remove a TEAMYRA worktree and branch. Requires confirm=true. Unmerged/dirty work requires force=true.",
     "inputSchema": {"type": "object", "properties": {
         "worktree_id": {"type": "string"}, "confirm": {"type": "boolean", "default": False},
         "force": {"type": "boolean", "default": False}},
         "required": ["worktree_id", "confirm"], "additionalProperties": False}},
    {"name": "start_task", "description": (
        "Start a worker job and return at once with its job_id (non-blocking). The worker runs in its own "
        "process with a live transcript. Follow it with job_wait, job_status/job_events, or run the returned "
        "follow_command as a background task (its exit signals completion). worker=auto picks the first idle "
        "worker without a usage cooldown in the configured order. With queue=true (default) a busy worker gets "
        "the job as state queued with queue_position. ChatGPT queues are shared unless pin=true; other "
        "providers share within their provider only with pool=true. expect_files requires non-empty output files. "
        "Not for drawing images: use codex_image_batch (Codex/gpt-image) or media_batch (Google Flow); see media_guide."),
     "inputSchema": {"type": "object", "properties": {
         "worker": W_ENUM, "project_path": {"type": "string"}, "task": {"type": "string"},
         "label": {"type": "string", "description": "short name shown in lists and the dashboard"},
         "timeout_minutes": {"type": "integer", "default": 90, "minimum": 1, "maximum": 360},
         "write": {"type": "boolean", "default": True},
         "pin": {"type": "boolean", "default": False, "description": "Keep the job on its assigned worker."},
         "pool": {"type": "boolean", "default": False, "description": "Allow idle workers of the same provider to take this queued job."},
         "expect_files": {"type": "array", "items": {"type": "string"}, "description": "Required non-empty output files, relative to project_path."},
         "auto_failover": {"type": "boolean", "description": "Automatically reassign eligible provider/worker failures. Defaults on when worker=auto."},
         "max_failovers": {"type": "integer", "default": 2, "minimum": 0, "maximum": 5},
         "queue": {"type": "boolean", "default": True,
                   "description": "When the chosen worker already has an active job (running, waiting_for_desktop, needs_user), create this job as queued (FIFO per worker) instead of running it concurrently. Its timeout counts from dispatch."}},
         "required": ["project_path", "task"], "additionalProperties": False}},
    {"name": "job_status", "description": "Compact status of one job, or of the 15 most recent jobs when job_id is omitted. Includes state, reason, exit_code, attention (a human must act, e.g. ChatGPT verification) and queue_position.",
     "inputSchema": {"type": "object", "properties": {"job_id": {"type": "string"}}, "additionalProperties": False}},
    {"name": "job_events", "description": "Incremental slice of a job's normalized events (commands, results, messages, file changes), each clipped to 300 chars. Pass the returned next as since.",
     "inputSchema": {"type": "object", "properties": {"job_id": {"type": "string"},
                     "since": {"type": "integer", "default": 0}, "limit": {"type": "integer", "default": 40}},
                     "required": ["job_id"], "additionalProperties": False}},
    {"name": "job_result", "description": "Final result of the terminal job in a failover chain, with chain lineage when reassignment occurred.",
     "inputSchema": {"type": "object", "properties": {"job_id": {"type": "string"}}, "required": ["job_id"], "additionalProperties": False}},
    {"name": "job_chain", "description": "Inspect root/child lineage for automatic failover and the current terminal job.",
     "inputSchema": {"type": "object", "properties": {"job_id": {"type": "string"}}, "required": ["job_id"], "additionalProperties": False}},
    {"name": "job_wait", "description": "Block until all (or any) of the jobs end, or timeout_seconds pass (max 3000; progress is reported every minute).",
     "inputSchema": {"type": "object", "properties": {"job_ids": {"type": "array", "items": {"type": "string"}},
                     "mode": {"type": "string", "enum": ["all", "any"], "default": "all"},
                     "timeout_seconds": {"type": "integer", "default": 1500}},
                     "required": ["job_ids"], "additionalProperties": False}},
    {"name": "job_handoff", "description": "Hand a completed job to another worker using a persistent structured envelope with source lineage, acceptance criteria, artifacts, and optional bounded project-memory context.",
     "inputSchema": {"type": "object", "properties": {
         "job_id": {"type": "string"}, "target_worker": W_ENUM,
         "message": {"type": "string", "description": "Requested action. Kept required for backward compatibility."},
         "objective": {"type": "string"},
         "constraints": {"type": "array", "maxItems": 24, "items": {"type": "string"}},
         "acceptance_criteria": {"type": "array", "maxItems": 24, "items": {"type": "string"}},
         "artifacts": {"type": "array", "maxItems": 24, "items": {"type": "string"}},
         "notes": {"type": "string"},
         "include_project_memory": {"type": "boolean", "default": True},
         "memory_query": {"type": "string"},
         "memory_max_chars": {"type": "integer", "default": 6000, "minimum": 1000, "maximum": 8000},
         "persist_memory": {"type": "boolean", "default": False},
         "write": {"type": "boolean", "default": False},
         "timeout_minutes": {"type": "integer", "default": 90, "minimum": 1, "maximum": 360}},
         "required": ["job_id", "message"], "additionalProperties": False}},
    {"name": "handoff_get", "description": "Read one persistent structured handoff envelope by handoff_id.",
     "inputSchema": {"type": "object", "properties": {
         "handoff_id": {"type": "string"}},
         "required": ["handoff_id"], "additionalProperties": False}},
    {"name": "handoff_list", "description": "List persistent structured handoffs, optionally scoped by project, source job, or target worker.",
     "inputSchema": {"type": "object", "properties": {
         "project_path": {"type": "string"},
         "source_job_id": {"type": "string"},
         "target_worker": {"type": "string"},
         "limit": {"type": "integer", "default": 100, "minimum": 1, "maximum": 500}},
         "additionalProperties": False}},
    {"name": "job_message", "description": "Send a follow-up message to a finished job's worker session (resumes the same Codex thread or Antigravity conversation in the same folder). Returns a new job_id.",
     "inputSchema": {"type": "object", "properties": {"job_id": {"type": "string"}, "message": {"type": "string"},
                     "timeout_minutes": {"type": "integer", "default": 60}},
                     "required": ["job_id", "message"], "additionalProperties": False}},
    {"name": "job_cancel", "description": "Stop a running job (kills the worker process tree).",
     "inputSchema": {"type": "object", "properties": {"job_id": {"type": "string"}}, "required": ["job_id"], "additionalProperties": False}},
    {"name": "worker_status", "description": "List all discovered workers/accounts with auth availability, provider, model, running jobs, current_job, queue_length and usage cooldown.",
     "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False}},
    {"name": "team_report", "description": (
        "Full team report in one call: every worker (provider, label, model/effort, ready + detail, cooldown, "
        "current job with label/state/elapsed/last_event/attention, queue with ids and labels, last finished jobs "
        "with state/reason/exit_code, usage totals) plus all jobs that need the user (e.g. ChatGPT verification). "
        "Use it to see every agent before delegating."),
     "inputSchema": {"type": "object", "properties": {
         "recent": {"type": "integer", "default": 5, "minimum": 1, "maximum": 20,
                    "description": "Finished jobs listed per worker."},
         "project_path": {"type": "string", "description": "Optional: restrict job history and usage to one project."}},
         "additionalProperties": False}},
    {"name": "queue_list", "description": "List queued jobs per worker in dispatch order (position 1 starts next), with each worker's current job.",
     "inputSchema": {"type": "object", "properties": {
         "worker": {"type": "string", "description": "Optional worker id; omit for all workers."}},
         "additionalProperties": False}},
    {"name": "queue_cancel", "description": "Cancel one queued (not yet dispatched) job. Use job_cancel for a job that already runs.",
     "inputSchema": {"type": "object", "properties": {"job_id": {"type": "string"}},
                     "required": ["job_id"], "additionalProperties": False}},
    {"name": "queue_move", "description": "Move one queued job to a new 1-based position in its worker's queue (1 = dispatched next).",
     "inputSchema": {"type": "object", "properties": {
         "job_id": {"type": "string"},
         "position": {"type": "integer", "minimum": 1}},
         "required": ["job_id", "position"], "additionalProperties": False}},
    {"name": "clear_worker_cooldown", "description": "Clear the usage-limit cooldown for one worker or all.",
     "inputSchema": {"type": "object", "properties": {"worker": {"type": "string"}}, "additionalProperties": False}},
    {"name": "run_ai_worker", "description": "Compatibility: start_task, then wait up to timeout_seconds. If the job is still running, returns its job_id instead of stopping it. Not for drawing images: use codex_image_batch or media_batch (see media_guide).",
     "inputSchema": {"type": "object", "properties": {"worker": W_ENUM, "project_path": {"type": "string"}, "task": {"type": "string"},
                     "timeout_seconds": {"type": "integer", "default": 1800, "minimum": 30, "maximum": 3000},
                     "write": {"type": "boolean", "default": True},
                     "pin": {"type": "boolean", "default": False},
                     "pool": {"type": "boolean", "default": False},
                     "expect_files": {"type": "array", "items": {"type": "string"}, "description": "Required non-empty output files, relative to project_path."},
                     "auto_failover": {"type": "boolean", "description": "Defaults on when worker=auto."},
                     "max_failovers": {"type": "integer", "default": 2, "minimum": 0, "maximum": 5},
                     "queue": {"type": "boolean", "default": True,
                   "description": "When the chosen worker already has an active job (running, waiting_for_desktop, needs_user), create this job as queued (FIFO per worker) instead of running it concurrently. Its timeout counts from dispatch."}},
                     "required": ["task", "project_path"], "additionalProperties": False}},
    {"name": "run_ai_parallel", "description": "Start up to three independent tasks, each in a new git worktree and branch under D:/AI-Orchestrator/worktrees, and return their job_ids (non-blocking).",
     "inputSchema": {"type": "object", "properties": {"project_path": {"type": "string"},
                     "tasks": {"type": "array", "minItems": 1, "maxItems": 3, "items": {"type": "object", "properties": {
                         "task": {"type": "string"}, "worker": W_ENUM, "label": {"type": "string"}},
                         "required": ["task"], "additionalProperties": False}},
                     "timeout_minutes": {"type": "integer", "default": 90}, "write": {"type": "boolean", "default": True},
                     "auto_failover": {"type": "boolean", "default": True},
                     "max_failovers": {"type": "integer", "default": 2, "minimum": 0, "maximum": 5}},
                     "required": ["tasks", "project_path"], "additionalProperties": False}},
]


def mcp_workspace_permissions(service):
    """Stored workspace permissions (ROOT/chatgpt/workspace.json) for MCP workspace_tool calls.

    The MCP path can only narrow them: full access and outside-workspace access are user-only
    switches of the desktop UI / interactive CLI and are never enabled through an MCP call.
    """
    try:
        stored = dict(service._load().get("permissions") or {})
    except Exception:
        stored = {}
    stored["full_access"] = False
    stored["outside_workspace"] = False
    return stored


def tool_call(name, a):
    if name == "provider_list":
        return desktop_control("provider.list", {})
    if name == "agent_account_create":
        return desktop_control("account.create", {
            "provider": a["provider"],
            "name": a.get("name"),
        })
    if name == "agent_account_update":
        return desktop_control("account.update", {
            "provider": a["provider"],
            "profile_id": a["profile_id"],
            "patch": a.get("patch") or {},
        })
    if name == "chatgpt_control":
        action = str(a["action"])
        payload = dict(a)
        payload.pop("action", None)
        return desktop_control("chatgpt." + action, payload)
    if name == "media_generate":
        result = media_engine.create_job(ROOT, a)
        surface = "music" if result.get("provider_surface") == "google-flow-music" else "visual"
        result["runtime"] = wake_media_surface(surface)
        return result
    if name == "media_guide":
        return media_guide.guide(ROOT)
    if name == "codex_image_batch":
        return codex_images.create_batch(ROOT, a["requests"], a["project_path"], max_parallel=a.get("max_parallel"),
                                         accounts=a.get("accounts"))
    if name == "codex_image_status":
        return codex_images.batch_status(ROOT, a["batch_id"])
    if name == "codex_image_cancel":
        return codex_images.cancel_batch(ROOT, a["batch_id"])
    if name == "media_batch":
        result = media_engine.create_batch(ROOT, a["requests"], max_parallel=a.get("max_parallel"))
        surfaces = {
            "music" if item.get("provider_surface") == "google-flow-music" else "visual"
            for item in result["jobs"]
        }
        for surface in surfaces:
            result.setdefault("runtime", {})[surface] = wake_media_surface(surface)
        return result
    if name == "media_transform":
        result = media_engine.create_transform_job(ROOT, a)
        surface = "music" if result.get("provider_surface") == "google-flow-music" else "visual"
        result["runtime"] = wake_media_surface(surface)
        return result
    if name == "media_capabilities":
        return {"video": {"generation_resolutions": ["360p", "720p"], "default_generation_resolution": "720p",
                          "default_download_quality": "1080p", "download_workflow": "Select 1080p Upscaled in the generated result's Download menu; wait for the actual file and verify its dimensions"},
                "sound_effect": {"generation_resolution": "360p", "download_quality": "source", "upscale": False,
                                 "workflow": "Generate a 360p source video, download original size, extract audio with FFmpeg, return an audio-only file"},
                "omni_references": {"mode": "ingredients", "references": "Exact TEAMYRA asset IDs or project-local images attach directly in the prompt box and are verified before Generate",
                                    "exact_first_frame": False, "exact_last_frame": False,
                                    "first_frame_alias": "Accepted as an image ingredient, without an exact opening-frame guarantee", "last_frame": "Rejected before generation"},
                "runtime": "Desktop-dependent requests cold-start the app hidden; active jobs retain the browser, idle views unload after a grace period"}
    if name == "media_status":
        media_support.sweep_tickets(ROOT, media_helper_state)
        return media_engine.job_status(ROOT, a.get("job_id"), a.get("limit", 30), a.get("batch_id"), compact=True)
    if name == "media_recover":
        result = media_engine.recover_job(ROOT, a["job_id"], helper_ticket=a.get("ticket_id"))
        if result["recovered"]:
            job = media_engine.load_job(ROOT, a["job_id"])
            result["runtime"] = wake_media_surface(job["request"]["surface"])
        return result
    if name == "media_assets":
        return media_engine.list_assets(
            ROOT, a.get("project_path"), a.get("asset_id"), a.get("type"), a.get("limit", 100)
        )
    if name == "media_cancel":
        if a.get("batch_id") and not a.get("job_id"):
            return media_engine.cancel_batch(ROOT, a["batch_id"])
        if not a.get("job_id"):
            raise ValueError("job_id or batch_id is required")
        return media_engine.cancel_job(ROOT, a["job_id"])
    if name == "media_resume_auth":
        result = media_engine.resume_auth_jobs(ROOT)
        surfaces = {media_engine.load_job(ROOT, job_id)["request"]["surface"]
                    for job_id in result["resumed"] + result["reconcile_required"]}
        for surface in surfaces:
            result.setdefault("runtime", {})[surface] = wake_media_surface(surface)
        return result
    if name == "media_report_issue":
        if a.get("take_over", True) is False:
            jobs = list(a.get("job_ids") or [])
            snapshots = [media_support.job_snapshot(ROOT, job_id) for job_id in jobs[:50]]
            issue = media_support.log_issue(
                ROOT, source="agent_report", summary=a["description"], details=a.get("instructions"),
                category=(snapshots[0]["failure"].get("category") if snapshots else None) or "reported",
                job_ids=jobs, batch_id=a.get("batch_id"), reporter=a.get("reporter"),
                project_path=snapshots[0]["project_path"] if snapshots else None)
            return {"issue_id": issue["issue_id"], "logged": True, "helper": None}
        ticket = media_support.create_ticket(
            ROOT, kind="issue", reporter=a.get("reporter"), description=a["description"],
            job_ids=a.get("job_ids") or [], batch_id=a.get("batch_id"), instructions=a.get("instructions"))
        dispatch = dispatch_media_helper(ticket["ticket_id"])
        return {"ticket_id": ticket["ticket_id"], "issue_id": ticket["issue_id"], "helper": dispatch,
                "jobs": ticket.get("assisted_jobs"),
                "next": "Stop retrying these jobs. A TEAMYRA helper agent is handling them; poll media_ticket_status "
                        "or your job ids. Results are delivered into the same job ids."}
    if name == "media_delegate":
        ticket = media_support.create_ticket(
            ROOT, kind="delegate", reporter=a.get("reporter"), description=a["description"],
            project_path=a["project_path"], requests=a.get("requests") or [], instructions=a.get("instructions"))
        dispatch = dispatch_media_helper(ticket["ticket_id"])
        return {"ticket_id": ticket["ticket_id"], "issue_id": ticket["issue_id"], "helper": dispatch,
                "requests": len(ticket.get("requests") or []),
                "next": "The helper agent generates and delivers these. Poll media_ticket_status; do not generate them yourself."}
    if name == "media_ticket_status":
        media_support.sweep_tickets(ROOT, media_helper_state)
        ticket = media_support._load_ticket(ROOT, a["ticket_id"])
        return media_support.ticket_status(ROOT, a["ticket_id"], media_helper_state(ticket))
    if name == "media_ticket_update":
        ticket = media_support.update_ticket(ROOT, a["ticket_id"], status=a.get("status"), note=a.get("note"),
                                             by=a.get("by"), summary=a.get("summary"))
        return media_support.ticket_status(ROOT, ticket["ticket_id"], media_helper_state(ticket))
    if name == "media_ticket_deliver":
        ticket = media_support.deliver(ROOT, a["ticket_id"], a["asset_id"], original_job_id=a.get("original_job_id"),
                                       item=a.get("item"), note=a.get("note"), by=a.get("by"))
        return media_support.ticket_status(ROOT, ticket["ticket_id"], media_helper_state(ticket))
    if name == "media_issues":
        return media_support.list_issues(ROOT, a.get("status"), a.get("category"), a.get("source"), a.get("limit", 50),
                                         area="media")
    if name == "maintenance_report":
        issue = media_support.log_issue(
            ROOT, source="agent_report", area=a.get("area") or "other", summary=a["summary"],
            details=a.get("details"), category=a.get("category") or "reported", reporter=a.get("reporter"),
            severity=a.get("severity"), refs=a.get("refs") or [], project_path=a.get("project_path"))
        return {"issue_id": issue["issue_id"], "logged": True,
                "next": "Logged for the TEAMYRA maintenance team. Continue your work; this does not fix anything by itself."}
    if name == "maintenance_issues":
        return media_support.list_issues(ROOT, a.get("status"), a.get("category"), a.get("source"), a.get("limit", 50),
                                         area=a.get("area"))
    if name == "media_issue_update":
        return media_support.update_issue(ROOT, a["issue_id"], status=a.get("status"), note=a.get("note"), by=a.get("by"))
    if name == "media_resume_download":
        result = media_engine.resume_download_job(ROOT, a["job_id"], helper_ticket=a.get("ticket_id"))
        surface = "music" if result.get("provider_surface") == "google-flow-music" else "visual"
        result["runtime"] = wake_media_surface(surface)
        return result
    if name == "timeline_list":
        return observability.timeline(
            ROOT,
            a.get("limit", 100),
            a.get("project_path"),
            a.get("worker"),
            a.get("sources"),
            a.get("query"),
            a.get("since"),
        )
    if name == "logs_search":
        return observability.search_logs(
            ROOT,
            a["query"],
            a.get("limit", 50),
            a.get("project_path"),
            a.get("worker"),
            a.get("kinds"),
        )
    if name == "usage_snapshot":
        return observability.usage_snapshot(
            ROOT,
            worker_status(),
            a.get("project_path"),
        )
    if name == "workspace_tool":
        actor = "teamyra-mcp"
        if a.get("agent"):
            actor += ":" + str(a["agent"])[:80]
        service = workspace_tools.WorkspaceToolService(ROOT)
        return service.execute_in_workspace(
            a["project_path"],
            a["tool"],
            a.get("args"),
            permissions=mcp_workspace_permissions(service),
            trusted=True,
            actor=actor,
            confirm=a.get("confirm") is True,
        )
    if name == "memory_add":
        return project_memory.add(
            ROOT, a["project_path"], a["kind"], a["title"], a["content"],
            a.get("tags"), a.get("importance", "normal"),
            a.get("source_job_id"), a.get("source_graph_id"),
        )
    if name == "memory_list":
        return project_memory.list_entries(
            ROOT, a["project_path"], a.get("kind"), a.get("status", "active"),
            a.get("tag"), a.get("limit", 100),
        )
    if name == "memory_search":
        return project_memory.search(
            ROOT, a["project_path"], a["query"], a.get("kinds"), a.get("tags"),
            a.get("status", "active"), a.get("limit", 50),
        )
    if name == "memory_get":
        return project_memory.get(ROOT, a["project_path"], a["memory_id"])
    if name == "memory_update":
        patch = {
            key: a[key]
            for key in ("title", "content", "tags", "importance", "kind")
            if key in a
        }
        return project_memory.update(ROOT, a["project_path"], a["memory_id"], **patch)
    if name == "memory_archive":
        return project_memory.archive(ROOT, a["project_path"], a["memory_id"], a.get("reason"))
    if name == "memory_context":
        return project_memory.context_pack(
            ROOT, a["project_path"], a.get("query"), a.get("kinds"), a.get("tags"),
            a.get("max_chars", 8000), a.get("limit", 40),
        )
    if name == "review_start":
        return start_review_cycle(
            a["job_id"],
            a.get("reviewer_worker", "auto"),
            a.get("max_rounds", 2),
            a.get("allow_self_review", False),
        )
    if name == "review_status":
        return review_cycle.summary(review_cycle.load(ROOT, a["review_id"]))
    if name == "review_cancel":
        state = review_cycle.load(ROOT, a["review_id"])
        state["cancel_requested"] = True
        review_cycle.save(ROOT, state)
        return review_cycle.summary(state)
    if name == "recovery_scan":
        return recovery.recover_all(ROOT, BRIDGE, PYTHON)
    if name == "mcp_pool_list":
        return mcp_pool.list_servers(ROOT)
    if name == "mcp_pool_tools":
        return mcp_pool.list_tools(ROOT, a["server"], a.get("refresh", False))
    if name == "mcp_pool_call":
        return mcp_pool.call_tool(
            ROOT,
            a["server"],
            a["tool_name"],
            a.get("arguments") or {},
            a.get("timeout_seconds", 30),
        )
    if name == "mcp_pool_register":
        if a.get("confirm") is not True:
            raise ValueError("mcp_pool_register requires confirm=true")
        return mcp_pool.register(
            ROOT,
            a["server"],
            a["command"],
            a.get("cwd"),
            a.get("env") or {},
            a.get("enabled", True),
            a.get("timeout_seconds", 30),
        )
    if name == "mcp_pool_restart":
        if a.get("confirm") is not True:
            raise ValueError("mcp_pool_restart requires confirm=true")
        return mcp_pool.restart(ROOT, a["server"])
    if name == "mcp_pool_remove":
        if a.get("confirm") is not True:
            raise ValueError("mcp_pool_remove requires confirm=true")
        return mcp_pool.remove(ROOT, a["server"])
    if name == "test_run":
        project_path = Path(a["project_path"]).resolve()
        if not project_path.exists():
            raise ValueError(f"project_path not found: {project_path}")
        return test_policy.run_steps(a["tests"], project_path)
    if name == "graph_create":
        project_path = Path(a["project_path"]).resolve()
        if not project_path.exists():
            raise ValueError(f"project_path not found: {project_path}")
        graph = task_graph.create_graph(
            ROOT, a.get("title"), project_path, a["nodes"], a.get("objective"), a.get("max_parallel", 1)
        )
        return task_graph.graph_summary(graph)
    if name == "graph_start":
        return start_conductor(a["graph_id"])
    if name == "graph_status":
        return task_graph.graph_summary(task_graph.load_graph(ROOT, a["graph_id"]))
    if name == "graph_cancel":
        graph = task_graph.load_graph(ROOT, a["graph_id"])
        graph["cancel_requested"] = True
        task_graph.save_graph(ROOT, graph)
        return task_graph.graph_summary(graph)
    if name == "graph_approve":
        graph = task_graph.load_graph(ROOT, a["graph_id"])
        node = task_graph.decide_approval(graph, a["node_id"], a["decision"], a.get("note"))
        pending = [item for item in graph.get("approval_pending_node_ids", []) if item != node["id"]]
        graph["approval_pending_node_ids"] = pending
        graph["approval_pending_node_id"] = pending[0] if pending else None
        if a["decision"] == "approve" and graph.get("state") == "awaiting_approval":
            graph["state"] = "running"
        elif a["decision"] == "deny":
            task_graph.terminalize_graph(graph)
        task_graph.save_graph(ROOT, graph)
        return task_graph.graph_summary(graph)
    if name == "worktree_create":
        return worktree_manager.create(
            a["project_path"], WORKTREES, a.get("label") or "task", a.get("base_ref", "HEAD")
        )
    if name == "worktree_list":
        return worktree_manager.list_managed(WORKTREES)
    if name == "worktree_status":
        return worktree_manager.status(WORKTREES, a["worktree_id"])
    if name == "worktree_diff":
        return worktree_manager.diff(WORKTREES, a["worktree_id"], a.get("max_chars", 50000))
    if name == "worktree_rebase":
        if a.get("confirm") is not True:
            raise ValueError("worktree_rebase requires confirm=true")
        return worktree_manager.rebase(WORKTREES, a["worktree_id"])
    if name == "worktree_merge":
        if a.get("confirm") is not True:
            raise ValueError("worktree_merge requires confirm=true")
        return worktree_manager.merge(WORKTREES, a["worktree_id"])
    if name == "worktree_discard":
        if a.get("confirm") is not True:
            raise ValueError("worktree_discard requires confirm=true")
        return worktree_manager.discard(WORKTREES, a["worktree_id"], a.get("force", False))
    if name == "start_task":
        requested_worker = a.get("worker", "auto")
        auto_failover = a.get("auto_failover", requested_worker == "auto")
        job_id, worker = start_job(
            requested_worker, a["task"], a["project_path"], a.get("label"),
            a.get("timeout_minutes", 90), a.get("write", True),
            auto_failover=auto_failover, max_failovers=a.get("max_failovers"),
            queue=a.get("queue", True),
            pin=a.get("pin", False), pool=a.get("pool", False), expect_files=a.get("expect_files"),
        )
        result = {"job_id": job_id, "worker": worker, "auto_failover": auto_failover, **follow_info(job_id)}
        hint = media_guide.image_task_hint(a["task"], worker)
        if hint:
            result["hint"] = hint
        try:
            meta = read_meta(job_id)
            result["state"] = meta.get("state")
            if meta.get("state") == scheduler.QUEUED:
                result["queue_position"] = meta.get("queue_position")
        except Exception:
            pass
        return result
    if name == "job_status":
        if a.get("job_id"):
            return summary(read_meta(a["job_id"]))
        return [summary(m) for m in all_jobs()[:15]]
    if name == "job_events":
        return job_events(a["job_id"], a.get("since", 0), a.get("limit", 40))
    if name == "job_result":
        return job_result(a["job_id"])
    if name == "job_chain":
        return chain_summary(a["job_id"])
    if name == "job_wait":
        return job_wait(a["job_ids"], a.get("mode", "all"), a.get("timeout_seconds", 1500))
    if name == "job_handoff":
        terminal_id = failover_terminal_job_id(a["job_id"])
        source = read_meta(terminal_id)
        if not chain_is_complete(a["job_id"]):
            raise ValueError("source job is still running")
        requested = a.get("target_worker", "auto")
        target = requested
        if requested == "auto":
            target = pick_worker("auto", exclude=[source.get("worker")] if source.get("worker") else [])

        record, source, terminal_id = prepare_handoff_record(a["job_id"], target, a)
        prompt = handoff_task(a["job_id"], a["message"], record)
        job_id, worker = start_job(
            target,
            prompt,
            source["cwd"],
            record.get("label") or f"handoff from {source.get('label') or a['job_id']}"[:80],
            a.get("timeout_minutes", 90),
            a.get("write", False),
            parent=terminal_id,
            auto_failover=requested == "auto",
            max_failovers=config().get("max_failovers", 2),
        )
        record = handoff_store.attach_target_job(ROOT, record["id"], job_id, worker)

        memory_entry_id = None
        if a.get("persist_memory", False):
            try:
                memory_entry = project_memory.add(
                    ROOT,
                    source["cwd"],
                    "handoff",
                    (a.get("objective") or record.get("label") or "Agent handoff")[:200],
                    (
                        f"Handoff {record['id']} from {source.get('worker')} to {worker}. "
                        f"Source job {a['job_id']} -> target job {job_id}. "
                        f"Requested action: {a['message']}"
                    ),
                    tags=["handoff", str(source.get("worker") or ""), str(worker or "")],
                    importance="normal",
                    source_job_id=a["job_id"],
                )
                memory_entry_id = memory_entry["id"]
                record["memory_entry_id"] = memory_entry_id
                handoff_store.save(ROOT, record)
            except Exception as exc:
                record["memory_persist_error"] = clip(str(exc), 300)
                handoff_store.save(ROOT, record)

        patch_job_meta(
            job_id,
            handoff_id=record["id"],
            handoff_from_job_id=a["job_id"],
            handoff_from_terminal_job_id=terminal_id,
            handoff_from_worker=source.get("worker"),
            handoff_memory_entry_id=memory_entry_id,
        )
        return {
            "job_id": job_id,
            "worker": worker,
            "source_job_id": a["job_id"],
            "handoff_id": record["id"],
            "handoff": handoff_store.summary(record),
            "memory_entry_id": memory_entry_id,
            **follow_info(job_id),
        }
    if name == "handoff_get":
        return handoff_store.load(ROOT, a["handoff_id"])
    if name == "handoff_list":
        return handoff_store.list_records(
            ROOT,
            a.get("project_path"),
            a.get("source_job_id"),
            a.get("target_worker"),
            a.get("limit", 100),
        )
    if name == "job_message":
        terminal_id = failover_terminal_job_id(a["job_id"])
        m = read_meta(terminal_id)
        if not is_done(m["id"]):
            raise ValueError("job is still running; wait for it or cancel it first")
        if not m.get("session_id"):
            raise ValueError("that job has no worker session id to resume")
        job_id, worker = start_job(m["worker"], a["message"], m["cwd"], f"follow-up: {m['label']}"[:80],
                                   a.get("timeout_minutes", 60), m.get("write", True), m["session_id"], m["id"])
        return {"job_id": job_id, "worker": worker, **follow_info(job_id)}
    if name == "job_cancel":
        terminal_id = failover_terminal_job_id(a["job_id"])
        terminal = read_meta(terminal_id)
        if terminal.get("state") == scheduler.QUEUED and not is_done(terminal_id):
            try:
                scheduler.queue_cancel(jobs_root(), terminal_id)
                return {"ok": True, "job_id": a["job_id"], "cancelled_job_id": terminal_id,
                        "note": "the job was still queued and never started"}
            except ValueError:
                pass  # dispatched meanwhile: cancel it like a running job
        (JOBS / terminal_id / "CANCEL").write_text("cancel", encoding="utf-8")
        return {"ok": True, "job_id": a["job_id"], "cancelled_job_id": terminal_id,
                "note": "the active terminal worker stops within a few seconds"}
    if name == "worker_status":
        return worker_status()
    if name == "team_report":
        return observability.team_report(
            jobs_root(), worker_status(), a.get("recent", 5), a.get("project_path"),
        )
    if name == "queue_list":
        return scheduler.queue_list(jobs_root(), a.get("worker"))
    if name == "queue_cancel":
        return scheduler.queue_cancel(jobs_root(), a["job_id"])
    if name == "queue_move":
        return scheduler.queue_move(jobs_root(), a["job_id"], a["position"])
    if name == "clear_worker_cooldown":
        try:
            data = json.loads(COOLDOWN_FILE.read_text(encoding="utf-8"))
        except Exception:
            data = {}
        for w in ([a["worker"]] if a.get("worker") else worker_ids()):
            data[w] = time.time()
        COOLDOWN_FILE.write_text(json.dumps(data), encoding="utf-8")
        return {"ok": True, "worker": a.get("worker") or "all"}
    if name == "run_ai_worker":
        requested_worker = a.get("worker", "auto")
        auto_failover = a.get("auto_failover", requested_worker == "auto")
        job_id, worker = start_job(
            requested_worker, a["task"], a["project_path"], a.get("label"),
            a.get("timeout_minutes", int(config().get("job_timeout_minutes", 180))), a.get("write", True),
            auto_failover=auto_failover, max_failovers=a.get("max_failovers"),
            queue=a.get("queue", True),
            pin=a.get("pin", False), pool=a.get("pool", False), expect_files=a.get("expect_files"),
        )
        waited = job_wait([job_id], "all", a.get("timeout_seconds", 1800))
        res = job_result(job_id) if not waited["timed_out"] else {**chain_summary(job_id), "still_running": True}
        hint = media_guide.image_task_hint(a["task"], worker)
        return {**res, **follow_info(job_id), **({"hint": hint} if hint else {})}
    if name == "run_ai_parallel":
        started = []
        for i, t in enumerate(a["tasks"], 1):
            worker = pick_worker(t.get("worker", "auto"))
            wt = create_worktree(a["project_path"], worker, i)
            path, branch = wt["path"], wt["branch"]
            job_id, worker = start_job(
                worker, t["task"], path, t.get("label"), a.get("timeout_minutes", 90), a.get("write", True),
                auto_failover=a.get("auto_failover", True), max_failovers=a.get("max_failovers"),
            )
            patch_job_meta(job_id, worktree_id=wt["id"], worktree_branch=branch)
            started.append({"job_id": job_id, "worker": worker, "worktree_id": wt["id"],
                            "worktree": path, "branch": branch,
                            "auto_failover": a.get("auto_failover", True), **follow_info(job_id)})
        return started
    raise ValueError("Unknown tool: " + name)


MCP_NAMESPACE = "teamyra."
MCP_SERVER_NAME = "teamyra"
MCP_SERVER_VERSION = "0.2.0"
MCP_SUPPORTED_PROTOCOLS = ("2025-11-25", "2025-06-18", "2025-03-26")
MCP_DEFAULT_PROTOCOL = MCP_SUPPORTED_PROTOCOLS[0]


def negotiate_protocol(requested):
    requested = str(requested or "").strip()
    return requested if requested in MCP_SUPPORTED_PROTOCOLS else MCP_DEFAULT_PROTOCOL


def canonical_tool_name(name):
    name = str(name or "")
    return name[len(MCP_NAMESPACE):] if name.startswith(MCP_NAMESPACE) else name


def mcp_tools(include_legacy=True):
    canonical = []
    for tool in TOOLS:
        item = dict(tool)
        item["name"] = MCP_NAMESPACE + tool["name"]
        canonical.append(item)
    if not include_legacy:
        return canonical
    legacy = []
    for tool in TOOLS:
        item = dict(tool)
        item["description"] = "Legacy alias. " + str(tool.get("description") or "")
        legacy.append(item)
    return canonical + legacy


# --- MCP plumbing ------------------------------------------------------------------------------
def send(obj):
    line = json.dumps(obj, ensure_ascii=False, separators=(",", ":")) + "\n"
    with SEND_LOCK:
        sys.stdout.write(line)
        sys.stdout.flush()


def heartbeat(token, done, every=60):
    # Claude Code drops a call after 30 min without a response or progress.
    n = 0
    while not done.wait(every):
        n += 1
        send({"jsonrpc": "2.0", "method": "notifications/progress",
              "params": {"progressToken": token, "progress": n, "message": f"waiting ({n} min)"}})


def handle(msg):
    method, req_id = msg.get("method"), msg.get("id")
    if method == "initialize":
        return {"jsonrpc": "2.0", "id": req_id, "result": {
            "protocolVersion": negotiate_protocol(msg.get("params", {}).get("protocolVersion")),
            "capabilities": {"tools": {"listChanged": False}},
            "serverInfo": {
                "name": MCP_SERVER_NAME,
                "title": "TEAMYRA Multi-Agent Engineering OS",
                "version": MCP_SERVER_VERSION,
                "description": "Local-first multi-agent orchestration, testing, worktrees, reviews and worker routing."
            },
            "instructions": media_guide.INSTRUCTIONS}}
    if method == "ping":
        return {"jsonrpc": "2.0", "id": req_id, "result": {}}
    if method == "tools/list":
        return {"jsonrpc": "2.0", "id": req_id, "result": {"tools": mcp_tools(include_legacy=True)}}
    if method == "tools/call":
        params = msg.get("params", {})
        try:
            result = tool_call(canonical_tool_name(params.get("name")), params.get("arguments") or {})
            return {"jsonrpc": "2.0", "id": req_id, "result": {
                "content": [{"type": "text", "text": json.dumps(result, ensure_ascii=False, indent=1)}], "isError": False}}
        except Exception as e:
            return {"jsonrpc": "2.0", "id": req_id, "result": {
                "content": [{"type": "text", "text": json.dumps({"ok": False, "error": str(e)}, ensure_ascii=False)}],
                "isError": True}}
    if req_id is not None:
        return {"jsonrpc": "2.0", "id": req_id, "error": {"code": -32601, "message": f"Method not found: {method}"}}
    return None


def handle_and_send(msg):
    done = threading.Event()
    token = ((msg.get("params") or {}).get("_meta") or {}).get("progressToken")
    if token is not None:
        threading.Thread(target=heartbeat, args=(token, done), daemon=True).start()
    try:
        response = handle(msg)
        if response is not None:
            send(response)
    except Exception as e:
        print("TEAMYRA MCP error:", e, file=sys.stderr, flush=True)
    finally:
        done.set()


def main():
    try:
        import dashboard
        dashboard.serve(int(config().get("dashboard_port", 8765)))
    except Exception as e:
        print("dashboard not started:", e, file=sys.stderr, flush=True)
    try:
        start_background_services()
    except Exception as e:
        print("scheduler not started:", e, file=sys.stderr, flush=True)
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except ValueError as e:
            print("TEAMYRA MCP error:", e, file=sys.stderr, flush=True)
            continue
        if msg.get("method") == "tools/call":  # calls can block for long: one thread each
            threading.Thread(target=handle_and_send, args=(msg,), daemon=True).start()
        else:
            handle_and_send(msg)


if __name__ == "__main__":
    sys.path.insert(0, str(BRIDGE))
    main()
