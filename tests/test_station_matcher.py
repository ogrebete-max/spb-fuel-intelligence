from __future__ import annotations

import unittest

from src.station_matcher import is_match


def station(source, station_id, network="Лукойл", address="Невский проспект, 1", lat=59.93, lon=30.33):
    return {"source": source, "station_id": station_id, "network": network, "address": address, "location": {"lat": lat, "lon": lon}}


class StationMatcherTests(unittest.TestCase):
    def test_distance_alone_never_matches(self):
        left = station("a", "1", network="Лукойл", address="Невский проспект, 1")
        right = station("b", "2", network="Газпромнефть", address="Московский проспект, 99", lat=59.93001)
        self.assertFalse(is_match(left, right)[0])

    def test_network_address_and_distance_match(self):
        left = station("a", "1")
        right = station("b", "2", address="Санкт-Петербург, Невский проспект, дом 1", lat=59.93002)
        self.assertTrue(is_match(left, right)[0])

    def test_sber_upstream_id_matches(self):
        left = station("sber", "70000001000000001", network="АЗС")
        right = station("gdebenzin", "2gis:70000001000000001", network="Прочие АЗС")
        self.assertTrue(is_match(left, right)[0])


if __name__ == "__main__":
    unittest.main()

