import unittest
from unittest.mock import patch
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "bridge"))

import server


class RoutingTests(unittest.TestCase):
    def test_auto_excludes_disabled_and_uses_priority(self):
        registry = {
            "disabled": {"id": "disabled", "provider": "codex", "enabled": False, "priority": 0},
            "later": {"id": "later", "provider": "codex", "enabled": True, "priority": 50},
            "first": {"id": "first", "provider": "codex", "enabled": True, "priority": 10},
        }
        with patch.object(server, "worker_registry", return_value=registry),              patch.object(server, "config", return_value={"auto_order": []}),              patch.object(server, "cooldown_left", return_value=0),              patch.object(server, "running_jobs", return_value=[]),              patch.object(server, "worker_auth_status", return_value=(True, "ready")):
            self.assertEqual(server.pick_worker("auto"), "first")

    def test_explicit_worker_selection_is_not_blocked_by_auto_enabled_flag(self):
        registry = {
            "disabled": {"id": "disabled", "provider": "codex", "enabled": False, "priority": 0},
        }
        with patch.object(server, "worker_registry", return_value=registry):
            self.assertEqual(server.pick_worker("disabled"), "disabled")


if __name__ == "__main__":
    unittest.main()
