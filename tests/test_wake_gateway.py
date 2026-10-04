import http.client
import json
import sys
import tempfile
import threading
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "bridge"))

import wake_gateway


class WakeGatewayTests(unittest.TestCase):
    def test_active_jobs_only_counts_live_states(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            jobs = root / "jobs"
            (jobs / "done").mkdir(parents=True)
            (jobs / "done" / "meta.json").write_text(json.dumps({"state": "done"}), encoding="utf-8")
            self.assertFalse(wake_gateway.active_jobs(root))

            (jobs / "live").mkdir(parents=True)
            (jobs / "live" / "meta.json").write_text(json.dumps({"state": "running"}), encoding="utf-8")
            self.assertTrue(wake_gateway.active_jobs(root))

    def test_health_check_does_not_wake_backend(self):
        with tempfile.TemporaryDirectory() as td:
            httpd = wake_gateway.create_server(
                "127.0.0.1",
                0,
                runtime_root=td,
                bridge_dir=ROOT / "bridge",
                idle_seconds=30,
                backend_port=0,
            )
            port = httpd.server_address[1]
            thread = threading.Thread(target=httpd.serve_forever, daemon=True)
            thread.start()
            try:
                conn = http.client.HTTPConnection("127.0.0.1", port, timeout=3)
                conn.request("GET", wake_gateway.HEALTH_PATH)
                response = conn.getresponse()
                data = json.loads(response.read().decode("utf-8"))
                conn.close()
                self.assertEqual(response.status, 200)
                self.assertEqual(data["service"], "teamyra-wake-gateway")
                self.assertFalse(data["backend_running"])
                self.assertFalse(httpd.manager.backend_alive())
            finally:
                httpd.shutdown()
                httpd.manager.close()
                httpd.server_close()
                thread.join(timeout=3)

    def test_idle_seconds_has_minimum_safety_floor(self):
        with tempfile.TemporaryDirectory() as td:
            manager = wake_gateway.BackendManager(
                td,
                ROOT / "bridge",
                idle_seconds=1,
                backend_port=0,
            )
            self.assertEqual(manager.idle_seconds, 30)


if __name__ == "__main__":
    unittest.main()
