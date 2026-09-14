"""PPR fuel-card locator: per-grade availability from card transactions.

One public backend serves three card brands: locator.transitcard.ru
(TransitCard), the iframe on petrolplus.ru/fuelstations/ (Petrol Plus / PPR)
and map.e1-card.ru (E1 CARD).  Anonymous JSON, no key, no session.

The light point list takes a bounding box and a fuel filter, and with
``fuelAvailability`` set it returns a status for that fuel at every station:

    available           "Высокая": card transactions go through as usual
    has_limit           sold, but with a per-card litre limit
    possibly_available  "Не подтверждена": too few transactions to tell
    unavailable         "Недоступна": no transactions at the moment

The list has no timestamps; the status means "now" by design.  The point
detail (``--details N``) adds per-grade litre limits and price times.
"""

from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime, timedelta, timezone
import json
import re
import sys
import time
from typing import Any
from urllib.parse import urlencode
from urllib.request import ProxyHandler, Request, build_opener

BBOX = {"south": 58.4, "west": 27.6, "north": 61.4, "east": 35.8}  # SPb + Leningrad oblast
BROWSER_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"
)
HOST = "locator.transitcard.ru"  # map.e1-card.ru answers with the same data
# Service ids from /web/v1/service/list; premium grades (6, 7, 8) are left out.
GRADES = {"92": 4, "95": 3, "98": 2, "100": 10, "ДТ": 1}
SERVICE_NAMES = {
    1: "ДТ", 2: "Аи-98", 3: "Аи-95", 4: "Аи-92", 5: "А-80", 6: "Премиум ДТ",
    7: "Премиум 95", 8: "Премиум 92", 9: "Газ СПБТ", 10: "Аи-100", 11: "ДТ2",
    12: "ДТ Арктическое", 49: "Метан", 161: "AdBlue",
}
ALL_STATUSES = "available;possibly_available;unavailable"  # has_limit comes back as well
FUEL_STATION = 8
MOSCOW = timezone(timedelta(hours=3))
PAUSE_S = 1.5

_OPENER = build_opener()  # honours HTTPS_PROXY, as the pipeline does


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _json(url: str, *, referer: str) -> Any:
    headers = {
        "User-Agent": BROWSER_UA, "Accept": "application/json, text/plain, */*",
        "Accept-Language": "ru,en;q=0.8", "Referer": referer,
    }
    with _OPENER.open(Request(url, headers=headers), timeout=45) as response:
        return json.loads(response.read().decode("utf-8"))


def _in_bbox(lat: Any, lon: Any) -> bool:
    return (isinstance(lat, (int, float)) and isinstance(lon, (int, float))
            and BBOX["south"] <= lat <= BBOX["north"] and BBOX["west"] <= lon <= BBOX["east"])


def _columns_to_rows(payload: dict[str, Any]) -> list[dict[str, Any]]:
    """The list comes 'transposed': one array per field."""
    size = payload.get("size") or len(payload.get("id") or [])
    fields = [key for key, value in payload.items() if isinstance(value, list)]
    return [{key: payload[key][index] for key in fields} for index in range(size)]


def grade_of(name: str | None) -> str | None:
    text = (name or "").upper()
    if "ДТ" in text or "ДИЗ" in text:
        return "ДТ"
    match = re.search(r"(?<!\d)(92|95|98|100)(?!\d)", text)
    return match.group(1) if match else None


def parse_detail(payload: dict[str, Any]) -> dict[str, Any]:
    """Per-grade limits and price times from /web/v2/point?id=..."""
    fuels = []
    for fuel in payload.get("fuelServices") or []:
        restrictions = fuel.get("restrictions") or {}
        every = restrictions.get("all") or {}
        card = restrictions.get("plastic") or {}
        app = restrictions.get("mobile") or {}
        price_at = None
        if fuel.get("priceDateWithTime"):
            local = datetime.strptime(fuel["priceDateWithTime"], "%Y-%m-%d %H:%M").replace(tzinfo=MOSCOW)
            price_at = local.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
        fuels.append({
            "name": fuel.get("name"), "grade": grade_of(fuel.get("name")),
            "status": every.get("status") or card.get("status") or app.get("status"),
            "card_status": card.get("status"), "card_limit_l": card.get("limit"),
            "app_status": app.get("status"), "app_limit_l": app.get("limit"),
            "price": fuel.get("price"), "price_at": price_at,
        })
    return {
        "id": payload.get("id"), "name": payload.get("name"), "brand": payload.get("brand"),
        "address": payload.get("address"), "closed": payload.get("closed"), "fuels": fuels,
    }


def collect(host: str = HOST, details: int = 0) -> dict[str, Any]:
    referer = f"https://{host}/"
    stations: dict[str, dict[str, Any]] = {}
    requests_made = 0
    for grade, service_id in GRADES.items():
        if requests_made:
            time.sleep(PAUSE_S)
        query = urlencode({
            "pointTypes": FUEL_STATION, "services": service_id, "fuelAvailability": ALL_STATUSES,
            "x1": BBOX["south"], "y1": BBOX["west"], "x2": BBOX["north"], "y2": BBOX["east"],
        })
        payload = _json(f"https://{host}/web/v2/point/transpose-list?{query}", referer=referer)
        requests_made += 1
        for row in _columns_to_rows(payload):
            if not _in_bbox(row.get("latitude"), row.get("longitude")):
                continue
            station = stations.setdefault(row["id"], {
                "id": row["id"], "lat": row["latitude"], "lon": row["longitude"],
                "brand": row.get("brand"), "enabled": row.get("enabled"),
                "prices": {SERVICE_NAMES.get(int(key), key): value
                           for key, value in (row.get("prices") or {}).items()},
                "grades": {},
            })
            station["grades"][grade] = row.get("status")
    for station in list(stations.values())[:max(details, 0)]:
        time.sleep(PAUSE_S)
        station["detail"] = parse_detail(_json(
            f"https://{host}/web/v2/point?{urlencode({'id': station['id']})}", referer=referer))
        requests_made += 1
    return {
        "source": f"https://{host}/web/v2/point/transpose-list",
        "captured_at": _now(), "requests": requests_made, "bbox": BBOX,
        "stations": list(stations.values()),
    }


def summarize(result: dict[str, Any]) -> None:
    stations = result["stations"]
    print(f"source: {result['source']}  captured_at: {result['captured_at']}  requests: {result['requests']}")
    print(f"stations in SPb/LO bbox: {len(stations)}")
    brands = Counter(station.get("brand") for station in stations)
    print("top brands:", ", ".join(f"{name}={count}" for name, count in brands.most_common(6)))
    for grade in GRADES:
        counts = Counter(station["grades"].get(grade) for station in stations if grade in station["grades"])
        print(f"  {grade:>3}: {sum(counts.values()):4d} stations  " + "  ".join(
            f"{status}={count}" for status, count in counts.most_common()))
    stamps = [fuel["price_at"] for station in stations for fuel in (station.get("detail") or {}).get("fuels", [])
              if fuel.get("price_at")]
    if stamps:
        newest = max(stamps)
        age = datetime.now(timezone.utc) - datetime.fromisoformat(newest.replace("Z", "+00:00"))
        print(f"newest price time (details): {newest}  age: {int(age.total_seconds() // 60)} min")
    else:
        print("newest timestamp: none in the list (status is 'now'; price times only in --details)")


def main(argv: list[str] | None = None) -> int:
    global _OPENER
    parser = argparse.ArgumentParser(description="PPR / TransitCard / E1 fuel-card locator")
    parser.add_argument("--direct", action="store_true", help="bypass HTTPS_PROXY")
    parser.add_argument("--save", metavar="PATH", help="write the collected JSON to PATH")
    parser.add_argument("--host", default=HOST, help="locator.transitcard.ru or map.e1-card.ru")
    parser.add_argument("--details", type=int, default=0, metavar="N",
                        help="also fetch N station details (limits, price times)")
    args = parser.parse_args(argv)
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    if args.direct:
        _OPENER = build_opener(ProxyHandler({}))
    result = collect(host=args.host, details=args.details)
    summarize(result)
    if args.save:
        with open(args.save, "w", encoding="utf-8") as handle:
            json.dump(result, handle, ensure_ascii=False, separators=(",", ":"))
        print(f"saved: {args.save}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
