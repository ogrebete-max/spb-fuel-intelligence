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

import re
from typing import Any

# A name that says "gas pump" in so many words. Crowd sites print template
# rows of petrol grades for these too, so no amount of that evidence keeps them.
GAS_PUMP = re.compile(
    r"агзс|агнкс|газозаправ|газомотор|газов(?:ая|ой|ые) заправ|пропан|метан"
    r"|\bкпг\b|\bспг\b|\blpg\b|\bcng\b",
    re.IGNORECASE,
)
# A brand that sells gas but also runs ordinary forecourts; evidence decides.
GAS_BRAND = re.compile(
    r"(?:^|[\s,«\"(])газ(?:[\s,»\")]|$)|автогаз|росгаз|\bgas\b|greengas|globalgaz|vervex|вервекс|митекс",
    re.IGNORECASE,
)
# "Сургутнефтегаз" is an oil company, not a gas pump.
NOT_GAS = ("нефтегаз",)
DEFINITE = {"AVAILABLE", "NOT_AVAILABLE", "LIMITED", "QUEUE", "CONFLICT", "LIKELY", "LIKELY_NOT"}
LIQUID_FUEL_SOURCES_REQUIRED = 2


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
