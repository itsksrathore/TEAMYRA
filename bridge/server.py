"""ai-workers MCP bridge, v2: asynchronous worker jobs with live transcripts.

Every task runs as a job in D:/AI-Orchestrator/jobs/<job_id>/, executed by runner.py
in its own process, so a bridge restart or an MCP timeout never stops a worker.
Claude starts jobs, follows them (follow.py as a background task, or the dashboard),
reads compact results, sends follow-up messages and cancels them.
"""
import json, os, subprocess, sys, threading, time, uuid
from pathlib import Path
from worker_registry import build_worker_registry
from runtime_paths import codex_launch, agy_launch, claude_launch

sys.stdin.reconfigure(encoding="utf-8")
sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")

BRIDGE = Path(__file__).resolve().parent
ROOT = BRIDGE.parent
JOBS = ROOT / "jobs"
LOGS = ROOT / "logs"
WORKTREES = ROOT / "worktrees"
CONFIG = BRIDGE / "config.json"
COOLDOWN_FILE = JOBS / "_cooldown_cleared.json"
PYTHON = Path(sys.executable)
COOLDOWN_SECONDS = 1800
# Sent when runner.py auto-resumes a worker session that died mid-run.
RESUME_MESSAGE = ("Your previous run on this task was interrupted: the worker process exited unexpectedly. "
                  "Check git status, git log and your last steps, then continue the same task from where you "
                  "stopped. Do not redo finished work, and finish everything the original task asked for.")
SEND_LOCK = threading.Lock()
AUTH_CACHE = {}
AUTH_CACHE_SECONDS = 20
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


def worker_auth_status(info, use_cache=True):
    worker = info["id"]
    now = time.time()
    cached = AUTH_CACHE.get(worker)
    if use_cache and cached and now - cached["at"] < AUTH_CACHE_SECONDS:
        return cached["ready"], cached["detail"]

    provider = info["provider"]
    try:
        if provider == "codex":
            launch = codex_launch()
            if not launch:
                raise RuntimeError("Codex CLI not found")
            rc, out, err = run([*launch, "login", "status"],
                                env={"CODEX_HOME": str(info["home"])}, timeout=20)
            detail = (out + err).strip()
            ready = rc == 0 and "not logged in" not in detail.lower()
        elif provider == "claude":
            launch = claude_launch()
            if not launch:
                raise RuntimeError("Claude Code CLI not found")
            env = {}
            if not info.get("native"):
                env["CLAUDE_CONFIG_DIR"] = str(info["home"])
            rc, out, err = run([*launch, "auth", "status", "--json"], env=env, timeout=20)
            detail = (out + err).strip()
            ready = rc == 0
        elif provider == "antigravity":
            launch = agy_launch()
            if not launch:
                raise RuntimeError("Antigravity CLI not found")
            rc, out, err = run([*launch, "models"], timeout=30)
            detail = (out + err).strip()
            ready = rc == 0 and bool(out.strip())
        else:
            ready, detail = False, "unsupported provider"
    except Exception as exc:
        ready, detail = False, str(exc)

    AUTH_CACHE[worker] = {"at": now, "ready": ready, "detail": detail}
    return ready, detail


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
def codex_cmd(task, cwd, write, final_path, session_id=None, settings=None):
    c = settings or config().get("codex", {})
    launch = codex_launch()
    if not launch:
        raise RuntimeError("Codex CLI not found. Install Codex or set TEAMYRA_CODEX / TEAMYRA_CODEX_JS.")
    base = [*launch,
            "-c", f'model="{c.get("model", "gpt-6.1-sol")}"',
            "-c", f'model_reasoning_effort="{c.get("effort", "high")}"']
    if session_id:  # resume has no --approve-for-me / -C: pass the same settings as config
        policy = (["-c", 'approval_policy="on-request"', "-c", 'approvals_reviewer="auto_review"',
                   "-c", 'sandbox_mode="workspace-write"'] if write else ["-c", 'sandbox_mode="read-only"'])
        return base + policy + ["exec", "resume", "--json", "-o", str(final_path), session_id, task]
    mode = ["--approve-for-me"] if write else ["--sandbox", "read-only"]
    return base + ["exec", "--json", *mode, "-C", str(cwd), "-o", str(final_path), task]


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


def pick_worker(worker):
    registry = worker_registry()
    if worker != "auto":
        return worker

    configured = [w for w in config().get("auto_order", [])
                  if w in registry and registry[w].get("enabled", True)]
    discovered = sorted(
        (w for w in registry if w not in configured and registry[w].get("enabled", True)),
        key=lambda w: (registry[w].get("priority", 100), w),
    )
    order = configured + discovered
    if not order:
        raise ValueError("no enabled workers are configured or discovered")

    free = [w for w in order if not cooldown_left(w)]
    idle = [w for w in free if not running_jobs(w)]
    candidates = idle + [w for w in free if w not in idle]
    for candidate in candidates:
        ready, _ = worker_auth_status(registry[candidate])
        if ready:
            return candidate
    raise ValueError("no authenticated worker is currently ready")


def start_job(worker, task, project_path, label=None, timeout_minutes=90, write=True,
              session_id=None, parent=None):
    cwd = Path(project_path).resolve()
    if not cwd.exists():
        raise ValueError(f"project_path not found: {cwd}")
    worker = pick_worker(worker)
    registry = worker_registry()
    if worker not in registry:
        raise ValueError(f"unknown worker: {worker}")
    worker_info = registry[worker]
    # enabled controls automatic routing only; explicit/manual worker selection remains allowed.
    provider = worker_info["provider"]
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
    if provider == "codex":
        cmd = codex_cmd(task, cwd, write, final_path, session_id, settings)
        env = {"CODEX_HOME": str(worker_info["home"])}
        resume_cmd = codex_cmd(RESUME_MESSAGE, cwd, write, final_path, "{SESSION}", settings)
    elif provider == "claude":
        cmd = claude_cmd(task, cwd, write, session_id, settings)
        env = {}
        if not worker_info.get("native"):
            env["CLAUDE_CONFIG_DIR"] = str(worker_info["home"])
        resume_cmd = claude_cmd(RESUME_MESSAGE, cwd, write, "{SESSION}", settings)
    elif provider == "antigravity":
        cmd, env = agy_cmd(task, cwd, write, timeout, session_id), {}
        resume_cmd = agy_cmd(RESUME_MESSAGE, cwd, write, timeout, "{SESSION}")
    else:
        raise ValueError(f"unsupported worker provider: {provider}")
    head = git(cwd, "rev-parse", "HEAD")
    meta = {"id": job_id, "label": label or clip(task.splitlines()[0] if task else job_id, 80),
            "worker": worker, "provider": provider, "worker_label": worker_info.get("label"),
            "profile_id": worker_info.get("profile_id"), "state": "starting", "cwd": str(cwd), "write": write,
            "created": time.time(), "head_start": head, "branch": git(cwd, "rev-parse", "--abbrev-ref", "HEAD"),
            "parent": parent, "resumed_session": session_id, "timeout_s": timeout}
    (jdir / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8")
    (jdir / "task.txt").write_text(task, encoding="utf-8")
    (jdir / "spec.json").write_text(json.dumps({"worker": worker, "provider": provider, "cmd": cmd, "cwd": str(cwd), "env": env,
                                                 "timeout": timeout, "final_path": str(final_path),
                                                 "resume_cmd": resume_cmd,
                                                 "auto_resume": int(config().get("auto_resume", 2))},
                                                ensure_ascii=False, indent=1), encoding="utf-8")
    (jdir / "transcript.md").write_text(f"# {meta['label']}\n{worker} | {cwd} | {meta['branch']} @ {head}\n\n",
                                        encoding="utf-8")
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0) | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
    log = open(jdir / "runner.log", "w", encoding="utf-8")
    try:  # break away from the MCP server's job object so a bridge restart does not kill the job
        subprocess.Popen([str(PYTHON), str(BRIDGE / "runner.py"), str(jdir)], cwd=str(cwd),
                         stdin=subprocess.DEVNULL, stdout=log, stderr=log, close_fds=True,
                         creationflags=flags | 0x01000000)
    except OSError:
        subprocess.Popen([str(PYTHON), str(BRIDGE / "runner.py"), str(jdir)], cwd=str(cwd),
                         stdin=subprocess.DEVNULL, stdout=log, stderr=log, close_fds=True,
                         creationflags=flags)
    return job_id, worker


# --- views ---------------------------------------------------------------------------------
def summary(m, events=True):
    out = {k: m.get(k) for k in ("id", "label", "worker", "state", "reason", "branch", "session_id",
                                 "exit_code", "last_event")}
    start, end = m.get("started") or m.get("created"), m.get("ended") or time.time()
    out["elapsed_s"] = int(end - start) if start else None
    if m.get("usage"):
        out["usage"] = m["usage"]
    if not events:
        out.pop("last_event", None)
    return out


def follow_info(job_id):
    return {"follow_command": f'"{PYTHON}" "{BRIDGE / "follow.py"}" {job_id}',
            "dashboard": f"http://127.0.0.1:{config().get('dashboard_port', 8765)}/",
            "transcript": str(JOBS / job_id / "transcript.md")}


def job_result(job_id):
    m = read_meta(job_id)
    res = summary(m)
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


def job_wait(job_ids, mode="all", timeout_seconds=1500):
    ids = [job_ids] if isinstance(job_ids, str) else list(job_ids)
    for j in ids:
        read_meta(j)
    deadline = time.time() + max(5, min(int(timeout_seconds), 3000))
    while time.time() < deadline:
        done = [j for j in ids if is_done(j)]
        if (mode == "any" and done) or len(done) == len(ids):
            break
        time.sleep(5)
    return {"timed_out": not all(is_done(j) for j in ids) if mode == "all" else not any(is_done(j) for j in ids),
            "jobs": [summary(read_meta(j)) for j in ids]}


def worker_status():
    out = []
    registry = worker_registry()
    for w, info in registry.items():
        provider = info["provider"]
        ready, text = worker_auth_status(info, use_cache=False)
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
        item["running_jobs"] = [m["id"] for m in running_jobs(w)]
        item["cooldown_seconds"] = cooldown_left(w)
        if item["cooldown_seconds"]:
            item["ready"] = False
    return out


def create_worktree(project_path, worker, idx):
    root = git(project_path, "rev-parse", "--show-toplevel")
    if not root:
        raise ValueError("run_ai_parallel needs a git repository")
    stamp = time.strftime("%Y%m%d-%H%M%S")
    branch = f"ai/{worker}/{stamp}-{idx}-{uuid.uuid4().hex[:4]}"
    path = WORKTREES / f"{Path(root).name}-{stamp}-{idx}-{worker}"
    rc, _, err = run(["git", "-C", root, "worktree", "add", "-b", branch, str(path), "HEAD"])
    if rc != 0:
        raise ValueError(f"git worktree add failed: {clip(err, 400)}")
    return str(path), branch


# --- MCP tools -------------------------------------------------------------------------------
W_ENUM = {"type": "string", "default": "auto",
          "description": "Use auto or any worker id returned by worker_status. Dynamic Codex profiles are discovered at runtime."}
TOOLS = [
    {"name": "start_task", "description": (
        "Start a worker job and return at once with its job_id (non-blocking). The worker runs in its own "
        "process with a live transcript. Follow it with job_wait, job_status/job_events, or run the returned "
        "follow_command as a background task (its exit signals completion). worker=auto picks the first idle "
        "worker without a usage cooldown in the configured order."),
     "inputSchema": {"type": "object", "properties": {
         "worker": W_ENUM, "project_path": {"type": "string"}, "task": {"type": "string"},
         "label": {"type": "string", "description": "short name shown in lists and the dashboard"},
         "timeout_minutes": {"type": "integer", "default": 90, "minimum": 1, "maximum": 360},
         "write": {"type": "boolean", "default": True}},
         "required": ["project_path", "task"], "additionalProperties": False}},
    {"name": "job_status", "description": "Compact status of one job, or of the 15 most recent jobs when job_id is omitted.",
     "inputSchema": {"type": "object", "properties": {"job_id": {"type": "string"}}, "additionalProperties": False}},
    {"name": "job_events", "description": "Incremental slice of a job's normalized events (commands, results, messages, file changes), each clipped to 300 chars. Pass the returned next as since.",
     "inputSchema": {"type": "object", "properties": {"job_id": {"type": "string"},
                     "since": {"type": "integer", "default": 0}, "limit": {"type": "integer", "default": 40}},
                     "required": ["job_id"], "additionalProperties": False}},
    {"name": "job_result", "description": "Final message (<=6000 chars), commits since the job started, git status and diffstat of the job's folder, denied actions and stderr tail on failure.",
     "inputSchema": {"type": "object", "properties": {"job_id": {"type": "string"}}, "required": ["job_id"], "additionalProperties": False}},
    {"name": "job_wait", "description": "Block until all (or any) of the jobs end, or timeout_seconds pass (max 3000; progress is reported every minute).",
     "inputSchema": {"type": "object", "properties": {"job_ids": {"type": "array", "items": {"type": "string"}},
                     "mode": {"type": "string", "enum": ["all", "any"], "default": "all"},
                     "timeout_seconds": {"type": "integer", "default": 1500}},
                     "required": ["job_ids"], "additionalProperties": False}},
    {"name": "job_message", "description": "Send a follow-up message to a finished job's worker session (resumes the same Codex thread or Antigravity conversation in the same folder). Returns a new job_id.",
     "inputSchema": {"type": "object", "properties": {"job_id": {"type": "string"}, "message": {"type": "string"},
                     "timeout_minutes": {"type": "integer", "default": 60}},
                     "required": ["job_id", "message"], "additionalProperties": False}},
    {"name": "job_cancel", "description": "Stop a running job (kills the worker process tree).",
     "inputSchema": {"type": "object", "properties": {"job_id": {"type": "string"}}, "required": ["job_id"], "additionalProperties": False}},
    {"name": "worker_status", "description": "List all discovered workers/accounts with auth availability, provider, model, running jobs and usage cooldown.",
     "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False}},
    {"name": "clear_worker_cooldown", "description": "Clear the usage-limit cooldown for one worker or all.",
     "inputSchema": {"type": "object", "properties": {"worker": {"type": "string"}}, "additionalProperties": False}},
    {"name": "run_ai_worker", "description": "Compatibility: start_task, then wait up to timeout_seconds. If the job is still running, returns its job_id instead of stopping it.",
     "inputSchema": {"type": "object", "properties": {"worker": W_ENUM, "project_path": {"type": "string"}, "task": {"type": "string"},
                     "timeout_seconds": {"type": "integer", "default": 1800, "minimum": 30, "maximum": 3000},
                     "write": {"type": "boolean", "default": True}},
                     "required": ["task", "project_path"], "additionalProperties": False}},
    {"name": "run_ai_parallel", "description": "Start up to three independent tasks, each in a new git worktree and branch under D:/AI-Orchestrator/worktrees, and return their job_ids (non-blocking).",
     "inputSchema": {"type": "object", "properties": {"project_path": {"type": "string"},
                     "tasks": {"type": "array", "minItems": 1, "maxItems": 3, "items": {"type": "object", "properties": {
                         "task": {"type": "string"}, "worker": W_ENUM, "label": {"type": "string"}},
                         "required": ["task"], "additionalProperties": False}},
                     "timeout_minutes": {"type": "integer", "default": 90}, "write": {"type": "boolean", "default": True}},
                     "required": ["tasks", "project_path"], "additionalProperties": False}},
]


def tool_call(name, a):
    if name == "start_task":
        job_id, worker = start_job(a.get("worker", "auto"), a["task"], a["project_path"], a.get("label"),
                                   a.get("timeout_minutes", 90), a.get("write", True))
        return {"job_id": job_id, "worker": worker, **follow_info(job_id)}
    if name == "job_status":
        if a.get("job_id"):
            return summary(read_meta(a["job_id"]))
        return [summary(m) for m in all_jobs()[:15]]
    if name == "job_events":
        return job_events(a["job_id"], a.get("since", 0), a.get("limit", 40))
    if name == "job_result":
        return job_result(a["job_id"])
    if name == "job_wait":
        return job_wait(a["job_ids"], a.get("mode", "all"), a.get("timeout_seconds", 1500))
    if name == "job_message":
        m = read_meta(a["job_id"])
        if not is_done(m["id"]):
            raise ValueError("job is still running; wait for it or cancel it first")
        if not m.get("session_id"):
            raise ValueError("that job has no worker session id to resume")
        job_id, worker = start_job(m["worker"], a["message"], m["cwd"], f"follow-up: {m['label']}"[:80],
                                   a.get("timeout_minutes", 60), m.get("write", True), m["session_id"], m["id"])
        return {"job_id": job_id, "worker": worker, **follow_info(job_id)}
    if name == "job_cancel":
        read_meta(a["job_id"])
        (JOBS / a["job_id"] / "CANCEL").write_text("cancel", encoding="utf-8")
        return {"ok": True, "job_id": a["job_id"], "note": "the runner stops the worker within a few seconds"}
    if name == "worker_status":
        return worker_status()
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
        job_id, worker = start_job(a.get("worker", "auto"), a["task"], a["project_path"], None,
                                   # The job's own limit is independent of how long this call waits.
                                   int(config().get("job_timeout_minutes", 180)), a.get("write", True))
        job_wait([job_id], "all", a.get("timeout_seconds", 1800))
        res = job_result(job_id) if is_done(job_id) else {**summary(read_meta(job_id)), "still_running": True}
        return {**res, **follow_info(job_id)}
    if name == "run_ai_parallel":
        started = []
        for i, t in enumerate(a["tasks"], 1):
            worker = pick_worker(t.get("worker", "auto"))
            path, branch = create_worktree(a["project_path"], worker, i)
            job_id, worker = start_job(worker, t["task"], path, t.get("label"), a.get("timeout_minutes", 90), a.get("write", True))
            started.append({"job_id": job_id, "worker": worker, "worktree": path, "branch": branch, **follow_info(job_id)})
        return started
    raise ValueError("Unknown tool: " + name)


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
            "protocolVersion": msg.get("params", {}).get("protocolVersion", "2025-06-18"),
            "capabilities": {"tools": {"listChanged": False}},
            "serverInfo": {"name": "ai-workers", "version": "2.0.0"}}}
    if method == "ping":
        return {"jsonrpc": "2.0", "id": req_id, "result": {}}
    if method == "tools/list":
        return {"jsonrpc": "2.0", "id": req_id, "result": {"tools": TOOLS}}
    if method == "tools/call":
        params = msg.get("params", {})
        try:
            result = tool_call(params.get("name"), params.get("arguments") or {})
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
        print("ai-workers bridge error:", e, file=sys.stderr, flush=True)
    finally:
        done.set()


def main():
    try:
        import dashboard
        dashboard.serve(int(config().get("dashboard_port", 8765)))
    except Exception as e:
        print("dashboard not started:", e, file=sys.stderr, flush=True)
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except ValueError as e:
            print("ai-workers bridge error:", e, file=sys.stderr, flush=True)
            continue
        if msg.get("method") == "tools/call":  # calls can block for long: one thread each
            threading.Thread(target=handle_and_send, args=(msg,), daemon=True).start()
        else:
            handle_and_send(msg)


if __name__ == "__main__":
    sys.path.insert(0, str(BRIDGE))
    main()
