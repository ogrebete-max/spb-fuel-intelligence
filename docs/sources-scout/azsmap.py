"""Prototype collector: AZS MAP crowd map (https://azsmap.com/region/lenobl).

Endpoint
    GET https://azsmap.com/api/data-model.js?city=lenobl
    The JavaScript file the map page loads (about 750 KB). It defines
    `const STATIONS = {...}` as plain JSON. The Leningrad-oblast model already
    holds every Saint Petersburg station (city=spb is a subset of it), so one
    request covers SPb+LO. No key, cookie or session.

Record (STATIONS[key])
    key    osm_<n|w><id> (OpenStreetMap card), u_<lat>_<lon> (added by users),
           ya_<id> (card taken from Yandex)
    brand, address, lat, lon, attrs, color/badge/logo (map styling)
    fuels  [grade, state, price, age_minutes, ...] per grade ai92|ai95|ai98|dt|gas
           state: have | low | none | stale  (the page names them Есть /
           Заканчивается / Нет / Нет данных); price like "65,15" or "—";
           the fourth field behaves as minutes since the last mark; the
           remaining five fields are unlabelled flags and counters.

Usage
    python azsmap.py [--direct] [--save full.json] [--sample sample.json]
"""

from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime, timezone
import json
from pathlib import Path
import re
import sys
from typing import Any
from urllib.request import ProxyHandler, Request, build_opener

URL = "https://azsmap.com/api/data-model.js?city=lenobl"
BBOX = {"south": 58.4, "north": 61.4, "west": 27.6, "east": 35.8}
CITY_AOI = {"south": 59.60, "north": 60.35, "west": 29.50, "east": 31.10}
FRESH_MINUTES = 180
BROWSER_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"
)
STATIONS_START = re.compile(r"const\s+STATIONS\s*=\s*")


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _inside(lat: Any, lon: Any, box: dict[str, float]) -> bool:
    try:
        lat, lon = float(lat), float(lon)
    except (TypeError, ValueError):
        return False
    return box["south"] <= lat <= box["north"] and box["west"] <= lon <= box["east"]


def collect(direct: bool = False, timeout: int = 60) -> dict[str, Any]:
    opener = build_opener(ProxyHandler({})) if direct else build_opener()
    request = Request(URL, headers={
        "User-Agent": BROWSER_UA,
        "Accept": "*/*",
        "Accept-Language": "ru,en;q=0.8",
        "Referer": "https://azsmap.com/region/lenobl",
    })
    with opener.open(request, timeout=timeout) as response:
        script = response.read().decode("utf-8", "replace")
    match = STATIONS_START.search(script)
    if not match:
        raise RuntimeError("azsmap: STATIONS block is missing from the data model")
    raw, _ = json.JSONDecoder().raw_decode(script, match.end())
    stations = []
    for key, row in raw.items():
        if not _inside(row.get("lat"), row.get("lon"), BBOX):
            continue
        fuels = []
        for item in row.get("fuels") or []:
            if not isinstance(item, list) or len(item) < 4:
                continue
            fuels.append({
                "grade": item[0],
                "state": item[1],
                "price": None if item[2] in (None, "—") else item[2],
                "age_minutes": item[3] if isinstance(item[3], (int, float)) else None,
                "raw": item,
            })
        stations.append({
            "key": key,
            "origin": key.split("_", 1)[0],
            "brand": row.get("brand"),
            "address": row.get("address"),
            "lat": row.get("lat"),
            "lon": row.get("lon"),
            "fuels": fuels,
        })
    return {
        "captured_at": _now().isoformat().replace("+00:00", "Z"),
        "source": URL,
        "stations": stations,
    }


def _freshest(station: dict[str, Any]) -> float | None:
    ages = [fuel["age_minutes"] for fuel in station["fuels"]
            if fuel["state"] != "stale" and fuel["age_minutes"] is not None]
    return min(ages) if ages else None


def summary(payload: dict[str, Any]) -> None:
    stations = payload["stations"]
    city = sum(1 for row in stations if _inside(row["lat"], row["lon"], CITY_AOI))
    print(f"azsmap.com: {len(stations)} stations in SPb/LO ({city} in the city AOI); "
          f"cards by origin {dict(Counter(row['origin'] for row in stations))}")
    grades: dict[str, Counter[str]] = {}
    for row in stations:
        for fuel in row["fuels"]:
            grades.setdefault(str(fuel["grade"]), Counter())[str(fuel["state"])] += 1
    for grade in sorted(grades):
        print(f"  {grade:5} " + ", ".join(f"{key}={value}" for key, value in grades[grade].most_common()))
    ages = [age for age in map(_freshest, stations) if age is not None]
    fresh = sum(1 for age in ages if age < FRESH_MINUTES)
    day = sum(1 for age in ages if age < 1440)
    print(f"  stations with a mark newer than 3 h: {fresh}; newer than 24 h: {day}")
    if ages:
        print(f"  newest mark {min(ages):.0f} min old (the feed's own age field)")
    print(f"  grade entries with a price: {sum(1 for row in stations for fuel in row['fuels'] if fuel['price'])}")


def trimmed(payload: dict[str, Any], max_bytes: int = 45_000) -> dict[str, Any]:
    rows = sorted(payload["stations"], key=lambda row: _freshest(row) if _freshest(row) is not None else 1e12)
    count = min(150, len(rows))
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
