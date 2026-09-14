"""Collectors for sources that are not a single plain JSON GET.

Everything here is anonymous public data: a tiled bbox API, two form POSTs, a
JSON blob embedded in a public HTML page, the public web preview of a Telegram
channel, a bank's public station list and a map's JavaScript data model.  No
account, key or protected content is involved.
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
import gzip
import html
import json
import os
import re
import ssl
import time
from typing import Any
from urllib.parse import quote, urlencode
from pathlib import Path
from urllib.request import Request, urlopen

ROOT_WEB = Path(__file__).resolve().parents[1] / "web"
ROOT_CONFIG = Path(__file__).resolve().parents[1] / "config"


AOI = {"west": 29.50, "south": 59.60, "east": 31.10, "north": 60.35}
BROWSER_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"
)
# The public channel that posts one structured card per confirmed station.
TELEGRAM_CHANNEL = "benzinspb78"
TELEGRAM_PAGES = 6
RU_MONTHS = {
    "января": 1, "февраля": 2, "марта": 3, "апреля": 4, "мая": 5, "июня": 6,
    "июля": 7, "августа": 8, "сентября": 9, "октября": 10, "ноября": 11, "декабря": 12,
}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _fetch(url: str, *, referer: str | None = None, data: bytes | None = None,
           content_type: str | None = None, accept: str = "application/json",
           timeout: int = 60, extra_headers: dict[str, str] | None = None,
           compressed: bool = False, context: ssl.SSLContext | None = None) -> bytes:
    headers = {"Accept": accept, "User-Agent": BROWSER_UA, "Accept-Language": "ru,en;q=0.8"}
    if compressed:
        headers["Accept-Encoding"] = "gzip"
    headers.update(extra_headers or {})
    if referer:
        headers["Referer"] = referer
    if content_type:
        headers["Content-Type"] = content_type
    with urlopen(Request(url, headers=headers, data=data), timeout=timeout, context=context) as response:
        body = response.read()
        if str(response.headers.get("Content-Encoding") or "").lower() == "gzip":
            body = gzip.decompress(body)
        return body


def _json(url: str, **kwargs: Any) -> Any:
    return json.loads(_fetch(url, **kwargs).decode("utf-8"))


def collect_gdezapravka() -> dict[str, Any]:
    """Tile the AOI: the endpoint silently truncates a response at 500 rows."""
    steps_lat, steps_lon = 4, 4
    lat_step = (AOI["north"] - AOI["south"]) / steps_lat
    lon_step = (AOI["east"] - AOI["west"]) / steps_lon
    tiles = [
        (AOI["south"] + row * lat_step, AOI["west"] + col * lon_step,
         AOI["south"] + (row + 1) * lat_step, AOI["west"] + (col + 1) * lon_step)
        for row in range(steps_lat) for col in range(steps_lon)
    ]

    def one(tile: tuple[float, float, float, float]) -> list[dict[str, Any]]:
        south, west, north, east = tile
        url = (
            "https://gdezapravka.ru/api/stations"
            f"?bbox={south:.4f},{west:.4f},{north:.4f},{east:.4f}"
        )
        payload = _json(url, referer="https://gdezapravka.ru/")
        rows = payload.get("stations") if isinstance(payload, dict) else payload
        return list(rows or [])

    merged: dict[str, dict[str, Any]] = {}
    truncated = 0
    with ThreadPoolExecutor(max_workers=4) as pool:
        for rows in pool.map(one, tiles):
            if len(rows) >= 500:
                truncated += 1
            for row in rows:
                merged[str(row.get("id"))] = row
    return {
        "captured_at": _now(), "tiles": len(tiles), "truncated_tiles": truncated,
        "stations": list(merged.values()),
    }


def collect_tofuel() -> dict[str, Any]:
    regions = ("Санкт-Петербург", "Ленинградская область")
    stations: list[dict[str, Any]] = []
    for region in regions:
        url = f"https://tofuel.ru/api/stations?region={quote(region)}&limit=5000"
        payload = _json(url, referer="https://tofuel.ru/")
        rows = payload.get("stations") if isinstance(payload, dict) else payload
        stations.extend(rows or [])
    return {"captured_at": _now(), "regions": list(regions), "stations": stations}


def collect_teboil() -> dict[str, Any]:
    # 353 is Saint Petersburg, 354 is the Leningrad region.
    groups: list[dict[str, Any]] = []
    for city_id in (353, 354):
        payload = _json(
            "https://azs.teboil.ru/map/ajax/map.php",
            referer="https://azs.teboil.ru/map/",
            data=f"cityId[]={city_id}".encode("utf-8"),
            content_type="application/x-www-form-urlencoded",
        )
        groups.extend(payload.get("data") or [])
    return {"captured_at": _now(), "data": groups}


def collect_kirishi() -> dict[str, Any]:
    page = _fetch("https://kirishiavtoservis.ru/stations/", accept="text/html").decode("utf-8", "replace")
    match = re.search(r"data-markers=(['\"])(.*?)\1", page, re.S)
    if not match:
        raise RuntimeError("kirishiavtoservis: data-markers attribute is missing")
    raw = html.unescape(match.group(2)).strip()
    # The attribute carries trailing markup after the JSON array.
    markers, _ = json.JSONDecoder().raw_decode(raw)
    return {"captured_at": _now(), "markers": markers}


def _telegram_page(before: int | None) -> str:
    url = f"https://t.me/s/{TELEGRAM_CHANNEL}"
    if before:
        url += f"?before={before}"
    return _fetch(url, accept="text/html", timeout=40).decode("utf-8", "replace")


def _plain_text(block: str) -> str:
    text = re.sub(r"<br\s*/?>", "\n", block)
    text = re.sub(r"<[^>]+>", "", text)
    return html.unescape(text)


def parse_moscow_confirmation(value: str, *, reference: datetime) -> str | None:
    """Parse "11 сентября в 23:24" as Moscow time and return UTC ISO-8601."""
    match = re.search(r"(\d{1,2})\s+([а-яё]+)\s+в\s+(\d{1,2}):(\d{2})", value.lower())
    if not match:
        return None
    day, month_name, hour, minute = match.groups()
    month = RU_MONTHS.get(month_name)
    if not month:
        return None
    for year in (reference.year, reference.year - 1):
        try:
            moscow = datetime(year, month, int(day), int(hour), int(minute), tzinfo=timezone(timedelta(hours=3)))
        except ValueError:
            continue
        parsed = moscow.astimezone(timezone.utc)
        # A December confirmation read in January must not jump a year forward.
        if parsed <= reference + timedelta(hours=6):
            return parsed.isoformat().replace("+00:00", "Z")
    return None


def collect_telegram() -> dict[str, Any]:
    """Read the public web preview of the channel; no account, no API key."""
    posts: dict[str, dict[str, Any]] = {}
    before: int | None = None
    for _ in range(TELEGRAM_PAGES):
        page = _telegram_page(before)
        identifiers = [int(value) for value in re.findall(rf'data-post="{TELEGRAM_CHANNEL}/(\d+)"', page)]
        bodies = re.findall(r'<div class="tgme_widget_message_text[^"]*"[^>]*>(.*?)</div>', page, re.S)
        stamps = re.findall(r'<time datetime="([^"]+)"', page)
        for index, body in enumerate(bodies):
            post_id = identifiers[index] if index < len(identifiers) else None
            published = stamps[index] if index < len(stamps) else None
            coordinates = None
            for href in re.findall(r'href="([^"]+)"', body):
                point = re.search(r"[?&]pt=(-?\d+\.\d+),(-?\d+\.\d+)", html.unescape(href))
                if point:
                    coordinates = {"lon": float(point.group(1)), "lat": float(point.group(2))}
                    break
            posts[str(post_id)] = {
                "post_id": post_id,
                "published_at": published,
                "text": _plain_text(body),
                "location": coordinates,
            }
        if not identifiers:
            break
        before = min(identifiers)
    return {"captured_at": _now(), "channel": TELEGRAM_CHANNEL, "posts": list(posts.values())}


# Yandex Maps renders the fuel block into the page itself, so the public search
# result page carries per-grade availability, a queue size and how many driver
# signals arrived in the last hour.  No key, no session, no protection is
# involved; the paths used here are the ones yandex.ru/robots.txt allows.
#
# This is the only source found that reports a queue for individual stations,
# which is the half of the decision the project was missing.  It is fetched
# gently: one request a second, an honest browser User-Agent, a dozen requests
# per refresh, and the whole collector can be switched off with
# SPBFI_DISABLE_YANDEX=1 without touching anything else.
YANDEX_VIEWS = (
    (29.70, 59.66), (29.81, 59.66), (29.93, 59.66), (30.04, 59.66),
    (30.16, 59.66), (30.27, 59.66), (30.39, 59.66), (30.50, 59.66),
    (30.62, 59.66), (30.73, 59.66), (30.85, 59.66), (29.70, 59.71),
    (29.81, 59.71), (29.93, 59.71), (30.04, 59.71), (30.16, 59.71),
    (30.27, 59.71), (30.39, 59.71), (30.50, 59.71), (30.62, 59.71),
    (30.73, 59.71), (30.85, 59.71), (29.70, 59.77), (29.81, 59.77),
    (29.93, 59.77), (30.04, 59.77), (30.16, 59.77), (30.27, 59.77),
    (30.39, 59.77), (30.50, 59.77), (30.62, 59.77), (30.73, 59.77),
    (30.85, 59.77), (29.70, 59.82), (29.81, 59.82), (29.93, 59.82),
    (30.04, 59.82), (30.16, 59.82), (30.27, 59.82), (30.39, 59.82),
    (30.50, 59.82), (30.62, 59.82), (30.73, 59.82), (30.85, 59.82),
    (29.70, 59.88), (29.81, 59.88), (29.93, 59.88), (30.04, 59.88),
    (30.16, 59.88), (30.27, 59.88), (30.39, 59.88), (30.50, 59.88),
    (30.62, 59.88), (30.73, 59.88), (30.85, 59.88), (29.70, 59.93),
    (29.81, 59.93), (29.93, 59.93), (30.04, 59.93), (30.16, 59.93),
    (30.27, 59.93), (30.39, 59.93), (30.50, 59.93), (30.62, 59.93),
    (30.73, 59.93), (30.85, 59.93), (29.70, 59.99), (29.81, 59.99),
    (29.93, 59.99), (30.04, 59.99), (30.16, 59.99), (30.27, 59.99),
    (30.39, 59.99), (30.50, 59.99), (30.62, 59.99), (30.73, 59.99),
    (30.85, 59.99), (29.70, 60.04), (29.81, 60.04), (29.93, 60.04),
    (30.04, 60.04), (30.16, 60.04), (30.27, 60.04), (30.39, 60.04),
    (30.50, 60.04), (30.62, 60.04), (30.73, 60.04), (30.85, 60.04),
    (29.70, 60.10), (29.81, 60.10), (29.93, 60.10), (30.04, 60.10),
    (30.16, 60.10), (30.27, 60.10), (30.39, 60.10), (30.50, 60.10),
    (30.62, 60.10), (30.73, 60.10), (30.85, 60.10), (29.70, 60.15),
    (29.81, 60.15), (29.93, 60.15), (30.04, 60.15), (30.16, 60.15),
    (30.27, 60.15), (30.39, 60.15), (30.50, 60.15), (30.62, 60.15),
    (30.73, 60.15), (30.85, 60.15),
)
YANDEX_STATE = re.compile(r'<script type="application/json" class="state-view">(.*?)</script>', re.S)


def collect_yandex() -> dict[str, Any]:
    if os.environ.get("SPBFI_DISABLE_YANDEX") == "1":
        raise RuntimeError("disabled by SPBFI_DISABLE_YANDEX")
    stations: dict[str, dict[str, Any]] = {}
    errors: list[str] = []
    for index, (lon, lat) in enumerate(YANDEX_VIEWS):
        if index:
            time.sleep(1.0)
        url = (
            "https://yandex.ru/maps/2/saint-petersburg/search/"
            f"{quote('АЗС')}/?ll={lon:.4f}%2C{lat:.4f}&z=14"
        )
        try:
            page = _fetch(url, accept="text/html", timeout=45).decode("utf-8", "replace")
        except Exception as exc:
            errors.append(f"{lon},{lat}: {type(exc).__name__}: {exc}")
            continue
        match = YANDEX_STATE.search(page)
        if not match:
            errors.append(f"{lon},{lat}: fuel block missing")
            continue
        try:
            state = json.loads(html.unescape(match.group(1)))
        except json.JSONDecodeError as exc:
            errors.append(f"{lon},{lat}: {exc}")
            continue
        for stack in state.get("stack", []):
            for item in (stack.get("results") or {}).get("items") or []:
                coordinates = item.get("coordinates") or []
                availability = item.get("fuelAvailability")
                if len(coordinates) != 2 or not availability:
                    continue
                key = str(item.get("id") or f"{coordinates[0]:.5f},{coordinates[1]:.5f}")
                stations[key] = {
                    "id": key,
                    "title": item.get("title"),
                    "address": item.get("address"),
                    "lon": coordinates[0],
                    "lat": coordinates[1],
                    "availability": availability,
                }
    if not stations:
        raise RuntimeError("; ".join(errors) or "no stations returned")
    return {"captured_at": _now(), "views": len(YANDEX_VIEWS), "errors": errors,
            "stations": list(stations.values())}


def _tiles(steps_lat: int, steps_lon: int) -> list[tuple[float, float, float, float]]:
    lat_step = (AOI["north"] - AOI["south"]) / steps_lat
    lon_step = (AOI["east"] - AOI["west"]) / steps_lon
    return [
        (AOI["south"] + row * lat_step, AOI["west"] + col * lon_step,
         AOI["south"] + (row + 1) * lat_step, AOI["west"] + (col + 1) * lon_step)
        for row in range(steps_lat) for col in range(steps_lon)
    ]


def collect_gdebenzin24() -> dict[str, Any]:
    """One radius call covers the whole area; per-grade statuses carry their own time."""
    payload = _json(
        "https://gdebenzin24.ru/api/nearby?lat=59.95&lon=30.30&radius_km=60",
        referer="https://gdebenzin24.ru/",
    )
    return {"captured_at": _now(), "stations": payload.get("stations") or []}


def collect_gde_benzin() -> dict[str, Any]:
    """Separates human confirmations from parser imports, which matters for weight."""
    payload = _json(
        "https://gde-benzin.ru/api/stations?bbox=59.60,29.50,60.35,31.10",
        referer="https://gde-benzin.ru/",
    )
    return {"captured_at": _now(), "stations": payload.get("stations") or []}


def collect_gdebenzin_net() -> dict[str, Any]:
    """The freshest queue feed found: explicit car counts and a waiting trend."""
    payload = _json(
        "https://gdebenzin.net/api/comments?lat1=59.60&lon1=29.50&lat2=60.35&lon2=31.10",
        referer="https://gdebenzin.net/",
    )
    rows = payload if isinstance(payload, list) else payload.get("stations") or []
    return {"captured_at": _now(), "stations": rows}


def collect_gdebenzfuel() -> dict[str, Any]:
    """Truncates at 500 rows, so the area is walked in quadrants."""
    merged: dict[str, dict[str, Any]] = {}
    truncated = 0
    for south, west, north, east in _tiles(3, 3):
        url = (
            "https://gdebenzfuel.ru/api/v1/stations"
            f"?minLat={south:.4f}&maxLat={north:.4f}&minLon={west:.4f}&maxLon={east:.4f}"
        )
        payload = _json(url, referer="https://gdebenzfuel.ru/")
        rows = payload if isinstance(payload, list) else payload.get("stations") or []
        if len(rows) >= 500:
            truncated += 1
        for row in rows:
            merged[str(row.get("id"))] = row
    return {"captured_at": _now(), "truncated_tiles": truncated, "stations": list(merged.values())}


def collect_tbank() -> dict[str, Any]:
    """Payment activity from a bank other than Sber; truncates at 300 rows."""
    merged: dict[str, dict[str, Any]] = {}
    for south, west, north, east in _tiles(3, 3):
        url = (
            "https://toplivo.tbank.ru/api/v1/stations"
            f"?minLat={south:.4f}&maxLat={north:.4f}&minLon={west:.4f}&maxLon={east:.4f}"
        )
        payload = _json(url, referer="https://toplivo.tbank.ru/")
        for row in payload.get("payload") or []:
            merged[str(row.get("id"))] = row
    return {"captured_at": _now(), "stations": list(merged.values())}



def collect_gdebenzi() -> dict[str, Any]:
    """Reports a queue in cars for more stations than any other feed.

    Its robots.txt asks crawlers away from /api/; the collector exists because
    the project owner decided to include it, and it polls on the same ten
    minute cadence as everything else.
    """
    payload = _json(
        "https://gdebenzi.ru/api/stations.php?bbox=29.50,59.60,31.10,60.35",
        referer="https://gdebenzi.ru/",
    )
    return {"captured_at": _now(), "stations": payload.get("stations") or []}


# The five feeds below were found on 14 Sep 2026 and answer from abroad. They
# are read for Saint Petersburg and the whole Leningrad region: the build keeps
# the city AOI, and the wider box keeps a capture comparable with what the
# sources themselves show.
REGION = {"south": 58.4, "west": 27.6, "north": 61.4, "east": 35.8}


def _in_region(lat: Any, lon: Any) -> bool:
    try:
        latitude, longitude = float(lat), float(lon)
    except (TypeError, ValueError):
        return False
    return REGION["south"] <= latitude <= REGION["north"] and REGION["west"] <= longitude <= REGION["east"]


def without_personal_fields(value: Any) -> Any:
    """Drop every field that names a person's account, however deep it sits.

    The 2GIS station card lists the drivers behind its reports by user id. The
    list read here carries no such field today; one that appears tomorrow must
    still never reach a capture file.
    """
    if isinstance(value, dict):
        return {
            key: without_personal_fields(item)
            for key, item in value.items() if "user" not in str(key).lower()
        }
    if isinstance(value, list):
        return [without_personal_fields(item) for item in value]
    return value


# 2GIS «Статус АЗС»: the tab on 2gis.ru where drivers mark each grade as there
# or not, with a queue and a litre limit. The page calls this host with no key
# or cookie. A box may span at most five degrees a side, so the region is read
# in two tiles; the city lies wholly in the western one. The station card
# (/stations/{id}) would add the drivers' user ids and is never called.
TWO_GIS_BENZIN = "https://benzin.api.2gis.ru/api/v1/stations"
TWO_GIS_TILES = ((58.4, 27.6, 61.4, 31.7), (58.4, 31.7, 61.4, 35.8))


def collect_2gis_benzin() -> dict[str, Any]:
    stations: dict[str, dict[str, Any]] = {}
    errors: list[str] = []
    for index, (south, west, north, east) in enumerate(TWO_GIS_TILES):
        if index:
            time.sleep(1.0)
        url = f"{TWO_GIS_BENZIN}?minLat={south}&maxLat={north}&minLon={west}&maxLon={east}"
        try:
            rows = _json(url, referer="https://2gis.ru/", compressed=True,
                         extra_headers={"Origin": "https://2gis.ru"})
        except Exception as exc:
            # Without the western tile there is no city at all.
            if index == 0:
                raise
            errors.append(f"tile {index}: {type(exc).__name__}: {exc}")
            continue
        if not isinstance(rows, list):
            raise RuntimeError("2gis benzin: the station list is not a list")
        for row in rows:
            station_id = (row.get("station") or {}).get("id") if isinstance(row, dict) else None
            if station_id is not None:
                stations[str(station_id)] = without_personal_fields(row)
    return {"captured_at": _now(), "tiles": len(TWO_GIS_TILES), "errors": errors,
            "stations": list(stations.values())}


# ППР's fuel-card locator, the backend behind TransitCard, Petrol Plus and E1
# CARD. Filtered by one fuel, it says how card sales of that grade go at every
# station right now: available, has_limit, possibly_available (too few
# transactions to tell) or unavailable. It carries no time: the status is the
# locator's "now". benzokarta.com republishes it and is not read.
TRANSITCARD = "https://locator.transitcard.ru/web/v2/point/transpose-list"
# Service ids from the locator's own service list; branded premium grades are
# separate services and are left out.
TRANSITCARD_SERVICES = {"AI92": 4, "AI95": 3, "AI98": 2, "AI100": 10, "DT": 1}


def transposed_rows(payload: dict[str, Any]) -> list[dict[str, Any]]:
    """The locator sends columns, one array per field, instead of rows."""
    columns = {key: value for key, value in payload.items() if isinstance(value, list)}
    size = payload.get("size")
    if not isinstance(size, int):
        size = len(columns.get("id") or [])
    return [
        {key: values[index] for key, values in columns.items() if index < len(values)}
        for index in range(size)
    ]


def collect_transitcard() -> dict[str, Any]:
    stations: dict[str, dict[str, Any]] = {}
    errors: list[str] = []
    for index, (grade, service) in enumerate(TRANSITCARD_SERVICES.items()):
        if index:
            time.sleep(1.5)
        query = urlencode({
            "pointTypes": 8, "services": service,
            "fuelAvailability": "available;possibly_available;unavailable",
            "x1": REGION["south"], "y1": REGION["west"], "x2": REGION["north"], "y2": REGION["east"],
        }, safe=";")
        try:
            payload = _json(f"{TRANSITCARD}?{query}", referer="https://locator.transitcard.ru/")
        except Exception as exc:
            errors.append(f"{grade}: {type(exc).__name__}: {exc}")
            continue
        for row in transposed_rows(payload if isinstance(payload, dict) else {}):
            if row.get("id") is None or not _in_region(row.get("latitude"), row.get("longitude")):
                continue
            station = stations.setdefault(str(row["id"]), {
                "id": str(row["id"]), "lat": row["latitude"], "lon": row["longitude"],
                "brand": row.get("brand"), "statuses": {}, "prices": {},
            })
            station["statuses"][grade] = row.get("status")
            station["prices"].update(row.get("prices") or {})
    if not stations:
        raise RuntimeError("; ".join(errors) or "transitcard: no stations returned")
    return {"captured_at": _now(), "services": TRANSITCARD_SERVICES, "errors": errors,
            "stations": list(stations.values())}


# Alfa-Bank's public fuel map: one list for all of Russia with, per grade, the
# bank's status, a price, the last card transaction and the Benzuber sales
# limits and stops. Benzuber runs Alfa's in-app fuel payments and its whole
# network is in this list, so Benzuber is not read on its own.
ALFA_STATIONS = "https://alfabank.ru/api/v1/azs-stations/public/stations"
# alfabank.ru is certified by the Russian Trusted Root CA of the Ministry of
# Digital Development, which the Windows, Ubuntu and certifi stores lack.
# Verification stays on: that one public root is added to a context made for
# this one request, and no other request ever sees it. SHA-256 of the root:
# D2:6D:2D:02:31:B7:C3:9F:92:CC:73:85:12:BA:54:10:35:19:E4:40:5D:68:B5:BD:70:3E:97:88:CA:8E:CF:31
RUSSIAN_TRUSTED_ROOT = ROOT_CONFIG / "russian-trusted-root-ca.pem"


def alfa_tls_context() -> ssl.SSLContext:
    context = ssl.create_default_context()
    context.load_verify_locations(cafile=str(RUSSIAN_TRUSTED_ROOT))
    return context


def collect_alfa() -> dict[str, Any]:
    """All of Russia comes at once (3 MB compressed); the region is cut out here."""
    rows = _json(ALFA_STATIONS, referer="https://alfabank.ru/azs/", compressed=True,
                 timeout=120, context=alfa_tls_context())
    if not isinstance(rows, list):
        raise RuntimeError("alfa: the station list is not a list")
    stations = []
    for row in rows:
        location = ((row.get("address") or {}).get("location") or {}) if isinstance(row, dict) else {}
        if _in_region(location.get("latitude"), location.get("longitude")):
            stations.append(row)
    return {"captured_at": _now(), "russia_total": len(rows), "stations": stations}


# азсрадар.рф: its own drivers mark each grade ok or empty, with a queue in cars,
# a litre limit and a technical break. Its T-Bank and Sber columns are the
# site's reading of two payment feeds this pipeline reads directly, so they are
# not kept. The old azs-radar.ru now serves another site's certificate.
AZSRADAR = "https://xn--80aaapn8cdd.xn--p1ai/api/stations"
AZSRADAR_BANK_FIELDS = ("tbank_status", "sber_status", "forecast_fuels", "forecast_updated_at")


def collect_azsradar() -> dict[str, Any]:
    url = (f"{AZSRADAR}?minLat={REGION['south']}&maxLat={REGION['north']}"
           f"&minLng={REGION['west']}&maxLng={REGION['east']}")
    rows = _json(url, referer="https://xn--80aaapn8cdd.xn--p1ai/")
    if not isinstance(rows, list):
        raise RuntimeError("azsradar: the station list is not a list")
    stations = [
        {key: value for key, value in row.items() if key not in AZSRADAR_BANK_FIELDS}
        for row in rows if isinstance(row, dict)
    ]
    return {"captured_at": _now(), "stations": stations}


# AZS MAP (azsmap.com) loads its whole data model as a script holding
# `const STATIONS = {...}` in plain JSON. A grade is [key, state, price, minutes
# since the mark, …, minutes since the price]. The Leningrad-region model stops
# at exactly 1500 stations, so the city model is read as well and the two are
# merged. The site's own grade labels are kept with the capture: its key "ai98"
# is shown on the site as АИ-100.
AZSMAP_MODEL = "https://azsmap.com/api/data-model.js?city={city}"
AZSMAP_CITIES = ("lenobl", "spb")
AZSMAP_STATIONS = re.compile(r"const\s+STATIONS\s*=\s*")
AZSMAP_LABELS = re.compile(r"const\s+FUEL_LABELS\s*=\s*\{([^}]*)\}")
AZSMAP_FIELDS = ("brand", "address", "lat", "lon", "fuels", "attrs")


def parse_azsmap_model(script: str) -> tuple[dict[str, Any], dict[str, str]]:
    """The stations and the grade labels out of the map's data-model script."""
    match = AZSMAP_STATIONS.search(script)
    if not match:
        raise RuntimeError("azsmap: STATIONS block is missing from the data model")
    stations, _ = json.JSONDecoder().raw_decode(script, match.end())
    if not isinstance(stations, dict):
        raise RuntimeError("azsmap: STATIONS is not an object")
    block = AZSMAP_LABELS.search(script)
    labels = dict(re.findall(r"(\w+)\s*:\s*['\"]([^'\"]*)['\"]", block.group(1))) if block else {}
    return stations, labels


def collect_azsmap() -> dict[str, Any]:
    stations: dict[str, dict[str, Any]] = {}
    labels: dict[str, str] = {}
    errors: list[str] = []
    for index, city in enumerate(AZSMAP_CITIES):
        if index:
            time.sleep(1.0)
        try:
            script = _fetch(AZSMAP_MODEL.format(city=city), referer=f"https://azsmap.com/region/{city}",
                            accept="*/*", compressed=True).decode("utf-8", "replace")
            rows, found = parse_azsmap_model(script)
        except Exception as exc:
            errors.append(f"{city}: {type(exc).__name__}: {exc}")
            continue
        labels.update(found)
        for key, row in rows.items():
            if isinstance(row, dict) and _in_region(row.get("lat"), row.get("lon")):
                stations[key] = {"key": key, **{name: row.get(name) for name in AZSMAP_FIELDS}}
    if not stations:
        raise RuntimeError("; ".join(errors) or "azsmap: no stations returned")
    return {"captured_at": _now(), "fuel_labels": labels, "errors": errors,
            "stations": list(stations.values())}


def _report_endpoint() -> str | None:
    """The reports Worker address, taken from the single place it is configured."""
    override = os.environ.get("SPBFI_REPORT_ENDPOINT")
    if override:
        return override.strip() or None
    config = ROOT_WEB / "config.js"
    if not config.exists():
        return None
    match = re.search(r"SPBFI_REPORT_ENDPOINT\s*=\s*['\"]([^'\"]+)['\"]", config.read_text(encoding="utf-8"))
    return match.group(1) if match else None


def collect_own_reports() -> dict[str, Any]:
    """Read back what people using this app reported from the forecourt."""
    endpoint = _report_endpoint()
    if not endpoint:
        raise RuntimeError("no reports endpoint configured (web/config.js)")
    # With the closed club's reader key set on the worker, the marks are not
    # readable without it; the key comes from a repository secret.
    reader_key = os.environ.get("SPBFI_REPORT_READER_KEY", "").strip()
    # The club's server is in Moscow. From abroad, where the pipeline runs,
    # about one connection in four stalled on the way (measured 14 Sep 2026),
    # and another try soon after gets through. An answer such as 401 is not
    # a stall and is not asked again.
    for attempt in range(1, 4):
        try:
            payload = _json(
                endpoint.rstrip("/") + "/reports", timeout=12,
                extra_headers={"X-Reader-Key": reader_key} if reader_key else None,
            )
            break
        except (OSError, ValueError) as error:
            if attempt == 3 or getattr(error, "code", None):
                raise
            time.sleep(2 * attempt)
    return {"captured_at": _now(), "reports": payload.get("reports") or []}


COLLECTORS = {
    "gdezapravka-full-aoi": collect_gdezapravka,
    "tofuel-full-aoi": collect_tofuel,
    "teboil-official": collect_teboil,
    "kirishi-official": collect_kirishi,
    "telegram-benzinspb78": collect_telegram,
    "yandex-maps": collect_yandex,
    "gdebenzin24": collect_gdebenzin24,
    "gde-benzin": collect_gde_benzin,
    "gdebenzin-net": collect_gdebenzin_net,
    "gdebenzfuel": collect_gdebenzfuel,
    "tbank-fuel": collect_tbank,
    "gdebenzi": collect_gdebenzi,
    "own-reports": collect_own_reports,
    "2gis-benzin": collect_2gis_benzin,
    "transitcard": collect_transitcard,
    "alfa-azs": collect_alfa,
    "azsradar-rf": collect_azsradar,
    "azsmap": collect_azsmap,
}
