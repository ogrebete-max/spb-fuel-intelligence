from datetime import datetime, timezone
import unittest

from src.history import station_history_id, timeline_for, update_history_data


def snapshot(at, availability, kind="official_stock"):
    station = {
        "id": "canonical-1", "network": "Test", "address": "СПб",
        "location": {"lat": 59.9, "lon": 30.3},
        "source_refs": [{"source": "gazpromneft", "station_id": "1108"}],
        "evidence": [{
            "source": "gazpromneft", "grade": "AI95", "availability": availability,
            "kind": kind, "received_at": at, "observed_at": at,
            "provenance_cluster": "gazpromneft-official", "independent": False,
        }],
    }
    return {"snapshot_at": at, "stations": [station]}, station


class HistoryTests(unittest.TestCase):
    def test_stable_upstream_identity(self):
        _, station = snapshot("2026-09-11T05:00:00Z", "AVAILABLE")
        self.assertEqual(station_history_id(station), "gazpromneft:1108")

    def test_first_positive_is_not_claimed_as_restock(self):
        first, station = snapshot("2026-09-11T05:00:00Z", "AVAILABLE")
        history = update_history_data(None, first)
        view = timeline_for(history, station, "AI95", now=datetime(2026, 9, 11, 5, 10, tzinfo=timezone.utc))
        self.assertEqual(view["state"], "OBSERVED_AVAILABLE")
        self.assertIsNone(view["last_transition"])

    def test_official_negative_to_positive_is_possible_restock(self):
        first, _ = snapshot("2026-09-11T05:00:00Z", "NOT_AVAILABLE")
        second, station = snapshot("2026-09-11T05:20:00Z", "AVAILABLE")
        history = update_history_data(update_history_data(None, first), second)
        view = timeline_for(history, station, "AI95", now=datetime(2026, 9, 11, 5, 25, tzinfo=timezone.utc))
        self.assertEqual(view["state"], "JUST_APPEARED")
        self.assertEqual(view["last_transition"]["kind"], "BECAME_AVAILABLE")
        self.assertEqual(view["last_transition"]["interpretation"], "possible_restock")
        self.assertEqual(view["last_transition"]["confidence"], "high")

    def test_unknown_to_positive_is_only_new_signal(self):
        first, _ = snapshot("2026-09-11T05:00:00Z", "UNKNOWN", kind="catalog_fuel")
        second, station = snapshot("2026-09-11T05:20:00Z", "AVAILABLE")
        history = update_history_data(update_history_data(None, first), second)
        view = timeline_for(history, station, "AI95", now=datetime(2026, 9, 11, 5, 25, tzinfo=timezone.utc))
        self.assertEqual(view["last_transition"]["kind"], "NEW_POSITIVE_SIGNAL")
        self.assertEqual(view["last_transition"]["interpretation"], "new_positive_signal")

    def test_unchanged_status_preserves_since_and_counts_confirmation(self):
        first, _ = snapshot("2026-09-11T05:00:00Z", "AVAILABLE")
        second, station = snapshot("2026-09-11T06:00:00Z", "AVAILABLE")
        history = update_history_data(update_history_data(None, first), second)
        view = timeline_for(history, station, "AI95", now=datetime(2026, 9, 11, 6, 0, tzinfo=timezone.utc))
        self.assertEqual(view["duration_seconds"], 3600)
        self.assertEqual(view["confirmations"], 2)
        self.assertEqual(view["transitions"], [])

    def test_positive_to_negative_is_recorded(self):
        first, _ = snapshot("2026-09-11T05:00:00Z", "AVAILABLE")
        second, station = snapshot("2026-09-11T05:20:00Z", "NOT_AVAILABLE")
        history = update_history_data(update_history_data(None, first), second)
        view = timeline_for(history, station, "AI95", now=datetime(2026, 9, 11, 5, 25, tzinfo=timezone.utc))
        self.assertEqual(view["state"], "RECENTLY_DISAPPEARED")
        self.assertFalse(view["appeared_recent"])
        self.assertEqual(view["last_transition"]["kind"], "BECAME_UNAVAILABLE")

    def test_old_transition_is_not_recent_when_live_status_expired(self):
        first, _ = snapshot("2026-09-11T05:00:00Z", "NOT_AVAILABLE")
        second, station = snapshot("2026-09-11T05:20:00Z", "AVAILABLE")
        history = update_history_data(update_history_data(None, first), second)
        view = timeline_for(history, station, "AI95", now=datetime(2026, 9, 11, 10, 25, tzinfo=timezone.utc), current_status="NO_FRESH_DATA")
        self.assertEqual(view["state"], "HISTORICAL_POSITIVE")
        self.assertFalse(view["appeared_recent"])
    def test_stale_negative_history_never_contradicts_a_live_positive(self):
        first, _ = snapshot("2026-09-11T05:00:00Z", "NOT_AVAILABLE")
        second, station = snapshot("2026-09-11T05:20:00Z", "NOT_AVAILABLE")
        history = update_history_data(update_history_data(None, first), second)
        view = timeline_for(
            history, station, "AI95",
            now=datetime(2026, 9, 11, 18, 0, tzinfo=timezone.utc),
            current_status="CAN_REFUEL",
        )
        self.assertEqual(view["state"], "OUTDATED_HISTORY")
        self.assertIsNone(view["duration_seconds"])
        self.assertFalse(view["appeared_recent"])


if __name__ == "__main__":
    unittest.main()
