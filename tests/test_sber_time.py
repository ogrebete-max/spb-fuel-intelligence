import unittest

from src.normalizers import normalize_sber


def body(fuel, **station):
    return {
        "station": {
            "id": "s-1", "name": "АЗС", "address": "СПб", "location": {"lat": 59.9, "lon": 30.3},
            "updatedAt": "2026-09-12T13:57:53.196Z", "fuels": [fuel], **station,
        },
    }


class SberTimestampTests(unittest.TestCase):
    def test_last_payment_beats_the_batch_pull_time(self):
        rows = normalize_sber(body(
            {"type": "AI95", "availabilityStatus": "available", "available": True},
            lastPaymentAt="2026-09-12T13:46:10.000Z",
        ))[0]["evidence"]
        self.assertEqual(rows[0]["observed_at"], "2026-09-12T13:46:10.000Z")

    def test_grade_specific_fueling_time_still_wins(self):
        rows = normalize_sber(body(
            {"type": "AI95", "availabilityStatus": "available", "available": True, "lastFuelingAt": "2026-09-12T13:50:00.000Z"},
            lastPaymentAt="2026-09-12T13:46:10.000Z",
        ))[0]["evidence"]
        self.assertEqual(rows[0]["observed_at"], "2026-09-12T13:50:00.000Z")

    def test_pull_time_is_only_the_last_resort(self):
        rows = normalize_sber(body({"type": "AI95", "availabilityStatus": "available", "available": True}))[0]["evidence"]
        self.assertEqual(rows[0]["observed_at"], "2026-09-12T13:57:53.196Z")


if __name__ == "__main__":
    unittest.main()
