"""Build the local MVP dataset from the live Phase-0 captures.

The script consumes the larger AOI responses kept in ``work/pages`` when they
are available and always falls back to the sanitized fixtures shipped with the
project.  Output is deterministic for a given set of inputs.
"""

from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime, timezone
import json
from pathlib import Path
import re
import sys
from typing import Any, Callable


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from src.evidence_engine import parse_time  # noqa: E402
from src.normalizers import (  # noqa: E402
    canonical_grade,
    grade_tokens,
    normalize_benzinradar,
    normalize_gazpromneft,
    normalize_benzinest,
    normalize_benzonavt,
    normalize_benzas,
    normalize_fixture,
    normalize_gdebenzin,
    normalize_sber,
    normalize_tutbenz,
)
from src.sources_live import (  # noqa: E402
    normalize_gdezapravka,
    normalize_toplivo_direct,
    parse_moscow_file_time,
    normalize_kirishi_live,
    normalize_rosneft_live,
    normalize_tatneft_live,
    normalize_teboil_live,
    normalize_telegram_post,
    normalize_tofuel,
)
from src.station_matcher import merge_stations  # noqa: E402

sys.path.insert(0, str(ROOT / "scripts"))
from collectors import parse_moscow_confirmation  # noqa: E402


AOI = {"west": 29.50, "south": 59.60, "east": 31.10, "north": 60.35}


def read_json(path: Path, default: Any = None) -> Any:
    if not path.exists():
        return default
    return json.loads(path.read_text(encoding="utf-8-sig"))


def in_aoi(lat: Any, lon: Any) -> bool:
    try:
        latitude, longitude = float(lat), float(lon)
    except (TypeError, ValueError):
        return False
    return AOI["south"] <= latitude <= AOI["north"] and AOI["west"] <= longitude <= AOI["east"]


def source_registry() -> list[dict[str, str]]:
    text = (ROOT / "config" / "sources.yaml").read_text(encoding="utf-8")
    result: list[dict[str, str]] = []
    current: dict[str, str] | None = None
    for line in text.splitlines():
        match = re.match(r"\s*- id:\s*(\S+)", line)
        if match:
            if current:
                result.append(current)
            current = {"id": match.group(1)}
            continue
        if current:
            status = re.match(r"\s+status:\s*(\S+)", line)
            url = re.match(r'\s+public_url:\s*"([^"]+)"', line)
            if status:
                current["status"] = status.group(1)
            if url:
                current["public_url"] = url.group(1)
    if current:
        result.append(current)
    return result


def capture_times(raw_dir: Path, fallback: str) -> dict[str, str]:
    result: dict[str, str] = {}
    for item in read_json(raw_dir / "full-aoi-probe-results.json", []) or []:
        if item.get("captured_at"):
            result[item["name"]] = item["captured_at"]
    return Counter(result) and result or {"fallback": fallback}


def add_rows(
    target: list[dict[str, Any]],
    source_counts: Counter[str],
    rows: list[dict[str, Any]],
    received_at: str,
) -> None:
    for row in rows:
        if not in_aoi(row.get("location", {}).get("lat"), row.get("location", {}).get("lon")):
            continue
        for evidence in row.get("evidence", []):
            evidence.setdefault("received_at", received_at)
            evidence.setdefault("source", row.get("source"))
        target.append(row)
        source_counts[row["source"]] += 1


def normalize_undated_gdebenz(station: dict[str, Any], received_at: str) -> dict[str, Any]:
    row = {
        "source": "gdebenz",
        "station_id": str(station.get("osm_id")),
        "network": station.get("brand") or station.get("name"),
        "address": station.get("addr"),
        "location": {"lat": float(station["lat"]), "lon": float(station["lon"])},
        "evidence": [],
    }
    status = station.get("status")
    # ``fuels_now`` is a comma separated string such as "92,95,98,ДТ"; iterating
    # it directly would yield single characters.
    present = grade_tokens(station.get("fuels_now"))
    catalog = grade_tokens(",".join(str(item) for item in ((station.get("meta") or {}).get("f") or [])))
    availability = "LIKELY" if status == "yes" else "QUEUE" if status == "queue" else "UNKNOWN"
    for grade in present:
        row["evidence"].append({
            "grade": grade,
            "availability": availability if status in {"yes", "queue"} else "LIKELY",
            "kind": "undated_crowd_summary",
            "observed_at": None,
            "received_at": received_at,
            "price_rub": None,
            "limit_liters": None,
            "queue": "reported" if status == "queue" else None,
            "confidence": {"timestamp_missing": True},
            "provenance_cluster": "gdebenz-crowd",
            "independent": True,
            "raw_status": status,
            "note": "The map row has no report timestamp; this is only a short-lived hint.",
        })
    # The source publishes "what is available right now"; a catalog grade left
    # out of that list while the station itself reports a state is a negative
    # hint, never a hard negative.
    if status in {"yes", "no", "queue"}:
        for grade in catalog:
            if grade in present:
                continue
            row["evidence"].append({
                "grade": grade,
                "availability": "LIKELY_NOT",
                "kind": "undated_crowd_summary",
                "observed_at": None,
                "received_at": received_at,
                "price_rub": None,
                "limit_liters": None,
                "queue": None,
                "confidence": {"timestamp_missing": True, "inferred_from_absence": True},
                "provenance_cluster": "gdebenz-crowd",
                "independent": True,
                "raw_status": status,
                "note": "The grade is sold here but missing from the current availability list.",
            })
    for raw_grade, price in (station.get("prices_now") or {}).items():
        row["evidence"].append({
            "grade": canonical_grade(raw_grade), "availability": "UNKNOWN", "kind": "price",
            "observed_at": price.get("t"), "received_at": received_at, "price_rub": price.get("p"),
            "limit_liters": None, "queue": None, "confidence": None,
            "provenance_cluster": "gdebenz-price-unknown-upstream", "independent": None,
            "raw_status": None, "note": "Price provenance is separate from availability.",
        })
    return row


def catalog_station(source: str, station_id: Any, network: Any, address: Any, lat: Any, lon: Any) -> dict[str, Any]:
    return {
        "source": source,
        "station_id": str(station_id),
        "network": network,
        "address": address,
        "location": {"lat": float(lat), "lon": float(lon)},
        "evidence": [],
    }


def prediction_row(station: dict[str, Any]) -> dict[str, Any]:
    row = catalog_station(
        "toplivo-ryadom",
        f"prediction:{station.get('la')}:{station.get('lo')}",
        station.get("b"), station.get("a"), station["la"], station["lo"],
    )
    tier_map = {"H": "LIKELY", "A": "LIKELY", "F": "LIKELY", "M": "LIKELY", "N": "LIKELY_NOT"}
    for raw_grade, state in (station.get("f") or {}).items():
        sources = state.get("src") or {}
        observed = max((value or 0 for value in sources.values()), default=0) or None
        row["evidence"].append({
            "grade": canonical_grade(raw_grade),
            "availability": tier_map.get(state.get("t"), "UNKNOWN"),
            "kind": "payment_prediction",
            "observed_at": observed,
            "price_rub": None,
            "limit_liters": state.get("lim"),
            "queue": None,
            "confidence": {"tier": state.get("t")},
            "provenance_cluster": "alpha+tbank+sber+2gis",
            "independent": False,
            "raw_status": state.get("t"),
            "note": "Prediction from payment/catalog activity, not a stock guarantee.",
        })
    return row


def build(raw_dir: Path) -> dict[str, Any]:
    analysis = read_json(raw_dir / "phase0-analysis.json", {}) or {}
    snapshot_at = analysis.get("generated_at") or datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    captured = capture_times(raw_dir, snapshot_at)
    rows: list[dict[str, Any]] = []
    counts: Counter[str] = Counter()

    def time_for(name: str) -> str:
        return captured.get(name, snapshot_at)

    sber = read_json(raw_dir / "sber-full-aoi.json", {}) or {}
    add_rows(rows, counts, [normalize_sber(item)[0] for item in sber.get("stations", [])], time_for("sber-full-aoi"))

    benzinest = read_json(raw_dir / "benzinest-full-aoi.json", []) or []
    add_rows(rows, counts, [normalize_benzinest({"station": item})[0] for item in benzinest], time_for("benzinest-full-aoi"))

    tutbenz = read_json(raw_dir / "tutbenz-full-aoi.json", []) or []
    add_rows(rows, counts, [normalize_tutbenz(item)[0] for item in tutbenz], time_for("tutbenz-full-aoi"))

    gdebenzin = read_json(raw_dir / "gdebenzin-full-aoi.json", {}) or {}
    gdebenzin_rows = []
    for item in gdebenzin.get("stations", []):
        copy = dict(item)
        prefix = str(copy.get("id") or "").split(":", 1)[0]
        if prefix in {"tb", "sber"}:
            copy["source_level"] = "payment"
        gdebenzin_rows.append(normalize_gdebenzin({"station": copy})[0])
    add_rows(rows, counts, gdebenzin_rows, time_for("gdebenzin-full-aoi"))

    benzonavt = read_json(raw_dir / "benzonavt-full-aoi.json", []) or []
    add_rows(rows, counts, [normalize_benzonavt(item)[0] for item in benzonavt], time_for("benzonavt-full-aoi"))

    gdebenz = read_json(raw_dir / "gdebenz-full-aoi.json", []) or []
    add_rows(rows, counts, [normalize_undated_gdebenz(item, time_for("gdebenz-full-aoi")) for item in gdebenz], time_for("gdebenz-full-aoi"))

    benzas_stations = {str(item.get("osm_id")): item for item in (read_json(raw_dir / "benzas-full-aoi.json", []) or [])}
    benzas_comments = {str(item.get("osm_id")): item for item in (read_json(raw_dir / "benzas-comments-full-aoi.json", []) or [])}
    benzas_rows = []
    for station_id, station in benzas_stations.items():
        body = {"station": station, "recent": [benzas_comments[station_id]] if station_id in benzas_comments else []}
        benzas_rows.append(normalize_benzas(body)[0])
    add_rows(rows, counts, benzas_rows, time_for("benzas-comments-full-aoi"))

    tofuel = read_json(raw_dir / "tofuel-full-aoi.json", {}) or {}
    tofuel_at = tofuel.get("captured_at") or snapshot_at
    add_rows(rows, counts, [row for item in tofuel.get("stations", []) for row in normalize_tofuel(item)], tofuel_at)

    gdezapravka = read_json(raw_dir / "gdezapravka-full-aoi.json", {}) or {}
    gdezapravka_at = gdezapravka.get("captured_at") or snapshot_at
    add_rows(
        rows, counts,
        [row for item in gdezapravka.get("stations", []) for row in normalize_gdezapravka(item, gdezapravka_at)],
        gdezapravka_at,
    )

    # The channel republishes driver confirmations with an explicit "last
    # confirmed at" line, which is a better observation time than the post time.
    telegram = read_json(raw_dir / "telegram-benzinspb78.json", {}) or {}
    telegram_at = telegram.get("captured_at") or snapshot_at
    telegram_reference = parse_time(telegram_at) or datetime.now(timezone.utc)
    telegram_rows = []
    for post in telegram.get("posts", []):
        confirmed = parse_moscow_confirmation(str(post.get("text") or ""), reference=telegram_reference)
        telegram_rows.extend(normalize_telegram_post(post, observed_at=confirmed))
    add_rows(rows, counts, telegram_rows, telegram_at)

    teboil = read_json(raw_dir / "teboil-official.json", {}) or {}
    teboil_rows = [
        row
        for group in teboil.get("data", [])
        for shop in group.get("shops", [])
        for row in normalize_teboil_live(shop)
    ]
    add_rows(rows, counts, teboil_rows, teboil.get("captured_at") or snapshot_at)

    kirishi = read_json(raw_dir / "kirishi-official.json", {}) or {}
    add_rows(
        rows, counts,
        [row for marker in kirishi.get("markers", []) for row in normalize_kirishi_live(marker)],
        kirishi.get("captured_at") or snapshot_at,
    )

    tatneft = read_json(raw_dir / "tatneft-azs.json", {}) or {}
    tatneft_types = ((read_json(raw_dir / "tatneft-fuel-types.json", {}) or {}).get("data") or {}).get("items", [])
    tatneft_titles = {item.get("id"): item.get("title") for item in tatneft_types}
    add_rows(
        rows, counts,
        [row for item in tatneft.get("data", []) for row in normalize_tatneft_live(item, tatneft_titles)],
        time_for("tatneft-azs"),
    )

    rosneft = (read_json(raw_dir / "rosneft-stations.json", {}) or {}).get("data") or {}
    rosneft_updated = rosneft.get("prices_update_date")
    add_rows(
        rows, counts,
        [row for item in rosneft.get("stations", []) for row in normalize_rosneft_live(item, updated=rosneft_updated)],
        time_for("rosneft-stations"),
    )

    benzinradar = read_json(raw_dir / "benzinradar-full-aoi.json", []) or []
    add_rows(rows, counts, normalize_benzinradar(benzinradar, time_for("benzinradar-full-aoi")), time_for("benzinradar-full-aoi"))

    toplivo = read_json(raw_dir / "toplivo-data.json", {}) or {}
    toplivo_updated = parse_moscow_file_time(toplivo.get("updated")) or time_for("toplivo-data")
    direct_rows = [
        row
        for item in toplivo.get("stations", []) if in_aoi(item.get("la"), item.get("lo"))
        for row in normalize_toplivo_direct(item, updated_at=toplivo_updated)
    ]
    add_rows(rows, counts, direct_rows, time_for("toplivo-data"))
    predictions = read_json(raw_dir / "toplivo-predict.json", {}) or {}
    add_rows(rows, counts, [prediction_row(item) for item in predictions.get("stations", []) if in_aoi(item.get("la"), item.get("lo"))], snapshot_at)

    gpn_official = read_json(raw_dir / "gpn-official.json", {}) or {}
    gpn_received_at = gpn_official.get("captured_at") or snapshot_at
    gpn_official_rows = [normalize_gazpromneft(item)[0] for item in gpn_official.get("details", [])]
    add_rows(rows, counts, gpn_official_rows, gpn_received_at)

    # Official network catalog points broaden the map without pretending to be
    # current stock evidence.
    gpn = read_json(raw_dir / "gpn-spb.json", {}) or {}
    gpn_rows = [catalog_station("gazpromneft", s["GPNAZSID"], "Газпромнефть", s.get("address"), s["latitude"], s["longitude"])
                for s in gpn.get("stations", []) if in_aoi(s.get("latitude"), s.get("longitude"))]
    add_rows(rows, counts, gpn_rows, snapshot_at)

    lukoil = read_json(raw_dir / "lukoil-search.json", {}) or {}
    lukoil_rows = [catalog_station("lukoil", s["GasStationId"], "Лукойл", ", ".join(filter(None, (s.get("City"), s.get("Street")))), s["Latitude"], s["Longitude"])
                    for s in lukoil.get("GasStations", []) if in_aoi(s.get("Latitude"), s.get("Longitude"))]
    add_rows(rows, counts, lukoil_rows, snapshot_at)

    # Sanitized fixtures are fallback contracts, not live observations.  Never
    # mix them into a source that already supplied evidence in this refresh:
    # an older fixture may otherwise replace a live row with the same price
    # timestamp during evidence de-duplication.
    sources_with_live_evidence = {
        row["source"] for row in rows if row.get("source") and row.get("evidence")
    }
    fixtures_dir = ROOT / "tests" / "fixtures"
    for fixture_path in fixtures_dir.glob("*/2026-09-11-spb.json"):
        fixture = read_json(fixture_path, {}) or {}
        fixture_source = (fixture.get("_fixture") or {}).get("source")
        if fixture_source in sources_with_live_evidence:
            continue
        fixture_rows = normalize_fixture(fixture)
        fixture_time = (fixture.get("_fixture") or {}).get("captured_at") or snapshot_at
        add_rows(rows, counts, fixture_rows, fixture_time)

    canonical = merge_stations(rows)
    evidence_count = sum(len(station.get("evidence", [])) for station in canonical)
    mode = "live_http_snapshot" if raw_dir.name.lower() == "live" else "phase0_snapshot"
    return {
        "schema_version": 1,
        "generated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "snapshot_at": snapshot_at,
        "mode": mode,
        "aoi": AOI,
        "source_registry": source_registry(),
        "stats": {
            "raw_station_rows": len(rows),
            "canonical_stations": len(canonical),
            "evidence_records": evidence_count,
            "source_rows": dict(sorted(counts.items())),
        },
        "stations": canonical,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--raw-dir", type=Path, default=ROOT / "data" / "live")
    parser.add_argument("--output", type=Path, default=ROOT / "data" / "stations.json")
    args = parser.parse_args()
    result = build(args.raw_dir.resolve())
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result["stats"], ensure_ascii=False, indent=2))
    print(f"snapshot={args.output.resolve()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
