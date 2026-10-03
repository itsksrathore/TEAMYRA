"""Detached TEAMYRA Conductor for one persistent dependency graph.

Graphs remain sequential by default. When max_parallel > 1, independent nodes may
run concurrently. Write nodes are isolated in managed Git worktrees and are only
marked done after their branch is snapshotted, rebased, merged, and safely cleaned
up. This keeps dependency visibility deterministic while allowing parallel work.
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


def _active_ids(graph):
    raw = graph.get("active_node_ids")
    ids = list(raw) if isinstance(raw, list) else []
    legacy = graph.get("active_node_id")
    if legacy and legacy not in ids:
        ids.insert(0, legacy)
    nodes = _node_map(graph)
    return [
        node_id for node_id in ids
        if node_id in nodes and nodes[node_id].get("status") == "running"
    ]


def _set_active_ids(graph, ids):
    clean = []
    seen = set()
    nodes = _node_map(graph)
    for node_id in ids:
        if node_id in seen or node_id not in nodes:
            continue
        if nodes[node_id].get("status") != "running":
            continue
        seen.add(node_id)
        clean.append(node_id)
    graph["active_node_ids"] = clean
    graph["active_node_id"] = clean[0] if clean else None
    return clean


def _save(graph):
    task_graph.terminalize_graph(graph)
    return task_graph.save_graph(server.ROOT, graph)


def _cancel_active_jobs(graph):
    cancelled = 0
    for active_id in _active_ids(graph):
        node = _node_map(graph).get(active_id)
        if not node or not node.get("job_id"):
            continue
        terminal_id = server.failover_terminal_job_id(node["job_id"])
        if server.is_done(terminal_id):
            continue
        (server.JOBS / terminal_id / "CANCEL").write_text("cancel", encoding="utf-8")
        cancelled += 1
    return cancelled


def _integrate_worktree(graph, node):
    worktree_id = node.get("worktree_id")
    if not worktree_id:
        return

    node["merge_state"] = "snapshotting"
    snapshot = server.worktree_manager.snapshot(
        server.WORKTREES,
        worktree_id,
        f"TEAMYRA graph {graph['id']} node {node['id']}",
    )
    if snapshot.get("committed"):
        node["snapshot_commit"] = snapshot.get("head")

    node["merge_state"] = "rebasing"
    rebased = server.worktree_manager.rebase(server.WORKTREES, worktree_id)
    node["rebased_head"] = rebased.get("head")

    node["merge_state"] = "merging"
    merged = server.worktree_manager.merge(server.WORKTREES, worktree_id)
    node["merged_commit"] = merged.get("merged_commit")
    node["merge_state"] = "merged"

    try:
        server.worktree_manager.discard(server.WORKTREES, worktree_id, force=False)
        node["worktree_removed"] = True
    except Exception as exc:
        node["worktree_removed"] = False
        node["worktree_cleanup_error"] = str(exc)


def _resolve_active_nodes(graph):
    active = _active_ids(graph)
    if not active:
        _set_active_ids(graph, [])
        return False

    changed = False
    remaining = []
    nodes = _node_map(graph)
    for active_id in active:
        node = nodes.get(active_id)
        if not node:
            graph["error"] = f"active node disappeared: {active_id}"
            changed = True
            continue

        job_id = node.get("job_id")
        if not job_id:
            node["status"] = "failed"
            node["error"] = "active node has no job id"
            node["ended_at"] = time.time()
            changed = True
            continue

        if not server.chain_is_complete(job_id):
            remaining.append(active_id)
            continue

        result = server.job_result(job_id)
        terminal_state = result.get("state")
        node["terminal_job_id"] = (
            result.get("terminal_job_id") or server.failover_terminal_job_id(job_id)
        )
        node["terminal_worker"] = result.get("worker")
        node["ended_at"] = time.time()

        if terminal_state == "done":
            try:
                _integrate_worktree(graph, node)
                node["status"] = "done"
                node["error"] = None
            except Exception as exc:
                node["status"] = "failed"
                node["merge_state"] = "failed"
                node["error"] = f"worktree integration failed: {exc}"
        elif terminal_state == "cancelled":
            node["status"] = "cancelled"
            node["error"] = result.get("reason")
        else:
            node["status"] = "failed"
            node["error"] = result.get("reason")

        changed = True

    _set_active_ids(graph, remaining)
    if changed:
        task_graph.mark_blocked_nodes(graph)
    return changed


def _cancel_pending_nodes(graph):
    for node in graph.get("nodes", []):
        if node.get("status") == "pending":
            node["status"] = "cancelled"
            node["ended_at"] = time.time()
            node["error"] = "graph cancelled"


def _temporary_auto_worker_error(exc):
    text = str(exc).lower()
    return any(token in text for token in (
        "no authenticated worker is currently ready",
        "cooling down after a usage limit",
        "not authenticated/ready",
    ))


def _launch_node(graph, node, used_workers):
    requested_worker = node.get("worker") or "auto"
    auto_failover = requested_worker == "auto"

    try:
        if auto_failover:
            selected_worker = server.pick_worker("auto", exclude=used_workers)
        else:
            selected_worker = requested_worker
    except Exception:
        if auto_failover:
            return "deferred"
        raise

    worktree = None
    cwd = graph["project_path"]
    if int(graph.get("max_parallel", 1)) > 1 and node.get("write", True):
        try:
            worktree = server.worktree_manager.create(
                graph["project_path"],
                server.WORKTREES,
                label=f"graph-{graph['id']}-{node['id']}",
                base_ref="HEAD",
            )
            cwd = worktree["path"]
            node["worktree_id"] = worktree["id"]
            node["worktree_path"] = worktree["path"]
            node["worktree_branch"] = worktree["branch"]
            node["merge_state"] = "pending"
        except Exception as exc:
            node["status"] = "failed"
            node["ended_at"] = time.time()
            node["error"] = f"worktree creation failed: {exc}"
            return "failed"

    try:
        job_id, selected_worker = server.start_job(
            selected_worker,
            node["task"],
            cwd,
            node.get("label"),
            int(node.get("timeout_minutes") or 90),
            node.get("write", True),
            parent=f"graph:{graph['id']}",
            auto_failover=auto_failover,
            max_failovers=server.config().get("max_failovers", 2),
        )
    except Exception as exc:
        if worktree:
            try:
                server.worktree_manager.discard(
                    server.WORKTREES, worktree["id"], force=True
                )
            except Exception:
                pass
            node["worktree_id"] = None
            node["worktree_path"] = None
            node["worktree_branch"] = None
            node["merge_state"] = "not_required"
        if auto_failover and _temporary_auto_worker_error(exc):
            return "deferred"
        node["status"] = "failed"
        node["ended_at"] = time.time()
        node["error"] = f"worker launch failed: {exc}"
        return "failed"

    meta_patch = {
        "graph_id": graph["id"],
        "graph_node_id": node["id"],
        "graph_depends_on": list(node.get("depends_on") or []),
    }
    if worktree:
        meta_patch.update(
            worktree_id=worktree["id"],
            worktree_branch=worktree["branch"],
        )
    server.patch_job_meta(job_id, **meta_patch)

    node["status"] = "running"
    node["job_id"] = job_id
    node["selected_worker"] = selected_worker
    node["started_at"] = time.time()
    return "launched"


def _launch_ready_nodes(graph):
    active = _active_ids(graph)
    limit = max(1, min(int(graph.get("max_parallel") or 1), 4))
    slots = max(0, limit - len(active))
    if slots == 0:
        return 0, False

    nodes = _node_map(graph)
    used_workers = {
        nodes[node_id].get("selected_worker")
        for node_id in active
        if nodes.get(node_id) and nodes[node_id].get("selected_worker")
    }
    launched = 0
    deferred = False

    for node in task_graph.ready_nodes(graph):
        if slots <= 0:
            break
        try:
            outcome = _launch_node(graph, node, used_workers)
        except Exception as exc:
            node["status"] = "failed"
            node["ended_at"] = time.time()
            node["error"] = f"worker launch failed: {exc}"
            outcome = "failed"

        if outcome == "launched":
            active.append(node["id"])
            if node.get("selected_worker"):
                used_workers.add(node["selected_worker"])
            launched += 1
            slots -= 1
        elif outcome == "deferred":
            deferred = True

    _set_active_ids(graph, active)
    if launched or task_graph.mark_blocked_nodes(graph):
        return launched, deferred
    return launched, deferred


def tick(graph_id):
    """Advance one Conductor state-machine step and persist the graph."""
    graph = task_graph.load_graph(server.ROOT, graph_id)
    if task_graph.graph_is_terminal(graph):
        return graph

    graph.setdefault("max_parallel", 1)
    graph.setdefault("active_node_ids", [])
    if graph.get("state") in {"draft", "starting"}:
        graph["state"] = "running"
        graph["conductor_pid"] = os.getpid()
        graph["started_at"] = graph.get("started_at") or time.time()

    _resolve_active_nodes(graph)

    if graph.get("cancel_requested"):
        _cancel_active_jobs(graph)
        _cancel_pending_nodes(graph)
        if _active_ids(graph):
            graph["state"] = "cancelling"
            return task_graph.save_graph(server.ROOT, graph)
        _set_active_ids(graph, [])
        return _save(graph)

    task_graph.mark_blocked_nodes(graph)
    task_graph.terminalize_graph(graph)
    if task_graph.graph_is_terminal(graph):
        _set_active_ids(graph, [])
        return task_graph.save_graph(server.ROOT, graph)

    waiting = task_graph.awaiting_approval_nodes(graph)
    graph["approval_pending_node_ids"] = [node["id"] for node in waiting]
    graph["approval_pending_node_id"] = (
        graph["approval_pending_node_ids"][0]
        if graph["approval_pending_node_ids"] else None
    )

    launched, deferred = _launch_ready_nodes(graph)
    task_graph.mark_blocked_nodes(graph)
    task_graph.terminalize_graph(graph)
    if task_graph.graph_is_terminal(graph):
        _set_active_ids(graph, [])
        return task_graph.save_graph(server.ROOT, graph)

    active = _active_ids(graph)
    ready = task_graph.ready_nodes(graph)
    waiting = task_graph.awaiting_approval_nodes(graph)
    graph["approval_pending_node_ids"] = [node["id"] for node in waiting]
    graph["approval_pending_node_id"] = (
        graph["approval_pending_node_ids"][0]
        if graph["approval_pending_node_ids"] else None
    )

    if active:
        graph["state"] = "running"
        graph["error"] = None
    elif ready:
        graph["state"] = "waiting_for_worker"
        graph["error"] = None if deferred or launched else "ready nodes are waiting for worker capacity"
    elif waiting:
        graph["state"] = "awaiting_approval"
        graph["error"] = None
    else:
        graph["state"] = "failed"
        graph["error"] = "no runnable node remains"

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
            _set_active_ids(graph, _active_ids(graph))
            task_graph.save_graph(server.ROOT, graph)
        finally:
            raise


if __name__ == "__main__":
    main()
