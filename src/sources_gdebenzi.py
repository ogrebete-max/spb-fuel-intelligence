"""Normalizer for gdebenzi.ru.

Its robots.txt asks crawlers away from /api/, so this collector is only enabled
because the project owner decided to, and it polls no harder than the others.
It is included because it reports a queue in cars for more stations than any
other feed, and because its `conf: "dispute"` is an explicit "our own reporters
disagree" that the engine can use directly.

Its prices come from the shared russiabase feed — proven by the `poiid` field
matching russiabase to the kopeck — so price rows go into that one cluster.
"""

from __future__ import annotations

import re
from typing import Any

from .normalizers import _evidence, _station, canonical_grade, grade_tokens

STATE = {
    "yes": "AVAILABLE",
    "no": "NOT_AVAILABLE",
    "low": "LIMITED",
    "queue": "QUEUE",
    "dispute": "CONFLICT",
}
PRICE_KEYS = {"ai92": "AI92", "ai95": "AI95", "ai98": "AI98", "ai100": "AI100", "dt": "DT", "gas": "LPG"}
# "очередь до 25 авто", "очередь 25–50 авто", "очередь 100+ авто"
QUEUE_TEXT = (
    (r"100\s*\+", "gt50"),
    (r"50\s*[–—-]\s*100", "gt50"),
    (r"25\s*[–—-]\s*50", "20_50"),
    (r"до\s*25", "5_20"),
    (r"до\s*5\b", "lt5"),
)


def _queue_bucket(text: Any) -> str | None:
    raw = str(text or "").lower()
    if not raw:
        return None
    for pattern, bucket in QUEUE_TEXT:
        if re.search(pattern, raw):
            return bucket
    return "reported"


def normalize_gdebenzi(station: dict[str, Any], captured_at: str | None = None) -> list[dict[str, Any]]:
    if station.get("lat") is None or station.get("lon") is None:
        return []
    rec = _station(
        "gdebenzi", station.get("id"), station.get("brand") or station.get("name"),
        station.get("addr") or station.get("address"), station["lat"], station["lon"],
    )
    # `markts` is the time of a batch recompute shared by hundreds of rows;
    # `updated` is per station and is the honest observation time.
    observed = station.get("updated") or station.get("rbupd") or captured_at
    queue = _queue_bucket(station.get("queueTxt"))
    confidence = {
        "confirmations": station.get("reports"),
        "agreement_pct": station.get("confPct"),
        "consensus": station.get("conf"),
    }
    limits = {
        canonical_grade(name): value
        for name, value in (station.get("limits") or {}).items()
        if canonical_grade(name)
    }
    buckets = (
        ("fuelsYes", "AVAILABLE"),
        ("fuelsNo", "NOT_AVAILABLE"),
        ("fuelsDisputed", "CONFLICT"),
    )
    seen: set[str] = set()
    for key, availability in buckets:
        for raw_grade in station.get(key) or []:
            grade = canonical_grade(raw_grade)
            if not grade or grade in seen:
                continue
            seen.add(grade)
            rec["evidence"].append(_evidence(
                grade, availability, "crowd_status", "gdebenzi-crowd",
                observed_at=observed, limit=limits.get(grade),
                queue=queue if availability in {"AVAILABLE", "LIMITED", "QUEUE"} else None,
                confidence=confidence, independent=True, raw_status=station.get("state"),
            ))
    # A station-level state with no per-grade split still says something about
    # the grades the crowd listed as present.
    if not seen:
        availability = STATE.get(str(station.get("status") or station.get("state")), "UNKNOWN")
        if availability != "UNKNOWN":
            for grade in grade_tokens(",".join(str(item) for item in station.get("fuelsMaybe") or [])):
                rec["evidence"].append(_evidence(
                    grade, availability, "crowd_status", "gdebenzi-crowd",
                    observed_at=observed, queue=queue, confidence=confidence,
                    independent=True, raw_status=station.get("state"),
                ))
    for key, grade in PRICE_KEYS.items():
        price = (station.get("reg") or {}).get(key) or (station.get("prices") or {}).get(key)
        if price is None:
            continue
        rec["evidence"].append(_evidence(
            grade, "UNKNOWN", "price", "russiabase-price-cluster",
            observed_at=station.get("rbupd"), price=price, independent=False,
            note="Price relayed from the shared russiabase feed, not an independent quote.",
        ))
    return [rec]
