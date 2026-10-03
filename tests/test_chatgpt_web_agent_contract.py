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

    def test_persistent_session_is_dedicated(self):
        self.assertIn("persist:teamyra-chatgpt-profile", self.session)
        self.assertIn("session.fromPartition", self.session)

    def test_workspace_tools_are_shared_with_mcp(self):
        self.assertIn('"workspace_tool"', self.server)
        self.assertIn("WorkspaceToolService", self.server)
        self.assertIn("execute_in_workspace", self.server)

    def test_sensitive_roots_and_confirmation_gates_exist(self):
        for marker in (
            '".ssh"', '".aws"', '".azure"', '".codex"', '".claude"', '".gemini"',
            '"Chrome"', '"Edge"', '"Firefox"', '"TEAMYRA_LOCAL_AGENT_TOKEN_FILE"',
            '"git.restore"', '"filesystem.delete"',
        ):
            self.assertIn(marker, self.workspace)
        self.assertIn("destructive operation requires explicit confirmation", self.workspace)

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
        self.assertIn("for (let step = 0; step < 16; step += 1)", self.provider)


if __name__ == "__main__":
    unittest.main()
