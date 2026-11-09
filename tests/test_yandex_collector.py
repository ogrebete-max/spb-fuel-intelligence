"""The Yandex Maps collector without the network.

A search page lists at most 25 stations, so the collector asks from many sides:
searches by chain and district first, then map views. What each page brings is
merged by Yandex's organisation id, and a page that fails costs only itself.
"""

from __future__ import annotations

import html
import json
from pathlib import Path
import sys
import unittest
from unittest import mock
from urllib.parse import unquote

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import collectors  # noqa: E402


def page(*items: dict) -> bytes:
    state = {"stack": [{"results": {"items": list(items)}}]}
    return f'<script type="application/json" class="state-view">{html.escape(json.dumps(state))}</script>'.encode()


def station(org: str, lon: float, lat: float) -> dict:
    return {"id": org, "title": "Лукойл", "address": "СПб", "coordinates": [lon, lat],
            "fuelAvailability": {"fuel": [{"fuelType": "AI95", "status": "IN_STOCK"}]}}


class YandexCollectorTests(unittest.TestCase):
    def test_asks_by_chain_and_district_before_the_map_views(self):
        requests = collectors.yandex_requests()
        self.assertEqual(len(requests), len(collectors.YANDEX_SEARCHES) + len(collectors.YANDEX_VIEWS))
        self.assertEqual(len({url for _, url in requests}), len(requests))
        searches = requests[:len(collectors.YANDEX_SEARCHES)]
        self.assertTrue(all("?" not in url and unquote(url).endswith(f"/search/{text}/") for text, url in searches))
        self.assertIn("АЗС Лукойл", collectors.YANDEX_SEARCHES)
        self.assertIn("АЗС Невский район", collectors.YANDEX_SEARCHES)
        label, url = requests[len(searches)]
        lon, lat = collectors.YANDEX_VIEWS[0]
        self.assertEqual(label, f"{lon},{lat}")
        self.assertTrue(url.endswith(f"/?ll={lon:.4f}%2C{lat:.4f}&z=14"))
        # Every view stays over St Petersburg and its edge of the region.
        self.assertTrue(all(29.5 <= lon <= 31.0 and 59.5 <= lat <= 60.3 for lon, lat in collectors.YANDEX_VIEWS))

    def test_merges_stations_across_pages_and_keeps_going_past_a_failed_one(self):
        pages = iter([
            page(station("1", 30.30, 59.90), station("2", 30.40, 59.95)),
            RuntimeError("timed out"),
            b"<html>no state</html>",
            page(station("2", 30.40, 59.95), station("3", 30.50, 60.00), {"id": "4", "coordinates": [30.1, 59.8]}),
        ])

        def fetch(url):
            answer = next(pages, page())
            if isinstance(answer, Exception):
                raise answer
            return answer.decode(), url

        with mock.patch.object(collectors, "_yandex_page", side_effect=fetch) as fetched, \
                mock.patch.object(collectors.time, "sleep") as slept:
            captured = collectors.collect_yandex()
        self.assertEqual(fetched.call_count, len(collectors.yandex_requests()))
        self.assertEqual(slept.call_count, fetched.call_count - 1)
        self.assertEqual(sorted(item["id"] for item in captured["stations"]), ["1", "2", "3"])
        self.assertEqual(len(captured["errors"]), 2)
        self.assertTrue(captured["errors"][0].startswith(f"{collectors.YANDEX_SEARCHES[1]}: RuntimeError"))
        self.assertIn("fuel block missing", captured["errors"][1])
        self.assertEqual((captured["searches"], captured["views"]), (len(collectors.YANDEX_SEARCHES), len(collectors.YANDEX_VIEWS)))

    def test_says_what_came_instead_of_a_search_page(self):
        # 6-9 Nov 2026: GitHub's servers got pages without the state block, and
        # the collector could only say «fuel block missing».
        pages = iter([b"<html><title>Yandex Maps</title>bare</html>", b"<html><title>Yandex Maps</title></html>"])

        def fetch(url):
            return next(pages, page(station("1", 30.30, 59.90))).decode(), url

        with mock.patch.object(collectors, "_yandex_page", side_effect=fetch), \
                mock.patch.object(collectors.time, "sleep"):
            captured = collectors.collect_yandex()
        self.assertIn("fuel block missing (→ https://yandex.ru/maps/2/saint-petersburg/search/", captured["errors"][0])
        self.assertIn("«Yandex Maps»", captured["errors"][0])
        self.assertTrue(captured["errors"][1].endswith("fuel block missing"))

    def test_stops_at_a_check_for_robots(self):
        captcha = ("<html><title>Вы не робот?</title></html>", "https://yandex.ru/showcaptcha?cc=1&retpath=x")

        with mock.patch.object(collectors, "_yandex_page", return_value=captcha) as fetched, \
                mock.patch.object(collectors.time, "sleep"):
            with self.assertRaises(RuntimeError) as raised:
                collectors.collect_yandex()
        self.assertEqual(fetched.call_count, 1)
        self.assertIn("не робот", str(raised.exception))
        self.assertIn("https://yandex.ru/showcaptcha,", str(raised.exception))
        self.assertNotIn("retpath", str(raised.exception))


if __name__ == "__main__":
    unittest.main()
