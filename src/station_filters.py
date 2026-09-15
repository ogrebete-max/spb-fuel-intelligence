"""Which forecourts the app should not show at all.

Gas filling points (АГЗС, АГНКС, propane and methane pumps) are stations in
every catalogue, so every feed lists them, and several crowd sites even print a
full row of petrol grades for them by template.  For a driver who wants petrol
or diesel such a card is worse than nothing: it looks like a station that may
have fuel.  They are removed here, after matching, so the decision sees every
source at once.

The name alone is not enough to drop a station: "Global Gas" and "Митекс" run
ordinary multi-fuel forecourts alongside gas ones.  A gas-named station stays
only when at least two independent feeds have actually said something definite
about a petrol or diesel grade there — a template row of "UNKNOWN" is not a
statement.
"""

from __future__ import annotations

import math
import re
from typing import Any

# A name that says "gas pump" in so many words. Crowd sites print template
# rows of petrol grades for these too, so no amount of that evidence keeps them.
GAS_PUMP = re.compile(
    r"агзс|агнкс|газозаправ|газомотор|газов(?:ая|ой|ые) заправ|пропан|метан"
    r"|\bкпг\b|\bспг\b|\blpg\b|\bcng\b|газов(?:ых|ые) (?:баллон|технолог)|газсервис|трансгаз|газon|газ \d+"
    # «Газпром ГМТ», as Alfa-Bank's map names Gazprom's methane stations.
    r"|\bгмт\b",
    re.IGNORECASE,
)
# A brand that sells gas but also runs ordinary forecourts; evidence decides.
GAS_BRAND = re.compile(
    r"(?:^|[\s,«\"(])газ(?:[\s,»\")]|$)|автогаз|росгаз|газ\b|газонаполн|газоснабж|газовичк"
    r"|\bgas\b|greengas|globalgaz|vervex|вервекс|митекс",
    re.IGNORECASE,
)
# "Сургутнефтегаз" is an oil company, not a gas pump.
NOT_GAS = ("нефтегаз",)
DEFINITE = {"AVAILABLE", "NOT_AVAILABLE", "LIMITED", "QUEUE", "CONFLICT", "LIKELY", "LIKELY_NOT"}
LIQUID_FUEL_SOURCES_REQUIRED = 3


def _name(station: dict[str, Any]) -> str:
    name = f"{station.get('network') or ''} {station.get('name') or ''}"
    return "" if any(marker in name.lower() for marker in NOT_GAS) else name


def gas_pump_named(station: dict[str, Any]) -> bool:
    return bool(GAS_PUMP.search(_name(station)))


def gas_named(station: dict[str, Any]) -> bool:
    name = _name(station)
    return bool(GAS_PUMP.search(name) or GAS_BRAND.search(name))


def liquid_fuel_sources(station: dict[str, Any]) -> set[str]:
    """Sources that made a definite claim about a petrol or diesel grade."""
    return {
        row["source"]
        for row in station.get("evidence", [])
        if row.get("grade") and row["grade"] != "LPG" and row.get("availability") in DEFINITE
    }


def is_gas_only(station: dict[str, Any]) -> bool:
    grades = {row.get("grade") for row in station.get("evidence", []) if row.get("grade")}
    if grades and grades <= {"LPG"}:
        return True
    if gas_pump_named(station):
        return True
    if not gas_named(station):
        return False
    return len(liquid_fuel_sources(station)) < LIQUID_FUEL_SOURCES_REQUIRED


def drop_gas_only(stations: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [station for station in stations if not is_gas_only(station)]


# A name a feed broke into U+FFFD (12 Sep 2026: tofuel's «Пропан 24» without its
# first letter) can be read neither on the map nor by the gas filter above.
def has_broken_name(station: dict[str, Any]) -> bool:
    return "�" in str(station.get("network") or "")


def drop_broken_names(stations: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [station for station in stations if not has_broken_name(station)]


# Catalogue rows that are no forecourt at all.  15 Sep 2026: gdebenzin24 lists a
# «Татнефт» at the General Staff building on Palace Square; built from that row
# alone, it was offered as «Вы у АЗС» to anyone in the centre.  The point also
# catches the same row should the feed give it a new id.
NOT_STATIONS = (
    {"source": "gdebenzin24", "station_id": "753179155", "lat": 59.93841, "lon": 30.31793},
)
NOT_STATION_METRES = 60


def _metres(lat_a: float, lon_a: float, lat_b: float, lon_b: float) -> float:
    # Flat is exact enough at a few dozen metres.
    dy = (lat_a - lat_b) * 111_320
    dx = (lon_a - lon_b) * 111_320 * math.cos(math.radians((lat_a + lat_b) / 2))
    return math.hypot(dx, dy)


def is_not_a_station(station: dict[str, Any]) -> bool:
    """A listed row, or a lone feed's row on a listed point.

    A station another feed confirms stays: two catalogues agreeing is not the
    mistake this list is for.
    """
    refs = station.get("source_refs") or []
    listed = {(entry["source"], entry["station_id"]) for entry in NOT_STATIONS}
    if refs and all((ref.get("source"), str(ref.get("station_id"))) in listed for ref in refs):
        return True
    location = station.get("location") or {}
    if location.get("lat") is None or location.get("lon") is None or len({ref.get("source") for ref in refs}) > 1:
        return False
    lat, lon = float(location["lat"]), float(location["lon"])
    return any(_metres(lat, lon, entry["lat"], entry["lon"]) <= NOT_STATION_METRES for entry in NOT_STATIONS)


def drop_not_stations(stations: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [station for station in stations if not is_not_a_station(station)]
