"""Collect official Gazpromneft stock for the configured SPB/LO AOI."""

from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


LIST_URL = "https://gpnbonus.ru/api/stations/list"
DETAIL_URL = "https://gpnbonus.ru/api/stations/{station_id}"
AOI = {"west": 29.50, "south": 59.60, "east": 31.10, "north": 60.35}
HEADERS = {
    "Accept": "application/json",
    "Content-Type": "application/json",
    "Referer": "https://gpnbonus.ru/fuel/refuel-map",
    "User-Agent": "Mozilla/5.0 Chrome/140 Safari/537.36",
}


def post_json(url: str, *, attempts: int = 3, timeout: int = 35) -> tuple[dict, int]:
    last_error: Exception | None = None
    for attempt in range(attempts):
        request = Request(url, data=b"{}", headers=HEADERS, method="POST")
        try:
            with urlopen(request, timeout=timeout) as response:
                return json.loads(response.read().decode("utf-8")), response.status
        except (HTTPError, URLError, TimeoutError, json.JSONDecodeError) as exc:
            last_error = exc
            if isinstance(exc, HTTPError) and exc.code not in {429, 502, 503, 504}:
                break
            time.sleep(0.8 * (attempt + 1))
    raise RuntimeError(f"{url}: {last_error}")


def in_aoi(station: dict) -> bool:
    try:
        lat, lon = float(station["latitude"]), float(station["longitude"])
    except (KeyError, TypeError, ValueError):
        return False
    return AOI["south"] <= lat <= AOI["north"] and AOI["west"] <= lon <= AOI["east"]


def collect_detail(station: dict) -> dict:
    body, status = post_json(DETAIL_URL.format(station_id=station["GPNAZSID"]))
    return {"station": station, "fuel_detail": body, "http_status": status}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--workers", type=int, default=5)
    args = parser.parse_args()

    started = datetime.now(timezone.utc)
    # The WAF silently drops connections from data-centre addresses instead of
    # answering, so a long retry ladder here only burns runner minutes.
    listing, list_status = post_json(LIST_URL, attempts=2, timeout=20)
    stations = sorted((row for row in listing.get("stations", []) if in_aoi(row)), key=lambda row: str(row["GPNAZSID"]))
    details: list[dict] = []
    errors: list[dict] = []
    with ThreadPoolExecutor(max_workers=max(1, min(args.workers, 6))) as pool:
        futures = {pool.submit(collect_detail, station): station for station in stations}
        for future in as_completed(futures):
            station = futures[future]
            try:
                details.append(future.result())
            except Exception as exc:  # one station must not discard the AOI batch
                errors.append({"station_id": str(station.get("GPNAZSID")), "error": str(exc)})

    details.sort(key=lambda row: str(row["station"]["GPNAZSID"]))
    captured_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    payload = {
        "schema_version": 1,
        "captured_at": captured_at,
        "elapsed_seconds": round((datetime.now(timezone.utc) - started).total_seconds(), 2),
        "aoi": AOI,
        "list_http_status": list_status,
        "list_station_count": len(listing.get("stations", [])),
        "aoi_station_count": len(stations),
        "detail_success_count": len(details),
        "details": details,
        "errors": errors,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    temporary = args.output.with_suffix(args.output.suffix + ".next")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, args.output)
    print(f"Gazpromneft official: {len(details)}/{len(stations)} AOI details, {payload['elapsed_seconds']}s")
    return 0 if details and len(details) >= max(1, int(len(stations) * 0.8)) else 2


if __name__ == "__main__":
    raise SystemExit(main())
