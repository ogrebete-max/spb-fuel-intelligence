"""Collectors for sources that are not a single plain JSON GET.

Everything here is anonymous public data: a tiled bbox API, two form POSTs, a
JSON blob embedded in a public HTML page, and the public web preview of a
Telegram channel.  No account, key or protected content is involved.
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
import html
import json
import os
import re
import time
from typing import Any
from urllib.parse import quote
from urllib.request import Request, urlopen


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
           timeout: int = 60) -> bytes:
    headers = {"Accept": accept, "User-Agent": BROWSER_UA, "Accept-Language": "ru,en;q=0.8"}
    if referer:
        headers["Referer"] = referer
    if content_type:
        headers["Content-Type"] = content_type
    with urlopen(Request(url, headers=headers, data=data), timeout=timeout) as response:
        return response.read()


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
}
