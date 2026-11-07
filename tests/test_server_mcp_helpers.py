import sys
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "bridge"))
import server  # noqa: E402


class StaleCodeNoticeTests(unittest.TestCase):
    def setUp(self):
        self.saved = (server.SERVER_STARTED_AT, dict(server._STALE_CHECK))

    def tearDown(self):
        server.SERVER_STARTED_AT = self.saved[0]
        server._STALE_CHECK.clear()
        server._STALE_CHECK.update(self.saved[1])

    def test_notice_when_code_is_newer_than_the_process(self):
        server.SERVER_STARTED_AT = 0  # every bridge file is newer
        server._STALE_CHECK.update(at=0.0, stale=False, told_at=0.0)
        now = time.time()
        self.assertIn("reload the TEAMYRA MCP server", server.stale_code_notice(now))
        self.assertIsNone(server.stale_code_notice(now + 60), "said at most once every 10 minutes")
        self.assertIsNotNone(server.stale_code_notice(now + 700))

    def test_no_notice_for_a_current_process(self):
        server.SERVER_STARTED_AT = time.time() + 3600
        server._STALE_CHECK.update(at=0.0, stale=False, told_at=0.0)
        self.assertIsNone(server.stale_code_notice())


class FollowUpSettingsTests(unittest.TestCase):
    def test_follow_up_keeps_the_parent_settings(self):
        parent = {"pin": True, "pool": False, "transfer": False, "write": True, "account_fixed": True}
        got = server.follow_up_settings(parent, {})
        self.assertEqual((got["pin"], got["pool"], got["transfer"], got["account_fixed"], got["write"]),
                         (True, False, False, True, True))
        self.assertFalse(server.follow_up_settings(parent, {"pin": False})["pin"])
        self.assertIsNone(server.follow_up_settings({}, {})["transfer"])


class JobCancelTests(unittest.TestCase):
    def test_cancel_stops_the_named_running_sibling(self):
        # ISS-20261107-173958: two continuations of one root; cancelling the
        # running one cancelled the finished sibling on the root's chain.
        import json
        import tempfile
        with tempfile.TemporaryDirectory() as td:
            jobs = Path(td) / "jobs"
            def job(job_id, done, **meta):
                (jobs / job_id).mkdir(parents=True)
                (jobs / job_id / "meta.json").write_text(json.dumps({"id": job_id, "worker": "w", "state": "running",
                                                                     **meta}), encoding="utf-8")
                if done:
                    (jobs / job_id / "DONE").write_text("done", encoding="utf-8")
            job("root", True, failover_job_id="b")
            job("b", True, failover_root="root", state="done")
            job("c", False, failover_root="root")
            saved = server.JOBS
            server.JOBS = jobs
            try:
                result = server.tool_call("job_cancel", {"job_id": "c"})
            finally:
                server.JOBS = saved
            self.assertEqual(result["cancelled_job_id"], "c")
            self.assertTrue((jobs / "c" / "CANCEL").exists())
            self.assertFalse((jobs / "b" / "CANCEL").exists())

if __name__ == "__main__":
    unittest.main()
