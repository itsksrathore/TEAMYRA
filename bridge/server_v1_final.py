import sys, json, os, subprocess, time, uuid, threading
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed

sys.stdin.reconfigure(encoding="utf-8")
sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")

ROOT = Path(r"D:\AI-Orchestrator")
LOGS = ROOT / "logs"
RESULTS = ROOT / "results"
WORKTREES = ROOT / "worktrees"
CODEX_JS = Path(r"C:\Users\kiran\AppData\Roaming\npm\node_modules\@openai\codex\bin\codex.js")
AGY = Path(r"C:\Users\kiran\AppData\Local\agy\bin\agy.exe")
NODE = Path(r"C:\Program Files\nodejs\node.exe")
PROFILES = {
    "codex1": Path(r"C:\\Users\\kiran\\.codex"),
    "codex2": ROOT / "profiles" / "codex2",
}
# Models the user chose for each worker (2026-10-02): Codex = GPT-6.1 Sol, Antigravity = Gemini 3.1 Pro.
CODEX_MODEL = "gpt-6.1-sol"
CODEX_EFFORT = "high"
AGY_MODEL = "gemini-3.1-pro-high"
CODEX_MODEL_ARGS = ["-c", f'model="{CODEX_MODEL}"', "-c", f'model_reasoning_effort="{CODEX_EFFORT}"']
COOLDOWNS = {}
LOCK = threading.Lock()
SEND_LOCK = threading.Lock()
LIMIT_MARKERS = [
    "rate limit", "usage limit", "quota", "too many requests",
    "resource exhausted", "limit reached", "insufficient quota"
]

for p in (LOGS, RESULTS, WORKTREES):
    p.mkdir(parents=True, exist_ok=True)

def now_id():
    return time.strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:6]

def compact(text, n=6000):
    text = (text or "").strip()
    return text if len(text) <= n else text[-n:]

def run_process(cmd, cwd=None, env=None, timeout=1800):
    merged = os.environ.copy()
    if env:
        merged.update(env)
    cp = subprocess.run(
        cmd, cwd=cwd, env=merged, text=True,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        timeout=timeout, encoding="utf-8", errors="replace"
    )
    return cp.returncode, cp.stdout or "", cp.stderr or ""

def is_limit_error(text):
    low = (text or "").lower()
    return any(x in low for x in LIMIT_MARKERS)
def codex_status(worker):
    env = {"CODEX_HOME": str(PROFILES[worker])}
    try:
        rc, out, err = run_process(
            [str(NODE), str(CODEX_JS), "login", "status"],
            env=env, timeout=20
        )
        text = (out + "\n" + err).strip()
        ready = rc == 0 and "not logged in" not in text.lower()
        return {"worker": worker, "ready": ready, "detail": compact(text, 1200)}
    except Exception as e:
        return {"worker": worker, "ready": False, "detail": str(e)}

def agy_status():
    try:
        rc, out, err = run_process([str(AGY), "models"], timeout=30)
        text = (out + "\n" + err).strip()
        ready = rc == 0 and bool(out.strip())
        return {"worker": "antigravity", "ready": ready, "detail": compact(text, 1800)}
    except Exception as e:
        return {"worker": "antigravity", "ready": False, "detail": str(e)}

def worker_status():
    data = [codex_status("codex1"), codex_status("codex2"), agy_status()]
    now = time.time()
    with LOCK:
        for item in data:
            until = COOLDOWNS.get(item["worker"], 0)
            item["cooldown_seconds"] = max(0, int(until - now))
            if until > now:
                item["ready"] = False
                item["detail"] = "Temporarily cooled down after quota/rate-limit failure."
    return data

def set_cooldown(worker, seconds=1800):
    with LOCK:
        COOLDOWNS[worker] = time.time() + seconds

def clear_cooldown(worker=None):
    with LOCK:
        if worker:
            COOLDOWNS.pop(worker, None)
        else:
            COOLDOWNS.clear()
    return {"ok": True, "worker": worker or "all"}

def run_codex(worker, task, project_path, timeout, write=True):
    task_id = now_id()
    log = LOGS / f"{task_id}-{worker}.jsonl"
    final = RESULTS / f"{task_id}-{worker}.txt"
    env = {"CODEX_HOME": str(PROFILES[worker])}
    cmd = [str(NODE), str(CODEX_JS), *CODEX_MODEL_ARGS, "exec", "--json"]
    if write:
        cmd += ["--approve-for-me"]
    else:
        cmd += ["--sandbox", "read-only"]
    cmd += ["-C", str(project_path), "-o", str(final), task]
    try:
        rc, out, err = run_process(cmd, env=env, timeout=timeout)
    except subprocess.TimeoutExpired:
        return {"ok": False, "worker": worker, "reason": "timeout", "task_id": task_id}
    log.write_text(out + "\n--- STDERR ---\n" + err, encoding="utf-8")
    final_text = ""
    if final.exists():
        final_text = final.read_text(encoding="utf-8", errors="replace")
    combined = (out + "\n" + err + "\n" + final_text)
    if rc != 0 and is_limit_error(combined):
        set_cooldown(worker)
        reason = "usage_or_rate_limit"
    elif rc != 0:
        reason = "worker_error"
    else:
        reason = None
    thread_id = None
    usage = None
    for line in out.splitlines():
        try:
            event = json.loads(line)
            if event.get("type") == "thread.started":
                thread_id = event.get("thread_id")
            if event.get("type") == "turn.completed":
                usage = event.get("usage")
        except Exception:
            continue
    return {
        "ok": rc == 0,
        "worker": worker, "task_id": task_id, "reason": reason,
        "session_id": thread_id, "usage": usage,
        "result": compact(final_text or out, 6000),
        "log_path": str(log),
        "result_path": str(final) if final.exists() else None,
    }

def run_agy(task, project_path, timeout, write=True):
    worker = "antigravity"
    task_id = now_id()
    log = LOGS / f"{task_id}-{worker}.log"
    mode = "accept-edits" if write else "plan"
    cmd = [
        str(AGY), "-p", task, "--output-format", "json",
        "--model", AGY_MODEL,
        "--mode", mode, "--sandbox",
        "--print-timeout", f"{int(timeout)}s",
        "--add-dir", str(project_path)
    ]
    try:
        rc, out, err = run_process(cmd, cwd=str(project_path), timeout=timeout + 20)
    except subprocess.TimeoutExpired:
        return {"ok": False, "worker": worker, "reason": "timeout", "task_id": task_id}
    log.write_text(out + "\n--- STDERR ---\n" + err, encoding="utf-8")
    combined = out + "\n" + err
    if rc != 0 and is_limit_error(combined):
        set_cooldown(worker)
        reason = "usage_or_rate_limit"
    elif rc != 0:
        reason = "worker_error"
    else:
        reason = None
    result = out
    obj = {}
    try:
        obj = json.loads(out)
        for key in ("result", "response", "text", "message"):
            if isinstance(obj.get(key), str):
                result = obj[key]
                break
    except Exception:
        obj = {}
    status = str(obj.get("status", "")).upper() if isinstance(obj, dict) else ""
    if rc == 0 and status and status != "SUCCESS":
        reason = "worker_status_" + status.lower()
    ok = rc == 0 and (not status or status == "SUCCESS")
    # Headless agy auto-denies tools that need a prompt and still reports SUCCESS
    # (often with an empty response): treat that as a failure, not a finished task.
    denied = obj.get("denied_actions") if isinstance(obj, dict) else None
    if denied:
        ok = False
        reason = "permission_denied"
        result = (result or "") + "\nDENIED: " + json.dumps(denied) + "\n" + compact(err, 1500)
    return {
        "ok": ok, "worker": worker, "task_id": task_id, "reason": reason,
        "session_id": obj.get("conversation_id") if isinstance(obj, dict) else None,
        "usage": obj.get("usage") if isinstance(obj, dict) else None,
        "result": compact(result, 6000),
        "log_path": str(log),
    }
def can_try(worker):
    with LOCK:
        return COOLDOWNS.get(worker, 0) <= time.time()

def run_worker(worker, task, project_path, timeout=1800, write=True):
    project_path = str(Path(project_path).resolve())
    if not Path(project_path).exists():
        return {"ok": False, "worker": worker, "reason": "project_path_not_found"}

    if worker == "auto":
        order = ["antigravity", "codex1", "codex2"]
    elif worker == "antigravity":
        order = ["antigravity", "codex1", "codex2"]
    elif worker == "codex1":
        order = ["codex1", "codex2", "antigravity"]
    elif worker == "codex2":
        order = ["codex2", "codex1", "antigravity"]
    else:
        order = [worker]

    attempts = []
    for w in order:
        if not can_try(w):
            attempts.append({"worker": w, "skipped": "cooldown"})
            continue
        if w == "antigravity":
            res = run_agy(task, project_path, timeout, write)
        elif w in ("codex1", "codex2"):
            res = run_codex(w, task, project_path, timeout, write)
        else:
            return {"ok": False, "reason": "unknown_worker", "worker": w}
        attempts.append({"worker": w, "ok": res.get("ok"), "reason": res.get("reason")})
        if res.get("ok"):
            res["attempts"] = attempts
            return res
        if res.get("reason") != "usage_or_rate_limit" and worker != "auto":
            res["attempts"] = attempts
            return res
    return {"ok": False, "reason": "all_workers_failed", "attempts": attempts}

def resume_worker(worker, session_id, task, project_path, timeout=1800):
    project_path = str(Path(project_path).resolve())
    task_id = now_id()
    if worker in ("codex1", "codex2"):
        final = RESULTS / f"{task_id}-{worker}-resume.txt"
        log = LOGS / f"{task_id}-{worker}-resume.jsonl"
        env = {"CODEX_HOME": str(PROFILES[worker])}
        cmd = [str(NODE), str(CODEX_JS), *CODEX_MODEL_ARGS, "exec", "resume", "--json",
               "-o", str(final), session_id, task]
        try:
            rc, out, err = run_process(cmd, cwd=project_path, env=env, timeout=timeout)
        except subprocess.TimeoutExpired:
            return {"ok": False, "worker": worker, "reason": "timeout"}
        log.write_text(out + "\n--- STDERR ---\n" + err, encoding="utf-8")
        text = final.read_text(encoding="utf-8", errors="replace") if final.exists() else out
        if rc != 0 and is_limit_error(out + err):
            set_cooldown(worker)
        return {"ok": rc == 0, "worker": worker, "session_id": session_id,
                "result": compact(text), "log_path": str(log)}
    if worker == "antigravity":
        log = LOGS / f"{task_id}-antigravity-resume.log"
        cmd = [str(AGY), "--conversation", session_id, "-p", task,
               "--output-format", "json", "--model", AGY_MODEL,
               "--mode", "accept-edits", "--sandbox",
               "--print-timeout", f"{int(timeout)}s", "--add-dir", project_path]
        try:
            rc, out, err = run_process(cmd, cwd=project_path, timeout=timeout + 20)
        except subprocess.TimeoutExpired:
            return {"ok": False, "worker": worker, "reason": "timeout"}
        log.write_text(out + "\n--- STDERR ---\n" + err, encoding="utf-8")
        try:
            obj = json.loads(out)
        except Exception:
            obj = {}
        status = str(obj.get("status", "")).upper()
        return {"ok": rc == 0 and (not status or status == "SUCCESS"),
                "worker": worker, "session_id": obj.get("conversation_id", session_id),
                "usage": obj.get("usage"), "result": compact(obj.get("response", out)),
                "log_path": str(log)}
    return {"ok": False, "reason": "unknown_worker", "worker": worker}

def create_worktree(project_path, worker, idx):
    rc, out, err = run_process(["git", "-C", project_path, "rev-parse", "--show-toplevel"], timeout=20)
    if rc != 0:
        raise RuntimeError("Parallel mode requires a Git repository: " + compact(err or out, 500))
    root = out.strip()
    task_id = now_id()
    safe_worker = worker.replace("_", "-")
    path = WORKTREES / f"{task_id}-{safe_worker}-{idx}"
    branch = f"aiw/{task_id}-{safe_worker}-{idx}"
    rc, out, err = run_process(["git", "-C", root, "worktree", "add", "-b", branch, str(path), "HEAD"], timeout=60)
    if rc != 0:
        raise RuntimeError(compact(err or out, 1000))
    return {"path": str(path), "branch": branch, "root": root}

def run_parallel(tasks, project_path, timeout=1800, write=True):
    prepared = []
    for idx, spec in enumerate(tasks):
        worker = spec.get("worker", "auto")
        wt = create_worktree(project_path, worker, idx)
        prepared.append((idx, spec, wt))
    results = [None] * len(prepared)
    max_workers = min(3, max(1, len(prepared)))
    with ThreadPoolExecutor(max_workers=max_workers) as pool:
        future_map = {}
        for idx, spec, wt in prepared:
            fut = pool.submit(
                run_worker,
                spec.get("worker", "auto"),
                spec["task"],
                wt["path"],
                timeout,
                write
            )
            future_map[fut] = (idx, wt)
        for fut in as_completed(future_map):
            idx, wt = future_map[fut]
            try:
                res = fut.result()
            except Exception as e:
                res = {"ok": False, "reason": "bridge_exception", "error": str(e)}
            res["worktree"] = wt["path"]
            res["branch"] = wt["branch"]
            results[idx] = res
    return results

TOOLS = [
    {
        "name": "worker_status",
        "description": "Check availability/auth status of Codex account 1, Codex account 2, and Antigravity workers.",
        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
    {
        "name": "run_ai_worker",
        "description": "Delegate one coding task to an external worker. Use explicit worker for deliberate routing or auto for automatic Antigravity→Codex1→Codex2 fallback. Returns compact result; full logs stay on disk.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "worker": {"type": "string", "enum": ["auto", "antigravity", "codex1", "codex2"], "default": "auto"},
                "task": {"type": "string"},
                "project_path": {"type": "string"},
                "timeout_seconds": {"type": "integer", "minimum": 30, "maximum": 3600, "default": 1800},
                "write": {"type": "boolean", "default": True},
            },
            "required": ["task", "project_path"],
            "additionalProperties": False,
        },
    },
    {
        "name": "run_ai_parallel",
        "description": "Run up to three independent tasks in parallel in isolated Git worktrees. Returns branch/worktree for review and merge.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "tasks": {
                    "type": "array", "minItems": 1, "maxItems": 3,
                    "items": {
                        "type": "object",
                        "properties": {
                            "worker": {"type": "string", "enum": ["auto", "antigravity", "codex1", "codex2"], "default": "auto"},
                            "task": {"type": "string"},
                        },
                        "required": ["task"],
                        "additionalProperties": False,
                    },
                },
                "project_path": {"type": "string"},
                "timeout_seconds": {"type": "integer", "minimum": 30, "maximum": 3600, "default": 1800},
                "write": {"type": "boolean", "default": True},
            },
            "required": ["tasks", "project_path"],
            "additionalProperties": False,
        },
    },
    {
        "name": "resume_ai_worker",
        "description": "Continue an existing Codex or Antigravity worker session without resending the full prior context.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "worker": {"type": "string", "enum": ["antigravity", "codex1", "codex2"]},
                "session_id": {"type": "string"},
                "task": {"type": "string"},
                "project_path": {"type": "string"},
                "timeout_seconds": {"type": "integer", "minimum": 30, "maximum": 3600, "default": 1800},
            },
            "required": ["worker", "session_id", "task", "project_path"],
            "additionalProperties": False,
        },
    },
    {
        "name": "clear_worker_cooldown",
        "description": "Clear automatic rate/quota cooldown for one worker or all workers.",
        "inputSchema": {
            "type": "object",
            "properties": {"worker": {"type": "string", "enum": ["antigravity", "codex1", "codex2"]}},
            "additionalProperties": False,
        },
    },
]

def tool_call(name, args):
    if name == "worker_status":
        return worker_status()
    if name == "run_ai_worker":
        return run_worker(
            args.get("worker", "auto"), args["task"], args["project_path"],
            args.get("timeout_seconds", 1800), args.get("write", True)
        )
    if name == "run_ai_parallel":
        return run_parallel(
            args["tasks"], args["project_path"],
            args.get("timeout_seconds", 1800), args.get("write", True)
        )
    if name == "resume_ai_worker":
        return resume_worker(
            args["worker"], args["session_id"], args["task"], args["project_path"],
            args.get("timeout_seconds", 1800)
        )
    if name == "clear_worker_cooldown":
        return clear_cooldown(args.get("worker"))
    raise ValueError("Unknown tool: " + name)
def send(obj):
    line = json.dumps(obj, ensure_ascii=False, separators=(",", ":")) + "\n"
    with SEND_LOCK:
        sys.stdout.write(line)
        sys.stdout.flush()

def heartbeat(token, done, every=60):
    # Claude Code drops a tool call after 30 min without a response or progress;
    # workers run longer, so report progress while the call is still running.
    n = 0
    while not done.wait(every):
        n += 1
        send({"jsonrpc": "2.0", "method": "notifications/progress",
              "params": {"progressToken": token, "progress": n,
                         "message": f"worker running ({n} min)"}})

def handle_and_send(msg):
    done = threading.Event()
    token = ((msg.get("params") or {}).get("_meta") or {}).get("progressToken")
    if token is not None:
        threading.Thread(target=heartbeat, args=(token, done), daemon=True).start()
    elif msg.get("method") == "tools/call":
        with open(LOGS / "bridge.log", "a", encoding="utf-8") as f:
            f.write(f"{now_id()} tools/call without progressToken: no heartbeat\n")
    try:
        response = handle(msg)
        if response is not None:
            send(response)
    except Exception as e:
        print("ai-workers bridge error:", e, file=sys.stderr, flush=True)
    finally:
        done.set()

def handle(msg):
    method = msg.get("method")
    req_id = msg.get("id")
    if method == "initialize":
        version = msg.get("params", {}).get("protocolVersion", "2025-06-18")
        return {
            "jsonrpc": "2.0", "id": req_id,
            "result": {
                "protocolVersion": version,
                "capabilities": {"tools": {"listChanged": False}},
                "serverInfo": {"name": "ai-workers", "version": "1.0.0"},
            },
        }
    if method == "ping":
        return {"jsonrpc": "2.0", "id": req_id, "result": {}}
    if method == "tools/list":
        return {"jsonrpc": "2.0", "id": req_id, "result": {"tools": TOOLS}}
    if method == "tools/call":
        params = msg.get("params", {})
        try:
            result = tool_call(params.get("name"), params.get("arguments") or {})
            payload = json.dumps(result, ensure_ascii=False, indent=2)
            return {
                "jsonrpc": "2.0", "id": req_id,
                "result": {"content": [{"type": "text", "text": payload}], "isError": False},
            }
        except Exception as e:
            payload = json.dumps({"ok": False, "error": str(e)}, ensure_ascii=False)
            return {
                "jsonrpc": "2.0", "id": req_id,
                "result": {"content": [{"type": "text", "text": payload}], "isError": True},
            }
    if req_id is not None:
        return {
            "jsonrpc": "2.0", "id": req_id,
            "error": {"code": -32601, "message": "Method not found: " + str(method)},
        }
    return None

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        msg = json.loads(line)
    except Exception as e:
        print("ai-workers bridge error:", e, file=sys.stderr, flush=True)
        continue
    # Tool calls run for up to an hour: run each in its own thread so calls to
    # different workers proceed in parallel instead of queueing behind each other.
    if msg.get("method") == "tools/call":
        threading.Thread(target=handle_and_send, args=(msg,), daemon=True).start()
    else:
        handle_and_send(msg)
