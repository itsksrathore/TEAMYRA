import json
import subprocess
import sys
import unittest
from pathlib import Path

DESKTOP_API = Path(__file__).resolve().parents[1] / "bridge" / "desktop_api.py"


class ServeReadsUtf8Tests(unittest.TestCase):
    """ISS-20261107-170009: the desktop writes UTF-8, but the core read its
    piped stdin as cp1252; "”" arrived garbled and as a lone surrogate."""

    def test_non_ascii_request_arrives_intact(self):
        action = "nope ” → हि"
        line = json.dumps({"id": 1, "action": action, "payload": {}}, ensure_ascii=False) + "\n"
        proc = subprocess.run([sys.executable, str(DESKTOP_API), "--serve"], input=line.encode("utf-8"),
                              capture_output=True, timeout=60)
        reply = json.loads(proc.stdout.decode("utf-8").splitlines()[0])
        self.assertFalse(reply["ok"])
        self.assertIn(action, reply["error"])


if __name__ == "__main__":
    unittest.main()
