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
        self.assertEqual(manifest["start_url"], ".")
        self.assertEqual(manifest["scope"], ".")
        self.assertTrue(all(not icon["src"].startswith("/") for icon in manifest["icons"]))
        self.assertIn("const APP_SHELL = ['./'", service_worker)


if __name__ == "__main__":
    unittest.main()
