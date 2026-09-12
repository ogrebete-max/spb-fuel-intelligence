"""One-off accuracy audit of our verdicts against Yandex Maps fuel signals.

This is a measurement tool, not a collector: it is never run by the scheduled
job and nothing it fetches is published.  It answers one question — how often
does our snapshot claim fuel where Yandex's crowd signal says otherwise.
"""

from __future__ import annotations

import argparse
from html import unescape
import json
from pathlib import Path
import re
import sys
import time
from urllib.parse import quote
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from src.repository import StationRepository  # noqa: E402
from src.station_matcher import haversine_km  # noqa: E402

BROWSER_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"
)
# A grid of map centres covering the city; the page returns up to 25 per view.
CENTRES = [
    (30.20, 59.85), (30.35, 59.85), (30.50, 59.85),
    (30.20, 59.93), (30.35, 59.93), (30.50, 59.93),
    (30.20, 60.01), (30.35, 60.01), (30.50, 60.01),
    (30.28, 59.78), (30.45, 60.08), (30.15, 59.99),
]
GRADE_BY_YANDEX = {
    "AI92": "AI92", "AI95": "AI95", "AI95_PREMIUM": "AI95", "AI98": "AI98",
    "AI100": "AI100", "DIESEL": "DT", "GAS": "LPG", "PROPANE": "LPG",
}
OUR_POSITIVE = {"CAN_REFUEL", "LIKELY_AVAILABLE", "LIMITED"}
OUR_NEGATIVE = {"CONFIRMED_NO", "LIKELY_NOT"}


def fetch_view(lon: float, lat: float) -> list[dict]:
    url = (
        "https://yandex.ru/maps/2/saint-petersburg/search/"
        f"{quote('АЗС')}/?ll={lon:.4f}%2C{lat:.4f}&z=14"
    )
    request = Request(url, headers={"User-Agent": BROWSER_UA, "Accept-Language": "ru"})
    with urlopen(request, timeout=45) as response:
        page = response.read().decode("utf-8", "replace")
    match = re.search(r'<script type="application/json" class="state-view">(.*?)</script>', page, re.S)
    if not match:
        return []
    state = json.loads(unescape(match.group(1)))
    items: list[dict] = []
    for stack in state.get("stack", []):
        results = (stack.get("results") or {}).get("items") or []
        items.extend(results)
    return items


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--grade", default="AI95")
    parser.add_argument("--out", type=Path, default=None)
    args = parser.parse_args()

    reference: dict[tuple[float, float], dict] = {}
    for lon, lat in CENTRES:
        try:
            for item in fetch_view(lon, lat):
                coords = item.get("coordinates") or []
                availability = item.get("fuelAvailability")
                if len(coords) != 2 or not availability:
                    continue
                reference[(round(coords[1], 5), round(coords[0], 5))] = {
                    "title": item.get("title"),
                    "address": item.get("address"),
                    "availability": availability,
                }
        except Exception as exc:  # a single view must not abort the audit
            print(f"view {lon},{lat}: {type(exc).__name__}: {exc}")
        time.sleep(1.0)
    print(f"reference stations with a fuel signal: {len(reference)}")

    repository = StationRepository(ROOT / "data" / "stations.json", ROOT / "data" / "history.json")
    ours = repository.query(grade=args.grade, limit=10_000)["stations"]
    points = [(station["location"], station) for station in ours]

    rows = []
    for (lat, lon), entry in reference.items():
        target = {"lat": lat, "lon": lon}
        nearest, distance = None, 10.0
        for location, station in points:
            gap = haversine_km(location, target)
            if gap < distance:
                nearest, distance = station, gap
        if nearest is None or distance * 1000 > 150:
            continue
        their = None
        for fuel in entry["availability"].get("fuel", []):
            if GRADE_BY_YANDEX.get(fuel.get("fuelType")) == args.grade:
                their = fuel.get("status")
                break
        rows.append({
            "title": entry["title"],
            "address": entry["address"],
            "their_status": their,
            "their_overall": entry["availability"].get("status"),
            "their_signals": entry["availability"].get("signalsCountPerHour"),
            "their_queue": entry["availability"].get("localizedQueueSize"),
            "our_status": nearest["grade"]["status"],
            "our_trust": nearest["grade"]["trust_score"],
            "our_age": nearest["grade"]["age_seconds"],
            "our_sources": nearest["grade"].get("fresh_source_count"),
            "distance_m": round(distance * 1000),
            "id": nearest["id"],
        })

    matched = [row for row in rows if row["their_status"] in {"IN_STOCK", "OUT_OF_STOCK"}]
    false_positive = [r for r in matched if r["our_status"] in OUR_POSITIVE and r["their_status"] == "OUT_OF_STOCK"]
    false_negative = [r for r in matched if r["our_status"] in OUR_NEGATIVE and r["their_status"] == "IN_STOCK"]
    agree = [r for r in matched if (r["our_status"] in OUR_POSITIVE) == (r["their_status"] == "IN_STOCK")
             and r["our_status"] in OUR_POSITIVE | OUR_NEGATIVE]
    silent = [r for r in matched if r["our_status"] == "NO_FRESH_DATA"]

    print(f"matched stations: {len(rows)}, with a definite Yandex verdict: {len(matched)}")
    print(f"agree: {len(agree)}  we say yes they say no: {len(false_positive)}  "
          f"we say no they say yes: {len(false_negative)}  we are silent: {len(silent)}")
    for row in sorted(false_positive, key=lambda r: -(r["our_trust"] or 0))[:10]:
        print(f"  FP trust={row['our_trust']:>3} {row['our_status']:17} src={row['our_sources']} "
              f"age={row['our_age']} | {row['title']} — {row['address']}")
    if args.out:
        args.out.write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"detail written to {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
