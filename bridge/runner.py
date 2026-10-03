"""Runs one worker job, detached from the MCP bridge.

    python runner.py <job_dir>

<job_dir>/spec.json holds {worker, cmd, cwd, env, timeout, final_path}. The runner
streams the worker's JSON events into:
  events.jsonl   normalized events {ts, kind, text}
  transcript.md  human-readable live transcript (what the dashboard and follow.py show)
  meta.json      state, session id, usage, last event, timestamps
  final.txt      the worker's final message
  DONE           written last; its content is the final state
Because the runner is its own process, a bridge restart or an MCP timeout does not
stop the job.
"""
import json, os, subprocess, sys, threading, time
from pathlib import Path

LIMIT_MARKERS = ["rate limit", "usage limit", "quota", "too many requests",
                 "resource exhausted", "limit reached", "insufficient quota"]


def now():
    return time.strftime("%H:%M:%S")


def clip(text, n):
    text = (text or "").strip()
    return text if len(text) <= n else text[: n - 15] + " ...[clipped]"


def tail_lines(text, n):
    lines = (text or "").rstrip().splitlines()
    head = [f"... ({len(lines) - n} earlier lines)"] if len(lines) > n else []
    return head + lines[-n:]


class Job:
    def __init__(self, job_dir):
        self.dir = Path(job_dir)
        self.spec = json.loads((self.dir / "spec.json").read_text(encoding="utf-8"))
        self.meta = json.loads((self.dir / "meta.json").read_text(encoding="utf-8"))
        self.events = open(self.dir / "events.jsonl", "a", encoding="utf-8")
        self.transcript = open(self.dir / "transcript.md", "a", encoding="utf-8")
        self.lock = threading.Lock()
        self.final_text = ""
        self.raw_tail = []          # last raw lines, for limit detection
        self.agy_text = {}          # agy step_index -> accumulated text
        self.agy_seen = set()       # agy (step_index, state) already reported

    # --- output ---------------------------------------------------------------
    def save_meta(self, **changes):
        with self.lock:
            self.meta.update(changes)
            self.meta["updated"] = time.time()
            tmp = self.dir / "meta.json.tmp"
            tmp.write_text(json.dumps(self.meta, ensure_ascii=False, indent=1), encoding="utf-8")
            os.replace(tmp, self.dir / "meta.json")

    def emit(self, kind, text, block=None):
        """One event: a line in events.jsonl and an entry in the transcript."""
        text = (text or "").strip()
        if not text and not block:
            return
        with self.lock:
            self.events.write(json.dumps({"ts": time.time(), "kind": kind, "text": clip(text, 4000)},
                                         ensure_ascii=False) + "\n")
            self.events.flush()
            marker = {"message": ">>", "command": "$ ", "result": "  ", "files": "~ ",
                      "reasoning": "..", "error": "!!", "info": "--", "done": "=="}.get(kind, "--")
            self.transcript.write(f"[{now()}] {marker} {text}\n")
            for line in block or []:
                self.transcript.write(f"           | {line}\n")
            self.transcript.flush()
        self.meta["last_event"] = clip(f"{kind}: {text}", 200)
        self.meta["events"] = self.meta.get("events", 0) + 1

    # --- codex --json -----------------------------------------------------------
    def codex_event(self, ev):
        t = ev.get("type", "")
        if t == "thread.started":
            self.save_meta(session_id=ev.get("thread_id"))
            self.emit("info", f"codex session {ev.get('thread_id')}")
        elif t in ("item.started", "item.completed"):
            item = ev.get("item") or {}
            it = item.get("type")
            if it == "command_execution":
                if t == "item.started":
                    self.emit("command", clip(item.get("command", ""), 600))
                else:
                    code = item.get("exit_code")
                    out = item.get("aggregated_output") or ""
                    self.emit("result", f"exit {code} ({len(out.splitlines())} lines)",
                              block=[clip(l, 300) for l in tail_lines(out, 12)])
            elif it == "agent_message" and t == "item.completed":
                self.final_text = item.get("text") or self.final_text
                self.emit("message", item.get("text", ""))
            elif it == "reasoning" and t == "item.completed":
                self.emit("reasoning", clip(item.get("text", ""), 500))
            elif it == "file_change" and t == "item.completed":
                changes = item.get("changes") or []
                self.emit("files", ", ".join(f"{c.get('kind', '?')} {c.get('path', '?')}" for c in changes))
            elif it == "todo_list":
                todo = item.get("items") or []
                self.emit("info", "plan: " + "; ".join(
                    f"[{'x' if x.get('completed') else ' '}] {x.get('text', '')}" for x in todo))
            elif it in ("mcp_tool_call", "web_search") and t == "item.started":
                self.emit("command", f"{it}: {clip(json.dumps(item, ensure_ascii=False), 300)}")
            elif it == "error":
                self.emit("error", item.get("message", ""))
        elif t == "turn.completed":
            self.save_meta(usage=ev.get("usage"))
        elif t in ("turn.failed", "error"):
            msg = ev.get("message") or (ev.get("error") or {}).get("message") or json.dumps(ev)
            self.emit("error", clip(msg, 1000))

    # --- claude --output-format stream-json --------------------------------------------
    def claude_event(self, ev):
        t = ev.get("type", "")
        sid = ev.get("session_id")
        if sid and sid != self.meta.get("session_id"):
            self.save_meta(session_id=sid)

        if t == "system" and ev.get("subtype") == "init":
            model = ev.get("model") or "unknown"
            self.save_meta(model=model)
            self.emit("info", f"claude session {sid or '?'} model {model}")
            return

        if t == "assistant":
            msg = ev.get("message") or {}
            if msg.get("usage"):
                self.save_meta(usage=msg.get("usage"))
            for block in msg.get("content") or []:
                kind = block.get("type")
                if kind == "text" and block.get("text"):
                    text = block.get("text")
                    self.final_text = text
                    self.emit("message", text)
                elif kind == "tool_use":
                    name = block.get("name") or "tool"
                    detail = clip(json.dumps(block.get("input") or {}, ensure_ascii=False), 700)
                    self.emit("command", f"{name}: {detail}")
                elif kind == "thinking" and block.get("thinking"):
                    self.emit("reasoning", clip(block.get("thinking"), 500))
            return

        if t == "user":
            msg = ev.get("message") or {}
            for block in msg.get("content") or []:
                if block.get("type") != "tool_result":
                    continue
                content = block.get("content")
                if isinstance(content, list):
                    text = " ".join(str(x.get("text", "")) for x in content if isinstance(x, dict))
                else:
                    text = str(content or "")
                self.emit("result", clip(text, 900))
            return

        if t == "rate_limit_event":
            info = ev.get("rate_limit_info") or {}
            self.save_meta(rate_limit=info)
            self.emit("info", f"claude rate limit {info.get('status', 'update')}")
            return

        if t == "result":
            result = ev.get("result")
            if isinstance(result, str) and result.strip():
                self.final_text = result
            denied = ev.get("permission_denials") or []
            self.save_meta(
                session_id=sid or self.meta.get("session_id"),
                usage=ev.get("usage") or self.meta.get("usage"),
                model_usage=ev.get("modelUsage") or self.meta.get("model_usage"),
                total_cost_usd=ev.get("total_cost_usd"),
                worker_status=ev.get("terminal_reason") or ev.get("subtype"),
                result_subtype=ev.get("subtype"),
                denied_actions=denied or self.meta.get("denied_actions"),
                reported_error=bool(ev.get("is_error")),
            )
            if ev.get("is_error"):
                self.emit("error", clip(str(result or ev.get("subtype") or "Claude run failed"), 1000))
            return

    # --- agy --output-format stream-json ---------------------------------------------
    def agy_event(self, ev):
        e = ev.get("event")
        if e == "init":
            self.save_meta(session_id=ev.get("conversation_id"))
            self.emit("info", f"antigravity session {ev.get('conversation_id')} "
                              f"model {(ev.get('init') or {}).get('model')}")
        elif e == "step_update":
            s = ev.get("step_update") or {}
            idx, state, stype = s.get("step_index"), s.get("state"), s.get("step_type", "?")
            if "text_delta" in s:
                self.agy_text[idx] = self.agy_text.get(idx, "") + (s.get("text_delta") or "")
            if stype == "user_input":
                return
            if stype == "agent_response":
                if state == "DONE" and self.agy_text.get(idx):
                    self.final_text = self.agy_text[idx]
                    self.emit("message", self.agy_text.pop(idx))
                return
            key = (idx, state)
            if key in self.agy_seen:
                return
            self.agy_seen.add(key)
            info = s.get("tool_info") or {}
            params = info.get("parameters") or {}
            name = info.get("name") or s.get("tool_name") or stype
            text = self.agy_text.pop(idx, "") if state == "DONE" else ""
            if name == "run_command":
                what = params.get("CommandLine", "")
            else:
                what = f"{name} {clip(json.dumps(params, ensure_ascii=False), 300) if params else ''}"
            if state != "DONE":
                self.emit("command", clip(what, 600))
            else:
                out = info.get("output") or text
                dur = s.get("duration_seconds")
                self.emit("result", f"{name} done{f' in {dur:.1f} s' if isinstance(dur, (int, float)) else ''}",
                          block=[clip(l, 300) for l in tail_lines(out, 12)] if out else None)
        elif e == "result":
            r = ev.get("result") or {}
            self.final_text = r.get("response") or self.final_text
            denied = r.get("denied_actions")
            self.save_meta(usage=r.get("usage"), worker_status=r.get("status"), denied_actions=denied)
            if denied:
                self.emit("error", f"permission denied: {json.dumps(denied)}")

    # --- main -----------------------------------------------------------------------
    def run_once(self, cmd, env, deadline):
        """Runs one worker process to its end; returns (rc, stderr, timed_out, cancelled)."""
        flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        proc = subprocess.Popen(cmd, cwd=self.spec["cwd"], env=env, stdin=subprocess.DEVNULL,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                text=True, encoding="utf-8", errors="replace", creationflags=flags)
        self.save_meta(state="running", worker_pid=proc.pid)
        stderr_lines = []
        stderr_thread = threading.Thread(
            target=lambda: stderr_lines.extend(proc.stderr),
            daemon=True,
            name=f"teamyra-stderr-{proc.pid}",
        )
        stderr_thread.start()
        timed_out, cancelled = threading.Event(), threading.Event()

        def watchdog():
            last_heartbeat = 0.0
            while proc.poll() is None:
                now_ts = time.time()
                if now_ts - last_heartbeat >= 10:
                    last_heartbeat = now_ts
                    self.save_meta(heartbeat_at=now_ts)
                if now_ts > deadline or (self.dir / "CANCEL").exists():
                    (timed_out if now_ts > deadline else cancelled).set()
                    subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"], capture_output=True)
                    return
                time.sleep(3)
        threading.Thread(target=watchdog, daemon=True).start()

        provider = self.spec.get("provider")
        if not provider:
            provider = "codex" if self.spec["worker"].startswith("codex") else "antigravity"
        handlers = {"codex": self.codex_event, "claude": self.claude_event, "antigravity": self.agy_event}
        handler = handlers.get(provider)
        if handler is None:
            raise RuntimeError(f"unsupported worker provider: {provider}")
        last_save = 0.0
        for line in proc.stdout:
            line = line.strip()
            if not line:
                continue
            self.raw_tail = (self.raw_tail + [line])[-40:]
            try:
                ev = json.loads(line)
            except ValueError:
                self.emit("info", clip(line, 400))
                continue
            try:
                handler(ev)
            except Exception as exc:  # never let one odd event stop the job
                self.emit("error", f"event parse error: {exc}")
            if time.time() - last_save > 2:
                last_save = time.time()
                self.save_meta()
        rc = proc.wait()
        stderr_thread.join(timeout=5)
        if proc.stdout is not None:
            proc.stdout.close()
        if proc.stderr is not None:
            proc.stderr.close()
        return rc, "".join(stderr_lines), timed_out.is_set(), cancelled.is_set()

    def run(self):
        spec = self.spec
        env = os.environ.copy()
        env.update(spec.get("env") or {})
        self.emit("info", f"start {spec['worker']} in {spec['cwd']}")
        started = self.meta.get("started") or time.time()
        self.save_meta(
            started=started,
            runner_pid=os.getpid(),
            heartbeat_at=time.time(),
            recovery_state="running" if self.meta.get("recovery_requested") else self.meta.get("recovery_state"),
        )
        deadline = started + spec.get("timeout", 3600)
        cmd, resumes, max_resumes = spec["cmd"], 0, int(spec.get("auto_resume", 2))
        while True:
            attempt_start = time.time()
            rc, err, timed_out, cancelled = self.run_once(cmd, env, deadline)
            low = (err + "\n" + "\n".join(self.raw_tail)).lower()
            limit = rc != 0 and any(m in low for m in LIMIT_MARKERS)
            # A worker that dies mid-run (exit != 0 with no limit, timeout or cancel) is resumed in the
            # same session, like an interrupted agent: its work so far is on disk and in the thread.
            sid, template = self.meta.get("session_id"), spec.get("resume_cmd")
            if (rc != 0 and not (timed_out or cancelled or limit or self.meta.get("denied_actions"))
                    and sid and template and resumes < max_resumes and time.time() - attempt_start > 60
                    and time.time() < deadline - 120):
                resumes += 1
                if err.strip():
                    (self.dir / f"stderr-attempt{resumes}.txt").write_text(err, encoding="utf-8")
                self.emit("error", f"worker exited {rc} mid-run; auto-resume {resumes}/{max_resumes} "
                                   f"of session {sid}")
                cmd = [sid if part == "{SESSION}" else part for part in template]
                self.save_meta(auto_resumes=resumes)
                continue
            break
        final_path = Path(spec.get("final_path") or self.dir / "final.txt")
        if final_path.exists() and final_path.stat().st_size:
            self.final_text = final_path.read_text(encoding="utf-8", errors="replace")
        (self.dir / "final.txt").write_text(self.final_text or "", encoding="utf-8")
        if err.strip():
            (self.dir / "stderr.txt").write_text(err, encoding="utf-8")
        if cancelled:
            state, reason = "cancelled", "cancelled"
        elif timed_out:
            state, reason = "failed", "timeout"
        elif limit:
            state, reason = "failed", "usage_or_rate_limit"
        elif self.meta.get("denied_actions"):
            state, reason = "failed", "permission_denied"
        elif self.meta.get("reported_error"):
            state, reason = "failed", "worker_reported_error"
        elif rc != 0:
            state, reason = "failed", "worker_error"
        else:
            state, reason = "done", None
        if reason and err.strip():
            self.emit("error", clip(err.strip().splitlines()[-1], 400))
        self.emit("done", f"{state}{' (' + reason + ')' if reason else ''}, exit {rc}, "
                          f"{int(time.time() - self.meta['started'])} s"
                          f"{f', {resumes} auto-resume(s)' if resumes else ''}")
        self.save_meta(
            state=state,
            reason=reason,
            exit_code=rc,
            ended=time.time(),
            runner_pid=None,
            worker_pid=None,
            heartbeat_at=None,
            recovery_state="completed" if self.meta.get("recovery_requested") else self.meta.get("recovery_state"),
        )
        (self.dir / "DONE").write_text(state, encoding="utf-8")

def main():
    if len(sys.argv) != 2:
        raise SystemExit("usage: runner.py <job_dir>")
    job = Job(sys.argv[1])
    try:
        job.run()
    except Exception as exc:
        job.emit("error", f"runner crashed: {exc}")
        job.save_meta(
            state="failed", reason="runner_crash", ended=time.time(),
            runner_pid=None, worker_pid=None,
        )
        (job.dir / "DONE").write_text("failed", encoding="utf-8")


if __name__ == "__main__":
    main()
