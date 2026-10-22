import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "bridge"))

import desktop_api
import server
import workspace_tools


class DesktopTaskActionTests(unittest.TestCase):
    def test_scheduler_dispatch_advances_queued_desktop_job(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            job = root / "jobs" / "queued-web"
            job.mkdir(parents=True)
            (job / "meta.json").write_text(json.dumps({
                "id": job.name, "worker": "chatgpt-normal", "provider": "chatgpt-web",
                "state": "queued", "created": 1,
            }), encoding="utf-8")
            with patch.object(desktop_api, "ROOT", root):
                report = desktop_api.handle("scheduler.dispatch", {})
            self.assertEqual(report["dispatched"][0]["job_id"], job.name)
            self.assertEqual(json.loads((job / "meta.json").read_text())["state"], "waiting_for_desktop")

    def test_workspace_elevations_require_confirmed_user_access_payload(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "runtime"
            workspace = Path(td) / "project"
            workspace.mkdir()
            service = workspace_tools.WorkspaceToolService(root)
            service.state_root.mkdir(parents=True)
            token = "x" * 64
            service.token_file.write_text(token, encoding="utf-8")
            with patch.object(desktop_api, "ROOT", root), patch.object(desktop_api, "_bridge_token", return_value=token):
                desktop_api.handle("chatgpt.workspace.configure", {"workspace": str(workspace)})
                for key in ("full_access", "outside_workspace", "destructive_without_confirmation"):
                    with self.subTest(key=key):
                        for payload in ({"permissions": {key: True}, "user_confirmed": True}, {"access": {key: True}}):
                            with self.assertRaises(PermissionError):
                                desktop_api.handle("chatgpt.workspace.configure", {"workspace": str(workspace), **payload})
                access = {"full_access": True, "outside_workspace": True, "destructive_without_confirmation": True}
                desktop_api.handle("chatgpt.workspace.configure", {
                    "workspace": str(workspace), "permissions": {"terminal": True},
                    "access": access, "user_confirmed": True,
                })
                self.assertTrue(all(service.status(token=token)["permissions"][key] for key in access))
                desktop_api.handle("chatgpt.workspace.configure", {
                    "access": {key: False for key in access}, "user_confirmed": True,
                })
                self.assertTrue(all(not service.status(token=token)["permissions"][key] for key in access))

    def test_task_start_reuses_server_start_job(self):
        with patch.object(server, "start_job", return_value=("job-123", "codex1")) as start:
            result = desktop_api.handle("task.start", {
                "task": "Fix the renderer",
                "project_path": str(ROOT),
                "worker": "auto",
                "write": True,
                "timeout_minutes": 45,
                "auto_failover": True,
            })

        self.assertEqual(result, {"job_id": "job-123", "worker": "codex1"})
        args, kwargs = start.call_args
        self.assertEqual(args[0], "auto")
        self.assertEqual(args[1], "Fix the renderer")
        self.assertEqual(args[2], str(ROOT))
        self.assertEqual(kwargs["timeout_minutes"], 45)
        self.assertTrue(kwargs["write"])
        self.assertTrue(kwargs["auto_failover"])

    def test_task_start_validates_required_fields(self):
        with self.assertRaisesRegex(ValueError, "task is required"):
            desktop_api.handle("task.start", {"project_path": str(ROOT)})

        with self.assertRaisesRegex(ValueError, "project_path is required"):
            desktop_api.handle("task.start", {"task": "Do work"})

    def test_task_cancel_writes_existing_job_cancel_signal(self):
        with tempfile.TemporaryDirectory() as td:
            jobs = Path(td)
            active = jobs / "active-job"
            active.mkdir()
            with patch.object(server, "JOBS", jobs), \
                 patch.object(server, "failover_terminal_job_id", return_value="active-job"), \
                 patch.object(server, "read_meta", return_value={"id": "active-job"}):
                result = desktop_api.handle("task.cancel", {"job_id": "root-job"})

            self.assertTrue((active / "CANCEL").is_file())
            self.assertEqual(result["job_id"], "root-job")
            self.assertEqual(result["cancelled_job_id"], "active-job")


if __name__ == "__main__":
    unittest.main()
