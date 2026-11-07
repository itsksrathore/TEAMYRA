import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "bridge"))

from workspace_tools import (  # noqa: E402
    DEFAULT_PERMISSIONS,
    PERMISSION_BY_TOOL,
    WorkspaceToolService,
)

TOKEN = "x" * 64
CODE_TOOLS = ("code.map", "code.symbol")
JOBS_MARKER = "SECRET-JOBS-MARKER"
PROFILE_MARKER = "SECRET-PROFILES-MARKER"
CRED_MARKER = "SECRET-CREDENTIAL-MARKER"


class CodeIntelWorkspacePermissionTests(unittest.TestCase):
    """C-3 public contract: ``code.map`` and ``code.symbol`` must apply exactly
    the same permission key and path guards as ``filesystem.search``.

    The tests are written independently of the implementation and only use the
    public ``WorkspaceToolService`` execution path on synthetic temporary
    ROOT/workspace trees (no accounts, network, jobs or real cache).  When the
    C-3 registrations are missing from the snapshot, every test fails with an
    explicit WAITING_PARENT message instead of being skipped.
    """

    def setUp(self):
        self._temp = tempfile.TemporaryDirectory()
        self.base = Path(self._temp.name).resolve()
        self.root = self.base / "runtime"
        self.workspace = self.base / "project"
        src = self.workspace / "src"
        src.mkdir(parents=True)
        (src / "alpha.py").write_text(
            "def alpha_handler(value):\n    return value + 1\n", encoding="utf-8"
        )
        (src / "beta.py").write_text(
            "from alpha import alpha_handler\n\n\ndef beta_entry():\n    return alpha_handler(1)\n",
            encoding="utf-8",
        )
        # Protected runtime children of the fake ROOT.
        (self.root / "jobs").mkdir(parents=True)
        (self.root / "jobs" / "secret_job.py").write_text(
            "def leaky_secret():  # " + JOBS_MARKER + "\n    pass\n", encoding="utf-8"
        )
        (self.root / "profiles").mkdir()
        (self.root / "profiles" / "profile_data.py").write_text(
            "def protected_profile():  # " + PROFILE_MARKER + "\n    pass\n",
            encoding="utf-8",
        )
        # Credential-named file with a secret marker inside the workspace.
        (self.workspace / "credentials.json").write_text(
            '{"token": "' + CRED_MARKER + '"}\n', encoding="utf-8"
        )
        self.service = self._new_service()
        self.service.configure(self.workspace, token=TOKEN, actor="test")

    def tearDown(self):
        self._temp.cleanup()

    # -- helpers (never named ``run``) ---------------------------------
    def _new_service(self):
        service = WorkspaceToolService(self.root)
        service.state_root.mkdir(parents=True, exist_ok=True)
        service.token_file.write_text(TOKEN, encoding="utf-8")
        return service

    def require_code_tools(self):
        missing = [tool for tool in CODE_TOOLS if tool not in PERMISSION_BY_TOOL]
        if missing:
            self.fail(
                "WAITING_PARENT: C-3 registrations are missing from this snapshot ("
                + ", ".join(missing)
                + "); C-1/C-2/C-3 are not merged here yet"
            )

    def full_access(self, service=None):
        (service or self.service).set_access(
            {
                "full_access": True,
                "outside_workspace": True,
                "destructive_without_confirmation": False,
            },
            token=TOKEN,
            actor="user-test",
            user_confirmed=True,
        )

    def call_tool(self, tool, args, service=None):
        self.require_code_tools()
        return (service or self.service).execute(
            tool, args, token=TOKEN, actor="test"
        )

    @staticmethod
    def as_text(result):
        return json.dumps(result, ensure_ascii=False, default=str)

    # -- 1. same permission key and search gating ----------------------
    def test_code_tools_use_the_filesystem_search_permission_key(self):
        self.require_code_tools()
        self.assertEqual(PERMISSION_BY_TOOL.get("filesystem.search"), "search")
        for tool in CODE_TOOLS:
            self.assertEqual(PERMISSION_BY_TOOL.get(tool), "search", tool)
        self.assertTrue(set(PERMISSION_BY_TOOL.values()) <= set(DEFAULT_PERMISSIONS))

    def test_search_permission_false_denies_and_true_allows_even_when_read_differs(self):
        self.require_code_tools()
        calls = (
            ("code.map", {"path": "src"}),
            ("code.symbol", {"path": "src/alpha.py", "name": "alpha_handler"}),
        )
        # read stays on: search off must still deny both code tools.
        self.service.configure(self.workspace, {"search": False, "read": True}, token=TOKEN)
        for tool, args in calls:
            with self.subTest(tool=tool):
                with self.assertRaises(PermissionError):
                    self.service.execute(tool, args, token=TOKEN)
        # read off, search on: filesystem.read is denied but the code tools work.
        self.service.configure(self.workspace, {"search": True, "read": False}, token=TOKEN)
        with self.assertRaises(PermissionError):
            self.service.execute("filesystem.read", {"path": "src/alpha.py"}, token=TOKEN)
        mapping = self.call_tool("code.map", {"path": "src"})
        self.assertIn("alpha_handler", self.as_text(mapping))
        symbol = self.call_tool(
            "code.symbol", {"path": "src/alpha.py", "name": "alpha_handler"}
        )
        self.assertIn("alpha_handler", self.as_text(symbol))

    # -- 2. positives inside the workspace ------------------------------
    def test_code_map_lists_symbols_inside_workspace(self):
        text = self.as_text(self.call_tool("code.map", {"path": "src"}))
        self.assertIn("alpha_handler", text)
        self.assertIn("beta_entry", text)
        self.assertNotIn(JOBS_MARKER, text)
        self.assertNotIn(CRED_MARKER, text)

    def test_code_symbol_returns_definition_and_references_inside_workspace(self):
        text = self.as_text(
            self.call_tool(
                "code.symbol", {"path": "src/alpha.py", "name": "alpha_handler"}
            )
        )
        self.assertIn("alpha_handler", text)
        self.assertIn("return value + 1", text)
        self.assertNotIn(JOBS_MARKER, text)
        self.assertNotIn(PROFILE_MARKER, text)

    # -- 3. outside the selected workspace ------------------------------
    def test_outside_workspace_denied_without_outside_permission(self):
        outside = self.base / "outside"
        outside.mkdir()
        (outside / "other.py").write_text("def outside_fn():\n    pass\n", encoding="utf-8")
        cases = (
            ("code.map", {"path": str(outside)}),
            ("code.symbol", {"path": str(outside / "other.py"), "name": "outside_fn"}),
            ("code.map", {"path": "../outside"}),
        )
        for tool, args in cases:
            with self.subTest(tool=tool, path=args["path"]):
                with self.assertRaises(PermissionError):
                    self.call_tool(tool, args)

    # -- 4. protected runtime roots and credential files ----------------
    def test_protected_roots_and_credential_files_denied_even_with_full_access(self):
        self.full_access()
        cases = (
            ("code.map", {"path": str(self.root / "jobs")}),
            ("code.map", {"path": str(self.root / "profiles")}),
            ("code.symbol", {
                "path": str(self.root / "jobs" / "secret_job.py"),
                "name": "leaky_secret",
            }),
            ("code.symbol", {
                "path": str(self.root / "profiles" / "profile_data.py"),
                "name": "protected_profile",
            }),
            ("code.map", {"path": "credentials.json"}),
        )
        for tool, args in cases:
            with self.subTest(tool=tool, path=args["path"]):
                with self.assertRaises(PermissionError):
                    self.call_tool(tool, args)

    def test_workspace_as_fake_runtime_root_excludes_protected_children(self):
        # The workspace is the fake RuntimeRoot itself; protected children must
        # be filtered out before any read/cache/ref body is produced.
        (self.root / "app.py").write_text(
            "from secret_job import leaky_secret\n\n\ndef main():\n    return leaky_secret()\n",
            encoding="utf-8",
        )
        service = self._new_service()
        service.configure(self.root, token=TOKEN, actor="test")
        mapping = self.as_text(self.call_tool("code.map", {"path": "."}, service=service))
        self.assertIn("main", mapping)
        for hidden in (
            JOBS_MARKER, PROFILE_MARKER, "secret_job", "profile_data", "leaky_secret",
            "protected_profile", "local-agent.token", "workspace.json",
        ):
            self.assertNotIn(hidden, mapping)
        try:
            refs = self.as_text(
                self.call_tool("code.symbol", {"path": "app.py", "name": "leaky_secret"}, service=service)
            )
        except (PermissionError, LookupError, ValueError):
            return
        self.assertNotIn(JOBS_MARKER, refs)
        self.assertNotIn("def leaky_secret", refs)

    def test_cache_stays_inside_the_fake_runtime_root(self):
        self.require_code_tools()
        self.full_access()
        cache_dir = self.root / "cache"
        cache_dir.mkdir(parents=True, exist_ok=True)
        (cache_dir / "entry.py").write_text("def cached_index():\n    pass\n", encoding="utf-8")
        blocked = self.service._sensitive_roots(full_access=True)
        self.assertFalse(any(p == cache_dir.resolve() for p in blocked))
        text = self.as_text(self.call_tool("code.map", {"path": str(cache_dir)}))
        self.assertIn("cached_index", text)
        # Any code-intel cache that appeared must live under the fake ROOT.
        app_cache = Path.home() / ".teamyra"
        if (self.root / "cache" / "code-intel").exists():
            self.assertTrue(
                str((self.root / "cache" / "code-intel").resolve()).startswith(str(self.root))
            )
        self.assertNotIn(str(app_cache), text)

    # -- 5. trusted runtime is not overridable from tool args -----------
    def test_untrusted_root_and_cache_root_args_cannot_redirect_the_service(self):
        self.require_code_tools()
        attacker = self.base / "attacker"
        attacker.mkdir()
        args = {
            "path": "src",
            "root": str(attacker),
            "cache_root": str(attacker / "cache"),
            "workspace": str(attacker),
        }
        try:
            text = self.as_text(self.call_tool("code.map", dict(args)))
        except (PermissionError, LookupError, ValueError):
            text = ""
        self.assertEqual(self.service.root, self.root.resolve())
        self.assertEqual(list(attacker.iterdir()), [])
        if text:
            self.assertNotIn(str(attacker), text)

    # -- 6. link escape --------------------------------------------------
    def test_symlink_escape_out_of_workspace_is_not_followed(self):
        self.require_code_tools()
        outside = self.base / "outside"
        outside.mkdir()
        (outside / "leak.py").write_text("def leaked_outside():\n    pass\n", encoding="utf-8")
        link = self.workspace / "escape"
        try:
            os.symlink(outside, link, target_is_directory=True)
        except (OSError, NotImplementedError, AttributeError):
            self.skipTest("this OS cannot create symlinks/junctions for the escape check")
        try:
            text = self.as_text(self.call_tool("code.map", {"path": "."}))
            self.assertNotIn("leaked_outside", text)
            self.assertNotIn("leak.py", text)
            with self.assertRaises(PermissionError):
                self.call_tool("code.map", {"path": "escape"})
        finally:
            try:
                os.unlink(link)
            except OSError:
                pass


if __name__ == "__main__":
    unittest.main()
