"""Benzuber public web map: per-grade availability marks, no partner key.

The map page embedded on benzuber.ru (app.benzuber.ru/map, also
price.benzuber.ru) loads every connected station as a Yandex ObjectManager
FeatureCollection.  With ``filter=<grade>`` the marker icon is the status of
that grade: point_available ("топливо есть"), point_probably,
point_unavailable ("остановка продаж"), point_default (no data).  Only ids
and coordinates come in the list; the station card (``--cards N``, HTML)
adds number, brand, address, per-grade status, litre limit and price.

This is the anonymous web map, not the partner API that needs an apikey.
No timestamps anywhere.  The host sits behind DDoS-Guard, which answered
without a challenge.
"""

from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime, timezone
import html
import json
import re
import sys
import time
from typing import Any
from urllib.parse import quote
from urllib.request import ProxyHandler, Request, build_opener

BBOX = {"south": 58.4, "west": 27.6, "north": 61.4, "east": 35.8}  # SPb + Leningrad oblast
BROWSER_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"
)
BASE = "https://app.benzuber.ru/map"
REFERER = "https://app.benzuber.ru/map?noheader=1"
GRADES = ("92", "95", "98", "100", "ДТ")  # the labels the map's own filter uses
ICON_STATUS = {
    "point_available.png": "available",
    "point_probably.png": "probably",
    "point_unavailable.png": "unavailable",
    "point_default.png": "no_data",
}
CARD_ITEM = re.compile(
    r'<div class="status ([a-z_]+)"(?: title="([^"]*)")?\s*></div>\s*'
    r'<div class="name">(.*?)</div>\s*<div class="price">([^<]*)</div>', re.S)
PAUSE_S = 1.5

_OPENER = build_opener()  # honours HTTPS_PROXY, as the pipeline does


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _fetch(url: str) -> bytes:
    headers = {
        "User-Agent": BROWSER_UA, "Accept": "*/*", "Accept-Language": "ru,en;q=0.8",
        "Referer": REFERER, "X-Requested-With": "XMLHttpRequest",
    }
    with _OPENER.open(Request(url, headers=headers), timeout=60) as response:
        return response.read()


def _in_bbox(lat: float, lon: float) -> bool:
    return BBOX["south"] <= lat <= BBOX["north"] and BBOX["west"] <= lon <= BBOX["east"]


def _text(fragment: str) -> str:
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", fragment))).strip()


def parse_card(page: str) -> dict[str, Any]:
    """Station card HTML from /map?station_id=ID."""
    number = re.search(r"<h1>(.*?)</h1>", page, re.S)
    brand = re.search(r'<div class="brand">(.*?)</div>', page, re.S)
    address = re.search(r'<div class="address">(.*?)</div>', page, re.S)
    fuels = []
    for status, title, name_block, price in CARD_ITEM.findall(page):
        name = _text(re.split(r"<br\s*/?>", name_block)[0])
        limit = re.search(r"Лимит\s*(\d+(?:[.,]\d+)?)\s*л", name_block)
        fuels.append({
            "name": name, "status": status, "status_title": html.unescape(title),
            "limit_l": float(limit.group(1).replace(",", ".")) if limit else None,
            "price": float(price) if price.strip() else None,
        })
    return {
        "number": _text(number.group(1)) if number else None,
        "brand": _text(brand.group(1)) if brand else None,
        "address": _text(address.group(1)) if address else None,
        "fuels": fuels,
    }


def collect(cards: int = 0) -> dict[str, Any]:
    stations: dict[str, dict[str, Any]] = {}
    requests_made = 0
    for grade in GRADES:
        if requests_made:
            time.sleep(PAUSE_S)
        url = f"{BASE}?zoom=10&price_mode=0&filter={quote(grade)}"
        collection = json.loads(_fetch(url).decode("utf-8"))
        requests_made += 1
        for feature in collection.get("features") or []:
            lat, lon = feature["geometry"]["coordinates"]  # Yandex order: lat, lon
            if not _in_bbox(lat, lon):
                continue
            icon = (feature.get("options") or {}).get("iconImageHref", "").rsplit("/", 1)[-1]
            station = stations.setdefault(str(feature["id"]), {
                "id": str(feature["id"]), "lat": lat, "lon": lon, "grades": {},
            })
            station["grades"][grade] = ICON_STATUS.get(icon, icon or None)
    for station in list(stations.values())[:max(cards, 0)]:
        time.sleep(PAUSE_S)
        station["card"] = parse_card(_fetch(f"{BASE}?station_id={quote(station['id'])}").decode("utf-8", "replace"))
        requests_made += 1
    return {
        "source": BASE, "captured_at": _now(), "requests": requests_made, "bbox": BBOX,
        "stations": list(stations.values()),
    }


def summarize(result: dict[str, Any]) -> None:
    stations = result["stations"]
    print(f"source: {result['source']}  captured_at: {result['captured_at']}  requests: {result['requests']}")
    print(f"stations in SPb/LO bbox (with at least one of the five grades): {len(stations)}")
    for grade in GRADES:
        counts = Counter(station["grades"][grade] for station in stations if grade in station["grades"])
        print(f"  {grade:>3}: {sum(counts.values()):4d} stations  " + "  ".join(
            f"{status}={count}" for status, count in counts.most_common()))
    carded = [station for station in stations if station.get("card")]
    for station in carded:
        card = station["card"]
        print(f"  card {station['id']}: {card['number']} {card['brand']} {card['address']} -> " + "; ".join(
            f"{fuel['name']} {fuel['status']} limit={fuel['limit_l']} price={fuel['price']}" for fuel in card["fuels"]))
    print("newest timestamp: none (the map carries no times)")


def main(argv: list[str] | None = None) -> int:
    global _OPENER
    parser = argparse.ArgumentParser(description="Benzuber public web map")
    parser.add_argument("--direct", action="store_true", help="bypass HTTPS_PROXY")
    parser.add_argument("--save", metavar="PATH", help="write the collected JSON to PATH")
    parser.add_argument("--cards", type=int, default=0, metavar="N",
                        help="also fetch N station cards (brand, address, limit, price)")
    args = parser.parse_args(argv)
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    if args.direct:
        _OPENER = build_opener(ProxyHandler({}))
    result = collect(cards=args.cards)
    summarize(result)
    if args.save:
        with open(args.save, "w", encoding="utf-8") as handle:
            json.dump(result, handle, ensure_ascii=False, separators=(",", ":"))
        print(f"saved: {args.save}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
