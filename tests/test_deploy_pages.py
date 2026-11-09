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
# The slot's own commit on the `state` branch.
STATE = "0123456789abcdef0123456789abcdef01234567"


class DeployPagesTests(unittest.TestCase):
    def test_a_slot_deploys_under_its_own_history_commit_and_retries_under_the_other(self):
        # One code commit was deployed 2736 times under one name; the status
        # read back was some older deployment's. GitHub takes only commits.
        self.assertEqual([build_version(SHA, STATE, attempt) for attempt in range(1, deploy_pages.ATTEMPTS + 1)],
                         [STATE, SHA, STATE])
        # A chain started before the history commit was passed on.
        self.assertEqual({build_version(SHA, "", attempt) for attempt in range(1, 4)}, {SHA})

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

    def run_main(self, statuses, served_probes, refuse_own_versions=False, state_sha=STATE):
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
               "GITHUB_SHA": SHA, "STATE_SHA": state_sha, "GITHUB_OUTPUT": ""}
        import os
        old_env = {key: os.environ.get(key) for key in env}
        try:
            deploy_pages.github, deploy_pages.oidc_token, deploy_pages.served = github, (lambda: "token"), served
            deploy_pages.time.sleep = lambda seconds: None
            sys.argv = ["deploy_pages.py", "123"]
            for key, value in env.items():
                if value:
                    os.environ[key] = value
                else:
                    os.environ.pop(key, None)
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
        self.assertEqual(calls["created"], [STATE, SHA])
        # The first attempt's eight probes never served; the second attempt's
        # second probe did, each a file never asked for before.
        self.assertEqual(calls["probes"][-1], probe)
        self.assertEqual(len(set(calls["probes"])), len(calls["probes"]))

    def test_a_refused_build_version_falls_back_to_the_code_commit(self):
        # 9 Nov 2026, 18:19 UTC: «404 Not Found» for every name not a commit.
        probe = "https://o.github.io/r/deploy-probe/9-1-3-1.txt"
        code, calls = self.run_main(["succeed"], {probe}, refuse_own_versions=True)
        self.assertEqual(code, 0)
        self.assertEqual(calls["created"], [STATE, SHA])

    def test_without_a_history_commit_it_deploys_as_deploy_pages_did(self):
        probe = "https://o.github.io/r/deploy-probe/9-1-3-1.txt"
        code, calls = self.run_main(["succeed"], {probe}, state_sha="")
        self.assertEqual((code, calls["created"]), (0, [SHA]))

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
