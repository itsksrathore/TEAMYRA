"""TEAMYRA local command-line interface."""
import argparse
import json
import sys
from pathlib import Path

BRIDGE = Path(__file__).resolve().parent
ROOT = BRIDGE.parent
sys.path.insert(0, str(BRIDGE))

import server


VERSION = "0.2.0"


def emit(value):
    if isinstance(value, str):
        print(value)
    else:
        print(json.dumps(value, ensure_ascii=False, indent=2))


def call(name, args=None):
    return server.tool_call(name, args or {})


def cmd_doctor(args):
    workers = server.worker_status()
    ready = [item for item in workers if item.get("ready")]
    result = {
        "ok": bool(ready),
        "version": VERSION,
        "root": str(ROOT),
        "mcp_server": server.MCP_SERVER_NAME,
        "mcp_version": server.MCP_SERVER_VERSION,
        "ready_workers": len(ready),
        "workers": workers,
    }
    emit(result)
    return 0 if ready else 2


def cmd_workers(args):
    emit(server.worker_status())
    return 0


def cmd_jobs(args):
    emit(call("job_status", {"job_id": args.job_id} if args.job_id else {}))
    return 0


def cmd_run(args):
    payload = {
        "worker": args.worker,
        "project_path": args.project,
        "task": args.task,
        "label": args.label,
        "timeout_minutes": args.timeout_minutes,
        "write": not args.read_only,
        "max_failovers": args.max_failovers,
    }
    if args.wait:
        payload["timeout_seconds"] = args.wait_timeout
        result = call("run_ai_worker", payload)
    else:
        result = call("start_task", payload)
    emit(result)
    return 0


def cmd_wait(args):
    emit(call("job_wait", {
        "job_ids": args.job_ids,
        "mode": args.mode,
        "timeout_seconds": args.timeout_seconds,
    }))
    return 0


def cmd_result(args):
    emit(call("job_result", {"job_id": args.job_id}))
    return 0


def cmd_timeline(args):
    emit(call("timeline_list", {
        "limit": args.limit,
        "project_path": args.project,
        "worker": args.worker,
        "sources": args.source or [],
        "query": args.query,
        "since": args.since,
    }))
    return 0


def cmd_search(args):
    emit(call("logs_search", {
        "query": args.query,
        "limit": args.limit,
        "project_path": args.project,
        "worker": args.worker,
        "kinds": args.kind or [],
    }))
    return 0


def cmd_usage(args):
    emit(call("usage_snapshot", {
        "project_path": args.project,
    }))
    return 0


def cmd_memory(args):
    action = args.memory_action
    base = {"project_path": args.project}
    if action == "add":
        result = call("memory_add", {
            **base, "kind": args.kind, "title": args.title, "content": args.content,
            "tags": args.tag or [], "importance": args.importance,
            "source_job_id": args.source_job_id, "source_graph_id": args.source_graph_id,
        })
    elif action == "list":
        result = call("memory_list", {
            **base, "kind": args.kind, "status": args.status, "tag": args.tag,
            "limit": args.limit,
        })
    elif action == "search":
        result = call("memory_search", {
            **base, "query": args.query, "kinds": args.kind or [], "tags": args.tag or [],
            "status": args.status, "limit": args.limit,
        })
    elif action == "get":
        result = call("memory_get", {**base, "memory_id": args.memory_id})
    elif action == "update":
        payload = {**base, "memory_id": args.memory_id}
        for key in ("title", "content", "importance", "kind"):
            value = getattr(args, key)
            if value is not None:
                payload[key] = value
        if args.tag is not None:
            payload["tags"] = args.tag
        result = call("memory_update", payload)
    elif action == "archive":
        result = call("memory_archive", {**base, "memory_id": args.memory_id, "reason": args.reason})
    elif action == "context":
        result = call("memory_context", {
            **base, "query": args.query, "kinds": args.kind or [], "tags": args.tag or [],
            "max_chars": args.max_chars, "limit": args.limit,
        })
    else:
        raise ValueError("unsupported memory action")
    emit(result)
    return 0


def cmd_handoff(args):
    action = args.handoff_action
    if action == "start":
        result = call("job_handoff", {
            "job_id": args.job_id,
            "target_worker": args.target_worker,
            "message": args.message,
            "objective": args.objective,
            "constraints": args.constraint or [],
            "acceptance_criteria": args.accept or [],
            "artifacts": args.artifact or [],
            "notes": args.notes,
            "include_project_memory": not args.no_project_memory,
            "memory_query": args.memory_query,
            "memory_max_chars": args.memory_max_chars,
            "persist_memory": args.persist_memory,
            "write": args.write,
            "timeout_minutes": args.timeout_minutes,
        })
    elif action == "get":
        result = call("handoff_get", {"handoff_id": args.handoff_id})
    elif action == "list":
        result = call("handoff_list", {
            "project_path": args.project,
            "source_job_id": args.source_job_id,
            "target_worker": args.target_worker,
            "limit": args.limit,
        })
    else:
        raise ValueError("unsupported handoff action")
    emit(result)
    return 0


def _pool_env(values):
    out = {}
    for item in values or []:
        if "=" not in item:
            raise ValueError("--env values must use KEY=VALUE")
        key, value = item.split("=", 1)
        key = key.strip()
        if not key:
            raise ValueError("--env variable name cannot be empty")
        out[key] = value
    return out


def cmd_pool(args):
    action = args.pool_action
    if action == "list":
        result = call("mcp_pool_list", {})
    elif action == "tools":
        result = call("mcp_pool_tools", {
            "server": args.server,
            "refresh": args.refresh,
        })
    elif action == "call":
        try:
            arguments = json.loads(args.arguments or "{}")
        except Exception as exc:
            raise ValueError(f"--arguments must be a JSON object: {exc}")
        if not isinstance(arguments, dict):
            raise ValueError("--arguments must decode to a JSON object")
        result = call("mcp_pool_call", {
            "server": args.server,
            "tool_name": args.tool_name,
            "arguments": arguments,
            "timeout_seconds": args.timeout_seconds,
        })
    elif action == "register":
        if not args.yes:
            raise ValueError("pool register requires --yes")
        command = list(args.command or [])
        if command and command[0] == "--":
            command = command[1:]
        if not command:
            raise ValueError("pool register requires a command after --")
        result = call("mcp_pool_register", {
            "server": args.server,
            "command": command,
            "cwd": args.cwd,
            "env": _pool_env(args.env),
            "enabled": not args.disabled,
            "timeout_seconds": args.timeout_seconds,
            "confirm": True,
        })
    elif action == "restart":
        if not args.yes:
            raise ValueError("pool restart requires --yes")
        result = call("mcp_pool_restart", {"server": args.server, "confirm": True})
    elif action == "remove":
        if not args.yes:
            raise ValueError("pool remove requires --yes")
        result = call("mcp_pool_remove", {"server": args.server, "confirm": True})
    else:
        raise ValueError("unsupported pool action")
    emit(result)
    return 0


def cmd_test(args):
    argv = list(args.command or [])
    if argv and argv[0] == "--":
        argv = argv[1:]
    if not argv:
        raise ValueError("test requires a command after --")
    result = call("test_run", {
        "project_path": args.project,
        "tests": [{
            "name": args.name or "cli-test",
            "argv": argv,
            "timeout_seconds": args.timeout_seconds,
        }],
    })
    emit(result)
    return 0 if result.get("ok") else 1


def cmd_graph(args):
    if args.graph_action == "status":
        result = call("graph_status", {"graph_id": args.graph_id})
    elif args.graph_action == "start":
        result = call("graph_start", {"graph_id": args.graph_id})
    elif args.graph_action == "cancel":
        result = call("graph_cancel", {"graph_id": args.graph_id})
    else:
        raise ValueError("unsupported graph action")
    emit(result)
    return 0


def cmd_worktree(args):
    action = args.worktree_action
    if action == "list":
        result = call("worktree_list", {})
    elif action == "status":
        result = call("worktree_status", {"worktree_id": args.worktree_id})
    elif action == "diff":
        result = call("worktree_diff", {
            "worktree_id": args.worktree_id,
            "max_chars": args.max_chars,
        })
    elif action == "rebase":
        if not args.yes:
            raise ValueError("worktree rebase requires --yes")
        result = call("worktree_rebase", {
            "worktree_id": args.worktree_id,
            "confirm": True,
        })
    elif action == "merge":
        if not args.yes:
            raise ValueError("worktree merge requires --yes")
        result = call("worktree_merge", {
            "worktree_id": args.worktree_id,
            "confirm": True,
        })
    elif action == "discard":
        if not args.yes:
            raise ValueError("worktree discard requires --yes")
        result = call("worktree_discard", {
            "worktree_id": args.worktree_id,
            "confirm": True,
            "force": args.force,
        })
    else:
        raise ValueError("unsupported worktree action")
    emit(result)
    return 0


def cmd_mcp(args):
    if args.transport == "stdio":
        server.main()
        return 0
    if args.transport == "http":
        import http_mcp
        http_mcp.serve(args.host, args.port)
        return 0
    raise ValueError(f"unsupported MCP transport: {args.transport}")


def parser():
    p = argparse.ArgumentParser(
        prog="teamyra",
        description="TEAMYRA Multi-Agent Engineering OS",
    )
    p.add_argument("--version", action="version", version=f"TEAMYRA {VERSION}")
    sub = p.add_subparsers(dest="command_name", required=True)

    doctor = sub.add_parser("doctor", help="Check worker discovery, auth and core readiness")
    doctor.set_defaults(func=cmd_doctor)

    workers = sub.add_parser("workers", help="List discovered agent accounts/workers")
    workers.set_defaults(func=cmd_workers)

    jobs = sub.add_parser("jobs", help="List recent jobs or inspect one job")
    jobs.add_argument("job_id", nargs="?")
    jobs.set_defaults(func=cmd_jobs)

    run = sub.add_parser("run", help="Start one agent task")
    run.add_argument("--project", required=True)
    run.add_argument("--task", required=True)
    run.add_argument("--worker", default="auto")
    run.add_argument("--label")
    run.add_argument("--timeout-minutes", type=int, default=90)
    run.add_argument("--max-failovers", type=int, default=2)
    run.add_argument("--read-only", action="store_true")
    run.add_argument("--wait", action="store_true")
    run.add_argument("--wait-timeout", type=int, default=1800)
    run.set_defaults(func=cmd_run)

    wait = sub.add_parser("wait", help="Wait for one or more jobs")
    wait.add_argument("job_ids", nargs="+")
    wait.add_argument("--mode", choices=["all", "any"], default="all")
    wait.add_argument("--timeout-seconds", type=int, default=1500)
    wait.set_defaults(func=cmd_wait)

    result = sub.add_parser("result", help="Read a terminal job result")
    result.add_argument("job_id")
    result.set_defaults(func=cmd_result)

    timeline = sub.add_parser("timeline", help="Read the unified jobs/graphs/reviews/worktrees timeline")
    timeline.add_argument("--limit", type=int, default=100)
    timeline.add_argument("--project")
    timeline.add_argument("--worker")
    timeline.add_argument("--source", action="append", choices=["job", "graph", "review", "handoff", "worktree"])
    timeline.add_argument("--query")
    timeline.add_argument("--since", type=float)
    timeline.set_defaults(func=cmd_timeline)

    search = sub.add_parser("search", help="Search TEAMYRA job logs and transcripts")
    search.add_argument("query")
    search.add_argument("--limit", type=int, default=50)
    search.add_argument("--project")
    search.add_argument("--worker")
    search.add_argument("--kind", action="append", choices=["events.jsonl", "transcript.md", "stderr.txt", "runner.log", "task.txt"])
    search.set_defaults(func=cmd_search)

    usage = sub.add_parser("usage", help="Show real token usage plus live readiness/cooldown telemetry")
    usage.add_argument("--project")
    usage.set_defaults(func=cmd_usage)

    memory = sub.add_parser("memory", help="Manage local structured project memory")
    mem = memory.add_subparsers(dest="memory_action", required=True)

    mem_add = mem.add_parser("add")
    mem_add.add_argument("--project", required=True)
    mem_add.add_argument("--kind", required=True, choices=["decision","architecture","fact","note","handoff","todo"])
    mem_add.add_argument("--title", required=True)
    mem_add.add_argument("--content", required=True)
    mem_add.add_argument("--tag", action="append")
    mem_add.add_argument("--importance", choices=["low","normal","high","critical"], default="normal")
    mem_add.add_argument("--source-job-id")
    mem_add.add_argument("--source-graph-id")
    mem_add.set_defaults(func=cmd_memory)

    mem_list = mem.add_parser("list")
    mem_list.add_argument("--project", required=True)
    mem_list.add_argument("--kind", choices=["decision","architecture","fact","note","handoff","todo"])
    mem_list.add_argument("--status", choices=["active","archived","all"], default="active")
    mem_list.add_argument("--tag")
    mem_list.add_argument("--limit", type=int, default=100)
    mem_list.set_defaults(func=cmd_memory)

    mem_search = mem.add_parser("search")
    mem_search.add_argument("--project", required=True)
    mem_search.add_argument("query")
    mem_search.add_argument("--kind", action="append", choices=["decision","architecture","fact","note","handoff","todo"])
    mem_search.add_argument("--tag", action="append")
    mem_search.add_argument("--status", choices=["active","archived","all"], default="active")
    mem_search.add_argument("--limit", type=int, default=50)
    mem_search.set_defaults(func=cmd_memory)

    mem_get = mem.add_parser("get")
    mem_get.add_argument("--project", required=True)
    mem_get.add_argument("memory_id")
    mem_get.set_defaults(func=cmd_memory)

    mem_update = mem.add_parser("update")
    mem_update.add_argument("--project", required=True)
    mem_update.add_argument("memory_id")
    mem_update.add_argument("--title")
    mem_update.add_argument("--content")
    mem_update.add_argument("--tag", action="append")
    mem_update.add_argument("--importance", choices=["low","normal","high","critical"])
    mem_update.add_argument("--kind", choices=["decision","architecture","fact","note","handoff","todo"])
    mem_update.set_defaults(func=cmd_memory)

    mem_archive = mem.add_parser("archive")
    mem_archive.add_argument("--project", required=True)
    mem_archive.add_argument("memory_id")
    mem_archive.add_argument("--reason")
    mem_archive.set_defaults(func=cmd_memory)

    mem_context = mem.add_parser("context")
    mem_context.add_argument("--project", required=True)
    mem_context.add_argument("--query")
    mem_context.add_argument("--kind", action="append", choices=["decision","architecture","fact","note","handoff","todo"])
    mem_context.add_argument("--tag", action="append")
    mem_context.add_argument("--max-chars", type=int, default=8000)
    mem_context.add_argument("--limit", type=int, default=40)
    mem_context.set_defaults(func=cmd_memory)

    handoff = sub.add_parser("handoff", help="Create or inspect persistent structured cross-agent handoffs")
    handoff_sub = handoff.add_subparsers(dest="handoff_action", required=True)

    handoff_start = handoff_sub.add_parser("start")
    handoff_start.add_argument("job_id")
    handoff_start.add_argument("--message", required=True)
    handoff_start.add_argument("--target-worker", default="auto")
    handoff_start.add_argument("--objective")
    handoff_start.add_argument("--constraint", action="append")
    handoff_start.add_argument("--accept", action="append")
    handoff_start.add_argument("--artifact", action="append")
    handoff_start.add_argument("--notes")
    handoff_start.add_argument("--write", action="store_true")
    handoff_start.add_argument("--timeout-minutes", type=int, default=90)
    handoff_start.add_argument("--no-project-memory", action="store_true")
    handoff_start.add_argument("--memory-query")
    handoff_start.add_argument("--memory-max-chars", type=int, default=6000)
    handoff_start.add_argument("--persist-memory", action="store_true")
    handoff_start.set_defaults(func=cmd_handoff)

    handoff_get = handoff_sub.add_parser("get")
    handoff_get.add_argument("handoff_id")
    handoff_get.set_defaults(func=cmd_handoff)

    handoff_list = handoff_sub.add_parser("list")
    handoff_list.add_argument("--project")
    handoff_list.add_argument("--source-job-id")
    handoff_list.add_argument("--target-worker")
    handoff_list.add_argument("--limit", type=int, default=100)
    handoff_list.set_defaults(func=cmd_handoff)

    pool = sub.add_parser("pool", help="Manage shared external MCP stdio servers")
    pool_sub = pool.add_subparsers(dest="pool_action", required=True)
    pool_sub.add_parser("list").set_defaults(func=cmd_pool)

    pool_tools = pool_sub.add_parser("tools")
    pool_tools.add_argument("server")
    pool_tools.add_argument("--refresh", action="store_true")
    pool_tools.set_defaults(func=cmd_pool)

    pool_call = pool_sub.add_parser("call")
    pool_call.add_argument("server")
    pool_call.add_argument("tool_name")
    pool_call.add_argument("--arguments", default="{}")
    pool_call.add_argument("--timeout-seconds", type=int, default=30)
    pool_call.set_defaults(func=cmd_pool)

    pool_register = pool_sub.add_parser("register")
    pool_register.add_argument("server")
    pool_register.add_argument("--cwd")
    pool_register.add_argument("--env", action="append", default=[])
    pool_register.add_argument("--disabled", action="store_true")
    pool_register.add_argument("--timeout-seconds", type=int, default=30)
    pool_register.add_argument("--yes", action="store_true")
    pool_register.add_argument("command", nargs="+", help="External MCP argv; place after -- to preserve its flags")
    pool_register.set_defaults(func=cmd_pool)

    pool_restart = pool_sub.add_parser("restart")
    pool_restart.add_argument("server")
    pool_restart.add_argument("--yes", action="store_true")
    pool_restart.set_defaults(func=cmd_pool)

    pool_remove = pool_sub.add_parser("remove")
    pool_remove.add_argument("server")
    pool_remove.add_argument("--yes", action="store_true")
    pool_remove.set_defaults(func=cmd_pool)

    test = sub.add_parser("test", help="Run one deterministic no-shell test command")
    test.add_argument("--project", required=True)
    test.add_argument("--name")
    test.add_argument("--timeout-seconds", type=int, default=300)
    test.add_argument("command", nargs=argparse.REMAINDER)
    test.set_defaults(func=cmd_test)

    graph = sub.add_parser("graph", help="Control a task graph")
    graph_sub = graph.add_subparsers(dest="graph_action", required=True)
    for action in ("status", "start", "cancel"):
        item = graph_sub.add_parser(action)
        item.add_argument("graph_id")
        item.set_defaults(func=cmd_graph)

    worktree = sub.add_parser("worktree", help="Inspect and integrate managed worktrees")
    wt_sub = worktree.add_subparsers(dest="worktree_action", required=True)
    wt_sub.add_parser("list").set_defaults(func=cmd_worktree)
    wt_status = wt_sub.add_parser("status")
    wt_status.add_argument("worktree_id")
    wt_status.set_defaults(func=cmd_worktree)
    wt_diff = wt_sub.add_parser("diff")
    wt_diff.add_argument("worktree_id")
    wt_diff.add_argument("--max-chars", type=int, default=50000)
    wt_diff.set_defaults(func=cmd_worktree)
    for action in ("rebase", "merge"):
        item = wt_sub.add_parser(action)
        item.add_argument("worktree_id")
        item.add_argument("--yes", action="store_true")
        item.set_defaults(func=cmd_worktree)
    wt_discard = wt_sub.add_parser("discard")
    wt_discard.add_argument("worktree_id")
    wt_discard.add_argument("--yes", action="store_true")
    wt_discard.add_argument("--force", action="store_true")
    wt_discard.set_defaults(func=cmd_worktree)

    mcp = sub.add_parser("mcp", help="Run TEAMYRA as an MCP server")
    mcp.add_argument("transport", choices=["stdio", "http"])
    mcp.add_argument("--host", default="127.0.0.1",
                     help="HTTP bind host (localhost-only in this build)")
    mcp.add_argument("--port", type=int, default=8787)
    mcp.set_defaults(func=cmd_mcp)

    return p


def main(argv=None):
    args = parser().parse_args(argv)
    try:
        return int(args.func(args) or 0)
    except KeyboardInterrupt:
        return 130
    except Exception as exc:
        print(f"TEAMYRA error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
