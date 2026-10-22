import json
import sys
import tempfile
import unittest
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "bridge"))
import expected_outputs
import observability
import runner
import server


class ExpectedOutputTests(unittest.TestCase):
    def test_validation_rejects_absolute_escaping_and_invalid_paths(self):
        with tempfile.TemporaryDirectory() as td:
            for paths in ("file.txt", [""], [None], ["../outside"], ["a/../../b"],
                          ["C:/file"], ["C:file"], ["/file"], ["\\\\server\\file"]):
                with self.subTest(paths=paths), self.assertRaises(ValueError):
                    expected_outputs.validate_expect_files(td, paths)
            self.assertEqual(expected_outputs.validate_expect_files(td, ["sub\\out.txt"]), ["sub\\out.txt"])

    def test_all_cli_providers_verify_outputs_before_done(self):
        for provider in ("codex", "claude", "antigravity"):
            for output in ("missing", "empty", "directory", "ready", "no_contract"):
                with self.subTest(provider=provider, output=output), tempfile.TemporaryDirectory() as td:
                    project = Path(td) / "project"
                    project.mkdir()
                    target = project / "out.txt"
                    if output in ("empty", "ready"):
                        target.write_text("content" if output == "ready" else "")
                    elif output == "directory":
                        target.mkdir()
                    paths = [] if output == "no_contract" else ["out.txt"]
                    job_dir = Path(td) / "jobs" / "job"
                    job_dir.mkdir(parents=True)
                    (job_dir / "meta.json").write_text(json.dumps({"id": "job", "worker": "worker",
                        "provider": provider, "state": "starting", "expect_files": paths}))
                    (job_dir / "spec.json").write_text(json.dumps({"worker": "worker", "provider": provider,
                        "cwd": str(project), "cmd": ["fake"], "expect_files": paths}))
                    job = runner.Job(job_dir)
                    try:
                        with patch.object(job, "run_once", return_value=(0, "", False, False)):
                            job.run()
                    finally:
                        job.events.close()
                        job.transcript.close()
                    meta = json.loads((job_dir / "meta.json").read_text())
                    passed = output in ("ready", "no_contract")
                    self.assertEqual(meta["state"], "done" if passed else "failed")
                    self.assertEqual(meta["reason"], None if passed else "missing_output")
                    self.assertEqual(meta["exit_code"], 0 if passed else 1)
                    self.assertEqual((job_dir / "DONE").read_text(), meta["state"])

    def test_start_options_persist_in_spec_meta_status_and_report(self):
        with tempfile.TemporaryDirectory() as td, ExitStack() as stack:
            root = Path(td)
            jobs = root / "jobs"
            jobs.mkdir()
            registry = {"chat": {"provider": "chatgpt-web", "profile_id": "account", "label": "Chat"}}
            for name, value in {"ROOT": root, "JOBS": jobs}.items():
                stack.enter_context(patch.object(server, name, value))
            for name, value in {"worker_registry": registry, "worker_auth_status": (True, "ready"),
                                "worker_settings": {}, "cooldown_left": 0, "git": "head", "config": {}}.items():
                stack.enter_context(patch.object(server, name, return_value=value))
            job_id, _ = server.start_job("chat", "Create output", root, pin=True, pool=True,
                                         expect_files=["out.txt"], queue=False)
            for filename in ("spec.json", "meta.json"):
                data = json.loads((jobs / job_id / filename).read_text())
                self.assertEqual(data["expect_files"], ["out.txt"])
                self.assertTrue(data["pin"])
                self.assertTrue(data["pool"])
                self.assertEqual(data["profile_id"], "account")
            status = server.tool_call("job_status", {"job_id": job_id})
            self.assertEqual(status["expect_files"], ["out.txt"])
            report = observability.team_report(root, [{"worker": "chat"}])
            self.assertEqual(report["workers"][0]["current_job"]["expect_files"], ["out.txt"])
            server.patch_job_meta(job_id, state="failed", reason="missing_output", exit_code=1,
                                  missing_outputs=["out.txt"])
            (jobs / job_id / "DONE").write_text("failed")
            recent = observability.team_report(root, [{"worker": "chat"}])["workers"][0]["recent_jobs"][0]
            self.assertEqual(recent["expect_files"], ["out.txt"])
            self.assertEqual(recent["missing_outputs"], ["out.txt"])

    def test_both_tools_accept_and_forward_all_options(self):
        for name in ("start_task", "run_ai_worker"):
            with self.subTest(name=name), ExitStack() as stack:
                schema = next(t for t in server.TOOLS if t["name"] == name)["inputSchema"]["properties"]
                self.assertEqual(schema["expect_files"]["items"], {"type": "string"})
                self.assertIn("pin", schema)
                self.assertIn("pool", schema)
                start = stack.enter_context(patch.object(server, "start_job", return_value=("j", "chat")))
                stack.enter_context(patch.object(server, "read_meta", return_value={"state": "queued"}))
                stack.enter_context(patch.object(server, "follow_info", return_value={}))
                stack.enter_context(patch.object(server, "job_wait", return_value={"timed_out": True}))
                stack.enter_context(patch.object(server, "chain_summary", return_value={}))
                stack.enter_context(patch.object(server, "config", return_value={}))
                server.tool_call(name, {"task": "create", "project_path": ".", "pin": True,
                                       "pool": True, "expect_files": ["out.txt"]})
                self.assertTrue(start.call_args.kwargs["pin"])
                self.assertTrue(start.call_args.kwargs["pool"])
                self.assertEqual(start.call_args.kwargs["expect_files"], ["out.txt"])
