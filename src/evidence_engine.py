"""Conservative station/grade evidence evaluation.

The engine deliberately keeps UNKNOWN separate from NOT_AVAILABLE and counts
provenance clusters, not raw records.  It accepts normalized Phase-0 evidence
and returns one of the seven user-facing product states from the brief.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
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
    if raw.startswith("gdebenzin:2gis"):
        return "2gis-catalog"
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


def _deduplicate(rows: Iterable[EvaluatedRow]) -> list[EvaluatedRow]:
    best: dict[str, EvaluatedRow] = {}
    for item in rows:
        previous = best.get(item.cluster)
        rank = (
            1 if item.fresh else 0,
            item.strength,
            item.observed_at.timestamp() if item.observed_at else 0,
        )
        old_rank = (
            1 if previous and previous.fresh else 0,
            previous.strength if previous else -1,
            previous.observed_at.timestamp() if previous and previous.observed_at else 0,
        )
        if previous is None or rank > old_rank:
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


def _has_known_queue(row: dict[str, Any], now: datetime | None = None) -> bool:
    queue = row.get("queue")
    if isinstance(queue, dict):
        valid_until = parse_time(queue.get("until"))
        if valid_until and now and valid_until < now:
            return False
        queue = queue.get("size")
    return str(queue or "").strip().lower() not in {"", "0", "false", "no", "none", "no_queue"}


def evaluate_grade(
    evidence: Iterable[dict[str, Any]],
    grade: str,
    *,
    now: datetime | None = None,
) -> dict[str, Any]:
    """Evaluate one fuel grade without converting missing evidence to NO."""
    current_time = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    relevant = [dict(row) for row in evidence if row.get("grade") == grade]
    decorated = [_decorate(row, current_time) for row in relevant]
    deduped = _deduplicate(decorated)
    fresh = [item for item in deduped if item.fresh]

    price_rows = [item for item in decorated if item.row.get("price_rub") is not None]
    latest_price = max(price_rows, key=lambda item: item.observed_at or datetime.min.replace(tzinfo=timezone.utc), default=None)
    limits = [item.row.get("limit_liters") for item in fresh if item.row.get("limit_liters") is not None]
    queues = [item.row.get("queue") for item in fresh if _has_known_queue(item.row, current_time)]

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
    # A relay carries the network's own stock feed one hop removed.  Its content
    # is official, only its delivery is not, so it answers like the direct
    # source but says so and never scores as high.
    relay_positive = [item for item in positives if item.row.get("kind") == "official_relay"]
    relay_negative = [item for item in negatives if item.row.get("kind") == "official_relay"]

    independent_positive = {item.cluster for item in positives if item.row.get("independent") is True}
    independent_negative = {item.cluster for item in negatives if item.row.get("independent") is True}

    # With a dozen aggregators on one card a single weak negative would turn
    # almost every station into "данные расходятся".  Opposing signals are only
    # a real conflict when they carry comparable weight; a clearly weaker one
    # is reported as a disagreement instead of erasing the answer.
    disagreement: dict[str, Any] | None = None
    if positives and negatives and not (official_positive and official_negative):
        best_positive = max(item.strength for item in positives)
        best_negative = max(item.strength for item in negatives)
        if best_positive - best_negative >= DECISIVE_STRENGTH_GAP:
            disagreement = {"side": "negative", "count": len(negatives), "strength": best_negative}
            negatives, independent_negative, official_negative = [], set(), []
        elif best_negative - best_positive >= DECISIVE_STRENGTH_GAP:
            disagreement = {"side": "positive", "count": len(positives), "strength": best_positive}
            positives, independent_positive, official_positive = [], set(), []

    if (positives and negatives) or (official_positive and official_negative):
        status = "CONFLICT"
        reason = "Свежие источники с разным provenance дают противоположные сигналы."
    elif restricted:
        status = "LIMITED"
        reason = "Есть свежий сигнал об очереди или лимите отпуска."
    elif official_positive:
        status = "CAN_REFUEL"
        reason = "Официальный station-level источник сообщил доступный остаток."
    elif official_negative:
        status = "CONFIRMED_NO"
        reason = "Официальный station-level источник сообщил отсутствие остатка."
    elif relay_positive:
        status = "CAN_REFUEL"
        reason = "Ретранслятор официальной ленты сети сообщил доступный остаток."
    elif relay_negative:
        status = "CONFIRMED_NO"
        reason = "Ретранслятор официальной ленты сети сообщил отсутствие остатка."
    elif len(independent_positive) >= 2:
        status = "CAN_REFUEL"
        reason = "Наличие подтверждено двумя независимыми свежими provenance-кластерами."
    elif len(independent_negative) >= 2:
        status = "CONFIRMED_NO"
        reason = "Отсутствие подтверждено двумя независимыми свежими provenance-кластерами."
    elif positives:
        status = "LIKELY_AVAILABLE"
        reason = "Есть свежий положительный сигнал, но его недостаточно для строгого подтверждения."
    elif negatives:
        status = "LIKELY_NOT"
        reason = "Есть свежий отрицательный сигнал, но нет достаточного независимого подтверждения."
    else:
        status = "NO_FRESH_DATA"
        reason = "Нет пригодного по времени grade-specific сигнала; UNKNOWN не считается отсутствием топлива."

    newest = max((item.observed_at for item in fresh if item.observed_at), default=None)
    agreeing = independent_positive if status in {"CAN_REFUEL", "LIKELY_AVAILABLE", "LIMITED"} else independent_negative
    trust_score, trust_tier, trust_reason = _trust_score(status, fresh, len(agreeing), current_time)
    if (relay_positive or relay_negative) and not (official_positive or official_negative):
        # A relayed answer is never as strong as reading the source directly.
        trust_score = min(trust_score, 90)
        trust_tier = "conflict" if status == "CONFLICT" else "high" if trust_score >= 75 else "moderate" if trust_score >= 45 else "low"
    if disagreement:
        side = "отрицательный" if disagreement["side"] == "negative" else "положительный"
        reason += f" Более слабый {side} сигнал ({disagreement['count']} шт.) учтён, но не перевесил."
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
        "price_rub": latest_price.row.get("price_rub") if latest_price else None,
        "limit_liters": min(limits) if limits else None,
        "queue": queues[0] if queues else None,
        "ttl_seconds": ttl_seconds,
        "trust_score": trust_score,
        "trust_tier": trust_tier,
        "trust_label": TRUST_LABELS[trust_tier],
        "disagreement": disagreement,
        "trust_reason": trust_reason,
        "source_count": len({str(item.row.get("source") or item.cluster) for item in deduped}),
        "fresh_source_count": len({str(item.row.get("source") or item.cluster) for item in fresh}),
        "independent_agreeing_count": len(agreeing),
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
