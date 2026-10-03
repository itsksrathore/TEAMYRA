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
        cls.chatgpt_provider = (ROOT / "apps" / "desktop" / "src" / "chatgpt-web-provider.js").read_text(encoding="utf-8")
        cls.chatgpt_session = (ROOT / "apps" / "desktop" / "src" / "chatgpt-session-manager.js").read_text(encoding="utf-8")
        cls.chatgpt_automation = (ROOT / "apps" / "desktop" / "src" / "chatgpt-automation-adapter.js").read_text(encoding="utf-8")


    def test_chatgpt_renderer_ids_and_ipc_contract_exist(self):
        ids = [
            "navChatgpt", "chatgptView", "chatgptViewport", "chatgptConnection",
            "chatgptAccount", "chatgptBridge", "chatgptTools", "chatgptWorkspace",
            "chatgptOpen", "chatgptNew", "chatgptReload", "chatgptStop",
            "chatgptReconnect", "chatgptSelectWorkspace", "chatgptSavePermissions",
            "chatgptViewChanges", "chatgptViewDiff", "chatgptRevert",
        ]
        for element_id in ids:
            self.assertIn(f'id="{element_id}"', self.html, element_id)
            self.assertIn(f"#{element_id}", self.renderer, element_id)

        contracts = {
            "chatgptStatus": "teamyra:chatgpt-status",
            "openChatgpt": "teamyra:chatgpt-open",
            "reloadChatgpt": "teamyra:chatgpt-reload",
            "newChatgptChat": "teamyra:chatgpt-new-chat",
            "stopChatgpt": "teamyra:chatgpt-stop",
            "setChatgptBounds": "teamyra:chatgpt-bounds",
            "selectChatgptWorkspace": "teamyra:chatgpt-select-workspace",
            "chatgptChanges": "teamyra:chatgpt-changes",
            "revertChatgptChanges": "teamyra:chatgpt-revert",
        }
        for method, channel in contracts.items():
            self.assertRegex(self.preload, rf"\b{re.escape(method)}\s*:")
            self.assertIn(channel, self.preload)
            self.assertIn(channel, self.main)

    def test_chatgpt_uses_persistent_sandboxed_webcontentsview(self):
        self.assertIn("WebContentsView", self.chatgpt_provider)
        self.assertIn("persist:teamyra-chatgpt-profile", self.chatgpt_session)
        self.assertIn("nodeIntegration: false", self.chatgpt_provider)
        self.assertIn("contextIsolation: true", self.chatgpt_provider)
        self.assertIn("sandbox: true", self.chatgpt_provider)
        self.assertIn("setWindowOpenHandler", self.chatgpt_provider)
        self.assertNotIn("shell.openExternal", self.chatgpt_provider)

    def test_chatgpt_automation_is_semantic_not_coordinate_based(self):
        self.assertIn("data-testid", self.chatgpt_automation)
        self.assertIn("aria-label", self.chatgpt_automation)
        self.assertIn("contenteditable", self.chatgpt_automation)
        self.assertNotIn("robotjs", self.chatgpt_automation)
        self.assertNotIn("screenX", self.chatgpt_automation)
        self.assertNotIn("screenY", self.chatgpt_automation)

    def test_worktree_renderer_ids_exist_in_html(self):
        ids = [
            "navCommand", "navWorktrees", "commandView", "worktreesView",
            "worktreeList", "wtTitle", "wtState", "wtMeta", "wtSummary",
            "wtDiff", "wtRebase", "wtMerge", "wtDiscard", "wtForceDiscard",
            "wtOpenTerminal", "createWorktree", "refreshWorktrees",
            "wtManaged", "wtDirty", "wtConflicts", "wtConflictPanel",
            "wtConflictFiles", "wtConflictCount", "wtConflictPath", "wtConflictEditor",
            "wtUseTarget", "wtUseWorktree", "wtSaveConflict", "wtContinueConflict", "wtAbortConflict",
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

    def test_observability_ignores_stale_timeline_responses(self):
        self.assertIn("observabilityTimelineRequestId", self.renderer)
        self.assertIn("timelineRequestId === observabilityTimelineRequestId", self.renderer)

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

    def test_observability_supports_handoff_timeline_source(self):
        self.assertIn('<option value="handoff">Handoffs</option>', self.html)
        styles = (ROOT / "apps" / "desktop" / "renderer" / "styles.css").read_text(encoding="utf-8")
        self.assertIn(".timeline-dot.handoff", styles)
        self.assertIn(".timeline-source.handoff", styles)

    def test_observability_usage_reuses_cached_provider_state(self):
        self.assertIn("PROVIDER_CACHE_MS", self.main)
        self.assertIn("providersCached(false)", self.main)
        self.assertIn("mergeUsageProviderState", self.main)
        self.assertIn("workerIdForProfile", self.main)
        self.assertIn("'claude1'", self.main)
        self.assertIn("'codex1'", self.main)
        self.assertIn("'codex2'", self.main)
        self.assertIn("'antigravity'", self.main)

    def test_memory_renderer_ids_exist_in_html(self):
        ids = [
            "navMemory", "memoryView", "memoryProject", "loadMemory",
            "memorySearch", "memoryKindFilter", "memoryStatusFilter",
            "memoryNew", "memoryContext", "memoryList", "memoryForm",
            "memoryKind", "memoryImportance", "memoryTitle", "memoryTags",
            "memoryContent", "memoryMeta", "memoryArchive", "memoryReset",
            "memorySave", "memoryContextPreview", "memoryContextClose",
            "memoryEditorTitle", "memoryEditorState",
        ]
        for element_id in ids:
            self.assertIn(f'id="{element_id}"', self.html, element_id)
            self.assertIn(f"#{element_id}", self.renderer, element_id)

    def test_memory_preload_api_matches_main_ipc_handlers(self):
        contracts = {
            "memoryList": "teamyra:memory-list",
            "memorySearch": "teamyra:memory-search",
            "memoryGet": "teamyra:memory-get",
            "memoryAdd": "teamyra:memory-add",
            "memoryUpdate": "teamyra:memory-update",
            "memoryArchive": "teamyra:memory-archive",
            "memoryContext": "teamyra:memory-context",
        }
        for method, channel in contracts.items():
            self.assertRegex(self.preload, rf"\b{re.escape(method)}\s*:")
            self.assertIn(channel, self.preload)
            self.assertIn(channel, self.main)

        desktop_api = (ROOT / "bridge" / "desktop_api.py").read_text(encoding="utf-8")
        for action in (
            "memory.list", "memory.search", "memory.get", "memory.add",
            "memory.update", "memory.archive", "memory.context",
        ):
            self.assertIn(action, desktop_api)

    def test_memory_renderer_uses_textcontent_for_dynamic_entry_fields(self):
        self.assertIn("title.textContent = item.title", self.renderer)
        self.assertIn("tags.textContent =", self.renderer)
        self.assertIn("memoryContentEl.value = item.content", self.renderer)
        self.assertNotIn("memoryListEl.innerHTML = items.map", self.renderer)

    def test_memory_is_runtime_only_and_archives_instead_of_deleting(self):
        gitignore = (ROOT / ".gitignore").read_text(encoding="utf-8")
        self.assertRegex(gitignore, r"(?m)^memory/$")
        self.assertIn("Archive this memory entry?", self.renderer)
        self.assertNotIn("teamyra:memory-delete", self.main)
        self.assertNotIn("memoryDelete:", self.preload)

    def test_auto_update_preload_and_main_contract(self):
        contracts = {
            "updateStatus": "teamyra:update-status",
            "checkUpdates": "teamyra:update-check",
            "installUpdate": "teamyra:update-install",
            "onUpdateState": "teamyra:update-state",
        }
        for method, channel in contracts.items():
            self.assertRegex(self.preload, rf"\b{re.escape(method)}\s*:")
            self.assertIn(channel, self.preload)
            self.assertIn(channel, self.main)
        self.assertIn("autoUpdater.autoDownload = true", self.main)
        self.assertIn("autoUpdater.autoInstallOnAppQuit = true", self.main)
        self.assertIn("setupAutoUpdates();", self.main)

    def test_packaged_core_does_not_silently_fall_back_to_python(self):
        self.assertIn("Bundled TEAMYRA Core is missing", self.core_api)
        self.assertIn("process.env.TEAMYRA_CORE_EXE", self.core_api)

    def test_preload_worktree_api_matches_main_ipc_handlers(self):
        contracts = {
            "worktrees": "teamyra:worktrees",
            "worktreeStatus": "teamyra:worktree-status",
            "worktreeDiff": "teamyra:worktree-diff",
            "createWorktree": "teamyra:worktree-create",
            "rebaseWorktree": "teamyra:worktree-rebase",
            "beginConflictResolution": "teamyra:conflict-begin",
            "conflictDetail": "teamyra:conflict-detail",
            "resolveConflict": "teamyra:conflict-resolve",
            "continueConflictResolution": "teamyra:conflict-continue",
            "abortConflictResolution": "teamyra:conflict-abort",
            "mergeWorktree": "teamyra:worktree-merge",
            "discardWorktree": "teamyra:worktree-discard",
        }
        for method, channel in contracts.items():
            self.assertRegex(self.preload, rf"\b{re.escape(method)}\s*:")
            self.assertIn(channel, self.preload)
            self.assertIn(channel, self.main)

    def test_conflict_editor_blocks_manual_save_for_clipped_content(self):
        self.assertIn("detail.binary === true || detail.clipped === true", self.renderer)
        self.assertIn("Conflict content is too large for safe manual editing here", self.renderer)

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
