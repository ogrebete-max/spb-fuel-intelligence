"""Stations whose feed has gone quiet.

A station exists in a snapshot only while some source lists it. On 14 Sep 2026
gdezapravka.ru stopped answering, and the ~250 stations only it knew vanished
from the map: drivers could no longer see those forecourts existed at all. A
failure upstream is not news about the forecourt.

Every build therefore leaves a small catalogue of the stations it published —
name, address, coordinates, source ids — and when each source last listed them.
The next build brings back a station that is missing only because a source that
listed it failed on this refresh, and notes which failing sources used to cover
the stations that are still there. Only identity comes back, never evidence: a
returned station has nothing to vote with, so the ordinary freshness rules read
every grade as «нет свежих данных».

A forecourt that really closed must not linger, so the memory runs out a week
after a source last listed the station. A source that answers and no longer
lists a station is believed at once.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
from typing import Any, Iterable

from .evidence_engine import parse_time
from .station_matcher import is_match


RETENTION = timedelta(days=7)
SCHEMA_VERSION = 1


def _iso(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _time(stamp: Any) -> datetime:
    return parse_time(stamp) or datetime.min.replace(tzinfo=timezone.utc)


def _latest(stamps: Iterable[str]) -> str:
    # Stamps are compared as times: an ISO string without microseconds sorts
    # after the same second with them.
    return max(stamps, key=_time)


def _ref_key(ref: dict[str, Any]) -> tuple[str, str]:
    return str(ref.get("source")), str(ref.get("station_id"))


def _cell(location: dict[str, Any]) -> tuple[int, int]:
    # The buckets merge_stations uses, so a remembered station is compared with
    # the stations it could have been merged with.
    return round(float(location["lat"]) * 500), round(float(location["lon"]) * 500)


def _usable(entry: Any) -> bool:
    if not isinstance(entry, dict) or not entry.get("id"):
        return False
    location = entry.get("location")
    refs = entry.get("source_refs")
    return (
        isinstance(location, dict)
        and all(isinstance(location.get(axis), (int, float)) for axis in ("lat", "lon"))
        and isinstance(refs, list)
        and all(isinstance(ref, dict) for ref in refs)
        and isinstance(entry.get("seen"), dict)
    )


def load_catalogue(path: Path | None) -> dict[str, Any]:
    """The catalogue the previous build left, or an empty one.

    It is only a memory. A missing or damaged file must never stop a refresh;
    it means nothing can be brought back this time, as before it existed.
    """
    empty: dict[str, Any] = {"schema_version": SCHEMA_VERSION, "stations": []}
    if not path or not path.exists():
        return empty
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return empty
    if not isinstance(data, dict) or not isinstance(data.get("stations"), list):
        return empty
    return data


def save_catalogue(path: Path, catalogue: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".next")
    temporary.write_text(json.dumps(catalogue, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    temporary.replace(path)


def carry_forward(
    stations: list[dict[str, Any]],
    catalogue: dict[str, Any],
    *,
    silent: set[str],
    at: datetime,
) -> tuple[list[dict[str, Any]], dict[str, Any], int]:
    """Bring back stations lost to a failing source, and remember this build.

    ``stations`` are the canonical stations built from this refresh's rows and
    ``silent`` the sources whose collector failed on it. Returns the stations
    to publish, the catalogue for the next build, and how many of the stations
    no answering source lists: those brought back, and those only a failed
    collector's leftover capture still shows. With nothing silent the
    stations are returned as they came.
    """
    at_iso = _iso(at)
    horizon = at - RETENTION
    by_ref: dict[tuple[str, str], list[int]] = {}
    buckets: dict[tuple[int, int], list[int]] = {}
    for index, station in enumerate(stations):
        for ref in station.get("source_refs", []):
            by_ref.setdefault(_ref_key(ref), []).append(index)
        buckets.setdefault(_cell(station["location"]), []).append(index)

    # For stations that are still here: when a now failing source last listed
    # them, and under which ids.
    remembered: dict[int, dict[str, Any]] = {}
    returned: list[tuple[dict[str, Any], list[dict[str, Any]], dict[str, str]]] = []
    taken = {station["id"] for station in stations}
    for entry in catalogue.get("stations", []):
        if not _usable(entry):
            continue
        matches = {index for ref in entry["source_refs"] for index in by_ref.get(_ref_key(ref), ())}
        if not matches:
            # Another source may list the same forecourt under ids of its own;
            # bringing the old card back beside it would show one station twice.
            row, col = _cell(entry["location"])
            matches = {
                index
                for dy in (-1, 0, 1) for dx in (-1, 0, 1)
                for index in buckets.get((row + dy, col + dx), ())
                if is_match(stations[index], entry)[0]
            }
        quiet = {source: stamp for source, stamp in entry["seen"].items() if source in silent}
        if matches:
            for index in matches:
                memory = remembered.setdefault(index, {"seen": {}, "refs": []})
                for source, stamp in quiet.items():
                    memory["seen"][source] = _latest([stamp, memory["seen"].get(source, stamp)])
                memory["refs"].extend(ref for ref in entry["source_refs"] if ref.get("source") in quiet)
            continue
        recent = {source: stamp for source, stamp in entry["seen"].items() if _time(stamp) >= horizon}
        failing = sorted(source for source in recent if source in silent)
        # A source that answered and no longer lists the station is believed.
        if not failing or entry["id"] in taken:
            continue
        taken.add(entry["id"])
        refs = [ref for ref in entry["source_refs"] if ref.get("source") in recent]
        location = entry["location"]
        returned.append(({
            "id": entry["id"],
            "network": entry.get("network"),
            "address": entry.get("address"),
            "location": {"lat": float(location["lat"]), "lon": float(location["lon"])},
            "source_refs": refs,
            "match_rules": ["last_seen"],
            "evidence": [],
            "last_seen_at": _latest(recent.values()),
            "failing_sources": failing,
        }, refs, recent))

    present: list[tuple[dict[str, Any], list[dict[str, Any]], dict[str, str]]] = []
    held = len(returned)
    for index, station in enumerate(stations):
        memory = remembered.get(index, {"seen": {}, "refs": []})
        current = {str(ref.get("source")) for ref in station.get("source_refs", [])}
        seen = {
            # Rows of a failed collector come from its previous capture left on
            # disk: they show the station was there, not that anyone looked again.
            source: memory["seen"].get(source, at_iso) if source in silent else at_iso
            for source in current
        }
        for source, stamp in memory["seen"].items():
            if source not in seen and _time(stamp) >= horizon:
                seen[source] = stamp
        if seen and _time(_latest(seen.values())) < horizon:
            continue
        if current and current <= silent:
            held += 1
        failing = sorted(source for source in seen if source in silent)
        if failing:
            station["failing_sources"] = failing
        refs = list(station.get("source_refs", []))
        for ref in memory["refs"]:
            if ref.get("source") in seen and ref not in refs:
                refs.append(ref)
        present.append((station, refs, seen))

    # The order merge_stations publishes in; the stations built this time keep
    # their places.
    published = sorted(present + returned, key=lambda item: (
        str(item[0].get("network") or ""), str(item[0].get("address") or ""),
    ))
    entries = []
    for station, refs, seen in published:
        alive = {source: seen[source] for source in sorted(seen) if _time(seen[source]) >= horizon}
        entries.append({
            "id": station["id"],
            "network": station.get("network"),
            "address": station.get("address"),
            "location": station["location"],
            "source_refs": [ref for ref in refs if ref.get("source") in alive],
            "seen": alive,
        })
    next_catalogue = {"schema_version": SCHEMA_VERSION, "updated_at": at_iso, "stations": entries}
    return [station for station, _, _ in published], next_catalogue, held


def silence_note(sources: Iterable[str]) -> str | None:
    """«источник gdezapravka сейчас не отвечает» for a grade with no fresh data."""
    names = [str(source) for source in sources]
    if not names:
        return None
    if len(names) == 1:
        return f"источник {names[0]} сейчас не отвечает"
    return f"источники {', '.join(names[:-1])} и {names[-1]} сейчас не отвечают"
