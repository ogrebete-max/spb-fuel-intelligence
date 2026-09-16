from __future__ import annotations

import unittest

from src.station_filters import drop_broken_names, has_broken_name, is_gas_only, is_not_a_station


class BrokenNames(unittest.TestCase):
    def test_a_name_broken_into_replacement_characters_is_dropped(self):
        self.assertTrue(has_broken_name({"network": "��итекс"}))

    def test_readable_and_missing_names_stay(self):
        kept = drop_broken_names([{"network": "Лукойл"}, {"network": None}, {"network": "��гзс"}])
        self.assertEqual([station["network"] for station in kept], ["Лукойл", None])


def refs(*pairs):
    return [{"source": source, "station_id": station_id} for source, station_id in pairs]


class NotStations(unittest.TestCase):
    def test_the_palace_square_row_is_dropped(self):
        self.assertTrue(is_not_a_station({
            "network": "Татнефт", "location": {"lat": 59.93841051, "lon": 30.31793157},
            "source_refs": refs(("gdebenzin24", "753179155")),
        }))

    def test_the_same_point_under_a_new_id_is_dropped(self):
        self.assertTrue(is_not_a_station({
            "network": "Татнефть", "location": {"lat": 59.9385, "lon": 30.3181},
            "source_refs": refs(("gdebenzin24", "999")),
        }))

    def test_a_row_another_feed_confirms_stays(self):
        self.assertFalse(is_not_a_station({
            "network": "Татнефть", "location": {"lat": 59.9384, "lon": 30.3179},
            "source_refs": refs(("gdebenzin24", "753179155"), ("sber", "1")),
        }))

    def test_the_centre_pins_one_feed_alone_listed_are_dropped(self):
        for network, source, station_id, lat, lon in (
            ("Татнефть", "gdebenzin24", "370250522", 59.93996605, 30.31994820),
            ("Газпромнефть", "gdezapravka", "110209", 59.93308, 30.31371),
            ("Росснефть", "gdebenzin24", "552637759", 59.93840617, 30.32684684),
            ("teboil", "gdebenzin24", "17260", 59.928068, 30.305645),
            ("Газпром", "gdebenzin24", "1055924600", 59.9215729, 30.3422008),
            ("трансазс", "gdebenzin24", "134761076", 59.940839, 30.357415),
            ("Автокондиционеры", "gdezapravka", "110219", 59.941772, 30.281453),
        ):
            with self.subTest(network):
                self.assertTrue(is_not_a_station({
                    "network": network, "location": {"lat": lat, "lon": lon},
                    "source_refs": refs((source, station_id)),
                }))

    def test_an_ordinary_station_stays(self):
        self.assertFalse(is_not_a_station({
            "network": "Роснефть", "location": {"lat": 59.7256, "lon": 30.3995},
            "source_refs": refs(("gdebenzin24", "1")),
        }))


def station(network, *evidence):
    return {"network": network, "evidence": [
        {"grade": grade, "availability": availability, "source": source}
        for grade, availability, source in evidence
    ]}


class GasOnlyStations(unittest.TestCase):
    def test_lpg_only_evidence_is_dropped_whatever_the_name(self):
        self.assertTrue(is_gas_only(station("Бетон", ("LPG", "AVAILABLE", "gdebenzin24"))))

    def test_gas_named_station_with_template_rows_is_dropped(self):
        self.assertTrue(is_gas_only(station(
            "Газпром газомоторное топливо, АГНКС",
            ("AI92", "UNKNOWN", "benzinest"), ("AI95", "UNKNOWN", "gdebenzfuel"), ("DT", "UNKNOWN", "gdebenzi"),
        )))

    def test_one_feed_is_not_enough_to_call_a_gas_pump_a_petrol_station(self):
        self.assertTrue(is_gas_only(station("АГЗС", ("AI95", "NOT_AVAILABLE", "benzinest"))))

    def test_a_named_gas_pump_goes_even_with_petrol_template_rows(self):
        self.assertTrue(is_gas_only(station(
            "Пропан, АГЗС", ("AI95", "NOT_AVAILABLE", "benzinest"), ("AI92", "AVAILABLE", "gdebenzfuel"),
        )))

    def test_gas_network_forecourt_with_real_petrol_reports_stays(self):
        self.assertFalse(is_gas_only(station(
            "Митекс", ("AI95", "AVAILABLE", "benzonavt"), ("AI92", "AVAILABLE", "gdebenzin24"), ("DT", "AVAILABLE", "tbank-fuel"),
        )))

    def test_oil_company_name_containing_gaz_is_not_a_gas_pump(self):
        self.assertFalse(is_gas_only(station("Сургутнефтегаз, заправочная станция")))

    def test_ordinary_station_without_evidence_stays(self):
        self.assertFalse(is_gas_only(station("Лукойл")))


if __name__ == "__main__":
    unittest.main()
