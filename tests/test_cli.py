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
    def test_waiting_run_reports_terminal_failures_in_exit_code(self):
        for state, expected in (
            ("done", 0), ("running", 2), ("queued", 2), ("waiting_for_desktop", 2), ("needs_user", 2),
            ("failed", 1), ("cancelled", 1), ("timed_out", 1),
        ):
            with patch.object(teamyra_cli.server, "tool_call", return_value={"state": state, "reason": "why"}):
                code, out, err = self.run_cli(["run", "--project", "P", "--task", "Review", "--wait"])
            self.assertEqual(code, expected, state)
            self.assertEqual(json.loads(out)["state"], state)
            self.assertIn(state, err)
            self.assertIn("why", err)

    def test_wait_exit_codes(self):
        cases = (
            ([{"state": "done"}, {"state": "done"}], "all", 0),
            ([{"state": "done"}, {"state": "running"}], "all", 2),
            ([{"state": "done"}, {"state": "failed", "reason": "timeout"}], "all", 1),
            ([{"state": "needs_user", "reason": "chatgpt_verification"}], "all", 2),
            ([{"state": "done"}, {"state": "running"}], "any", 0),
            ([{"state": "queued"}, {"state": "running"}], "any", 2),
            ([{"state": "cancelled"}, {"state": "running"}], "any", 1),
        )
        for jobs, mode, expected in cases:
            rows = [{**job, "terminal_job_id": f"job-{index}"} for index, job in enumerate(jobs)]
            with patch.object(teamyra_cli.server, "tool_call", return_value={"timed_out": False, "jobs": rows}) as call:
                code, out, err = self.run_cli(["wait", "job-0", "job-1", "--mode", mode, "--timeout-seconds", "5"])
            self.assertEqual(code, expected, (jobs, mode))
            self.assertEqual(call.call_args.args[0], "job_wait")
            self.assertIn("job-0", err)

    def test_result_exit_codes(self):
        for state, expected in (("done", 0), ("failed", 1), ("running", 2)):
            with patch.object(teamyra_cli.server, "tool_call", return_value={"state": state, "terminal_job_id": "j"}):
                code, _, err = self.run_cli(["result", "j"])
            self.assertEqual(code, expected, state)
            self.assertIn(f"j: {state}", err)

    def access_service(self, root):
        import workspace_tools
        return workspace_tools.WorkspaceToolService(Path(root))

    class FakeStdin:
        def __init__(self, answer, tty=True):
            self.answer, self.tty = answer, tty

        def isatty(self):
            return self.tty

        def readline(self):
            return self.answer

    def test_chatgpt_access_requires_tty_and_explicit_yes(self):
        with tempfile.TemporaryDirectory() as td, patch.object(teamyra_cli, "ROOT", Path(td)):
            service = self.access_service(td)
            with patch.object(sys, "stdin", self.FakeStdin("y\n", tty=False)):
                code, _, err = self.run_cli(["chatgpt-access", "--full"])
            self.assertEqual(code, 1)
            self.assertIn("interactive terminal", err)
            self.assertFalse(service.status(trusted=True)["permissions"]["full_access"])

            with patch.object(sys, "stdin", self.FakeStdin("\n")):
                code, _, err = self.run_cli(["chatgpt-access", "--full"])
            self.assertEqual(code, 1)
            self.assertIn("[y/N]", err)
            self.assertFalse(service.status(trusted=True)["permissions"]["full_access"])

            with patch.object(sys, "stdin", self.FakeStdin("yes\n")):
                code, out, _ = self.run_cli(["chatgpt-access", "--full"])
            self.assertEqual(code, 0)
            payload = json.loads(out)
            self.assertTrue(payload["full_access"])
            self.assertTrue(payload["outside_workspace"])
            self.assertFalse(payload["destructive_without_confirmation"])
            permissions = service.status(trusted=True)["permissions"]
            self.assertTrue(permissions["full_access"] and permissions["outside_workspace"])

            with patch.object(sys, "stdin", self.FakeStdin("y\n")):
                code, out, _ = self.run_cli(["chatgpt-access", "--full", "--destructive-without-confirmation"])
            self.assertEqual(code, 0)
            self.assertTrue(json.loads(out)["destructive_without_confirmation"])

            # turning it off never needs a TTY
            with patch.object(sys, "stdin", self.FakeStdin("", tty=False)):
                code, out, _ = self.run_cli(["chatgpt-access", "--off"])
            self.assertEqual(code, 0)
            self.assertEqual(
                {key: value for key, value in json.loads(out).items() if key != "settings_file"},
                {"full_access": False, "outside_workspace": False, "destructive_without_confirmation": False},
            )
            rows = [json.loads(line) for line in service.audit_file.read_text(encoding="utf-8").splitlines()]
            self.assertEqual(
                [row["agent"] for row in rows if row["tool"] == "workspace.access" and row["result"] == "success"],
                ["teamyra-cli-user", "teamyra-cli-user", "teamyra-cli"],
            )

    def test_chatgpt_access_requires_full_or_off(self):
        with self.assertRaises(SystemExit):
            with redirect_stderr(io.StringIO()):
                teamyra_cli.main(["chatgpt-access"])

    def test_desktop_configure_only_enables_access_with_user_confirmation(self):
        import desktop_api
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "runtime"
            workspace = Path(td) / "project"
            workspace.mkdir()
            service = self.access_service(root)
            service.state_root.mkdir(parents=True)
            service.token_file.write_text("x" * 64, encoding="utf-8")
            with patch.object(desktop_api, "ROOT", root), \
                    patch.dict("os.environ", {"TEAMYRA_LOCAL_AGENT_TOKEN": ""}):
                base = {"workspace": str(workspace), "bridge_token": "x" * 64}
                desktop_api.handle("chatgpt.workspace.configure", base)
                # what the MCP chatgpt_control workspace_configure path can send
                for payload in (
                    {**base, "permissions": {"full_access": True}},
                    {**base, "permissions": {"outside_workspace": True, "user_confirmed": True}},
                    {**base, "access": {"full_access": True}},
                    {**base, "access": {"full_access": True}, "user_confirmed": "yes"},
                ):
                    with self.assertRaises(PermissionError, msg=payload):
                        desktop_api.handle("chatgpt.workspace.configure", payload)
                with self.assertRaises(PermissionError):
                    desktop_api.handle("chatgpt.tool.execute-in-workspace", {
                        **base, "tool": "filesystem.list", "args": {}, "permissions": {"full_access": True},
                    })
                self.assertFalse(service.status(trusted=True)["permissions"]["full_access"])
                enabled = desktop_api.handle("chatgpt.workspace.configure", {
                    **base, "access": {"full_access": True, "outside_workspace": True}, "user_confirmed": True,
                })
                self.assertTrue(enabled["permissions"]["full_access"])
                off = desktop_api.handle("chatgpt.workspace.configure", {
                    "bridge_token": "x" * 64, "access": {"full_access": False},
                })
                self.assertFalse(off["permissions"]["full_access"])
                self.assertEqual(off["workspace"], str(workspace.resolve()))

    def run_cli(self, argv):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = teamyra_cli.main(argv)
        return code, out.getvalue(), err.getvalue()

    def test_doctor_reports_ready_workers(self):
        import runtime_paths
        workers = [{"worker": "codex1", "ready": True}]
        info = {"argv": ["C:/c/claude.exe"], "path": "C:/c/claude.exe", "source": "PATH"}
        with patch.object(teamyra_cli.server, "worker_status", return_value=workers), \
                patch.object(runtime_paths, "claude_launch_info", return_value=info):
            code, out, err = self.run_cli(["doctor"])
        self.assertEqual(code, 0)
        self.assertEqual(err, "")
        payload = json.loads(out)
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["ready_workers"], 1)
        self.assertEqual(payload["mcp_server"], "teamyra")
        self.assertEqual(payload["claude_cli"]["source"], "PATH")

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


    def test_pool_register_requires_yes_and_preserves_argv(self):
        with patch.object(teamyra_cli.server, "tool_call", return_value={"name": "fake"}) as call:
            code, _, err = self.run_cli([
                "pool", "register", "fake",
                "--cwd", "P",
                "--env", "TOKEN=secret",
                "--timeout-seconds", "12",
                "--",
                "python", "fake.py",
            ])
        self.assertEqual(code, 1)
        self.assertIn("--yes", err)
        call.assert_not_called()

        with patch.object(teamyra_cli.server, "tool_call", return_value={"name": "fake"}) as call:
            code, out, _ = self.run_cli([
                "pool", "register", "fake",
                "--cwd", "P",
                "--env", "TOKEN=secret",
                "--timeout-seconds", "12",
                "--yes",
                "--",
                "python", "fake.py",
            ])
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out)["name"], "fake")
        name, payload = call.call_args.args
        self.assertEqual(name, "mcp_pool_register")
        self.assertEqual(payload["command"], ["python", "fake.py"])
        self.assertEqual(payload["env"], {"TOKEN": "secret"})
        self.assertEqual(payload["timeout_seconds"], 12)
        self.assertTrue(payload["confirm"])

    def test_pool_call_delegates_json_arguments(self):
        with patch.object(teamyra_cli.server, "tool_call", return_value={"result": {"ok": True}}) as call:
            code, _, _ = self.run_cli([
                "pool", "call", "fake", "echo",
                "--arguments", '{"value":"hello"}',
                "--timeout-seconds", "9",
            ])
        self.assertEqual(code, 0)
        name, payload = call.call_args.args
        self.assertEqual(name, "mcp_pool_call")
        self.assertEqual(payload["server"], "fake")
        self.assertEqual(payload["tool_name"], "echo")
        self.assertEqual(payload["arguments"], {"value": "hello"})
        self.assertEqual(payload["timeout_seconds"], 9)

    def test_pool_restart_and_remove_require_yes(self):
        for action, tool in (("restart", "mcp_pool_restart"), ("remove", "mcp_pool_remove")):
            with patch.object(teamyra_cli.server, "tool_call") as call:
                code, _, err = self.run_cli(["pool", action, "fake"])
            self.assertEqual(code, 1)
            self.assertIn("--yes", err)
            call.assert_not_called()

            with patch.object(teamyra_cli.server, "tool_call", return_value={"ok": True}) as call:
                code, _, _ = self.run_cli(["pool", action, "fake", "--yes"])
            self.assertEqual(code, 0)
            self.assertEqual(call.call_args.args[0], tool)
            self.assertTrue(call.call_args.args[1]["confirm"])

    def test_recover_delegates_recovery_scan(self):
        with patch.object(teamyra_cli.server, "tool_call", return_value={"ok": True, "actions": {}}) as call:
            code, out, _ = self.run_cli(["recover"])
        self.assertEqual(code, 0)
        self.assertTrue(json.loads(out)["ok"])
        call.assert_called_once_with("recovery_scan", {})

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
