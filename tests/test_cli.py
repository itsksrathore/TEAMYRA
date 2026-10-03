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


if __name__ == "__main__":
    unittest.main()
