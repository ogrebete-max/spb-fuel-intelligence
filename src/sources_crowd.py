"""Normalizers for the driver-community feeds that report queues.

These five sites were verified to disagree with each other far more than they
agree, so each is treated as its own provenance cluster.  Their *prices*,
however, were shown to come from one shared upstream, so price rows are parked
in a single cluster and can never look like independent quotes.
"""

from __future__ import annotations

from typing import Any

from .normalizers import _evidence, _station, canonical_grade, grade_tokens

CROWD_STATUS = {
    "yes": "AVAILABLE", "available": "AVAILABLE", "AVAILABLE": "AVAILABLE",
    "no": "NOT_AVAILABLE", "unavailable": "NOT_AVAILABLE", "UNAVAILABLE": "NOT_AVAILABLE",
    "low": "LIMITED", "limit": "LIMITED", "LIMITED": "LIMITED",
    "queue": "QUEUE", "QUEUE": "QUEUE",
}


def normalize_gdebenzin24(station: dict[str, Any]) -> list[dict[str, Any]]:
    """Per-grade statuses here each carry their own observation time."""
    if station.get("lat") is None or station.get("lon") is None:
        return []
    rec = _station(
        "gdebenzin24", station.get("id") or station.get("osm_id"),
        station.get("brand") or station.get("name"), station.get("addr"),
        station["lat"], station["lon"],
    )
    consensus = station.get("consensus") or {}
    confidence = {
        "confirmations": station.get("confirmations"),
        "voters": consensus.get("voters"),
        "agreement_pct": consensus.get("pct"),
        "source": station.get("status_source"),
    }
    cars = station.get("queue_cars")
    queue = str(int(cars)) if isinstance(cars, (int, float)) and cars else None
    prices = {
        canonical_grade(name): value
        for name, value in (station.get("prices") or {}).items()
        if canonical_grade(name)
    }
    for raw_grade, state in (station.get("fuel_statuses") or {}).items():
        grade = canonical_grade(raw_grade)
        if not grade or not isinstance(state, dict):
            continue
        availability = CROWD_STATUS.get(str(state.get("status")), "UNKNOWN")
        rec["evidence"].append(_evidence(
            grade, availability, "crowd_status", "gdebenzin24-crowd",
            observed_at=state.get("at") or station.get("last_at"),
            price=prices.get(grade),
            queue=queue if availability in {"AVAILABLE", "LIMITED", "QUEUE"} else None,
            confidence=confidence, independent=True, raw_status=state.get("status"),
        ))
    return [rec]


def normalize_gde_benzin(station: dict[str, Any]) -> list[dict[str, Any]]:
    """Splits human reports from parser imports, so the two can weigh differently."""
    if station.get("lat") is None or station.get("lon") is None:
        return []
    rec = _station(
        "gde-benzin", station.get("id"), station.get("brand") or station.get("name"),
        station.get("address"), station["lat"], station["lon"],
    )
    users = int(station.get("user_confirmations") or 0)
    observed = station.get("last_user_report_at") or station.get("last_report_at")
    confidence = {
        "confirmations": users or station.get("confirmations"),
        "user_reports": users,
        "parser_reports": station.get("parser_confirmations"),
        "trust": station.get("trust"),
    }
    queue = "reported" if station.get("situation") == "queue" else None
    seen: set[str] = set()
    for raw_grade, state in (station.get("fuels") or {}).items():
        grade = canonical_grade(raw_grade)
        if not grade or not isinstance(state, dict):
            continue
        seen.add(grade)
        availability = (
            "AVAILABLE" if state.get("available") is True
            else "NOT_AVAILABLE" if state.get("available") is False
            else "UNKNOWN"
        )
        rec["evidence"].append(_evidence(
            grade, availability, "crowd_status", "gde-benzin-crowd",
            observed_at=observed, price=state.get("price"),
            queue=queue if availability == "AVAILABLE" else None,
            confidence={**confidence, "grade_confirmations": state.get("confirmations")},
            # A row built only from a parser is a reimport of someone else's
            # feed, not a voice of this site's own community.
            independent=bool(users), raw_status=state.get("available"),
        ))
    for key, availability in (("fuels_available", "AVAILABLE"), ("fuels_unavailable", "NOT_AVAILABLE")):
        for raw_grade in station.get(key) or []:
            grade = canonical_grade(raw_grade)
            if not grade or grade in seen:
                continue
            seen.add(grade)
            rec["evidence"].append(_evidence(
                grade, availability, "crowd_status", "gde-benzin-crowd",
                observed_at=observed,
                queue=queue if availability == "AVAILABLE" else None,
                confidence=confidence, independent=bool(users), raw_status=station.get("situation"),
            ))
    return [rec]


def normalize_gdebenzin_net(station: dict[str, Any]) -> list[dict[str, Any]]:
    """Station-level status with an explicit car count and a waiting trend."""
    if station.get("lat") is None or station.get("lon") is None:
        return []
    rec = _station(
        "gdebenzin-net", station.get("osm_id"), station.get("name"), None,
        station["lat"], station["lon"],
    )
    availability = CROWD_STATUS.get(str(station.get("status")), "UNKNOWN")
    if availability == "UNKNOWN":
        return [rec]
    cars = station.get("queue_n")
    queue = (
        str(int(cars)) if isinstance(cars, (int, float)) and cars
        else "reported" if station.get("wait") else None
    )
    confidence = {
        "confirmed": station.get("confirmed"),
        "conflict": station.get("conflict"),
        "trend": station.get("trend"),
        "wait_minutes": station.get("wait"),
    }
    for grade in grade_tokens(station.get("fuels")):
        rec["evidence"].append(_evidence(
            grade, availability, "crowd_status", "gdebenzin-net-crowd",
            observed_at=station.get("queue_updated") or station.get("created_at"),
            queue=queue if availability in {"AVAILABLE", "QUEUE", "LIMITED"} else None,
            confidence=confidence, independent=True, raw_status=station.get("status"),
        ))
    return [rec]


GDEBENZFUEL_GRADES = {
    "PETROL_92": "AI92", "PETROL_95": "AI95", "PETROL_98": "AI98", "PETROL_100": "AI100",
    "DIESEL": "DT", "GAS": "LPG", "PROPANE": "LPG", "METHANE": "LPG",
}
GDEBENZFUEL_QUEUE = {"LOW": "lt5", "MEDIUM": "5_20", "HIGH": "20_50"}


def normalize_gdebenzfuel(station: dict[str, Any]) -> list[dict[str, Any]]:
    if station.get("latitude") is None or station.get("longitude") is None:
        return []
    rec = _station(
        "gdebenzfuel", station.get("id"), station.get("brand") or station.get("name"),
        station.get("address"), station["latitude"], station["longitude"],
    )
    queue = GDEBENZFUEL_QUEUE.get(str((station.get("queue") or {}).get("level")))
    for fuel in station.get("fuels") or []:
        grade = GDEBENZFUEL_GRADES.get(str(fuel.get("type")))
        if not grade:
            continue
        availability = CROWD_STATUS.get(str(fuel.get("availability")), "UNKNOWN")
        if fuel.get("conflicted"):
            availability = "CONFLICT"
        rec["evidence"].append(_evidence(
            grade, availability, "crowd_status", "gdebenzfuel-crowd",
            observed_at=fuel.get("lastReportAt"), limit=fuel.get("limitLiters"),
            queue=queue if availability in {"AVAILABLE", "LIMITED"} else None,
            confidence={
                "confirmations": fuel.get("reportsCount"),
                "agreement": fuel.get("agreement"),
                "level": fuel.get("confidence"),
            },
            independent=True, raw_status=fuel.get("availability"),
        ))
        if fuel.get("priceRub") is not None:
            rec["evidence"].append(_evidence(
                grade, "UNKNOWN", "price", "russiabase-price-cluster",
                observed_at=fuel.get("priceLastReportAt"), price=fuel.get("priceRub"),
                independent=False,
                note="Price relayed from the shared russiabase feed, not an independent quote.",
            ))
    return [rec]


TBANK_STATUS = {
    "available": "AVAILABLE", "has_fuel": "AVAILABLE",
    "no_fuel": "NOT_AVAILABLE", "unavailable": "NOT_AVAILABLE",
    "limited": "LIMITED", "queue": "QUEUE",
}


def normalize_tbank(station: dict[str, Any]) -> list[dict[str, Any]]:
    """Payment activity seen by a bank other than Sber: a separate upstream."""
    if station.get("lat") is None or station.get("lon") is None:
        return []
    rec = _station(
        "tbank-fuel", station.get("id"), station.get("brand") or station.get("name"),
        station.get("addr"), station["lat"], station["lon"],
    )
    prices = {
        canonical_grade(name): value
        for name, value in (station.get("priceByFuelType") or {}).items()
        if canonical_grade(name)
    }
    for raw_grade, state in (station.get("statusByFuelType") or {}).items():
        grade = canonical_grade(raw_grade)
        if not grade:
            continue
        rec["evidence"].append(_evidence(
            grade, TBANK_STATUS.get(str(state), "UNKNOWN"), "payment_projection", "tbank-payments",
            observed_at=station.get("lastTransactionAt"), price=prices.get(grade),
            confidence={"level": station.get("confidence")},
            independent=False, raw_status=state,
            note="Inferred from card payments, not from a stock reading.",
        ))
    return [rec]
