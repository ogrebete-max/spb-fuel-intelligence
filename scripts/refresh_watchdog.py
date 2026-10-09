"""Free the refresh chain when it has stopped publishing.

On 6 Oct 2026 at 07:11 UTC a chain of refresh-and-deploy.yml stopped in its
fifteenth slot: the job sat «waiting» for the github-pages environment, which
has no reviewers and no wait timer, and never ran. The chain holds the
`spb-fuel-refresh` concurrency group, every later wake-up queued behind it and
was replaced by the next, and nothing was published for three days. The page,
ageing what it had, showed every station grey; the owner opened the app on
9 Oct to «топлива нет ни на одной заправке». Cancelling the stuck run by hand
let the waiting one start at once.

This runs from its own workflow, outside that concurrency group, so a stuck
chain cannot hold it back too. It acts only when the published snapshot is
stale, and then:

- cancels every unfinished refresh run older than a chain can ever take
  (sixteen slots of about ten minutes, and each job's 200-minute timeout), and
  force-cancels one that does not stop;
- starts a new chain when no refresh run is left to start by itself.

    python scripts/refresh_watchdog.py --dry-run     # says what it would do
"""
from __future__ import annotations

import argparse
from datetime import datetime, timedelta, timezone
import json
import subprocess
import sys
import time
from typing import Any
from urllib.request import Request, urlopen

REPO = "ogrebete-max/spb-fuel-intelligence"
WORKFLOW = "refresh-and-deploy.yml"
META_URL = "https://ogrebete-max.github.io/spb-fuel-intelligence/static-data/meta.json"
# A chain publishes about every ten minutes while it runs, and the next one
# follows at once; an hour and a half of silence is no longer a gap between
# slots.
STALE_AFTER = timedelta(minutes=90)
# Sixteen slots of about ten minutes are under three hours; a job may take 200
# minutes before its own timeout. Older than this and still unfinished, a run
# is stuck.
STUCK_AFTER = timedelta(hours=4)


def parse_time(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)
    except ValueError:
        return None


def decide(snapshot_at: datetime | None, runs: list[dict[str, Any]], now: datetime) -> dict[str, Any]:
    """What to do: the runs to cancel, and whether to start a chain.

    `runs` are the refresh workflow's recent runs as `gh run list --json
    databaseId,createdAt,status` gives them.
    """
    stale = snapshot_at is None or now - snapshot_at > STALE_AFTER
    if not stale:
        return {"stale": False, "cancel": [], "dispatch": False}
    open_runs = [run for run in runs if run.get("status") != "completed"]
    stuck = [run for run in open_runs
             if (created := parse_time(run.get("createdAt"))) is not None and now - created > STUCK_AFTER]
    left = [run for run in open_runs if run not in stuck]
    return {
        "stale": True,
        "cancel": [int(run["databaseId"]) for run in stuck],
        # A run left unfinished, young or waiting, starts by itself once the
        # stuck one is gone; with none, the chain has to be started.
        "dispatch": not left,
    }


def gh(*args: str) -> str:
    return subprocess.run(["gh", *args], check=True, capture_output=True, text=True).stdout


def snapshot_time() -> datetime | None:
    request = Request(f"{META_URL}?t={int(time.time())}", headers={"Cache-Control": "no-cache"})
    try:
        with urlopen(request, timeout=30) as response:
            return parse_time(json.load(response).get("snapshot_at"))
    except (OSError, ValueError):
        return None


def cancel(run_id: int) -> None:
    gh("run", "cancel", str(run_id), "-R", REPO)
    for _ in range(12):
        time.sleep(5)
        if json.loads(gh("run", "view", str(run_id), "-R", REPO, "--json", "status"))["status"] == "completed":
            return
    # A job stuck «waiting» on an environment may not take an ordinary cancel.
    gh("api", "-X", "POST", f"repos/{REPO}/actions/runs/{run_id}/force-cancel")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    now = datetime.now(timezone.utc)
    snapshot_at = snapshot_time()
    runs = json.loads(gh("run", "list", "-R", REPO, "--workflow", WORKFLOW, "--limit", "100",
                         "--json", "databaseId,createdAt,status"))
    plan = decide(snapshot_at, runs, now)
    age = f"{(now - snapshot_at).total_seconds() / 60:.0f} min" if snapshot_at else "unknown"
    print(f"snapshot {snapshot_at.isoformat() if snapshot_at else 'unreadable'} ({age} old); "
          f"unfinished runs: {[(run['databaseId'], run['status'], run['createdAt']) for run in runs if run.get('status') != 'completed']}")
    if not plan["stale"]:
        print("fresh: nothing to do")
        return 0
    for run_id in plan["cancel"]:
        print(f"cancel stuck run {run_id}")
        if not args.dry_run:
            cancel(run_id)
    if plan["dispatch"]:
        print(f"start a new chain of {WORKFLOW}")
        if not args.dry_run:
            gh("workflow", "run", WORKFLOW, "-R", REPO)
    if not plan["cancel"] and not plan["dispatch"]:
        print("stale, but a chain is running or waiting to: left to it")
    return 0


if __name__ == "__main__":
    sys.exit(main())
