import io
import json
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest.mock import patch
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "bridge"))

import teamyra_cli


class CliTests(unittest.TestCase):
    def run_cli(self, argv):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = teamyra_cli.main(argv)
        return code, out.getvalue(), err.getvalue()

    def test_doctor_reports_ready_workers(self):
        workers = [{"worker": "codex1", "ready": True}]
        with patch.object(teamyra_cli.server, "worker_status", return_value=workers):
            code, out, err = self.run_cli(["doctor"])
        self.assertEqual(code, 0)
        self.assertEqual(err, "")
        payload = json.loads(out)
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["ready_workers"], 1)
        self.assertEqual(payload["mcp_server"], "teamyra")

    def test_run_delegates_to_start_task(self):
        with patch.object(teamyra_cli.server, "tool_call", return_value={"job_id": "job-1"}) as call:
            code, out, _ = self.run_cli([
                "run", "--project", ".", "--task", "Build it", "--worker", "codex1",
            ])
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out)["job_id"], "job-1")
        name, payload = call.call_args.args
        self.assertEqual(name, "start_task")
        self.assertEqual(payload["worker"], "codex1")
        self.assertEqual(payload["task"], "Build it")

    def test_test_command_preserves_argv_without_shell(self):
        with patch.object(teamyra_cli.server, "tool_call", return_value={"ok": True, "steps": []}) as call:
            code, _, _ = self.run_cli([
                "test", "--project", ".", "--name", "unit", "--",
                sys.executable, "-c", "print('ok')",
            ])
        self.assertEqual(code, 0)
        name, payload = call.call_args.args
        self.assertEqual(name, "test_run")
        self.assertEqual(payload["tests"][0]["argv"][0], sys.executable)
        self.assertEqual(payload["tests"][0]["argv"][1:], ["-c", "print('ok')"])

    def test_timeline_command_delegates_filters(self):
        with patch.object(teamyra_cli.server, "tool_call", return_value={"items": []}) as call:
            code, out, _ = self.run_cli([
                "timeline", "--limit", "12", "--project", "P", "--worker", "codex1",
                "--source", "job", "--query", "needle", "--since", "10",
            ])
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out)["items"], [])
        name, payload = call.call_args.args
        self.assertEqual(name, "timeline_list")
        self.assertEqual(payload["limit"], 12)
        self.assertEqual(payload["project_path"], "P")
        self.assertEqual(payload["worker"], "codex1")
        self.assertEqual(payload["sources"], ["job"])
        self.assertEqual(payload["query"], "needle")
        self.assertEqual(payload["since"], 10.0)

    def test_search_command_delegates_filters(self):
        with patch.object(teamyra_cli.server, "tool_call", return_value={"results": []}) as call:
            code, _, _ = self.run_cli([
                "search", "needle", "--limit", "7", "--project", "P",
                "--worker", "claude1", "--kind", "transcript.md",
            ])
        self.assertEqual(code, 0)
        name, payload = call.call_args.args
        self.assertEqual(name, "logs_search")
        self.assertEqual(payload["query"], "needle")
        self.assertEqual(payload["kinds"], ["transcript.md"])

    def test_usage_command_delegates_project_scope(self):
        with patch.object(teamyra_cli.server, "tool_call", return_value={"workers": []}) as call:
            code, _, _ = self.run_cli(["usage", "--project", "P"])
        self.assertEqual(code, 0)
        name, payload = call.call_args.args
        self.assertEqual(name, "usage_snapshot")
        self.assertEqual(payload["project_path"], "P")

    def test_memory_add_delegates_structured_payload(self):
        with patch.object(teamyra_cli.server, "tool_call", return_value={"id": "mem-1"}) as call:
            code, out, _ = self.run_cli([
                "memory", "add", "--project", "P", "--kind", "decision",
                "--title", "Architecture", "--content", "Use worktrees",
                "--tag", "git", "--importance", "high",
            ])
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out)["id"], "mem-1")
        name, payload = call.call_args.args
        self.assertEqual(name, "memory_add")
        self.assertEqual(payload["project_path"], "P")
        self.assertEqual(payload["tags"], ["git"])
        self.assertEqual(payload["importance"], "high")

    def test_memory_search_and_context_delegate(self):
        with patch.object(teamyra_cli.server, "tool_call", return_value={"items": []}) as call:
            code, _, _ = self.run_cli([
                "memory", "search", "--project", "P", "routing",
                "--kind", "decision", "--tag", "router",
            ])
        self.assertEqual(code, 0)
        name, payload = call.call_args.args
        self.assertEqual(name, "memory_search")
        self.assertEqual(payload["query"], "routing")
        self.assertEqual(payload["kinds"], ["decision"])
        self.assertEqual(payload["tags"], ["router"])

        with patch.object(teamyra_cli.server, "tool_call", return_value={"text": "ctx"}) as call:
            code, _, _ = self.run_cli([
                "memory", "context", "--project", "P", "--query", "routing",
                "--max-chars", "4000",
            ])
        self.assertEqual(code, 0)
        name, payload = call.call_args.args
        self.assertEqual(name, "memory_context")
        self.assertEqual(payload["max_chars"], 4000)

    def test_handoff_start_preserves_structured_payload(self):
        with patch.object(teamyra_cli.server, "tool_call", return_value={"handoff_id": "handoff-1"}) as call:
            code, out, _ = self.run_cli([
                "handoff", "start", "job-1",
                "--message", "Review and finish",
                "--target-worker", "claude1",
                "--objective", "Ship safely",
                "--constraint", "Keep API stable",
                "--constraint", "No destructive migration",
                "--accept", "Tests pass",
                "--artifact", "src/app.py",
                "--notes", "Focus on correctness",
                "--write",
                "--memory-query", "architecture",
                "--memory-max-chars", "4200",
                "--persist-memory",
            ])
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out)["handoff_id"], "handoff-1")
        name, payload = call.call_args.args
        self.assertEqual(name, "job_handoff")
        self.assertEqual(payload["job_id"], "job-1")
        self.assertEqual(payload["target_worker"], "claude1")
        self.assertEqual(payload["objective"], "Ship safely")
        self.assertEqual(payload["constraints"], ["Keep API stable", "No destructive migration"])
        self.assertEqual(payload["acceptance_criteria"], ["Tests pass"])
        self.assertEqual(payload["artifacts"], ["src/app.py"])
        self.assertTrue(payload["include_project_memory"])
        self.assertEqual(payload["memory_query"], "architecture")
        self.assertEqual(payload["memory_max_chars"], 4200)
        self.assertTrue(payload["persist_memory"])
        self.assertTrue(payload["write"])

    def test_handoff_start_can_disable_project_memory(self):
        with patch.object(teamyra_cli.server, "tool_call", return_value={"handoff_id": "handoff-1"}) as call:
            code, _, _ = self.run_cli([
                "handoff", "start", "job-1",
                "--message", "Continue",
                "--no-project-memory",
            ])
        self.assertEqual(code, 0)
        self.assertFalse(call.call_args.args[1]["include_project_memory"])

    def test_handoff_get_and_list_delegate(self):
        with patch.object(teamyra_cli.server, "tool_call", return_value={"id": "handoff-1"}) as call:
            code, _, _ = self.run_cli(["handoff", "get", "handoff-1"])
        self.assertEqual(code, 0)
        self.assertEqual(call.call_args.args, ("handoff_get", {"handoff_id": "handoff-1"}))

        with patch.object(teamyra_cli.server, "tool_call", return_value={"items": []}) as call:
            code, _, _ = self.run_cli([
                "handoff", "list",
                "--project", "P",
                "--source-job-id", "job-1",
                "--target-worker", "claude1",
                "--limit", "7",
            ])
        self.assertEqual(code, 0)
        name, payload = call.call_args.args
        self.assertEqual(name, "handoff_list")
        self.assertEqual(payload["project_path"], "P")
        self.assertEqual(payload["source_job_id"], "job-1")
        self.assertEqual(payload["target_worker"], "claude1")
        self.assertEqual(payload["limit"], 7)

    def test_worktree_merge_requires_yes(self):
        with patch.object(teamyra_cli.server, "tool_call") as call:
            code, _, err = self.run_cli(["worktree", "merge", "wt-test"])
        self.assertEqual(code, 1)
        self.assertIn("--yes", err)
        call.assert_not_called()

    def test_mcp_stdio_calls_server_main(self):
        with patch.object(teamyra_cli.server, "main") as main:
            code, _, _ = self.run_cli(["mcp", "stdio"])
        self.assertEqual(code, 0)
        main.assert_called_once_with()

    def test_mcp_http_calls_http_transport(self):
        import http_mcp
        with patch.object(http_mcp, "serve") as serve:
            code, _, _ = self.run_cli(["mcp", "http", "--port", "8899"])
        self.assertEqual(code, 0)
        serve.assert_called_once_with("127.0.0.1", 8899)


if __name__ == "__main__":
    unittest.main()
