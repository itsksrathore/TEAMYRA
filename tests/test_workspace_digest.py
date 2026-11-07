import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "bridge"))

import workspace_tools
from workspace_tools import WorkspaceToolService, digest_output


class DigestFunctionTests(unittest.TestCase):
    def make_lines(self, count, extra=None):
        lines = [f"line {index}" for index in range(1, count + 1)]
        for position, value in (extra or {}).items():
            lines[position] = value
        return lines

    def test_short_output_is_returned_unchanged(self):
        text = "\n".join(self.make_lines(10))
        self.assertEqual(digest_output(text), text)

    def test_long_output_keeps_head_tail_and_marks_cuts(self):
        lines = self.make_lines(300)
        digest = digest_output("\n".join(lines), label="stdout", full_log="D:/logs/1.txt")
        self.assertIn("[digest stdout: 300 lines", digest)
        self.assertIn("full log: D:/logs/1.txt", digest)
        self.assertIn("line 1\n", digest + "\n")
        self.assertIn("line 40", digest)
        self.assertIn("line 300", digest)
        self.assertNotIn("line 150", digest)
        self.assertIn("lines cut", digest)
        kept = [line for line in digest.splitlines() if line.startswith("line ")]
        self.assertEqual(kept, [f"line {i}" for i in list(range(1, 41)) + list(range(241, 301))])
        # The number of cut lines is labelled and adds up to the whole output.
        cut = 0
        for line in digest.splitlines():
            if "line cut" in line or "lines cut" in line:
                cut += int(line.split()[1])
        self.assertEqual(cut, 200)

    def test_error_lines_keep_two_context_lines(self):
        lines = self.make_lines(400, {199: "Traceback (most recent call last):"})
        digest = digest_output("\n".join(lines))
        self.assertIn("Traceback (most recent call last):", digest)
        for number in (198, 199, 201, 202):
            self.assertIn(f"line {number}\n", digest + "\n")
        self.assertNotIn("line 197\n", digest + "\n")
        self.assertNotIn("line 203\n", digest + "\n")

    def test_overlapping_contexts_are_merged(self):
        lines = self.make_lines(400, {149: "ERROR one", 152: "FAILED two", 155: "assert three"})
        digest = digest_output("\n".join(lines))
        kept = [line for line in digest.splitlines() if line.startswith("line ")]
        # The three error lines sit on lines 150, 153 and 156; their context
        # windows overlap and merge into one 148-158 block.
        block = [number for number in range(148, 159) if number not in (150, 153, 156)]
        self.assertEqual(
            kept,
            [f"line {i}" for i in list(range(1, 41)) + block + list(range(341, 401))],
        )
        self.assertNotIn("line 146\n", digest + "\n")
        self.assertNotIn("line 159\n", digest + "\n")
        positions = [int(line.split()[1]) for line in kept]
        self.assertEqual(positions, sorted(positions))
        self.assertEqual(len(positions), len(set(positions)))
        self.assertIn("\u2026 107 lines cut \u2026", digest)
        self.assertIn("\u2026 182 lines cut \u2026", digest)

    def test_summary_lines_are_kept(self):
        lines = self.make_lines(400, {
            120: "========== 3 passed, 1 failed in 0.12s ==========",
            140: "Ran 12 tests in 0.034s",
            160: "# pass 7",
            180: "npm ERR! code ELIFECYCLE",
            200: "src/app.ts(3,1): error TS2304: Cannot find name 'x'.",
            220: " 3 files changed, 10 insertions(+)",
            240: "[main 1a2b3c4] C-1: message",
        })
        digest = digest_output("\n".join(lines))
        for expected in (
            "3 passed, 1 failed",
            "Ran 12 tests",
            "# pass 7",
            "npm ERR!",
            "error TS2304",
            "files changed",
            "[main 1a2b3c4]",
        ):
            self.assertIn(expected, digest)

    def test_cut_labels_are_singular_for_one_line(self):
        lines = self.make_lines(102)
        lines[101] = "warning: last"
        digest = digest_output("\n".join(lines))
        self.assertIn("\u2026 2 lines cut \u2026", digest)
        lines = self.make_lines(101)
        digest = digest_output("\n".join(lines))
        self.assertIn("\u2026 1 line cut \u2026", digest)


class TerminalDigestServiceTests(unittest.TestCase):
    def make_service(self, root, workspace):
        service = WorkspaceToolService(root)
        service.state_root.mkdir(parents=True, exist_ok=True)
        service.token_file.write_text("x" * 64, encoding="utf-8")
        service.configure(workspace, {"terminal": True}, token="x" * 64, actor="test")
        service.set_access(
            {"full_access": True, "outside_workspace": True},
            token="x" * 64, actor="user-test", user_confirmed=True,
        )
        return service

    def run_terminal(self, service, args, completed):
        with patch("workspace_tools.subprocess.run", return_value=completed) as run:
            result = service.execute("terminal.run", args, token="x" * 64, confirm=True)
        return result, run

    def test_long_output_is_digested_and_full_log_saved(self):
        with tempfile.TemporaryDirectory() as td:
            workspace = Path(td) / "project"
            workspace.mkdir()
            service = self.make_service(Path(td) / "runtime", workspace)
            lines = [f"line {index}" for index in range(1, 801)]
            lines[400] = "ERROR: boom"
            stdout = "\n".join(lines)
            stderr = "warn: something\n" * 400
            args = {"argv": [sys.executable, "-m", "unittest"], "job": "job-1"}
            result, run = self.run_terminal(
                service, args, subprocess.CompletedProcess([], 3, stdout, stderr)
            )
            self.assertTrue(result["digest"])
            self.assertEqual(result["exit_code"], 3)
            self.assertEqual(result["argv"][1:], ["-m", "unittest"])
            self.assertIn("ERROR: boom", result["stdout"])
            self.assertLess(len(result["stdout"]), len(stdout))
            self.assertIn("digest stderr", result["stderr"])
            full_log = Path(result["full_log"])
            self.assertTrue(full_log.is_file())
            self.assertEqual(full_log.parent, (service.root / "logs" / "terminal" / "job-1").resolve())
            self.assertEqual(full_log.name, "1.txt")
            saved = full_log.read_text(encoding="utf-8")
            self.assertIn("exit_code: 3", saved)
            self.assertIn("ERROR: boom", saved)
            self.assertIn(stdout, saved)
            self.assertIn(stderr, saved)

            second, _ = self.run_terminal(
                service, args, subprocess.CompletedProcess([], 0, stdout, stderr)
            )
            self.assertEqual(Path(second["full_log"]).name, "2.txt")

    def test_short_output_keeps_old_behaviour(self):
        with tempfile.TemporaryDirectory() as td:
            workspace = Path(td) / "project"
            workspace.mkdir()
            service = self.make_service(Path(td) / "runtime", workspace)
            result, _ = self.run_terminal(
                service,
                {"argv": [sys.executable, "-m", "unittest"]},
                subprocess.CompletedProcess([], 0, "ok\n", ""),
            )
            self.assertEqual(result["stdout"], "ok\n")
            self.assertEqual(result["stderr"], "")
            self.assertNotIn("digest", result)
            self.assertFalse((service.root / "logs" / "terminal").exists())

    def test_digest_false_preserves_full_output(self):
        with tempfile.TemporaryDirectory() as td:
            workspace = Path(td) / "project"
            workspace.mkdir()
            service = self.make_service(Path(td) / "runtime", workspace)
            stdout = "\n".join(f"line {index}" for index in range(1, 2000))
            result, _ = self.run_terminal(
                service,
                {"argv": [sys.executable, "-m", "unittest"], "digest": False},
                subprocess.CompletedProcess([], 1, stdout, "boom\n"),
            )
            self.assertEqual(result["stdout"], stdout)
            self.assertEqual(result["stderr"], "boom\n")
            self.assertEqual(result["exit_code"], 1)
            self.assertNotIn("digest", result)
            self.assertFalse((service.root / "logs" / "terminal").exists())

    def test_explicit_digest_true_digests_short_output(self):
        with tempfile.TemporaryDirectory() as td:
            workspace = Path(td) / "project"
            workspace.mkdir()
            service = self.make_service(Path(td) / "runtime", workspace)
            stdout = "\n".join(f"line {index}" for index in range(1, 200))
            result, _ = self.run_terminal(
                service,
                {"argv": [sys.executable, "-m", "unittest"], "digest": True, "job": "a/b"},
                subprocess.CompletedProcess([], 0, stdout, ""),
            )
            self.assertTrue(result["digest"])
            self.assertIn("lines cut", result["stdout"])
            full_log = Path(result["full_log"])
            self.assertEqual(full_log.parent.name, "a_b")
            self.assertEqual(full_log.parent.parent, (service.root / "logs" / "terminal").resolve())


if __name__ == "__main__":
    unittest.main()
