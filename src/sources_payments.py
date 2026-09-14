"""Normalizers for two payment feeds found on 14 Sep 2026.

Alfa-Bank's fuel map and ППР's fuel-card locator (TransitCard, Petrol Plus,
E1 CARD) both say, per grade, how sales go at a station right now. Neither is
a stock reading, and neither says when its verdict was reached: the status is
the feed's "now". Their status rows therefore carry no observed time. The
engine dates such a row by the capture, lets it expire with the payment TTL,
and never lets it set the age a card shows. They vote at the weight of a
payment projection and are never independent.

What was measured that day decides what counts once:

* The two feeds read one sales state. Of 321 grades Alfa marked "unavailable"
  that ППР also listed, ППР said "unavailable" for 317, whether or not Alfa had
  seen a payment at the station that day; on Gazpromneft forecourts the two
  disagreed with the official stock together 20 times and apart twice. A ППР
  status that agrees with Alfa's joins Alfa's cluster in the evidence engine.
* Alfa's "probably_unavailable" is silence, not a stop: of 354 such grades that
  ППР also listed, ППР called 289 "possibly_available" (too few transactions to
  tell) and 24 "unavailable". Neither of those statuses is a vote.
* tboo.ru passes Alfa's per-grade transaction times into its own tiers (2538 of
  them matched Alfa to the minute); the engine counts such a tier as Alfa
  whenever Alfa is read directly for the same grade, so tboo can neither repeat
  Alfa nor contradict it.
* Benzuber runs Alfa's in-app fuel payments and its network sits inside Alfa's
  list, so it is not read separately; benzokarta.com republishes the ППР
  locator and is not read either.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from .normalizers import _evidence, _station
from .sources_live import _parse_utc


ALFA_GRADES = {"AI92": "AI92", "AI95": "AI95", "DIESEL": "DT"}
# "AI98_100" is one bucket for two grades with different prices and different
# stations; it can answer for neither, so it is left out. "closed" is Alfa's
# payments being off at the station, "unknown" is no data and
# "probably_unavailable" is silence: none of them says anything about the fuel.
ALFA_STATUS = {
    "available": "AVAILABLE",
    "unavailable": "NOT_AVAILABLE",
}
PRICE_WINDOW = timedelta(hours=24)


def normalize_alfa(row: dict[str, Any], captured_at: str | None = None) -> list[dict[str, Any]]:
    """Alfa's per-grade verdict with Benzuber's limits and sales stops."""
    address = row.get("address") or {}
    location = address.get("location") or {}
    if location.get("latitude") is None or location.get("longitude") is None:
        return []
    rec = _station(
        "alfa-azs", row.get("station_id"), (row.get("brand") or {}).get("name"),
        address.get("fullname"), location["latitude"], location["longitude"],
    )
    captured = _parse_utc(captured_at)
    for fuel in row.get("fuels") or []:
        grade = ALFA_GRADES.get(str(fuel.get("category")))
        if not grade:
            continue
        availability = ALFA_STATUS.get(str(fuel.get("status")))
        rules = [item for item in fuel.get("restrictions") or [] if isinstance(item, dict)]
        # A Benzuber limit for every way of paying is the station's own limit
        # per fill-up; a stop for one payment type (the app) is not a stock fact.
        limits = [
            float(item["limit"]) for item in rules
            if item.get("type") == "limit" and item.get("payment_type") == "all"
            and isinstance(item.get("limit"), (int, float)) and item["limit"] > 0
        ]
        if availability:
            rec["evidence"].append(_evidence(
                grade, availability, "payment_projection", "alfa-payments",
                limit=min(limits) if limits and availability == "AVAILABLE" else None,
                confidence={
                    "last_transaction_at": fuel.get("last_transaction_at"),
                    "station_last_transaction_at": row.get("last_alfa_transaction_time"),
                    "station_transactions_24h": row.get("last_24h_alfa_transactions_count"),
                    "sales_stopped_for": sorted({str(item.get("payment_type")) for item in rules if item.get("type") == "disabled"}) or None,
                    "comments": sorted({str(item["comment"]) for item in rules if item.get("comment")}) or None,
                },
                independent=False, raw_status=fuel.get("status"),
                note="Card payments seen by Alfa-Bank and Benzuber sales stops; the status has no time of its own.",
            ))
        # A price is only as recent as the last payment that went through at it.
        # 2GIS shows the same prices (1237 of 1302 grades on 14 Sep 2026), so
        # the two share one price cluster.
        paid = _parse_utc(fuel.get("last_transaction_at"))
        price = fuel.get("price")
        if (
            isinstance(price, (int, float)) and price > 0 and paid
            and (captured is None or captured - paid <= PRICE_WINDOW)
        ):
            rec["evidence"].append(_evidence(
                grade, "UNKNOWN", "price", "alfa-2gis-price",
                observed_at=fuel.get("last_transaction_at"), price=price, independent=False,
                note="Price at Alfa-Bank's last card payment; provenance is separate from availability.",
            ))
    return [rec]


TRANSITCARD_GRADES = ("AI92", "AI95", "AI98", "AI100", "DT")
# "possibly_available" is the locator's «не подтверждена»: too few
# transactions to tell, which is no statement at all.
TRANSITCARD_STATUS = {
    "available": "AVAILABLE",
    "has_limit": "LIMITED",
    "unavailable": "LIKELY_NOT",
}
MOSCOW = timezone(timedelta(hours=3))
# A quiet forecourt sees no fuel-card transactions at night, and the locator
# then shows "unavailable" for a grade nobody is buying. From 23:00 to 07:00
# Moscow time that status is therefore not counted at all.
NIGHT_STARTS, NIGHT_ENDS = 23, 7


def is_moscow_night(moment: datetime) -> bool:
    hour = moment.astimezone(MOSCOW).hour
    return hour >= NIGHT_STARTS or hour < NIGHT_ENDS


def normalize_transitcard(row: dict[str, Any], captured_at: str | None = None) -> list[dict[str, Any]]:
    """How fuel-card sales of each grade go at the station right now."""
    if row.get("lat") is None or row.get("lon") is None:
        return []
    rec = _station("transitcard", row.get("id"), row.get("brand"), None, row["lat"], row["lon"])
    captured = _parse_utc(captured_at)
    # Without a capture time there is no telling night from day, and a quiet
    # station must not be read as an empty one.
    unsure_of_quiet = captured is None or is_moscow_night(captured)
    for grade in TRANSITCARD_GRADES:
        status = (row.get("statuses") or {}).get(grade)
        availability = TRANSITCARD_STATUS.get(str(status))
        if availability is None or (availability == "LIKELY_NOT" and unsure_of_quiet):
            continue
        rec["evidence"].append(_evidence(
            grade, availability, "payment_projection", "transitcard-payments",
            independent=False, raw_status=status,
            note="Fuel-card transactions seen by the PPR network; the status has no time of its own.",
        ))
    return [rec]
