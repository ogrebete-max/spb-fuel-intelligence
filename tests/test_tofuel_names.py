from __future__ import annotations

import unittest

from src.sources_live import normalize_tofuel


def row(brand, name, *fuels):
    return {
        "_id": "t1", "brand": brand, "name": name, "address": "",
        "location": {"type": "Point", "coordinates": [30.3, 59.9]},
        "fuels": [{"type": fuel, "availability": "available"} for fuel in fuels],
    }


class BrokenTofuelBrands(unittest.TestCase):
    """12 Sep 2026: tofuel sent brands with the first letter broken into U+FFFD."""

    def test_a_broken_brand_that_sells_gas_is_left_out(self):
        self.assertEqual(normalize_tofuel(row("��ропан 24", "ПРОПАН 24 Витебский", "GAS", "AI92")), [])

    def test_a_broken_brand_without_gas_takes_the_intact_name(self):
        record = normalize_tofuel(row("��еверная", "Северная АЗС №3", "AI92", "AI95"))[0]
        self.assertEqual(record["network"], "Северная АЗС №3")

    def test_an_intact_brand_is_kept_even_with_gas_on_sale(self):
        record = normalize_tofuel(row("Лукойл", "АЗС 47", "AI95", "GAS"))[0]
        self.assertEqual(record["network"], "Лукойл")


if __name__ == "__main__":
    unittest.main()
