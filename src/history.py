"""Temporal station-grade observations and conservative transition labels."""

from __future__ import annotations

from datetime import datetime, timezone
import json
from pathlib import Path
from typing import Any

from .evidence_engine import evaluate_grade, parse_time


GRADES = ("AI92", "AI95", "AI98", "AI100", "DT", "LPG")
POSITIVE_STATUSES = {"CAN_REFUEL", "LIKELY_AVAILABLE"}
NEGATIVE_STATUSES = {"CONFIRMED_NO", "LIKELY_NOT"}
SOURCE_PRIORITY = {
    "gazpromneft": 0, "lukoil": 1, "teboil": 2, "sber": 3,
    "gdebenz": 4, "benzas": 5, "benzinest": 6, "tutbenz": 7,
    "gdebenzin": 8, "benzonavt": 9,
}


def iso(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def availability_group(status: str) -> str:
    if status in POSITIVE_STATUSES:
        return "positive"
    if status in NEGATIVE_STATUSES:
        return "negative"
    if status == "LIMITED":
        return "restricted"
    if status == "CONFLICT":
        return "conflict"
    return "unknown"


def station_history_id(station: dict[str, Any]) -> str:
    """Prefer a durable upstream ID over the matcher-generated canonical ID."""
    refs = station.get("source_refs") or []
    if refs:
        ref = min(
            refs,
            key=lambda item: (
                SOURCE_PRIORITY.get(str(item.get("source")), 99),
                str(item.get("source")), str(item.get("station_id")),
            ),
        )
        return f"{ref.get('source')}:{ref.get('station_id')}"
    return f"canonical:{station.get('id')}"


def _signal_class(evaluated: dict[str, Any]) -> str:
    fresh = [row for row in evaluated.get("evidence", []) if row.get("fresh")]
    official_positive = any(row.get("kind") == "official_stock" and row.get("availability") in {"AVAILABLE", "LIKELY"} for row in fresh)
    official_negative = any(row.get("kind") == "official_stock" and row.get("availability") in {"NOT_AVAILABLE", "LIKELY_NOT"} for row in fresh)
    if official_positive:
        return "official_positive"
    if official_negative:
        return "official_negative"
    group = availability_group(evaluated["status"])
    independent = len({row.get("effective_provenance") for row in fresh if row.get("independent") is True})
    if group == "positive":
        return "independent_positive" if independent >= 2 else "indirect_positive"
    if group == "negative":
        return "independent_negative" if independent >= 2 else "indirect_negative"
    return group


def _transition(previous: dict[str, Any], status: str, signal: str, at: str) -> dict[str, Any] | None:
    old_status = previous.get("current_status")
    old_group = availability_group(str(old_status or "NO_FRESH_DATA"))
    new_group = availability_group(status)
    if old_status == status:
        return None
    if old_group == "negative" and new_group == "positive":
        kind = "BECAME_AVAILABLE"
        if previous.get("signal_class") == "official_negative" and signal == "official_positive":
            confidence = "high"
            interpretation = "possible_restock"
        elif previous.get("signal_class") == "independent_negative" and signal in {"official_positive", "independent_positive"}:
            confidence = "medium"
            interpretation = "possible_restock"
        else:
            confidence = "low"
            interpretation = "availability_appeared"
    elif old_group == "positive" and new_group == "negative":
        kind, confidence, interpretation = "BECAME_UNAVAILABLE", "high" if "official" in signal else "medium", "availability_disappeared"
    elif old_group != "positive" and new_group == "positive":
        kind, confidence, interpretation = "NEW_POSITIVE_SIGNAL", "medium" if signal in {"official_positive", "independent_positive"} else "low", "new_positive_signal"
    else:
        kind, confidence, interpretation = "STATUS_CHANGED", "low", "status_changed"
    return {
        "at": at, "from_status": old_status, "to_status": status,
        "kind": kind, "confidence": confidence, "interpretation": interpretation,
    }


def update_history_data(history: dict[str, Any] | None, snapshot: dict[str, Any], *, observed_at: datetime | None = None) -> dict[str, Any]:
    result = dict(history or {})
    result.setdefault("schema_version", 1)
    entries = dict(result.get("entries") or {})
    at_dt = observed_at or parse_time(snapshot.get("snapshot_at")) or datetime.now(timezone.utc)
    at = iso(at_dt)
    changed = 0

    for station in snapshot.get("stations", []):
        history_id = station_history_id(station)
        for grade in GRADES:
            evaluated = evaluate_grade(station.get("evidence", []), grade, now=at_dt)
            if evaluated.get("evidence_count", 0) == 0:
                continue
            key = f"{history_id}|{grade}"
            old = entries.get(key)
            if old:
                # Schema v1 originally repeated display metadata in every grade
                # entry. Keep every temporal fact while compacting that safely.
                old = {name: value for name, value in old.items() if name not in {
                    "station_id", "network", "address", "last_fingerprint",
                }}
                entries[key] = old
            signal = _signal_class(evaluated)
            status = evaluated["status"]
            group = availability_group(status)
            if old and old.get("last_observed_at") == at:
                continue
            if old is None:
                entry = {
                    "station_history_id": history_id, "grade": grade,
                    "first_observed_at": at, "last_observed_at": at, "current_status": status,
                    "current_since": at, "positive_since": at if group == "positive" else None,
                    "negative_since": at if group == "negative" else None,
                    "last_positive_at": at if group == "positive" else None,
                    "last_negative_at": at if group == "negative" else None,
                    "signal_class": signal, "confirmations": 1,
                    "transitions": [],
                }
            else:
                entry = dict(old)
                transition = _transition(old, status, signal, at)
                if transition:
                    entry["transitions"] = (list(old.get("transitions") or []) + [transition])[-20:]
                    entry["current_since"] = at
                    changed += 1
                entry.update({
                    "last_observed_at": at, "current_status": status, "signal_class": signal,
                    "confirmations": int(old.get("confirmations") or 0) + 1,
                })
                if group == "positive":
                    entry["last_positive_at"] = at
                    if availability_group(str(old.get("current_status"))) != "positive":
                        entry["positive_since"] = at
                    entry["negative_since"] = None
                elif group == "negative":
                    entry["last_negative_at"] = at
                    entry["positive_since"] = None
                    if availability_group(str(old.get("current_status"))) != "negative":
                        entry["negative_since"] = at
            entries[key] = entry

    result["entries"] = entries
    result["updated_at"] = at
    result["last_snapshot_at"] = snapshot.get("snapshot_at")
    result["stats"] = {"tracked_station_grades": len(entries), "transitions_this_update": changed}
    return result


def timeline_for(
    history: dict[str, Any], station: dict[str, Any], grade: str, *, now: datetime,
    current_status: str | None = None,
) -> dict[str, Any]:
    entry = (history.get("entries") or {}).get(f"{station_history_id(station)}|{grade}")
    if not entry:
        return {"state": "NO_HISTORY", "label": "История ещё не накоплена", "description": "Появится после следующих обновлений данных.", "recent": False, "appeared_recent": False}
    transitions = list(entry.get("transitions") or [])
    last = transitions[-1] if transitions else None
    stored_group = availability_group(str(entry.get("current_status")))
    live_group = availability_group(current_status) if current_status else None
    # The stored entry is only as new as the last successful refresh.  When the
    # live answer already disagrees with it, continuity claims like "нет
    # непрерывно 13 ч" would contradict the card the user is looking at.
    contradicts = (
        (live_group in {"positive", "restricted"} and stored_group == "negative")
        or (live_group == "negative" and stored_group == "positive")
    )
    if contradicts:
        return {
            "state": "OUTDATED_HISTORY",
            "label": "История отстаёт от текущего ответа",
            "description": "Сохранённая история относится к предыдущему обновлению и пока не подтверждает текущий статус.",
            "recent": False, "appeared_recent": False,
            "current_since": None, "duration_seconds": None,
            "last_observed_at": entry.get("last_observed_at"),
            "confirmations": entry.get("confirmations", 1),
            "last_transition": last, "transitions": transitions[-5:],
        }
    status_group = stored_group
    duration_start = (entry.get("positive_since") or entry.get("current_since")) if status_group == "positive" else (entry.get("negative_since") or entry.get("current_since")) if status_group == "negative" else entry.get("current_since")
    current_since = parse_time(duration_start)
    duration = max(0, round((now - current_since).total_seconds())) if current_since else None
    state, label = "OBSERVED", "История наблюдений ведётся"
    description = "Это длительность наблюдаемого статуса, а не измерение объёма топлива в резервуаре."
    recent = False
    if last:
        changed_at = parse_time(last.get("at"))
        transition_age = max(0, round((now - changed_at).total_seconds())) if changed_at else None
        if last.get("kind") in {"BECAME_AVAILABLE", "NEW_POSITIVE_SIGNAL"} and status_group == "positive":
            # A history transition is not a live signal by itself. Its bright
            # “just appeared” presentation requires a current positive status
            # and a transition inside the same 45-minute freshness window.
            current_is_positive = current_status is None or availability_group(current_status) == "positive"
            recent = current_is_positive and transition_age is not None and transition_age <= 45 * 60
            state = "JUST_APPEARED" if transition_age is not None and transition_age <= 30 * 60 else "RECENTLY_APPEARED" if recent else "AVAILABLE_CONTINUOUS"
            if not current_is_positive:
                state, label = "HISTORICAL_POSITIVE", "Исторический сигнал наличия"
                description = "Переход в наличие был зафиксирован ранее, но сейчас нет пригодного по времени сигнала. Это не рекомендация ехать на АЗС."
                recent = False
            elif not recent:
                state, label = "AVAILABLE_CONTINUOUS", "Наличие наблюдалось ранее"
                description = "Последний переход в наличие слишком старый для ответа «сейчас»."
            elif last.get("interpretation") == "possible_restock":
                label = "Возможно, свежее пополнение" if recent else "Наличие продолжается"
                description = "После зафиксированного отсутствия появился положительный сигнал. Это косвенный признак пополнения, не замер остатка."
            elif current_is_positive:
                label = "Новый сигнал наличия" if recent else "Наличие продолжается"
                description = "Источник впервые после смены статуса показал наличие; факт поставки и объём не подтверждены."
        elif last.get("kind") == "BECAME_UNAVAILABLE" and status_group == "negative":
            recent = transition_age is not None and transition_age <= 6 * 3600
            state, label = "RECENTLY_DISAPPEARED" if recent else "UNAVAILABLE_CONTINUOUS", "Недавно пропало" if recent else "Отсутствие продолжается"
            description = "Ранее был положительный сигнал, затем источник показал отсутствие."
    elif status_group == "positive":
        state, label = "OBSERVED_AVAILABLE", "Наличие наблюдается"
    elif status_group == "negative":
        state, label = "OBSERVED_UNAVAILABLE", "Отсутствие наблюдается"
    appeared_recent = recent and state in {"JUST_APPEARED", "RECENTLY_APPEARED"}
    return {
        "state": state, "label": label, "description": description, "recent": recent, "appeared_recent": appeared_recent,
        "current_since": duration_start, "duration_seconds": duration,
        "last_observed_at": entry.get("last_observed_at"), "confirmations": entry.get("confirmations", 1),
        "last_transition": last, "transitions": transitions[-5:],
    }


def load_history(path: Path | None) -> dict[str, Any]:
    if not path or not path.exists():
        return {"schema_version": 1, "entries": {}}
    return json.loads(path.read_text(encoding="utf-8"))


def save_history(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".next")
    temporary.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    temporary.replace(path)
