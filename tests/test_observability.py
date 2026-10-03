import json
import tempfile
import unittest
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "bridge"))

import observability
import server
import desktop_api


class ObservabilityTests(unittest.TestCase):
    def write_json(self, path, value):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value), encoding="utf-8")

    def test_timeline_unifies_jobs_graphs_reviews_and_worktrees(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            project = root / "project"
            project.mkdir()

            job = root / "jobs" / "job-1"
            job.mkdir(parents=True)
            self.write_json(job / "meta.json", {
                "id": "job-1",
                "label": "Implement",
                "worker": "codex1",
                "provider": "codex",
                "state": "done",
                "cwd": str(project),
                "branch": "feature/x",
                "created": 10,
                "started": 11,
                "ended": 15,
            })
            (job / "events.jsonl").write_text(
                json.dumps({"ts": 12, "kind": "command", "text": "run tests"}) + "\n"
                + json.dumps({"ts": 13, "kind": "message", "text": "done soon"}) + "\n",
                encoding="utf-8",
            )

            self.write_json(root / "tasks" / "graph-a.json", {
                "id": "graph-a",
                "title": "Build",
                "objective": "Ship",
                "project_path": str(project),
                "state": "done",
                "created_at": 20,
                "updated_at": 30,
                "nodes": [{
                    "id": "node-a",
                    "label": "Node A",
                    "worker": "codex1",
                    "status": "done",
                    "started_at": 21,
                    "ended_at": 29,
                }],
            })
            self.write_json(root / "tasks" / "reviews" / "review-a.json", {
                "id": "review-a",
                "source_job_id": "job-1",
                "reviewer_worker": "claude1",
                "state": "done",
                "decision": "PASS",
                "created_at": 31,
                "updated_at": 33,
            })
            self.write_json(root / "tasks" / "handoffs" / "handoff-a.json", {
                "id": "handoff-a",
                "project_path": str(project),
                "source_job_id": "job-1",
                "terminal_job_id": "job-1",
                "source_worker": "codex1",
                "target_worker": "claude1",
                "target_job_id": "job-2",
                "label": "Review implementation",
                "objective": "Validate and finish",
                "message": "Review the implementation",
                "created_at": 34,
                "updated_at": 35,
            })
            self.write_json(root / "worktrees" / ".teamyra" / "wt-a.json", {
                "id": "wt-a",
                "label": "Node A",
                "repo_root": str(project),
                "path": str(root / "worktrees" / "wt-a"),
                "branch": "teamyra/node-a",
                "target_branch": "main",
                "created_at": 22,
                "rebased_at": 28,
                "merged_at": 32,
            })

            result = observability.timeline(root, limit=100)
            sources = {item["source"] for item in result["items"]}
            kinds = {item["kind"] for item in result["items"]}
            self.assertEqual(sources, {"job", "graph", "review", "handoff", "worktree"})
            self.assertIn("job.command", kinds)
            self.assertIn("graph.node.ended", kinds)
            self.assertIn("review.updated", kinds)
            self.assertIn("handoff.created", kinds)
            self.assertIn("handoff.target.attached", kinds)
            self.assertIn("worktree.merged", kinds)
            timestamps = [item["ts"] for item in result["items"]]
            self.assertEqual(timestamps, sorted(timestamps, reverse=True))

    def test_timeline_filters_handoff_source(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            project = root / "project"
            project.mkdir()
            self.write_json(root / "tasks" / "handoffs" / "handoff-filter.json", {
                "id": "handoff-filter",
                "project_path": str(project),
                "source_job_id": "source-job",
                "terminal_job_id": "terminal-job",
                "source_worker": "codex1",
                "target_worker": "claude1",
                "target_job_id": "target-job",
                "label": "Security review",
                "objective": "needle objective",
                "message": "Review it",
                "created_at": 40,
                "updated_at": 41,
            })
            result = observability.timeline(
                root,
                project_path=project,
                worker="claude1",
                sources=["handoff"],
                query="needle",
            )
            self.assertEqual(result["total_matches"], 1)
            self.assertEqual(result["items"][0]["handoff_id"], "handoff-filter")
            self.assertEqual(result["items"][0]["kind"], "handoff.created")

    def test_timeline_filters_worker_project_query_and_source(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            project = root / "project"
            project.mkdir()
            other = root / "other"
            other.mkdir()

            for job_id, worker, cwd, text, ts in [
                ("job-1", "codex1", project, "needle event", 5),
                ("job-2", "claude1", other, "other event", 6),
            ]:
                folder = root / "jobs" / job_id
                folder.mkdir(parents=True)
                self.write_json(folder / "meta.json", {
                    "id": job_id,
                    "label": job_id,
                    "worker": worker,
                    "state": "done",
                    "cwd": str(cwd),
                    "created": ts - 1,
                    "ended": ts + 1,
                })
                (folder / "events.jsonl").write_text(
                    json.dumps({"ts": ts, "kind": "message", "text": text}) + "\n",
                    encoding="utf-8",
                )

            result = observability.timeline(
                root,
                project_path=project,
                worker="codex1",
                sources=["job"],
                query="needle",
            )
            self.assertEqual(result["total_matches"], 1)
            self.assertEqual(result["items"][0]["job_id"], "job-1")
            self.assertEqual(result["items"][0]["kind"], "job.message")

    def test_log_search_is_bounded_and_scoped(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            project = root / "project"
            project.mkdir()
            folder = root / "jobs" / "job-1"
            folder.mkdir(parents=True)
            self.write_json(folder / "meta.json", {
                "id": "job-1",
                "label": "Search me",
                "worker": "codex1",
                "cwd": str(project),
                "created": 1,
            })
            (folder / "transcript.md").write_text(
                "alpha\nneedle first\nneedle second\nomega\n",
                encoding="utf-8",
            )
            (folder / "events.jsonl").write_text(
                json.dumps({"ts": 2, "kind": "message", "text": "needle event"}) + "\n",
                encoding="utf-8",
            )

            result = observability.search_logs(
                root,
                "needle",
                limit=2,
                project_path=project,
                worker="codex1",
            )
            self.assertEqual(result["count"], 2)
            self.assertTrue(result["clipped"])
            self.assertTrue(all(row["job_id"] == "job-1" for row in result["results"]))

    def test_log_search_requires_query(self):
        with tempfile.TemporaryDirectory() as td:
            with self.assertRaisesRegex(ValueError, "query is required"):
                observability.search_logs(Path(td), "")

    def test_usage_snapshot_aggregates_real_tokens_and_live_worker_state(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            project = root / "project"
            project.mkdir()

            samples = [
                ("job-1", "codex1", "codex", "done", 1, {
                    "input_tokens": 100,
                    "cached_input_tokens": 60,
                    "output_tokens": 20,
                    "reasoning_output_tokens": 5,
                }),
                ("job-2", "codex1", "codex", "failed", 2, {
                    "input_tokens": 50,
                    "cached_input_tokens": 10,
                    "output_tokens": 8,
                }),
                ("job-3", "claude1", "claude", "running", 3, {
                    "input_tokens": 40,
                    "output_tokens": 12,
                }),
            ]
            for job_id, worker, provider, state, created, usage in samples:
                folder = root / "jobs" / job_id
                folder.mkdir(parents=True)
                self.write_json(folder / "meta.json", {
                    "id": job_id,
                    "worker": worker,
                    "provider": provider,
                    "state": state,
                    "cwd": str(project),
                    "created": created,
                    "usage": usage,
                })

            live = [
                {
                    "worker": "codex1",
                    "provider": "codex",
                    "ready": False,
                    "cooldown_seconds": 123,
                    "model": "gpt-test",
                    "effort": "high",
                    "running_jobs": [],
                },
                {
                    "worker": "claude1",
                    "provider": "claude",
                    "ready": True,
                    "cooldown_seconds": 0,
                    "model": "opus",
                    "effort": "high",
                    "running_jobs": ["job-3"],
                },
                {
                    "worker": "antigravity",
                    "provider": "antigravity",
                    "ready": True,
                    "cooldown_seconds": 0,
                    "model": "gemini",
                    "running_jobs": [],
                },
            ]

            result = observability.usage_snapshot(root, live, project_path=project)
            workers = {row["worker"]: row for row in result["workers"]}
            codex = workers["codex1"]
            self.assertEqual(codex["jobs"], 2)
            self.assertEqual(codex["done"], 1)
            self.assertEqual(codex["failed"], 1)
            self.assertEqual(codex["tokens"]["input_tokens"], 150)
            self.assertEqual(codex["tokens"]["cached_input_tokens"], 70)
            self.assertEqual(codex["cooldown_seconds"], 123)
            self.assertFalse(codex["ready"])
            self.assertAlmostEqual(codex["cache_ratio"], 70 / 150, places=4)
            self.assertEqual(workers["antigravity"]["jobs"], 0)
            self.assertEqual(result["jobs"], 3)
            providers = {row["provider"]: row for row in result["providers"]}
            self.assertEqual(providers["codex"]["jobs"], 2)
            self.assertEqual(providers["claude"]["jobs"], 1)
            self.assertIn("not fabricated", result["note"].lower())

    def test_usage_hides_invalid_cross_provider_cache_ratio(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            folder = root / "jobs" / "job-1"
            folder.mkdir(parents=True)
            self.write_json(folder / "meta.json", {
                "id": "job-1",
                "worker": "antigravity",
                "provider": "unknown",
                "state": "done",
                "created": 1,
                "usage": {
                    "input_tokens": 10,
                    "cached_input_tokens": 25,
                    "output_tokens": 2,
                },
            })
            result = observability.usage_snapshot(root, [{
                "worker": "antigravity",
                "provider": "antigravity",
                "ready": True,
                "cooldown_seconds": 0,
                "running_jobs": [],
            }])
            row = result["workers"][0]
            self.assertEqual(row["provider"], "antigravity")
            self.assertIsNone(row["cache_ratio"])

    def test_mcp_observability_tools_are_registered_and_namespaced(self):
        names = [tool["name"] for tool in server.TOOLS]
        for name in ("timeline_list", "logs_search", "usage_snapshot"):
            self.assertEqual(names.count(name), 1)
        namespaced = {tool["name"] for tool in server.mcp_tools(include_legacy=False)}
        for name in ("teamyra.timeline_list", "teamyra.logs_search", "teamyra.usage_snapshot"):
            self.assertIn(name, namespaced)

    def test_server_handlers_delegate_to_observability_core(self):
        from unittest.mock import patch

        with patch.object(server.observability, "timeline", return_value={"items": []}) as timeline:
            result = server.tool_call("timeline_list", {
                "limit": 12,
                "project_path": "P",
                "worker": "codex1",
                "sources": ["job"],
                "query": "needle",
                "since": 10,
            })
            self.assertEqual(result, {"items": []})
            timeline.assert_called_once_with(server.ROOT, 12, "P", "codex1", ["job"], "needle", 10)

        with patch.object(server.observability, "search_logs", return_value={"results": []}) as search:
            server.tool_call("logs_search", {
                "query": "needle",
                "limit": 7,
                "project_path": "P",
                "worker": "claude1",
                "kinds": ["transcript.md"],
            })
            search.assert_called_once_with(server.ROOT, "needle", 7, "P", "claude1", ["transcript.md"])

        with patch.object(server, "worker_status", return_value=[{"worker": "codex1"}]), \
             patch.object(server.observability, "usage_snapshot", return_value={"workers": []}) as usage:
            server.tool_call("usage_snapshot", {"project_path": "P"})
            usage.assert_called_once_with(server.ROOT, [{"worker": "codex1"}], "P")

    def test_desktop_api_observability_actions_delegate_to_core(self):
        from unittest.mock import patch

        with patch.object(desktop_api.observability, "timeline", return_value={"items": []}) as timeline:
            result = desktop_api.handle("observability.timeline", {
                "limit": 9,
                "project_path": "P",
                "worker": "codex1",
                "sources": ["job"],
                "query": "x",
                "since": 3,
            })
            self.assertEqual(result, {"items": []})
            timeline.assert_called_once_with(
                desktop_api.ROOT, 9, "P", "codex1", ["job"], "x", 3
            )

        with patch.object(desktop_api.observability, "search_logs", return_value={"results": []}) as search:
            desktop_api.handle("observability.search", {
                "query": "needle",
                "limit": 4,
                "project_path": "P",
                "worker": "claude1",
                "kinds": ["events.jsonl"],
            })
            search.assert_called_once_with(
                desktop_api.ROOT, "needle", 4, "P", "claude1", ["events.jsonl"]
            )

        with patch.object(server, "worker_registry", return_value={
            "codex1": {"id": "codex1", "provider": "codex"},
        }), patch.object(server, "worker_settings", return_value={"model": "gpt-test", "effort": "high"}), \
             patch.object(server, "cooldown_left", return_value=9), \
             patch.object(server, "running_jobs", return_value=[{"id": "job-live"}]), \
             patch.object(server, "worker_auth_status") as auth_status, \
             patch.object(desktop_api.observability, "usage_snapshot", return_value={"workers": []}) as usage:
            desktop_api.handle("observability.usage", {"project_path": "P"})
            auth_status.assert_not_called()
            usage.assert_called_once_with(
                desktop_api.ROOT,
                [{
                    "worker": "codex1",
                    "provider": "codex",
                    "ready": None,
                    "cooldown_seconds": 9,
                    "model": "gpt-test",
                    "effort": "high",
                    "running_jobs": ["job-live"],
                }],
                "P",
            )


if __name__ == "__main__":
    unittest.main()
