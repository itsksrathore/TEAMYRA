import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "bridge"))

import review_cycle
import server


class ReviewCycleTests(unittest.TestCase):
    def test_parse_decision_uses_last_marker(self):
        text = """Initial thought.
TEAMYRA_REVIEW: CHANGES
After fixes:
TEAMYRA_REVIEW: PASS
"""
        self.assertEqual(review_cycle.parse_decision(text), "PASS")
        self.assertIsNone(review_cycle.parse_decision("No marker here"))

    def test_create_load_and_round_bounds(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            state = review_cycle.create(root, "job-1", "auto", 99)
            self.assertEqual(state["max_rounds"], 5)
            loaded = review_cycle.load(root, state["id"])
            self.assertEqual(loaded["source_job_id"], "job-1")
            self.assertEqual(loaded["state"], "draft")

    def test_review_status_and_cancel_tools(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            state = review_cycle.create(root, "job-1", "codex2", 2)
            with patch.object(server, "ROOT", root):
                status = server.tool_call("review_status", {"review_id": state["id"]})
                self.assertEqual(status["reviewer_worker"], "codex2")
                cancelled = server.tool_call("review_cancel", {"review_id": state["id"]})
                self.assertTrue(cancelled["cancel_requested"])
                loaded = review_cycle.load(root, state["id"])
                self.assertTrue(loaded["cancel_requested"])

    def test_invalid_review_id_is_rejected(self):
        with tempfile.TemporaryDirectory() as td:
            with self.assertRaises(ValueError):
                review_cycle.load(Path(td), "../escape")


if __name__ == "__main__":
    unittest.main()
