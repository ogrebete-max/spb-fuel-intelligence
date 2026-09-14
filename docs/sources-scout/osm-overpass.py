#!/usr/bin/env python3
"""OpenStreetMap fuel stations of Saint Petersburg and Leningrad oblast (Overpass API).

Catalog only: OSM carries no live stock.  fuel:octane_92/95/98/100 and fuel:diesel say
which grades a station is mapped as selling; check_date and the element's last edit say
how old that mapping is.  One POST per run, meant for a daily or weekly catalog refresh,
never for the 10-minute loop.

overpass-api.de answers HTTP 406 to a browser User-Agent (verified 2026-09-14, from a
Russian and a Swedish IP); an honest tool User-Agent gets through, so that is the default.

    python osm-overpass.py [--direct] [--endpoint URL] [--ua tool|browser|STRING]
                           [--save out.json] [--raw-save raw.json] [--sample sample.json]
    python osm-overpass.py --input raw.json      # parse a saved response, no network
"""

from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime, timezone
import json
from pathlib import Path
import sys
from typing import Any
from urllib.parse import urlencode
from urllib.request import ProxyHandler, Request, build_opener

BBOX = (58.4, 27.6, 61.4, 35.8)      # south, west, north, east: SPb + Leningrad oblast
AOI = (59.60, 29.50, 60.35, 31.10)   # production city core
ENDPOINTS = (
    "https://overpass-api.de/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
)
BROWSER_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"
)
# Overpass asks API clients to identify themselves; add a contact before production use.
TOOL_UA = "spb-fuel-catalog/0.1 (non-commercial)"

# One request, three blocks, each introduced by an `out count` row:
#   1) ids of fuel stations inside the Saint Petersburg area,
#   2) ids inside the Leningrad oblast area,
#   3) full records for the SPb+LO bounding box.
# If an instance has no area index, blocks 1-2 come back empty and the bbox block still
# delivers every station (region "unknown", neighbours in Finland/Estonia/Karelia included).
QUERY = """[out:json][timeout:180];
area["ISO3166-2"="RU-SPE"]->.spb;
area["ISO3166-2"="RU-LEN"]->.lo;
nwr["amenity"="fuel"](area.spb)->.fs;
nwr["amenity"="fuel"](area.lo)->.fl;
nwr["amenity"="fuel"](58.4,27.6,61.4,35.8)->.fb;
.fs out count;
.fs out ids;
.fl out count;
.fl out ids;
.fb out count;
.fb out center meta;
"""
BLOCKS = ("spb", "lo", "bbox")
REGIONS = ("spb", "lo")
GRADE_TAGS = {
    "92": "fuel:octane_92", "95": "fuel:octane_95", "98": "fuel:octane_98",
    "100": "fuel:octane_100", "dt": "fuel:diesel",
}
DATE_TAGS = ("check_date", "check_date:fuel", "survey:date", "survey_date", "source:date")
LIFECYCLE_PREFIXES = ("disused:", "abandoned:", "was:", "construction:", "proposed:", "demolished:")


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(moment: datetime) -> str:
    return moment.isoformat().replace("+00:00", "Z")


def _parse_time(value: str | None) -> datetime | None:
    if not value:
        return None
    text = value.strip().replace("Z", "+00:00")
    for candidate in (text, text + "T00:00:00+00:00", text + "-01T00:00:00+00:00"):
        try:
            moment = datetime.fromisoformat(candidate)
        except ValueError:
            continue
        return moment if moment.tzinfo else moment.replace(tzinfo=timezone.utc)
    return None


def _age(value: str | None) -> str:
    moment = _parse_time(value)
    if not moment:
        return "n/a"
    seconds = (_now() - moment).total_seconds()
    if seconds < 3600:
        return f"{seconds / 60:.0f} min"
    if seconds < 86400 * 2:
        return f"{seconds / 3600:.1f} h"
    return f"{seconds / 86400:.0f} days"


def _inside(lat: float, lon: float, box: tuple[float, float, float, float]) -> bool:
    south, west, north, east = box
    return south <= lat <= north and west <= lon <= east


def fetch(endpoint: str, *, direct: bool, user_agent: str, timeout: int = 240) -> bytes:
    opener = build_opener(ProxyHandler({})) if direct else build_opener()
    request = Request(
        endpoint,
        data=urlencode({"data": QUERY}).encode("utf-8"),
        headers={
            "User-Agent": user_agent,
            "Accept": "*/*",
            "Accept-Language": "ru,en;q=0.8",
            "Content-Type": "application/x-www-form-urlencoded",
        },
    )
    with opener.open(request, timeout=timeout) as response:
        return response.read()


def _station(element: dict[str, Any], region: str) -> dict[str, Any] | None:
    center = element.get("center") or {}
    lat = element.get("lat", center.get("lat"))
    lon = element.get("lon", center.get("lon"))
    if lat is None or lon is None or not _inside(lat, lon, BBOX):
        return None
    tags = element.get("tags") or {}
    address = ", ".join(
        part for part in (
            tags.get("addr:city") or tags.get("addr:place"),
            tags.get("addr:street"),
            tags.get("addr:housenumber"),
        ) if part
    )
    return {
        "id": f"osm:{element['type']}/{element['id']}",
        "lat": round(lat, 6),
        "lon": round(lon, 6),
        "region": region,
        "in_aoi": _inside(lat, lon, AOI),
        "name": tags.get("name"),
        "brand": tags.get("brand"),
        "operator": tags.get("operator"),
        "brand_wikidata": tags.get("brand:wikidata"),
        "address": address or None,
        "opening_hours": tags.get("opening_hours"),
        # Mapped assortment, not stock: "yes"/"no" as last surveyed by a mapper.
        "grades": {grade: tags[key] for grade, key in GRADE_TAGS.items() if key in tags},
        "other_fuel": {
            key[5:]: value for key, value in tags.items()
            if key.startswith("fuel:") and key not in GRADE_TAGS.values()
        },
        "check_date": next((tags[key] for key in DATE_TAGS if key in tags), None),
        "last_edit": element.get("timestamp"),
        "version": element.get("version"),
        "lifecycle": sorted(key for key in tags if key.startswith(LIFECYCLE_PREFIXES)) or None,
    }


def normalize(payload: dict[str, Any]) -> dict[str, Any]:
    members: dict[str, set[str]] = {"spb": set(), "lo": set()}
    declared: dict[str, int] = {}
    records: list[dict[str, Any]] = []
    block = -1
    for element in payload.get("elements", []):
        if element.get("type") == "count":
            block += 1
            if block < len(BLOCKS):
                declared[BLOCKS[block]] = int((element.get("tags") or {}).get("total", 0))
            continue
        if not 0 <= block < len(BLOCKS):
            continue
        if BLOCKS[block] in members:
            members[BLOCKS[block]].add(f"{element['type']}/{element['id']}")
        else:
            records.append(element)
    areas_available = bool(members["spb"] or members["lo"])
    stations: list[dict[str, Any]] = []
    seen: set[str] = set()
    outside_regions = 0
    for element in records:
        key = f"{element['type']}/{element['id']}"
        seen.add(key)
        if areas_available:
            region = "spb" if key in members["spb"] else "lo" if key in members["lo"] else None
            if region is None:
                outside_regions += 1  # Finland, Estonia, Karelia, Novgorod... inside the bbox
                continue
        else:
            region = "unknown"
        station = _station(element, region)
        if station:
            stations.append(station)
    return {
        "captured_at": _iso(_now()),
        "source": "openstreetmap-overpass",
        "osm_base": (payload.get("osm3s") or {}).get("timestamp_osm_base"),
        "areas_available": areas_available,
        "declared_counts": declared,
        "bbox_rows_outside_spb_lo": outside_regions,
        "area_rows_missing_from_bbox": len((members["spb"] | members["lo"]) - seen),
        "stations": stations,
    }


def collect(*, direct: bool = False, endpoint: str | None = None, user_agent: str = TOOL_UA,
            raw_save: str | None = None) -> dict[str, Any]:
    errors: list[str] = []
    for url in ([endpoint] if endpoint else list(ENDPOINTS)):
        try:
            raw = fetch(url, direct=direct, user_agent=user_agent)
        except Exception as exc:  # noqa: BLE001 - report and try the next mirror
            errors.append(f"{url}: {exc}")
            continue
        if raw_save:
            Path(raw_save).write_bytes(raw)
        result = normalize(json.loads(raw.decode("utf-8")))
        result.update({"endpoint": url, "errors": errors})
        return result
    raise RuntimeError("all Overpass endpoints failed: " + " | ".join(errors))


def _label(station: dict[str, Any]) -> str:
    return (station.get("brand") or station.get("operator") or station.get("name") or "(no name)").strip()


def stats(result: dict[str, Any]) -> dict[str, Any]:
    stations = result["stations"]
    spelling: dict[str, str] = {}
    labels: Counter[str] = Counter()
    for station in stations:
        label = _label(station)
        spelling.setdefault(label.casefold(), label)
        labels[label.casefold()] += 1
    fuel_tags: Counter[str] = Counter()
    for station in stations:
        for grade, value in station["grades"].items():
            fuel_tags[f"{GRADE_TAGS[grade]}={value}"] += 1
        for key, value in station["other_fuel"].items():
            fuel_tags[f"fuel:{key}={value}"] += 1
    edits = sorted(s["last_edit"] for s in stations if s.get("last_edit"))
    checks = sorted(s["check_date"] for s in stations if s.get("check_date"))
    return {
        "total_stations": len(stations),
        "by_region": dict(Counter(s["region"] for s in stations)),
        "in_production_aoi": sum(1 for s in stations if s["in_aoi"]),
        "top_labels": [[spelling[key], count] for key, count in labels.most_common(25)],
        "tag_presence": {
            "brand": sum(1 for s in stations if s.get("brand")),
            "operator": sum(1 for s in stations if s.get("operator")),
            "name": sum(1 for s in stations if s.get("name")),
            "brand_wikidata": sum(1 for s in stations if s.get("brand_wikidata")),
            "address": sum(1 for s in stations if s.get("address")),
            "opening_hours": sum(1 for s in stations if s.get("opening_hours")),
            "opening_hours_24_7": sum(1 for s in stations if s.get("opening_hours") == "24/7"),
            "any_grade_tag": sum(1 for s in stations if s["grades"]),
            "check_date": len(checks),
            "lifecycle_prefix": sum(1 for s in stations if s.get("lifecycle")),
        },
        "fuel_tags": dict(fuel_tags.most_common()),
        "last_edit_by_year": dict(sorted(Counter(e[:4] for e in edits).items())),
        "check_date_by_year": dict(sorted(Counter(c[:4] for c in checks).items())),
        "newest_last_edit": edits[-1] if edits else None,
        "newest_check_date": checks[-1] if checks else None,
    }


def summarize(result: dict[str, Any]) -> None:
    info = stats(result)
    print(f"source {result['source']} via {result.get('endpoint', 'saved file')}; captured {result['captured_at']}")
    print(f"osm_base {result['osm_base']} (age {_age(result['osm_base'])}); areas available: {result['areas_available']}")
    print(f"declared by Overpass: {result['declared_counts']}; bbox rows outside SPb/LO: {result['bbox_rows_outside_spb_lo']}")
    print(f"stations in SPb/LO: {info['total_stations']} {info['by_region']}; in production AOI: {info['in_production_aoi']}")
    print("tag presence:", info["tag_presence"])
    print("top brand/operator/name:", ", ".join(f"{label} {count}" for label, count in info["top_labels"]))
    print("per-grade tags (mapped assortment, not stock):")
    for key in GRADE_TAGS.values():
        values = {tag.split("=", 1)[1]: n for tag, n in info["fuel_tags"].items() if tag.split("=", 1)[0] == key}
        print(f"  {key}: {values or '-'}")
    others = {tag: n for tag, n in info["fuel_tags"].items() if tag.split("=", 1)[0] not in GRADE_TAGS.values()}
    print("other fuel tags:", others)
    print(f"newest last edit {info['newest_last_edit']} (age {_age(info['newest_last_edit'])}); by year {info['last_edit_by_year']}")
    print(f"newest check_date {info['newest_check_date']} (age {_age(info['newest_check_date'])}); by year {info['check_date_by_year']}")


def trim(result: dict[str, Any], per_region: int = 50) -> dict[str, Any]:
    picked: list[dict[str, Any]] = []
    for region in (*REGIONS, "unknown"):
        rows = [s for s in result["stations"] if s["region"] == region]
        # Prefer richly tagged rows so the sample documents every field.
        rows.sort(key=lambda s: (-(len(s["grades"]) + bool(s["check_date"]) + bool(s["opening_hours"])), s["id"]))
        picked.extend(rows[:per_region])
    sample = {key: value for key, value in result.items() if key != "stations"}
    sample["stats"] = stats(result)
    sample["stations_note"] = f"{len(picked)} of {len(result['stations'])} stations kept"
    sample["stations"] = picked
    return sample


def main(argv: list[str] | None = None) -> int:
    sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description="OSM fuel stations for SPb and Leningrad oblast")
    parser.add_argument("--direct", action="store_true", help="bypass HTTPS_PROXY")
    parser.add_argument("--endpoint", help="a single Overpass interpreter URL (default: try the list)")
    parser.add_argument("--ua", default="tool", help="'tool', 'browser' or a literal User-Agent")
    parser.add_argument("--input", help="parse a saved Overpass JSON instead of fetching")
    parser.add_argument("--raw-save", help="write the raw Overpass response here")
    parser.add_argument("--save", help="write the normalized collection here")
    parser.add_argument("--sample", help="write a trimmed ~100-station sample here")
    args = parser.parse_args(argv)

    user_agent = {"browser": BROWSER_UA, "tool": TOOL_UA}.get(args.ua, args.ua)
    if args.input:
        result = normalize(json.loads(Path(args.input).read_text(encoding="utf-8")))
    else:
        result = collect(direct=args.direct, endpoint=args.endpoint, user_agent=user_agent,
                         raw_save=args.raw_save)
    summarize(result)
    if args.save:
        Path(args.save).write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
    if args.sample:
        Path(args.sample).write_text(json.dumps(trim(result), ensure_ascii=False, indent=1), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
