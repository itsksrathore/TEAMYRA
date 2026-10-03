import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class DesktopContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.html = (ROOT / "apps" / "desktop" / "renderer" / "index.html").read_text(encoding="utf-8")
        cls.renderer = (ROOT / "apps" / "desktop" / "renderer" / "app.mjs").read_text(encoding="utf-8")
        cls.preload = (ROOT / "apps" / "desktop" / "src" / "preload.js").read_text(encoding="utf-8")
        cls.main = (ROOT / "apps" / "desktop" / "src" / "main.js").read_text(encoding="utf-8")
        cls.core_api = (ROOT / "apps" / "desktop" / "src" / "core-api.js").read_text(encoding="utf-8")

    def test_worktree_renderer_ids_exist_in_html(self):
        ids = [
            "navCommand", "navWorktrees", "commandView", "worktreesView",
            "worktreeList", "wtTitle", "wtState", "wtMeta", "wtSummary",
            "wtDiff", "wtRebase", "wtMerge", "wtDiscard", "wtForceDiscard",
            "wtOpenTerminal", "createWorktree", "refreshWorktrees",
            "wtManaged", "wtDirty", "wtConflicts",
        ]
        for element_id in ids:
            self.assertIn(f'id="{element_id}"', self.html, element_id)
            self.assertIn(f"#{element_id}", self.renderer, element_id)

    def test_observability_renderer_ids_exist_in_html(self):
        ids = [
            "navObservability", "observabilityView",
            "obsWorkers", "obsReady", "obsRunning", "obsJobs",
            "usageCards", "timelineList", "obsProject", "obsWorker",
            "obsSource", "obsQuery", "refreshObservability",
            "logSearchForm", "logSearchQuery", "logSearchKind", "logSearchResults",
        ]
        for element_id in ids:
            self.assertIn(f'id="{element_id}"', self.html, element_id)
            self.assertIn(f"#{element_id}", self.renderer, element_id)

    def test_observability_does_not_treat_unknown_readiness_as_ready(self):
        self.assertIn("worker.ready === true", self.renderer)
        self.assertIn("'detected'", self.renderer)

    def test_observability_preload_api_matches_main_ipc_handlers(self):
        contracts = {
            "timeline": "teamyra:timeline",
            "searchLogs": "teamyra:logs-search",
            "usage": "teamyra:usage",
        }
        for method, channel in contracts.items():
            self.assertRegex(self.preload, rf"\b{re.escape(method)}\s*:")
            self.assertIn(channel, self.preload)
            self.assertIn(channel, self.main)

        desktop_api = (ROOT / "bridge" / "desktop_api.py").read_text(encoding="utf-8")
        for action in ("observability.timeline", "observability.search", "observability.usage"):
            self.assertIn(action, desktop_api)

    def test_observability_usage_reuses_cached_provider_state(self):
        self.assertIn("PROVIDER_CACHE_MS", self.main)
        self.assertIn("providersCached(false)", self.main)
        self.assertIn("mergeUsageProviderState", self.main)
        self.assertIn("workerIdForProfile", self.main)
        self.assertIn("'claude1'", self.main)
        self.assertIn("'codex1'", self.main)
        self.assertIn("'codex2'", self.main)
        self.assertIn("'antigravity'", self.main)

    def test_preload_worktree_api_matches_main_ipc_handlers(self):
        contracts = {
            "worktrees": "teamyra:worktrees",
            "worktreeStatus": "teamyra:worktree-status",
            "worktreeDiff": "teamyra:worktree-diff",
            "createWorktree": "teamyra:worktree-create",
            "rebaseWorktree": "teamyra:worktree-rebase",
            "mergeWorktree": "teamyra:worktree-merge",
            "discardWorktree": "teamyra:worktree-discard",
        }
        for method, channel in contracts.items():
            self.assertRegex(self.preload, rf"\b{re.escape(method)}\s*:")
            self.assertIn(channel, self.preload)
            self.assertIn(channel, self.main)

    def test_destructive_worktree_ipc_requires_confirmation_twice(self):
        self.assertIn("Rebase requires explicit confirmation", self.main)
        self.assertIn("Merge requires explicit confirmation", self.main)
        self.assertIn("Discard requires explicit confirmation", self.main)
        desktop_api = (ROOT / "bridge" / "desktop_api.py").read_text(encoding="utf-8")
        self.assertIn('worktree.rebase requires confirm=true', desktop_api)
        self.assertIn('worktree.merge requires confirm=true', desktop_api)
        self.assertIn('worktree.discard requires confirm=true', desktop_api)

    def test_core_client_uses_execfile_not_shell_exec(self):
        self.assertIn("execFile(", self.core_api)
        self.assertNotIn("execSync(", self.core_api)
        self.assertNotIn("shell: true", self.core_api)

    def test_force_discard_requires_typed_phrase_and_confirmation(self):
        self.assertIn("phrase !== 'DISCARD'", self.renderer)
        self.assertIn("Final confirmation: permanently force-discard", self.renderer)


if __name__ == "__main__":
    unittest.main()
