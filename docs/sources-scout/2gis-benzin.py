"""Prototype collector: 2GIS fuel statuses (the «Статус АЗС» tab on 2gis.ru).

Endpoint
    GET https://benzin.api.2gis.ru/api/v1/stations?minLat=&maxLat=&minLon=&maxLon=
    The host is the "benzApiUrl" value in the public 2gis.ru page config. The
    web bundle calls it without a key or cookie, and it answers with
    "access-control-allow-origin: *". A box may span at most 5 degrees per
    side (HTTP 400 "bounding box too large ... zoom in"), so SPb+LO, which is
    3.0 x 8.2 degrees, is read in two tiles. gzip is honoured; no robots.txt.
    Other routes in the bundle: /api/v1/stations/by-ids?ids= (500 per call),
    /api/v1/stations/nearby?lat=&lng=&radius=(<=50000)&limit=(<=200), and
    /api/v1/stations/{id}, which adds recent_ugc_reports and recent_transactions.

Record (one per station)
    station {id, region_id, name, brand, address, lat, lng, last_transaction_at,
             created_at, updated_at, fuel_assortment, has_shop, pay_sbp, ...}
    status: AVAILABLE | PARTIALLY_AVAILABLE | NOT_AVAILABLE | NO_DATA
    closed, closed_by_schedule, limit_liters, queue_level, can_use_canister
    prices[] {fuel_type, price, updated_at}
    fuel_statuses[] {fuel_type AI_92|AI_95|AI_98|AI_100|DT|GAS,
                     available true|false|null,
                     queue_level NONE|UP_TO_25|FROM_25_TO_50|OVER_50,
                     limit_liters, reports_count, last_report_at}

The station ids are 2GIS "benzin" ids, not the 2GIS branch ids used by the
sberazs.ru feed, so matching to other sources goes by coordinates.

Usage
    python 2gis-benzin.py [--direct] [--details N] [--save full.json] [--sample sample.json]
"""

from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime, timezone
import gzip
import json
from pathlib import Path
import sys
import time
from typing import Any
from urllib.request import ProxyHandler, Request, build_opener

BASE = "https://benzin.api.2gis.ru/api/v1"
# (south, north, west, east); each side stays under the 5 degree limit.
TILES = ((58.4, 61.4, 27.6, 31.7), (58.4, 61.4, 31.7, 35.8))
CITY_AOI = {"south": 59.60, "north": 60.35, "west": 29.50, "east": 31.10}
BROWSER_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"
)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(value: Any) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None


def _get(url: str, direct: bool, timeout: int = 60) -> Any:
    opener = build_opener(ProxyHandler({})) if direct else build_opener()
    request = Request(url, headers={
        "User-Agent": BROWSER_UA,
        "Accept": "application/json",
        "Accept-Encoding": "gzip",
        "Accept-Language": "ru,en;q=0.8",
        "Origin": "https://2gis.ru",
        "Referer": "https://2gis.ru/",
    })
    with opener.open(request, timeout=timeout) as response:
        body = response.read()
        if response.headers.get("Content-Encoding") == "gzip":
            body = gzip.decompress(body)
    return json.loads(body.decode("utf-8"))


def _newest_report(row: dict[str, Any]) -> datetime | None:
    stamps = [_iso(fuel.get("last_report_at")) for fuel in row.get("fuel_statuses") or []]
    stamps = [stamp for stamp in stamps if stamp]
    return max(stamps) if stamps else None


def _in_city(row: dict[str, Any]) -> bool:
    station = row.get("station") or {}
    try:
        lat, lon = float(station["lat"]), float(station["lng"])
    except (KeyError, TypeError, ValueError):
        return False
    return CITY_AOI["south"] <= lat <= CITY_AOI["north"] and CITY_AOI["west"] <= lon <= CITY_AOI["east"]


def collect(direct: bool = False, details: int = 0) -> dict[str, Any]:
    merged: dict[str, dict[str, Any]] = {}
    for index, (south, north, west, east) in enumerate(TILES):
        if index:
            time.sleep(1.0)
        url = f"{BASE}/stations?minLat={south}&maxLat={north}&minLon={west}&maxLon={east}"
        for row in _get(url, direct):
            merged[str((row.get("station") or {}).get("id"))] = row
    stations = list(merged.values())
    detail_rows: list[dict[str, Any]] = []
    if details:
        epoch = datetime.min.replace(tzinfo=timezone.utc)
        freshest = sorted(stations, key=lambda row: _newest_report(row) or epoch, reverse=True)[:details]
        for row in freshest:
            time.sleep(1.0)
            detail = _get(f"{BASE}/stations/{row['station']['id']}", direct)
            for key in ("recent_ugc_reports", "recent_transactions"):
                for report in detail.get(key) or []:
                    report.pop("user_id", None)  # a driver's account id is not needed here
            detail_rows.append(detail)
    return {
        "captured_at": _now().isoformat().replace("+00:00", "Z"),
        "source": f"{BASE}/stations",
        "tiles": len(TILES),
        "stations": stations,
        "details": detail_rows,
    }


def _bucket(stamp: datetime | None, now: datetime) -> str:
    if stamp is None:
        return "none"
    hours = (now - stamp).total_seconds() / 3600
    return "<1h" if hours < 1 else "<3h" if hours < 3 else "<24h" if hours < 24 else "older"


def summary(payload: dict[str, Any]) -> None:
    now = _now()
    stations = payload["stations"]
    graded = [row for row in stations if row.get("fuel_statuses")]
    print(f"2GIS benzin: {len(stations)} stations in SPb/LO ({sum(map(_in_city, stations))} in the city AOI), "
          f"{len(graded)} with per-grade data")
    print(f"  station status: {dict(Counter(row.get('status') for row in stations))}; "
          f"closed_by_schedule={sum(1 for row in stations if row.get('closed_by_schedule'))}")
    by_grade: dict[str, Counter[str]] = {}
    queues: Counter[Any] = Counter()
    limits: Counter[Any] = Counter()
    for row in graded:
        for fuel in row["fuel_statuses"]:
            state = {True: "yes", False: "no"}.get(fuel.get("available"), "null")
            by_grade.setdefault(str(fuel.get("fuel_type")), Counter())[state] += 1
            queues[fuel.get("queue_level")] += 1
            limits[fuel.get("limit_liters")] += 1
    for grade in sorted(by_grade):
        print(f"  {grade:7} " + ", ".join(f"{key}={value}" for key, value in by_grade[grade].most_common()))
    print(f"  queue_level per grade: {dict(queues)}")
    print(f"  limit_liters per grade: {dict(limits.most_common(6))}")
    report_stamps = [_iso(fuel.get("last_report_at")) for row in graded for fuel in row["fuel_statuses"]]
    print(f"  per-grade last_report_at: {dict(Counter(_bucket(t, now) for t in report_stamps))}")
    known = [t for t in report_stamps if t]
    if known:
        newest = max(known)
        print(f"  newest report {newest.isoformat()} ({(now - newest).total_seconds() / 60:.1f} min ago)")
    prices = [_iso(price.get("updated_at")) for row in stations for price in row.get("prices") or []]
    print(f"  prices: {len(prices)} entries, updated {dict(Counter(_bucket(t, now) for t in prices))}")
    for detail in payload.get("details") or []:
        station = detail.get("station") or {}
        ugc = detail.get("recent_ugc_reports") or []
        print(f"  detail {station.get('brand')} | {station.get('address')}: "
              f"{len(ugc)} recent driver reports, {len(detail.get('recent_transactions') or [])} recent transactions")


def trimmed(payload: dict[str, Any], max_bytes: int = 48_000) -> dict[str, Any]:
    epoch = datetime.min.replace(tzinfo=timezone.utc)
    city = [row for row in payload["stations"] if _in_city(row) and row.get("fuel_statuses")]
    city.sort(key=lambda row: _newest_report(row) or epoch, reverse=True)
    count = min(40, len(city))
    while True:
        sample = {
            "captured_at": payload["captured_at"],
            "source": payload["source"],
            "stations_total_spb_lo": len(payload["stations"]),
            "stations_in_sample": count,
            "stations": city[:count],
            "details": (payload.get("details") or [])[:1],
        }
        size = len(json.dumps(sample, ensure_ascii=False, indent=1).encode("utf-8"))
        if count <= 1 or size <= max_bytes:
            return sample
        count -= 1


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--direct", action="store_true", help="ignore HTTPS_PROXY")
    parser.add_argument("--details", type=int, default=0, help="also read N station details")
    parser.add_argument("--save", type=Path, help="write the SPb/LO payload")
    parser.add_argument("--sample", type=Path, help="write a trimmed sample")
    args = parser.parse_args()
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass
    payload = collect(direct=args.direct, details=args.details)
    summary(payload)
    if args.save:
        args.save.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    if args.sample:
        args.sample.write_text(json.dumps(trimmed(payload), ensure_ascii=False, indent=1), encoding="utf-8")
    return 0 if payload["stations"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
