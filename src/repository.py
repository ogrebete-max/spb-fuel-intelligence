"""Snapshot repository and geographic query layer."""

from __future__ import annotations

from collections import Counter
from datetime import datetime, timezone
import json
from pathlib import Path
from typing import Any

from .evidence_engine import evaluate_grade, evaluate_station, parse_time, travel_advice
from .history import load_history, timeline_for
from .station_matcher import haversine_km


GRADES = ("AI92", "AI95", "AI98", "AI100", "DT", "LPG")
SOURCE_COUNT_KEYS = {
    "sber_fuel_map": "sber",
    "gdebenzin_rf": "gdebenzin",
    "toplivo_ryadom": "toplivo-ryadom",
    "rosneft_ptk": "rosneft-ptk",
    "benzinradar_analogue": "benzinradar-analogue",
    "benzin_live_analogue": "benzin-live-analogue",
    "telegram_benzinspb78": "telegram-benzinspb78",
    "yandex_maps_fuel": "yandex-maps",
    "gde_benzin": "gde-benzin",
    "gdebenzin_net": "gdebenzin-net",
    "tbank_fuel_map": "tbank-fuel",
}


class StationRepository:
    def __init__(self, snapshot_path: Path, history_path: Path | None = None):
        self.snapshot_path = snapshot_path
        self.history_path = history_path
        self.reload()

    def reload(self) -> None:
        self.snapshot = json.loads(self.snapshot_path.read_text(encoding="utf-8"))
        self.stations = self.snapshot.get("stations", [])
        self.by_id = {station["id"]: station for station in self.stations}
        self._mtime_ns = self.snapshot_path.stat().st_mtime_ns
        self.history = load_history(self.history_path)
        self._history_mtime_ns = self.history_path.stat().st_mtime_ns if self.history_path and self.history_path.exists() else None

    def _ensure_current(self) -> None:
        """Pick up a snapshot rebuilt by the CLI while the server is running."""
        if self.snapshot_path.stat().st_mtime_ns != self._mtime_ns:
            self.reload()
        elif self.history_path and self.history_path.exists() and self.history_path.stat().st_mtime_ns != self._history_mtime_ns:
            self.history = load_history(self.history_path)
            self._history_mtime_ns = self.history_path.stat().st_mtime_ns

    def _as_of(self, value: str | None) -> datetime:
        if value == "snapshot":
            parsed = parse_time(self.snapshot.get("snapshot_at"))
            if parsed:
                return parsed
        parsed = parse_time(value)
        return parsed or datetime.now(timezone.utc)

    def meta(self) -> dict[str, Any]:
        self._ensure_current()
        snapshot_at = parse_time(self.snapshot.get("snapshot_at"))
        age = max(0, round((datetime.now(timezone.utc) - snapshot_at).total_seconds())) if snapshot_at else None
        return {
            "schema_version": self.snapshot.get("schema_version"),
            "mode": self.snapshot.get("mode"),
            "generated_at": self.snapshot.get("generated_at"),
            "snapshot_at": self.snapshot.get("snapshot_at"),
            "snapshot_age_seconds": age,
            "aoi": self.snapshot.get("aoi"),
            "stats": self.snapshot.get("stats"),
            "grades": GRADES,
            "history": self.history.get("stats", {"tracked_station_grades": 0, "transitions_this_update": 0}),
            "notice": "Для ответа «сейчас» применяются жёсткие TTL: прямой статус — 30 мин, пользовательский сигнал — 45 мин. UNKNOWN никогда не становится NO.",
        }

    def sources(self) -> dict[str, Any]:
        self._ensure_current()
        row_counts = (self.snapshot.get("stats") or {}).get("source_rows", {})
        rows = []
        for source in self.snapshot.get("source_registry", []):
            item = dict(source)
            count_key = SOURCE_COUNT_KEYS.get(source["id"], source["id"])
            item["station_rows_in_snapshot"] = row_counts.get(count_key, 0)
            rows.append(item)
        return {"sources": rows, "counts": dict(Counter(item.get("status") for item in rows))}

    @staticmethod
    def _inside_bbox(location: dict[str, float], bbox: tuple[float, float, float, float] | None) -> bool:
        if bbox is None:
            return True
        west, south, east, north = bbox
        return west <= location["lon"] <= east and south <= location["lat"] <= north

    @staticmethod
    def _inside_area(station: dict[str, Any], area: str | None) -> bool:
        if not area or area == "all":
            return True
        address = str(station.get("address") or "").lower()
        if area == "spb":
            return "ленинградск" not in address and "всеволож" not in address and "гатчин" not in address
        if area == "lo":
            return any(token in address for token in ("ленинградск", "всеволож", "гатчин", "тоснен", "кировск", "выборг"))
        return True

    def query(
        self,
        *,
        grade: str = "AI95",
        statuses: set[str] | None = None,
        bbox: tuple[float, float, float, float] | None = None,
        center: dict[str, float] | None = None,
        radius_km: float | None = None,
        search: str | None = None,
        area: str | None = None,
        sort: str = "status",
        timeline: str | None = None,
        limit: int = 250,
        offset: int = 0,
        as_of: str | None = None,
    ) -> dict[str, Any]:
        self._ensure_current()
        if grade not in GRADES:
            raise ValueError(f"Unsupported grade: {grade}")
        now = self._as_of(as_of)
        query_text = (search or "").strip().casefold()
        result = []
        all_statuses: Counter[str] = Counter()
        timeline_counts: Counter[str] = Counter()

        for station in self.stations:
            location = station["location"]
            if not self._inside_bbox(location, bbox) or not self._inside_area(station, area):
                continue
            if query_text and query_text not in f"{station.get('network', '')} {station.get('address', '')}".casefold():
                continue
            distance = haversine_km(center, location) if center else None
            if radius_km is not None and distance is not None and distance > radius_km:
                continue
            evaluated = evaluate_grade(station.get("evidence", []), grade, now=now)
            temporal = timeline_for(self.history, station, grade, now=now, current_status=evaluated["status"])
            evaluated["timeline"] = temporal
            evaluated["advice"] = travel_advice(evaluated, temporal)
            all_statuses[evaluated["status"]] += 1
            if temporal.get("appeared_recent"):
                timeline_counts["appeared"] += 1
            if statuses and evaluated["status"] not in statuses:
                continue
            if timeline == "appeared" and not temporal.get("appeared_recent"):
                continue
            # The list view only needs the decision summary. Raw evidence stays
            # available from /api/stations/{id}; omitting it here keeps map/list
            # responses small even when hundreds of stations are visible.
            grade_summary = {key: value for key, value in evaluated.items() if key != "evidence"}
            result.append({
                "id": station["id"],
                "network": station.get("network") or "АЗС",
                "address": station.get("address") or "Адрес не указан",
                "location": location,
                "distance_km": round(distance, 2) if distance is not None else None,
                "source_count": len(station.get("source_refs", [])),
                "sources": sorted({ref["source"] for ref in station.get("source_refs", [])}),
                "grade": grade_summary,
            })

        priority = {
            "CAN_REFUEL": 0, "LIMITED": 1, "LIKELY_AVAILABLE": 2, "CONFLICT": 3,
            "LIKELY_NOT": 4, "CONFIRMED_NO": 5, "NO_FRESH_DATA": 6,
        }
        # "Ближайшие доступные" answers the question people actually ask: the
        # closest station that can serve this grade now, not the closest station.
        serves_now = {
            "CAN_REFUEL": 0, "LIMITED": 0, "LIKELY_AVAILABLE": 0,
            "CONFLICT": 1, "NO_FRESH_DATA": 2, "LIKELY_NOT": 3, "CONFIRMED_NO": 3,
        }
        # "Куда ехать" ranks by the actual decision: can it serve me, how
        # confident is that, how long is the queue, and only then distance.
        def go_rank(item: dict[str, Any]) -> tuple:
            grade_result = item["grade"]
            advice = grade_result.get("advice") or {}
            decision_order = {"GO": 0, "GO_WITH_WAIT": 1, "RISKY": 2, "UNKNOWN": 3, "NO": 4}
            queue = grade_result.get("queue") or {}
            return (
                decision_order.get(advice.get("decision"), 3),
                {"low": 0, "medium": 1, "high": 2}.get(advice.get("risk"), 2),
                queue.get("cars_from") if queue.get("cars_from") is not None else 0,
                -(grade_result.get("trust_score") or 0),
                item["distance_km"] if item["distance_km"] is not None else 0,
            )

        if sort == "go":
            result.sort(key=go_rank)
        elif sort == "nearest_available" and center:
            result.sort(key=lambda item: (serves_now[item["grade"]["status"]], item["distance_km"]))
        elif sort == "distance" and center:
            result.sort(key=lambda item: (item["distance_km"], priority[item["grade"]["status"]]))
        elif sort == "freshness":
            result.sort(key=lambda item: (item["grade"]["age_seconds"] is None, item["grade"]["age_seconds"] or 10**12))
        elif sort == "price":
            result.sort(key=lambda item: (item["grade"]["price_rub"] is None, item["grade"]["price_rub"] or 10**9))
        elif sort == "appeared":
            result.sort(key=lambda item: (
                not item["grade"]["timeline"].get("appeared_recent"),
                -(parse_time((item["grade"]["timeline"].get("last_transition") or {}).get("at")).timestamp()
                  if parse_time((item["grade"]["timeline"].get("last_transition") or {}).get("at")) else 0),
            ))
        else:
            result.sort(key=lambda item: (priority[item["grade"]["status"]], item["grade"]["age_seconds"] or 10**12))

        total = len(result)
        return {
            "grade": grade,
            "as_of": now.isoformat().replace("+00:00", "Z"),
            "total": total,
            "offset": offset,
            "limit": limit,
            "status_counts": dict(all_statuses),
            "timeline_counts": dict(timeline_counts),
            "stations": result[offset : offset + limit],
        }

    def grades_brief(self, *, as_of: str | None = None) -> dict[str, Any]:
        """Status of every grade for every station, in one pass.

        The card shows all grades at once, but computing that inside a
        per-grade query would evaluate the whole snapshot six times over.
        """
        self._ensure_current()
        now = self._as_of(as_of)
        rows: dict[str, dict[str, Any]] = {}
        for station in self.stations:
            evidence = station.get("evidence", [])
            row: dict[str, Any] = {}
            for grade in GRADES:
                summary = evaluate_grade(evidence, grade, now=now)
                # Short keys and no nulls: this file is downloaded by a phone.
                entry: dict[str, Any] = {"s": summary["status"]}
                if summary["price_rub"] is not None:
                    entry["p"] = round(float(summary["price_rub"]), 2)
                row[grade] = entry
            rows[station["id"]] = row
        return {"as_of": now.isoformat().replace("+00:00", "Z"), "stations": rows}

    def detail(self, station_id: str, *, as_of: str | None = None) -> dict[str, Any] | None:
        self._ensure_current()
        station = self.by_id.get(station_id)
        if station is None:
            return None
        now = self._as_of(as_of)
        result = evaluate_station(station, now=now)
        for grade, evaluated in result["grades"].items():
            evaluated["timeline"] = timeline_for(self.history, station, grade, now=now, current_status=evaluated["status"])
        return result
