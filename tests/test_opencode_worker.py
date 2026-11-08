"""OpenCode's free models as TEAMYRA workers (2026-11-08)."""
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "bridge"))

import runner  # noqa: E402
import server  # noqa: E402
import worker_registry  # noqa: E402
from runner import Job  # noqa: E402


class OpenCodeRegistryTests(unittest.TestCase):
    def test_seeded_models_become_workers_and_user_settings_survive(self):
        with tempfile.TemporaryDirectory() as td:
            created = worker_registry.seed_opencode_profiles(td)
            self.assertEqual(len(created), len(worker_registry.OPENCODE_DEFAULT_MODELS))
            folder = Path(td) / "profiles" / "opencode" / "glm-5.3-flash-free"
            meta = json.loads((folder / "teamyra-profile.json").read_text(encoding="utf-8"))
            meta.update(enabled=False, name="My GLM")
            (folder / "teamyra-profile.json").write_text(json.dumps(meta), encoding="utf-8")
            self.assertEqual(worker_registry.seed_opencode_profiles(td), [], "existing folders are left alone")
            workers = worker_registry.build_worker_registry(td, home=td)
            glm = workers["opencode-glm-5.3-flash-free"]
            self.assertEqual((glm["provider"], glm["label"], glm["enabled"]), ("opencode", "My GLM", False))
            self.assertEqual(glm["settings"]["model"], "opencode/glm-5.3-flash-free")
            self.assertFalse(workers["opencode-flint-40b-free"]["enabled"], "less tested models start disabled")
            self.assertTrue(workers["opencode-big-pickle"]["enabled"])


class OpenCodeCommandTests(unittest.TestCase):
    def test_write_and_read_only_commands(self):
        with patch.object(server, "opencode_launch", return_value=["opencode.exe"]):
            write = server.opencode_cmd("do it", "D:/p", True, None, {"model": "opencode/big-pickle"})
            read = server.opencode_cmd("look", "D:/p", False, "ses_1", {"model": "opencode/big-pickle"})
        self.assertEqual(write, ["opencode.exe", "run", "--model", "opencode/big-pickle", "--format", "json",
                                 "--dir", "D:/p", "--auto", "do it"])
        self.assertIn("--agent", read)
        self.assertEqual(read[read.index("--agent") + 1], "plan")
        self.assertNotIn("--auto", read)
        self.assertEqual(read[read.index("--session") + 1], "ses_1")
        self.assertEqual(read[-1], "look")

    def test_readiness_needs_the_model_in_opencode_models(self):
        info = {"provider": "opencode", "settings": {"model": "opencode/big-pickle"}}
        with patch.object(server, "opencode_models", return_value={"opencode/big-pickle"}):
            ready, detail, _ = server._probe_worker_auth(info, 0)
        self.assertTrue(ready, detail)
        with patch.object(server, "opencode_models", return_value={"opencode/beam-free"}):
            ready, detail, _ = server._probe_worker_auth(info, 0)
        self.assertFalse(ready)
        self.assertIn("not offered", detail)


class OpenCodeRunnerTests(unittest.TestCase):
    def make_job(self):
        tmp = tempfile.TemporaryDirectory()
        job = Path(tmp.name)
        (job / "spec.json").write_text(json.dumps({"worker": "opencode-big-pickle", "provider": "opencode",
                                                   "cwd": str(ROOT), "cmd": []}), encoding="utf-8")
        (job / "meta.json").write_text(json.dumps({"id": "t", "worker": "opencode-big-pickle",
                                                   "provider": "opencode", "state": "starting"}), encoding="utf-8")
        return tmp, Job(job)

    def test_events_give_session_text_tools_and_usage(self):
        tmp, job = self.make_job()
        try:
            sid = "ses_e45358b65ffe2GmHuDvXPUE27F"
            job.opencode_event({"type": "step_start", "sessionID": sid, "part": {"type": "step-start"}})
            job.opencode_event({"type": "tool_use", "sessionID": sid, "part": {
                "type": "tool", "tool": "bash",
                "state": {"status": "completed", "input": {"command": "git status"}, "output": "clean"}}})
            job.opencode_event({"type": "text", "sessionID": sid, "part": {"type": "text", "text": "OK"}})
            job.opencode_event({"type": "step_finish", "sessionID": sid, "part": {
                "type": "step-finish", "tokens": {"input": 11442, "output": 3, "reasoning": 10}, "cost": 0}})
            self.assertEqual(job.meta["session_id"], sid)
            self.assertEqual(job.final_text, "OK")
            self.assertEqual(job.meta["usage"]["input_tokens"], 11442)
            events = (job.dir / "events.jsonl").read_text(encoding="utf-8")
            self.assertIn("git status", events)
        finally:
            job.events.close()
            job.transcript.close()
            tmp.cleanup()

    def test_a_rate_limit_error_with_exit_code_0_is_a_limit(self):
        tmp, job = self.make_job()
        try:
            line = {"type": "error", "error": {"name": "APIError", "data": {"message": "Rate limit exceeded"}}}
            job.opencode_event(line)
            job.raw_tail = [json.dumps(line)]
            with patch.object(job, "run_once", return_value=(0, "", False, False)):
                job.run()
            meta = json.loads((job.dir / "meta.json").read_text(encoding="utf-8"))
            self.assertEqual((meta["state"], meta["reason"]), ("failed", "usage_or_rate_limit"))
        finally:
            job.events.close()
            job.transcript.close()
            tmp.cleanup()


if __name__ == "__main__":
    unittest.main()
