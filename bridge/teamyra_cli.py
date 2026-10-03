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
    if args.transport != "stdio":
        raise ValueError("only stdio is implemented in this build")
    server.main()
    return 0


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
    mcp.add_argument("transport", choices=["stdio"])
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
