import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "bridge"))

import runtime_paths
from runtime_paths import claude_launch, claude_launch_info, find_claude

ORIGINAL_COMMAND_LINES = runtime_paths._command_lines


def touch(path, executable=True):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("@echo off\n", encoding="utf-8")
    if executable and os.name != "nt":
        path.chmod(0o755)
    return path


class ClaudeDiscoveryTests(unittest.TestCase):
    def setUp(self):
        self.td = tempfile.TemporaryDirectory()
        self.base = Path(self.td.name)
        self.home = self.base / "home"
        self.home.mkdir()
        self.empty_path = self.base / "empty-path"
        self.empty_path.mkdir()
        runtime_paths._COMMAND_CACHE.clear()
        self.commands = {}
        patcher = patch.object(runtime_paths, "_command_lines", side_effect=self.fake_command)
        self.command_mock = patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(self.td.cleanup)

    def fake_command(self, argv, env):
        key = Path(str(argv[0])).stem.lower()
        return self.commands.get(key, [])

    def env(self, **extra):
        return {"PATH": str(self.empty_path), **extra}

    def test_teamyra_claude_stays_first(self):
        touch(self.home / ".local" / "bin" / "claude.exe")
        env = self.env(TEAMYRA_CLAUDE=r"C:\tools\claude.exe")
        self.assertEqual(find_claude(env, self.home, windows=True), (r"C:\tools\claude.exe", "TEAMYRA_CLAUDE"))
        self.assertEqual(claude_launch(env=env, home=self.home), [r"C:\tools\claude.exe"])

    def test_path_lookup_prefers_launchable_pathext_variants(self):
        bin_dir = self.base / "bin"
        touch(bin_dir / "claude")  # npm's extensionless sh shim cannot be started on Windows
        cmd = touch(bin_dir / "claude.cmd")
        path, source = find_claude({"PATH": str(bin_dir)}, self.home, windows=True)
        self.assertEqual((Path(path).name.lower(), source), ("claude.cmd", "PATH"))
        self.assertEqual(Path(path).resolve(), cmd.resolve())

    def test_where_output_is_used_on_windows(self):
        exe = touch(self.base / "elsewhere" / "claude.exe")
        self.commands["where"] = [str(self.base / "elsewhere" / "claude"), str(exe)]
        self.assertEqual(find_claude(self.env(), self.home, windows=True), (str(exe), "where claude"))

    def test_npm_global_prefix_and_package_binary(self):
        npm_dir = self.base / "node"
        touch(npm_dir / ("npm.cmd" if os.name == "nt" else "npm"))
        prefix = self.base / "npm-prefix"
        package_exe = touch(prefix / "node_modules" / "@anthropic-ai" / "claude-code" / "bin" / "claude.exe")
        self.commands["npm"] = [str(prefix)]
        path, source = find_claude({"PATH": str(npm_dir)}, self.home, windows=True)
        self.assertEqual((path, source), (str(package_exe), "npm prefix -g"))

    def test_static_locations_in_documented_order(self):
        local = self.base / "local"
        appdata = self.base / "appdata"
        candidates = [
            (self.home / ".local" / "bin" / "claude.exe", ".local/bin"),
            (self.home / ".claude" / "local" / "claude.cmd", ".claude/local"),
            (local / "Programs" / "claude" / "claude.exe", "LOCALAPPDATA Programs"),
            (appdata / "npm" / "claude.cmd", "npm global"),
        ]
        env = self.env(LOCALAPPDATA=str(local), APPDATA=str(appdata))
        for path, source in candidates:
            touch(path)
            self.assertEqual(find_claude(env, self.home, windows=True), (str(path), source))

    def test_claude_desktop_bundled_cli_newest_version(self):
        appdata = self.base / "appdata"
        touch(appdata / "Claude" / "claude-code" / "2.1.9" / "aaa" / "claude.exe")
        newest = touch(appdata / "Claude" / "claude-code" / "2.1.10" / "bbb" / "claude.exe")
        info = claude_launch_info(self.env(APPDATA=str(appdata)), self.home, windows=True)
        self.assertEqual(info, {"argv": [str(newest)], "path": str(newest), "source": "Claude desktop bundled CLI"})

    def test_nothing_found_reports_empty(self):
        self.assertEqual(claude_launch_info(self.env(), self.home, windows=True),
                         {"argv": [], "path": None, "source": None})

    def test_command_lines_are_cached(self):
        runtime_paths._COMMAND_CACHE.clear()
        with patch.object(runtime_paths.subprocess, "run") as run:
            run.return_value.returncode = 0
            run.return_value.stdout = "C:\\npm\n"
            first = ORIGINAL_COMMAND_LINES(["npm", "prefix", "-g"], {"PATH": "x"})
            second = ORIGINAL_COMMAND_LINES(["npm", "prefix", "-g"], {"PATH": "x"})
        self.assertEqual(first, ["C:\\npm"])
        self.assertEqual(second, first)
        self.assertEqual(run.call_count, 1)


if __name__ == "__main__":
    unittest.main()
