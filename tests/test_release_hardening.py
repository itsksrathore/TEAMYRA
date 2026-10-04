import json
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class ReleaseHardeningTests(unittest.TestCase):
    def test_public_policy_files_exist(self):
        for relative in (
            "LICENSE",
            ".github/CONTRIBUTING.md",
            ".github/SECURITY.md",
            ".github/CODE_OF_CONDUCT.md",
            ".github/SUPPORT.md",
            "docs/CHANGELOG.md",
            ".github/pull_request_template.md",
            ".github/ISSUE_TEMPLATE/bug_report.yml",
            ".github/ISSUE_TEMPLATE/feature_request.yml",
            "docs/RELEASE_CHECKLIST.md",
            "docs/PROVIDER_CAPABILITIES.md",
        ):
            self.assertTrue((ROOT / relative).is_file(), relative)

    def test_packages_declare_mit_license(self):
        root_package = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
        desktop_package = json.loads(
            (ROOT / "apps" / "desktop" / "package.json").read_text(encoding="utf-8")
        )
        self.assertEqual(root_package.get("license"), "MIT")
        self.assertEqual(desktop_package.get("license"), "MIT")

    def test_brand_assets_and_windows_icon_are_wired(self):
        logo = ROOT / "apps" / "desktop" / "assets" / "teamyra-logo.png"
        icon = ROOT / "apps" / "desktop" / "assets" / "teamyra-icon.ico"
        self.assertTrue(logo.is_file())
        self.assertTrue(icon.is_file())
        html = (ROOT / "apps" / "desktop" / "renderer" / "index.html").read_text(encoding="utf-8")
        main = (ROOT / "apps" / "desktop" / "src" / "main.js").read_text(encoding="utf-8")
        desktop_package = json.loads(
            (ROOT / "apps" / "desktop" / "package.json").read_text(encoding="utf-8")
        )
        self.assertIn('src="../assets/teamyra-logo.png"', html)
        self.assertIn("teamyra-icon.ico", main)
        self.assertEqual(desktop_package["build"]["win"]["icon"], "assets/teamyra-icon.ico")
        self.assertEqual(desktop_package["build"]["nsis"]["installerIcon"], "assets/teamyra-icon.ico")
        self.assertEqual(desktop_package["build"]["nsis"]["uninstallerIcon"], "assets/teamyra-icon.ico")
        self.assertIn("assets/**/*", desktop_package["build"]["files"])
        resources = desktop_package["build"]["extraResources"]
        self.assertTrue(any(item.get("to") == "teamyra-icon.ico" for item in resources))
        self.assertIn("APP_ICON", main)
        self.assertIn("nativeImage", main)
        self.assertIn("win.setIcon(APP_ICON)", main)
        self.assertIn("win.setAppDetails({", main)
        self.assertIn("ensureWindowsShortcutIdentity();", main)

    def test_release_version_is_1_0_0(self):
        root_package = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
        desktop_package = json.loads(
            (ROOT / "apps" / "desktop" / "package.json").read_text(encoding="utf-8")
        )
        self.assertEqual(root_package.get("version"), "1.0.0")
        self.assertEqual(desktop_package.get("version"), "1.0.0")

    def test_stable_windows_release_requires_and_verifies_signing(self):
        workflow = (
            ROOT / ".github" / "workflows" / "release-windows.yml"
        ).read_text(encoding="utf-8")
        self.assertIn("WINDOWS_CSC_LINK", workflow)
        self.assertIn("WINDOWS_CSC_KEY_PASSWORD", workflow)
        self.assertIn("Get-AuthenticodeSignature", workflow)
        self.assertIn('Status -ne "Valid"', workflow)
        self.assertIn("gh release upload", workflow)
        self.assertNotIn("--publish always", workflow)
        self.assertLess(
            workflow.index("Verify stable signatures"),
            workflow.index("Publish verified stable artifacts"),
        )

    def test_ci_audits_runtime_dependencies(self):
        for relative in (
            ".github/workflows/desktop-check.yml",
            ".github/workflows/release-windows.yml",
        ):
            workflow = (ROOT / relative).read_text(encoding="utf-8")
            self.assertIn("npm audit --omit=dev --audit-level=high", workflow)

    def test_provider_limits_are_explicit(self):
        text = (ROOT / "docs" / "PROVIDER_CAPABILITIES.md").read_text(encoding="utf-8")
        self.assertIn("Managed multi-account/profile isolation: disabled", text)
        self.assertIn("does not fabricate a value", text)


if __name__ == "__main__":
    unittest.main()
