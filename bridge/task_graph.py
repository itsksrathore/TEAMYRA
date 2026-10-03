"""Persistent task-graph primitives for TEAMYRA orchestration."""
import json
import os
import re
import time
import uuid
from pathlib import Path

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
        normalized.append({
            "id": node_id,
            "label": str(raw.get("label") or node_id).strip()[:120] or node_id,
            "task": task,
            "worker": str(raw.get("worker") or "auto"),
            "depends_on": deps,
            "write": raw.get("write", True) is not False,
            "timeout_minutes": timeout,
            "status": "pending",
            "job_id": None,
            "started_at": None,
            "ended_at": None,
            "error": None,
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


def create_graph(root, title, project_path, nodes, objective=None):
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
        "active_node_id": None,
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
            ready.append(node)
    return ready


def mark_blocked_nodes(graph):
    nodes = node_map(graph)
    changed = False
    for node in graph.get("nodes", []):
        if node.get("status") != "pending":
            continue
        deps = [nodes[dep] for dep in node.get("depends_on", [])]
        if any(dep.get("status") in {"failed", "cancelled", "blocked"} for dep in deps):
            node["status"] = "blocked"
            node["ended_at"] = time.time()
            node["error"] = "dependency failed or was cancelled"
            changed = True
    return changed


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
        "active_node_id": graph.get("active_node_id"),
        "counts": counts,
        "nodes": [
            {
                "id": node["id"],
                "label": node.get("label"),
                "worker": node.get("worker"),
                "depends_on": node.get("depends_on", []),
                "write": node.get("write", True),
                "timeout_minutes": node.get("timeout_minutes", 90),
                "status": node.get("status"),
                "job_id": node.get("job_id"),
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
