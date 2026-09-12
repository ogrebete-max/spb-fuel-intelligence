"""Small, deliberately conservative normalizers for the Phase-0 fixtures.

This module is not an Evidence Engine.  It only proves that the captured source
shapes can be mapped without turning catalog data, stale data, or generic bank
payments into a false per-grade "available now" assertion.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
import re
from typing import Any, Callable


ALLOWED_AVAILABILITY = {
    "AVAILABLE",
    "LIKELY",
    "CONFLICT",
    "LIMITED",
    "QUEUE",
    "LIKELY_NOT",
    "NOT_AVAILABLE",
    "UNKNOWN",
}


# A branded grade is a different product at a different price: a station that
# has G-95 but no plain 95 does not have 95, and its price is not the 95 price.
# Yandex Maps shows them as separate chips for exactly this reason.
PREMIUM_MARKERS = (
    "g-", "g ", "экто", "ecto", "pulsar", "пульсар", "atum", "атум",
    "ultimate", "ултимейт", "taneco", "taneko", "танеко", "опти", "opti",
    "evro", "евро", "premium", "премиум", "+", "_gpn",
)


def is_premium_grade(value: Any) -> bool:
    raw = str(value or "").strip().lower().replace("ё", "е")
    if not raw:
        return False
    compact = re.sub(r"\s+", " ", raw)
    return any(marker in compact for marker in PREMIUM_MARKERS)


def canonical_grade(value: Any, *, allow_premium: bool = False) -> str | None:
    if not allow_premium and is_premium_grade(value):
        return None
    raw = str(value or "").strip().lower().replace("ё", "е")
    compact = re.sub(r"[\s_+\-]", "", raw)
    if re.search(r"(?:^|[^0-9])92(?:[^0-9]|$)", raw) or compact in {"ai92", "аи92", "a92", "92"}:
        return "AI92"
    if re.search(r"(?:^|[^0-9])95(?:[^0-9]|$)", raw) or compact.startswith(("ai95", "аи95", "a95", "95")):
        return "AI95"
    if re.search(r"(?:^|[^0-9])98(?:[^0-9]|$)", raw) or compact in {"ai98", "аи98", "a98", "98"}:
        return "AI98"
    if re.search(r"(?:^|[^0-9])100(?:[^0-9]|$)", raw) or compact.startswith(("ai100", "аи100", "a100", "100")):
        return "AI100"
    if any(token in raw for token in ("дизел", "diesel")) or compact in {"dt", "дт", "дтл"}:
        return "DT"
    if any(token in raw for token in ("lpg", "пропан", "газ", "суг", "метан", "cng")):
        return "LPG"
    return None


def grade_tokens(value: Any) -> list[str]:
    grades: list[str] = []
    for token in re.split(r"[,;/]", str(value or "")):
        grade = canonical_grade(token)
        if grade and grade not in grades:
            grades.append(grade)
    return grades


def _iso(value: Any, assume_moscow: bool = False) -> str | None:
    if value in (None, ""):
        return None
    if isinstance(value, (int, float)):
        seconds = float(value) / (1000 if float(value) > 1_000_000_000_000 else 1)
        return datetime.fromtimestamp(seconds, timezone.utc).isoformat().replace("+00:00", "Z")
    text = str(value).strip().replace(" ", "T", 1)
    if assume_moscow and not re.search(r"(?:Z|[+-]\d\d:?\d\d)$", text):
        text += "+03:00"
    if text.endswith("+00"):
        text += ":00"
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return str(value)
    return parsed.isoformat().replace("+00:00", "Z")


def _station(source: str, station_id: Any, network: Any, address: Any, lat: Any, lon: Any) -> dict[str, Any]:
    return {
        "source": source,
        "station_id": str(station_id),
        "network": network or None,
        "address": address or None,
        "location": {"lat": float(lat), "lon": float(lon)},
        "evidence": [],
    }


def _evidence(
    grade: str | None,
    availability: str,
    kind: str,
    provenance: str,
    *,
    observed_at: Any = None,
    price: Any = None,
    limit: Any = None,
    queue: Any = None,
    confidence: Any = None,
    independent: bool | None = None,
    raw_status: Any = None,
    note: str | None = None,
) -> dict[str, Any]:
    assert availability in ALLOWED_AVAILABILITY
    return {
        "grade": grade,
        "availability": availability,
        "kind": kind,
        "observed_at": _iso(observed_at),
        "price_rub": float(price) if price not in (None, "") else None,
        "limit_liters": float(limit) if limit not in (None, "") else None,
        "queue": queue or None,
        "confidence": confidence,
        "provenance_cluster": provenance,
        "independent": independent,
        "raw_status": raw_status,
        "note": note,
    }


def normalize_sber(body: dict[str, Any]) -> list[dict[str, Any]]:
    s = body.get("station", body)
    rec = _station("sber", s["id"], s.get("name"), s.get("address"), s["location"]["lat"], s["location"]["lon"])
    for fuel in s.get("fuels", []):
        raw_status = fuel.get("availabilityStatus", "unknown")
        is_available = raw_status == "available" and fuel.get("available") is True
        # Crucial: available=false + stale is UNKNOWN, never NOT_AVAILABLE.
        availability = "AVAILABLE" if is_available else "UNKNOWN"
        rec["evidence"].append(_evidence(
            canonical_grade(fuel.get("type")), availability,
            "realtime_status" if is_available else "catalog_or_stale",
            "sber+2gis-catalog",
            observed_at=fuel.get("lastFuelingAt") or s.get("updatedAt"),
            limit=fuel.get("limitLiters"), independent=False, raw_status=raw_status,
        ))
    return [rec]


def normalize_gazpromneft(body: dict[str, Any]) -> list[dict[str, Any]]:
    s = body["station"]
    address = ", ".join(part for part in (s.get("city"), s.get("address")) if part)
    rec = _station("gazpromneft", s["GPNAZSID"], "Газпромнефть", address, s["latitude"], s["longitude"])
    grouped: dict[str, list[dict[str, Any]]] = {}
    for item in body["fuel_detail"].get("data", []):
        grade = canonical_grade(item.get("product", {}).get("shortTitle"))
        if grade:
            grouped.setdefault(grade, []).append(item)
    for grade, variants in grouped.items():
        # The live API uses an empty array when the stock object is absent.
        # Absence is UNKNOWN; it must never be converted into a negative.
        rest_by_variant = [item.get("rest") if isinstance(item.get("rest"), dict) else {} for item in variants]
        variant_statuses = [rest.get("avail") for rest in rest_by_variant]
        available = True if True in variant_statuses else False if False in variant_statuses else None
        status = "AVAILABLE" if available is True else "NOT_AVAILABLE" if available is False else "UNKNOWN"

        priced = []
        for item, rest in zip(variants, rest_by_variant):
            price = item.get("price") if isinstance(item.get("price"), dict) else {}
            if price.get("price") not in (None, "") and (available is not True or rest.get("avail") is True):
                priced.append((float(price["price"]), price.get("since")))
        best_price, price_since = min(priced, default=(None, None), key=lambda pair: pair[0])
        variant_note = ", ".join(
            f"{item.get('product', {}).get('shortTitle')}={rest.get('avail')}"
            for item, rest in zip(variants, rest_by_variant)
        )
        rec["evidence"].append(_evidence(
            grade, status, "official_stock", "gazpromneft-official",
            observed_at=price_since, price=best_price, independent=True, raw_status=available,
            note=f"variants: {variant_note}",
        ))
    return [rec]


def normalize_lukoil(body: dict[str, Any] | list[dict[str, Any]]) -> list[dict[str, Any]]:
    # GetObjects returns an array even when exactly one station ID is requested.
    rows = body if isinstance(body, list) else [body]
    result: list[dict[str, Any]] = []
    for row in rows:
        s = row["GasStation"]
        rec = _station("lukoil", s["GasStationId"], "Лукойл", s.get("Address"), s["Latitude"], s["Longitude"])
        for fuel in row.get("Fuels", []):
            rec["evidence"].append(_evidence(
                canonical_grade(fuel.get("Name")), "UNKNOWN", "catalog_fuel", "lukoil-official",
                price=fuel.get("Price"), independent=True, raw_status=None,
                note="Configured/sold fuel is not current stock.",
            ))
        result.append(rec)
    return result


def normalize_teboil(body: dict[str, Any]) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for group in body.get("data", []):
        for s in group.get("shops", []):
            rec = _station("teboil", s["externalCode"], "Teboil", s.get("adr"), s["coordinates"][0], s["coordinates"][1])
            for fuel in s.get("fuel", []):
                rec["evidence"].append(_evidence(canonical_grade(fuel.get("name")), "UNKNOWN", "catalog_fuel", "teboil-official", independent=True))
            result.append(rec)
    return result


def _crowd_status(value: Any) -> str:
    return {"yes": "AVAILABLE", "no": "NOT_AVAILABLE", "queue": "QUEUE", "low": "LIMITED", "limit": "LIMITED"}.get(str(value), "UNKNOWN")


def normalize_gdebenz(body: dict[str, Any]) -> list[dict[str, Any]]:
    s = body["station"]
    rec = _station("gdebenz", s["osm_id"], s.get("brand") or s.get("name"), s.get("addr"), s["lat"], s["lon"])
    for report in body.get("recent", []):
        grades = grade_tokens(report.get("detail"))
        limit_match = re.search(r"лимит\s*(\d+)\s*л", report.get("detail", ""), re.I)
        queue_match = re.search(r"очередь\s*([^·]+)", report.get("detail", ""), re.I)
        for grade in grades or [None]:
            ev = _evidence(
                grade, _crowd_status(report.get("status")), "crowd_report", "gdebenz-crowd",
                observed_at=_iso(report.get("created_at"), assume_moscow=True),
                limit=limit_match.group(1) if limit_match else None,
                queue=queue_match.group(1).strip() if queue_match else None,
                confidence={"on_site": bool(report.get("on_site")), "reliable": bool(report.get("author_reliable"))},
                independent=True, raw_status=report.get("status"),
            )
            rec["evidence"].append(ev)
    for raw_grade, price in (s.get("prices_now") or {}).items():
        rec["evidence"].append(_evidence(canonical_grade(raw_grade), "UNKNOWN", "price", "gdebenz-price-unknown-upstream", observed_at=_iso(price.get("t"), assume_moscow=True), price=price.get("p"), independent=None))
    return [rec]


def normalize_benzas(body: dict[str, Any]) -> list[dict[str, Any]]:
    s = body["station"]
    rec = _station("benzas", s["osm_id"], s.get("brand") or s.get("name"), s.get("addr"), s["lat"], s["lon"])
    for report in body.get("recent", []):
        for grade in grade_tokens(report.get("fuels_now") or report.get("detail")) or [None]:
            rec["evidence"].append(_evidence(grade, _crowd_status(report.get("status")), "crowd_report", "benzas-crowd", observed_at=report.get("created_at"), independent=True, raw_status=report.get("status")))
    for raw_grade, price in body.get("insight", {}).get("prices", {}).items():
        rec["evidence"].append(_evidence(
            canonical_grade(raw_grade), "UNKNOWN", "price", f"price:{price.get('source') or 'unknown'}",
            observed_at=price.get("at"), price=price.get("price"), independent=False,
            note="Price provenance is separate from crowd availability.",
        ))
    return [rec]


def normalize_benzinest(body: dict[str, Any]) -> list[dict[str, Any]]:
    s = body["station"]
    rec = _station("benzinest", s["id"], s.get("name"), s.get("address"), s["lat"], s["lng"])
    limit = next((t.get("value") for t in s.get("tags", []) if t.get("tag") == "limit"), None)
    status_map = {"AVAILABLE": "AVAILABLE", "OUT_OF_STOCK": "NOT_AVAILABLE"}
    for fuel in s.get("fuels", []):
        rec["evidence"].append(_evidence(
            canonical_grade(fuel.get("type")), status_map.get(fuel.get("status"), "UNKNOWN"), "imported_status", "benzinest-imported-mixed",
            observed_at=s.get("lastReportAt") or s.get("lastUpdated"), price=fuel.get("price"), limit=limit,
            confidence={"level": fuel.get("confidence"), "probability": fuel.get("availProb"), "reports": fuel.get("reportsInWindow")},
            independent=False, raw_status=fuel.get("status"),
        ))
    return [rec]


def normalize_tutbenz(body: dict[str, Any]) -> list[dict[str, Any]]:
    s = body
    rec = _station("tutbenz", s["id"], s.get("brand") or s.get("name"), s.get("address"), s["lat"], s["lng"])
    for state in s.get("states", []):
        if state.get("stale") or state.get("status") == "unknown":
            availability = "UNKNOWN"
        elif state.get("sourceKind") == "payment":
            # The same generic transaction timestamp is repeated across grades in this sample.
            availability = "LIKELY" if state.get("status") == "has" else "LIKELY_NOT" if state.get("status") == "empty" else "UNKNOWN"
        else:
            availability = {"has": "AVAILABLE", "empty": "NOT_AVAILABLE", "queue": "QUEUE"}.get(state.get("status"), "UNKNOWN")
        rec["evidence"].append(_evidence(
            canonical_grade(state.get("fuelType")), availability,
            "payment_projection" if state.get("sourceKind") == "payment" else "parsed_status",
            "tbank-payment" if state.get("sourceKind") == "payment" else "tutbenz-parser",
            observed_at=state.get("observedAt") or state.get("verifiedAt"), price=state.get("price"), limit=state.get("limitL"),
            confidence=state.get("confidence"), independent=False, raw_status=state.get("status"),
            note="Generic payment is not proof of a specific grade." if state.get("sourceKind") == "payment" else None,
        ))
    return [rec]


def normalize_gdebenzin(body: dict[str, Any]) -> list[dict[str, Any]]:
    s = body["station"]
    rec = _station("gdebenzin", s["id"], s.get("network") or s.get("title"), s.get("address"), s["lat"], s["lng"])
    payment = s.get("source_level") == "payment"
    for raw_grade, fuel in (s.get("fuels") or {}).items():
        if payment:
            availability = "LIKELY" if fuel.get("free") is True else "LIKELY_NOT" if fuel.get("free") is False else "UNKNOWN"
            kind = "payment_projection"
        else:
            availability = "AVAILABLE" if fuel.get("free") is True else "NOT_AVAILABLE" if fuel.get("free") is False else "UNKNOWN"
            kind = "aggregated_status"
        rec["evidence"].append(_evidence(
            canonical_grade(raw_grade), availability, kind, f"gdebenzin:{str(s['id']).split(':')[0]}",
            observed_at=fuel.get("confirmed_at") or s.get("confirmed_at") or s.get("source_ts"), price=fuel.get("price_rub"),
            confidence=s.get("confidence"), independent=False, raw_status=fuel.get("free"),
            note="Payment source is indirect grade evidence." if payment else None,
        ))
    return [rec]


def normalize_benzonavt(body: dict[str, Any]) -> list[dict[str, Any]]:
    s = body
    rec = _station("benzonavt", s["id"], s.get("brand") or s.get("name"), s.get("address"), s["lat"], s["lon"])
    state = s.get("st") or {}
    limits = {canonical_grade(x.get("grade")): x for x in s.get("limits", [])}
    prices = {canonical_grade(g): p for g, p in (s.get("prices") or {}).items()}
    for raw_grade in s.get("fuels", []):
        grade = canonical_grade(raw_grade)
        if raw_grade in state.get("fuels_now", []):
            availability = "AVAILABLE"
        elif raw_grade in state.get("fuels_out", []):
            availability = "NOT_AVAILABLE"
        else:
            availability = "UNKNOWN"
        rec["evidence"].append(_evidence(
            grade, availability, "crowd_status" if availability != "UNKNOWN" else "catalog_fuel", "benzonavt-crowd-or-import",
            observed_at=state.get("updated_at"), price=(prices.get(grade) or {}).get("price"), limit=(limits.get(grade) or {}).get("liters"),
            queue=state.get("queue"), confidence=state.get("confidence"), independent=None, raw_status=state.get("status"),
        ))
    return [rec]


def normalize_benzinkarta(body: dict[str, Any], captured_at: str | None = None) -> list[dict[str, Any]]:
    s = body["station"]
    rec = _station("benzinkarta", s["osm_id"], s.get("brand_name") or s.get("name"), s.get("addr"), s["lat"], s["lon"])
    captured = datetime.fromisoformat((captured_at or datetime.now(timezone.utc).isoformat()).replace("Z", "+00:00"))
    prices = {p.get("fuel"): p for p in body.get("card", {}).get("prices", [])}
    for raw_grade, state in body.get("status", {}).items():
        observed = captured - timedelta(seconds=float(state.get("age") or 0))
        p = prices.get(raw_grade) or {}
        rec["evidence"].append(_evidence(
            canonical_grade(raw_grade), _crowd_status(state.get("status")), "crowd_status", "benzinkarta-mixed-crowd",
            observed_at=observed.isoformat(), price=p.get("price"), confidence=body.get("card", {}).get("confidence"),
            independent=None, raw_status=state.get("status"),
        ))
    return [rec]


def normalize_rosneft(body: dict[str, Any]) -> list[dict[str, Any]]:
    s = body["station"]
    rec = _station("rosneft-ptk", s["id"], s.get("brand") or s.get("name"), s.get("address"), s["coordinate"]["lat"], s["coordinate"]["lng"])
    for fuel in s.get("fuels", []):
        rec["evidence"].append(_evidence(canonical_grade(fuel.get("code")), "UNKNOWN", "catalog_price", "rosneft-official", observed_at=body.get("prices_update_date"), price=fuel.get("price"), independent=True))
    return [rec]


def normalize_tatneft(body: dict[str, Any]) -> list[dict[str, Any]]:
    s = body["station"]
    type_rows = body.get("fuel_types", {}).get("data", {}).get("items", [])
    type_map = {row["id"]: row.get("title") for row in type_rows}
    rec = _station("tatneft", s["id"], "Татнефть", s.get("address"), s["lat"], s["lon"])
    for fuel in s.get("fuel", []):
        rec["evidence"].append(_evidence(canonical_grade(type_map.get(fuel.get("fuel_type_id"))), "UNKNOWN", "catalog_price", "tatneft-official", observed_at=fuel.get("updated"), price=fuel.get("price"), independent=True))
    return [rec]


def normalize_kirishi(body: dict[str, Any]) -> list[dict[str, Any]]:
    s = body
    # The source reverses the semantic names of lat/lng.
    rec = _station("kirishiavtoservis", s["id"], "Киришавтосервис", s.get("address"), s["lng"], s["lat"])
    for fuel in s.get("prices", []):
        number = re.search(r"\d+[,.]?\d*", str(fuel.get("cost") or ""))
        rec["evidence"].append(_evidence(canonical_grade(fuel.get("name")), "UNKNOWN", "catalog_price", "kirishi-official", price=number.group(0).replace(",", ".") if number else None, independent=True))
    return [rec]


def normalize_toplivo(body: dict[str, Any]) -> list[dict[str, Any]]:
    s = body["direct_station"]
    rec = _station("toplivo-ryadom", f"{s.get('b')}:{s.get('n')}:{s.get('la')}:{s.get('lo')}", s.get("b"), s.get("a"), s["la"], s["lo"])
    for fuel in s.get("f", []):
        raw_grade, raw_price, raw_available = fuel[:3]
        rec["evidence"].append(_evidence(
            canonical_grade(raw_grade), "AVAILABLE" if raw_available == 1 else "NOT_AVAILABLE", "network_claim_aggregated", f"toplivo-network:{s.get('b')}",
            observed_at=s.get("pt"), price=raw_price, independent=False, raw_status=raw_available,
            note="Cross-verified as official only for the sampled Gazpromneft station.",
        ))
    p = body.get("prediction_station")
    if p:
        pred = _station("toplivo-ryadom", f"prediction:{p.get('la')}:{p.get('lo')}", p.get("b"), p.get("a"), p["la"], p["lo"])
        tier_map = {"H": "LIKELY", "A": "LIKELY", "F": "LIKELY", "M": "LIKELY", "N": "LIKELY_NOT", "X": "UNKNOWN", "u": "UNKNOWN"}
        for raw_grade, state in (p.get("f") or {}).items():
            source_times = state.get("src") or {}
            observed = max(source_times.get("a") or 0, source_times.get("t") or 0) or None
            pred["evidence"].append(_evidence(canonical_grade(raw_grade), tier_map.get(state.get("t"), "UNKNOWN"), "payment_prediction", "alpha+tbank+sber+2gis", observed_at=observed, limit=state.get("lim"), independent=False, raw_status=state.get("t"), note="Prediction, not a stock guarantee."))
        rec["related_prediction"] = pred
    return [rec]


def normalize_benzinradar(body: list[dict[str, Any]], captured_at: str | None = None) -> list[dict[str, Any]]:
    captured = datetime.fromisoformat((captured_at or datetime.now(timezone.utc).isoformat()).replace("Z", "+00:00"))
    result: list[dict[str, Any]] = []
    for s in body:
        rec = _station("benzinradar-analogue", s["id"], s.get("brand") or s.get("name"), s.get("address"), s["lat"], s["lon"])
        for raw_grade, fuel in (s.get("fuels") or {}).items():
            status = _crowd_status({"available": "yes", "empty": "no"}.get(fuel.get("status"), fuel.get("status")))
            updated_at = fuel.get("updatedAt")
            try:
                updated_dt = datetime.fromisoformat(str(updated_at).replace("Z", "+00:00")) if updated_at else None
            except ValueError:
                updated_dt = None
            if updated_dt is None or captured - updated_dt > timedelta(hours=24):
                status = "UNKNOWN"
            rec["evidence"].append(_evidence(canonical_grade(raw_grade), status, "stale_or_crowd_status", "benzinradar-unknown", observed_at=updated_at, price=fuel.get("price"), confidence=fuel.get("confirmations"), independent=None, raw_status=fuel.get("status")))
        result.append(rec)
    return result


NORMALIZERS: dict[str, Callable[..., list[dict[str, Any]]]] = {
    "sber": normalize_sber,
    "gazpromneft": normalize_gazpromneft,
    "lukoil": normalize_lukoil,
    "teboil": normalize_teboil,
    "gdebenz": normalize_gdebenz,
    "benzas": normalize_benzas,
    "benzinest": normalize_benzinest,
    "tutbenz": normalize_tutbenz,
    "gdebenzin": normalize_gdebenzin,
    "benzonavt": normalize_benzonavt,
    "benzinkarta": normalize_benzinkarta,
    "rosneft-ptk": normalize_rosneft,
    "tatneft": normalize_tatneft,
    "kirishiavtoservis": normalize_kirishi,
    "toplivo-ryadom": normalize_toplivo,
    "benzinradar-analogue": normalize_benzinradar,
}


def normalize_fixture(fixture: dict[str, Any]) -> list[dict[str, Any]]:
    meta = fixture.get("_fixture") or {}
    source = meta.get("source")
    normalizer = NORMALIZERS.get(source)
    if not normalizer or fixture.get("body") is None:
        return []
    if source in {"benzinkarta", "benzinradar-analogue"}:
        return normalizer(fixture["body"], meta.get("captured_at"))
    return normalizer(fixture["body"])
