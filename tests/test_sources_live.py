from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from collectors import parse_moscow_confirmation  # noqa: E402
from src.sources_live import (  # noqa: E402
    normalize_gdezapravka,
    normalize_kirishi_live,
    normalize_telegram_post,
    normalize_tofuel,
)


REFERENCE = datetime(2026, 9, 11, 21, 0, tzinfo=timezone.utc)


class TofuelTests(unittest.TestCase):
    def station(self, availability: str) -> dict:
        return {
            "_id": "abc", "name": "Лукойл", "address": "Невский, 1",
            "location": {"type": "Point", "coordinates": [30.33, 59.93]},
            "fuels": [{
                "type": "AI95", "availability": availability, "price": 70.1,
                "lastReportAt": "2026-09-11T20:50:00.000Z", "votesYes": 3, "votesNo": 0,
                "confidence": 0.8, "probability": 0.9,
            }],
        }

    def test_available_becomes_a_crowd_status(self):
        row = normalize_tofuel(self.station("available"))[0]
        evidence = row["evidence"][0]
        self.assertEqual(evidence["availability"], "AVAILABLE")
        self.assertEqual(evidence["kind"], "crowd_status")
        self.assertEqual(evidence["price_rub"], 70.1)
        # The site resells undisclosed provider feeds, so it is never independent.
        self.assertFalse(evidence["independent"])

    def test_unknown_never_becomes_a_negative(self):
        row = normalize_tofuel(self.station("unknown"))[0]
        self.assertEqual(row["evidence"][0]["availability"], "UNKNOWN")

    def test_disputed_is_reported_as_a_conflict(self):
        row = normalize_tofuel(self.station("disputed"))[0]
        self.assertEqual(row["evidence"][0]["availability"], "CONFLICT")


class GdezapravkaTests(unittest.TestCase):
    def test_missing_grade_is_a_soft_negative_not_silence(self):
        row = normalize_gdezapravka({
            "id": "2837", "brand": "Татнефть", "address": "Софийская, 37",
            "lat": 59.83, "lng": 30.53, "status": "available",
            "fuel_types": ["ai92", "ai95", "dt"], "available_fuels": ["ai95"],
            "last_report_age_ms": 600000, "confidence": 0.48, "fresh_count": 4,
            "queue_bucket": None,
        }, "2026-09-11T21:00:00Z")[0]
        by_grade = {item["grade"]: item for item in row["evidence"]}
        self.assertEqual(by_grade["AI95"]["availability"], "AVAILABLE")
        self.assertEqual(by_grade["AI92"]["availability"], "LIKELY_NOT")
        self.assertEqual(by_grade["DT"]["availability"], "LIKELY_NOT")
        self.assertEqual(by_grade["AI95"]["observed_at"], "2026-09-11T20:50:00Z")
        # Absence of a grade from the list is a hint, so it must never act as
        # one of the two independent confirmations behind "ПОДТВЕРЖДЕНО НЕТ".
        self.assertTrue(by_grade["AI95"]["independent"])
        self.assertIsNone(by_grade["AI92"]["independent"])

    def test_a_station_reporting_nothing_is_a_direct_negative(self):
        row = normalize_gdezapravka({
            "id": "9", "brand": "Лукойл", "lat": 59.9, "lng": 30.3, "status": "none",
            "fuel_types": ["ai92", "ai95"], "available_fuels": [], "last_report_age_ms": 60000,
        }, "2026-09-11T21:00:00Z")[0]
        for item in row["evidence"]:
            self.assertEqual(item["availability"], "NOT_AVAILABLE")
            self.assertTrue(item["independent"])

    def test_an_undated_row_produces_no_negative(self):
        row = normalize_gdezapravka({
            "id": "1", "brand": "Лукойл", "lat": 59.9, "lng": 30.3, "status": "available",
            "fuel_types": ["ai92"], "available_fuels": [], "last_report_age_ms": None,
        }, "2026-09-11T21:00:00Z")[0]
        self.assertEqual(row["evidence"], [])


class KirishiTests(unittest.TestCase):
    def test_swapped_latitude_and_longitude_are_restored(self):
        row = normalize_kirishi_live({
            "id": 1876, "lng": "59.940859", "lat": "30.503966",
            "address": "улица Коммуны, 14", "prices": [{"name": "АИ-95", "cost": "70,97  ₽"}],
        })[0]
        self.assertAlmostEqual(row["location"]["lat"], 59.940859)
        self.assertAlmostEqual(row["location"]["lon"], 30.503966)
        self.assertEqual(row["evidence"][0]["price_rub"], 70.97)
        self.assertEqual(row["evidence"][0]["availability"], "UNKNOWN")


class TelegramTests(unittest.TestCase):
    TEXT = (
        "Татнефть\nЛабораторный пр-кт, 21\n\n"
        "Топливо: 92,95,ДТ\nОчередь: Очередь ≈20–50 машин\nЛимит: 30 л\n\n"
        "Цены: 92 — 65,9 ₽ · 95 — 70,9 ₽ · ДТ — 80,3 ₽\nПо отметкам водителей\n\n"
        "Расстояние: 3.9 км от центра\nПоследнее подтверждение: 11 сентября в 23:49\n"
        "Подтверждений: 14"
    )

    def test_a_card_becomes_per_grade_crowd_reports(self):
        post = {
            "post_id": 4711, "published_at": "2026-09-11T21:00:00+00:00",
            "text": self.TEXT, "location": {"lat": 59.9386075, "lon": 30.2315669},
        }
        confirmed = parse_moscow_confirmation(self.TEXT, reference=REFERENCE)
        row = normalize_telegram_post(post, observed_at=confirmed)[0]
        self.assertEqual(row["network"], "Татнефть")
        self.assertEqual(row["address"], "Лабораторный пр-кт, 21")
        by_grade = {item["grade"]: item for item in row["evidence"]}
        self.assertEqual(sorted(by_grade), ["AI92", "AI95", "DT"])
        self.assertEqual(by_grade["AI95"]["price_rub"], 70.9)
        self.assertEqual(by_grade["AI95"]["queue"], "20_50")
        self.assertEqual(by_grade["AI95"]["limit_liters"], 30.0)
        self.assertEqual(by_grade["AI95"]["confidence"]["confirmations"], 14)
        # 23:49 Moscow is 20:49 UTC on the same day.
        self.assertEqual(by_grade["AI95"]["observed_at"], "2026-09-11T20:49:00Z")

    def test_a_digest_without_coordinates_is_ignored(self):
        post = {"post_id": 1, "text": "Самое важное из чатов к 00:00\n• Где-то был 92-й.", "location": None}
        self.assertEqual(normalize_telegram_post(post), [])

    def test_a_confirmation_is_never_read_as_the_future(self):
        stamp = parse_moscow_confirmation("Последнее подтверждение: 31 декабря в 23:30", reference=REFERENCE)
        self.assertEqual(stamp, "2025-12-31T20:30:00Z")


if __name__ == "__main__":
    unittest.main()
