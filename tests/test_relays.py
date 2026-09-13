from datetime import datetime, timedelta, timezone
import unittest

from src.evidence_engine import evaluate_grade

NOW = datetime(2026, 9, 13, 10, 0, tzinfo=timezone.utc)


def row(source, cluster, kind, availability, minutes_ago):
    at = (NOW - timedelta(minutes=minutes_ago)).isoformat().replace("+00:00", "Z")
    return {
        "source": source, "grade": "AI95", "availability": availability, "kind": kind,
        "observed_at": at, "received_at": at, "provenance_cluster": cluster, "independent": False,
    }


def clusters(rows):
    return {vote["cluster"] for vote in evaluate_grade(rows, "AI95", now=NOW)["votes"]}


SBER = row("sber", "sber+2gis-catalog", "realtime_status", "AVAILABLE", 30)


class RelayTests(unittest.TestCase):
    def test_tofuel_trailing_sber_is_the_same_voice(self):
        self.assertEqual(clusters([SBER, row("tofuel", "tofuel-mixed-upstream", "crowd_status", "AVAILABLE", 8)]), {"sber-2gis"})

    def test_tutbenz_payment_trailing_sber_is_the_same_voice(self):
        self.assertEqual(clusters([SBER, row("tutbenz", "tbank-payment", "payment_projection", "LIKELY", 10)]), {"sber-2gis"})

    def test_a_relay_that_disagrees_keeps_its_voice(self):
        self.assertEqual(
            clusters([SBER, row("tofuel", "tofuel-mixed-upstream", "crowd_status", "NOT_AVAILABLE", 8)]),
            {"sber-2gis", "tofuel-mixed-upstream"},
        )

    def test_a_relay_long_after_sber_keeps_its_voice(self):
        # Sber is too old to vote here; the late row is not its echo and still counts.
        old_sber = row("sber", "sber+2gis-catalog", "realtime_status", "AVAILABLE", 110)
        self.assertEqual(
            clusters([old_sber, row("tofuel", "tofuel-mixed-upstream", "crowd_status", "AVAILABLE", 5)]),
            {"tofuel-mixed-upstream"},
        )

    def test_without_sber_nothing_is_folded(self):
        self.assertEqual(clusters([row("tofuel", "tofuel-mixed-upstream", "crowd_status", "AVAILABLE", 8)]), {"tofuel-mixed-upstream"})

    def test_the_real_tbank_feed_is_never_folded(self):
        self.assertEqual(
            clusters([SBER, row("tbank-fuel", "tbank-payments", "payment_projection", "LIKELY", 10)]),
            {"sber-2gis", "tbank-payments"},
        )


if __name__ == "__main__":
    unittest.main()
