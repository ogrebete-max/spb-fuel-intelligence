"""FUELUP («Заправить авто») coverage map: station list with prices only.

fuelup.ru/map draws its markers from one static JSON list at
res.fuelup.ru/stations/list: station code/name, address, coordinates and a
price per fuel.  No availability, no queue, no limit and no timestamps, so
this is a catalogue plus prices.  The host sits behind Qrator, which
answered without a challenge.  The richer stations map lives in the partner
cabinet (new-lk.fuelup.ru, GraphQL with a user token) and is not used.
"""

from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime, timezone
import json
import sys
from typing import Any
from urllib.request import ProxyHandler, Request, build_opener

BBOX = {"south": 58.4, "west": 27.6, "north": 61.4, "east": 35.8}  # SPb + Leningrad oblast
BROWSER_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"
)
URL = "https://res.fuelup.ru/stations/list"

_OPENER = build_opener()  # honours HTTPS_PROXY, as the pipeline does


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _in_bbox(lat: Any, lon: Any) -> bool:
    return (isinstance(lat, (int, float)) and isinstance(lon, (int, float))
            and BBOX["south"] <= lat <= BBOX["north"] and BBOX["west"] <= lon <= BBOX["east"])


def collect() -> dict[str, Any]:
    headers = {"User-Agent": BROWSER_UA, "Accept": "application/json, */*", "Accept-Language": "ru,en;q=0.8",
               "Referer": "https://fuelup.ru/map"}
    with _OPENER.open(Request(URL, headers=headers), timeout=60) as response:
        rows = json.loads(response.read().decode("utf-8"))
    stations = []
    for row in rows:
        if not _in_bbox(row.get("lat"), row.get("lon")):
            continue
        prices = {item["fuel"]: item["price"] for item in row.get("price") or [] if item.get("fuel")}
        stations.append({"name": row.get("name"), "address": row.get("address"),
                         "lat": row["lat"], "lon": row["lon"], "prices": prices})
    return {"source": URL, "captured_at": _now(), "requests": 1, "national_total": len(rows),
            "bbox": BBOX, "stations": stations}


def summarize(result: dict[str, Any]) -> None:
    stations = result["stations"]
    print(f"source: {result['source']}  captured_at: {result['captured_at']}  requests: {result['requests']}")
    print(f"stations: national {result['national_total']}, in SPb/LO bbox {len(stations)}")
    fuels = Counter(fuel for station in stations for fuel in station["prices"])
    print("priced fuels in bbox:", ", ".join(f"{fuel}={count}" for fuel, count in fuels.most_common()))
    print(f"stations without any price: {sum(1 for station in stations if not station['prices'])}")
    print("per-grade status: none (list has prices only)")
    print("newest timestamp: none in the payload")


def main(argv: list[str] | None = None) -> int:
    global _OPENER
    parser = argparse.ArgumentParser(description="FUELUP station list")
    parser.add_argument("--direct", action="store_true", help="bypass HTTPS_PROXY")
    parser.add_argument("--save", metavar="PATH", help="write the collected JSON to PATH")
    args = parser.parse_args(argv)
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    if args.direct:
        _OPENER = build_opener(ProxyHandler({}))
    result = collect()
    summarize(result)
    if args.save:
        with open(args.save, "w", encoding="utf-8") as handle:
            json.dump(result, handle, ensure_ascii=False, separators=(",", ":"))
        print(f"saved: {args.save}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
