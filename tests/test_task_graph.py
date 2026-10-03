import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "bridge"))

import server
import task_graph
import conductor_monitor


class TaskGraphTests(unittest.TestCase):
    def test_create_load_and_ready_dependencies(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            project = root / "project"
            project.mkdir()
            graph = task_graph.create_graph(root, "Build", project, [
                {"id": "plan", "task": "Plan the feature", "write": False},
                {"id": "build", "task": "Implement it", "depends_on": ["plan"]},
                {"id": "review", "task": "Review it", "depends_on": ["build"], "write": False},
            ])
            self.assertEqual([n["id"] for n in task_graph.ready_nodes(graph)], ["plan"])

            graph["nodes"][0]["status"] = "done"
            task_graph.save_graph(root, graph)
            loaded = task_graph.load_graph(root, graph["id"])
            self.assertEqual([n["id"] for n in task_graph.ready_nodes(loaded)], ["build"])

    def test_cycle_is_rejected(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            project = root / "project"
            project.mkdir()
            with self.assertRaisesRegex(ValueError, "cycle"):
                task_graph.create_graph(root, "Cycle", project, [
                    {"id": "a", "task": "A", "depends_on": ["b"]},
                    {"id": "b", "task": "B", "depends_on": ["a"]},
                ])

    def test_failed_dependency_blocks_downstream_nodes(self):
        graph = {
            "id": "graph-test",
            "nodes": [
                {"id": "a", "status": "failed", "depends_on": []},
                {"id": "b", "status": "pending", "depends_on": ["a"]},
                {"id": "c", "status": "pending", "depends_on": ["b"]},
            ],
        }
        self.assertTrue(task_graph.mark_blocked_nodes(graph))
        self.assertEqual(graph["nodes"][1]["status"], "blocked")
        self.assertEqual(graph["nodes"][2]["status"], "blocked")
        self.assertFalse(task_graph.mark_blocked_nodes(graph))

    def test_graph_summary_is_compact(self):
        graph = {
            "id": "graph-test",
            "title": "Test",
            "project_path": "/tmp/project",
            "state": "running",
            "active_node_id": "a",
            "nodes": [
                {"id": "a", "label": "A", "worker": "auto", "depends_on": [], "status": "running", "job_id": "j1"},
                {"id": "b", "label": "B", "worker": "codex1", "depends_on": ["a"], "status": "pending", "job_id": None},
            ],
        }
        summary = task_graph.graph_summary(graph)
        self.assertEqual(summary["counts"], {"running": 1, "pending": 1})
        self.assertEqual(summary["active_node_id"], "a")
        self.assertNotIn("task", summary["nodes"][0])

    def test_server_graph_create_and_status_tools(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            project = root / "project"
            project.mkdir()
            with patch.object(server, "ROOT", root):
                created = server.tool_call("graph_create", {
                    "title": "Graph tool",
                    "project_path": str(project),
                    "nodes": [{"id": "one", "task": "Do one thing"}],
                })
                status = server.tool_call("graph_status", {"graph_id": created["id"]})
                self.assertEqual(status["id"], created["id"])
                self.assertEqual(status["counts"], {"pending": 1})


    def test_approval_metadata_and_mcp_decision(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            project = root / "project"
            project.mkdir()
            with patch.object(server, "ROOT", root):
                created = server.tool_call("graph_create", {
                    "title": "Approval graph",
                    "project_path": str(project),
                    "nodes": [{
                        "id": "deploy",
                        "task": "Deploy the change",
                        "requires_approval": True,
                        "approval_reason": "Production change",
                    }],
                })
                node = created["nodes"][0]
                self.assertTrue(node["requires_approval"])
                self.assertEqual(node["approval_status"], "pending")

                approved = server.tool_call("graph_approve", {
                    "graph_id": created["id"],
                    "node_id": "deploy",
                    "decision": "approve",
                    "note": "Approved for release",
                })
                approved_node = approved["nodes"][0]
                self.assertEqual(approved_node["approval_status"], "approved")
                self.assertEqual(approved_node["approval_note"], "Approved for release")

    def test_non_gated_node_cannot_be_approved(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            project = root / "project"
            project.mkdir()
            with patch.object(server, "ROOT", root):
                created = server.tool_call("graph_create", {
                    "project_path": str(project),
                    "nodes": [{"id": "build", "task": "Build"}],
                })
                with self.assertRaisesRegex(ValueError, "does not require approval"):
                    server.tool_call("graph_approve", {
                        "graph_id": created["id"],
                        "node_id": "build",
                        "decision": "approve",
                    })

    def test_denied_approval_is_persisted(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            project = root / "project"
            project.mkdir()
            with patch.object(server, "ROOT", root):
                created = server.tool_call("graph_create", {
                    "project_path": str(project),
                    "nodes": [{
                        "id": "delete",
                        "task": "Delete generated artifacts",
                        "requires_approval": True,
                    }],
                })
                denied = server.tool_call("graph_approve", {
                    "graph_id": created["id"],
                    "node_id": "delete",
                    "decision": "deny",
                    "note": "Keep artifacts",
                })
                self.assertEqual(denied["nodes"][0]["approval_status"], "denied")
                self.assertEqual(denied["nodes"][0]["approval_note"], "Keep artifacts")


    def test_approval_gate_blocks_ready_node_until_approved(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            project = root / "project"
            project.mkdir()
            graph = task_graph.create_graph(root, "Approval", project, [
                {"id": "plan", "task": "Plan", "write": False},
                {
                    "id": "deploy",
                    "task": "Deploy",
                    "depends_on": ["plan"],
                    "requires_approval": True,
                    "timeout_minutes": 45,
                },
            ], objective="Ship safely")
            self.assertEqual(graph["objective"], "Ship safely")
            self.assertEqual(graph["nodes"][1]["timeout_minutes"], 45)
            self.assertTrue(graph["nodes"][1]["requires_approval"])

            graph["nodes"][0]["status"] = "done"
            self.assertEqual(task_graph.ready_nodes(graph), [])
            waiting = task_graph.awaiting_approval_nodes(graph)
            self.assertEqual([node["id"] for node in waiting], ["deploy"])

            approved = task_graph.approve_node(graph, "deploy", "Reviewed by operator")
            self.assertIsNotNone(approved["approved_at"])
            self.assertEqual(approved["approval_note"], "Reviewed by operator")
            self.assertEqual([node["id"] for node in task_graph.ready_nodes(graph)], ["deploy"])

    def test_approval_rejects_incomplete_dependencies(self):
        graph = {
            "id": "graph-test",
            "nodes": [
                {"id": "plan", "status": "pending", "depends_on": []},
                {
                    "id": "deploy",
                    "status": "pending",
                    "depends_on": ["plan"],
                    "requires_approval": True,
                    "approved_at": None,
                },
            ],
        }
        with self.assertRaisesRegex(ValueError, "dependencies are not complete"):
            task_graph.approve_node(graph, "deploy")

    def test_server_graph_approve_tool_persists_gate(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            project = root / "project"
            project.mkdir()
            with patch.object(server, "ROOT", root):
                created = server.tool_call("graph_create", {
                    "title": "Approval graph",
                    "objective": "Safe change",
                    "project_path": str(project),
                    "nodes": [{
                        "id": "reviewed-write",
                        "task": "Make the change",
                        "requires_approval": True,
                        "timeout_minutes": 30,
                    }],
                })
                approved = server.tool_call("graph_approve", {
                    "graph_id": created["id"],
                    "node_id": "reviewed-write",
                    "decision": "approve",
                    "note": "Approved in test",
                })
                node = approved["nodes"][0]
                self.assertIsNotNone(node["approved_at"])
                self.assertEqual(node["approval_note"], "Approved in test")
                self.assertEqual(node["timeout_minutes"], 30)
                self.assertEqual(approved["objective"], "Safe change")


    def test_conductor_waits_at_approval_gate_instead_of_failing(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            project = root / "project"
            project.mkdir()
            graph = task_graph.create_graph(root, "Gate", project, [{
                "id": "deploy",
                "task": "Deploy safely",
                "requires_approval": True,
            }])
            with patch.object(server, "ROOT", root), patch.object(conductor_monitor.server, "ROOT", root):
                updated = conductor_monitor.tick(graph["id"])
                self.assertEqual(updated["state"], "awaiting_approval")
                self.assertEqual(updated["approval_pending_node_id"], "deploy")
                self.assertEqual(updated["nodes"][0]["status"], "pending")

    def test_graph_approve_tool_is_registered_once(self):
        names = [tool["name"] for tool in server.TOOLS]
        self.assertEqual(names.count("graph_approve"), 1)

    def test_graph_approve_and_deny_use_canonical_decision_helper(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            project = root / "project"
            project.mkdir()
            with patch.object(server, "ROOT", root):
                approved_graph = task_graph.create_graph(root, "Approve", project, [{
                    "id": "write",
                    "task": "Write",
                    "requires_approval": True,
                }])
                approved = server.tool_call("graph_approve", {
                    "graph_id": approved_graph["id"],
                    "node_id": "write",
                    "decision": "approve",
                    "note": "reviewed",
                })
                node = approved["nodes"][0]
                self.assertEqual(node["approval_status"], "approved")
                self.assertIsNotNone(node["approved_at"])

                denied_graph = task_graph.create_graph(root, "Deny", project, [
                    {
                        "id": "danger",
                        "task": "Dangerous change",
                        "requires_approval": True,
                    },
                    {
                        "id": "after",
                        "task": "Should not run",
                        "depends_on": ["danger"],
                    },
                ])
                denied = server.tool_call("graph_approve", {
                    "graph_id": denied_graph["id"],
                    "node_id": "danger",
                    "decision": "deny",
                    "note": "not approved",
                })
                by_id = {node["id"]: node for node in denied["nodes"]}
                self.assertEqual(by_id["danger"]["approval_status"], "denied")
                self.assertEqual(by_id["danger"]["status"], "cancelled")
                self.assertEqual(by_id["after"]["status"], "blocked")


if __name__ == "__main__":
    unittest.main()
