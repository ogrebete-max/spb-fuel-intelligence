"""Publish the built site to GitHub Pages, and make sure it is served.

On 9 Nov 2026 from 16:41 UTC every slot's actions/deploy-pages said «Reported
success!» five seconds after creating its deployment, and the site kept serving
the 16:41 snapshot. An hour later the owner opened the app to every station
grey: the answers in that snapshot had run out. deploy-pages names a deployment
by its build version, the commit, and a chain deploys one commit sixteen times
(e55c8ee since 22 Oct: 2736 deployments). The status it read back was that of
an older deployment of the same commit, so it could not see that this one never
went live. GitHub acknowledges deployments that are accepted and never served
(community discussion 200884); deploying again is its advice.

GitHub takes only a commit of the repository as a build version («404 Not
Found» for a name of our own, 9 Nov 2026 18:19 UTC). So a slot deploys under
the commit it has just stored its history in (the `state` branch, a new one
each slot), which no other deployment has had, and its status read back is its
own; under the code's commit when that is refused, as deploy-pages did. After
«succeed» the site is asked for a file only this build carries (the probes the
workflow packs into the site); a new file name each time, because GitHub's CDN
keeps a «404» for minutes too. Not served — deploy again, now under the other
commit. Never served after a few attempts — the step fails, so the run shows
red and the watchdog's stale check stays the last word.

    python scripts/deploy_pages.py <artifact id>
"""
from __future__ import annotations

import json
import os
import sys
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

ATTEMPTS = 3
# Seconds: how long one deployment may stay in progress, and between reads.
STATUS_TIMEOUT = 240
STATUS_EVERY = 5
# Probe reads after «succeed», each of a new file; the workflow packs
# ATTEMPTS * PROBES_PER_ATTEMPT of them.
PROBES_PER_ATTEMPT = 8
PROBE_EVERY = 15

SUCCEED = "succeed"
# deploy-pages' own lists (src/internal/deployment.js).
FAILED = {"deployment_failed", "deployment_perms_error", "deployment_content_failed",
          "deployment_cancelled", "deployment_lost"}


def build_version(sha: str, state_sha: str, attempt: int) -> str:
    """The commit to deploy under: the slot's own history commit, which no
    other deployment has had, and the code's commit in between, so a retry is
    a deployment under another name."""
    return state_sha if state_sha and attempt % 2 else sha


def probe_name(prefix: str, index: int) -> str:
    return f"deploy-probe/{prefix}-{index}.txt"


def fall_back_to_commit(code: int) -> bool:
    """Whether a refused deployment is worth trying under the bare commit:
    any refusal of the request itself, but not a token without rights."""
    return 400 <= code < 500 and code not in (401, 403)


def outcome(status: str | None) -> str:
    """«live», «failed» or «wait» for a status the Pages API reports."""
    if status == SUCCEED:
        return "live"
    if status in FAILED:
        return "failed"
    return "wait"


def github(method: str, path: str, body: dict | None = None) -> dict:
    api = os.environ.get("GITHUB_API_URL", "https://api.github.com")
    request = Request(f"{api}{path}", method=method, data=json.dumps(body).encode() if body is not None else None,
                      headers={"Authorization": f"Bearer {os.environ['GH_TOKEN']}",
                               "Accept": "application/vnd.github+json",
                               "X-GitHub-Api-Version": "2022-11-28",
                               "Content-Type": "application/json"})
    with urlopen(request, timeout=30) as response:
        text = response.read().decode()
    return json.loads(text) if text else {}


def oidc_token() -> str:
    """The job's OIDC token, as deploy-pages gets it (core.getIDToken())."""
    request = Request(os.environ["ACTIONS_ID_TOKEN_REQUEST_URL"],
                      headers={"Authorization": f"bearer {os.environ['ACTIONS_ID_TOKEN_REQUEST_TOKEN']}"})
    with urlopen(request, timeout=30) as response:
        return json.load(response)["value"]


def served(url: str) -> bool:
    try:
        with urlopen(Request(url, headers={"Cache-Control": "no-cache"}), timeout=20) as response:
            return response.status == 200
    except (HTTPError, URLError, OSError):
        return False


def deploy_once(repo: str, artifact_id: int, version: str) -> tuple[str, str]:
    """Create one deployment and wait for its own status. Returns (outcome, id)."""
    created = github("POST", f"/repos/{repo}/pages/deployments",
                     {"artifact_id": artifact_id, "pages_build_version": version, "oidc_token": oidc_token()})
    deployment_id = str(created.get("id") or str(created.get("status_url") or "").rstrip("/").split("/")[-1] or version)
    print(f"created deployment {deployment_id} (build version {version})", flush=True)
    started = time.monotonic()
    status = None
    while time.monotonic() - started < STATUS_TIMEOUT:
        time.sleep(STATUS_EVERY)
        try:
            status = github("GET", f"/repos/{repo}/pages/deployments/{deployment_id}").get("status")
        except (HTTPError, URLError, OSError) as error:
            print(f"  status unreadable: {error}", flush=True)
            continue
        result = outcome(status)
        if result != "wait":
            print(f"  status {status}", flush=True)
            return result, deployment_id
    print(f"  still «{status}» after {STATUS_TIMEOUT} s; cancelling it", flush=True)
    try:
        github("POST", f"/repos/{repo}/pages/deployments/{deployment_id}/cancel")
    except (HTTPError, URLError, OSError) as error:
        print(f"  cancel failed: {error}", flush=True)
    return "failed", deployment_id


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__)
        return 2
    artifact_id = int(sys.argv[1])
    repo = os.environ["GITHUB_REPOSITORY"]
    site = os.environ["PAGES_URL"].rstrip("/") + "/"
    prefix = os.environ["PROBE_PREFIX"]
    sha = os.environ["GITHUB_SHA"]
    probe = 0
    for attempt in range(1, ATTEMPTS + 1):
        version = build_version(sha, os.environ.get("STATE_SHA", ""), attempt)
        try:
            result, _ = deploy_once(repo, artifact_id, version)
        except HTTPError as error:
            # One more way out: GitHub refusing the history commit (9 Nov 2026,
            # 18:19 UTC: «404 Not Found» for every name that was not a commit).
            # The code's commit is what deploy-pages always sent, and the
            # probes still tell whether it went live.
            detail = error.read().decode(errors="replace")[:300]
            print(f"attempt {attempt}: creating the deployment failed: HTTP {error.code} {detail}", flush=True)
            if fall_back_to_commit(error.code) and version != sha:
                print("  trying the bare commit as the build version", flush=True)
                try:
                    result, _ = deploy_once(repo, artifact_id, sha)
                except (HTTPError, URLError, OSError) as again:
                    print(f"  with the bare commit too: {again}", flush=True)
                    result = "failed"
            else:
                result = "failed"
        except (URLError, OSError) as error:
            print(f"attempt {attempt}: {error}", flush=True)
            result = "failed"
        if result == "live":
            for _ in range(PROBES_PER_ATTEMPT):
                probe += 1
                time.sleep(PROBE_EVERY)
                url = site + probe_name(prefix, probe)
                if served(url):
                    print(f"served: {url}", flush=True)
                    with open(os.environ.get("GITHUB_OUTPUT", os.devnull), "a", encoding="utf-8") as output:
                        output.write(f"page_url={site}\n")
                    return 0
            print(f"attempt {attempt}: Pages reported success, but the site still serves an older build", flush=True)
        else:
            probe += PROBES_PER_ATTEMPT
            # A deployment still in progress makes GitHub refuse the next one.
            time.sleep(30)
    print(f"::error::The site was not updated after {ATTEMPTS} deployments; it still serves an older snapshot.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
