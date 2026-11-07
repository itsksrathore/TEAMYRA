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


if __name__ == "__main__":
    unittest.main()
