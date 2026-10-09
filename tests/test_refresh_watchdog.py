"""The watchdog that frees a stuck refresh chain (9 Oct 2026)."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from refresh_watchdog import decide  # noqa: E402

NOW = datetime(2026, 10, 9, 8, 30, tzinfo=timezone.utc)


def run(run_id, hours_ago, status):
    created = (NOW - timedelta(hours=hours_ago)).isoformat().replace("+00:00", "Z")
    return {"databaseId": run_id, "createdAt": created, "status": status}


class WatchdogTests(unittest.TestCase):
    def test_a_fresh_snapshot_leaves_everything_alone(self):
        plan = decide(NOW - timedelta(minutes=12), [run(1, 50, "waiting")], NOW)
        self.assertEqual(plan, {"stale": False, "cancel": [], "dispatch": False})

    def test_the_stuck_chain_of_6_october_is_cancelled_and_the_waiting_run_left_to_start(self):
        # The run stuck since 6 Oct 07:11 UTC, and the wake-up queued behind it.
        plan = decide(datetime(2026, 10, 6, 9, 14, tzinfo=timezone.utc),
                      [run(2, 1, "pending"), run(1, 73, "waiting")], NOW)
        self.assertEqual(plan["cancel"], [1])
        self.assertFalse(plan["dispatch"])

    def test_with_nothing_queued_behind_it_a_new_chain_is_started(self):
        plan = decide(NOW - timedelta(hours=6), [run(1, 6, "in_progress"), run(0, 9, "completed")], NOW)
        self.assertEqual(plan["cancel"], [1])
        self.assertTrue(plan["dispatch"])

    def test_a_chain_of_today_is_not_cut_short(self):
        # Stale for a moment, but its run is younger than a chain can take.
        plan = decide(NOW - timedelta(hours=2), [run(1, 2.5, "in_progress")], NOW)
        self.assertEqual(plan["cancel"], [])
        self.assertFalse(plan["dispatch"])

    def test_a_dead_chain_with_nothing_running_is_restarted(self):
        plan = decide(NOW - timedelta(hours=3), [run(0, 5, "completed")], NOW)
        self.assertEqual(plan["cancel"], [])
        self.assertTrue(plan["dispatch"])

    def test_an_unreadable_snapshot_counts_as_stale(self):
        plan = decide(None, [], NOW)
        self.assertTrue(plan["stale"])
        self.assertTrue(plan["dispatch"])


if __name__ == "__main__":
    unittest.main()
