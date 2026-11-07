"""The desktop core (desktop_api --serve) must keep answering after a request
imports server.py. server.py reconfigured sys.stdin on import, which ended
the core's request loop: it exited with requests unanswered every minute or
so under load (2026-11-07)."""
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class CoreServeTests(unittest.TestCase):
    def test_core_survives_importing_server(self):
        with tempfile.TemporaryDirectory() as td:
            env = dict(os.environ, TEAMYRA_ROOT=td, PYTHONIOENCODING="utf-8")
            proc = subprocess.Popen([sys.executable, str(ROOT / "bridge" / "desktop_api.py"), "--serve"],
                                    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                    text=True, encoding="utf-8", env=env)
            try:
                def ask(request_id, action, payload):
                    proc.stdin.write(json.dumps({"id": request_id, "action": action, "payload": payload}) + "\n")
                    proc.stdin.flush()
                    deadline = time.time() + 60
                    while time.time() < deadline:
                        line = proc.stdout.readline()
                        if not line:
                            self.fail(f"core exited (code {proc.poll()}) before answering request {request_id}")
                        message = json.loads(line)
                        if message.get("id") == request_id:
                            return message
                    self.fail(f"no answer to request {request_id}")

                # task.cancel imports server, then fails on the unknown job.
                first = ask(1, "task.cancel", {"job_id": "no-such-job"})
                self.assertFalse(first["ok"])
                for request_id in range(2, 6):
                    answer = ask(request_id, "transfer.check", {"job_id": "no-such-job"})
                    self.assertFalse(answer["ok"])
                time.sleep(0.5)
                self.assertIsNone(proc.poll(), "the core must still be running")
            finally:
                proc.kill()
                proc.wait(timeout=10)


if __name__ == "__main__":
    unittest.main()
