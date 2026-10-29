import json
import tempfile
import unittest
from pathlib import Path
import sys
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "bridge"))

import runner
from runner import Job


class ClaudeRunnerTests(unittest.TestCase):
    def test_terminal_states_normalize_exit_code_and_preserve_process_code(self):
        cases = (
            (0, "", False, False, {}, "done", None),
            (37, "", False, False, {}, "failed", "worker_error"),
            (0, "", True, False, {}, "failed", "timeout"),
            (0, "", False, True, {}, "cancelled", "cancelled"),
            (0, "", False, False, {"reported_error": True}, "failed", "worker_reported_error"),
            (0, "", False, False, {"denied_actions": ["blocked"]}, "failed", "permission_denied"),
            (42, "rate limit", False, False, {}, "failed", "usage_or_rate_limit"),
        )
        for rc, err, timed_out, cancelled, metadata, state, reason in cases:
            with self.subTest(state=state, reason=reason):
                tmp, job = self.make_job()
                try:
                    job.meta.update(metadata)
                    with patch.object(job, "run_once", return_value=(rc, err, timed_out, cancelled)):
                        job.run()
                    persisted = json.loads((job.dir / "meta.json").read_text())
                    self.assertEqual(persisted["state"], state)
                    self.assertEqual(persisted["exit_code"], 0 if state == "done" else 1)
                    self.assertEqual(persisted["process_exit_code"], rc)
                    self.assertEqual(persisted["reason"], reason)
                    self.assertEqual((job.dir / "DONE").read_text(), state)
                finally:
                    self.close_job(job)
                    tmp.cleanup()

    def test_crash_sets_failure_exit_code_and_still_dispatches(self):
        tmp, job = self.make_job()
        try:
            with patch.object(runner.sys, "argv", ["runner.py", str(job.dir)]), \
                 patch.object(runner, "Job", return_value=job), \
                 patch.object(job, "run", side_effect=RuntimeError("crash")), \
                 patch.object(runner, "dispatch_next") as dispatch:
                runner.main()
            persisted = json.loads((job.dir / "meta.json").read_text())
            self.assertEqual(persisted["exit_code"], 1)
            self.assertEqual(persisted["reason"], "runner_crash")
            self.assertEqual((job.dir / "DONE").read_text(), "failed")
            dispatch.assert_called_once_with(job.dir)
        finally:
            self.close_job(job)
            tmp.cleanup()

    def make_job(self):
        tmp = tempfile.TemporaryDirectory()
        job = Path(tmp.name)
        (job / "spec.json").write_text(json.dumps({
            "worker": "claude1",
            "provider": "claude",
            "cwd": str(ROOT),
            "cmd": [],
        }), encoding="utf-8")
        (job / "meta.json").write_text(json.dumps({
            "id": "test",
            "worker": "claude1",
            "state": "starting",
        }), encoding="utf-8")
        return tmp, Job(job)

    def close_job(self, job):
        job.events.close()
        job.transcript.close()

    def test_init_text_rate_and_result(self):
        tmp, job = self.make_job()
        try:
            job.claude_event({
                "type": "system", "subtype": "init",
                "session_id": "sess-123", "model": "claude-opus-5-5"
            })
            job.claude_event({
                "type": "assistant",
                "message": {
                    "content": [{"type": "text", "text": "TEAMYRA_OK"}],
                    "usage": {"input_tokens": 2, "output_tokens": 4},
                },
            })
            job.claude_event({
                "type": "rate_limit_event",
                "rate_limit_info": {"status": "allowed_warning"},
            })
            job.claude_event({
                "type": "result",
                "session_id": "sess-123",
                "result": "TEAMYRA_OK",
                "usage": {"input_tokens": 2, "output_tokens": 5},
                "modelUsage": {"claude-opus-5-5": {"outputTokens": 5}},
                "total_cost_usd": 0.01,
                "permission_denials": [],
                "terminal_reason": "completed",
                "is_error": False,
            })
            self.assertEqual(job.meta["session_id"], "sess-123")
            self.assertEqual(job.meta["model"], "claude-opus-5-5")
            self.assertEqual(job.final_text, "TEAMYRA_OK")
            self.assertEqual(job.meta["rate_limit"]["status"], "allowed_warning")
            self.assertEqual(job.meta["worker_status"], "completed")
            self.assertEqual(job.meta["total_cost_usd"], 0.01)
        finally:
            self.close_job(job)
            tmp.cleanup()

    def test_run_once_parses_claude_stream_end_to_end(self):
        tmp, job = self.make_job()
        try:
            events = [
                {"type": "system", "subtype": "init", "session_id": "sess-e2e", "model": "claude-opus-5-5"},
                {"type": "assistant", "message": {"content": [{"type": "text", "text": "STREAM_OK"}]}},
                {"type": "result", "session_id": "sess-e2e", "result": "STREAM_OK",
                 "permission_denials": [], "terminal_reason": "completed", "is_error": False},
            ]
            payload = "\n".join(json.dumps(x) for x in events)
            code = "import sys; sys.stdout.write(" + repr(payload + "\n") + "); sys.stdout.flush()"
            env = __import__("os").environ.copy()
            rc, stderr, timed_out, cancelled = job.run_once(
                [sys.executable, "-c", code], env, __import__("time").time() + 10
            )
            self.assertEqual(rc, 0)
            self.assertFalse(timed_out)
            self.assertFalse(cancelled)
            self.assertEqual(stderr, "")
            self.assertEqual(job.meta["session_id"], "sess-e2e")
            self.assertEqual(job.final_text, "STREAM_OK")
        finally:
            self.close_job(job)
            tmp.cleanup()

    def test_permission_denial_is_recorded(self):
        tmp, job = self.make_job()
        try:
            denied = [{"tool_name": "Bash", "reason": "blocked"}]
            job.claude_event({
                "type": "result",
                "session_id": "sess-denied",
                "result": "Permission denied",
                "permission_denials": denied,
                "is_error": True,
            })
            self.assertEqual(job.meta["denied_actions"], denied)
            self.assertEqual(job.meta["session_id"], "sess-denied")
        finally:
            self.close_job(job)
            tmp.cleanup()


if __name__ == "__main__":
    unittest.main()
