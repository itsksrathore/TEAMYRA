import json
import tempfile
import unittest
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "bridge"))

import project_memory
import server


class ProjectMemoryTests(unittest.TestCase):
    def test_add_get_update_and_archive(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            project = root / "project"
            project.mkdir()

            created = project_memory.add(
                root,
                project,
                "decision",
                "Use worktrees",
                "Parallel write tasks must use isolated worktrees.",
                tags=["git", "parallel", "Git"],
                importance="high",
                source_job_id="job-1",
            )
            self.assertTrue(created["id"].startswith("mem-"))
            self.assertEqual(created["kind"], "decision")
            self.assertEqual(created["tags"], ["git", "parallel"])
            self.assertEqual(created["importance"], "high")

            fetched = project_memory.get(root, project, created["id"])
            self.assertEqual(fetched["content"], "Parallel write tasks must use isolated worktrees.")
            self.assertEqual(fetched["source_job_id"], "job-1")

            updated = project_memory.update(
                root,
                project,
                created["id"],
                title="Use managed worktrees",
                content="All parallel writes use TEAMYRA-managed worktrees.",
                tags=["git", "isolation"],
                importance="critical",
                kind="architecture",
            )
            self.assertEqual(updated["title"], "Use managed worktrees")
            self.assertEqual(updated["kind"], "architecture")
            self.assertEqual(updated["importance"], "critical")

            archived = project_memory.archive(root, project, created["id"], "superseded")
            self.assertEqual(archived["status"], "archived")
            self.assertEqual(archived["archive_reason"], "superseded")
            with self.assertRaisesRegex(ValueError, "archived memory cannot be updated"):
                project_memory.update(root, project, created["id"], title="nope")

    def test_project_namespaces_are_isolated(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            a = root / "a"
            b = root / "b"
            a.mkdir()
            b.mkdir()
            first = project_memory.add(root, a, "fact", "A only", "alpha")
            project_memory.add(root, b, "fact", "B only", "beta")

            listed_a = project_memory.list_entries(root, a, status="all")
            self.assertEqual(listed_a["total_matches"], 1)
            self.assertEqual(listed_a["items"][0]["id"], first["id"])
            with self.assertRaisesRegex(ValueError, "no such memory"):
                project_memory.get(root, b, first["id"])

    def test_search_scores_title_tags_and_content(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            project = root / "project"
            project.mkdir()

            title_hit = project_memory.add(
                root, project, "decision", "SQLite persistence", "Use a local database.",
                tags=["storage"],
            )
            tag_hit = project_memory.add(
                root, project, "note", "Database note", "Persistence note.",
                tags=["sqlite"],
            )
            content_hit = project_memory.add(
                root, project, "fact", "Storage engine", "SQLite supports local structured state.",
                tags=["db"],
            )
            project_memory.add(root, project, "fact", "Irrelevant", "Nothing related.")

            result = project_memory.search(root, project, "sqlite", limit=10)
            ids = [item["id"] for item in result["items"]]
            self.assertEqual(ids[0], title_hit["id"])
            self.assertIn(tag_hit["id"], ids)
            self.assertIn(content_hit["id"], ids)
            self.assertEqual(result["total_matches"], 3)

            filtered = project_memory.search(
                root, project, "sqlite", kinds=["fact"], tags=["db"], limit=10,
            )
            self.assertEqual([item["id"] for item in filtered["items"]], [content_hit["id"]])

    def test_list_filters_kind_status_tag_and_limit(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            project = root / "project"
            project.mkdir()

            first = project_memory.add(root, project, "decision", "One", "First", tags=["core"])
            second = project_memory.add(root, project, "decision", "Two", "Second", tags=["core"])
            project_memory.add(root, project, "note", "Note", "Third", tags=["misc"])
            project_memory.archive(root, project, first["id"])

            active = project_memory.list_entries(root, project, kind="decision", tag="core", limit=10)
            self.assertEqual(active["total_matches"], 1)
            self.assertEqual(active["items"][0]["id"], second["id"])

            all_rows = project_memory.list_entries(root, project, status="all", limit=2)
            self.assertEqual(all_rows["count"], 2)
            self.assertEqual(all_rows["total_matches"], 3)
            self.assertTrue(all_rows["clipped"])

    def test_context_pack_prioritizes_importance_and_is_bounded(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            project = root / "project"
            project.mkdir()

            low = project_memory.add(
                root, project, "note", "Low", "low context", importance="low",
            )
            critical = project_memory.add(
                root, project, "architecture", "Critical", "critical context", importance="critical",
            )
            project_memory.add(
                root, project, "fact", "Large", "x" * 6000, importance="high",
            )

            packed = project_memory.context_pack(root, project, max_chars=1200, limit=10)
            self.assertLessEqual(packed["chars"], 1200)
            self.assertEqual(packed["memory_ids"][0], critical["id"])
            self.assertIn("critical context", packed["text"])
            self.assertTrue(packed["clipped"])
            self.assertNotEqual(packed["memory_ids"][0], low["id"])

    def test_context_pack_query_uses_search_results(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            project = root / "project"
            project.mkdir()

            target = project_memory.add(
                root, project, "decision", "Routing policy", "Prefer idle Codex accounts.", tags=["routing"],
            )
            project_memory.add(root, project, "note", "UI", "Use dense cards.", tags=["design"])

            packed = project_memory.context_pack(root, project, query="routing", max_chars=3000)
            self.assertEqual(packed["memory_ids"], [target["id"]])
            self.assertIn("Routing policy", packed["text"])

    def test_validation_rejects_invalid_inputs(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            project = root / "project"
            project.mkdir()

            with self.assertRaisesRegex(ValueError, "kind must be"):
                project_memory.add(root, project, "secret", "x", "y")
            with self.assertRaisesRegex(ValueError, "title is required"):
                project_memory.add(root, project, "note", "", "content")
            with self.assertRaisesRegex(ValueError, "content is required"):
                project_memory.add(root, project, "note", "title", "")
            with self.assertRaisesRegex(ValueError, "query is required"):
                project_memory.search(root, project, "")
            with self.assertRaisesRegex(ValueError, "invalid memory id"):
                project_memory.get(root, project, "../../bad")

    def test_mcp_memory_tools_are_namespaced_and_route_to_core(self):
        names = {tool["name"] for tool in server.mcp_tools(include_legacy=False)}
        for name in (
            "teamyra.memory_add", "teamyra.memory_list", "teamyra.memory_search",
            "teamyra.memory_get", "teamyra.memory_update", "teamyra.memory_archive",
            "teamyra.memory_context",
        ):
            self.assertIn(name, names)

        with tempfile.TemporaryDirectory() as td:
            project = Path(td) / "project"
            project.mkdir()
            created = server.tool_call("memory_add", {
                "project_path": str(project),
                "kind": "decision",
                "title": "Use local memory",
                "content": "Keep project memory local.",
                "tags": ["memory"],
                "importance": "high",
            })
            listed = server.tool_call("memory_list", {
                "project_path": str(project),
                "status": "active",
                "limit": 10,
            })
            self.assertEqual(listed["items"][0]["id"], created["id"])
            packed = server.tool_call("memory_context", {
                "project_path": str(project),
                "query": "local memory",
                "max_chars": 2000,
            })
            self.assertIn(created["id"], packed["memory_ids"])

    def test_empty_project_path_is_rejected(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            with self.assertRaisesRegex(ValueError, "project_path is required"):
                project_memory.list_entries(root, "", status="all")
            with self.assertRaisesRegex(ValueError, "project_path is required"):
                project_memory.add(root, "", "note", "Title", "Content")

    def test_read_only_calls_do_not_create_memory_namespace(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            project = root / "project"
            project.mkdir()
            memory_root = root / "memory"
            self.assertFalse(memory_root.exists())

            listed = project_memory.list_entries(root, project, status="all")
            self.assertEqual(listed["items"], [])
            self.assertFalse(memory_root.exists())

            searched = project_memory.search(root, project, "missing")
            self.assertEqual(searched["items"], [])
            self.assertFalse(memory_root.exists())

            packed = project_memory.context_pack(root, project)
            self.assertEqual(packed["memory_ids"], [])
            self.assertFalse(memory_root.exists())

            with self.assertRaisesRegex(ValueError, "no such memory"):
                project_memory.get(root, project, "mem-missing")
            self.assertFalse(memory_root.exists())

    def test_runtime_files_live_under_ignored_memory_directory(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            project = root / "project"
            project.mkdir()
            created = project_memory.add(root, project, "note", "Persisted", "Local only")

            project_dir = root / "memory" / "projects" / project_memory.project_key(project)
            entry = project_dir / "entries" / f"{created['id']}.json"
            self.assertTrue(entry.exists())
            payload = json.loads(entry.read_text(encoding="utf-8"))
            self.assertEqual(payload["project_path"], str(project.resolve()))


if __name__ == "__main__":
    unittest.main()
