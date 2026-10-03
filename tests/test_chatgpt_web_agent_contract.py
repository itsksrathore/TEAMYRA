import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class ChatGPTWebAgentContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.provider = (ROOT / "apps" / "desktop" / "src" / "chatgpt-web-provider.js").read_text(encoding="utf-8")
        cls.session = (ROOT / "apps" / "desktop" / "src" / "chatgpt-session-manager.js").read_text(encoding="utf-8")
        cls.automation = (ROOT / "apps" / "desktop" / "src" / "chatgpt-automation-adapter.js").read_text(encoding="utf-8")
        cls.workspace = (ROOT / "bridge" / "workspace_tools.py").read_text(encoding="utf-8")
        cls.workspace_bridge = (ROOT / "apps" / "desktop" / "src" / "workspace-bridge.js").read_text(encoding="utf-8")
        cls.desktop_api = (ROOT / "bridge" / "desktop_api.py").read_text(encoding="utf-8")
        cls.server = (ROOT / "bridge" / "server.py").read_text(encoding="utf-8")
        cls.gitignore = (ROOT / ".gitignore").read_text(encoding="utf-8")

    def test_web_agent_does_not_use_openai_api(self):
        joined = "\n".join((self.provider, self.session, self.automation))
        self.assertNotIn("api.openai.com", joined)
        self.assertNotIn("OPENAI_API_KEY", joined)
        self.assertNotIn("Authorization: Bearer", joined)
        self.assertIn("https://chatgpt.com/", self.provider)

    def test_no_external_browser_launch_path(self):
        joined = "\n".join((self.provider, self.automation))
        self.assertNotIn("shell.openExternal", joined)
        self.assertNotIn("child_process", joined)
        self.assertIn("setWindowOpenHandler", self.provider)
        self.assertIn("action: 'deny'", self.provider)

    def test_auth_popups_stay_inside_teamyra(self):
        self.assertIn("createEmbeddedPopup", self.provider)
        self.assertIn("createWindow: options => this.createEmbeddedPopup(options)", self.provider)
        self.assertIn("new WebContentsView", self.provider)
        self.assertNotIn("new BrowserWindow", self.provider)

    def test_persistent_session_is_dedicated(self):
        self.assertIn("persist:teamyra-chatgpt-profile", self.session)
        self.assertIn("session.fromPartition", self.session)
        self.assertIn("setPermissionCheckHandler", self.session)
        self.assertIn("setPermissionRequestHandler", self.session)
        self.assertIn("will-download", self.session)
        self.assertIn("item.cancel()", self.session)

    def test_workspace_tools_are_shared_with_mcp(self):
        self.assertIn('"workspace_tool"', self.server)
        self.assertIn("WorkspaceToolService", self.server)
        self.assertIn("execute_in_workspace", self.server)

    def test_mcp_workspace_tool_cannot_self_confirm_destructive_actions(self):
        workspace_tool_block = self.server.split('if name == "workspace_tool":', 1)[1].split('if name == "memory_add":', 1)[0]
        self.assertIn('permissions={"terminal": True}', workspace_tool_block)
        self.assertIn("confirm=False", workspace_tool_block)
        self.assertNotIn('a.get("confirm")', workspace_tool_block)

    def test_sensitive_roots_and_confirmation_gates_exist(self):
        for marker in (
            '".ssh"', '".aws"', '".azure"', '".codex"', '".claude"', '".gemini"',
            '"Chrome"', '"Edge"', '"Firefox"', '"TEAMYRA_LOCAL_AGENT_TOKEN_FILE"',
            '"git.restore"', '"filesystem.delete"',
        ):
            self.assertIn(marker, self.workspace)
        self.assertIn("destructive operation requires explicit confirmation", self.workspace)

    def test_local_bridge_token_is_not_sent_in_process_argv_payload(self):
        self.assertNotIn("bridge_token: this.token", self.workspace_bridge)
        self.assertIn("TEAMYRA_LOCAL_AGENT_TOKEN", self.workspace_bridge)
        self.assertIn("TEAMYRA_LOCAL_AGENT_TOKEN", self.desktop_api)

    def test_git_internals_are_not_exposed_through_filesystem_tools(self):
        self.assertIn('relative.parts[0].lower() == ".git"', self.workspace)
        self.assertIn("direct filesystem access to Git internals is blocked", self.workspace)

    def test_runtime_state_and_backups_are_gitignored(self):
        self.assertIn("chatgpt/", self.gitignore)
        self.assertIn("backups/", self.gitignore)

    def test_worker_is_desktop_backed_not_fake_cli(self):
        self.assertIn('provider == "chatgpt-web"', self.server)
        self.assertIn('state="waiting_for_desktop"', self.server)
        self.assertIn("queued for embedded ChatGPT", self.server)

    def test_automation_protocol_is_bounded(self):
        self.assertIn("TEAMYRA_TOOL_REQUEST", self.automation)
        self.assertIn("TEAMYRA_CANCELLED", self.automation)
        self.assertIn("Array.isArray(data.args)", self.automation)
        self.assertIn("for (let step = 0; step < 16; step += 1)", self.provider)
        self.assertIn("MAX_TOOL_RESULT_CHARS", self.provider)
        self.assertIn("next_offset", self.provider)
        self.assertIn("before-input-event", self.provider)
        self.assertIn("pointer-events: none", self.provider)
        self.assertIn("activeJobDir", self.provider)
        self.assertIn("'CANCEL'", self.provider)


if __name__ == "__main__":
    unittest.main()
