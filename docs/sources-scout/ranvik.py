#!/usr/bin/env python3
"""Ranvik maps (maps.ranvik.ru): per-grade availability summarised from external sources and users.

GET /server/maps/stations?bbox=minLng,minLat,maxLng,maxLat&limit=50[&cursor=...]  (no key)
returns {"items": [...], "clusters": [], "meta": {mode, zoom, bbox, itemCount, limit, hasMore, nextCursor}}.
At most 50 items per page (a bigger limit is clamped); pages are ordered by the latest report
time (cursor = base64 of {"t": "<Moscow time>", "id": ...}), so a poller can stop as soon as a
page is older than it cares about.
Per item: id, slug osm-<type>-<id>, brand, name, address, place, lat, lng, status, fuels,
fuelAvailability{92,95,98,100,dt}{status, confidence, source external|user|custom|unknown,
freshness, lastReportedAt, lastObservedAt, counts{sourceYes,sourceNo,userYes,userNo}},
queueLevel, presence{presenceStatus, confidence, user{...}, external{...}}.
Timestamps are Moscow local time without an offset and are converted to UTC here.
In the AOI sourceYes/No outweigh userYes/No about 15:1: mostly a re-aggregation of other maps
and payment layers that the site does not name, so treat it as a dependent aggregator.

    python ranvik.py [--direct] [--full] [--pages 3] [--max-age-hours H] [--save out.json] [--sample sample.json]
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
from urllib.parse import urlencode
from urllib.request import ProxyHandler, Request, build_opener

HOST = "https://maps.ranvik.ru"
BBOX = (58.4, 27.6, 61.4, 35.8)      # south, west, north, east: SPb + Leningrad oblast
AOI = (59.60, 29.50, 60.35, 31.10)   # production city core
PAGE_LIMIT = 50
MSK = timezone(timedelta(hours=3))
BROWSER_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"
)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(moment: datetime) -> str:
    return moment.isoformat(timespec="seconds").replace("+00:00", "Z")


def _msk_to_utc(text: Any) -> str | None:
    if not text:
        return None
    try:
        moment = datetime.fromisoformat(str(text).strip().replace(" ", "T"))
    except ValueError:
        return None
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=MSK)
    return _iso(moment.astimezone(timezone.utc))


def _hours(ts: str | None) -> float:
    if not ts:
        return float("inf")
    try:
        moment = datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except ValueError:
        return float("inf")
    return (_now() - moment).total_seconds() / 3600


def _age(ts: str | None) -> str:
    hours = _hours(ts)
    if hours == float("inf"):
        return "n/a"
    return f"{hours * 60:.0f} min" if hours < 2 else f"{hours:.1f} h" if hours < 48 else f"{hours / 24:.0f} days"


def fetch_page(bbox: tuple[float, float, float, float], cursor: str | None, *, direct: bool) -> dict[str, Any]:
    south, west, north, east = bbox
    params = {"bbox": f"{west},{south},{east},{north}", "limit": PAGE_LIMIT}
    if cursor:
        params["cursor"] = cursor
    opener = build_opener(ProxyHandler({})) if direct else build_opener()
    request = Request(f"{HOST}/server/maps/stations?{urlencode(params)}", headers={
        "User-Agent": BROWSER_UA,
        "Accept": "application/json",
        "Accept-Language": "ru,en;q=0.8",
        "Referer": HOST + "/",
    })
    with opener.open(request, timeout=60) as response:
        return json.loads(response.read().decode("utf-8"))


def normalize(item: dict[str, Any]) -> dict[str, Any]:
    grades: dict[str, Any] = {}
    for grade, info in (item.get("fuelAvailability") or {}).items():
        grades[grade] = {
            "status": info.get("status"),
            "confidence": info.get("confidence"),
            "source": info.get("source"),
            "freshness": info.get("freshness"),
            "last_reported_at": _msk_to_utc(info.get("lastReportedAt")),
            "last_observed_at": _msk_to_utc(info.get("lastObservedAt")),
            "counts": info.get("counts"),
        }
    presence = item.get("presence") or {}
    user = presence.get("user") or {}
    external = presence.get("external") or {}
    return {
        "id": f"ranvik:{item.get('id')}",
        "osm": item.get("slug"),
        "lat": item.get("lat"),
        "lon": item.get("lng"),
        "brand": item.get("brand"),
        "name": item.get("name"),
        "address": item.get("address"),
        "place": item.get("place"),
        "status": item.get("status"),
        "catalog_fuels": item.get("fuels"),
        "queue_level": item.get("queueLevel"),
        "last_reported_at": _msk_to_utc(item.get("lastReportedAt")),
        "grades": grades,
        "presence": {
            "status": presence.get("presenceStatus"),
            "confidence": presence.get("confidence"),
            "user": {"status": user.get("status"), "total": user.get("total"), "last_reported_at": _msk_to_utc(user.get("lastReportedAt"))},
            "external": {"status": external.get("status"), "total": external.get("total"), "last_observed_at": _msk_to_utc(external.get("lastObservedAt"))},
        },
    }


def collect(*, direct: bool = False, bbox: tuple[float, float, float, float] = AOI, pages: int = 3,
            max_age_hours: float | None = None, pause: float = 1.2) -> dict[str, Any]:
    captured = _now()
    items: dict[Any, dict[str, Any]] = {}
    cursor: str | None = None
    fetched = 0
    has_more = False
    while fetched < pages:
        if fetched:
            time.sleep(pause)
        payload = fetch_page(bbox, cursor, direct=direct)
        fetched += 1
        page_items = payload.get("items") or []
        for item in page_items:
            items[item.get("id")] = item
        meta = payload.get("meta") or {}
        cursor, has_more = meta.get("nextCursor"), bool(meta.get("hasMore"))
        oldest = min((_msk_to_utc(i.get("lastReportedAt")) or "" for i in page_items), default="")
        if not has_more or not cursor:
            break
        if max_age_hours is not None and oldest and _hours(oldest) > max_age_hours:
            break
    stations = [normalize(item) for item in items.values() if item.get("lat") is not None and item.get("lng") is not None]
    return {"captured_at": _iso(captured), "source": "ranvik", "bbox": list(bbox), "pages": fetched,
            "has_more": has_more, "stations": stations}


def summarize(result: dict[str, Any]) -> None:
    stations = result["stations"]
    print(f"source {result['source']} captured {result['captured_at']}: {len(stations)} stations from {result['pages']} page(s); "
          f"more pages available: {result['has_more']}")
    per_grade: dict[str, Counter[str]] = {}
    freshness: Counter[str] = Counter()
    counts: Counter[str] = Counter()
    observed: list[str] = []
    for station in stations:
        for grade, info in station["grades"].items():
            per_grade.setdefault(grade, Counter())[info["status"]] += 1
            freshness[info["freshness"]] += 1
            for key, value in (info["counts"] or {}).items():
                counts[key] += value or 0
            if info["last_observed_at"]:
                observed.append(info["last_observed_at"])
    print("  status per grade:", {g: dict(c) for g, c in sorted(per_grade.items())})
    print("  freshness:", dict(freshness), "| evidence counts:", dict(counts))
    print("  presence:", dict(Counter(s["presence"]["status"] for s in stations)), "| queue level:", dict(Counter(s["queue_level"] for s in stations)))
    newest = max(observed, default=None)
    newest_report = max((s["last_reported_at"] for s in stations if s["last_reported_at"]), default=None)
    print(f"  newest observation {newest} (age {_age(newest)}); newest station report {newest_report} (age {_age(newest_report)})")


def trim(result: dict[str, Any], keep: int = 40) -> str:
    ranked = sorted(result["stations"], key=lambda s: _hours(s["last_reported_at"]))
    while True:
        sample = {key: value for key, value in result.items() if key != "stations"}
        sample["total_stations"] = len(result["stations"])
        sample["stations_note"] = f"{keep} most recently reported stations kept"
        sample["stations"] = ranked[:keep]
        text = json.dumps(sample, ensure_ascii=False, indent=1)
        if len(text.encode("utf-8")) <= 48_000 or keep <= 5:
            return text
        keep = int(keep * 0.8)


def main(argv: list[str] | None = None) -> int:
    sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description="maps.ranvik.ru stations")
    parser.add_argument("--direct", action="store_true", help="bypass HTTPS_PROXY")
    parser.add_argument("--full", action="store_true", help="SPb + Leningrad oblast instead of the city core")
    parser.add_argument("--pages", type=int, default=3, help="page cap (50 stations per page)")
    parser.add_argument("--max-age-hours", type=float, help="stop paging once a page is older than this")
    parser.add_argument("--save", help="write the normalized collection here")
    parser.add_argument("--sample", help="write a trimmed sample here")
    args = parser.parse_args(argv)
    result = collect(direct=args.direct, bbox=BBOX if args.full else AOI, pages=args.pages, max_age_hours=args.max_age_hours)
    summarize(result)
    if args.save:
        Path(args.save).write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
    if args.sample:
        Path(args.sample).write_text(trim(result), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
