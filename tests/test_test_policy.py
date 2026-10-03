import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "bridge"))

import server
import test_policy


class TestPolicyTests(unittest.TestCase):
    def test_successful_steps_run_in_order(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            result = test_policy.run_steps([
                {
                    "name": "one",
                    "argv": [sys.executable, "-c", "print('ONE')"],
                    "timeout_seconds": 10,
                },
                {
                    "name": "two",
                    "argv": [sys.executable, "-c", "print('TWO')"],
                    "timeout_seconds": 10,
                },
            ], root)
            self.assertTrue(result["ok"])
            self.assertEqual(result["state"], "passed")
            self.assertEqual([step["name"] for step in result["steps"]], ["one", "two"])
            self.assertIn("ONE", result["steps"][0]["stdout_tail"])
            self.assertIn("TWO", result["steps"][1]["stdout_tail"])

    def test_failure_stops_following_steps(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            marker = root / "should-not-exist.txt"
            result = test_policy.run_steps([
                {
                    "name": "fail",
                    "argv": [sys.executable, "-c", "import sys; sys.exit(7)"],
                },
                {
                    "name": "never",
                    "argv": [
                        sys.executable,
                        "-c",
                        f"from pathlib import Path; Path({str(marker)!r}).write_text('bad')",
                    ],
                },
            ], root)
            self.assertFalse(result["ok"])
            self.assertEqual(result["failed_step"], "fail")
            self.assertEqual(result["steps"][0]["exit_code"], 7)
            self.assertEqual(len(result["steps"]), 1)
            self.assertFalse(marker.exists())

    def test_timeout_is_reported_as_failure(self):
        with tempfile.TemporaryDirectory() as td:
            result = test_policy.run_steps([{
                "name": "timeout",
                "argv": [sys.executable, "-c", "import time; time.sleep(2)"],
                "timeout_seconds": 1,
            }], td)
            self.assertFalse(result["ok"])
            self.assertTrue(result["steps"][0]["timed_out"])
            self.assertIsNone(result["steps"][0]["exit_code"])

    def test_policy_is_explicitly_no_shell(self):
        source = (ROOT / "bridge" / "test_policy.py").read_text(encoding="utf-8")
        self.assertIn("shell=False", source)
        self.assertNotIn("shell=True", source)

    def test_validation_rejects_string_command(self):
        with self.assertRaisesRegex(ValueError, "argv"):
            test_policy.normalize_steps([{"argv": "python -m pytest"}])

    def test_mcp_test_run_uses_same_policy_engine(self):
        tool = next(tool for tool in server.TOOLS if tool["name"] == "test_run")
        self.assertEqual(tool["inputSchema"]["properties"]["tests"]["maxItems"], 12)
        with tempfile.TemporaryDirectory() as td:
            result = server.tool_call("test_run", {
                "project_path": td,
                "tests": [{
                    "name": "smoke",
                    "argv": [sys.executable, "-c", "print('MCP_TEST_OK')"],
                }],
            })
            self.assertTrue(result["ok"])
            self.assertIn("MCP_TEST_OK", result["steps"][0]["stdout_tail"])


if __name__ == "__main__":
    unittest.main()
