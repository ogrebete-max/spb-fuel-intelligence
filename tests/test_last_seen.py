"""A source that stops answering must not take its stations off the map.

On 14 Sep 2026 gdezapravka.ru stopped answering and ~250 stations only it
listed vanished from the published snapshot. These tests replay that refresh by
refresh: the files refresh_live leaves in data/live, the build, the history
update, and what the cards then say.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import build_snapshot  # noqa: E402
from collectors import COLLECTORS  # noqa: E402
import refresh_live  # noqa: E402
from src.history import save_history, update_history_data  # noqa: E402
from src.last_seen import RETENTION, carry_forward  # noqa: E402
from src.repository import StationRepository  # noqa: E402


START = datetime(2026, 9, 14, 12, 0, tzinfo=timezone.utc)
# The fixture has two sources; since 18 Sep 2026 «есть» is published only with
# three independent voices, so these tests watch the fresh evidence a slot
# delivers rather than the word the engine puts on it.
NOTE = "источник gdezapravka сейчас не отвечает"
# A forecourt only gdezapravka knows, and one that Sber lists as well.
ONLY = {"id": "7001", "address": "Тестовая ул., 1", "lat": 60.30, "lng": 29.62, "available": ["ai95"]}
SHARED = {"id": "7002", "address": "Тестовая ул., 2", "lat": 60.31, "lng": 29.64, "available": ["ai95", "dt"]}


def iso(value: datetime) -> str:
    return value.isoformat().replace("+00:00", "Z")


def write(path: Path, value) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")


def comparable(snapshot: dict) -> str:
    return json.dumps({key: value for key, value in snapshot.items() if key != "generated_at"}, ensure_ascii=False)


def listed_as(snapshot: dict, source: str, station_id: str) -> dict | None:
    ref = {"source": source, "station_id": station_id}
    return next((station for station in snapshot["stations"] if ref in station["source_refs"]), None)


class Pipeline:
    """What one scheduled slot does with data/live, the catalogue and history."""

    def __init__(self, root: Path):
        self.raw = root / "live"
        self.raw.mkdir()
        self.catalogue = root / "last-seen.json"
        self.snapshot_path = root / "stations.json"
        self.history_path = root / "history.json"
        self.history = None

    def refresh(self, at: datetime, gdezapravka: str = "fresh", listed=(ONLY, SHARED)) -> dict:
        """One refresh at ``at``.

        ``gdezapravka`` is "fresh"; "missing", a failure on a clean checkout
        where no capture of it exists; or "left", a failure on a disk that
        still holds its last good capture.
        """
        # The build takes its snapshot time from here, as for Phase-0 captures.
        write(self.raw / "phase0-analysis.json", {"generated_at": iso(at)})
        write(self.raw / "sber-full-aoi.json", {"stations": [{
            "id": "sber-7002", "name": "Тестойл", "address": SHARED["address"],
            "location": {"lat": SHARED["lat"], "lon": SHARED["lng"]},
            "fuels": [{"type": "ai95", "availabilityStatus": "available", "available": True,
                       "lastFuelingAt": iso(at - timedelta(minutes=5))}],
        }]})
        capture = self.raw / "gdezapravka-full-aoi.json"
        if gdezapravka == "fresh":
            write(capture, {"captured_at": iso(at), "stations": [{
                "id": item["id"], "brand": "Тестойл", "address": item["address"],
                "lat": item["lat"], "lng": item["lng"], "status": "available",
                "fuel_types": ["ai92", "ai95", "dt"], "available_fuels": item["available"],
                "last_report_age_ms": 5 * 60 * 1000, "fresh_count": 3,
            } for item in listed]})
        elif gdezapravka == "missing":
            capture.unlink(missing_ok=True)
        answered = gdezapravka == "fresh"
        write(self.raw / "full-aoi-probe-results.json", [
            {"name": "gdezapravka-full-aoi", "ok": answered, "http_status": 200 if answered else 0,
             "bytes": capture.stat().st_size if capture.exists() else 0, "captured_at": iso(at),
             "elapsed_ms": 120000, "error": None if answered else "TimeoutError: timed out"},
            {"name": "sber-full-aoi", "ok": True, "http_status": 200, "bytes": 400,
             "captured_at": iso(at), "elapsed_ms": 300, "error": None},
        ])
        snapshot = build_snapshot.build(self.raw, last_seen_path=self.catalogue)
        write(self.snapshot_path, snapshot)
        self.history = update_history_data(self.history, snapshot)
        save_history(self.history_path, self.history)
        return snapshot

    def cards(self, grade: str = "AI95") -> tuple[StationRepository, dict[str, dict]]:
        repository = StationRepository(self.snapshot_path, self.history_path)
        listed = repository.query(grade=grade, as_of="snapshot", limit=10_000)["stations"]
        return repository, {item["id"]: item["grade"] for item in listed}


class SourceOutageTests(unittest.TestCase):
    def setUp(self):
        self.temp = TemporaryDirectory()
        self.pipeline = Pipeline(Path(self.temp.name))

    def tearDown(self):
        self.temp.cleanup()

    def test_a_normal_refresh_is_left_exactly_as_it_was(self):
        self.pipeline.refresh(START)
        remembered = self.pipeline.refresh(START + timedelta(minutes=10))
        self.assertEqual(comparable(remembered), comparable(build_snapshot.build(self.pipeline.raw)))
        self.assertNotIn("stations_kept_while_sources_fail", remembered["stats"])

    def test_stations_only_the_failed_source_listed_stay_with_no_fresh_data(self):
        before = self.pipeline.refresh(START)
        during = self.pipeline.refresh(START + timedelta(minutes=10), "missing")

        known, kept = listed_as(before, "gdezapravka", "7001"), listed_as(during, "gdezapravka", "7001")
        self.assertIsNotNone(kept)
        identity = ("id", "network", "address", "location")
        self.assertEqual({key: kept[key] for key in identity}, {key: known[key] for key in identity})
        self.assertEqual(kept["evidence"], [])
        self.assertEqual(kept["failing_sources"], ["gdezapravka"])
        self.assertEqual(kept["last_seen_at"], iso(START))
        self.assertEqual(during["stats"]["canonical_stations"], before["stats"]["canonical_stations"])
        self.assertEqual(during["stats"]["stations_kept_while_sources_fail"], 1)

        repository, cards = self.pipeline.cards()
        card = cards[kept["id"]]
        self.assertEqual(card["status"], "NO_FRESH_DATA")
        self.assertEqual(card["source_note"], NOTE)
        self.assertTrue(card["reason"].startswith("Источник gdezapravka сейчас не отвечает. "))
        detail = repository.detail(kept["id"], as_of="snapshot")
        self.assertEqual({grade["status"] for grade in detail["grades"].values()}, {"NO_FRESH_DATA"})
        self.assertEqual({grade["source_note"] for grade in detail["grades"].values()}, {NOTE})

        # Sber still answers for 95 at the other station; its diesel came only
        # from gdezapravka.
        shared = listed_as(during, "sber", "sber-7002")
        self.assertEqual(shared["failing_sources"], ["gdezapravka"])
        self.assertGreater(cards[shared["id"]]["fresh_evidence_count"], 0, "Sber still answers for 95 here")
        self.assertNotIn("source_note", cards[shared["id"]])
        diesel = repository.detail(shared["id"], as_of="snapshot")["grades"]["DT"]
        self.assertEqual((diesel["status"], diesel["source_note"]), ("NO_FRESH_DATA", NOTE))

    def test_the_last_answer_is_not_carried_over_as_current(self):
        station_id = listed_as(self.pipeline.refresh(START), "gdezapravka", "7001")["id"]
        _, cards = self.pipeline.cards()
        self.assertGreater(cards[station_id]["fresh_evidence_count"], 0)
        self.assertEqual(cards[station_id]["timeline"]["state"], "OBSERVED")

        self.pipeline.refresh(START + timedelta(minutes=10), "missing")
        _, cards = self.pipeline.cards()
        card = cards[station_id]
        self.assertEqual(card["status"], "NO_FRESH_DATA")
        self.assertIsNone(card["probability"])
        self.assertEqual(card["votes"], [])
        self.assertEqual(card["advice"]["decision"], "UNKNOWN")
        # The stored history stopped with the feed; «есть непрерывно» must not
        # read on as if someone still saw fuel there.
        self.assertEqual(card["timeline"]["state"], "OUTDATED_HISTORY")

    def test_a_capture_the_failed_collector_left_on_disk(self):
        self.pipeline.refresh(START)
        # Ten minutes on, the capture it left still answers by its own age.
        recent = self.pipeline.refresh(START + timedelta(minutes=10), "left")
        station = listed_as(recent, "gdezapravka", "7001")
        self.assertEqual(station["failing_sources"], ["gdezapravka"])
        _, cards = self.pipeline.cards()
        self.assertGreater(cards[station["id"]]["fresh_evidence_count"], 0)
        self.assertNotIn("source_note", cards[station["id"]])

        # Three hours on, the same capture is only proof the station exists.
        stale = self.pipeline.refresh(START + timedelta(hours=3), "left")
        station = listed_as(stale, "gdezapravka", "7001")
        self.assertIsNotNone(station)
        self.assertEqual(stale["stats"]["stations_kept_while_sources_fail"], 1)
        repository, cards = self.pipeline.cards()
        self.assertEqual(cards[station["id"]]["source_note"], NOTE)
        detail = repository.detail(station["id"], as_of="snapshot")
        self.assertEqual({grade["status"] for grade in detail["grades"].values()}, {"NO_FRESH_DATA"})
        self.assertFalse(any(row["fresh"] for grade in detail["grades"].values() for row in grade["evidence"]))

        gone = self.pipeline.refresh(START + RETENTION + timedelta(hours=1), "left")
        self.assertIsNone(listed_as(gone, "gdezapravka", "7001"))
        self.assertIsNotNone(listed_as(gone, "sber", "sber-7002"))

    def test_a_kept_station_goes_a_week_after_any_source_last_listed_it(self):
        self.pipeline.refresh(START)
        self.pipeline.refresh(START + timedelta(hours=1), "missing")
        almost = self.pipeline.refresh(START + RETENTION - timedelta(minutes=10), "missing")
        self.assertIsNotNone(listed_as(almost, "gdezapravka", "7001"))

        after = self.pipeline.refresh(START + RETENTION + timedelta(minutes=10), "missing")
        self.assertIsNone(listed_as(after, "gdezapravka", "7001"))
        self.assertNotIn("stations_kept_while_sources_fail", after["stats"])
        catalogue = json.loads(self.pipeline.catalogue.read_text(encoding="utf-8"))
        refs = [ref for entry in catalogue["stations"] for ref in entry["source_refs"]]
        self.assertNotIn({"source": "gdezapravka", "station_id": "7001"}, refs)

    def test_everything_returns_to_normal_when_the_source_answers_again(self):
        self.pipeline.refresh(START)
        self.pipeline.refresh(START + timedelta(minutes=10), "missing")
        back = self.pipeline.refresh(START + timedelta(minutes=20))

        self.assertEqual(comparable(back), comparable(build_snapshot.build(self.pipeline.raw)))
        station = listed_as(back, "gdezapravka", "7001")
        self.assertNotIn("failing_sources", station)
        self.assertTrue(station["evidence"])
        _, cards = self.pipeline.cards()
        self.assertGreater(cards[station["id"]]["fresh_evidence_count"], 0)

    def test_a_station_the_answering_source_no_longer_lists_goes_at_once(self):
        self.pipeline.refresh(START)
        after = self.pipeline.refresh(START + timedelta(minutes=10), listed=(SHARED,))
        self.assertIsNone(listed_as(after, "gdezapravka", "7001"))

    def test_a_damaged_catalogue_never_stops_a_refresh(self):
        self.pipeline.catalogue.write_text("{not json", encoding="utf-8")
        snapshot = self.pipeline.refresh(START)
        self.assertIsNotNone(listed_as(snapshot, "gdezapravka", "7001"))
        self.assertEqual(json.loads(self.pipeline.catalogue.read_text(encoding="utf-8"))["schema_version"], 1)


class CatalogueTests(unittest.TestCase):
    def test_a_station_another_source_lists_under_its_own_id_is_not_shown_twice(self):
        remembered = {"stations": [{
            "id": "spbfi-old", "network": "Тестойл", "address": "Тестовая ул., 1",
            "location": {"lat": 60.30, "lon": 29.62},
            "source_refs": [{"source": "gdezapravka", "station_id": "7001"}],
            "seen": {"gdezapravka": iso(START - timedelta(minutes=10))},
        }]}
        current = [{
            "id": "spbfi-new", "network": "Тестойл", "address": "Тестовая ул., 1",
            "location": {"lat": 60.30001, "lon": 29.62},
            "source_refs": [{"source": "yandex-maps", "station_id": "y1"}],
            "match_rules": ["seed"], "evidence": [],
        }]
        stations, catalogue, kept = carry_forward(current, remembered, silent={"gdezapravka"}, at=START)
        self.assertEqual([station["id"] for station in stations], ["spbfi-new"])
        self.assertEqual(stations[0]["failing_sources"], ["gdezapravka"])
        self.assertEqual(kept, 0)
        # The failed source's id is still remembered for when it answers again.
        self.assertIn({"source": "gdezapravka", "station_id": "7001"}, catalogue["stations"][0]["source_refs"])

    def test_only_a_failed_collector_counts_as_silence(self):
        with TemporaryDirectory() as temp:
            raw = Path(temp)
            write(raw / "full-aoi-probe-results.json", [
                {"name": "gdezapravka-full-aoi", "ok": False, "error": "TimeoutError: timed out"},
                {"name": "gpn-official", "ok": False, "disabled": True},
                {"name": "yandex-maps", "ok": True, "skipped": True, "age_seconds": 600},
                {"name": "sber-full-aoi", "ok": True},
            ])
            self.assertEqual(build_snapshot.failed_sources(raw), {"gdezapravka"})

    def test_every_collector_says_which_stations_it_feeds(self):
        names = {name for name, _, _ in refresh_live.ENDPOINTS} | set(COLLECTORS) | {"gpn-official"}
        self.assertEqual(names, set(build_snapshot.CAPTURE_SOURCES))


if __name__ == "__main__":
    unittest.main()
