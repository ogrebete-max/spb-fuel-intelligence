#!/usr/bin/env python3
"""Бензокарта (benzokarta.com): own driver reports, community status and Transit Card prices.

The public page talks to Supabase REST directly.  The publishable key below ships in the
page's JavaScript bundle (_next/static/chunks/659-*.js, NEXT_PUBLIC_SUPABASE_ANON_KEY
fallback): «ключ веб-клиента», a gray zone — no account behind it, but it is a key.
One embedded PostgREST query per page returns, for a bounding box, each station with
  - community_status: the site's per-grade summary (status, confidence, reported_at, limit),
  - fuel_reports of the last 24 h (fuel_kind, status, queue, limit_liters, delivery_at, created_at),
  - transitcard_status: status plus per-grade price/limit from the Transit Card network.
The page itself reads reports per station; the embedded join returns the same rows in one call.

    python benzokarta.py [--direct] [--aoi] [--hours 24] [--save out.json] [--sample sample.json]
"""

from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import sys
import time
from typing import Any
from urllib.parse import quote
from urllib.request import ProxyHandler, Request, build_opener

SUPABASE = "https://araqnwsxoesjwlexbddh.supabase.co"
WEB_CLIENT_KEY = "sb_publishable_XGGFi7H7SAo3spqiDxKBVg_uxcszkZr"  # ключ веб-клиента (see docstring)
BBOX = (58.4, 27.6, 61.4, 35.8)      # south, west, north, east: SPb + Leningrad oblast
AOI = (59.60, 29.50, 60.35, 31.10)   # production city core
PAGE = 1000
BROWSER_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"
)
KIND_TO_GRADE = {"ai92": "92", "ai95": "95", "ai98": "98", "ai100": "100", "diesel": "dt", "gas": "gas"}
SELECT = (
    "id,name,network,address,region,city,latitude,longitude,fuels,opening_hours,community_status,"
    "transitcard_status(status,fuels),"
    "fuel_reports(fuel_kind,status,queue,limit_liters,delivery_at,created_at)"
)


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


def _grade(kind: Any) -> str:
    return KIND_TO_GRADE.get(kind, str(kind))


def fetch_page(bbox: tuple[float, float, float, float], since: str, offset: int, *, direct: bool) -> list[dict[str, Any]]:
    south, west, north, east = bbox
    query = "&".join([
        "select=" + quote(SELECT, safe=",()"),
        "fuel_reports.created_at=gte." + quote(since, safe=""),
        "fuel_reports.order=created_at.desc",
        f"latitude=gte.{south}", f"latitude=lte.{north}",
        f"longitude=gte.{west}", f"longitude=lte.{east}",
        "order=id", f"limit={PAGE}", f"offset={offset}",
    ])
    opener = build_opener(ProxyHandler({})) if direct else build_opener()
    request = Request(f"{SUPABASE}/rest/v1/stations?{query}", headers={
        "apikey": WEB_CLIENT_KEY,
        "Authorization": f"Bearer {WEB_CLIENT_KEY}",
        "Accept": "application/json",
        "Accept-Language": "ru,en;q=0.8",
        "User-Agent": BROWSER_UA,
        "Origin": "https://benzokarta.com",
        "Referer": "https://benzokarta.com/",
    })
    with opener.open(request, timeout=90) as response:
        return json.loads(response.read().decode("utf-8"))


def _station(row: dict[str, Any]) -> dict[str, Any]:
    reports = sorted(row.get("fuel_reports") or [], key=lambda r: r.get("created_at") or "", reverse=True)
    latest: dict[str, Any] = {}
    for report in reports:
        latest.setdefault(_grade(report.get("fuel_kind")), {
            "status": report.get("status"),
            "queue": report.get("queue"),
            "limit_liters": report.get("limit_liters"),
            "delivery_at": report.get("delivery_at"),
            "reported_at": report.get("created_at"),
        })
    community = row.get("community_status") or {}
    card = row.get("transitcard_status")
    if isinstance(card, list):
        card = card[0] if card else None
    return {
        "id": f"benzokarta:{row['id']}",
        "lat": row.get("latitude"),
        "lon": row.get("longitude"),
        "network": row.get("network") or row.get("name"),
        "address": row.get("address") or None,
        "region": row.get("region"),
        "city": row.get("city") or None,
        "opening_hours": row.get("opening_hours"),
        "catalog_fuels": {_grade(f.get("kind")): f.get("availability") for f in row.get("fuels") or []},
        "reports": {"count": len(reports), "latest_by_grade": latest},
        "community": None if not community else {
            "overall": community.get("overall"),
            "updated_at": community.get("updated_at"),
            "sample": community.get("sample"),
            "grades": {
                _grade(f.get("kind")): {k: f.get(k) for k in ("status", "confidence", "reported_at", "restriction", "limit_liters", "confirmations")}
                for f in community.get("fuels") or []
            },
        },
        "transitcard": None if not card else {
            "status": card.get("status"),
            "grades": {_grade(f.get("kind")): {"price": f.get("price"), "availability": f.get("availability"), "limit_liters": f.get("limit_liters")}
                       for f in card.get("fuels") or []},
        },
    }


def collect(*, direct: bool = False, bbox: tuple[float, float, float, float] = BBOX, hours: int = 24) -> dict[str, Any]:
    captured = _now()
    since = _iso(captured - timedelta(hours=hours))
    rows: list[dict[str, Any]] = []
    offset = 0
    while True:
        page = fetch_page(bbox, since, offset, direct=direct)
        rows.extend(page)
        if len(page) < PAGE:
            break
        offset += PAGE
        time.sleep(1.5)
    stations = [_station(row) for row in rows if row.get("latitude") is not None and row.get("longitude") is not None]
    return {"captured_at": _iso(captured), "source": "benzokarta", "reports_since": since, "requests": offset // PAGE + 1, "stations": stations}


def summarize(result: dict[str, Any]) -> None:
    stations = result["stations"]
    print(f"source {result['source']} captured {result['captured_at']} ({result['requests']} request(s)): "
          f"{len(stations)} stations; regions {dict(Counter(s['region'] for s in stations).most_common(4))}")
    reported = [s for s in stations if s["reports"]["count"]]
    latest: dict[str, Counter[str]] = {}
    newest = None
    for station in reported:
        for grade, info in station["reports"]["latest_by_grade"].items():
            latest.setdefault(grade, Counter())[info["status"]] += 1
            newest = max(newest or "", info["reported_at"] or "")
    print(f"  reports since {result['reports_since']}: {sum(s['reports']['count'] for s in stations)} at {len(reported)} stations;"
          f" latest status per grade {({g: dict(c) for g, c in sorted(latest.items())})}; newest {newest or None} (age {_age(newest)})")
    community = [s for s in stations if s["community"]]
    print(f"  community_status on {len(community)} stations: overall {dict(Counter(s['community']['overall'] for s in community))};"
          f" updated <24h: {sum(1 for s in community if _hours(s['community']['updated_at']) < 24)}")
    cards = [s for s in stations if s["transitcard"]]
    prices = Counter(g for s in cards for g, info in s["transitcard"]["grades"].items() if info["price"] is not None)
    print(f"  transitcard_status on {len(cards)} stations: {dict(Counter(s['transitcard']['status'] for s in cards))}; prices per grade {dict(prices)}")


def trim(result: dict[str, Any], keep: int = 60) -> str:
    def rank(station: dict[str, Any]) -> tuple[int, int]:
        return (-station["reports"]["count"], 0 if station["community"] else 1)

    ranked = sorted(result["stations"], key=rank)
    while True:
        sample = {key: value for key, value in result.items() if key != "stations"}
        sample["total_stations"] = len(result["stations"])
        sample["stations_note"] = f"{keep} stations kept, most reported first"
        sample["stations"] = ranked[:keep]
        text = json.dumps(sample, ensure_ascii=False, indent=1)
        if len(text.encode("utf-8")) <= 48_000 or keep <= 5:
            return text
        keep = int(keep * 0.8)


def main(argv: list[str] | None = None) -> int:
    sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description="benzokarta.com stations for SPb and Leningrad oblast")
    parser.add_argument("--direct", action="store_true", help="bypass HTTPS_PROXY")
    parser.add_argument("--aoi", action="store_true", help="only the production city core")
    parser.add_argument("--hours", type=int, default=24, help="report window")
    parser.add_argument("--save", help="write the normalized collection here")
    parser.add_argument("--sample", help="write a trimmed sample here")
    args = parser.parse_args(argv)
    result = collect(direct=args.direct, bbox=AOI if args.aoi else BBOX, hours=args.hours)
    summarize(result)
    if args.save:
        Path(args.save).write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
    if args.sample:
        Path(args.sample).write_text(trim(result), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
