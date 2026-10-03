import os
import tempfile
import unittest
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "bridge"))

from runtime_paths import agy_launch, codex_launch, find_codex_js, find_node


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

    def test_appdata_codex_js_candidate(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            script = root / "npm" / "node_modules" / "@openai" / "codex" / "bin" / "codex.js"
            script.parent.mkdir(parents=True)
            script.write_text("// test", encoding="utf-8")
            found = find_codex_js(env={"APPDATA": str(root)}, home=root / "home")
            self.assertEqual(Path(found), script)


if __name__ == "__main__":
    unittest.main()
