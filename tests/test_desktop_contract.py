import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class DesktopContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.html = (ROOT / "apps" / "desktop" / "renderer" / "index.html").read_text(encoding="utf-8")
        cls.renderer = (ROOT / "apps" / "desktop" / "renderer" / "app.mjs").read_text(encoding="utf-8")
        cls.styles = (ROOT / "apps" / "desktop" / "renderer" / "styles.css").read_text(encoding="utf-8")
        cls.preload = (ROOT / "apps" / "desktop" / "src" / "preload.js").read_text(encoding="utf-8")
        cls.main = (ROOT / "apps" / "desktop" / "src" / "main.js").read_text(encoding="utf-8")
        cls.core_api = (ROOT / "apps" / "desktop" / "src" / "core-api.js").read_text(encoding="utf-8")
        cls.desktop_api = (ROOT / "bridge" / "desktop_api.py").read_text(encoding="utf-8")
        cls.chatgpt_provider = (ROOT / "apps" / "desktop" / "src" / "chatgpt-web-provider.js").read_text(encoding="utf-8")
        cls.chatgpt_session = (ROOT / "apps" / "desktop" / "src" / "chatgpt-session-manager.js").read_text(encoding="utf-8")
        cls.chatgpt_automation = (ROOT / "apps" / "desktop" / "src" / "chatgpt-automation-adapter.js").read_text(encoding="utf-8")

    def test_primary_ui_has_only_tasks_and_agents_navigation(self):
        self.assertIn('id="navTasks"', self.html)
        self.assertIn('id="navAgents"', self.html)
        self.assertEqual(len(re.findall(r'data-view="(?:tasks|agents)"', self.html)), 2)
        for removed in (
            "navCommand", "navWorktrees", "navObservability", "navMemory",
            "commandView", "worktreesView", "observabilityView", "memoryView",
        ):
            self.assertNotIn(f'id="{removed}"', self.html)

    def test_tasks_surface_is_minimal_live_tile_desk(self):
        for element_id in (
            "tasksView", "taskDesk", "newTask", "filterActive", "filterAll",
            "newTaskDialog", "taskPrompt", "taskWorkspacePick", "taskAgent", "taskStart",
        ):
            self.assertIn(f'id="{element_id}"', self.html)
            self.assertIn(f"#{element_id}", self.renderer)
        self.assertIn("task-card", self.renderer)
        self.assertIn("data-task-output", self.renderer)
        self.assertIn("data-cancel-job", self.renderer)
        self.assertNotIn("Agents detected", self.html)
        self.assertNotIn("Recent jobs", self.html)

    def test_task_start_cancel_reuse_core_job_system(self):
        contracts = {
            "startTask": "teamyra:task-start",
            "cancelTask": "teamyra:task-cancel",
            "pickProject": "teamyra:pick-project",
        }
        for method, channel in contracts.items():
            self.assertRegex(self.preload, rf"\b{re.escape(method)}\s*:")
            self.assertIn(channel, self.preload)
            self.assertIn(channel, self.main)
        self.assertIn('action == "task.start"', self.desktop_api)
        self.assertIn("server.start_job(", self.desktop_api)
        self.assertIn('action == "task.cancel"', self.desktop_api)
        self.assertIn("server.failover_terminal_job_id", self.desktop_api)

    def test_agents_surface_is_connection_shelf_not_settings_dashboard(self):
        for element_id in ("agentsView", "agentsShelf", "agentGrid", "agentSummary"):
            self.assertIn(f'id="{element_id}"', self.html)
        self.assertIn("agent-card", self.renderer)
        self.assertIn("profile-row", self.renderer)
        self.assertIn("window.teamyra.addAccount", self.renderer)
        self.assertIn("window.teamyra.openTerminal", self.renderer)
        self.assertNotIn("Model override", self.html)
        self.assertNotIn("Effort override", self.html)
        self.assertNotIn("Priority", self.html)

    def test_glass_design_language_is_present(self):
        for marker in (
            "--accent: #ef6461",
            "backdrop-filter: blur(30px)",
            "border-radius: 999px",
            ".task-card",
            ".agent-card",
            "radial-gradient(52% 44% at 12% 6%",
        ):
            self.assertIn(marker, self.styles)
        self.assertIn("Portions of this visual language are adapted from Nami", self.styles)
        self.assertIn("Copyright 2026 Dainami Pte Ltd, licensed under Apache-2.0", self.styles)

    def test_chatgpt_is_nested_under_agents_and_keeps_core_controls(self):
        ids = [
            "chatgptDetail", "chatgptViewport", "chatgptBack", "chatgptOpen",
            "chatgptWorkspaceButton", "chatgptTools", "chatgptNew", "chatgptReload",
            "chatgptStop", "chatgptToolsDialog", "chatgptSavePermissions",
            "chatgptViewChanges",
        ]
        for element_id in ids:
            self.assertIn(f'id="{element_id}"', self.html)
            self.assertIn(f"#{element_id}", self.renderer)
        self.assertIn("setChatgptVisible", self.renderer)
        self.assertIn("setChatgptBounds", self.renderer)

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

    def test_chatgpt_tools_stay_secondary_and_safe_by_default(self):
        self.assertIn('id="chatgptPermTerminal" type="checkbox"', self.html)
        self.assertNotIn('id="chatgptPermTerminal" type="checkbox" checked', self.html)
        self.assertIn("outside_workspace: false", self.renderer)
        self.assertIn("destructive_without_confirmation: false", self.renderer)
        tools = (ROOT / "bridge" / "workspace_tools.py").read_text(encoding="utf-8")
        self.assertIn('"terminal": False', tools)
        self.assertIn('if not inside:', tools)

    def test_advanced_backend_capabilities_remain_available_without_primary_pages(self):
        ipc_contracts = {
            "timeline": "teamyra:timeline",
            "searchLogs": "teamyra:logs-search",
            "usage": "teamyra:usage",
            "memoryList": "teamyra:memory-list",
            "worktrees": "teamyra:worktrees",
            "beginConflictResolution": "teamyra:conflict-begin",
            "resolveConflict": "teamyra:conflict-resolve",
            "mergeWorktree": "teamyra:worktree-merge",
        }
        for method, channel in ipc_contracts.items():
            self.assertRegex(self.preload, rf"\b{re.escape(method)}\s*:")
            self.assertIn(channel, self.preload)
            self.assertIn(channel, self.main)

        for action in (
            "observability.timeline", "observability.search", "observability.usage",
            "memory.list", "memory.search", "memory.get", "memory.add",
            "memory.update", "memory.archive", "memory.context",
            "worktree.list", "worktree.status", "worktree.diff",
            "worktree.conflict.begin", "worktree.conflict.resolve",
        ):
            self.assertIn(action, self.desktop_api)

    def test_destructive_worktree_ipc_still_requires_confirmation(self):
        self.assertIn("Rebase requires explicit confirmation", self.main)
        self.assertIn("Merge requires explicit confirmation", self.main)
        self.assertIn("Discard requires explicit confirmation", self.main)
        self.assertIn('worktree.rebase requires confirm=true', self.desktop_api)
        self.assertIn('worktree.merge requires confirm=true', self.desktop_api)
        self.assertIn('worktree.discard requires confirm=true', self.desktop_api)

    def test_auto_update_contract_is_preserved(self):
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

    def test_packaged_core_does_not_silently_fall_back_to_python(self):
        self.assertIn("Bundled TEAMYRA Core is missing", self.core_api)
        self.assertIn("process.env.TEAMYRA_CORE_EXE", self.core_api)

    def test_core_client_uses_execfile_not_shell_exec(self):
        self.assertIn("execFile(", self.core_api)
        self.assertNotIn("execSync(", self.core_api)
        self.assertNotIn("shell: true", self.core_api)


if __name__ == "__main__":
    unittest.main()
