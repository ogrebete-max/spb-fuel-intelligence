"""Normalizers for the live sources added after Phase 0.

They follow the same rule as :mod:`src.normalizers`: a missing answer stays
UNKNOWN, a catalog entry is never current stock, and an aggregator that resells
other feeds is never marked independent.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
import re
from typing import Any

from .normalizers import _evidence, _station, canonical_grade, grade_tokens


def _parse_utc(value: Any) -> datetime | None:
    if value in (None, ""):
        return None
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed.astimezone(timezone.utc) if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def normalize_tofuel(station: dict[str, Any]) -> list[dict[str, Any]]:
    """tofuel.ru publishes a per-grade verdict with votes and a report time."""
    point = (station.get("location") or {}).get("coordinates") or [None, None]
    if point[0] is None or point[1] is None:
        return []
    rec = _station(
        "tofuel", station.get("_id") or station.get("id"),
        station.get("brand") or station.get("name"), station.get("address"),
        point[1], point[0],
    )
    status_map = {
        "available": "AVAILABLE",
        "unavailable": "NOT_AVAILABLE",
        "disputed": "CONFLICT",
        "unknown": "UNKNOWN",
    }
    for fuel in station.get("fuels") or []:
        availability = status_map.get(str(fuel.get("availability")), "UNKNOWN")
        rec["evidence"].append(_evidence(
            canonical_grade(fuel.get("type")), availability,
            "crowd_status" if availability != "UNKNOWN" else "catalog_fuel",
            "tofuel-mixed-upstream",
            observed_at=fuel.get("lastReportAt") or station.get("sourceUpdatedAt"),
            price=fuel.get("price"),
            confidence={
                "level": fuel.get("confidence"), "probability": fuel.get("probability"),
                "votes_yes": fuel.get("votesYes"), "votes_no": fuel.get("votesNo"),
                "unanimous": fuel.get("unanimousYes"), "source_confirmed": fuel.get("sourceConfirmed"),
            },
            # Rows mix the site's own votes with third-party provider feeds.
            independent=False, raw_status=fuel.get("availability"),
        ))
    return [rec]


def normalize_gdezapravka(station: dict[str, Any], captured_at: str | None = None) -> list[dict[str, Any]]:
    """gdezapravka.ru states which grades are available right now."""
    if station.get("lat") is None or station.get("lng") is None:
        return []
    rec = _station(
        "gdezapravka", station.get("id"), station.get("brand") or station.get("name"),
        station.get("address"), station.get("lat"), station.get("lng"),
    )
    captured = _parse_utc(captured_at) or datetime.now(timezone.utc)
    age_ms = station.get("last_report_age_ms")
    observed = (
        (captured - timedelta(milliseconds=float(age_ms))).isoformat().replace("+00:00", "Z")
        if isinstance(age_ms, (int, float)) else None
    )
    available = grade_tokens(",".join(str(item) for item in station.get("available_fuels") or []))
    catalog = grade_tokens(",".join(str(item) for item in station.get("fuel_types") or []))
    status = str(station.get("status") or "unknown")
    queue = station.get("queue_bucket")
    confidence = {
        "level": station.get("confidence"), "fresh_reports": station.get("fresh_count"),
        "disputed_from": station.get("disputed_from"), "pay_only": station.get("pay_only"),
    }
    for grade in available:
        rec["evidence"].append(_evidence(
            grade, "LIMITED" if status == "limited" else "AVAILABLE", "crowd_status", "gdezapravka-crowd",
            observed_at=observed, queue=queue, confidence=confidence,
            independent=True, raw_status=status,
        ))
    # The feed says what is available now, so a catalogued grade left out of
    # that list is a negative hint rather than a confirmed absence.
    if status in {"available", "limited", "none"} and observed:
        for grade in catalog:
            if grade in available:
                continue
            rec["evidence"].append(_evidence(
                grade, "NOT_AVAILABLE" if status == "none" else "LIKELY_NOT",
                "crowd_status", "gdezapravka-crowd",
                observed_at=observed, confidence=confidence, independent=True, raw_status=status,
                note="Grade is sold here but missing from the current availability list.",
            ))
    return [rec]


def normalize_tatneft_live(station: dict[str, Any], type_titles: dict[Any, Any]) -> list[dict[str, Any]]:
    if station.get("lat") is None or station.get("lon") is None:
        return []
    rec = _station("tatneft", station.get("id"), "Татнефть", station.get("address"), station["lat"], station["lon"])
    for fuel in station.get("fuel") or []:
        rec["evidence"].append(_evidence(
            canonical_grade(type_titles.get(fuel.get("fuel_type_id"))), "UNKNOWN", "catalog_price",
            "tatneft-official", observed_at=fuel.get("updated"), price=fuel.get("price"),
            independent=True, note="Official price feed; it does not state current stock.",
        ))
    return [rec]


def normalize_rosneft_live(station: dict[str, Any], *, updated: str | None = None) -> list[dict[str, Any]]:
    coordinate = station.get("coordinate") or {}
    if coordinate.get("lat") is None or coordinate.get("lng") is None:
        return []
    rec = _station(
        "rosneft-ptk", station.get("id"), station.get("brand") or station.get("name"),
        station.get("address"), coordinate["lat"], coordinate["lng"],
    )
    for fuel in station.get("fuels") or []:
        rec["evidence"].append(_evidence(
            canonical_grade(fuel.get("code")), "UNKNOWN", "catalog_price", "rosneft-official",
            observed_at=updated, price=fuel.get("price"), independent=True,
            note="Official price feed; it does not state current stock.",
        ))
    return [rec]


def normalize_teboil_live(shop: dict[str, Any]) -> list[dict[str, Any]]:
    coordinates = shop.get("coordinates") or [None, None]
    if len(coordinates) < 2 or coordinates[0] in (None, "") or coordinates[1] in (None, ""):
        return []
    rec = _station("teboil", shop.get("externalCode"), "Teboil", shop.get("adr"), coordinates[0], coordinates[1])
    for fuel in shop.get("fuel") or []:
        rec["evidence"].append(_evidence(
            canonical_grade(fuel.get("name")), "UNKNOWN", "catalog_fuel", "teboil-official",
            independent=True, note="Configured assortment, not current stock.",
        ))
    return [rec]


def normalize_kirishi_live(marker: dict[str, Any]) -> list[dict[str, Any]]:
    # The source swaps the meaning of its own lat/lng attributes.
    if marker.get("lng") in (None, "") or marker.get("lat") in (None, ""):
        return []
    rec = _station(
        "kirishiavtoservis", marker.get("id"), "Киришиавтосервис",
        marker.get("address"), marker["lng"], marker["lat"],
    )
    for fuel in marker.get("prices") or []:
        number = re.search(r"\d+[,.]?\d*", str(fuel.get("cost") or ""))
        rec["evidence"].append(_evidence(
            canonical_grade(fuel.get("name")), "UNKNOWN", "catalog_price", "kirishi-official",
            price=number.group(0).replace(",", ".") if number else None, independent=True,
            note="Official price board; it does not state current stock.",
        ))
    return [rec]


def normalize_lukoil_catalog(station: dict[str, Any]) -> list[dict[str, Any]]:
    if station.get("Latitude") is None or station.get("Longitude") is None:
        return []
    address = ", ".join(part for part in (station.get("City"), station.get("Street")) if part)
    return [_station(
        "lukoil", station.get("GasStationId"), "Лукойл", address,
        station["Latitude"], station["Longitude"],
    )]


QUEUE_BUCKETS: tuple[tuple[str, str], ...] = (
    (r"100\s*\+", "gt50"),
    (r"50\s*[–—-]\s*100", "gt50"),
    (r"20\s*[–—-]\s*50", "20_50"),
    (r"5\s*[–—-]\s*20", "5_20"),
    (r"до\s*5", "lt5"),
)


def normalize_telegram_post(post: dict[str, Any], *, observed_at: str | None = None) -> list[dict[str, Any]]:
    """One structured channel card: brand, address, grades, queue, limit, price."""
    location = post.get("location") or {}
    lines = [line.strip() for line in str(post.get("text") or "").splitlines() if line.strip()]
    fields: dict[str, str] = {}
    for line in lines:
        key, separator, value = line.partition(":")
        if separator:
            fields.setdefault(key.strip().lower(), value.strip())
    grades = grade_tokens(fields.get("топливо"))
    if not grades or location.get("lat") is None or location.get("lon") is None:
        return []
    network = lines[0] if lines else None
    address = lines[1] if len(lines) > 1 and ":" not in lines[1] else None
    rec = _station(
        "telegram-benzinspb78", f"tg:{post.get('post_id')}", network, address,
        location["lat"], location["lon"],
    )
    queue_raw = fields.get("очередь")
    queue = None
    if queue_raw:
        queue = "reported"
        for pattern, bucket in QUEUE_BUCKETS:
            if re.search(pattern, queue_raw):
                queue = bucket
                break
    limit_match = re.search(r"(\d+)\s*л", fields.get("лимит") or "")
    prices: dict[str, float] = {}
    for chunk in re.split(r"[·•]", fields.get("цены") or ""):
        match = re.search(r"([^\s—-]+)\s*[—-]\s*(\d+[.,]\d+)", chunk)
        grade = canonical_grade(match.group(1)) if match else None
        if grade:
            prices[grade] = float(match.group(2).replace(",", "."))
    confirmations = re.search(r"(\d+)", fields.get("подтверждений") or "")
    for grade in grades:
        rec["evidence"].append(_evidence(
            grade, "AVAILABLE", "crowd_report", "telegram-benzinspb78",
            observed_at=observed_at or post.get("published_at"),
            price=prices.get(grade),
            limit=limit_match.group(1) if limit_match else None,
            queue=queue,
            confidence={
                "confirmations": int(confirmations.group(1)) if confirmations else None,
                "on_site": True,
            },
            independent=True, raw_status=fields.get("топливо"),
            note="Driver confirmations republished by the channel; not an official stock reading.",
        ))
    return [rec]
