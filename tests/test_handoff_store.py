import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "bridge"))

import handoff_store
import server


class HandoffStoreTests(unittest.TestCase):
    def test_create_load_list_and_render_structured_record(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            project = root / "project"
            project.mkdir()
            record = handoff_store.create(
                root,
                project_path=project,
                source_job_id="job-source",
                terminal_job_id="job-terminal",
                source_worker="codex1",
                target_worker="claude1",
                message="Review the implementation and repair correctness issues.",
                objective="Ship a safe implementation.",
                constraints=["Do not change the public API.", "Keep tests deterministic."],
                acceptance_criteria=["All tests pass.", "No uncommitted changes remain."],
                artifacts=["src/app.py", "tests/test_app.py"],
                notes="Focus on concurrency.",
                source_state="done",
                source_final_message="Implementation complete.",
                git_status=[" M src/app.py"],
                diffstat="2 files changed",
                memory_context="- [decision] Use worktrees.",
                write=True,
            )
            self.assertTrue(record["id"].startswith("handoff-"))
            loaded = handoff_store.load(root, record["id"])
            self.assertEqual(loaded["objective"], "Ship a safe implementation.")
            listed = handoff_store.list_records(root, project_path=project)
            self.assertEqual(listed["count"], 1)
            self.assertEqual(listed["items"][0]["id"], record["id"])

            prompt = handoff_store.render_prompt(loaded)
            self.assertIn("Ship a safe implementation.", prompt)
            self.assertIn("Do not change the public API.", prompt)
            self.assertIn("All tests pass.", prompt)
            self.assertIn("Use worktrees.", prompt)
            self.assertIn("Inspect the actual workspace", prompt)
            self.assertLessEqual(len(prompt), handoff_store.MAX_PROMPT)

    def test_prompt_is_bounded_for_large_structured_context(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            project = root / "project"
            project.mkdir()
            record = handoff_store.create(
                root,
                project_path=project,
                source_job_id="source",
                terminal_job_id="terminal",
                source_worker="codex1",
                target_worker="claude1",
                message="x" * 20000,
                constraints=["c" * 3000 for _ in range(24)],
                acceptance_criteria=["a" * 3000 for _ in range(24)],
                artifacts=["p" * 3000 for _ in range(24)],
                source_final_message="f" * 12000,
                memory_context="m" * 12000,
            )
            prompt = handoff_store.render_prompt(record)
            self.assertLessEqual(len(prompt), handoff_store.MAX_PROMPT)
            self.assertIn("Inspect the actual workspace", prompt)

    def test_attach_target_job_updates_persistent_record(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            project = root / "project"
            project.mkdir()
            record = handoff_store.create(
                root,
                project_path=project,
                source_job_id="source",
                terminal_job_id="terminal",
                source_worker="codex1",
                target_worker="auto",
                message="Continue",
            )
            updated = handoff_store.attach_target_job(root, record["id"], "target-job", "claude1")
            self.assertEqual(updated["target_job_id"], "target-job")
            self.assertEqual(updated["target_worker"], "claude1")
            self.assertEqual(handoff_store.load(root, record["id"])["target_job_id"], "target-job")

    def test_prepare_handoff_record_includes_bounded_project_memory(self):
        source = {
            "id": "terminal",
            "worker": "codex1",
            "cwd": ".",
            "state": "done",
            "label": "source",
        }
        result = {
            "final_message": "Implemented feature",
            "git_status": [" M app.py"],
            "diffstat": "1 file changed",
            "transcript": "transcript.md",
        }
        created = {
            "id": "handoff-test",
            "message": "Review",
            "memory_context": "ctx",
        }
        with patch.object(server, "failover_terminal_job_id", return_value="terminal"),              patch.object(server, "read_meta", return_value=source),              patch.object(server, "job_result", return_value=result),              patch.object(server.project_memory, "context_pack", return_value={"text": "project context"}) as memory,              patch.object(server.handoff_store, "create", return_value=created) as create:
            record, source_out, terminal = server.prepare_handoff_record(
                "root",
                "claude1",
                {
                    "message": "Review",
                    "objective": "Validate implementation",
                    "constraints": ["read-only"],
                    "acceptance_criteria": ["tests pass"],
                    "artifacts": ["app.py"],
                    "include_project_memory": True,
                    "memory_max_chars": 4500,
                },
            )
        self.assertEqual(record, created)
        self.assertEqual(source_out, source)
        self.assertEqual(terminal, "terminal")
        memory.assert_called_once()
        kwargs = create.call_args.kwargs
        self.assertEqual(kwargs["memory_context"], "project context")
        self.assertIn("Source transcript: transcript.md", kwargs["artifacts"])
        self.assertIn("Workspace: .", kwargs["artifacts"])

    def test_mcp_structured_handoff_tools_are_namespaced(self):
        names = {tool["name"] for tool in server.mcp_tools(include_legacy=False)}
        for name in ("teamyra.job_handoff", "teamyra.handoff_get", "teamyra.handoff_list"):
            self.assertIn(name, names)

    def test_optional_handoff_memory_persistence_is_non_blocking(self):
        source = {
            "id": "terminal",
            "worker": "codex1",
            "cwd": ".",
            "label": "source",
            "state": "done",
        }
        record = {
            "id": "handoff-test",
            "label": "handoff source",
            "message": "Review",
            "project_path": ".",
        }
        with patch.object(server, "failover_terminal_job_id", return_value="terminal"),              patch.object(server, "read_meta", return_value=source),              patch.object(server, "chain_is_complete", return_value=True),              patch.object(server, "pick_worker", return_value="claude1"),              patch.object(server, "prepare_handoff_record", return_value=(record, source, "terminal")),              patch.object(server, "handoff_task", return_value="prompt"),              patch.object(server, "start_job", return_value=("target-job", "claude1")),              patch.object(server.handoff_store, "attach_target_job", return_value={**record, "target_job_id": "target-job", "target_worker": "claude1"}),              patch.object(server.handoff_store, "save") as save,              patch.object(server.handoff_store, "summary", return_value={"id": "handoff-test"}),              patch.object(server.project_memory, "add", return_value={"id": "mem-handoff"}) as memory_add,              patch.object(server, "patch_job_meta") as patch_meta,              patch.object(server, "follow_info", return_value={}):
            result = server.tool_call("job_handoff", {
                "job_id": "source-root",
                "message": "Review",
                "persist_memory": True,
            })
        self.assertEqual(result["memory_entry_id"], "mem-handoff")
        memory_add.assert_called_once()
        save.assert_called_once()
        self.assertEqual(patch_meta.call_args.kwargs["handoff_id"], "handoff-test")

    def test_handoff_get_and_list_delegate_to_store(self):
        with patch.object(server.handoff_store, "load", return_value={"id": "handoff-1"}) as load:
            self.assertEqual(server.tool_call("handoff_get", {"handoff_id": "handoff-1"})["id"], "handoff-1")
            load.assert_called_once_with(server.ROOT, "handoff-1")
        with patch.object(server.handoff_store, "list_records", return_value={"items": []}) as listing:
            result = server.tool_call("handoff_list", {
                "project_path": "P",
                "source_job_id": "source",
                "target_worker": "claude1",
                "limit": 7,
            })
            self.assertEqual(result, {"items": []})
            listing.assert_called_once_with(server.ROOT, "P", "source", "claude1", 7)


if __name__ == "__main__":
    unittest.main()
