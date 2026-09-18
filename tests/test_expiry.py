from __future__ import annotations

import unittest
from datetime import datetime, timedelta, timezone

from src.evidence_engine import evaluate_grade

NOW = datetime(2026, 9, 15, 12, 0, tzinfo=timezone.utc)


def row(cluster="crowd-a", **times):
    return {
        "grade": "AI95", "availability": "AVAILABLE", "kind": "crowd_status",
        "provenance_cluster": cluster, "independent": True,
        "price_rub": None, "limit_liters": None, "queue": None, **times,
    }


def heard(**times):
    """The same answer from three independent voices, as «есть» now needs."""
    return [row(cluster=name, **times) for name in ("crowd-a", "crowd-b", "crowd-c")]


def iso(moment: datetime) -> str:
    return moment.isoformat().replace("+00:00", "Z")


class AnswersRunOut(unittest.TestCase):
    """15 Sep 2026 review: an answer from a source without time never ran out in the browser."""

    def test_a_dated_answer_runs_out_its_ttl_after_it_was_seen(self):
        seen = NOW - timedelta(minutes=10)
        result = evaluate_grade(heard(observed_at=iso(seen)), "AI95", now=NOW)
        self.assertNotEqual(result["status"], "NO_FRESH_DATA")
        self.assertEqual(result["expires_at"], iso(seen + timedelta(seconds=result["ttl_seconds"])))

    def test_an_undated_answer_runs_out_its_ttl_after_it_was_polled(self):
        polled = NOW - timedelta(minutes=5)
        result = evaluate_grade(heard(received_at=iso(polled)), "AI95", now=NOW)
        self.assertNotEqual(result["status"], "NO_FRESH_DATA")
        self.assertTrue(result["undated_only"])
        self.assertIsNone(result["age_seconds"])
        self.assertEqual(result["expires_at"], iso(polled + timedelta(seconds=result["ttl_seconds"])))

    def test_no_answer_has_no_end(self):
        result = evaluate_grade([row(observed_at=iso(NOW - timedelta(hours=9)))], "AI95", now=NOW)
        self.assertEqual(result["status"], "NO_FRESH_DATA")
        self.assertIsNone(result["expires_at"])


if __name__ == "__main__":
    unittest.main()
