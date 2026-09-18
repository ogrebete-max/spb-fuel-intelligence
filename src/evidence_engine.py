"""Conservative station/grade evidence evaluation.

The engine deliberately keeps UNKNOWN separate from NOT_AVAILABLE and counts
provenance clusters, not raw records.  It accepts normalized Phase-0 evidence
and returns one of the seven user-facing product states from the brief.
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from datetime import datetime, timezone, timedelta
import math
from typing import Any, Iterable


FINAL_STATUSES: dict[str, str] = {
    "CAN_REFUEL": "МОЖНО ЗАПРАВИТЬСЯ",
    "LIKELY_AVAILABLE": "СКОРЕЕ ЕСТЬ",
    "CONFLICT": "ДАННЫЕ РАСХОДЯТСЯ",
    "LIMITED": "ОГРАНИЧЕННАЯ ПРОДАЖА",
    "LIKELY_NOT": "СКОРЕЕ НЕТ",
    "CONFIRMED_NO": "ПОДТВЕРЖДЕНО НЕТ",
    "NO_FRESH_DATA": "НЕТ СВЕЖИХ ДАННЫХ",
}

POSITIVE = {"AVAILABLE", "LIKELY"}
NEGATIVE = {"NOT_AVAILABLE", "LIKELY_NOT"}
RESTRICTED = {"LIMITED", "QUEUE"}
NON_STATUS_KINDS = {"price", "catalog_price", "catalog_fuel", "catalog_or_stale"}

# A TTL says for how long a signal may influence the current status.  Old rows
# stay visible in the explanation but never silently become a negative signal.
TTL_SECONDS = {
    # This product answers “can I refuel now?”.  A five-hour-old report is
    # useful history but not a current station-level answer.
    # Someone looked at the pump. Still perishable: a station can empty in half
    # an hour, and an hour-old sighting must not answer for "сейчас".
    "eyewitness": 45 * 60,
    "official_stock": 30 * 60,
    "official_relay": 30 * 60,
    "realtime_status": 30 * 60,
    "crowd_report": 45 * 60,
    "crowd_status": 45 * 60,
    "parsed_status": 45 * 60,
    "aggregated_status": 30 * 60,
    "imported_status": 30 * 60,
    "payment_projection": 30 * 60,
    "payment_prediction": 30 * 60,
    "network_claim_aggregated": 30 * 60,
    "stale_or_crowd_status": 30 * 60,
    "undated_crowd_summary": 30 * 60,
}

# How much stronger one side has to be before the weaker opposing signal stops
# counting as a conflict and becomes a footnote.
DECISIVE_STRENGTH_GAP = 25

KIND_STRENGTH = {
    "eyewitness": 110,
    "official_stock": 100,
    "official_relay": 85,
    "realtime_status": 80,
    "crowd_report": 70,
    "parsed_status": 60,
    "crowd_status": 55,
    "network_claim_aggregated": 45,
    "aggregated_status": 35,
    "imported_status": 30,
    "payment_projection": 20,
    "payment_prediction": 15,
    "undated_crowd_summary": 15,
}


TRUST_LABELS = {
    "high": "высокая",
    "moderate": "средняя",
    "low": "низкая",
    "conflict": "противоречивая",
    "none": "нет данных",
}


def _trust_score(
    status: str,
    fresh: list[EvaluatedRow],
    independent_clusters: int,
    current_time: datetime,
) -> tuple[int, str, str]:
    """Score how much the current answer can be trusted, 0-100.

    The score mixes the strongest kind of fresh evidence, how many genuinely
    independent provenance clusters agree, and how much of each signal's TTL
    has already been spent.  It is a statement about the evidence, never about
    the physical tank.
    """
    if status == "NO_FRESH_DATA" or not fresh:
        return 0, "none", "Нет свежего grade-specific сигнала."
    strongest = max(fresh, key=lambda item: item.strength)
    score = min(100, strongest.strength)
    score += min(24, 12 * max(0, independent_clusters - 1))
    score += min(8, 4 * max(0, len({item.cluster for item in fresh}) - 1))
    ttl = TTL_SECONDS.get(str(strongest.row.get("kind") or ""), 2 * 60 * 60)
    spent = min(1.0, (strongest.age_seconds or 0) / ttl) if ttl else 1.0
    score = round(score * (1 - 0.35 * spent))
    if status == "CONFLICT":
        score = min(score, 45)
    score = max(1, min(100, score))
    tier = "conflict" if status == "CONFLICT" else "high" if score >= 75 else "moderate" if score >= 45 else "low"
    parts = [f"сильнейший сигнал — {strongest.row.get('kind')}"]
    parts.append(f"независимых источников: {independent_clusters}")
    parts.append(f"свежих записей: {len(fresh)}")
    return score, tier, "; ".join(parts)


# Every source gets a vote, weighted by what kind of signal it is, how fresh it
# is and how many people stand behind it.  The votes are summed in log-odds and
# turned back into a probability, so eight weak agreeing sources can outweigh
# one strong one, and one strong source cannot silence a fresh crowd entirely.
# This replaces the old cascade, where whichever side had the strongest single
# row won outright and the other side became a footnote.
KIND_VOTE_WEIGHT = {
    # Nothing beats having been there; everything else is somebody's inference.
    "eyewitness": 1.3,
    "official_stock": 1.0,
    "official_relay": 0.8,
    "crowd_report": 0.7,
    "crowd_status": 0.6,
    "parsed_status": 0.55,
    "aggregated_status": 0.45,
    "imported_status": 0.4,
    "network_claim_aggregated": 0.4,
    "stale_or_crowd_status": 0.35,
    "payment_projection": 0.25,
    "payment_prediction": 0.2,
    "undated_crowd_summary": 0.2,
}
# Scales one unit of weight into log-odds.  A single official reading lands
# around 0.85; two independent crowd confirmations around 0.8.
VOTE_SCALE = 1.9
POSITIVE_DIRECTION = {"AVAILABLE": 1.0, "LIKELY": 0.8, "LIMITED": 0.7, "QUEUE": 0.7}
NEGATIVE_DIRECTION = {"NOT_AVAILABLE": -1.0, "LIKELY_NOT": -0.8}


def _vote(item: EvaluatedRow) -> tuple[float, float]:
    """Return (direction, weight) for one fresh evidence row."""
    availability = str(item.row.get("availability") or "")
    direction = POSITIVE_DIRECTION.get(availability, NEGATIVE_DIRECTION.get(availability, 0.0))
    if not direction:
        return 0.0, 0.0
    kind = str(item.row.get("kind") or "")
    weight = KIND_VOTE_WEIGHT.get(kind, 0.3)
    ttl = TTL_SECONDS.get(kind, 2 * 60 * 60)
    spent = min(1.0, (item.age_seconds or 0) / ttl) if ttl else 1.0
    # A signal at the very edge of its TTL is worth less than a fresh one, but
    # never nothing — it is still the only thing anyone reported.
    weight *= 1.0 - 0.6 * spent
    confidence = item.row.get("confidence")
    if isinstance(confidence, dict):
        reports = 0
        for key in CONFIRMATION_KEYS:
            value = confidence.get(key)
            if isinstance(value, (int, float)) and value > reports:
                reports = int(value)
        if reports > 1:
            weight *= min(1.6, 1.0 + 0.18 * math.log(reports))
        if confidence.get("on_site"):
            weight *= 1.15
    if item.row.get("independent") is True:
        weight *= 1.15
    return direction, weight


# Relevance fades, it does not fall off a cliff.  A contrary report that just
# passed its TTL is poor grounds for claiming fuel, but excellent grounds for
# being less sure — which is why the card could say 96% while showing a
# one-hour-old "нет" from two drivers right underneath.
STALE_OPPOSITION_REACH = 3.0
STALE_OPPOSITION_WEIGHT = 0.45


def _stale_opposition(rows: list[EvaluatedRow], leading: int) -> list[tuple[float, EvaluatedRow]]:
    """Expired evidence against the leading answer, at a fading weight."""
    damping: list[tuple[float, EvaluatedRow]] = []
    for item in rows:
        if item.fresh:
            continue
        direction, weight = _vote(item)
        if not weight or (direction > 0) == (leading > 0):
            continue
        kind = str(item.row.get("kind") or "")
        ttl = TTL_SECONDS.get(kind, 2 * 60 * 60)
        age = item.age_seconds
        if age is None or ttl <= 0 or age >= ttl * STALE_OPPOSITION_REACH:
            continue
        fade = 1.0 - (age - ttl) / (ttl * (STALE_OPPOSITION_REACH - 1))
        damping.append((direction * weight * STALE_OPPOSITION_WEIGHT * max(0.0, fade), item))
    return damping


def probability_available(
    rows: list[EvaluatedRow],
    stale: list[EvaluatedRow] | None = None,
) -> tuple[float | None, list[dict[str, Any]]]:
    """Combine every fresh vote into P(this grade is available right now)."""
    breakdown: list[dict[str, Any]] = []
    total = 0.0
    for item in rows:
        direction, weight = _vote(item)
        if not weight:
            continue
        contribution = direction * weight * VOTE_SCALE
        total += contribution
        breakdown.append({
            "source": item.row.get("source"),
            "cluster": item.cluster,
            "kind": item.row.get("kind"),
            "availability": item.row.get("availability"),
            "age_seconds": round(item.age_seconds) if item.age_seconds is not None else None,
            # Dated only by our poll: the page must not show it as minutes old.
            "undated": not item.row.get("observed_at"),
            "weight": round(weight, 3),
            "direction": direction,
        })
    if not breakdown:
        return None, []
    # One voice is one observation, however authoritative.  Shrinking the
    # log-odds toward 50% when nobody corroborates keeps a lone reading out of
    # "стоит ехать" and reserves confidence for agreement.
    # Corroboration means voices agreeing with the answer, not voices present.
    # Counting all of them would let an opposing vote raise confidence, because
    # it made the crowd look bigger.
    leading = 1 if total >= 0 else -1
    agreeing = sum(1 for row in breakdown if (row["direction"] > 0) == (leading > 0))
    total *= {0: 0.65, 1: 0.65, 2: 0.85}.get(agreeing, 1.0)
    # Expired opposition may only lower confidence, never create or sustain an
    # answer of its own, so it is applied after corroboration is counted.
    for contribution, item in _stale_opposition(stale or [], leading):
        total += contribution * VOTE_SCALE
        breakdown.append({
            "source": item.row.get("source"),
            "cluster": item.cluster,
            "kind": item.row.get("kind"),
            "availability": item.row.get("availability"),
            "age_seconds": round(item.age_seconds) if item.age_seconds is not None else None,
            "undated": not item.row.get("observed_at"),
            "weight": round(abs(contribution), 3),
            "direction": 1.0 if contribution > 0 else -1.0,
            "expired": True,
        })
    probability = 1.0 / (1.0 + math.exp(-total))
    breakdown.sort(key=lambda row: -row["weight"])
    return probability, breakdown



@dataclass(frozen=True)
class EvaluatedRow:
    row: dict[str, Any]
    observed_at: datetime | None
    age_seconds: float | None
    fresh: bool
    strength: int
    cluster: str


def parse_time(value: Any) -> datetime | None:
    if value in (None, ""):
        return None
    if isinstance(value, (int, float)):
        seconds = float(value) / (1000 if float(value) > 1_000_000_000_000 else 1)
        return datetime.fromtimestamp(seconds, timezone.utc)
    text = str(value).strip().replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _cluster_family(value: Any) -> str:
    """Collapse known upstream aliases without inventing independence."""
    raw = str(value or "unknown").strip().lower()
    if "gazpromneft-official" in raw:
        return "gazpromneft-official"
    if raw.startswith("gdebenzin:tb") or "tbank-payment" in raw:
        return "tbank-payments"
    if "alpha+tbank+sber+2gis" in raw:
        return "mixed-bank-payments"
    if "sber+2gis" in raw:
        return "sber-2gis"
    if raw.startswith("gdebenzin:sber"):
        return "sber-2gis"
    # гдебензин.рф's "2gis:" stations are 2GIS «Статус АЗС» stations under the
    # same ids (248 of 250 on 14 Sep 2026), carrying 2GIS's statuses late.
    if raw.startswith("gdebenzin:2gis"):
        return "2gis-benzin"
    if raw.startswith("gdebenzin:gdb"):
        return "gdebenz-crowd"
    if "gdebenz-crowd" in raw:
        return "gdebenz-crowd"
    if "benzas-crowd" in raw:
        return "benzas-crowd"
    if "benzinest-imported" in raw:
        return "benzinest-mixed-upstream"
    if "benzonavt" in raw:
        return "benzonavt-mixed-upstream"
    if "benzinkarta" in raw:
        return "benzinkarta-mixed-upstream"
    return raw


def _best_timestamp(row: dict[str, Any]) -> datetime | None:
    # For a direct official stock response, capture time proves when the current
    # value was observed.  For reports/payments, preserve the event timestamp.
    if row.get("kind") == "official_stock":
        return parse_time(row.get("received_at")) or parse_time(row.get("observed_at"))
    return parse_time(row.get("observed_at")) or parse_time(row.get("received_at"))


def _decorate(row: dict[str, Any], now: datetime) -> EvaluatedRow:
    observed = _best_timestamp(row)
    age = max(0.0, (now - observed).total_seconds()) if observed else None
    kind = str(row.get("kind") or "")
    ttl = TTL_SECONDS.get(kind, 2 * 60 * 60)
    availability = row.get("availability")
    fresh = (
        availability not in (None, "UNKNOWN")
        and kind not in NON_STATUS_KINDS
        and age is not None
        and age <= ttl
    )
    strength = KIND_STRENGTH.get(kind, 10)
    if row.get("independent") is True:
        strength += 10
    confidence = row.get("confidence")
    if isinstance(confidence, dict) and confidence.get("on_site"):
        strength += 10
    return EvaluatedRow(row, observed, age, fresh, strength, _cluster_family(row.get("provenance_cluster")))


# Measured on the live snapshot of 13 September 2026: tofuel's verdicts and
# tutbenz's payment rows agree with the Sber/2GIS feed 98-100% of the time and
# trail it by a median of 22 minutes. They are the same observation arriving
# late, and counting them as separate voices tripled one bank's say. A row is
# folded into the Sber cluster only when it says the same thing shortly after a
# Sber row; disagreeing or unmatched rows keep their own voice.
RELAY_SOURCES = {"tofuel", "tutbenz"}
RELAY_CLUSTERS = {"tofuel-mixed-upstream", "tbank-payments"}
RELAY_LAG = (timedelta(minutes=-5), timedelta(minutes=45))

# Some feeds repeat another one's observation with no time that could show the
# lag, so a copy is recognised by saying the same thing about the same grade at
# the same station. It then counts as the original, and a copy that disagrees
# keeps its own voice.
#
# AZS MAP takes its stations, its prices and part of its marks from the ГдеБЕНЗ
# feed: on 14 Sep 2026 about seven marks in ten matched ГдеБЕНЗ at the same
# station, whose map rows carry no time either. ППР's card locator and Alfa-
# Bank's map read one sales state: of 321 grades Alfa marked unavailable that
# ППР also listed, ППР said unavailable for 317, and on Gazpromneft forecourts
# the two disagreed with the official stock together 20 times and apart twice.
COPY_SOURCES = {"azsmap": "gdebenz-crowd", "transitcard": "alfa-payments"}

# tboo.ru/gpn builds its payment tiers from other feeds' times: Alfa-Bank's
# per-grade transactions ("a"), 2GIS drivers' reports ("g") and T-Bank payments
# ("t"). On 14 Sep 2026, 2538 of its Alfa times matched Alfa's own to the
# minute and 379 of 397 of its 2GIS times matched 2GIS. When the feed behind a
# tier's newest time is read directly for the same grade, the tier is that feed
# again in tboo's words: it joins that feed's cluster, where the direct reading
# outranks it, so it can neither repeat the feed nor contradict it. When that
# feed is not read, or failed, the tier keeps its own voice.
PREDICTION_UPSTREAMS = {"a": "alfa-payments", "g": "2gis-benzin", "t": "tbank-payments"}


def _sense(availability: Any) -> int:
    if availability in POSITIVE_SENSE:
        return 1
    if availability in NEGATIVE_SENSE:
        return -1
    return 0


def _fold_sber_relays(rows: list[EvaluatedRow]) -> list[EvaluatedRow]:
    origins = [item for item in rows if item.cluster == "sber-2gis" and item.observed_at and _sense(item.row.get("availability"))]
    if not origins:
        return rows
    folded = []
    for item in rows:
        sense = _sense(item.row.get("availability"))
        if item.row.get("source") in RELAY_SOURCES and item.cluster in RELAY_CLUSTERS and item.observed_at and sense:
            for origin in origins:
                lag = item.observed_at - origin.observed_at
                if sense == _sense(origin.row.get("availability")) and RELAY_LAG[0] <= lag <= RELAY_LAG[1]:
                    item = replace(item, cluster="sber-2gis")
                    break
        folded.append(item)
    return folded


def _fold_copies(rows: list[EvaluatedRow]) -> list[EvaluatedRow]:
    for source, origin in COPY_SOURCES.items():
        senses = {
            _sense(item.row.get("availability"))
            for item in rows if item.cluster == origin and item.row.get("source") != source
        } - {0}
        if senses:
            rows = [
                replace(item, cluster=origin)
                if item.row.get("source") == source and _sense(item.row.get("availability")) in senses
                else item
                for item in rows
            ]
    return rows


def _fold_predictions(rows: list[EvaluatedRow]) -> list[EvaluatedRow]:
    direct = {item.cluster for item in rows if item.row.get("kind") != "payment_prediction"}
    if not direct & set(PREDICTION_UPSTREAMS.values()):
        return rows
    folded = []
    for item in rows:
        confidence = item.row.get("confidence")
        times = confidence.get("source_times") if isinstance(confidence, dict) else None
        if item.row.get("kind") == "payment_prediction" and isinstance(times, dict):
            stamps = {key: parse_time(value) for key, value in times.items() if key in PREDICTION_UPSTREAMS}
            stamps = {key: value for key, value in stamps.items() if value}
            if stamps:
                upstream = PREDICTION_UPSTREAMS[max(stamps, key=lambda key: stamps[key])]
                if upstream in direct:
                    item = replace(item, cluster=upstream)
        folded.append(item)
    return folded


def _fold_relays(rows: list[EvaluatedRow]) -> list[EvaluatedRow]:
    return _fold_predictions(_fold_copies(_fold_sber_relays(rows)))


def _restricts(item: EvaluatedRow) -> int:
    """2 for a limit in litres or a sized queue, 1 for a bare «limited», else 0."""
    row = item.row
    if row.get("limit_liters") or _has_known_queue(row):
        return 2
    return 1 if row.get("availability") in RESTRICTED else 0


def _outranks(item: EvaluatedRow, other: EvaluatedRow | None) -> bool:
    """Whether ``item`` should speak for its cluster instead of ``other``.

    Fresh beats stale, a stronger kind beats a weaker one, and then the newer
    row wins. Two rows their sources did not date carry only the times we
    polled them, which say nothing about which feed saw more: between those the
    one that reports a restriction is kept, so counting ППР's copy of Alfa-
    Bank's sales state once cannot lose Alfa's litre limit because ППР was
    polled a few seconds later.
    """
    if other is None:
        return True
    head = (1 if item.fresh else 0, item.strength)
    other_head = (1 if other.fresh else 0, other.strength)
    if head != other_head:
        return head > other_head
    if not item.row.get("observed_at") and not other.row.get("observed_at"):
        if _restricts(item) != _restricts(other):
            return _restricts(item) > _restricts(other)
    polled = item.observed_at.timestamp() if item.observed_at else 0
    other_polled = other.observed_at.timestamp() if other.observed_at else 0
    return polled > other_polled


def _deduplicate(rows: Iterable[EvaluatedRow]) -> list[EvaluatedRow]:
    best: dict[str, EvaluatedRow] = {}
    for item in rows:
        if _outranks(item, best.get(item.cluster)):
            best[item.cluster] = item
    return sorted(
        best.values(),
        key=lambda item: (item.fresh, item.strength, item.observed_at or datetime.min.replace(tzinfo=timezone.utc)),
        reverse=True,
    )


def _public_row(item: EvaluatedRow) -> dict[str, Any]:
    row = dict(item.row)
    row["effective_observed_at"] = item.observed_at.isoformat().replace("+00:00", "Z") if item.observed_at else None
    row["age_seconds"] = round(item.age_seconds) if item.age_seconds is not None else None
    row["fresh"] = item.fresh
    row["strength"] = item.strength
    row["effective_provenance"] = item.cluster
    return row


# A queue is the second half of the decision: a driver needs to know whether to
# go, and how long the wait will be once there.  Sources spell it as a bucket
# ("20_50"), a car count ("12"), a bare "reported", or an object with a validity
# window, so everything is folded into one shape with an explicit car range.
QUEUE_BUCKETS: dict[str, tuple[int, int | None, str]] = {
    "lt5": (1, 5, "до 5 машин"),
    "less_than_5": (1, 5, "до 5 машин"),
    "5_20": (5, 20, "5–20 машин"),
    "from_5_to_20": (5, 20, "5–20 машин"),
    "20_50": (20, 50, "20–50 машин"),
    "from_20_to_50": (20, 50, "20–50 машин"),
    "gt50": (50, None, "больше 50 машин"),
    "more_than_50": (50, None, "больше 50 машин"),
    "high": (20, None, "большая"),
    "low": (1, 5, "небольшая"),
    "small": (1, 5, "небольшая"),
    "medium": (5, 20, "средняя"),
    "none": (0, 0, "без очереди"),
    "no_queue": (0, 0, "без очереди"),
    # 2GIS «Статус АЗС» and азсрадар.рф count in their own steps.
    "up_to_25": (1, 25, "до 25 машин"),
    "from_25_to_50": (25, 50, "25–50 машин"),
    "over_50": (50, None, "больше 50 машин"),
    "gt20": (20, None, "больше 20 машин"),
}
# One car takes roughly a minute and a half at a single dispenser; stations have
# several, so the estimate is deliberately given as a range and labelled as one.
SECONDS_PER_CAR = 90
EMPTY_QUEUE_WORDS = {"", "0", "false", "no", "none", "no_queue"}


def _queue_shape(value: Any, now: datetime | None = None) -> dict[str, Any] | None:
    """Turn any source's queue field into {cars_from, cars_to, label, wait}."""
    valid_until = None
    if isinstance(value, dict):
        valid_until = parse_time(value.get("until"))
        value = value.get("size") or value.get("label") or value.get("value")
    if valid_until and now and valid_until < now:
        return None
    text = str(value or "").strip().lower()
    if text in EMPTY_QUEUE_WORDS:
        return None
    bucket = QUEUE_BUCKETS.get(text)
    if bucket is None and text.isdigit():
        cars = int(text)
        bucket = (cars, cars, f"около {cars} " + ("машины" if cars < 5 else "машин"))
    if bucket is None:
        # "reported" and anything unrecognised: a queue exists, size unknown.
        return {"cars_from": None, "cars_to": None, "label": "очередь есть, размер неизвестен",
                "wait_from_minutes": None, "wait_to_minutes": None, "raw": text}
    cars_from, cars_to, label = bucket
    if cars_from == 0 and cars_to == 0:
        return None
    return {
        "cars_from": cars_from,
        "cars_to": cars_to,
        "label": label,
        "wait_from_minutes": round(cars_from * SECONDS_PER_CAR / 60) if cars_from else None,
        "wait_to_minutes": round(cars_to * SECONDS_PER_CAR / 60) if cars_to else None,
        "raw": text,
    }


def _worst_queue(rows: list[EvaluatedRow], now: datetime) -> dict[str, Any] | None:
    """Report the heaviest fresh queue, not an average that hides a bad one."""
    shapes = []
    for item in rows:
        shape = _queue_shape(item.row.get("queue"), now)
        if shape:
            shape = dict(shape)
            shape["source"] = item.row.get("source")
            shape["observed_at"] = item.observed_at.isoformat().replace("+00:00", "Z") if item.observed_at else None
            shape["age_seconds"] = round(item.age_seconds) if item.age_seconds is not None else None
            shapes.append(shape)
    if not shapes:
        return None
    return max(shapes, key=lambda item: (item["cars_from"] is not None, item["cars_from"] or 0))


CONFIRMATION_KEYS = ("confirmations", "fresh_reports", "reports", "reportsInWindow", "votes_yes")


def _confirmation_count(rows: list[EvaluatedRow]) -> int:
    """How many human reports stand behind the answer.

    Not every source publishes a report count; one that agrees without a number
    still counts as one voice, so the figure is never lower than the number of
    agreeing fresh sources.
    """
    total = 0
    for item in rows:
        confidence = item.row.get("confidence")
        best = 0
        if isinstance(confidence, dict):
            for key in CONFIRMATION_KEYS:
                value = confidence.get(key)
                if isinstance(value, (int, float)) and value > best:
                    best = int(value)
        total += max(best, 1)
    return total


def _has_known_queue(row: dict[str, Any], now: datetime | None = None) -> bool:
    queue = row.get("queue")
    if isinstance(queue, dict):
        valid_until = parse_time(queue.get("until"))
        if valid_until and now and valid_until < now:
            return False
        queue = queue.get("size")
    return str(queue or "").strip().lower() not in {"", "0", "false", "no", "none", "no_queue"}


# A price is only shown when it is recent and corroborated.  Taking whichever
# single row was newest let an eleven-day-old catalogue entry set the price on
# the card, and let one source's branded blend masquerade as the plain grade.
PRICE_MAX_AGE_SECONDS = 24 * 3600


def _consensus_price(rows: list[EvaluatedRow], now: datetime) -> dict[str, Any]:
    """Median of the recent price quotes, one per provenance cluster."""
    by_cluster: dict[str, EvaluatedRow] = {}
    for item in rows:
        if item.row.get("price_rub") is None:
            continue
        age = item.age_seconds
        if age is None or age > PRICE_MAX_AGE_SECONDS:
            continue
        previous = by_cluster.get(item.cluster)
        if previous is None or (previous.age_seconds or 0) > age:
            by_cluster[item.cluster] = item
    quotes = sorted(by_cluster.values(), key=lambda item: float(item.row["price_rub"]))
    if not quotes:
        return {"value": None, "sources": 0, "age_seconds": None}
    middle = quotes[len(quotes) // 2]
    return {
        "value": round(float(middle.row["price_rub"]), 2),
        "sources": len(quotes),
        "age_seconds": round(min(item.age_seconds or 0 for item in quotes)),
    }


# Yandex is the app people actually compare against, and on a card it is more
# useful as a second opinion than as one more anonymous vote.  Its row is
# therefore surfaced separately, with its own age and signal count, so a driver
# can see the disagreement instead of switching apps to find it.
POSITIVE_SENSE = {"AVAILABLE", "LIKELY", "LIMITED", "QUEUE"}
NEGATIVE_SENSE = {"NOT_AVAILABLE", "LIKELY_NOT"}


def _second_opinion(rows: list[EvaluatedRow], status: str) -> dict[str, Any] | None:
    """What Yandex Maps says about this grade, and whether it agrees with us."""
    candidates = [item for item in rows if str(item.row.get("source")) == "yandex-maps"]
    if not candidates:
        return None
    item = min(candidates, key=lambda row: row.age_seconds if row.age_seconds is not None else 10 ** 9)
    availability = str(item.row.get("availability") or "UNKNOWN")
    confidence = item.row.get("confidence") if isinstance(item.row.get("confidence"), dict) else {}
    ours_positive = status in {"CAN_REFUEL", "LIKELY_AVAILABLE", "LIMITED"}
    ours_negative = status in {"CONFIRMED_NO", "LIKELY_NOT"}
    if availability in POSITIVE_SENSE:
        agrees = True if ours_positive else False if ours_negative else None
    elif availability in NEGATIVE_SENSE:
        agrees = True if ours_negative else False if ours_positive else None
    else:
        agrees = None
    return {
        "availability": availability,
        "age_seconds": round(item.age_seconds) if item.age_seconds is not None else None,
        "fresh": item.fresh,
        "confirmations": confidence.get("confirmations"),
        "station_status": confidence.get("station_status"),
        "agrees": agrees,
    }



def _eyewitness_summary(rows: list[EvaluatedRow]) -> dict[str, Any] | None:
    """The freshest report from someone in the group who stood at the pump.

    Surfaced on its own because for the people this app is for, it is the one
    line that outranks everything else on the card.
    """
    candidates = [item for item in rows if item.row.get("kind") == "eyewitness" and item.observed_at]
    if not candidates:
        return None
    item = min(candidates, key=lambda row: row.age_seconds if row.age_seconds is not None else 10 ** 9)
    return {
        "seen": item.row.get("availability") in POSITIVE_SENSE,
        "age_seconds": round(item.age_seconds) if item.age_seconds is not None else None,
        "fresh": item.fresh,
        "queue": item.row.get("queue"),
    }


def evaluate_grade(
    evidence: Iterable[dict[str, Any]],
    grade: str,
    *,
    now: datetime | None = None,
) -> dict[str, Any]:
    """Evaluate one fuel grade without converting missing evidence to NO."""
    current_time = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    relevant = [dict(row) for row in evidence if row.get("grade") == grade]
    decorated = _fold_relays([_decorate(row, current_time) for row in relevant])
    deduped = _deduplicate(decorated)
    fresh = [item for item in deduped if item.fresh]

    price = _consensus_price(decorated, current_time)
    limits = [item.row.get("limit_liters") for item in fresh if item.row.get("limit_liters") is not None]
    queue = _worst_queue(fresh, current_time)

    positives = [item for item in fresh if item.row.get("availability") in POSITIVE]
    negatives = [item for item in fresh if item.row.get("availability") in NEGATIVE]
    restricted = [
        item for item in fresh
        if item.row.get("availability") in RESTRICTED
        or item.row.get("limit_liters")
        or _has_known_queue(item.row, current_time)
    ]
    official_positive = [item for item in positives if item.row.get("kind") == "official_stock"]
    official_negative = [item for item in negatives if item.row.get("kind") == "official_stock"]
    # A relay carries the network's own stock feed one hop removed: official in
    # content, not in delivery, so it votes slightly below the direct source.
    relay_positive = [item for item in positives if item.row.get("kind") == "official_relay"]
    relay_negative = [item for item in negatives if item.row.get("kind") == "official_relay"]

    independent_positive = {item.cluster for item in positives if item.row.get("independent") is True}
    independent_negative = {item.cluster for item in negatives if item.row.get("independent") is True}

    # Statuses come from the combined probability, not from whichever single
    # row is strongest: a dozen sources disagreeing should read as "расходятся",
    # and one official reading should not erase a fresh crowd.
    probability, vote_breakdown = probability_available(fresh, deduped)
    restricted_now = bool(restricted)
    disagreement: dict[str, Any] | None = None
    if positives and negatives:
        weaker = "negative" if probability is not None and probability >= 0.5 else "positive"
        disagreement = {
            "side": weaker,
            "count": len(negatives if weaker == "negative" else positives),
        }

    if probability is None:
        status = "NO_FRESH_DATA"
        reason = "За последние часы никто не сообщал об этой марке здесь. Это не значит, что топлива нет — просто нет свежих данных."
    elif probability >= 0.85:
        status = "LIMITED" if restricted_now else "CAN_REFUEL"
        reason = (
            "Свежие источники почти единодушны: топливо есть."
            if not restricted_now else
            "Топливо есть, но сообщают об очереди или лимите отпуска."
        )
    elif probability >= 0.6:
        status = "LIMITED" if restricted_now else "LIKELY_AVAILABLE"
        reason = (
            "Больше источников за наличие, чем против, но единодушия нет."
            if not restricted_now else
            "Скорее есть, при этом сообщают об очереди или лимите."
        )
    elif probability > 0.4:
        # "Расходятся" must mean sources actually disagree.  A lone weak signal
        # lands in the same probability band but is thin evidence, not a
        # conflict, and saying otherwise would be misleading.
        #
        # A row that says "there is fuel, with a limit" or "there is fuel, with
        # a queue" speaks for the grade: it is in neither `positives` nor
        # `negatives`, and this band used to read a lone such row as «СКОРЕЕ
        # НЕТ» explained by a signal against that did not exist (18 Sep 2026:
        # 28 станций-марок публиковали «нет» с вероятностью выше 50%).  The two
        # bands above already tell a restricted "yes" from a plain one.
        speaking_for = positives or restricted
        if speaking_for and negatives:
            status = "CONFLICT"
            reason = "Источники расходятся примерно поровну — ехать наугад."
        elif speaking_for:
            status = "LIMITED" if restricted_now else "LIKELY_AVAILABLE"
            reason = ("За наличие есть только один слабый сигнал, и в нём сообщают об очереди или лимите."
                      if restricted_now else "За наличие есть только один слабый сигнал.")
        else:
            status = "LIKELY_NOT"
            reason = "Против наличия есть только один слабый сигнал."
    elif probability > 0.15:
        status = "LIKELY_NOT"
        reason = "Больше источников за отсутствие, чем за наличие."
    else:
        status = "CONFIRMED_NO"
        reason = "Свежие источники почти единодушны: этой марки нет."

    # An undated row is dated by the moment we polled, which is not when anyone
    # saw anything.  Such a row may still vote, at its low weight, but it must
    # never set the age shown on the card: that is how a two-month-old crowd
    # summary starts reading as "4 минуты назад".
    timed = [item for item in fresh if item.row.get("observed_at")]
    newest = max((item.observed_at for item in timed if item.observed_at), default=None)
    undated_only = bool(fresh) and not timed
    agreeing = independent_positive if status in {"CAN_REFUEL", "LIKELY_AVAILABLE", "LIMITED"} else independent_negative
    trust_score, trust_tier, trust_reason = _trust_score(status, fresh, len(agreeing), current_time)
    if (relay_positive or relay_negative) and not (official_positive or official_negative):
        # A relayed answer is never as strong as reading the source directly.
        trust_score = min(trust_score, 90)
        trust_tier = "conflict" if status == "CONFLICT" else "high" if trust_score >= 75 else "moderate" if trust_score >= 45 else "low"
    if disagreement:
        side = "против" if disagreement["side"] == "negative" else "за наличие"
        reason += f" В меньшинстве оказались {disagreement['count']} источн. {side}."
        trust_score = max(1, round(trust_score * 0.85))
        trust_tier = "conflict" if status == "CONFLICT" else "high" if trust_score >= 75 else "moderate" if trust_score >= 45 else "low"
        trust_reason += "; есть более слабый противоположный сигнал"
    # A static build freezes the answer at build time.  Publishing the TTL of
    # the signal the answer rests on lets the page expire it in the browser
    # instead of pretending the whole snapshot ages at one rate.
    ttl_seconds = max(
        (TTL_SECONDS.get(str(item.row.get("kind") or ""), 2 * 60 * 60) for item in fresh),
        default=None,
    )
    # And the moment it runs out, for a page left open or offline to stop
    # showing it while no new snapshot comes. An undated answer counts from when
    # we polled it: the card still says the source gives no time, but the
    # answer does not stay current for ever (15 Sep 2026 review).
    polled = max((item.observed_at for item in fresh if item.observed_at), default=None)
    anchor = newest or polled
    expires_at = anchor + timedelta(seconds=ttl_seconds) if status != "NO_FRESH_DATA" and anchor and ttl_seconds else None
    confidence = {
        "CAN_REFUEL": "high",
        "CONFIRMED_NO": "high",
        "CONFLICT": "conflict",
        "LIMITED": "moderate",
        "LIKELY_AVAILABLE": "moderate",
        "LIKELY_NOT": "moderate",
        "NO_FRESH_DATA": "none",
    }[status]

    return {
        "grade": grade,
        "status": status,
        "label": FINAL_STATUSES[status],
        "reason": reason,
        "confidence": confidence,
        "updated_at": newest.isoformat().replace("+00:00", "Z") if newest else None,
        "age_seconds": round((current_time - newest).total_seconds()) if newest else None,
        "price_rub": price["value"],
        "price_sources": price["sources"],
        "price_age_seconds": price["age_seconds"],
        "limit_liters": min(limits) if limits else None,
        "queue": queue,
        # Only reports that back the answer count: fourteen people confirming
        # "нет" must not be shown as fourteen confirmations of "есть".
        "confirmations": _confirmation_count(_supporting(status, positives, negatives, restricted, fresh)),
        "ttl_seconds": ttl_seconds,
        "expires_at": expires_at.isoformat().replace("+00:00", "Z") if expires_at else None,
        "probability": round(probability, 3) if probability is not None else None,
        "probability_percent": round(probability * 100) if probability is not None else None,
        "votes": vote_breakdown,
        "trust_score": trust_score,
        "trust_tier": trust_tier,
        "trust_label": TRUST_LABELS[trust_tier],
        "disagreement": disagreement,
        "trust_reason": trust_reason,
        "source_count": len({str(item.row.get("source") or item.cluster) for item in deduped}),
        "fresh_source_count": len({str(item.row.get("source") or item.cluster) for item in fresh}),
        "independent_agreeing_count": len(agreeing),
        "undated_only": undated_only,
        "yandex": _second_opinion(decorated, status),
        "eyewitness": _eyewitness_summary(decorated),
        "fresh_provenance_count": len({item.cluster for item in fresh}),
        "fresh_evidence_count": len(fresh),
        "evidence_count": len(relevant),
        "evidence": [_public_row(item) for item in deduped],
    }


def evaluate_station(
    station: dict[str, Any],
    *,
    grades: Iterable[str] = ("AI92", "AI95", "AI98", "AI100", "DT", "LPG"),
    now: datetime | None = None,
) -> dict[str, Any]:
    result = {key: value for key, value in station.items() if key != "evidence"}
    result["grades"] = {grade: evaluate_grade(station.get("evidence", []), grade, now=now) for grade in grades}
    result["evidence_total"] = len(station.get("evidence", []))
    return result


# The product question is not "what is the status", it is "do I drive there, and
# how long will I stand".  This turns the evidence into that answer, and says
# out loud which parts are an estimate.
GO_LABELS = {
    "GO": "Стоит ехать",
    "GO_WITH_WAIT": "Ехать можно, но с очередью",
    "RISKY": "Скорее всего, есть",
    "NO": "Ехать не стоит",
    "UNKNOWN": "Непонятно",
}


def travel_advice(evaluated: dict[str, Any], timeline: dict[str, Any] | None = None) -> dict[str, Any]:
    status = evaluated.get("status")
    queue = evaluated.get("queue") or {}
    limit = evaluated.get("limit_liters")
    trust = int(evaluated.get("trust_score") or 0)
    held_for = (timeline or {}).get("duration_seconds")
    cars_from = queue.get("cars_from")

    wait_text = None
    if queue:
        if queue.get("wait_from_minutes") is not None and queue.get("wait_to_minutes") is not None:
            wait_text = f"≈{queue['wait_from_minutes']}–{queue['wait_to_minutes']} мин"
        elif queue.get("wait_from_minutes") is not None:
            wait_text = f"от {queue['wait_from_minutes']} мин"
        else:
            wait_text = "время неизвестно"

    if status in {"CONFIRMED_NO", "LIKELY_NOT"}:
        decision, risk, risk_text = "NO", "high", "Свежие источники говорят, что этой марки здесь нет."
    elif status == "NO_FRESH_DATA":
        decision, risk, risk_text = "UNKNOWN", "high", "Нет свежего сигнала — ехать наугад."
    elif status == "CONFLICT":
        decision, risk, risk_text = "RISKY", "high", "Источники расходятся: одни видят топливо, другие нет."
    else:
        # Available in some form.  How likely is it to still be there on arrival?
        if held_for is not None and held_for >= 2 * 3600:
            risk, risk_text = "low", "Наличие держится больше двух часов — шанс застать топливо высокий."
        elif held_for is not None and held_for < 20 * 60:
            risk, risk_text = "medium", "Топливо появилось только что: сигнал свежий, но такой запас разбирают быстро."
        elif trust >= 70:
            risk, risk_text = "low", "Свежее подтверждение от сильного источника."
        else:
            risk, risk_text = "medium", "Подтверждение есть, но слабое — данные могут отставать."
        if cars_from is not None and cars_from >= 50:
            risk = "high"
            risk_text = "Очередь больше 50 машин: пока достоите, топливо может закончиться."
        # The wording follows the combined probability, so a 79% answer never
        # reads the same as a 98% one.
        chance = evaluated.get("probability")
        decision = "GO" if chance is None or chance >= 0.85 else "RISKY"
        if queue and decision == "GO":
            decision = "GO_WITH_WAIT" if (cars_from or 0) < 50 else "RISKY"

    parts = []
    if held_for is not None and status not in {"NO_FRESH_DATA", "CONFIRMED_NO", "LIKELY_NOT"}:
        parts.append(f"держится {_human_duration(held_for)}")
    if queue:
        parts.append(f"очередь: {queue['label']}" + (f" ({wait_text})" if wait_text and wait_text != "время неизвестно" else ""))
    elif status in {"CAN_REFUEL", "LIKELY_AVAILABLE"}:
        parts.append("об очереди никто не сообщал")
    if limit:
        parts.append(f"лимит {limit:g} л")
    confirmations = int(evaluated.get("confirmations") or 0)
    if confirmations:
        parts.append(f"{confirmations} {_plural(confirmations, 'подтверждение', 'подтверждения', 'подтверждений')}")

    return {
        "decision": decision,
        "label": GO_LABELS[decision],
        "risk": risk,
        "risk_text": risk_text,
        # Worth putting on the card only when it warns about something the
        # summary does not already say; "нет свежих данных" says it twice.
        "caution": risk_text if risk != "low" and status not in {"NO_FRESH_DATA", "CONFIRMED_NO", "LIKELY_NOT"} else None,
        "wait_text": wait_text,
        "summary": ", ".join(parts) if parts else None,
    }


def _human_duration(seconds: float) -> str:
    if seconds < 3600:
        return f"{max(1, round(seconds / 60))} мин"
    if seconds < 86400:
        return f"{round(seconds / 3600)} ч"
    return f"{round(seconds / 86400)} дн."


def _plural(count: int, one: str, few: str, many: str) -> str:
    tail, hundred = count % 10, count % 100
    if 11 <= hundred <= 14 or tail == 0 or tail >= 5:
        return many
    return one if tail == 1 else few


def _supporting(
    status: str,
    positives: list[EvaluatedRow],
    negatives: list[EvaluatedRow],
    restricted: list[EvaluatedRow],
    fresh: list[EvaluatedRow],
) -> list[EvaluatedRow]:
    """The fresh rows that actually back the published verdict."""
    if status in {"CAN_REFUEL", "LIKELY_AVAILABLE", "LIMITED"}:
        chosen = positives + restricted
    elif status in {"CONFIRMED_NO", "LIKELY_NOT"}:
        chosen = negatives
    else:
        chosen = fresh
    unique: dict[int, EvaluatedRow] = {}
    for item in chosen:
        unique[id(item)] = item
    return list(unique.values())
