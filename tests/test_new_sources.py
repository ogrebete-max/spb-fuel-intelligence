"""The five sources found on 14 Sep 2026, without the network.

2GIS «Статус АЗС», ППР TransitCard, Alfa-Bank's fuel map, азсрадар.рф and AZS
MAP: how a capture is parsed, how each status reads in the engine's words,
which copies of one observation count once, and that a source allowed only to
join a station never starts one. The samples in tests/fixtures/_live-samples
are trimmed real captures in the shape the collectors write them.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
import hashlib
import inspect
import json
from pathlib import Path
import shutil
import ssl
import sys
from tempfile import TemporaryDirectory
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))

import build_snapshot  # noqa: E402
import collectors  # noqa: E402
import refresh_live  # noqa: E402
from src.evidence_engine import _queue_shape, evaluate_grade  # noqa: E402
from src.history import station_history_id  # noqa: E402
from src.sources_maps import (  # noqa: E402
    _azsmap_brand,
    _azsradar_queue,
    normalize_2gis_benzin,
    normalize_azsmap,
    normalize_azsradar,
)
from src.sources_payments import is_moscow_night, normalize_alfa, normalize_transitcard  # noqa: E402
from src.station_filters import is_gas_only  # noqa: E402
from src.station_matcher import is_match, merge_stations  # noqa: E402


SAMPLES = ROOT / "tests" / "fixtures" / "_live-samples"
CAPTURES = ("2gis-benzin", "transitcard", "alfa-azs", "azsradar-rf", "azsmap")
NOW = datetime(2026, 9, 14, 19, 0, tzinfo=timezone.utc)
STATE_ROOT_SHA256 = "D26D2D0231B7C39F92CC738512BA54103519E4405D68B5BD703E9788CA8ECF31"
TWO_GIS_GRADE = {"AI_92": "AI92", "AI_95": "AI95", "AI_98": "AI98", "AI_100": "AI100", "DT": "DT", "GAS": "LPG"}


def sample(name: str) -> dict:
    return json.loads((SAMPLES / f"{name}.json").read_text(encoding="utf-8"))


def iso(moment: datetime) -> str:
    return moment.isoformat().replace("+00:00", "Z")


def when(value) -> datetime:
    return datetime.fromisoformat(str(value).replace("Z", "+00:00"))


def station_in(capture: dict, key: str, value: str) -> dict:
    return next(row for row in capture["stations"] if str(row.get(key)) == value)


def statuses(rows: list[dict]) -> dict[str, dict]:
    """The status rows of normalized stations, by grade."""
    return {item["grade"]: item for station in rows for item in station["evidence"] if item["kind"] != "price"}


def prices(rows: list[dict]) -> dict[str, dict]:
    return {item["grade"]: item for station in rows for item in station["evidence"] if item["kind"] == "price"}


def evidence_row(source, cluster, kind, availability, minutes_ago=None, **extra) -> dict:
    """A row as the build leaves it; no minutes means the source gave no time."""
    row = {
        "source": source, "grade": "AI95", "availability": availability, "kind": kind,
        "observed_at": None if minutes_ago is None else iso(NOW - timedelta(minutes=minutes_ago)),
        "received_at": iso(NOW - timedelta(minutes=2)), "provenance_cluster": cluster,
        "independent": False, "price_rub": None, "limit_liters": None, "queue": None, "confidence": None,
    }
    row.update(extra)
    return row


def tier(availability: str = "LIKELY_NOT", **minutes_ago: float) -> dict:
    """A tboo.ru/gpn tier whose feeds ("a", "g", "t") last saw a payment so many minutes ago."""
    stamps = {key: int((NOW - timedelta(minutes=value)).timestamp()) for key, value in minutes_ago.items()}
    return evidence_row(
        "toplivo-ryadom", "alpha+tbank+sber+2gis", "payment_prediction", availability,
        min(minutes_ago.values()), confidence={"tier": "N", "source_times": stamps},
    )


def plain_station(source, station_id, network, lat, lon, address=None) -> dict:
    return {
        "source": source, "station_id": station_id, "network": network, "address": address,
        "location": {"lat": lat, "lon": lon}, "evidence": [],
    }


def voices(result: dict) -> set[str]:
    return {vote["cluster"] for vote in result["votes"] if not vote.get("expired")}


class CollectorTests(unittest.TestCase):
    def test_each_new_capture_has_a_collector_and_feeds_its_own_source(self):
        for name in CAPTURES:
            self.assertIn(name, collectors.COLLECTORS)
            self.assertEqual(build_snapshot.CAPTURE_SOURCES[name], (name,))

    def test_the_locator_sends_columns_that_become_rows(self):
        rows = collectors.transposed_rows({
            "id": ["A1", "B2"], "latitude": [59.9, 60.0], "longitude": [30.3, 30.4],
            "status": ["has_limit", "unavailable"], "prices": [{"3": 70.1}, {}], "size": 2,
        })
        self.assertEqual(rows, [
            {"id": "A1", "latitude": 59.9, "longitude": 30.3, "status": "has_limit", "prices": {"3": 70.1}},
            {"id": "B2", "latitude": 60.0, "longitude": 30.4, "status": "unavailable", "prices": {}},
        ])

    def test_the_map_script_gives_its_stations_and_its_own_grade_labels(self):
        script = (
            "/* AZS MAP */\nconst FUEL_LABELS = { ai92:'АИ-92', ai98:'АИ-100', dt:'ДТ' };\n"
            'const STATIONS = {"osm_n1": {"brand": "Лукойл", "lat": 59.9, "lon": 30.3, '
            '"fuels": [["ai92", "have", "65,15", 12, 0, false, true, true, 30]]}};\n'
            "const STATUS_META = { have: { short:'Есть' } };"
        )
        stations, labels = collectors.parse_azsmap_model(script)
        self.assertEqual(list(stations), ["osm_n1"])
        self.assertEqual(labels, {"ai92": "АИ-92", "ai98": "АИ-100", "dt": "ДТ"})

    def test_a_page_without_the_data_model_is_a_failed_collector(self):
        with self.assertRaises(RuntimeError):
            collectors.parse_azsmap_model("<html>Технические работы</html>")
        original_dir, original = refresh_live.OUT_DIR, refresh_live.COLLECTORS["azsmap"]
        with TemporaryDirectory() as temp:
            refresh_live.OUT_DIR = Path(temp)
            refresh_live.COLLECTORS["azsmap"] = lambda: collectors.parse_azsmap_model("<html></html>")
            try:
                row = refresh_live.run_collector("azsmap")
            finally:
                refresh_live.OUT_DIR, refresh_live.COLLECTORS["azsmap"] = original_dir, original
        self.assertFalse(row["ok"])
        self.assertIn("STATIONS block is missing", row["error"])

    def test_no_driver_account_reaches_a_capture(self):
        row = {"station": {"id": "1"}, "userId": 7, "recent_ugc_reports": [{"user_id": "42", "available": True}]}
        self.assertEqual(
            collectors.without_personal_fields(row),
            {"station": {"id": "1"}, "recent_ugc_reports": [{"available": True}]},
        )
        self.assertNotIn("user", json.dumps(sample("2gis-benzin")).lower())

    def test_the_bank_columns_of_azsradar_are_left_behind(self):
        for row in sample("azsradar-rf")["stations"]:
            self.assertFalse(set(collectors.AZSRADAR_BANK_FIELDS) & set(row))

    def test_alfa_is_verified_against_the_vendored_state_root(self):
        pem = collectors.RUSSIAN_TRUSTED_ROOT.read_text(encoding="ascii")
        self.assertEqual(pem.count("BEGIN CERTIFICATE"), 1)
        self.assertEqual(hashlib.sha256(ssl.PEM_cert_to_DER_cert(pem)).hexdigest().upper(), STATE_ROOT_SHA256)
        context = collectors.alfa_tls_context()
        self.assertEqual(context.verify_mode, ssl.CERT_REQUIRED)
        self.assertTrue(context.check_hostname)
        self.assertTrue(any("Russian Trusted Root CA" in str(item.get("subject")) for item in context.get_ca_certs()))

    def test_the_state_root_is_trusted_for_that_one_request_only(self):
        # Its definition and its single use, in the Alfa-Bank collector.
        self.assertEqual(inspect.getsource(collectors).count("alfa_tls_context()"), 2)
        self.assertIn("context=alfa_tls_context()", inspect.getsource(collectors.collect_alfa))

    def test_alfa_is_read_every_other_run(self):
        self.assertGreaterEqual(refresh_live.MIN_INTERVAL_SECONDS["alfa-azs"], 15 * 60)


class TwoGisTests(unittest.TestCase):
    capture = sample("2gis-benzin")

    def normalized(self, station_id: str) -> list[dict]:
        return normalize_2gis_benzin(next(row for row in self.capture["stations"] if row["station"]["id"] == station_id))

    def test_a_timed_mark_is_a_crowd_vote_and_a_null_mark_is_nothing(self):
        checked = 0
        for row in self.capture["stations"]:
            if row.get("closed") or row.get("closed_by_schedule"):
                continue
            evidence = statuses(normalize_2gis_benzin(row))
            for fuel in row.get("fuel_statuses") or []:
                grade = TWO_GIS_GRADE[fuel["fuel_type"]]
                if fuel["available"] is None:
                    self.assertNotIn(grade, evidence)
                    continue
                item = evidence[grade]
                self.assertEqual(item["availability"], "AVAILABLE" if fuel["available"] else "NOT_AVAILABLE")
                self.assertEqual(when(item["observed_at"]), when(fuel["last_report_at"]))
                self.assertEqual(
                    (item["kind"], item["provenance_cluster"], item["independent"]),
                    ("crowd_status", "2gis-benzin", True),
                )
                checked += 1
        self.assertGreaterEqual(checked, 10)

    def test_queue_and_limit_come_with_a_positive_mark(self):
        rows = self.normalized("5348552840320026")
        evidence = statuses(rows)
        diesel = evidence["DT"]
        self.assertEqual((diesel["availability"], diesel["queue"], diesel["limit_liters"]), ("AVAILABLE", "up_to_25", 30.0))
        self.assertEqual((evidence["AI92"]["queue"], evidence["AI92"]["limit_liters"]), (None, None))
        result = evaluate_grade(rows[0]["evidence"], "DT", now=when(diesel["observed_at"]) + timedelta(minutes=5))
        self.assertEqual(result["status"], "LIMITED")
        self.assertEqual(
            (result["queue"]["cars_from"], result["queue"]["cars_to"], result["queue"]["label"]),
            (1, 25, "до 25 машин"),
        )
        self.assertEqual(result["limit_liters"], 30.0)

    def test_the_other_queue_sizes(self):
        self.assertEqual((_queue_shape("from_25_to_50")["cars_from"], _queue_shape("from_25_to_50")["cars_to"]), (25, 50))
        self.assertEqual((_queue_shape("over_50")["cars_from"], _queue_shape("over_50")["cars_to"]), (50, None))

    def test_a_station_closed_by_its_schedule_sends_nobody(self):
        evidence = statuses(self.normalized("5348552840937875"))
        self.assertEqual(evidence["DT"]["availability"], "UNKNOWN")
        self.assertIn("closed by its schedule", evidence["DT"]["note"])
        self.assertIsNone(evidence["DT"]["queue"])
        self.assertEqual(evidence["AI95"]["availability"], "NOT_AVAILABLE")

    def test_a_gas_pump_is_left_off_the_map(self):
        station = merge_stations(self.normalized("70000001048312883"))[0]
        self.assertEqual({item["grade"] for item in station["evidence"]}, {"LPG"})
        self.assertTrue(is_gas_only(station))

    def test_its_prices_share_one_cluster_with_alfa(self):
        quotes = prices(self.normalized("5348552838746363"))
        self.assertTrue(quotes)
        self.assertEqual({item["provenance_cluster"] for item in quotes.values()}, {"alfa-2gis-price"})

    def test_gdebenzin_and_tboo_repeat_2gis_and_count_as_2gis(self):
        mark = evidence_row("2gis-benzin", "2gis-benzin", "crowd_status", "AVAILABLE", 20, independent=True)
        relay = evidence_row("gdebenzin", "gdebenzin:2gis", "aggregated_status", "AVAILABLE", 5)
        result = evaluate_grade([mark, relay, tier(g=20)], "AI95", now=NOW)
        self.assertEqual(voices(result), {"2gis-benzin"})
        self.assertEqual(result["fresh_provenance_count"], 1)

    def test_2gis_ids_match_the_sber_feed_and_the_gdebenzin_relay(self):
        gis = plain_station("2gis-benzin", "5348552838601946", "Роснефть, АЗС", 59.9081, 30.3040)
        sber = plain_station("sber", "5348552838601946", "Роснефть", 59.9090, 30.3040)
        relay = plain_station("gdebenzin", "2gis:5348552838601946", "Rosneft", 59.9072, 30.3040)
        self.assertEqual(is_match(gis, sber), (True, "explicit_upstream_id"))
        self.assertEqual(is_match(relay, gis), (True, "explicit_upstream_id"))


class TransitCardTests(unittest.TestCase):
    capture = sample("transitcard")

    def normalized(self, station_id: str, captured_at) -> dict[str, dict]:
        return statuses(normalize_transitcard(station_in(self.capture, "id", station_id), captured_at))

    def test_card_sales_by_day(self):
        # Captured at 21:50 Moscow time.
        evidence = self.normalized("3667CCD14C044701E053034A14AC6B2D", self.capture["captured_at"])
        self.assertEqual(
            {grade: item["availability"] for grade, item in evidence.items()},
            {"AI92": "LIKELY_NOT", "AI95": "LIKELY_NOT", "AI100": "LIKELY_NOT", "DT": "LIMITED"},
        )
        for item in evidence.values():
            self.assertIsNone(item["observed_at"])
            self.assertIsNone(item["limit_liters"])
            self.assertEqual(
                (item["kind"], item["provenance_cluster"], item["independent"]),
                ("payment_projection", "transitcard-payments", False),
            )

    def test_at_night_a_quiet_grade_is_not_an_empty_one(self):
        # 01:30 Moscow time.
        night = self.normalized("3667CCD14C044701E053034A14AC6B2D", "2026-09-14T22:30:00Z")
        self.assertEqual({grade: item["availability"] for grade, item in night.items()}, {"DT": "LIMITED"})
        # With no capture time, night cannot be told from day.
        self.assertEqual(set(self.normalized("3667CCD14C044701E053034A14AC6B2D", None)), {"DT"})

    def test_night_is_from_2300_to_0700_moscow_time(self):
        self.assertFalse(is_moscow_night(datetime(2026, 9, 14, 19, 59, tzinfo=timezone.utc)))
        self.assertTrue(is_moscow_night(datetime(2026, 9, 14, 20, 0, tzinfo=timezone.utc)))
        self.assertTrue(is_moscow_night(datetime(2026, 9, 15, 3, 59, tzinfo=timezone.utc)))
        self.assertFalse(is_moscow_night(datetime(2026, 9, 15, 4, 0, tzinfo=timezone.utc)))

    def test_too_few_transactions_is_no_statement(self):
        self.assertEqual(self.normalized("3667CCD167F84701E053034A14AC6B2D", self.capture["captured_at"]), {})
        selling = self.normalized("37D4D07BCC3EB6BAE063024A14ACBDBA", self.capture["captured_at"])
        self.assertEqual({grade: item["availability"] for grade, item in selling.items()},
                         {"AI92": "AVAILABLE", "AI95": "AVAILABLE", "DT": "AVAILABLE"})

    def test_an_undated_status_votes_but_never_sets_the_age_on_a_card(self):
        undated = evaluate_grade(
            [evidence_row("transitcard", "transitcard-payments", "payment_projection", "AVAILABLE")], "AI95", now=NOW)
        self.assertNotEqual(undated["status"], "NO_FRESH_DATA")
        self.assertIsNone(undated["updated_at"])
        self.assertIsNone(undated["age_seconds"])
        self.assertTrue(undated["undated_only"])
        self.assertTrue(undated["votes"][0]["undated"])
        dated = evaluate_grade([evidence_row("yandex-maps", "yandex-crowd", "crowd_status", "AVAILABLE", 10)], "AI95", now=NOW)
        self.assertFalse(dated["votes"][0]["undated"])

    def test_a_status_agreeing_with_alfa_counts_once_and_keeps_its_limit(self):
        alfa = evidence_row("alfa-azs", "alfa-payments", "payment_projection", "AVAILABLE")
        card = evidence_row("transitcard", "transitcard-payments", "payment_projection", "LIMITED")
        crowd = evidence_row("yandex-maps", "yandex-crowd", "crowd_status", "AVAILABLE", 10, independent=True)
        result = evaluate_grade([alfa, card, crowd], "AI95", now=NOW)
        self.assertEqual(voices(result), {"alfa-payments", "yandex-crowd"})
        self.assertEqual(result["status"], "LIMITED")

    def test_polled_later_it_does_not_erase_alfas_litre_limit(self):
        alfa = evidence_row("alfa-azs", "alfa-payments", "payment_projection", "AVAILABLE", limit_liters=30.0,
                            received_at=iso(NOW - timedelta(minutes=12)))
        card = evidence_row("transitcard", "transitcard-payments", "payment_projection", "AVAILABLE",
                            received_at=iso(NOW - timedelta(minutes=1)))
        result = evaluate_grade([alfa, card], "AI95", now=NOW)
        self.assertEqual(voices(result), {"alfa-payments"})
        self.assertEqual(result["limit_liters"], 30.0)
        self.assertEqual([vote["source"] for vote in result["votes"]], ["alfa-azs"])

    def test_a_status_disagreeing_with_alfa_keeps_its_voice(self):
        alfa = evidence_row("alfa-azs", "alfa-payments", "payment_projection", "AVAILABLE")
        card = evidence_row("transitcard", "transitcard-payments", "payment_projection", "LIKELY_NOT")
        self.assertEqual(voices(evaluate_grade([alfa, card], "AI95", now=NOW)), {"alfa-payments", "transitcard-payments"})


class AlfaTests(unittest.TestCase):
    capture = sample("alfa-azs")

    def normalized(self, station_id: str) -> list[dict]:
        return normalize_alfa(station_in(self.capture, "station_id", station_id), self.capture["captured_at"])

    def verdicts(self, station_id: str) -> dict[str, tuple]:
        return {grade: (item["availability"], item["limit_liters"]) for grade, item in statuses(self.normalized(station_id)).items()}

    def test_sales_on_and_sales_stopped_with_the_stations_limits(self):
        self.assertEqual(
            self.verdicts("01363062-9271-4654-a350-60d1cd6a53d9"),
            {"AI92": ("AVAILABLE", 50.0), "AI95": ("AVAILABLE", 30.0), "DT": ("AVAILABLE", None)},
        )
        self.assertEqual(
            self.verdicts("a3b6ec85-9f67-4d6c-9c2d-c7f6330e2cc6"),
            {"AI92": ("NOT_AVAILABLE", None), "AI95": ("NOT_AVAILABLE", None), "DT": ("NOT_AVAILABLE", None)},
        )
        # A limit belongs to a grade on sale; a stop of in-app payments is not a stock fact.
        self.assertEqual(
            self.verdicts("055de126-fbeb-4d01-8fae-6ef62485cfd9"),
            {"AI92": ("NOT_AVAILABLE", None), "AI95": ("NOT_AVAILABLE", None), "DT": ("AVAILABLE", 40.0)},
        )
        teboil = statuses(self.normalized("07ab18b1-016f-49b0-8982-5b47698e2741"))
        self.assertEqual({item["availability"] for item in teboil.values()}, {"AVAILABLE"})
        self.assertEqual(teboil["AI92"]["confidence"]["sales_stopped_for"], ["mobile"])

    def test_silence_closed_payments_and_the_98_100_bucket_say_nothing(self):
        self.assertEqual(self.verdicts("013ea4c1-8f1b-44a6-b18f-bb6565219eac"), {"DT": ("AVAILABLE", None)})
        self.assertEqual(self.verdicts("035997ba-88c5-4593-8421-57005f7ac424"), {})
        self.assertEqual(self.verdicts("06dd70ba-cf86-46f6-bf87-1972890c7aab"), {})
        for row in self.capture["stations"]:
            grades = {item["grade"] for station in normalize_alfa(row, self.capture["captured_at"]) for item in station["evidence"]}
            self.assertFalse(grades & {"AI98", "AI100"})

    def test_a_verdict_has_no_time_but_keeps_the_last_payment(self):
        evidence = statuses(self.normalized("01363062-9271-4654-a350-60d1cd6a53d9"))
        for item in evidence.values():
            self.assertIsNone(item["observed_at"])
            self.assertEqual(
                (item["kind"], item["provenance_cluster"], item["independent"]),
                ("payment_projection", "alfa-payments", False),
            )
        self.assertEqual(evidence["AI95"]["confidence"]["last_transaction_at"], "2026-09-14T15:53:13Z")

    def test_a_price_is_only_as_recent_as_a_payment_made_at_it(self):
        quotes = prices(self.normalized("01363062-9271-4654-a350-60d1cd6a53d9"))
        self.assertEqual((quotes["AI92"]["price_rub"], when(quotes["AI92"]["observed_at"])), (65.15, when("2026-09-14T10:59:49Z")))
        self.assertEqual(quotes["AI92"]["provenance_cluster"], "alfa-2gis-price")
        # 92 and 95 were last paid for days before the capture there.
        self.assertEqual(set(prices(self.normalized("013ea4c1-8f1b-44a6-b18f-bb6565219eac"))), {"DT"})
        self.assertEqual(prices(self.normalized("035997ba-88c5-4593-8421-57005f7ac424")), {})

    def test_the_same_price_from_2gis_is_not_a_second_quote(self):
        rows = [
            evidence_row("alfa-azs", "alfa-2gis-price", "price", "UNKNOWN", 30, price_rub=70.4),
            evidence_row("2gis-benzin", "alfa-2gis-price", "price", "UNKNOWN", 45, price_rub=70.4),
        ]
        self.assertEqual(evaluate_grade(rows, "AI95", now=NOW)["price_sources"], 1)


class TbooTierTests(unittest.TestCase):
    alfa = evidence_row("alfa-azs", "alfa-payments", "payment_projection", "AVAILABLE")

    def test_a_tier_built_on_alfas_payment_counts_as_alfa_and_cannot_contradict_it(self):
        result = evaluate_grade([self.alfa, tier(a=10)], "AI95", now=NOW)
        self.assertEqual(voices(result), {"alfa-payments"})
        self.assertIsNone(result["disagreement"])

    def test_without_alfa_the_tier_keeps_its_voice(self):
        self.assertEqual(voices(evaluate_grade([tier(a=10)], "AI95", now=NOW)), {"mixed-bank-payments"})

    def test_the_feed_behind_the_newest_time_decides(self):
        tbank = evidence_row("tbank-fuel", "tbank-payments", "payment_projection", "AVAILABLE", 8)
        self.assertEqual(
            voices(evaluate_grade([self.alfa, tbank, tier(a=200, t=8)], "AI95", now=NOW)),
            {"alfa-payments", "tbank-payments"},
        )
        # T-Bank is not read for this grade here, so the tier is more than Alfa.
        self.assertEqual(
            voices(evaluate_grade([self.alfa, tier(a=200, t=8)], "AI95", now=NOW)),
            {"alfa-payments", "mixed-bank-payments"},
        )

    def test_a_tier_with_no_time_at_all_is_no_statement(self):
        row = build_snapshot.prediction_row({
            "b": "ЛУКОЙЛ", "la": 59.9, "lo": 30.3, "a": "Невский пр., 1",
            "f": {"100": {"t": "N"}, "95": {"t": "N", "src": {"a": 1789405000, "t": 1789405600}}},
        })
        by_grade = {item["grade"]: item for item in row["evidence"]}
        self.assertEqual(by_grade["AI100"]["availability"], "UNKNOWN")
        self.assertEqual(by_grade["AI95"]["availability"], "LIKELY_NOT")
        self.assertEqual(by_grade["AI95"]["confidence"]["source_times"], {"a": 1789405000, "t": 1789405600})


class AzsradarTests(unittest.TestCase):
    capture = sample("azsradar-rf")

    def normalized(self, station_id: str, row: dict | None = None) -> list[dict]:
        return normalize_azsradar(row or station_in(self.capture, "id", station_id), self.capture["captured_at"])

    def test_the_sites_own_marks_with_queue_and_limit(self):
        rows = self.normalized("18895")
        evidence = statuses(rows)
        self.assertEqual({grade: item["availability"] for grade, item in evidence.items()},
                         {"AI92": "AVAILABLE", "AI95": "AVAILABLE", "DT": "AVAILABLE"})
        self.assertEqual((evidence["AI95"]["queue"], evidence["AI95"]["limit_liters"]), ("gt20", 30.0))
        self.assertEqual(when(evidence["AI95"]["observed_at"]), when("2026-09-14T18:43:47.340Z"))
        self.assertEqual((evidence["AI95"]["provenance_cluster"], evidence["AI95"]["independent"]), ("azsradar-crowd", True))
        self.assertEqual(rows[0]["network"], "Роснефть")
        empty = statuses(self.normalized("21315"))
        self.assertEqual({grade: item["availability"] for grade, item in empty.items()},
                         {"AI92": "NOT_AVAILABLE", "AI95": "NOT_AVAILABLE", "AI98": "NOT_AVAILABLE", "DT": "AVAILABLE"})
        self.assertIsNone(empty["AI92"]["queue"])

    def test_queue_words(self):
        self.assertEqual(
            [_azsradar_queue(text) for text in ("Нет", None, "До 5 машин", "5–20 машин", "Больше 20 машин", "очередь")],
            [None, None, "lt5", "5_20", "gt20", "reported"],
        )
        shape = _queue_shape("gt20")
        self.assertEqual((shape["cars_from"], shape["cars_to"], shape["label"]), (20, None, "больше 20 машин"))

    def test_no_data_is_no_statement(self):
        self.assertEqual(statuses(self.normalized("21128")), {})

    def test_a_technical_break_sends_nobody_until_it_ends(self):
        row = dict(station_in(self.capture, "id", "18895"), break_until="2026-09-14T19:30:00Z")
        on_break = statuses(self.normalized("18895", row))
        self.assertEqual({item["availability"] for item in on_break.values()}, {"UNKNOWN"})
        self.assertIn("technical break", on_break["AI95"]["note"])
        row["break_until"] = "2026-09-14T18:00:00Z"
        self.assertEqual({item["availability"] for item in statuses(self.normalized("18895", row)).values()}, {"AVAILABLE"})


class AzsmapTests(unittest.TestCase):
    capture = sample("azsmap")

    def normalized(self, key: str, labels: dict | None = None) -> list[dict]:
        row = station_in(self.capture, "key", key)
        return normalize_azsmap(row, self.capture["captured_at"], self.capture["fuel_labels"] if labels is None else labels)

    def test_a_mark_is_dated_by_its_age_in_minutes(self):
        evidence = statuses(self.normalized("osm_w699101085"))
        self.assertEqual({grade: item["availability"] for grade, item in evidence.items()}, {"AI92": "AVAILABLE", "AI95": "AVAILABLE"})
        self.assertEqual(when(evidence["AI92"]["observed_at"]), when(self.capture["captured_at"]) - timedelta(minutes=24))
        self.assertEqual((evidence["AI92"]["kind"], evidence["AI92"]["provenance_cluster"]), ("crowd_status", "azsmap-crowd"))

    def test_running_out_is_limited_and_no_data_is_nothing(self):
        self.assertEqual({item["availability"] for item in statuses(self.normalized("osm_w125082268")).values()}, {"LIMITED"})
        self.assertEqual(statuses(self.normalized("ya_3152388637")), {})

    def test_the_label_the_site_shows_decides_the_grade(self):
        # The key "ai98" is shown to drivers as АИ-100, and they mark what they see.
        marked = statuses(self.normalized("osm_n4246253678"))
        self.assertEqual(marked["AI100"]["availability"], "NOT_AVAILABLE")
        self.assertNotIn("AI98", marked)
        self.assertIn("AI98", statuses(self.normalized("osm_n4246253678", labels={"ai98": "АИ-98"})))

    def test_its_prices_are_the_gdebenz_feed(self):
        quotes = prices(self.normalized("osm_w699101085"))
        self.assertEqual({grade: item["price_rub"] for grade, item in quotes.items()}, {"AI92": 65.35, "AI95": 69.9, "DT": 81.25})
        self.assertEqual({item["provenance_cluster"] for item in quotes.values()}, {"gdebenz-price-unknown-upstream"})
        self.assertEqual(when(quotes["DT"]["observed_at"]), when(self.capture["captured_at"]) - timedelta(minutes=769))

    def test_a_slug_brand_is_read_as_words(self):
        self.assertEqual(_azsmap_brand("kirishi_oyl"), "kirishi oyl")
        self.assertIsNone(_azsmap_brand("azs"))
        self.assertIsNone(_azsmap_brand("АЗС"))
        self.assertEqual(_azsmap_brand("Роснефть"), "Роснефть")

    def test_a_mark_that_agrees_with_gdebenz_counts_as_gdebenz(self):
        gdebenz = evidence_row("gdebenz", "gdebenz-crowd", "undated_crowd_summary", "LIKELY", independent=True)
        mark = evidence_row("azsmap", "azsmap-crowd", "crowd_status", "AVAILABLE", 10, independent=True)
        agreed = evaluate_grade([gdebenz, mark], "AI95", now=NOW)
        self.assertEqual(voices(agreed), {"gdebenz-crowd"})
        # The copy that carries a time now dates the ГдеБЕНЗ answer.
        self.assertEqual(when(agreed["updated_at"]), NOW - timedelta(minutes=10))
        disagreed = evaluate_grade([dict(gdebenz, availability="LIKELY_NOT"), mark], "AI95", now=NOW)
        self.assertEqual(voices(disagreed), {"gdebenz-crowd", "azsmap-crowd"})

    def test_its_osm_and_yandex_cards_match_by_id(self):
        card = plain_station("azsmap", "osm_w699101085", None, 59.97325, 31.01685)
        self.assertEqual(
            is_match(card, plain_station("gdebenz", "699101085", "Роснефть", 59.97330, 31.01700)),
            (True, "explicit_upstream_id"),
        )
        self.assertFalse(is_match(card, plain_station("gdebenz", "699101085", "Роснефть", 59.97700, 31.01685))[0])
        yandex = plain_station("azsmap", "ya_1066014953", "kirishi oyl", 59.95, 30.30)
        self.assertEqual(
            is_match(yandex, plain_station("yandex-maps", "1066014953", "Кириши", 59.9504, 30.30)),
            (True, "explicit_upstream_id"),
        )


class BuildTests(unittest.TestCase):
    AT = "2026-09-14T18:55:00Z"

    def raw_dir(self, root: Path, at: str, *, missing=(), failed=()) -> Path:
        raw = root / "live"
        raw.mkdir(exist_ok=True)
        (raw / "phase0-analysis.json").write_text(json.dumps({"generated_at": at}), encoding="utf-8")
        for name in CAPTURES:
            target = raw / f"{name}.json"
            if name in missing:
                target.unlink(missing_ok=True)
            else:
                shutil.copyfile(SAMPLES / f"{name}.json", target)
        # ГдеБЕНЗ lists the forecourt of one AZS MAP card under its OSM id.
        card = station_in(sample("azsmap"), "key", "osm_w699101085")
        (raw / "gdebenz-full-aoi.json").write_text(json.dumps([{
            "osm_id": "699101085", "name": "Роснефть", "brand": "Роснефть", "addr": "улица Рабочего Батальона",
            "lat": card["lat"], "lon": card["lon"], "status": "yes", "fuels_now": "92,95",
            "prices_now": {}, "meta": {"f": ["92", "95", "ДТ"]},
        }], ensure_ascii=False), encoding="utf-8")
        (raw / "full-aoi-probe-results.json").write_text(json.dumps([
            {"name": name, "ok": name not in failed, "captured_at": at,
             "error": "TimeoutError: timed out" if name in failed else None}
            for name in (*CAPTURES, "gdebenz-full-aoi")
        ]), encoding="utf-8")
        return raw

    def test_the_new_captures_feed_the_snapshot_and_azsmap_only_joins(self):
        with TemporaryDirectory() as temp:
            snapshot = build_snapshot.build(self.raw_dir(Path(temp), self.AT))
        for name in CAPTURES:
            self.assertGreater(snapshot["stats"]["source_rows"].get(name, 0), 0, name)
        self.assertFalse(any(
            {ref["source"] for ref in station["source_refs"]} <= {"azsmap"} for station in snapshot["stations"]
        ))
        joined = next(
            station for station in snapshot["stations"]
            if {"source": "gdebenz", "station_id": "699101085"} in station["source_refs"]
        )
        self.assertIn({"source": "azsmap", "station_id": "osm_w699101085"}, joined["source_refs"])
        self.assertEqual(voices(evaluate_grade(joined["evidence"], "AI92", now=when(self.AT))), {"gdebenz-crowd"})

    def test_a_new_collector_that_fails_keeps_its_stations_on_the_map(self):
        with TemporaryDirectory() as temp:
            root = Path(temp)
            catalogue = root / "last-seen.json"
            before = build_snapshot.build(self.raw_dir(root, self.AT), last_seen_path=catalogue)
            during = build_snapshot.build(
                self.raw_dir(root, "2026-09-14T19:05:00Z", missing=("2gis-benzin",), failed=("2gis-benzin",)),
                last_seen_path=catalogue,
            )
        self.assertEqual(during["stats"]["canonical_stations"], before["stats"]["canonical_stations"])
        self.assertGreater(during["stats"].get("stations_kept_while_sources_fail", 0), 0)
        self.assertTrue(any("2gis-benzin" in station.get("failing_sources", []) for station in during["stations"]))

    def test_a_methane_station_from_alfas_list_is_left_off_the_map(self):
        # Alfa-Bank lists Gazprom's methane stations as «Газпром ГМТ», with the
        # petrol grades every station in its list carries.
        station = {"network": "Газпром ГМТ", "evidence": [
            evidence_row("alfa-azs", "alfa-payments", "payment_projection", "NOT_AVAILABLE", grade="AI95"),
        ]}
        self.assertTrue(is_gas_only(station))
        self.assertFalse(is_gas_only({"network": "Газпромнефть", "evidence": station["evidence"]}))

    def test_a_station_a_new_source_joins_keeps_its_history_id(self):
        refs = [
            {"source": "yandex-maps", "station_id": "1"},
            {"source": "2gis-benzin", "station_id": "5348552838601946"},
            {"source": "azsmap", "station_id": "osm_n1"},
        ]
        self.assertEqual(station_history_id({"source_refs": refs}), "yandex-maps:1")


if __name__ == "__main__":
    unittest.main()
