from pathlib import Path
import json
import unittest


ROOT = Path(__file__).resolve().parents[1]


class StaticSiteTests(unittest.TestCase):
    def test_assets_and_pwa_are_subpath_safe(self):
        html = (ROOT / "web" / "index.html").read_text(encoding="utf-8")
        manifest = json.loads((ROOT / "web" / "manifest.webmanifest").read_text(encoding="utf-8"))
        service_worker = (ROOT / "web" / "sw.js").read_text(encoding="utf-8")

        self.assertIn('name="spbfi-static-site" content="false"', html)
        self.assertNotIn('href="/', html)
        self.assertNotIn('src="/', html)
        self.assertIn(manifest["start_url"], {".", "./"})
        self.assertIn(manifest["scope"], {".", "./"})
        self.assertTrue(all(not icon["src"].startswith("/") for icon in manifest["icons"]))
        # Safari only accepts a PNG as the home-screen icon.
        self.assertIn('rel="apple-touch-icon"', html)
        self.assertIn("icons/apple-touch-icon.png", html)
        self.assertTrue((ROOT / "web" / "icons" / "apple-touch-icon.png").exists())
        self.assertIn("const APP_SHELL = ['./'", service_worker)


if __name__ == "__main__":
    unittest.main()
