"""The deploy step that checks the site really serves the new build (9 Nov 2026)."""
from __future__ import annotations

from pathlib import Path
import re
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

import deploy_pages  # noqa: E402
from deploy_pages import build_version, outcome, probe_name  # noqa: E402

WORKFLOW = Path(__file__).resolve().parents[1] / ".github" / "workflows" / "refresh-and-deploy.yml"
SHA = "e55c8ee3dcbbb77d3ac07f5853ee0f6539efe28e"


class DeployPagesTests(unittest.TestCase):
    def test_every_attempt_of_every_slot_has_a_build_version_of_its_own(self):
        # One commit was deployed 2736 times under one name; the status read
        # back was some older deployment's.
        versions = {build_version(SHA, "42653450427", "1", str(slot), attempt)
                    for slot in range(16) for attempt in range(1, deploy_pages.ATTEMPTS + 1)}
        self.assertEqual(len(versions), 16 * deploy_pages.ATTEMPTS)
        self.assertTrue(all(version.startswith(SHA) and re.fullmatch(r"[0-9a-z-]+", version) for version in versions))
        self.assertNotEqual(build_version(SHA, "1", "1", "0", 1), build_version(SHA, "1", "2", "0", 1))

    def test_only_succeed_counts_as_live(self):
        self.assertEqual(outcome("succeed"), "live")
        for status in ("deployment_failed", "deployment_lost", "deployment_cancelled", "deployment_content_failed"):
            self.assertEqual(outcome(status), "failed")
        for status in ("deployment_in_progress", "syncing_files", "updating_pages", "deployment_attempt_error", None):
            self.assertEqual(outcome(status), "wait")

    def test_the_workflow_packs_every_probe_the_step_may_ask_for(self):
        text = WORKFLOW.read_text(encoding="utf-8")
        packed = int(re.search(r"for i in \$\(seq 1 (\d+)\)", text).group(1))
        self.assertEqual(packed, deploy_pages.ATTEMPTS * deploy_pages.PROBES_PER_ATTEMPT)
        self.assertEqual(probe_name("1-1-0", 3), "deploy-probe/1-1-0-3.txt")
        self.assertIn('site/deploy-probe/$probe-$i.txt', text)
        self.assertIn("python scripts/deploy_pages.py", text)
        self.assertNotIn("actions/deploy-pages", text.split("Deploy to GitHub Pages")[-1].split("Hand over")[0])



class DeployLoopTests(unittest.TestCase):
    """main() against a fake Pages API: what 9 Nov looked like, and the way out."""

    def run_main(self, statuses, served_probes, refuse_own_versions=False):
        calls = {"created": [], "probes": []}
        state = {"status": iter(statuses)}

        def github(method, path, body=None):
            if method == "POST" and path.endswith("/pages/deployments"):
                calls["created"].append(body["pages_build_version"])
                if refuse_own_versions and body["pages_build_version"] != SHA:
                    import io
                    from urllib.error import HTTPError
                    raise HTTPError(path, 404, "Not Found", {}, io.BytesIO(b'{"message":"Not Found"}'))
                return {"status_url": f"https://api.github.com/x/pages/deployments/{body['pages_build_version']}"}
            if method == "GET":
                return {"status": next(state["status"])}
            return {}

        def served(url):
            calls["probes"].append(url)
            return url in served_probes

        saved = (deploy_pages.github, deploy_pages.oidc_token, deploy_pages.served, deploy_pages.time.sleep, sys.argv)
        env = {"GITHUB_REPOSITORY": "o/r", "PAGES_URL": "https://o.github.io/r", "PROBE_PREFIX": "9-1-3",
               "GITHUB_SHA": SHA, "GITHUB_RUN_ID": "9", "GITHUB_RUN_ATTEMPT": "1", "SLOT": "3", "GITHUB_OUTPUT": ""}
        import os
        old_env = {key: os.environ.get(key) for key in env}
        try:
            deploy_pages.github, deploy_pages.oidc_token, deploy_pages.served = github, (lambda: "token"), served
            deploy_pages.time.sleep = lambda seconds: None
            sys.argv = ["deploy_pages.py", "123"]
            os.environ.update({key: value for key, value in env.items() if value})
            code = deploy_pages.main()
        finally:
            deploy_pages.github, deploy_pages.oidc_token, deploy_pages.served, deploy_pages.time.sleep, sys.argv = saved
            for key, value in old_env.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value
        return code, calls

    def test_success_that_is_not_served_is_deployed_again(self):
        probe = "https://o.github.io/r/deploy-probe/9-1-3-10.txt"
        code, calls = self.run_main(["syncing_files", "succeed", "succeed"], {probe})
        self.assertEqual(code, 0)
        self.assertEqual(len(calls["created"]), 2)
        self.assertEqual(len(set(calls["created"])), 2)
        # The first attempt's eight probes never served; the second attempt's
        # second probe did, each a file never asked for before.
        self.assertEqual(calls["probes"][-1], probe)
        self.assertEqual(len(set(calls["probes"])), len(calls["probes"]))

    def test_a_refused_build_version_falls_back_to_the_bare_commit(self):
        # 9 Nov 2026, 18:19 UTC: «404 Not Found» for every version of our own.
        probe = "https://o.github.io/r/deploy-probe/9-1-3-1.txt"
        code, calls = self.run_main(["succeed"], {probe}, refuse_own_versions=True)
        self.assertEqual(code, 0)
        self.assertEqual(calls["created"], [build_version(SHA, "9", "1", "3", 1), SHA])

    def test_a_token_without_rights_is_not_retried_under_the_commit(self):
        self.assertFalse(deploy_pages.fall_back_to_commit(403))
        self.assertFalse(deploy_pages.fall_back_to_commit(401))
        self.assertFalse(deploy_pages.fall_back_to_commit(502))
        self.assertTrue(deploy_pages.fall_back_to_commit(404))
        self.assertTrue(deploy_pages.fall_back_to_commit(422))

    def test_a_site_that_never_updates_fails_the_step(self):
        code, calls = self.run_main(["succeed", "deployment_failed", "succeed"], set())
        self.assertEqual(code, 1)
        self.assertEqual(len(calls["created"]), deploy_pages.ATTEMPTS)
        self.assertEqual(len(set(calls["probes"])), len(calls["probes"]))


if __name__ == "__main__":
    unittest.main()
