import os
import tempfile
import unittest
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "bridge"))

from runtime_paths import agy_launch, claude_launch, codex_launch, find_codex_js, find_node, share_codex_sandbox


class RuntimePathTests(unittest.TestCase):
    def test_explicit_codex_binary_wins(self):
        env = {"TEAMYRA_CODEX": r"C:\tools\codex.cmd"}
        self.assertEqual(codex_launch(env=env, home=Path("C:/Users/Test")), [r"C:\tools\codex.cmd"])

    def test_explicit_node_and_codex_js_build_pair(self):
        env = {
            "TEAMYRA_NODE": r"C:\node\node.exe",
            "TEAMYRA_CODEX_JS": r"C:\codex\codex.js",
        }
        self.assertEqual(
            codex_launch(env=env, home=Path("C:/Users/Test")),
            [r"C:\node\node.exe", r"C:\codex\codex.js"],
        )

    def test_explicit_antigravity_binary_wins(self):
        env = {"TEAMYRA_AGY": r"C:\tools\agy.exe"}
        self.assertEqual(agy_launch(env=env, home=Path("C:/Users/Test")), [r"C:\tools\agy.exe"])

    def test_explicit_claude_binary_wins(self):
        env = {"TEAMYRA_CLAUDE": r"C:\\tools\\claude.exe"}
        self.assertEqual(claude_launch(env=env, home=Path("C:/Users/Test")), [r"C:\\tools\\claude.exe"])

    def test_appdata_codex_js_candidate(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            script = root / "npm" / "node_modules" / "@openai" / "codex" / "bin" / "codex.js"
            script.parent.mkdir(parents=True)
            script.write_text("// test", encoding="utf-8")
            found = find_codex_js(env={"APPDATA": str(root)}, home=root / "home")
            self.assertEqual(Path(found), script)


    @unittest.skipUnless(os.name == "nt", "Codex's elevated sandbox is Windows-only")
    def test_extra_codex_home_shares_the_sandbox_setup(self):
        with tempfile.TemporaryDirectory() as td:
            primary, extra = Path(td) / "main", Path(td) / "codex2"
            (primary / ".sandbox").mkdir(parents=True)
            (primary / ".sandbox" / "setup_marker.json").write_text("{}", encoding="utf-8")
            (primary / ".sandbox-secrets").mkdir()
            (primary / ".sandbox-secrets" / "users.json").write_text("main", encoding="utf-8")
            (extra / ".sandbox-secrets").mkdir(parents=True)
            (extra / ".sandbox-secrets" / "users.json").write_text("stale", encoding="utf-8")

            shared = share_codex_sandbox(extra, primary=primary)
            self.assertEqual(sorted(shared), [".sandbox", ".sandbox-secrets"])
            self.assertEqual((extra / ".sandbox-secrets" / "users.json").read_text(encoding="utf-8"), "main")
            backups = [item.name for item in extra.iterdir() if item.name.startswith(".sandbox-secrets.local-")]
            self.assertEqual(len(backups), 1, "the account's own copy is kept aside, not deleted")
            self.assertEqual(share_codex_sandbox(extra, primary=primary), [], "already shared")
            self.assertEqual(share_codex_sandbox(primary, primary=primary), [], "the main home is left alone")
            for name in shared:  # junctions must not take the target with them in cleanup
                os.rmdir(extra / name)

    def test_unprovisioned_main_home_shares_nothing(self):
        with tempfile.TemporaryDirectory() as td:
            primary, extra = Path(td) / "main", Path(td) / "codex2"
            primary.mkdir()
            extra.mkdir()
            self.assertEqual(share_codex_sandbox(extra, primary=primary), [])


if __name__ == "__main__":
    unittest.main()
