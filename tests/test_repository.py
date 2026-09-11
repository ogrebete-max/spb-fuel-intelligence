import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from src.repository import StationRepository


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

    def test_radius_keeps_nearby_station_and_adds_distance(self):
        result = self.repository.query(
            grade="AI95", center={"lat": 59.9001, "lon": 30.3001}, radius_km=1,
            sort="distance", as_of="2026-09-11T05:00:00Z",
        )
        self.assertEqual(result["total"], 1)
        self.assertLess(result["stations"][0]["distance_km"], 1)


if __name__ == "__main__":
    unittest.main()
