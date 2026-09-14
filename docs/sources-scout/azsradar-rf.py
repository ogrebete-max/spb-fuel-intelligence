#!/usr/bin/env python3
"""«АЗС радар» (азсрадар.рф): driver votes per grade plus the site's bank forecasts.

One anonymous GET returns every station of a bounding box (1061 for SPb+LO on 2026-09-14;
Cache-Control: max-age=15).  `fuel_statuses` / `status_updated_at` / `queue_size` /
`fuel_limit` are the site's own drivers.  `tbank_status`, `sber_status` and
`forecast_fuels` are the site's reading of T-Bank and SberAZS payments, i.e. sources we
already collect: keep them in that provenance cluster, never as an independent voice.
The site trusts votes and bank data for 4 hours.  The old domain azs-radar.ru now serves
a certificate for an unrelated host (TLS name mismatch) and is not used.

    python azsradar-rf.py [--direct] [--aoi] [--save out.json] [--sample sample.json]
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

HOST = "https://xn--80aaapn8cdd.xn--p1ai"  # азсрадар.рф
BBOX = (58.4, 27.6, 61.4, 35.8)      # south, west, north, east: SPb + Leningrad oblast
AOI = (59.60, 29.50, 60.35, 31.10)   # production city core
BROWSER_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"
)
VOTE_KEYS = {"AI-92": "92", "AI-95": "95", "AI-98": "98", "AI-100": "100", "DT": "dt"}
FORECAST_KEYS = {"АИ-92": "92", "АИ-95": "95", "АИ-98": "98", "АИ-100": "100", "ДТ": "dt"}
FRESH_HOURS = 4


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


def _buckets(values: list[float]) -> dict[str, int]:
    edges = [(0.5, "<30m"), (1, "<1h"), (4, "<4h"), (24, "<24h"), (72, "<3d"), (float("inf"), ">=3d")]
    counts: Counter[str] = Counter()
    for value in values:
        label = "none" if value == float("inf") else next(name for edge, name in edges if value < edge)
        counts[label] += 1
    return dict(counts)


def _inside(lat: float, lon: float, box: tuple[float, float, float, float]) -> bool:
    south, west, north, east = box
    return south <= lat <= north and west <= lon <= east


def fetch_json(url: str, *, direct: bool, referer: str) -> Any:
    opener = build_opener(ProxyHandler({})) if direct else build_opener()
    request = Request(url, headers={
        "User-Agent": BROWSER_UA,
        "Accept": "application/json",
        "Accept-Language": "ru,en;q=0.8",
        "Referer": referer,
    })
    with opener.open(request, timeout=60) as response:
        return json.loads(response.read().decode("utf-8"))


def collect(*, direct: bool = False, bbox: tuple[float, float, float, float] = BBOX) -> dict[str, Any]:
    south, west, north, east = bbox
    url = f"{HOST}/api/stations?minLat={south}&maxLat={north}&minLng={west}&maxLng={east}"
    captured = _now()
    rows = fetch_json(url, direct=direct, referer=HOST + "/")
    stations: list[dict[str, Any]] = []
    for row in rows:
        lat, lon = row.get("latitude"), row.get("longitude")
        if lat is None or lon is None or not _inside(lat, lon, bbox):
            continue
        stations.append({
            "id": f"azsradar:{row['id']}",
            "lat": lat,
            "lon": lon,
            "brand": row.get("brand"),
            "name": row.get("name"),
            "address": row.get("address"),
            "catalog_fuels": row.get("fuel_types"),
            "votes": {  # the site's own drivers
                "overall": row.get("status"),
                "grades": {VOTE_KEYS.get(k, k): v for k, v in (row.get("fuel_statuses") or {}).items()},
                "updated_at": row.get("status_updated_at"),
                "confidence_level": row.get("confidence_level"),
                "confidence_percent": row.get("confidence_percent"),
                "queue": row.get("queue_size"),
                "limit_liters": row.get("fuel_limit"),
                "break_until": row.get("break_until"),
            },
            "bank_forecast": {  # derived from T-Bank / SberAZS: dependent evidence
                "tbank": row.get("tbank_status"),
                "sber": row.get("sber_status"),
                "grades": {FORECAST_KEYS.get(k, k): v for k, v in (row.get("forecast_fuels") or {}).items()},
                "updated_at": row.get("forecast_updated_at"),
            },
        })
    return {"captured_at": _iso(captured), "source": "azsradar-rf", "url": url, "rows_returned": len(rows), "stations": stations}


def summarize(result: dict[str, Any]) -> None:
    stations = result["stations"]
    print(f"source {result['source']} captured {result['captured_at']}: {len(stations)} stations in bbox "
          f"({sum(1 for s in stations if _inside(s['lat'], s['lon'], AOI))} in production AOI)")
    for label, keep in (("votes, all ages", lambda s: True),
                        (f"votes younger than {FRESH_HOURS} h", lambda s: _hours(s["votes"]["updated_at"]) < FRESH_HOURS)):
        per_grade: dict[str, Counter[str]] = {}
        picked = [s for s in stations if keep(s)]
        for station in picked:
            for grade, status in station["votes"]["grades"].items():
                per_grade.setdefault(grade, Counter())[status] += 1
        print(f"  {label} ({len(picked)} stations):", {g: dict(c) for g, c in sorted(per_grade.items())})
    fresh = [s for s in stations if _hours(s["votes"]["updated_at"]) < FRESH_HOURS]
    print("  queue on fresh votes:", dict(Counter(s["votes"]["queue"] for s in fresh)),
          "| limit on fresh votes:", dict(Counter(str(s["votes"]["limit_liters"]) for s in fresh)))
    newest = max((s["votes"]["updated_at"] for s in stations if s["votes"]["updated_at"]), default=None)
    print(f"  newest vote {newest} (age {_age(newest)}); vote age buckets:",
          _buckets([_hours(s["votes"]["updated_at"]) for s in stations]))
    forecast: dict[str, Counter[str]] = {}
    for station in stations:
        for grade, status in station["bank_forecast"]["grades"].items():
            forecast.setdefault(grade, Counter())[status] += 1
    newest_forecast = max((s["bank_forecast"]["updated_at"] for s in stations if s["bank_forecast"]["updated_at"]), default=None)
    print("  bank forecast (dependent):", {g: dict(c) for g, c in sorted(forecast.items()) if g in ("92", "95", "98", "100", "dt")})
    print(f"  newest bank forecast {newest_forecast} (age {_age(newest_forecast)})")


def trim(result: dict[str, Any], keep: int = 60) -> str:
    ranked = sorted(result["stations"], key=lambda s: _hours(s["votes"]["updated_at"]))
    while True:
        sample = {key: value for key, value in result.items() if key != "stations"}
        sample["total_stations"] = len(result["stations"])
        sample["stations_note"] = f"{keep} most recently voted stations kept"
        sample["stations"] = ranked[:keep]
        text = json.dumps(sample, ensure_ascii=False, indent=1)
        if len(text.encode("utf-8")) <= 48_000 or keep <= 5:
            return text
        keep = int(keep * 0.8)


def main(argv: list[str] | None = None) -> int:
    sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description="азсрадар.рф stations for SPb and Leningrad oblast")
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
