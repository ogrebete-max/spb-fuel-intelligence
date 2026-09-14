"""Prototype collector: «Где бензин?» crowd map (pinggi.ru).

The same service runs the SEO site benzrf.ru, the bot @benzin_status_bot and
the channel t.me/gde_benz_rf. It is not гдебензин.рф (bot @gasoline_crimea_bot),
which the project already reads.

Endpoint
    GET https://pinggi.ru/api/stations?bbox={south},{west},{north},{east}
        &limit=5000&fuel=ai95&prices=1&queues=1&trust=1&anyfuel=1&center={lon},{lat}
    Anonymous JSON. One call covers SPb+LO (about 1250 stations, 560 KB); the
    web app itself sends a 5-decimal bbox and asks for up to 5000 rows.
    GET https://pinggi.ru/api/stations/{id} adds the report list (author display
    names, geoTrust), queue observations and statusRules (quorum 2 within 6 h).
    GET https://pinggi.ru/api/config gives fuelTypes and freshHours=4.

Record
    id, name, brand, lat, lng, address,
    source: osm | ppr | gdebenz | user   (where the station card came from)
    status: available | limited | none | unknown  (map colours est/limit/no/nodata);
            the grades it applies to are listed in fuelTypes
    lastReportAt (epoch ms), limitLiters, canister (yes|no), price, priceAt,
    priceSource, priceFuel, delivery, confirms, onsite, counted, q,
    statusSource: tbank | tbank-confirmed  (present when the status came from T-Bank)

Measured on 14.09.2026: 1246 stations in SPb/LO; the fresh statuses mostly
carry statusSource "tbank-confirmed", i.e. the T-Bank fuel map that the project
already reads, while most crowd reports in SPb are older than a week.

Usage
    python pinggi.py [--direct] [--save full.json] [--sample sample.json]
"""

from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime, timezone
import json
from pathlib import Path
import sys
from typing import Any
from urllib.request import ProxyHandler, Request, build_opener

BBOX = {"south": 58.4, "north": 61.4, "west": 27.6, "east": 35.8}
CITY_AOI = {"south": 59.60, "north": 60.35, "west": 29.50, "east": 31.10}
FRESH_HOURS = 4  # the site's own "fresh" window from /api/config
BROWSER_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"
)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _get(url: str, direct: bool, timeout: int = 60) -> Any:
    opener = build_opener(ProxyHandler({})) if direct else build_opener()
    request = Request(url, headers={
        "User-Agent": BROWSER_UA,
        "Accept": "application/json",
        "Accept-Language": "ru,en;q=0.8",
        "Referer": "https://pinggi.ru/",
    })
    with opener.open(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def collect(direct: bool = False) -> dict[str, Any]:
    box = f"{BBOX['south']:.5f},{BBOX['west']:.5f},{BBOX['north']:.5f},{BBOX['east']:.5f}"
    url = (
        f"https://pinggi.ru/api/stations?bbox={box}&limit=5000&fuel=ai95"
        "&prices=1&queues=1&trust=1&anyfuel=1&center=30.30000,59.90000"
    )
    payload = _get(url, direct)
    return {
        "captured_at": _now().isoformat().replace("+00:00", "Z"),
        "source": url,
        "stations": payload.get("stations") or [],
    }


def _age_hours(row: dict[str, Any], now: datetime) -> float | None:
    stamp = row.get("lastReportAt")
    if not stamp:
        return None
    return (now.timestamp() * 1000 - float(stamp)) / 3_600_000


def _bucket(hours: float | None) -> str:
    if hours is None:
        return "none"
    return "<1h" if hours < 1 else "<4h" if hours < 4 else "<24h" if hours < 24 else "<7d" if hours < 168 else "older"


def _in_city(row: dict[str, Any]) -> bool:
    try:
        lat, lon = float(row["lat"]), float(row["lng"])
    except (KeyError, TypeError, ValueError):
        return False
    return CITY_AOI["south"] <= lat <= CITY_AOI["north"] and CITY_AOI["west"] <= lon <= CITY_AOI["east"]


def summary(payload: dict[str, Any]) -> None:
    now = _now()
    stations = payload["stations"]
    fresh = [row for row in stations if (_age_hours(row, now) or 1e9) < FRESH_HOURS]
    print(f"pinggi.ru: {len(stations)} stations in SPb/LO ({sum(map(_in_city, stations))} in the city AOI), "
          f"{len(fresh)} with a report newer than {FRESH_HOURS} h")
    print(f"  status: {dict(Counter(row.get('status') for row in stations))}")
    print(f"  report age: {dict(Counter(_bucket(_age_hours(row, now)) for row in stations))}")
    print(f"  fresh statuses by origin: {dict(Counter(row.get('statusSource') or 'crowd' for row in fresh))}")
    grades: dict[str, Counter[str]] = {}
    for row in fresh:
        for grade in row.get("fuelTypes") or []:
            grades.setdefault(grade, Counter())[str(row.get("status"))] += 1
    for grade in sorted(grades):
        print(f"  fresh {grade:6} " + ", ".join(f"{key}={value}" for key, value in grades[grade].most_common()))
    print(f"  limits: {dict(Counter(row.get('limitLiters') for row in stations if row.get('limitLiters')))}; "
          f"canister: {dict(Counter(row.get('canister') for row in stations if row.get('canister')))}; "
          f"queue marks: {sum(1 for row in stations if row.get('q'))}; deliveries: {sum(1 for row in stations if row.get('delivery'))}")
    print(f"  station card origin: {dict(Counter(row.get('source') for row in stations))}")
    ages = [age for age in (_age_hours(row, now) for row in stations) if age is not None]
    if ages:
        print(f"  newest report {min(ages) * 60:.0f} min ago")


def trimmed(payload: dict[str, Any], max_bytes: int = 45_000) -> dict[str, Any]:
    now = _now()
    rows = sorted(payload["stations"], key=lambda row: _age_hours(row, now) if _age_hours(row, now) is not None else 1e9)
    count = min(120, len(rows))
    while True:
        sample = {
            "captured_at": payload["captured_at"],
            "source": payload["source"],
            "stations_total_spb_lo": len(payload["stations"]),
            "stations_in_sample": count,
            "stations": rows[:count],
        }
        if count <= 1 or len(json.dumps(sample, ensure_ascii=False, indent=1).encode("utf-8")) <= max_bytes:
            return sample
        count -= 1


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--direct", action="store_true", help="ignore HTTPS_PROXY")
    parser.add_argument("--save", type=Path, help="write the SPb/LO payload")
    parser.add_argument("--sample", type=Path, help="write a trimmed sample")
    args = parser.parse_args()
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass
    payload = collect(direct=args.direct)
    summary(payload)
    if args.save:
        args.save.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    if args.sample:
        args.sample.write_text(json.dumps(trimmed(payload), ensure_ascii=False, indent=1), encoding="utf-8")
    return 0 if payload["stations"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
