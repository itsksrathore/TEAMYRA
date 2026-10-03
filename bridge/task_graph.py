"""Persistent task-graph primitives for TEAMYRA orchestration."""
import json
import os
import re
import time
import uuid
from pathlib import Path

import test_policy

NODE_ID_RE = re.compile(r"^[A-Za-z0-9._-]{1,64}$")


def _graphs_dir(root):
    path = Path(root) / "tasks"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _graph_path(root, graph_id):
    if not NODE_ID_RE.fullmatch(str(graph_id or "")):
        raise ValueError("invalid graph id")
    return _graphs_dir(root) / f"{graph_id}.json"


def _atomic_write(path, data):
    tmp = path.with_name(path.name + f".tmp-{os.getpid()}-{uuid.uuid4().hex[:6]}")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, path)


def _validate_nodes(nodes):
    if not isinstance(nodes, list) or not nodes:
        raise ValueError("nodes must be a non-empty list")

    seen = set()
    normalized = []
    for raw in nodes:
        if not isinstance(raw, dict):
            raise ValueError("each node must be an object")
        node_id = str(raw.get("id") or "").strip()
        if not NODE_ID_RE.fullmatch(node_id):
            raise ValueError(f"invalid node id: {node_id}")
        if node_id in seen:
            raise ValueError(f"duplicate node id: {node_id}")
        seen.add(node_id)

        task = str(raw.get("task") or "").strip()
        if not task:
            raise ValueError(f"node {node_id} is missing task text")

        deps = list(raw.get("depends_on") or [])
        if any(not isinstance(dep, str) for dep in deps):
            raise ValueError(f"node {node_id} has invalid dependencies")

        timeout = max(1, min(int(raw.get("timeout_minutes") or 90), 360))
        requires_approval = raw.get("requires_approval", False) is True
        approval_reason = str(raw.get("approval_reason") or "").strip()[:500] or None
        tests = test_policy.normalize_steps(raw.get("tests") or [])
        normalized.append({
            "id": node_id,
            "label": str(raw.get("label") or node_id).strip()[:120] or node_id,
            "task": task,
            "worker": str(raw.get("worker") or "auto"),
            "depends_on": deps,
            "write": raw.get("write", True) is not False,
            "timeout_minutes": timeout,
            "requires_approval": requires_approval,
            "approval_status": "pending" if requires_approval else "not_required",
            "approval_reason": approval_reason,
            "approved_at": None,
            "denied_at": None,
            "approval_note": None,
            "status": "pending",
            "job_id": None,
            "started_at": None,
            "ended_at": None,
            "error": None,
            "tests": tests,
            "test_status": "pending" if tests else "not_required",
            "test_error": None,
            "test_results": [],
            "worktree_id": None,
            "worktree_path": None,
            "worktree_branch": None,
            "snapshot_commit": None,
            "merged_commit": None,
            "merge_state": "not_required",
        })

    for node in normalized:
        for dep in node["depends_on"]:
            if dep not in seen:
                raise ValueError(f"node {node['id']} depends on unknown node {dep}")
            if dep == node["id"]:
                raise ValueError(f"node {node['id']} cannot depend on itself")

    by_id = {node["id"]: node for node in normalized}
    visiting, visited = set(), set()

    def visit(node_id):
        if node_id in visited:
            return
        if node_id in visiting:
            raise ValueError("task graph contains a dependency cycle")
        visiting.add(node_id)
        for dep in by_id[node_id]["depends_on"]:
            visit(dep)
        visiting.remove(node_id)
        visited.add(node_id)

    for node_id in by_id:
        visit(node_id)

    return normalized


def create_graph(root, title, project_path, nodes, objective=None, max_parallel=1):
    graph_id = "graph-" + time.strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:6]
    now = time.time()
    graph = {
        "id": graph_id,
        "title": str(title or graph_id).strip()[:120] or graph_id,
        "objective": str(objective or "").strip(),
        "project_path": str(Path(project_path).resolve()),
        "state": "draft",
        "created_at": now,
        "updated_at": now,
        "cancel_requested": False,
        "max_parallel": max(1, min(int(max_parallel or 1), 4)),
        "active_node_id": None,
        "active_node_ids": [],
        "nodes": _validate_nodes(nodes),
    }
    _atomic_write(_graph_path(root, graph_id), graph)
    return graph


def load_graph(root, graph_id):
    path = _graph_path(root, graph_id)
    if not path.exists():
        raise ValueError(f"no such graph: {graph_id}")
    return json.loads(path.read_text(encoding="utf-8"))


def save_graph(root, graph):
    graph["updated_at"] = time.time()
    _atomic_write(_graph_path(root, graph["id"]), graph)
    return graph


def node_map(graph):
    return {node["id"]: node for node in graph.get("nodes", [])}


def ready_nodes(graph):
    nodes = node_map(graph)
    ready = []
    for node in graph.get("nodes", []):
        if node.get("status") != "pending":
            continue
        deps = [nodes[dep] for dep in node.get("depends_on", [])]
        if any(dep.get("status") in {"failed", "cancelled", "blocked"} for dep in deps):
            continue
        if all(dep.get("status") == "done" for dep in deps):
            if node.get("requires_approval") and node.get("approval_status") != "approved":
                continue
            ready.append(node)
    return ready


def awaiting_approval_nodes(graph):
    nodes = node_map(graph)
    waiting = []
    for node in graph.get("nodes", []):
        if node.get("status") != "pending" or not node.get("requires_approval"):
            continue
        deps = [nodes[dep] for dep in node.get("depends_on", [])]
        if (all(dep.get("status") == "done" for dep in deps)
                and node.get("approval_status") == "pending"):
            waiting.append(node)
    return waiting


def decide_approval(graph, node_id, decision, note=None):
    nodes = node_map(graph)
    node = nodes.get(node_id)
    if not node:
        raise ValueError(f"no such graph node: {node_id}")
    if node.get("status") != "pending":
        raise ValueError(f"node {node_id} cannot be approved from state {node.get('status')}")
    if not node.get("requires_approval"):
        raise ValueError(f"node {node_id} does not require approval")

    deps = [nodes[dep] for dep in node.get("depends_on", [])]
    if not all(dep.get("status") == "done" for dep in deps):
        raise ValueError(f"node {node_id} dependencies are not complete")

    decision = str(decision or "").strip().lower()
    if decision not in {"approve", "deny"}:
        raise ValueError("decision must be approve or deny")

    node["approval_note"] = str(note or "").strip()[:500] or None
    if decision == "approve":
        node["approval_status"] = "approved"
        node["approved_at"] = time.time()
        node["denied_at"] = None
    else:
        node["approval_status"] = "denied"
        node["denied_at"] = time.time()
        node["approved_at"] = None
        node["status"] = "cancelled"
        node["ended_at"] = time.time()
        node["error"] = "approval denied"
        mark_blocked_nodes(graph)
    return node


def approve_node(graph, node_id, note=None):
    return decide_approval(graph, node_id, "approve", note)

def mark_blocked_nodes(graph):
    nodes = node_map(graph)
    changed_any = False
    while True:
        changed = False
        for node in graph.get("nodes", []):
            if node.get("status") != "pending":
                continue
            deps = [nodes[dep] for dep in node.get("depends_on", [])]
            failed = [dep for dep in deps if dep.get("status") in {"failed", "cancelled", "blocked"}]
            if failed:
                node["status"] = "blocked"
                node["ended_at"] = time.time()
                node["error"] = "blocked by dependency: " + ", ".join(dep["id"] for dep in failed)
                changed = True
                changed_any = True
        if not changed:
            break
    return changed_any


def graph_summary(graph):
    counts = {}
    for node in graph.get("nodes", []):
        counts[node.get("status", "unknown")] = counts.get(node.get("status", "unknown"), 0) + 1
    return {
        "id": graph["id"],
        "title": graph.get("title"),
        "objective": graph.get("objective"),
        "project_path": graph.get("project_path"),
        "state": graph.get("state"),
        "max_parallel": graph.get("max_parallel", 1),
        "active_node_id": graph.get("active_node_id"),
        "active_node_ids": list(graph.get("active_node_ids") or ([graph.get("active_node_id")] if graph.get("active_node_id") else [])),
        "approval_pending_node_id": graph.get("approval_pending_node_id"),
        "approval_pending_node_ids": list(graph.get("approval_pending_node_ids") or ([graph.get("approval_pending_node_id")] if graph.get("approval_pending_node_id") else [])),
        "counts": counts,
        "nodes": [
            {
                "id": node["id"],
                "label": node.get("label"),
                "worker": node.get("worker"),
                "selected_worker": node.get("selected_worker"),
                "depends_on": node.get("depends_on", []),
                "write": node.get("write", True),
                "timeout_minutes": node.get("timeout_minutes", 90),
                "status": node.get("status"),
                "job_id": node.get("job_id"),
                "terminal_job_id": node.get("terminal_job_id"),
                "terminal_worker": node.get("terminal_worker"),
                "requires_approval": node.get("requires_approval", False),
                "approval_status": node.get("approval_status", "not_required"),
                "approval_reason": node.get("approval_reason"),
                "approved_at": node.get("approved_at"),
                "denied_at": node.get("denied_at"),
                "approval_note": node.get("approval_note"),
                "worktree_id": node.get("worktree_id"),
                "worktree_path": node.get("worktree_path"),
                "worktree_branch": node.get("worktree_branch"),
                "snapshot_commit": node.get("snapshot_commit"),
                "merged_commit": node.get("merged_commit"),
                "merge_state": node.get("merge_state", "not_required"),
                "tests": node.get("tests", []),
                "test_status": node.get("test_status", "not_required"),
                "test_error": node.get("test_error"),
                "test_results": [
                    {
                        "name": item.get("name"),
                        "ok": item.get("ok"),
                        "exit_code": item.get("exit_code"),
                        "timed_out": item.get("timed_out"),
                        "elapsed_s": item.get("elapsed_s"),
                    }
                    for item in node.get("test_results", [])
                ],
                "error": node.get("error"),
            }
            for node in graph.get("nodes", [])
        ],
    }

def graph_is_terminal(graph):
    return graph.get("state") in {"done", "failed", "cancelled"}


def terminalize_graph(graph):
    mark_blocked_nodes(graph)
    nodes = graph.get("nodes", [])
    if graph.get("cancel_requested"):
        if all(node.get("status") in {"done", "failed", "cancelled", "blocked"} for node in nodes):
            graph["state"] = "cancelled"
        else:
            graph["state"] = "cancelling"
    elif nodes and all(node.get("status") == "done" for node in nodes):
        graph["state"] = "done"
    elif nodes and all(node.get("status") in {"done", "failed", "cancelled", "blocked"} for node in nodes):
        graph["state"] = "failed"
    else:
        graph["state"] = "running"
    return graph
