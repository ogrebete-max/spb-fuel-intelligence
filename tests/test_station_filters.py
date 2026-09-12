from __future__ import annotations

import unittest

from src.station_filters import is_gas_only


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

    def test_gas_network_forecourt_with_real_petrol_reports_stays(self):
        self.assertFalse(is_gas_only(station(
            "Митекс", ("AI95", "AVAILABLE", "benzonavt"), ("AI92", "AVAILABLE", "gdebenzin24"),
        )))

    def test_oil_company_name_containing_gaz_is_not_a_gas_pump(self):
        self.assertFalse(is_gas_only(station("Сургутнефтегаз, заправочная станция")))

    def test_ordinary_station_without_evidence_stays(self):
        self.assertFalse(is_gas_only(station("Лукойл")))


if __name__ == "__main__":
    unittest.main()
