import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class PackagedFollowTests(unittest.TestCase):
    def test_internal_follow_uses_explicit_runtime_outside_repository(self):
        with tempfile.TemporaryDirectory(prefix="teamyra follow ") as temp:
            job = Path(temp) / "jobs" / "finished-job"
            job.mkdir(parents=True)
            (job / "transcript.md").write_text("completed transcript\n", encoding="utf-8")
            (job / "DONE").write_text("done", encoding="utf-8")
            env = {key: value for key, value in os.environ.items() if key != "TEAMYRA_ROOT"}
            result = subprocess.run([
                sys.executable, str(ROOT / "bridge/teamyra_entry.py"), "__follow",
                job.name, "--runtime-root", temp,
            ], cwd=temp, env=env, capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("completed transcript", result.stdout)
