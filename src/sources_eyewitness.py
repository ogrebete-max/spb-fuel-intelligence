"""Reports filed by people standing at the pump.

This is the only source where the observer is known to have looked at the
forecourt with their own eyes, so it is weighed above every remote feed. It is
also the only source the project controls, which is why it is treated with the
same suspicion as the rest: a report expires, a second report from the same
person replaces the first rather than stacking, and nothing here can revive a
station nobody has looked at.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from .normalizers import _evidence, _station


def normalize_eyewitness(report: dict[str, Any]) -> list[dict[str, Any]]:
    latitude, longitude = report.get("lat"), report.get("lon")
    if latitude is None or longitude is None:
        # Without coordinates the report cannot be attached to a forecourt: the
        # canonical station id is derived from the snapshot and may change.
        return []
    grade = str(report.get("grade") or "")
    if grade not in {"AI92", "AI95", "AI98", "AI100", "DT", "LPG"}:
        return []
    seen = report.get("seen")
    if not isinstance(seen, bool):
        return []
    stamp = report.get("at")
    observed = None
    if isinstance(stamp, (int, float)):
        observed = datetime.fromtimestamp(float(stamp) / 1000, timezone.utc).isoformat().replace("+00:00", "Z")
    rec = _station(
        "own-eyewitness", f"eye:{report.get('station')}:{report.get('who')}",
        None, None, latitude, longitude,
    )
    queue = report.get("queue")
    rec["evidence"].append(_evidence(
        grade, "AVAILABLE" if seen else "NOT_AVAILABLE", "eyewitness", "own-eyewitness",
        observed_at=observed,
        queue=str(int(queue)) if isinstance(queue, (int, float)) and queue else None,
        confidence={"confirmations": 1, "on_site": True},
        independent=True, raw_status=seen,
        note="Reported from the forecourt by someone using this app.",
    ))
    return [rec]
