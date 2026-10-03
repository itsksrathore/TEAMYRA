"""Detached sequential conductor for one TEAMYRA task graph.

Phase 3 deliberately executes one graph node at a time in the same workspace.
Parallel write execution is deferred until Phase 4 worktree merge/rebase semantics
are available.
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


def finish_graph(graph):
    statuses = [node.get("status") for node in graph.get("nodes", [])]
    if statuses and all(status == "done" for status in statuses):
        graph["state"] = "done"
    elif graph.get("cancel_requested"):
        graph["state"] = "cancelled"
    else:
        graph["state"] = "failed"
    graph["active_node_id"] = None
    task_graph.save_graph(server.ROOT, graph)


def cancel_active_job(graph):
    active_id = graph.get("active_node_id")
    if not active_id:
        return
    nodes = task_graph.node_map(graph)
    node = nodes.get(active_id)
    if not node or not node.get("job_id"):
        return
    terminal_id = server.failover_terminal_job_id(node["job_id"])
    if not server.is_done(terminal_id):
        (server.JOBS / terminal_id / "CANCEL").write_text("cancel", encoding="utf-8")


def main():
    if len(sys.argv) != 2:
        raise SystemExit("usage: conductor_monitor.py <graph_id>")

    graph_id = sys.argv[1]
    graph = task_graph.load_graph(server.ROOT, graph_id)
    graph["state"] = "running"
    graph["conductor_pid"] = os.getpid()
    graph["started_at"] = graph.get("started_at") or time.time()
    task_graph.save_graph(server.ROOT, graph)

    while True:
        graph = task_graph.load_graph(server.ROOT, graph_id)
        nodes = task_graph.node_map(graph)

        if graph.get("cancel_requested"):
            cancel_active_job(graph)

        active_id = graph.get("active_node_id")
        if active_id:
            node = nodes.get(active_id)
            if not node:
                graph["state"] = "failed"
                graph["error"] = f"active node disappeared: {active_id}"
                task_graph.save_graph(server.ROOT, graph)
                return

            job_id = node.get("job_id")
            if job_id and server.chain_is_complete(job_id):
                result = server.job_result(job_id)
                terminal_state = result.get("state")
                node["status"] = "done" if terminal_state == "done" else (
                    "cancelled" if terminal_state == "cancelled" else "failed"
                )
                node["ended_at"] = time.time()
                node["terminal_job_id"] = result.get("terminal_job_id")
                node["terminal_worker"] = result.get("worker")
                node["error"] = result.get("reason")
                graph["active_node_id"] = None
                task_graph.mark_blocked_nodes(graph)
                task_graph.save_graph(server.ROOT, graph)
                continue

            time.sleep(2)
            continue

        if graph.get("cancel_requested"):
            for node in graph.get("nodes", []):
                if node.get("status") == "pending":
                    node["status"] = "cancelled"
                    node["ended_at"] = time.time()
                    node["error"] = "graph cancelled"
            finish_graph(graph)
            return

        task_graph.mark_blocked_nodes(graph)
        if all(node.get("status") in TERMINAL_NODE_STATES for node in graph.get("nodes", [])):
            finish_graph(graph)
            return

        ready = task_graph.ready_nodes(graph)
        if not ready:
            graph["state"] = "failed"
            graph["error"] = "no runnable node remains"
            finish_graph(graph)
            return

        node = ready[0]

        if node.get("requires_approval"):
            approval = node.get("approval_status", "pending")
            if approval == "denied":
                node["status"] = "cancelled"
                node["ended_at"] = time.time()
                node["error"] = node.get("approval_note") or "approval denied"
                graph["approval_pending_node_id"] = None
                task_graph.mark_blocked_nodes(graph)
                task_graph.save_graph(server.ROOT, graph)
                continue
            if approval != "approved":
                graph["state"] = "waiting_approval"
                graph["approval_pending_node_id"] = node["id"]
                task_graph.save_graph(server.ROOT, graph)
                time.sleep(2)
                continue

        graph["state"] = "running"
        graph["approval_pending_node_id"] = None
        requested_worker = node.get("worker") or "auto"
        auto_failover = requested_worker == "auto"
        job_id, selected_worker = server.start_job(
            requested_worker,
            node["task"],
            graph["project_path"],
            node.get("label"),
            int(server.config().get("job_timeout_minutes", 180)),
            node.get("write", True),
            parent=f"graph:{graph_id}",
            auto_failover=auto_failover,
            max_failovers=server.config().get("max_failovers", 2),
        )
        server.patch_job_meta(
            job_id,
            graph_id=graph_id,
            graph_node_id=node["id"],
            graph_depends_on=list(node.get("depends_on") or []),
        )
        node["status"] = "running"
        node["job_id"] = job_id
        node["selected_worker"] = selected_worker
        node["started_at"] = time.time()
        graph["active_node_id"] = node["id"]
        task_graph.save_graph(server.ROOT, graph)


if __name__ == "__main__":
    main()
