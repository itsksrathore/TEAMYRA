import json
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "bridge"))
import desktop_api


class LeadToolTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root_patch = patch.object(desktop_api, "ROOT", Path(self.temp.name))
        self.root_patch.start()
        self.addCleanup(self.root_patch.stop)
        self.calls = []
        def tool_call(name, args):
            self.calls.append((name, args))
            return {"ok": True, "name": name}
        self.fake = types.SimpleNamespace(tool_call=tool_call)
        self.server_patch = patch.dict(sys.modules, {"server": self.fake})
        self.server_patch.start()
        self.addCleanup(self.server_patch.stop)

    def run_tool(self, name, args=None):
        return desktop_api.handle("lead.tool", {"name": name, "args": args if args is not None else {}})

    def audit(self):
        return [json.loads(line) for line in (Path(self.temp.name) / "logs" / "lead-tools.jsonl").read_text().splitlines()]

    def test_all_allowlisted_and_prefix(self):
        for name in sorted(desktop_api._LEAD_TOOLS):
            self.assertEqual(self.run_tool("lead." + name)["name"], name)
        self.assertEqual(len(self.calls), len(desktop_api._LEAD_TOOLS))
        self.assertEqual(len(self.audit()), len(self.calls))

    def test_denies_unknown_and_bad_args_without_dispatch(self):
        for name, args in (("lead.review_start", {}), ("lead.lead.job_cancel", {}),
                           ("terminal.run", {}), ("lead.job_cancel", []),
                           ("lead.job_cancel", {1: "bad"})):
            with self.subTest(name=name, args=args), self.assertRaises(ValueError):
                self.run_tool(name, args)
        with self.assertRaises(ValueError):
            desktop_api.handle("lead.tool", {"name": 7})
        self.assertEqual(self.calls, [])
        self.assertTrue(all(row["outcome"] == "denied" for row in self.audit()))

    def test_wait_cap_default_and_lower_and_no_mutation(self):
        for original, expected in (({}, 120), ({"timeout_seconds": 9999}, 120),
                                   ({"timeout_seconds": 4}, 4), ({"timeout_seconds": 0}, 0), ({"timeout_seconds": -1}, -1)):
            args = {"job_ids": ["a"], **original}
            snapshot = dict(args)
            self.run_tool("lead.job_wait", args)
            self.assertEqual(self.calls[-1][1]["timeout_seconds"], expected)
            self.assertEqual(args, snapshot)
        for timeout in (True, "999", None, float("nan"), float("inf"), float("-inf")):
            with self.assertRaises(ValueError):
                self.run_tool("job_wait", {"timeout_seconds": timeout})

    def test_returned_ok_false_audits_error(self):
        self.fake.tool_call = lambda name, args: {'ok': False, 'error': 'boom'}
        result = self.run_tool('lead.job_cancel', {'job_id': 'j'})
        self.assertEqual(result, {'ok': False, 'error': 'boom'})
        self.assertEqual(self.audit()[-1]['outcome'], 'error')
        self.fake.tool_call = lambda name, args: {'ok': True, 'name': name, 'job': {'state': 'failed'}}
        result = self.run_tool('lead.job_result', {'job_id': 'j'})
        self.assertEqual(result['job']['state'], 'failed')
        self.assertEqual(self.audit()[-1]['outcome'], 'success')

    def test_import_failure_audits_error(self):
        with patch.dict(sys.modules, {'server': None}):
            with self.assertRaises(ImportError):
                self.run_tool('lead.job_cancel', {'job_id': 'j'})
        self.assertEqual(self.audit()[-1]['outcome'], 'error')

    def test_forward_confirm_unchanged_and_preserve_result(self):
        args = {"worktree_id": "w", "confirm": False}
        result = self.run_tool("lead.worktree_merge", args)
        self.assertEqual(result, {"ok": True, "name": "worktree_merge"})
        self.assertEqual(self.calls[-1], ("worktree_merge", args))
        self.run_tool("job_cancel", {"job_id": "j"})
        self.assertNotIn("confirm", self.calls[-1][1])

    def test_error_audit_and_no_secrets(self):
        def fail(name, args):
            raise RuntimeError("private token abc")
        self.fake.tool_call = fail
        with self.assertRaisesRegex(RuntimeError, "private token"):
            self.run_tool("lead.memory_add", {"content": "secret content"})
        with self.assertRaises(ValueError):
            self.run_tool("lead.secret-token", {"password": "private"})
        text = (Path(self.temp.name) / "logs" / "lead-tools.jsonl").read_text()
        self.assertNotIn("secret content", text)
        self.assertNotIn("private token", text)
        self.assertNotIn("password", text)
        self.assertEqual([x["outcome"] for x in self.audit()], ["error", "denied"])


if __name__ == "__main__":
    unittest.main()
