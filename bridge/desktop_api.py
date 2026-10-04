"""Narrow JSON bridge used by the TEAMYRA desktop process.

This keeps destructive Git lifecycle logic in the tested Python core rather than
duplicating it inside Electron. One invocation handles one action and prints one
JSON response to stdout.
"""
import json
import os
import sys
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

BRIDGE = Path(__file__).resolve().parent
ROOT = Path(os.environ.get("TEAMYRA_ROOT") or BRIDGE.parent).resolve()
WORKTREES = ROOT / "worktrees"
sys.path.insert(0, str(BRIDGE))

import worktree_manager
import observability
import project_memory
import workspace_tools


def _bridge_token(payload):
    return os.environ.get("TEAMYRA_LOCAL_AGENT_TOKEN") or payload.get("bridge_token")


def handle(action, payload):
    payload = payload if isinstance(payload, dict) else {}

    if action == "task.start":
        import server
        task = str(payload.get("task") or "").strip()
        project_path = str(payload.get("project_path") or "").strip()
        worker = str(payload.get("worker") or "auto").strip() or "auto"
        if not task:
            raise ValueError("task is required")
        if len(task) > 24000:
            raise ValueError("task is too long")
        if not project_path:
            raise ValueError("project_path is required")
        timeout_minutes = max(1, min(int(payload.get("timeout_minutes", 180)), 720))
        write = payload.get("write") is not False
        auto_failover = payload.get("auto_failover", worker == "auto") is True
        label = str(payload.get("label") or task.splitlines()[0])[:80]
        job_id, selected_worker = server.start_job(
            worker,
            task,
            project_path,
            label=label,
            timeout_minutes=timeout_minutes,
            write=write,
            auto_failover=auto_failover,
        )
        return {"job_id": job_id, "worker": selected_worker}

    if action == "task.cancel":
        import server
        job_id = str(payload.get("job_id") or "").strip()
        if not job_id:
            raise ValueError("job_id is required")
        terminal_id = server.failover_terminal_job_id(job_id)
        server.read_meta(terminal_id)
        (server.JOBS / terminal_id / "CANCEL").write_text("cancel", encoding="utf-8")
        return {
            "ok": True,
            "job_id": job_id,
            "cancelled_job_id": terminal_id,
        }

    if action == "observability.timeline":
        return observability.timeline(
            ROOT,
            payload.get("limit", 120),
            payload.get("project_path"),
            payload.get("worker"),
            payload.get("sources"),
            payload.get("query"),
            payload.get("since"),
        )
    if action == "observability.search":
        return observability.search_logs(
            ROOT,
            payload.get("query"),
            payload.get("limit", 50),
            payload.get("project_path"),
            payload.get("worker"),
            payload.get("kinds"),
        )
    if action == "observability.usage":
        import server
        rows = []
        for worker, info in server.worker_registry().items():
            settings = server.worker_settings(info)
            rows.append({
                "worker": worker,
                "provider": info.get("provider"),
                "ready": None,
                "cooldown_seconds": server.cooldown_left(worker),
                "model": settings.get("model"),
                "effort": settings.get("effort"),
                "running_jobs": [item["id"] for item in server.running_jobs(worker)],
            })
        return observability.usage_snapshot(
            ROOT,
            rows,
            payload.get("project_path"),
        )
    if action == "memory.list":
        return project_memory.list_entries(
            ROOT, payload["project_path"], payload.get("kind"), payload.get("status", "active"),
            payload.get("tag"), payload.get("limit", 100),
        )
    if action == "memory.search":
        return project_memory.search(
            ROOT, payload["project_path"], payload["query"], payload.get("kinds"), payload.get("tags"),
            payload.get("status", "active"), payload.get("limit", 50),
        )
    if action == "memory.get":
        return project_memory.get(ROOT, payload["project_path"], payload["memory_id"])
    if action == "memory.add":
        return project_memory.add(
            ROOT, payload["project_path"], payload["kind"], payload["title"], payload["content"],
            payload.get("tags"), payload.get("importance", "normal"),
            payload.get("source_job_id"), payload.get("source_graph_id"),
        )
    if action == "memory.update":
        patch = {
            key: payload[key]
            for key in ("title", "content", "tags", "importance", "kind")
            if key in payload
        }
        return project_memory.update(ROOT, payload["project_path"], payload["memory_id"], **patch)
    if action == "memory.archive":
        return project_memory.archive(
            ROOT, payload["project_path"], payload["memory_id"], payload.get("reason"),
        )
    if action == "memory.context":
        return project_memory.context_pack(
            ROOT, payload["project_path"], payload.get("query"), payload.get("kinds"),
            payload.get("tags"), payload.get("max_chars", 8000), payload.get("limit", 40),
        )
    if action == "chatgpt.workspace.configure":
        service = workspace_tools.WorkspaceToolService(ROOT)
        return service.configure(
            payload.get("workspace"),
            payload.get("permissions"),
            token=_bridge_token(payload),
            actor="chatgpt-normal",
        )
    if action == "chatgpt.workspace.status":
        return workspace_tools.WorkspaceToolService(ROOT).status(
            token=_bridge_token(payload),
        )
    if action == "chatgpt.tool.execute":
        return workspace_tools.WorkspaceToolService(ROOT).execute(
            payload.get("tool"),
            payload.get("args"),
            token=_bridge_token(payload),
            actor="chatgpt-normal",
            confirm=payload.get("confirm") is True,
        )
    if action == "chatgpt.tool.execute-in-workspace":
        return workspace_tools.WorkspaceToolService(ROOT).execute_in_workspace(
            payload.get("workspace"),
            payload.get("tool"),
            payload.get("args"),
            permissions=payload.get("permissions"),
            token=_bridge_token(payload),
            actor="chatgpt-normal",
            confirm=payload.get("confirm") is True,
        )
    if action == "worktree.list":
        return worktree_manager.list_managed(WORKTREES)
    if action == "worktree.status":
        return worktree_manager.status(WORKTREES, payload["worktree_id"])
    if action == "worktree.diff":
        return worktree_manager.diff(
            WORKTREES,
            payload["worktree_id"],
            payload.get("max_chars", 80000),
        )
    if action == "worktree.create":
        project_path = payload.get("project_path")
        if not project_path:
            raise ValueError("project_path is required")
        return worktree_manager.create(
            project_path,
            WORKTREES,
            payload.get("label") or "task",
            payload.get("base_ref") or "HEAD",
        )
    if action == "worktree.rebase":
        if payload.get("confirm") is not True:
            raise ValueError("worktree.rebase requires confirm=true")
        return worktree_manager.rebase(WORKTREES, payload["worktree_id"])
    if action == "worktree.conflict.begin":
        if payload.get("confirm") is not True:
            raise ValueError("worktree.conflict.begin requires confirm=true")
        return worktree_manager.begin_rebase_resolution(WORKTREES, payload["worktree_id"])
    if action == "worktree.conflict.detail":
        return worktree_manager.conflict_detail(
            WORKTREES, payload["worktree_id"], payload["path"], payload.get("max_chars", 300000),
        )
    if action == "worktree.conflict.resolve":
        if payload.get("confirm") is not True:
            raise ValueError("worktree.conflict.resolve requires confirm=true")
        return worktree_manager.resolve_conflict(
            WORKTREES, payload["worktree_id"], payload["path"],
            payload.get("strategy", "manual"), payload.get("content"),
        )
    if action == "worktree.conflict.continue":
        if payload.get("confirm") is not True:
            raise ValueError("worktree.conflict.continue requires confirm=true")
        return worktree_manager.continue_rebase_resolution(WORKTREES, payload["worktree_id"])
    if action == "worktree.conflict.abort":
        if payload.get("confirm") is not True:
            raise ValueError("worktree.conflict.abort requires confirm=true")
        return worktree_manager.abort_rebase_resolution(WORKTREES, payload["worktree_id"])
    if action == "worktree.merge":
        if payload.get("confirm") is not True:
            raise ValueError("worktree.merge requires confirm=true")
        return worktree_manager.merge(WORKTREES, payload["worktree_id"])
    if action == "worktree.discard":
        if payload.get("confirm") is not True:
            raise ValueError("worktree.discard requires confirm=true")
        return worktree_manager.discard(
            WORKTREES,
            payload["worktree_id"],
            payload.get("force", False),
        )
    raise ValueError(f"unsupported desktop core action: {action}")


def main():
    if len(sys.argv) < 2:
        raise SystemExit("usage: desktop_api.py <action> [json_payload]")
    action = sys.argv[1]
    payload = json.loads(sys.argv[2]) if len(sys.argv) > 2 else {}
    try:
        result = handle(action, payload)
        response = {"ok": True, "result": result}
    except Exception as exc:
        response = {"ok": False, "error": str(exc)}
    sys.stdout.write(json.dumps(response, ensure_ascii=False))
    sys.stdout.flush()


if __name__ == "__main__":
    main()
