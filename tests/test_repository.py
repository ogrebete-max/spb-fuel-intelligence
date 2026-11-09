import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from src.repository import StationRepository, yandex_org


class RepositoryTests(unittest.TestCase):
    def setUp(self):
        self.temp = TemporaryDirectory()
        self.path = Path(self.temp.name) / "snapshot.json"
        self.path.write_text(json.dumps({
            "schema_version": 1,
            "snapshot_at": "2026-09-11T05:00:00Z",
            "mode": "test",
            "source_registry": [
                {"id": "sber_fuel_map", "status": "GREEN_VERIFIED_HTTP"},
                {"id": "toplivo_ryadom", "status": "GREEN_VERIFIED_HTTP"},
            ],
            "stats": {"source_rows": {"sber": 10, "toplivo-ryadom": 20}},
            "stations": [{
                "id": "one", "network": "Test", "address": "СПб", "location": {"lat": 59.9, "lon": 30.3},
                "source_refs": [{"source": "sber", "station_id": "1"}],
                "evidence": [{
                    "source": "sber", "grade": "AI95", "availability": "LIKELY", "kind": "crowd_report",
                    "observed_at": "2026-09-11T04:50:00Z", "provenance_cluster": "sber-test", "independent": True,
                }],
            }],
        }), encoding="utf-8")
        self.repository = StationRepository(self.path)

    def tearDown(self):
        self.temp.cleanup()

    def test_list_omits_raw_evidence_but_detail_keeps_it(self):
        listed = self.repository.query(grade="AI95", as_of="2026-09-11T05:00:00Z")
        self.assertNotIn("evidence", listed["stations"][0]["grade"])
        self.assertEqual(len(self.repository.detail("one", as_of="2026-09-11T05:00:00Z")["grades"]["AI95"]["evidence"]), 1)

    def test_source_count_aliases(self):
        counts = {row["id"]: row["station_rows_in_snapshot"] for row in self.repository.sources()["sources"]}
        self.assertEqual(counts, {"sber_fuel_map": 10, "toplivo_ryadom": 20})

    def test_list_row_carries_yandex_org_only_when_yandex_knows_the_station(self):
        listed = self.repository.query(grade="AI95", as_of="2026-09-11T05:00:00Z")
        self.assertNotIn("yandex_org", listed["stations"][0])
        snapshot = json.loads(self.path.read_text(encoding="utf-8"))
        snapshot["stations"][0]["source_refs"].append({"source": "yandex-maps", "station_id": "48686311669"})
        self.path.write_text(json.dumps(snapshot), encoding="utf-8")
        listed = StationRepository(self.path).query(grade="AI95", as_of="2026-09-11T05:00:00Z")
        self.assertEqual(listed["stations"][0]["yandex_org"], "48686311669")
        self.assertEqual(yandex_org({"source_refs": [
            {"source": "sber", "station_id": "7"},
            {"source": "yandex-maps", "station_id": "not-a-number"},
            {"source": "yandex-maps", "station_id": "48686311669"},
        ]}), "48686311669")
        self.assertIsNone(yandex_org({"source_refs": [{"source": "yandex-maps", "station_id": "12/34"}]}))

    def test_radius_keeps_nearby_station_and_adds_distance(self):
        result = self.repository.query(
            grade="AI95", center={"lat": 59.9001, "lon": 30.3001}, radius_km=1,
            sort="distance", as_of="2026-09-11T05:00:00Z",
        )
        self.assertEqual(result["total"], 1)
        self.assertLess(result["stations"][0]["distance_km"], 1)


if __name__ == "__main__":
    unittest.main()


class QuietSourceTests(unittest.TestCase):
    """A feed that answers but has no new mark is named (9 Nov 2026)."""

    def repository(self, evidence):
        temp = TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        path = Path(temp.name) / "snapshot.json"
        path.write_text(json.dumps({
            "schema_version": 1, "snapshot_at": "2026-11-09T18:36:00Z", "mode": "test",
            "stations": [{"id": "one", "network": "Test", "address": "СПб", "location": {"lat": 59.9, "lon": 30.3},
                          "source_refs": [], "evidence": evidence}],
        }), encoding="utf-8")
        return StationRepository(path)

    def test_names_feeds_whose_newest_mark_is_old_and_only_those(self):
        evidence = [
            # benzinradar.ru: newest mark 15 Sep, the rest «unknown».
            {"source": "benzinradar-analogue", "grade": "AI92", "availability": "NOT_AVAILABLE", "kind": "stale_or_crowd_status", "observed_at": "2026-09-15T18:10:08Z"},
            {"source": "benzinradar-analogue", "grade": "AI95", "availability": "UNKNOWN", "kind": "stale_or_crowd_status", "observed_at": None},
            # A feed marking now.
            {"source": "gdebenzin-net", "grade": "AI95", "availability": "AVAILABLE", "kind": "crowd_status", "observed_at": "2026-11-09T18:20:00Z"},
            # Fresh prices and catalogues say nothing about the pumps.
            {"source": "azsradar-rf", "grade": "AI95", "availability": "AVAILABLE", "kind": "crowd_status", "observed_at": "2026-11-09T15:27:00Z"},
            {"source": "azsradar-rf", "grade": "AI95", "availability": "UNKNOWN", "kind": "price", "observed_at": "2026-11-09T18:30:00Z"},
            {"source": "rosneft-ptk", "grade": "AI95", "availability": "AVAILABLE", "kind": "catalog_price", "observed_at": "2026-09-01T00:00:00Z"},
            # Card payments «now» carry no time; the group's own marks are no feed.
            {"source": "transitcard", "grade": "AI95", "availability": "AVAILABLE", "kind": "payment_projection", "observed_at": None},
            {"source": "own-eyewitness", "grade": "AI95", "availability": "AVAILABLE", "kind": "eyewitness", "observed_at": "2026-11-08T10:00:00Z"},
            # Switched off: already said in its own section.
            {"source": "yandex-maps", "grade": "AI95", "availability": "AVAILABLE", "kind": "crowd_status", "observed_at": "2026-11-06T20:47:00Z"},
        ]
        quiet = self.repository(evidence).quiet_sources({"yandex-maps"})
        self.assertEqual(quiet, [
            {"name": "benzinradar-analogue", "last_mark": "2026-09-15T18:10:08Z"},
            {"name": "azsradar-rf", "last_mark": "2026-11-09T15:27:00Z"},
        ])

    def test_meta_carries_the_quiet_list(self):
        evidence = [{"source": "2gis-benzin", "grade": "AI95", "availability": "AVAILABLE", "kind": "crowd_status", "observed_at": "2026-09-18T21:52:24Z"}]
        self.assertEqual(self.repository(evidence).collectors()["quiet"], [{"name": "2gis-benzin", "last_mark": "2026-09-18T21:52:24Z"}])
