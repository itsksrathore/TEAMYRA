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


class ResolveArgvTests(unittest.TestCase):
    """npm on Windows is npm.cmd, which a shell-less start cannot run
    (maintenance issue ISS-20261107-103622-59ae1f)."""

    def test_windows_names_resolve_without_a_shell(self):
        with tempfile.TemporaryDirectory() as td:
            folder = Path(td) / "nodejs"
            (folder / "node_modules" / "npm" / "bin").mkdir(parents=True)
            for name in ("node.exe", "npm.cmd", "npx.cmd", "tool.bat", "node_modules/npm/bin/npm-cli.js",
                         "node_modules/npm/bin/npx-cli.js"):
                (folder / name).write_text("", encoding="utf-8")
            paths = {"npm": folder / "npm.cmd", "npx": folder / "npx.cmd", "tool": folder / "tool.bat",
                     "python": Path(td) / "python.exe", "node": folder / "node.exe"}
            which = lambda name: str(paths[name]) if name in paths else None
            resolve = lambda argv: test_policy.resolve_argv(argv, which=which, platform="nt")
            self.assertEqual(resolve(["npm", "run", "desktop:check"]),
                             [str(folder / "node.exe"), str(folder / "node_modules/npm/bin/npm-cli.js"), "run", "desktop:check"])
            self.assertEqual(resolve(["npx", "tsc"])[1], str(folder / "node_modules/npm/bin/npx-cli.js"))
            self.assertEqual(resolve(["python", "-m", "unittest"]), [str(paths["python"]), "-m", "unittest"])
            with self.assertRaisesRegex(ValueError, "batch file"):
                resolve(["tool", "x"])
            with self.assertRaisesRegex(ValueError, "not found on PATH"):
                resolve(["missing-program"])
            # Elsewhere the argv is used as given.
            self.assertEqual(test_policy.resolve_argv(["npm", "test"], which=which, platform="posix"), ["npm", "test"])


if __name__ == "__main__":
    unittest.main()
