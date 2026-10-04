import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MEDIA = ROOT / "apps" / "desktop" / "src" / "media"


class DesktopMediaSecurityContractTests(unittest.TestCase):
    def read(self, name):
        return (MEDIA / name).read_text(encoding="utf-8")

    def test_shared_persistent_google_partition(self):
        text = self.read("google-media-session-manager.js")
        self.assertIn("persist:teamyra-google-media-profile", text)
        self.assertIn("setPermissionCheckHandler", text)
        self.assertIn("setPermissionRequestHandler", text)
        self.assertIn("AUTH_STORAGE_PERMISSIONS", text)
        self.assertIn("isTrustedGoogleOrigin", text)
        self.assertIn("select-webauthn-account", text)
        self.assertIn("callback(selected)", text)

    def test_media_views_use_electron_security_boundaries(self):
        for name in ("google-flow-provider.js", "google-flow-music-provider.js"):
            text = self.read(name)
            self.assertIn("nodeIntegration: false", text)
            self.assertIn("contextIsolation: true", text)
            self.assertIn("sandbox: true", text)
            self.assertIn("backgroundThrottling: false", text)

    def test_cdp_uses_live_geometry_not_static_screen_coordinates(self):
        text = self.read("media-browser-controller.js")
        self.assertIn("DOM.getBoxModel", text)
        self.assertIn("Input.dispatchMouseEvent", text)
        self.assertIn("DOM.setFileInputFiles", text)
        self.assertNotRegex(text, r"\bx\s*:\s*\d{2,}")
        self.assertNotRegex(text, r"\by\s*:\s*\d{2,}")

    def test_selectors_are_isolated_to_google_adapters(self):
        generic = "\n".join(
            self.read(name) for name in (
                "google-media-engine.js", "media-job-consumer.js",
                "media-download-manager.js", "google-media-session-manager.js",
            )
        )
        self.assertNotIn("querySelector(", generic)
        self.assertNotIn("aria-label", generic)

    def test_google_navigation_is_allowlisted(self):
        flow = self.read("google-flow-provider.js")
        music = self.read("google-flow-music-provider.js")
        self.assertIn("ALLOWED_GOOGLE_HOSTS", flow)
        self.assertIn("ALLOWED_MUSIC_HOSTS", music)
        self.assertIn("event.preventDefault()", flow)
        self.assertIn("event.preventDefault()", music)


if __name__ == "__main__":
    unittest.main()
