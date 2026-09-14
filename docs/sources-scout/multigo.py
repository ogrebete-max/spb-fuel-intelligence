"""MultiGO consumer map: nearest stations with an operating status and a price.

multigo.ru (SvelteKit) posts to its own /api/9/near/list with a point and a
fuel id and gets the nearest stations sorted by distance: id, name, brand,
address, coordinates, a station ``status`` ("Нормальное", the B2B page lists
"работает / на ремонте / закрыто") and the price of the requested fuel.
No per-grade availability, no timestamps.  The list stops at ``limit``
stations (1000 reached ~164 km from the SPb centre), so the region is
covered from a few centres.
"""

from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime, timezone
import json
import sys
import time
from typing import Any
from urllib.request import ProxyHandler, Request, build_opener

BBOX = {"south": 58.4, "west": 27.6, "north": 61.4, "east": 35.8}  # SPb + Leningrad oblast
BROWSER_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"
)
URL = "https://multigo.ru/api/9/near/list"
# fuel ids from the site's fuels chunk
FUELS = {"92": 8, "95": 11, "98": 14, "100": 16, "ДТ": 3}
CENTRES = ((59.94, 30.31), (59.70, 33.40))  # St Petersburg; Tikhvin side of the oblast
LIMIT = 1000
PAUSE_S = 1.5

_OPENER = build_opener()  # honours HTTPS_PROXY, as the pipeline does


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _post(body: dict[str, Any]) -> Any:
    headers = {"User-Agent": BROWSER_UA, "Accept": "application/json", "Accept-Language": "ru,en;q=0.8",
               "Content-Type": "application/json", "Origin": "https://multigo.ru",
               "Referer": "https://multigo.ru/benzin"}
    data = json.dumps(body).encode("utf-8")
    with _OPENER.open(Request(URL, data=data, headers=headers), timeout=60) as response:
        return json.loads(response.read().decode("utf-8"))


def _in_bbox(lat: float, lon: float) -> bool:
    return BBOX["south"] <= lat <= BBOX["north"] and BBOX["west"] <= lon <= BBOX["east"]


def collect(fuels: tuple[str, ...] = ("95",)) -> dict[str, Any]:
    stations: dict[str, dict[str, Any]] = {}
    requests_made = 0
    for grade in fuels:
        for lat, lon in CENTRES:
            if requests_made:
                time.sleep(PAUSE_S)
            payload = _post({"limit": LIMIT, "fuelId": FUELS[grade], "lat": lat, "lng": lon})
            requests_made += 1
            if payload.get("err"):
                raise RuntimeError(f"multigo near/list err={payload.get('err')} {payload.get('errmsg')}")
            for item in (payload.get("data") or {}).get("list") or []:
                point = item.get("loc") or []
                if len(point) != 2 or not _in_bbox(point[0], point[1]):
                    continue
                station = stations.setdefault(item["id"], {
                    "id": item["id"], "name": item.get("name"), "brand": (item.get("brand") or {}).get("name"),
                    "address": item.get("address"), "lat": point[0], "lon": point[1],
                    "status": item.get("status"), "prices": {},
                })
                for fuel in item.get("fuels") or []:
                    if fuel.get("fuelPrice") is not None:
                        station["prices"][fuel.get("fuelId")] = fuel["fuelPrice"]
    return {"source": URL, "captured_at": _now(), "requests": requests_made, "fuels": list(fuels),
            "bbox": BBOX, "stations": list(stations.values())}


def summarize(result: dict[str, Any]) -> None:
    stations = result["stations"]
    print(f"source: {result['source']}  captured_at: {result['captured_at']}  requests: {result['requests']}")
    print(f"stations in SPb/LO bbox: {len(stations)}  (fuels asked: {', '.join(result['fuels'])})")
    print("station status:", ", ".join(f"{status}={count}" for status, count in
                                       Counter(station["status"] for station in stations).most_common()))
    priced = Counter(fuel for station in stations for fuel in station["prices"])
    print("priced fuels:", ", ".join(f"{fuel}={count}" for fuel, count in priced.most_common()))
    print("brands:", ", ".join(f"{brand}={count}" for brand, count in
                                Counter(station["brand"] for station in stations).most_common(6)))
    print("per-grade status: none; newest timestamp: none in the payload")


def main(argv: list[str] | None = None) -> int:
    global _OPENER
    parser = argparse.ArgumentParser(description="MultiGO nearest-stations list")
    parser.add_argument("--direct", action="store_true", help="bypass HTTPS_PROXY")
    parser.add_argument("--save", metavar="PATH", help="write the collected JSON to PATH")
    parser.add_argument("--all-fuels", action="store_true", help="ask for 92/95/98/100/ДТ prices (5x requests)")
    args = parser.parse_args(argv)
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    if args.direct:
        _OPENER = build_opener(ProxyHandler({}))
    result = collect(tuple(FUELS) if args.all_fuels else ("95",))
    summarize(result)
    if args.save:
        with open(args.save, "w", encoding="utf-8") as handle:
            json.dump(result, handle, ensure_ascii=False, separators=(",", ":"))
        print(f"saved: {args.save}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
