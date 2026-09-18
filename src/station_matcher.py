"""Conservative canonical station matching for the MVP snapshot."""

from __future__ import annotations

from difflib import SequenceMatcher
from functools import lru_cache
import hashlib
from math import asin, cos, radians, sin, sqrt
import re
from typing import Any

from .station_filters import gas_named, gas_pump_named


OSM_ID_SOURCES = {"gdebenz", "benzas", "benzinkarta"}
# The Sber feed and 2GIS «Статус АЗС» both key stations by 2GIS branch id.
TWO_GIS_ID_SOURCES = {"sber", "2gis-benzin"}
# AZS MAP keys a card by where it came from: osm_n<id> or osm_w<id> for an
# OpenStreetMap node or way, ya_<id> for a Yandex Maps organisation.
AZSMAP_OSM = re.compile(r"osm_[nwr](\d+)")
AZSMAP_YANDEX = re.compile(r"ya_(\d+)")
EXPLICIT_RULES = {"shared_osm_id", "explicit_upstream_id"}


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
    """The key canonical ids are built from.

    It stays as it was: a new spelling here would give a known station a new
    id and cut it off from its history. Matching reads names with _name_key.
    """
    raw = _text(value)
    compact = re.sub(r"[^a-zа-я0-9]+", "", raw)
    if not compact:
        return raw
    for token, key in BRAND_KEYS:
        if token in compact:
            return key
    return raw


# The names the matcher has always read as no network: none, or a bare «АЗС».
GENERIC_NETWORKS = {"азс", "station", "неизвестно", "unknown", ""}
# How feeds say a station belongs to no network in particular: gde-benzin's
# "other", gdezapravka's «Независимая / Прочее», гдебензин.рф's «Прочие АЗС»,
# «Заправка». Read as a network of its own, "other" alone stood in 415 pairs
# of cards closer than 60 m on 15 Sep 2026, one card of a pair usually
# without data.
NO_NETWORK = frozenset({"other", "прочие", "прочее", "независимая", "unknown", "неизвестно", "station"})
# Words that say what kind of place it is, or what kind of company, not whose.
NAME_FILLER = frozenset({
    "азс", "азк", "станция", "заправка", "заправочная", "автозаправочная", "автозаправка",
    "самообслуживания", "автоматическая", "автомат", "мобильная", "частная", "сеть",
    "ооо", "оао", "зао", "пао", "ао", "ип", "тд",
})
# Spellings the keys above miss, each seen on 15 Sep 2026 at a forecourt a
# known network's card stands on.
MORE_BRAND_KEYS: tuple[tuple[str, str], ...] = (
    ("кинеф", "kirishi"), ("рнкарт", "rosneft"), ("тнзапад", "tatneft"),
    ("роялойл", "royaloil"), ("бензостайл", "benzostyle"),
)
# A feed's own id for a network where it is not the network's name.
# gde-benzin files Газпромнефть under "gazprom" (97 pairs of cards on 15 Sep
# 2026), and Gazprom's methane pumps too, so the id may be either network.
FEED_IDS = {"gazprom": frozenset({"gazpromneft", "gazprom"})}
# One forecourt under the names of the companies that owned it or sell
# through it, each seen on 15 Sep 2026 as two cards at one address: Neste sold
# its stations here to Tatneft; Lukoil's fuel-card company is listed at the
# Teboil stations Lukoil runs; Сургутнефтегаз sells as Киришиавтосервис, the
# retailer of its Kirishi refinery.
SAME_OWNER = {"neste": "tatneft", "teboil": "lukoil", "surgut": "kirishi"}

_LATIN = str.maketrans({
    "а": "a", "б": "b", "в": "v", "г": "g", "д": "d", "е": "e", "ж": "zh", "з": "z", "и": "i",
    "й": "y", "к": "k", "л": "l", "м": "m", "н": "n", "о": "o", "п": "p", "р": "r", "с": "s",
    "т": "t", "у": "u", "ф": "f", "х": "h", "ц": "ts", "ч": "ch", "ш": "sh", "щ": "sch",
    "ъ": "", "ы": "y", "ь": "", "э": "e", "ю": "yu", "я": "ya",
})
_SOUNDS = str.maketrans("cqwjz", "kkvys")


@lru_cache(maxsize=None)
def _name_key(name: str) -> tuple[frozenset[str] | None, str]:
    """The known networks a name may stand for, and the name's own letters.

    None for a name that says no network at all.
    """
    words = [
        word for word in re.findall(r"[a-zа-я0-9]+", name.lower().replace("ё", "е"))
        if len(word) > 1 and not word.isdigit() and word not in NAME_FILLER
    ]
    if all(word in NO_NETWORK for word in words):
        return None, ""
    compact = "".join(words)
    known = next((key for token, key in BRAND_KEYS + MORE_BRAND_KEYS if token in compact), None)
    return FEED_IDS.get(compact, frozenset({known} if known else ())), compact


@lru_cache(maxsize=None)
def _old_key(name: str) -> str:
    return _network(name)


@lru_cache(maxsize=None)
def _generic(name: str) -> bool:
    return _old_key(name) in GENERIC_NETWORKS


@lru_cache(maxsize=None)
def _gas(name: str) -> tuple[bool, bool]:
    station = {"network": name}
    return gas_pump_named(station), gas_named(station)


@lru_cache(maxsize=None)
def _latin(compact: str) -> str:
    return compact.translate(_LATIN).replace("ph", "f").replace("x", "ks").translate(_SOUNDS)


@lru_cache(maxsize=None)
def _consonants(compact: str) -> str:
    return re.sub(r"[^a-z]|[aeiouyh]", "", _latin(compact))


def _names_agree(left: str, right: str, *, prefix: bool) -> bool:
    """One network in another script or spacing: «Нева Ойл» and «Неваойл», «Бензо» and «BENZO».

    With ``prefix`` also a name with more after it: «Норд-Лайн» and «Норд-Лайн 3 Автополе».
    """
    short, long_ = sorted((_consonants(left), _consonants(right)), key=len)
    if len(short) >= 3:
        return long_ == short or (prefix and long_.startswith(short))
    return bool(short) and _latin(left) == _latin(right)


def _same_network(a: Any, b: Any, *, near: bool) -> bool:
    """Whether two names may be one network's.

    Some readings hold only on practically one spot (``near``): a name that
    says no network at all, the name of a company that owns or owned the
    forecourt, one name starting another. Farther out they would join two
    stations across a road: Sber lists a Lukoil at Комендантский проспект,
    43 к2 and a Teboil at 41а, 114 m apart.
    """
    left_name, right_name = str(a or ""), str(b or "")
    if _generic(left_name) or _generic(right_name) or _old_key(left_name) == _old_key(right_name):
        return True
    # None of the readings below joins a gas name with any other: a card a gas
    # pump started leaves the map with every row that joined it, and on
    # 15 Sep 2026 that took self-service stations Sber saw sell 95.
    if _gas(left_name) != _gas(right_name):
        return False
    left, left_letters = _name_key(left_name)
    right, right_letters = _name_key(right_name)
    if left is None or right is None:
        return near
    if left and right:
        if left & right:
            return True
        return near and bool({SAME_OWNER.get(key, key) for key in left} & {SAME_OWNER.get(key, key) for key in right})
    # A known network is spelled out in full: a short brand would otherwise
    # start somebody else's name.
    return _names_agree(left_letters, right_letters, prefix=near and not (left or right))


def _named(value: Any) -> bool:
    name = str(value or "")
    return not _generic(name) and _name_key(name)[0] is not None


def _names(station: dict[str, Any]) -> list[Any]:
    """Every network name a card is known by, so a Киришиавтосервис row still
    finds the card a Сургутнефтегаз row started. A name that says no network
    stays out: on 15 Sep 2026 one "other" row let a Vervex gas card at
    Витебский проспект, 9 take in Газпромнефть's rows."""
    return station.get("_networks") or [station.get("network")]


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
            if prefix in {"sber", "2gis"} and right.get("source") in TWO_GIS_ID_SOURCES and upstream_id == right_id:
                return True
            if prefix == "gdb" and right.get("source") in {"gdebenz", "benzas"} and upstream_id == right_id:
                return True
        if left.get("source") == "azsmap":
            osm = AZSMAP_OSM.fullmatch(left_id)
            yandex = AZSMAP_YANDEX.fullmatch(left_id)
            upstream = (
                osm.group(1) if osm and right.get("source") in OSM_ID_SOURCES
                else yandex.group(1) if yandex and right.get("source") == "yandex-maps"
                else None
            )
            # The OSM-based feeds carry the bare number, which a node and a way
            # may share, so the two must also stand on practically one spot.
            if upstream and upstream == right_id and haversine_km(a["location"], b["location"]) <= 0.15:
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
    near = distance_m <= 25
    agreeing = [(left, right) for left in _names(a) for right in _names(b) if _same_network(left, right, near=near)]
    if not agreeing:
        return False, None
    # Aggregators copy the same physical point but write the address very
    # differently ("Мурино, Оборонная 2" vs "дер. Мурино, ул. Оборонная, д. 2"),
    # and several of them ship no address at all.  Two rows of the same network
    # standing on practically the same coordinate are one station; requiring
    # string similarity there splits a single АЗС into a handful of cards.
    if near:
        return True, "network+25m"
    both_named = any(_named(left) and _named(right) for left, right in agreeing)
    missing_address = not _text(a.get("address")) or not _text(b.get("address"))
    if distance_m <= 60 and both_named and missing_address:
        return True, "network+60m"
    address_score = _address_similarity(a.get("address"), b.get("address"))
    if distance_m <= 60 and both_named and address_score >= 0.3:
        return True, "network+60m"
    if distance_m <= 45 and address_score >= 0.32:
        return True, "network+address+45m"
    if address_score >= 0.62:
        return True, "network+address+140m"
    return False, None


def _canonical_id(station: dict[str, Any]) -> str:
    loc = station["location"]
    material = "|".join(
        (_network(station.get("network")), _text(station.get("address")), f"{loc['lat']:.5f}", f"{loc['lon']:.5f}")
    )
    return "spbfi-" + hashlib.sha1(material.encode("utf-8")).hexdigest()[:12]


# Two forecourts cannot stand fifteen metres apart: cards that close are one
# station written down under two names — a brand and its operator («Deko» and
# «ТД Смарт-Технологии»), a spelling («Газпром» and «Газпромнефть», «С-зтк» and
# «СЗТК»), or the brand it used to carry («Nord Point» where «Ойлпласт» now
# stands). On 18 Sep 2026 the owner opened such a card in Yandex and read
# «Больше не работает» while ours said «скорее есть»: 100 pairs of cards stood
# within fifteen metres of each other, and the crowd feeds kept the dead name
# alive. Yandex telling the two apart by its own organisation ids is the one
# thing that holds them apart.
ONE_FORECOURT_METRES = 15
# A little further apart the house number decides: «проспект Обуховской Обороны,
# 303» written twice, twenty-two metres apart, is one forecourt; «Благодатная, 2»
# and «Благодатная, 2а» are left alone.
SAME_HOUSE_METRES = 30
HOUSE_NUMBER = re.compile(r"(?<![\w-])(\d{1,4})\s*([а-яa-z])?(?![\w])", re.IGNORECASE)


def _house_numbers(address: Any) -> set[str]:
    """The house numbers an address names: «38 к3» → {«38»}, index dropped."""
    return {
        (digits + (letter or "")).lower()
        for digits, letter in HOUSE_NUMBER.findall(str(address or ""))
    }


def _yandex_ids(station: dict[str, Any]) -> set[str]:
    return {
        str(ref.get("station_id"))
        for ref in station.get("source_refs", [])
        if ref.get("source") == "yandex-maps" and ref.get("station_id")
    }


def _fold_one_forecourt(canonical: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Fold cards standing on one forecourt into the best known of them."""
    buckets: dict[tuple[int, int], list[int]] = {}
    for index, station in enumerate(canonical):
        location = station["location"]
        cell = (int(location["lat"] * 2000), int(location["lon"] * 1000))
        buckets.setdefault(cell, []).append(index)
    folded: dict[int, int] = {}

    def home(index: int) -> int:
        while folded.get(index, index) != index:
            index = folded[index]
        return index

    for cell, indexes in buckets.items():
        near = [
            index
            for dy in (-1, 0, 1) for dx in (-1, 0, 1)
            for index in buckets.get((cell[0] + dy, cell[1] + dx), [])
        ]
        for left in indexes:
            for right in near:
                if left >= right:
                    continue
                one, two = home(left), home(right)
                if one == two:
                    continue
                first, second = canonical[one], canonical[two]
                metres = haversine_km(first["location"], second["location"]) * 1000
                if metres > SAME_HOUSE_METRES:
                    continue
                if metres > ONE_FORECOURT_METRES and not (
                    _house_numbers(first.get("address")) & _house_numbers(second.get("address"))
                ):
                    continue
                # A gas pump and a petrol forecourt share many a lot, and the
                # gas filter drops the gas card later: folding the two would
                # take a working petrol station off the map with it.
                if gas_named(first) != gas_named(second):
                    continue
                if gas_pump_named(first) != gas_pump_named(second):
                    continue
                # Yandex knows two organisations here: they are two stations.
                ids_first, ids_second = _yandex_ids(first), _yandex_ids(second)
                if ids_first and ids_second and not (ids_first & ids_second):
                    continue
                keep, gone = (one, two) if _forecourt_rank(first) >= _forecourt_rank(second) else (two, one)
                _absorb(canonical[keep], canonical[gone])
                folded[gone] = keep
    return [station for index, station in enumerate(canonical) if home(index) == index]


# Who keeps a forecourt's name current: Yandex, Sber and 2GIS send people to
# look, and a chain's own feed knows its own stations. The crowd feeds copy each
# other and carry a brand for years after it is painted over, so a card they
# alone describe joins one of these rather than the other way round.
NAME_KEEPERS = {"yandex-maps", "sber", "2gis-benzin"}


def _forecourt_rank(station: dict[str, Any]) -> tuple[int, ...]:
    """Which card of one forecourt the others join: the best known one."""
    sources = {ref.get("source") for ref in station.get("source_refs", [])}
    official = any(item.get("kind") == "official_stock" for item in station.get("evidence", []))
    return (
        1 if _yandex_ids(station) else 0,
        1 if official else 0,
        len(sources & NAME_KEEPERS),
        len(station.get("source_refs", [])),
        len(station.get("evidence", [])),
        1 if _named(station.get("network")) else 0,
    )


def _absorb(keeper: dict[str, Any], gone: dict[str, Any]) -> None:
    for ref in gone.get("source_refs", []):
        if ref not in keeper["source_refs"]:
            keeper["source_refs"].append(ref)
    keeper["evidence"].extend(gone.get("evidence", []))
    keeper["match_rules"].append("one_forecourt")
    for name in gone.get("_networks", []):
        if name not in keeper.get("_networks", []):
            keeper.setdefault("_networks", []).append(name)
    if len(str(gone.get("address") or "")) > len(str(keeper.get("address") or "")):
        keeper["address"] = gone.get("address")
    if not _named(keeper.get("network")) and _named(gone.get("network")):
        keeper["network"] = gone.get("network")


def merge_stations(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    canonical: list[dict[str, Any]] = []
    # Small spatial buckets keep matching near-linear for several thousand rows.
    buckets: dict[tuple[int, int], list[int]] = {}
    for row in rows:
        lat, lon = row["location"]["lat"], row["location"]["lon"]
        cell = (round(lat * 500), round(lon * 500))
        chosen = None
        match_rule = None
        best: tuple[bool, float, int] | None = None
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                for index in buckets.get((cell[0] + dy, cell[1] + dx), []):
                    matched, rule = is_match(canonical[index], row)
                    if not matched:
                        continue
                    # A row that names no network may stand between two
                    # stations and belongs to the nearer one; an id both feeds
                    # share outranks any distance.
                    rank = (rule not in EXPLICIT_RULES, haversine_km(canonical[index]["location"], row["location"]), index)
                    if best is None or rank < best:
                        best, chosen, match_rule = rank, index, rule
        ref = {"source": row["source"], "station_id": row["station_id"]}
        evidence = []
        for item in row.get("evidence", []):
            enriched = dict(item)
            enriched.setdefault("source", row["source"])
            evidence.append(enriched)
        name = row.get("network")
        if chosen is None:
            station = {
                "id": _canonical_id(row),
                "network": name,
                "address": row.get("address"),
                "location": row["location"],
                "source_refs": [ref],
                "match_rules": ["seed"],
                "evidence": evidence,
                "_networks": [name] if _named(name) else [],
            }
            canonical.append(station)
            buckets.setdefault(cell, []).append(len(canonical) - 1)
        else:
            station = canonical[chosen]
            if ref not in station["source_refs"]:
                station["source_refs"].append(ref)
            station["match_rules"].append(match_rule)
            station["evidence"].extend(evidence)
            if _named(name) and name not in station["_networks"]:
                station["_networks"].append(name)
            # Prefer informative text, but never move coordinates by averaging.
            if len(str(row.get("address") or "")) > len(str(station.get("address") or "")):
                station["address"] = row.get("address")
            # A name a feed broke into U+FFFD would take the station off the map.
            if not _named(station.get("network")) and _named(row.get("network")) and "�" not in str(row.get("network")):
                station["network"] = row.get("network")

    canonical = _fold_one_forecourt(canonical)
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
        del station["_networks"]
    return sorted(canonical, key=lambda station: (str(station.get("network") or ""), str(station.get("address") or "")))
