from __future__ import annotations

from datetime import datetime, timedelta, timezone
import unittest

from src.evidence_engine import evaluate_grade


NOW = datetime(2026, 9, 11, 0, 0, tzinfo=timezone.utc)


def row(status, *, kind="crowd_report", cluster="crowd-a", independent=True, age_minutes=10, grade="AI95", limit=None, queue=None):
    return {
        "grade": grade, "availability": status, "kind": kind,
        "observed_at": (NOW - timedelta(minutes=age_minutes)).isoformat(),
        "provenance_cluster": cluster, "independent": independent,
        "price_rub": None, "limit_liters": limit, "queue": queue,
    }


class EvidenceEngineTests(unittest.TestCase):
    def test_unknown_never_becomes_no(self):
        result = evaluate_grade([row("UNKNOWN")], "AI95", now=NOW)
        self.assertEqual(result["status"], "NO_FRESH_DATA")

    def test_stale_negative_is_no_fresh_data(self):
        result = evaluate_grade([row("NOT_AVAILABLE", age_minutes=1000)], "AI95", now=NOW)
        self.assertEqual(result["status"], "NO_FRESH_DATA")

    def test_five_hour_old_report_is_not_a_current_answer(self):
        result = evaluate_grade([row("AVAILABLE", age_minutes=5 * 60)], "AI95", now=NOW)
        self.assertEqual(result["status"], "NO_FRESH_DATA")

    def test_official_stock_is_confirmation(self):
        result = evaluate_grade([row("AVAILABLE", kind="official_stock", cluster="official")], "AI95", now=NOW)
        self.assertEqual(result["status"], "CAN_REFUEL")

    def test_two_independent_crowd_clusters_confirm(self):
        evidence = [row("AVAILABLE", cluster="a"), row("AVAILABLE", cluster="b")]
        self.assertEqual(evaluate_grade(evidence, "AI95", now=NOW)["status"], "CAN_REFUEL")

    def test_dependent_duplicates_do_not_confirm(self):
        evidence = [row("AVAILABLE", cluster="same", independent=False), row("AVAILABLE", cluster="same", independent=False)]
        result = evaluate_grade(evidence, "AI95", now=NOW)
        self.assertEqual(result["status"], "LIKELY_AVAILABLE")
        self.assertEqual(result["fresh_provenance_count"], 1)

    def test_opposite_fresh_signals_are_conflict(self):
        evidence = [row("AVAILABLE", cluster="a"), row("NOT_AVAILABLE", cluster="b")]
        self.assertEqual(evaluate_grade(evidence, "AI95", now=NOW)["status"], "CONFLICT")

    def test_limit_is_visible_and_restricted(self):
        result = evaluate_grade([row("AVAILABLE", limit=30)], "AI95", now=NOW)
        self.assertEqual(result["status"], "LIMITED")
        self.assertEqual(result["limit_liters"], 30)

    def test_known_queue_is_restricted_but_empty_queue_metadata_is_not(self):
        queued = evaluate_grade([row("AVAILABLE", queue={"size": "20_50"})], "AI95", now=NOW)
        unknown = evaluate_grade([row("AVAILABLE", queue={"size": None})], "AI95", now=NOW)
        self.assertEqual(queued["status"], "LIMITED")
        self.assertEqual(unknown["status"], "LIKELY_AVAILABLE")

    def test_expired_queue_is_not_shown_or_restricted(self):
        expired = {"size": "gt50", "until": (NOW - timedelta(minutes=1)).isoformat()}
        result = evaluate_grade([row("AVAILABLE", queue=expired)], "AI95", now=NOW)
        self.assertEqual(result["status"], "LIKELY_AVAILABLE")
        self.assertIsNone(result["queue"])


if __name__ == "__main__":
    unittest.main()
