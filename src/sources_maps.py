"""Normalizers for three maps where drivers mark each grade.

2GIS «Статус АЗС», азсрадар.рф and AZS MAP were found on 14 Sep 2026. Each
collects marks from its own drivers, so each is a crowd cluster of its own.
What they share with feeds that were already read was measured that day and
is kept out of the vote:

* 2GIS reaches the pipeline twice more. гдебензин.рф's "2gis:" stations carry
  2GIS's own ids (248 of 250) with 2GIS's statuses, and tboo.ru's "g" times
  are 2GIS report times (379 of 397 to the minute); the evidence engine counts
  both as 2GIS. Its station ids are the 2GIS branch ids the Sber feed uses as
  well (875 of Sber's 913), but its statuses are drivers' marks, not payments:
  where Sber saw a grade sold, 2GIS drivers agreed for 62 of 184, so the two
  stay separate voices.
* азсрадар.рф also shows T-Bank and Sber forecasts; the collector drops them.
* AZS MAP builds on the ГдеБЕНЗ feed. Its prices come from there and join the
  ГдеБЕНЗ price cluster, and a mark that says the same as ГдеБЕНЗ about the
  same grade is counted as ГдеБЕНЗ by the evidence engine.
"""

from __future__ import annotations

from datetime import timedelta
import re
from typing import Any

from .normalizers import _evidence, _iso, _station, canonical_grade
from .sources_live import _parse_utc


TWO_GIS_GRADES = {
    "AI_92": "AI92", "AI_95": "AI95", "AI_98": "AI98", "AI_100": "AI100", "DT": "DT", "GAS": "LPG",
}
# The three sizes 2GIS offers, as the engine's queue buckets.
TWO_GIS_QUEUE = {"UP_TO_25": "up_to_25", "FROM_25_TO_50": "from_25_to_50", "OVER_50": "over_50"}


def _positive_limit(value: Any) -> float | None:
    # 0 is how these feeds say "no limit".
    return float(value) if isinstance(value, (int, float)) and value > 0 else None


def normalize_2gis_benzin(row: dict[str, Any]) -> list[dict[str, Any]]:
    """Per-grade driver marks: there or not, a queue, a litre limit."""
    station = row.get("station") or {}
    if station.get("lat") is None or station.get("lng") is None:
        return []
    rec = _station(
        "2gis-benzin", station.get("id"), station.get("brand") or station.get("name"),
        station.get("address"), station["lat"], station["lng"],
    )
    # «Закрыта по расписанию»: whatever drivers saw earlier, nobody refuels
    # there now, so a positive mark must not send anyone.
    closed = bool(row.get("closed") or row.get("closed_by_schedule"))
    for fuel in row.get("fuel_statuses") or []:
        grade = TWO_GIS_GRADES.get(str(fuel.get("fuel_type")))
        available = fuel.get("available")
        # null: drivers reported a queue or a limit but not whether the grade
        # is there. That is not a statement about the grade, and neither is a
        # mark with no time, which would read as seen at our poll.
        if not grade or available not in (True, False) or not fuel.get("last_report_at"):
            continue
        availability = "AVAILABLE" if available else "NOT_AVAILABLE"
        note = "Driver marks collected by 2GIS, not an official stock reading."
        if closed and available:
            availability = "UNKNOWN"
            note = "The station is closed by its schedule right now."
        positive = availability == "AVAILABLE"
        rec["evidence"].append(_evidence(
            grade, availability, "crowd_status", "2gis-benzin",
            observed_at=fuel.get("last_report_at"),
            limit=_positive_limit(fuel.get("limit_liters")) if positive else None,
            queue=TWO_GIS_QUEUE.get(str(fuel.get("queue_level"))) if positive else None,
            # reports_count is every mark the station ever had, not a recent
            # window, so it is kept for reading and never weighs the vote.
            confidence={
                "reports_total": fuel.get("reports_count"),
                "station_status": row.get("status"),
                "closed_by_schedule": bool(row.get("closed_by_schedule")) or None,
            },
            independent=True, raw_status=available, note=note,
        ))
    # 2GIS showed the same price as Alfa-Bank's map for 1237 of 1302 grades at
    # the same forecourt on 14 Sep 2026, closer than any other feed, so the two
    # count as one price quote.
    for price in row.get("prices") or []:
        grade = TWO_GIS_GRADES.get(str(price.get("fuel_type")))
        if grade and isinstance(price.get("price"), (int, float)) and price["price"] > 0:
            rec["evidence"].append(_evidence(
                grade, "UNKNOWN", "price", "alfa-2gis-price",
                observed_at=price.get("updated_at"), price=price["price"], independent=None,
                note="Price shown by 2GIS; provenance is separate from availability.",
            ))
    return [rec]


AZSRADAR_STATE = {"ok": "AVAILABLE", "empty": "NOT_AVAILABLE"}
# "Нет", "До 5 машин", "5–20 машин", "Больше 20 машин".
AZSRADAR_QUEUE = (
    (r"больше\s*20|более\s*20|20\s*\+", "gt20"),
    (r"5\s*[–—-]\s*20", "5_20"),
    (r"до\s*5", "lt5"),
)


def _azsradar_queue(text: Any) -> str | None:
    raw = str(text or "").strip().lower()
    if not raw or raw in {"нет", "no", "none"}:
        return None
    for pattern, bucket in AZSRADAR_QUEUE:
        if re.search(pattern, raw):
            return bucket
    return "reported"


def normalize_azsradar(row: dict[str, Any], captured_at: str | None = None) -> list[dict[str, Any]]:
    """The site's own drivers: ok or empty per grade, a queue, a limit, a break."""
    if row.get("latitude") is None or row.get("longitude") is None:
        return []
    rec = _station(
        "azsradar-rf", row.get("id"), row.get("name") or row.get("brand"),
        row.get("address"), row["latitude"], row["longitude"],
    )
    # One time for the station: when its drivers last marked it.
    observed = row.get("status_updated_at")
    if not observed:
        return [rec]
    captured = _parse_utc(captured_at)
    break_until = _parse_utc(row.get("break_until"))
    on_break = bool(break_until and captured and break_until > captured)
    queue = _azsradar_queue(row.get("queue_size"))
    confidence = {
        "level": row.get("confidence_level"),
        "percent": row.get("confidence_percent"),
        "break_until": row.get("break_until"),
    }
    seen: set[str] = set()
    for raw_grade, state in (row.get("fuel_statuses") or {}).items():
        grade = canonical_grade(raw_grade)
        availability = AZSRADAR_STATE.get(str(state))
        if not grade or not availability or grade in seen:
            continue
        seen.add(grade)
        note = "Marks by the site's own drivers; its bank forecasts are not used."
        if on_break and availability == "AVAILABLE":
            availability = "UNKNOWN"
            note = "The station is on a technical break right now."
        positive = availability == "AVAILABLE"
        rec["evidence"].append(_evidence(
            grade, availability, "crowd_status", "azsradar-crowd",
            observed_at=observed,
            limit=_positive_limit(row.get("fuel_limit")) if positive else None,
            queue=queue if positive else None,
            confidence=confidence, independent=True, raw_status=state, note=note,
        ))
    return [rec]


AZSMAP_STATE = {"have": "AVAILABLE", "low": "LIMITED", "none": "NOT_AVAILABLE"}
# The labels the site showed on 14 Sep 2026, for a capture that carries none.
# Its key "ai98" is shown to drivers as АИ-100, and the label is what they mark.
AZSMAP_LABELS = {"ai92": "АИ-92", "ai95": "АИ-95", "ai98": "АИ-100", "dt": "ДТ", "gas": "ГАЗ"}
AZSMAP_PRICE = re.compile(r"^\d+(?:[.,]\d{1,2})?$")


def _azsmap_price(text: Any) -> float | None:
    raw = str(text if text is not None else "").strip()
    if not AZSMAP_PRICE.match(raw):
        return None
    value = float(raw.replace(",", "."))
    return value if 0 < value < 10_000 else None


def _minutes_before(captured: Any, minutes: Any) -> str | None:
    if captured is None or not isinstance(minutes, (int, float)) or isinstance(minutes, bool) or minutes < 0:
        return None
    return _iso((captured - timedelta(minutes=float(minutes))).isoformat())


AZSMAP_SLUG = re.compile(r"[a-z0-9]+(?:_[a-z0-9]+)*")


def _azsmap_brand(value: Any) -> str | None:
    """Cards taken from Yandex carry a transliterated slug such as "kirishi_oyl".

    With spaces the matcher's brand keys can still read it; a bare "azs" is the
    generic word, as «АЗС» is.
    """
    text = str(value or "").strip()
    if AZSMAP_SLUG.fullmatch(text):
        text = text.replace("_", " ")
    return None if text.lower() in {"", "azs", "азс"} else text


def normalize_azsmap(
    row: dict[str, Any], captured_at: str | None = None, labels: dict[str, str] | None = None,
) -> list[dict[str, Any]]:
    """One grade is [key, state, price, minutes since the mark, …, minutes since the price]."""
    if row.get("lat") is None or row.get("lon") is None:
        return []
    rec = _station("azsmap", row.get("key"), _azsmap_brand(row.get("brand")), row.get("address"), row["lat"], row["lon"])
    captured = _parse_utc(captured_at)
    names = {**AZSMAP_LABELS, **(labels or {})}
    for fuel in row.get("fuels") or []:
        if not isinstance(fuel, list) or len(fuel) < 4:
            continue
        grade = canonical_grade(names.get(str(fuel[0]), fuel[0]))
        if not grade:
            continue
        availability = AZSMAP_STATE.get(str(fuel[1]))
        observed = _minutes_before(captured, fuel[3])
        # "stale" is the site's own «нет данных».
        if availability and observed:
            rec["evidence"].append(_evidence(
                grade, availability, "crowd_status", "azsmap-crowd",
                observed_at=observed, confidence={"flags": fuel[5:8]},
                independent=True, raw_status=fuel[1],
                note="Marks shown by AZS MAP; where they agree with ГдеБЕНЗ they count as ГдеБЕНЗ.",
            ))
        price = _azsmap_price(fuel[2])
        priced = _minutes_before(captured, fuel[8]) if len(fuel) > 8 else None
        if price is not None and priced:
            rec["evidence"].append(_evidence(
                grade, "UNKNOWN", "price", "gdebenz-price-unknown-upstream",
                observed_at=priced, price=price, independent=None,
                note="Price relayed from the ГдеБЕНЗ feed; provenance is separate from availability.",
            ))
    return [rec]
