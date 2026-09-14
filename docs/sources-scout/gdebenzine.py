#!/usr/bin/env python3
"""ГдеБензин.ру (gdebenzine.ru): national pin list with status, available grades, prices, update time.

GET /api/pins (no key, no cookie) returns every pin in Russia in one response
(21 752 rows, ~0.9 MB JSON on 2026-09-14; 718 inside the SPb+LO box).  Row fields:
  id (osm_<OSM id> ...), lat, lng, name, fuels (catalog grades), status AVAILABLE|NONE|UNKNOWN,
  updatedAt, latestAvailableFuels, latestFuelPrice{grade: price}, cenaChasovNazad (price age, h),
  reportsCount, commentsCount.
Per-grade status is derived: a grade in latestAvailableFuels is "yes"; status NONE makes the
catalog grades "no"; everything else is "unknown".  The derivation is marked in the output.

    python gdebenzine.py [--direct] [--aoi] [--save out.json] [--sample sample.json]
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

HOST = "https://gdebenzine.ru"
BBOX = (58.4, 27.6, 61.4, 35.8)      # south, west, north, east: SPb + Leningrad oblast
AOI = (59.60, 29.50, 60.35, 31.10)   # production city core
FRESH_HOURS = 6
BROWSER_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"
)


def _grade(label: Any) -> str:
    text = str(label).strip().upper().replace("АИ-", "")
    return {"ДТ": "dt", "ГАЗ": "gas", "СУГ": "gas", "МЕТАН": "cng"}.get(text, text.lower())


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(moment: datetime) -> str:
    return moment.isoformat(timespec="seconds").replace("+00:00", "Z")


def _hours(ts: str | None) -> float:
    if not ts:
        return float("inf")
    try:
        moment = datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
    except ValueError:
        return float("inf")
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return (_now() - moment).total_seconds() / 3600


def _age(ts: str | None) -> str:
    hours = _hours(ts)
    if hours == float("inf"):
        return "n/a"
    return f"{hours * 60:.0f} min" if hours < 2 else f"{hours:.1f} h" if hours < 48 else f"{hours / 24:.0f} days"


def _inside(lat: float, lon: float, box: tuple[float, float, float, float]) -> bool:
    south, west, north, east = box
    return south <= lat <= north and west <= lon <= east


def fetch_pins(*, direct: bool) -> list[dict[str, Any]]:
    opener = build_opener(ProxyHandler({})) if direct else build_opener()
    request = Request(f"{HOST}/api/pins", headers={
        "User-Agent": BROWSER_UA,
        "Accept": "application/json",
        "Accept-Language": "ru,en;q=0.8",
        "Referer": HOST + "/",
    })
    with opener.open(request, timeout=90) as response:
        return json.loads(response.read().decode("utf-8"))


def normalize(pin: dict[str, Any]) -> dict[str, Any]:
    catalog = [_grade(f) for f in pin.get("fuels") or []]
    available = [_grade(f) for f in pin.get("latestAvailableFuels") or []]
    status = pin.get("status")
    grades: dict[str, str] = {}
    for grade in dict.fromkeys(catalog + available):
        if grade in available:
            grades[grade] = "yes"
        elif status == "NONE":
            grades[grade] = "no"
        else:
            grades[grade] = "unknown"
    return {
        "id": f"gdebenzine:{pin.get('id')}",
        "lat": pin.get("lat"),
        "lon": pin.get("lng"),
        "name": pin.get("name"),
        "status": status,
        "updated_at": pin.get("updatedAt"),
        "grades_derived": grades,
        "prices": {_grade(k): v for k, v in (pin.get("latestFuelPrice") or {}).items()},
        "price_age_hours": pin.get("cenaChasovNazad"),
        "reports": pin.get("reportsCount"),
        "comments": pin.get("commentsCount"),
    }


def collect(*, direct: bool = False, bbox: tuple[float, float, float, float] = BBOX) -> dict[str, Any]:
    captured = _now()
    pins = fetch_pins(direct=direct)
    stations = [normalize(p) for p in pins
                if p.get("lat") is not None and p.get("lng") is not None and _inside(p["lat"], p["lng"], bbox)]
    return {"captured_at": _iso(captured), "source": "gdebenzine", "pins_national": len(pins), "stations": stations}


def summarize(result: dict[str, Any]) -> None:
    stations = result["stations"]
    print(f"source {result['source']} captured {result['captured_at']}: {result['pins_national']} pins nationally, "
          f"{len(stations)} in bbox ({sum(1 for s in stations if _inside(s['lat'], s['lon'], AOI))} in production AOI)")
    print("  status:", dict(Counter(s["status"] for s in stations)))
    fresh = [s for s in stations if _hours(s["updated_at"]) < FRESH_HOURS]
    print(f"  updated < {FRESH_HOURS} h: {len(fresh)}; statuses {dict(Counter(s['status'] for s in fresh))}")
    for label, rows in (("all", stations), (f"< {FRESH_HOURS} h", fresh)):
        per_grade: dict[str, Counter[str]] = {}
        for station in rows:
            for grade, value in station["grades_derived"].items():
                per_grade.setdefault(grade, Counter())[value] += 1
        print(f"  derived grade status ({label}):", {g: dict(c) for g, c in sorted(per_grade.items())})
    newest = max((s["updated_at"] for s in stations if s["updated_at"]), default=None)
    print(f"  newest update {newest} (age {_age(newest)}); stations with reports: {sum(1 for s in stations if s['reports'])}")


def trim(result: dict[str, Any], keep: int = 80) -> str:
    ranked = sorted(result["stations"], key=lambda s: _hours(s["updated_at"]))
    while True:
        sample = {key: value for key, value in result.items() if key != "stations"}
        sample["total_stations"] = len(result["stations"])
        sample["stations_note"] = f"{keep} most recently updated stations kept"
        sample["stations"] = ranked[:keep]
        text = json.dumps(sample, ensure_ascii=False, indent=1)
        if len(text.encode("utf-8")) <= 48_000 or keep <= 5:
            return text
        keep = int(keep * 0.8)


def main(argv: list[str] | None = None) -> int:
    sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description="gdebenzine.ru pins for SPb and Leningrad oblast")
    parser.add_argument("--direct", action="store_true", help="bypass HTTPS_PROXY")
    parser.add_argument("--aoi", action="store_true", help="only the production city core")
    parser.add_argument("--save", help="write the normalized collection here")
    parser.add_argument("--sample", help="write a trimmed sample here")
    args = parser.parse_args(argv)
    result = collect(direct=args.direct, bbox=AOI if args.aoi else BBOX)
    summarize(result)
    if args.save:
        Path(args.save).write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
    if args.sample:
        Path(args.sample).write_text(trim(result), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
