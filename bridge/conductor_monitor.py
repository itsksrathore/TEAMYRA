"""Detached sequential Conductor for one TEAMYRA dependency graph.

Phase 3 deliberately runs one graph node at a time in the shared workspace.
Parallel write execution stays deferred until Phase 4 worktree merge semantics.
The public tick() function advances exactly one state-machine step and is unit
testable without launching a background process.
"""
import os
import sys
import time
from pathlib import Path

BRIDGE = Path(__file__).resolve().parent
sys.path.insert(0, str(BRIDGE))

import server
import task_graph


TERMINAL_NODE_STATES = {"done", "failed", "cancelled", "blocked"}


def _node_map(graph):
    return task_graph.node_map(graph)


def _save(graph):
    task_graph.terminalize_graph(graph)
    return task_graph.save_graph(server.ROOT, graph)


def _cancel_active_job(graph):
    active_id = graph.get("active_node_id")
    if not active_id:
        return False
    node = _node_map(graph).get(active_id)
    if not node or not node.get("job_id"):
        return False
    terminal_id = server.failover_terminal_job_id(node["job_id"])
    if server.is_done(terminal_id):
        return False
    (server.JOBS / terminal_id / "CANCEL").write_text("cancel", encoding="utf-8")
    return True


def _resolve_active_node(graph):
    active_id = graph.get("active_node_id")
    if not active_id:
        return False

    node = _node_map(graph).get(active_id)
    if not node:
        graph["state"] = "failed"
        graph["error"] = f"active node disappeared: {active_id}"
        graph["active_node_id"] = None
        return True

    job_id = node.get("job_id")
    if not job_id:
        node["status"] = "failed"
        node["error"] = "active node has no job id"
        node["ended_at"] = time.time()
        graph["active_node_id"] = None
        return True

    if not server.chain_is_complete(job_id):
        return False

    result = server.job_result(job_id)
    terminal_state = result.get("state")
    if terminal_state == "done":
        node["status"] = "done"
    elif terminal_state == "cancelled":
        node["status"] = "cancelled"
    else:
        node["status"] = "failed"

    node["ended_at"] = time.time()
    node["terminal_job_id"] = result.get("terminal_job_id") or server.failover_terminal_job_id(job_id)
    node["terminal_worker"] = result.get("worker")
    node["error"] = result.get("reason")
    graph["active_node_id"] = None
    task_graph.mark_blocked_nodes(graph)
    return True


def _cancel_pending_nodes(graph):
    for node in graph.get("nodes", []):
        if node.get("status") == "pending":
            node["status"] = "cancelled"
            node["ended_at"] = time.time()
            node["error"] = "graph cancelled"


def _launch_ready_node(graph):
    ready = task_graph.ready_nodes(graph)
    if not ready:
        return False

    node = ready[0]
    requested_worker = node.get("worker") or "auto"
    auto_failover = requested_worker == "auto"
    try:
        job_id, selected_worker = server.start_job(
            requested_worker,
            node["task"],
            graph["project_path"],
            node.get("label"),
            int(node.get("timeout_minutes") or 90),
            node.get("write", True),
            parent=f"graph:{graph['id']}",
            auto_failover=auto_failover,
            max_failovers=server.config().get("max_failovers", 2),
        )
    except Exception as exc:
        node["status"] = "failed"
        node["ended_at"] = time.time()
        node["error"] = f"worker launch failed: {exc}"
        task_graph.mark_blocked_nodes(graph)
        return True

    server.patch_job_meta(
        job_id,
        graph_id=graph["id"],
        graph_node_id=node["id"],
        graph_depends_on=list(node.get("depends_on") or []),
    )
    node["status"] = "running"
    node["job_id"] = job_id
    node["selected_worker"] = selected_worker
    node["started_at"] = time.time()
    graph["active_node_id"] = node["id"]
    return True


def tick(graph_id):
    """Advance one Conductor state-machine step and persist the graph."""
    graph = task_graph.load_graph(server.ROOT, graph_id)
    if task_graph.graph_is_terminal(graph):
        return graph

    if graph.get("state") in {"draft", "starting"}:
        graph["state"] = "running"
        graph["conductor_pid"] = os.getpid()
        graph["started_at"] = graph.get("started_at") or time.time()

    active_id = graph.get("active_node_id")
    if active_id:
        resolved = _resolve_active_node(graph)
        if not resolved:
            if graph.get("cancel_requested"):
                _cancel_active_job(graph)
                graph["state"] = "cancelling"
            return task_graph.save_graph(server.ROOT, graph)

    if graph.get("cancel_requested"):
        _cancel_pending_nodes(graph)
        graph["active_node_id"] = None
        return _save(graph)

    task_graph.mark_blocked_nodes(graph)
    task_graph.terminalize_graph(graph)
    if task_graph.graph_is_terminal(graph):
        graph["active_node_id"] = None
        return task_graph.save_graph(server.ROOT, graph)

    waiting = task_graph.awaiting_approval_nodes(graph)
    if waiting:
        graph["state"] = "awaiting_approval"
        graph["approval_pending_node_id"] = waiting[0]["id"]
        graph["active_node_id"] = None
        graph["error"] = None
        return task_graph.save_graph(server.ROOT, graph)

    graph["approval_pending_node_id"] = None
    if not _launch_ready_node(graph):
        graph["state"] = "failed"
        graph["error"] = "no runnable node remains"
        graph["active_node_id"] = None
        return task_graph.save_graph(server.ROOT, graph)

    return task_graph.save_graph(server.ROOT, graph)


def main():
    if len(sys.argv) != 2:
        raise SystemExit("usage: conductor_monitor.py <graph_id>")

    graph_id = sys.argv[1]
    try:
        while True:
            graph = tick(graph_id)
            if task_graph.graph_is_terminal(graph):
                return
            time.sleep(2)
    except Exception as exc:
        try:
            graph = task_graph.load_graph(server.ROOT, graph_id)
            graph["state"] = "failed"
            graph["error"] = f"conductor crashed: {exc}"
            graph["active_node_id"] = None
            task_graph.save_graph(server.ROOT, graph)
        finally:
            raise


if __name__ == "__main__":
    main()
