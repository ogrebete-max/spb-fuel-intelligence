"""Conservative canonical station matching for the MVP snapshot."""

from __future__ import annotations

from difflib import SequenceMatcher
import hashlib
from math import asin, cos, radians, sin, sqrt
import re
from typing import Any


OSM_ID_SOURCES = {"gdebenz", "benzas", "benzinkarta"}
GENERIC_NETWORKS = {"азс", "station", "неизвестно", "unknown", ""}


def _text(value: Any) -> str:
    value = str(value or "").lower().replace("ё", "е")
    value = re.sub(r"\b(ооо|пао|ао|азс|станция)\b", " ", value)
    return re.sub(r"[^a-zа-я0-9]+", " ", value).strip()


# Sources spell the same brand as "GPN", "Газпромнефть", "Газпромнефть, АЗС"
# and "Газпром нефть".  Matching on the raw string leaves one physical station
# split across several cards, so brands are folded to a single key.
BRAND_KEYS: tuple[tuple[str, str], ...] = (
    ("газпромнефт", "gazpromneft"), ("газпромнефть", "gazpromneft"), ("газпромнефт", "gazpromneft"),
    ("gazpromneft", "gazpromneft"), ("gpn", "gazpromneft"),
    ("лукойл", "lukoil"), ("lukoil", "lukoil"),
    ("тебойл", "teboil"), ("teboil", "teboil"),
    ("роснефт", "rosneft"), ("rosneft", "rosneft"),
    ("киришавтосервис", "kirishi"), ("кириши", "kirishi"), ("kirishi", "kirishi"),
    ("татнефт", "tatneft"), ("tatneft", "tatneft"),
    ("нефтьмагистрал", "neftmagistral"), ("несте", "neste"), ("neste", "neste"),
    ("фаэтон", "faeton"), ("птк", "ptk"), ("shell", "shell"),
    ("royaloil", "royaloil"), ("benzostyle", "benzostyle"), ("78petrol", "78petrol"),
    ("трасса", "trassa"), ("сургутнефтегаз", "surgut"), ("газпром", "gazprom"),
)


def _network(value: Any) -> str:
    raw = _text(value)
    compact = re.sub(r"[^a-zа-я0-9]+", "", raw)
    if not compact:
        return raw
    for token, key in BRAND_KEYS:
        if token in compact:
            return key
    return raw


def haversine_km(a: dict[str, float], b: dict[str, float]) -> float:
    lat1, lon1, lat2, lon2 = map(radians, (a["lat"], a["lon"], b["lat"], b["lon"]))
    dlat, dlon = lat2 - lat1, lon2 - lon1
    h = sin(dlat / 2) ** 2 + cos(lat1) * cos(lat2) * sin(dlon / 2) ** 2
    return 6371.0088 * 2 * asin(sqrt(h))


def _address_similarity(a: Any, b: Any) -> float:
    left, right = _text(a), _text(b)
    if not left or not right:
        return 0.0
    left_tokens, right_tokens = set(left.split()), set(right.split())
    jaccard = len(left_tokens & right_tokens) / max(1, len(left_tokens | right_tokens))
    return max(jaccard, SequenceMatcher(None, left, right).ratio())


def _same_network(a: Any, b: Any) -> bool:
    left, right = _network(a), _network(b)
    return left == right or left in GENERIC_NETWORKS or right in GENERIC_NETWORKS


def _identities(station: dict[str, Any]) -> list[dict[str, Any]]:
    refs = station.get("source_refs")
    if refs:
        return list(refs)
    return [{"source": station.get("source"), "station_id": str(station.get("station_id") or "")}]


def _explicit_osm_match(a: dict[str, Any], b: dict[str, Any]) -> bool:
    return any(
        left.get("source") in OSM_ID_SOURCES
        and right.get("source") in OSM_ID_SOURCES
        and str(left.get("station_id")) == str(right.get("station_id"))
        for left in _identities(a)
        for right in _identities(b)
    )


def _explicit_crosswalk_match(a: dict[str, Any], b: dict[str, Any]) -> bool:
    """Match provider IDs that explicitly name their upstream namespace."""
    pairs = [(left, right) for left in _identities(a) for right in _identities(b)]
    for original_left, original_right in pairs:
      for left, right in ((original_left, original_right), (original_right, original_left)):
        left_id = str(left.get("station_id") or "")
        right_id = str(right.get("station_id") or "")
        if left.get("source") == "gdebenzin" and ":" in left_id:
            prefix, upstream_id = left_id.split(":", 1)
            if prefix in {"sber", "2gis"} and right.get("source") == "sber" and upstream_id == right_id:
                return True
            if prefix == "gdb" and right.get("source") in {"gdebenz", "benzas"} and upstream_id == right_id:
                return True
    # Identical non-trivial IDs plus geographic agreement form an explicit
    # cross-source key; this is materially stronger than proximity alone.
    return any(
        str(left.get("station_id") or "") == str(right.get("station_id") or "")
        and len(str(left.get("station_id") or "")) >= 6
        and haversine_km(a["location"], b["location"]) <= 0.15
        for left, right in pairs
    )


def is_match(a: dict[str, Any], b: dict[str, Any]) -> tuple[bool, str | None]:
    """Never match on distance alone."""
    if _explicit_osm_match(a, b):
        return True, "shared_osm_id"
    if _explicit_crosswalk_match(a, b):
        return True, "explicit_upstream_id"
    distance_m = haversine_km(a["location"], b["location"]) * 1000
    if distance_m > 140:
        return False, None
    address_score = _address_similarity(a.get("address"), b.get("address"))
    same_network = _same_network(a.get("network"), b.get("network"))
    # Aggregators copy the same physical point but write the address very
    # differently ("Мурино, Оборонная 2" vs "дер. Мурино, ул. Оборонная, д. 2"),
    # and several of them ship no address at all.  Two rows of the same network
    # standing on practically the same coordinate are one station; requiring
    # string similarity there splits a single АЗС into a handful of cards.
    if distance_m <= 25 and same_network:
        return True, "network+25m"
    both_named = (
        same_network
        and _network(a.get("network")) not in GENERIC_NETWORKS
        and _network(b.get("network")) not in GENERIC_NETWORKS
    )
    missing_address = not _text(a.get("address")) or not _text(b.get("address"))
    if distance_m <= 60 and both_named and (missing_address or address_score >= 0.3):
        return True, "network+60m"
    if distance_m <= 45 and same_network and address_score >= 0.32:
        return True, "network+address+45m"
    if distance_m <= 140 and same_network and address_score >= 0.62:
        return True, "network+address+140m"
    return False, None


def _canonical_id(station: dict[str, Any]) -> str:
    loc = station["location"]
    material = "|".join(
        (_network(station.get("network")), _text(station.get("address")), f"{loc['lat']:.5f}", f"{loc['lon']:.5f}")
    )
    return "spbfi-" + hashlib.sha1(material.encode("utf-8")).hexdigest()[:12]


def merge_stations(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    canonical: list[dict[str, Any]] = []
    # Small spatial buckets keep matching near-linear for several thousand rows.
    buckets: dict[tuple[int, int], list[int]] = {}
    for row in rows:
        lat, lon = row["location"]["lat"], row["location"]["lon"]
        cell = (round(lat * 500), round(lon * 500))
        candidates: list[int] = []
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                candidates.extend(buckets.get((cell[0] + dy, cell[1] + dx), []))
        chosen = None
        match_rule = None
        for index in candidates:
            matched, rule = is_match(canonical[index], row)
            if matched:
                chosen, match_rule = index, rule
                break
        ref = {"source": row["source"], "station_id": row["station_id"]}
        evidence = []
        for item in row.get("evidence", []):
            enriched = dict(item)
            enriched.setdefault("source", row["source"])
            evidence.append(enriched)
        if chosen is None:
            station = {
                "id": _canonical_id(row),
                "network": row.get("network"),
                "address": row.get("address"),
                "location": row["location"],
                "source_refs": [ref],
                "match_rules": ["seed"],
                "evidence": evidence,
            }
            canonical.append(station)
            buckets.setdefault(cell, []).append(len(canonical) - 1)
        else:
            station = canonical[chosen]
            if ref not in station["source_refs"]:
                station["source_refs"].append(ref)
            station["match_rules"].append(match_rule)
            station["evidence"].extend(evidence)
            # Prefer informative text, but never move coordinates by averaging.
            if len(str(row.get("address") or "")) > len(str(station.get("address") or "")):
                station["address"] = row.get("address")
            if _network(station.get("network")) in GENERIC_NETWORKS and row.get("network"):
                station["network"] = row.get("network")

    for station in canonical:
        unique: dict[tuple[Any, ...], dict[str, Any]] = {}
        for item in station["evidence"]:
            key = (
                item.get("source"), item.get("grade"), item.get("availability"), item.get("kind"),
                item.get("observed_at"), item.get("provenance_cluster"), item.get("price_rub"),
            )
            unique[key] = item
        station["evidence"] = list(unique.values())
        station["source_refs"].sort(key=lambda ref: (ref["source"], ref["station_id"]))
    return sorted(canonical, key=lambda station: (str(station.get("network") or ""), str(station.get("address") or "")))
