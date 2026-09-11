from __future__ import annotations

import json
from pathlib import Path
import sys
import unittest


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from src.normalizers import (  # noqa: E402
    ALLOWED_AVAILABILITY,
    canonical_grade,
    normalize_fixture,
    normalize_gazpromneft,
)


FIXTURES = ROOT / "tests" / "fixtures"


def load(name: str) -> dict:
    return json.loads((FIXTURES / name / "2026-09-11-spb.json").read_text(encoding="utf-8"))


def rows(name: str) -> list[dict]:
    return normalize_fixture(load(name))


def evidence(name: str) -> list[dict]:
    return [item for station in rows(name) for item in station["evidence"]]


class GradeTests(unittest.TestCase):
    def test_grade_aliases(self) -> None:
        self.assertEqual(canonical_grade("АИ-92"), "AI92")
        self.assertEqual(canonical_grade("G-95"), "AI95")
        self.assertEqual(canonical_grade("АИ 98 ЭКТО"), "AI98")
        self.assertEqual(canonical_grade("100+"), "AI100")
        self.assertEqual(canonical_grade("ДТл"), "DT")


class SemanticsTests(unittest.TestCase):
    def test_sber_stale_false_is_unknown_not_no(self) -> None:
        items = {e["grade"]: e for e in evidence("sber")}
        self.assertEqual(items["AI92"]["availability"], "AVAILABLE")
        self.assertEqual(items["AI95"]["availability"], "UNKNOWN")
        self.assertEqual(items["AI95"]["raw_status"], "stale")
        self.assertEqual(items["AI92"]["limit_liters"], 40.0)

    def test_gazpromneft_has_explicit_current_stock_and_price(self) -> None:
        items = evidence("gazpromneft")
        self.assertTrue(any(e["grade"] == "DT" and e["availability"] == "AVAILABLE" for e in items))
        self.assertTrue(any(e["grade"] == "AI92" and e["availability"] == "NOT_AVAILABLE" for e in items))
        self.assertTrue(all(e["kind"] == "official_stock" for e in items))
        self.assertTrue(all(e["price_rub"] is not None for e in items))

    def test_gazpromneft_empty_rest_array_is_unknown(self) -> None:
        body = load("gazpromneft")["body"]
        body["fuel_detail"]["data"][0]["rest"] = []
        item = next(e for e in normalize_gazpromneft(body)[0]["evidence"] if e["grade"] == "AI95")
        # The second AI95 variant is explicitly unavailable, so the aggregate
        # remains a real negative rather than becoming UNKNOWN.
        self.assertEqual(item["availability"], "NOT_AVAILABLE")

        body["fuel_detail"]["data"][3]["rest"] = []
        item = next(e for e in normalize_gazpromneft(body)[0]["evidence"] if e["grade"] == "AI95")
        self.assertEqual(item["availability"], "UNKNOWN")
        self.assertIsNone(item["raw_status"])

    def test_gazpromneft_any_available_variant_wins_and_sets_price(self) -> None:
        body = load("gazpromneft")["body"]
        body["fuel_detail"]["data"][3]["rest"]["avail"] = True
        items = [e for e in normalize_gazpromneft(body)[0]["evidence"] if e["grade"] == "AI95"]
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["availability"], "AVAILABLE")
        self.assertEqual(items[0]["price_rub"], 72.52)

    def test_lukoil_and_teboil_catalog_never_becomes_stock(self) -> None:
        self.assertTrue(evidence("lukoil"))
        self.assertTrue(evidence("teboil"))
        self.assertTrue(all(e["availability"] == "UNKNOWN" for e in evidence("lukoil")))
        self.assertTrue(all(e["availability"] == "UNKNOWN" for e in evidence("teboil")))

    def test_gdebenz_preserves_queue_limit_and_on_site(self) -> None:
        items = evidence("gdebenz")
        limited_queue = [e for e in items if e["availability"] == "QUEUE" and e["limit_liters"] == 30.0]
        self.assertTrue(limited_queue)
        self.assertTrue(any(e["confidence"]["on_site"] for e in limited_queue))

    def test_benzas_keeps_benzuber_price_separate_from_crowd(self) -> None:
        items = evidence("benzas")
        price = [e for e in items if e["kind"] == "price"]
        crowd = [e for e in items if e["kind"] == "crowd_report"]
        self.assertTrue(price and crowd)
        self.assertTrue(all(e["availability"] == "UNKNOWN" for e in price))
        self.assertTrue(all(e["provenance_cluster"] == "price:benzuber" for e in price))

    def test_benzinest_marks_imported_as_dependent(self) -> None:
        items = evidence("benzinest")
        self.assertTrue(any(e["availability"] == "NOT_AVAILABLE" for e in items))
        self.assertTrue(all(e["independent"] is False for e in items))
        self.assertTrue(all(e["provenance_cluster"] == "benzinest-imported-mixed" for e in items))

    def test_tutbenz_generic_payment_is_only_likely(self) -> None:
        items = evidence("tutbenz")
        payment = [e for e in items if e["kind"] == "payment_projection" and e["raw_status"] == "has"]
        self.assertTrue(payment)
        self.assertTrue(all(e["availability"] == "LIKELY" for e in payment))
        self.assertFalse(any(e["availability"] == "AVAILABLE" for e in payment))

    def test_gdebenzin_payment_prefix_is_indirect(self) -> None:
        items = evidence("gdebenzin")
        self.assertTrue(items)
        self.assertTrue(all(e["kind"] == "payment_projection" for e in items))
        self.assertTrue(all(e["availability"] == "LIKELY" for e in items))
        self.assertTrue(all(e["independent"] is False for e in items))

    def test_benzonavt_separates_fuels_in_and_out(self) -> None:
        items = {e["grade"]: e for e in evidence("benzonavt")}
        self.assertEqual(items["DT"]["availability"], "AVAILABLE")
        self.assertEqual(items["AI92"]["availability"], "NOT_AVAILABLE")
        self.assertEqual(items["AI92"]["limit_liters"], 30.0)

    def test_benzinkarta_free_reveal_has_station_grade_status(self) -> None:
        items = {e["grade"]: e for e in evidence("benzinkarta")}
        self.assertEqual(items["AI92"]["availability"], "AVAILABLE")
        self.assertEqual(items["AI95"]["availability"], "AVAILABLE")
        self.assertGreater(items["AI95"]["price_rub"], 0)

    def test_official_price_catalogs_are_unknown_for_stock(self) -> None:
        for name in ("rosneft-ptk", "tatneft", "kirishiavtoservis"):
            with self.subTest(source=name):
                items = evidence(name)
                self.assertTrue(items)
                self.assertTrue(all(e["availability"] == "UNKNOWN" for e in items))

    def test_toplivo_distinguishes_network_claim_from_prediction(self) -> None:
        station = rows("toplivo-ryadom")[0]
        self.assertTrue(any(e["kind"] == "network_claim_aggregated" for e in station["evidence"]))
        prediction = station["related_prediction"]
        self.assertTrue(prediction["evidence"])
        self.assertTrue(all(e["availability"] != "AVAILABLE" for e in prediction["evidence"]))

    def test_stale_benzinradar_is_unknown(self) -> None:
        items = evidence("benzinradar-analogue")
        self.assertTrue(items)
        self.assertTrue(all(e["availability"] == "UNKNOWN" for e in items))

    def test_all_emitted_statuses_are_in_enum(self) -> None:
        names = [p.name for p in FIXTURES.iterdir() if p.is_dir() and not p.name.startswith("_")]
        for name in names:
            with self.subTest(source=name):
                for item in evidence(name):
                    self.assertIn(item["availability"], ALLOWED_AVAILABILITY)


if __name__ == "__main__":
    unittest.main()
