#!/usr/bin/env python3
"""Топливный Радар (топливныйрадар.рф): driver reports per grade with timestamps and trust.

GET /api/stations?fuel=all&statuses=all&bbox=S,W,N,E&limit=N  (N <= 900, larger -> HTTP 422)
returns {"fuel", "count", "stations"} and silently stops at N rows, so the area is walked
as a grid whose full tiles are split into four.
Per station: status ok|out|queue|limit|unknown with status_at, confirmations, trust_level,
queue, limit_l, paused_until; per grade fuels{ai92,ai95,ai98,ai100,dt}{status, status_at,
last_confirmed_at, confirmations_count}.  external_source/status/status_at/fuels_now/prices
are rows imported from gdebenz (224 of 300 AOI rows on 2026-09-14): that layer duplicates an
existing source and must stay in the gdebenz cluster.  Catalog origin: fsq | osm | dir | user.

    python toplivnyiradar.py [--direct] [--full] [--grid 2] [--save out.json] [--sample sample.json]
"""

from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime, timezone
import json
from pathlib import Path
import sys
import time
from typing import Any
from urllib.parse import urlencode
from urllib.request import ProxyHandler, Request, build_opener

HOST = "https://xn--80aaejrhlsfkqdo6k.xn--p1ai"  # топливныйрадар.рф
BBOX = (58.4, 27.6, 61.4, 35.8)      # south, west, north, east: SPb + Leningrad oblast
AOI = (59.60, 29.50, 60.35, 31.10)   # production city core
LIMIT = 900
MAX_DEPTH = 3
FRESH_HOURS = 6  # the map's own "fresh" filter
BROWSER_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"
)
FUEL_KEYS = {"ai92": "92", "ai95": "95", "ai98": "98", "ai100": "100", "dt": "dt", "gas": "gas"}


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


def _split(box: tuple[float, float, float, float], parts: int) -> list[tuple[float, float, float, float]]:
    south, west, north, east = box
    dlat, dlon = (north - south) / parts, (east - west) / parts
    return [(south + r * dlat, west + c * dlon, south + (r + 1) * dlat, west + (c + 1) * dlon)
            for r in range(parts) for c in range(parts)]


def fetch_tile(box: tuple[float, float, float, float], *, direct: bool) -> list[dict[str, Any]]:
    south, west, north, east = box
    params = urlencode({
        "fuel": "all", "statuses": "all",
        "bbox": f"{south:.6f},{west:.6f},{north:.6f},{east:.6f}",
        "limit": LIMIT,
    })
    opener = build_opener(ProxyHandler({})) if direct else build_opener()
    request = Request(f"{HOST}/api/stations?{params}", headers={
        "User-Agent": BROWSER_UA,
        "Accept": "application/json",
        "Accept-Language": "ru,en;q=0.8",
        "Referer": HOST + "/map/",
    })
    with opener.open(request, timeout=60) as response:
        payload = json.loads(response.read().decode("utf-8"))
    return payload.get("stations") or []


def normalize(row: dict[str, Any]) -> dict[str, Any]:
    grades = {
        FUEL_KEYS.get(key, key): {
            "status": info.get("status"),
            "status_at": info.get("status_at"),
            "last_confirmed_at": info.get("last_confirmed_at"),
            "confirmations": info.get("confirmations_count"),
        }
        for key, info in (row.get("fuels") or {}).items()
    }
    return {
        "id": f"toplivnyiradar:{row['id']}",
        "lat": row.get("lat"),
        "lon": row.get("lon"),
        "brand": row.get("brand"),
        "address": row.get("address") or None,
        "city": row.get("city"),
        "region": row.get("region"),
        "catalog_source": row.get("source"),
        "own": {
            "status": row.get("status"),
            "status_at": row.get("status_at"),
            "trust_level": row.get("trust_level"),
            "confirmations": row.get("confirmations_count"),
            "last_confirmed_at": row.get("last_confirmed_at"),
            "queue": row.get("queue"),
            "limit_l": row.get("limit_l"),
            "limit_detail": row.get("limit_detail"),
            "paused_until": row.get("paused_until"),
            "grades": grades,
        },
        "external": None if not row.get("external_source") else {  # imported, e.g. gdebenz
            "source": row.get("external_source"),
            "status": row.get("external_status"),
            "status_at": row.get("external_status_at"),
            "fuels_now": row.get("external_fuels_now"),
            "prices": row.get("external_prices"),
            "confirmations": row.get("external_confirmations_count"),
        },
    }


def collect(*, direct: bool = False, bbox: tuple[float, float, float, float] = AOI, grid: int = 2,
            pause: float = 1.2) -> dict[str, Any]:
    captured = _now()
    merged: dict[Any, dict[str, Any]] = {}
    pending = [(tile, 0) for tile in _split(bbox, grid)]
    requests = truncated = 0
    while pending:
        box, depth = pending.pop(0)
        if requests:
            time.sleep(pause)
        rows = fetch_tile(box, direct=direct)
        requests += 1
        for row in rows:
            merged[row["id"]] = row
        if len(rows) >= LIMIT:
            if depth < MAX_DEPTH:
                pending.extend((child, depth + 1) for child in _split(box, 2))
            else:
                truncated += 1
    stations = [normalize(row) for row in merged.values()
                if row.get("lat") is not None and row.get("lon") is not None and _inside(row["lat"], row["lon"], bbox)]
    return {"captured_at": _iso(captured), "source": "toplivnyiradar", "bbox": list(bbox), "requests": requests,
            "truncated_tiles": truncated, "stations": stations}


def summarize(result: dict[str, Any]) -> None:
    stations = result["stations"]
    print(f"source {result['source']} captured {result['captured_at']}: {len(stations)} stations in bbox {result['bbox']} "
          f"({result['requests']} requests, truncated tiles {result['truncated_tiles']})")
    print("  catalog origin:", dict(Counter(s["catalog_source"] for s in stations)),
          "| regions:", dict(Counter(s["region"] for s in stations).most_common(3)))
    for label, limit in (("all ages", float("inf")), (f"younger than {FRESH_HOURS} h", FRESH_HOURS)):
        per_grade: dict[str, Counter[str]] = {}
        for station in stations:
            for grade, info in station["own"]["grades"].items():
                if _hours(info["status_at"]) < limit:
                    per_grade.setdefault(grade, Counter())[info["status"]] += 1
        print(f"  own grade reports, {label}:", {g: dict(c) for g, c in sorted(per_grade.items())})
    fresh = [s for s in stations if _hours(s["own"]["status_at"]) < FRESH_HOURS]
    newest = max((s["own"]["status_at"] for s in stations if s["own"]["status_at"]), default=None)
    print(f"  stations with own status < {FRESH_HOURS} h: {len(fresh)}; statuses {dict(Counter(s['own']['status'] for s in fresh))};"
          f" queue {sum(1 for s in fresh if s['own']['queue'])}; limit {sum(1 for s in fresh if s['own']['limit_l'])}")
    print(f"  newest own status {newest} (age {_age(newest)})")
    external = [s for s in stations if s["external"]]
    newest_external = max((s["external"]["status_at"] for s in external if s["external"]["status_at"]), default=None)
    print(f"  imported rows: {len(external)} {dict(Counter(s['external']['source'] for s in external))}; "
          f"newest imported {newest_external} (age {_age(newest_external)})")


def trim(result: dict[str, Any], keep: int = 60) -> str:
    ranked = sorted(result["stations"], key=lambda s: _hours(s["own"]["status_at"]))
    while True:
        sample = {key: value for key, value in result.items() if key != "stations"}
        sample["total_stations"] = len(result["stations"])
        sample["stations_note"] = f"{keep} stations with the freshest own status kept"
        sample["stations"] = ranked[:keep]
        text = json.dumps(sample, ensure_ascii=False, indent=1)
        if len(text.encode("utf-8")) <= 48_000 or keep <= 5:
            return text
        keep = int(keep * 0.8)


def main(argv: list[str] | None = None) -> int:
    sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description="топливныйрадар.рф stations")
    parser.add_argument("--direct", action="store_true", help="bypass HTTPS_PROXY")
    parser.add_argument("--full", action="store_true", help="SPb + Leningrad oblast instead of the city core")
    parser.add_argument("--grid", type=int, default=2, help="initial grid size per side")
    parser.add_argument("--save", help="write the normalized collection here")
    parser.add_argument("--sample", help="write a trimmed sample here")
    args = parser.parse_args(argv)
    result = collect(direct=args.direct, bbox=BBOX if args.full else AOI, grid=args.grid)
    summarize(result)
    if args.save:
        Path(args.save).write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
    if args.sample:
        Path(args.sample).write_text(trim(result), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
