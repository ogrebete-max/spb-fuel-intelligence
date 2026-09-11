"""Dependency-free local HTTP server for SPB Fuel Intelligence."""

from __future__ import annotations

import argparse
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import mimetypes
from pathlib import Path
import subprocess
import sys
import threading
import time
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, unquote, urlencode, urlparse
from urllib.request import Request, urlopen

from .repository import StationRepository


ROOT = Path(__file__).resolve().parents[1]
WEB_ROOT = ROOT / "web"
DATA_PATH = ROOT / "data" / "stations.json"
HISTORY_PATH = ROOT / "data" / "history.json"
REFRESH_SCRIPT = ROOT / "scripts" / "refresh_live.py"
REFRESH_COOLDOWN_SECONDS = 4 * 60
GEOCODE_ENDPOINT = "https://nominatim.openstreetmap.org/search"
AOI = {"west": 29.50, "south": 59.60, "east": 31.10, "north": 60.35}
# Small, transparent safety net for the first local release.  It is used only
# when the public geocoder is unavailable on the user's network; it never
# pretends to be a precise house-level geocoding result.
LOCAL_PLACE_FALLBACKS = {
    "уточкина": {"label": "ул. Уточкина, Приморский район (приблизительный центр улицы)", "lat": 60.0084, "lon": 30.2570},
}


def _number(value: str | None, *, integer: bool = False):
    if value in (None, ""):
        return None
    return int(value) if integer else float(value)


class AppHandler(BaseHTTPRequestHandler):
    repository: StationRepository
    refresh_lock = threading.Lock()
    last_refresh_monotonic = 0.0
    geocode_lock = threading.Lock()
    geocode_last_monotonic = 0.0
    geocode_cache: dict[str, dict] = {}

    def log_message(self, fmt: str, *args) -> None:
        print(f"{self.address_string()} - {fmt % args}")

    def _json(self, payload, status: HTTPStatus = HTTPStatus.OK) -> None:
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def _error(self, status: HTTPStatus, message: str) -> None:
        self._json({"error": message, "status": status.value}, status)

    @classmethod
    def _geocode(cls, query: str) -> dict:
        """One explicit place search, cached and globally throttled for Nominatim."""
        normalized = " ".join(query.split()).strip()
        if len(normalized) < 3:
            raise ValueError("Введите не менее трёх символов адреса или названия места")
        if len(normalized) > 160:
            raise ValueError("Слишком длинный запрос")
        cache_key = normalized.casefold()
        with cls.geocode_lock:
            cached = cls.geocode_cache.get(cache_key)
            if cached:
                return cached
            pause = 1.05 - (time.monotonic() - cls.geocode_last_monotonic)
            if pause > 0:
                time.sleep(pause)
            params = urlencode({
                "q": f"{normalized}, Санкт-Петербург",
                "format": "jsonv2",
                "limit": 1,
                "countrycodes": "ru",
                "bounded": 1,
                "viewbox": f"{AOI['west']},{AOI['north']},{AOI['east']},{AOI['south']}",
                "addressdetails": 0,
            })
            request = Request(
                f"{GEOCODE_ENDPOINT}?{params}",
                headers={
                    "Accept": "application/json",
                    "User-Agent": "SPB-Fuel-Intelligence/0.1 (personal station finder)",
                },
            )
            try:
                with urlopen(request, timeout=12) as response:
                    rows = json.loads(response.read().decode("utf-8"))
            except (HTTPError, URLError, TimeoutError, json.JSONDecodeError) as exc:
                fallback = next((value for token, value in LOCAL_PLACE_FALLBACKS.items() if token in cache_key), None)
                if fallback:
                    result = {"query": normalized, "label": fallback["label"], "location": {"lat": fallback["lat"], "lon": fallback["lon"]}, "precision": "street_approximate"}
                    cls.geocode_cache[cache_key] = result
                    return result
                raise RuntimeError("Сервис поиска места временно недоступен. Переместите карту и нажмите «Искать в этой области».") from exc
            finally:
                cls.geocode_last_monotonic = time.monotonic()
            if not rows:
                raise LookupError("Место не найдено в Санкт-Петербурге и ближайшей области")
            row = rows[0]
            try:
                location = {"lat": float(row["lat"]), "lon": float(row["lon"])}
            except (KeyError, TypeError, ValueError) as exc:
                raise LookupError("Сервис поиска вернул неполный ответ") from exc
            if not (AOI["south"] <= location["lat"] <= AOI["north"] and AOI["west"] <= location["lon"] <= AOI["east"]):
                raise LookupError("Место находится вне зоны Санкт-Петербурга и ближайшей области")
            result = {"query": normalized, "label": row.get("display_name") or normalized, "location": location}
            cls.geocode_cache[cache_key] = result
            return result

    def _serve_static(self, request_path: str) -> None:
        relative = request_path.lstrip("/") or "index.html"
        path = (WEB_ROOT / relative).resolve()
        if WEB_ROOT.resolve() not in path.parents and path != WEB_ROOT.resolve():
            self._error(HTTPStatus.FORBIDDEN, "Forbidden")
            return
        if not path.is_file():
            path = WEB_ROOT / "index.html"
        content = path.read_bytes()
        mime = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        if mime.startswith("text/") or mime in {"application/javascript", "application/json"}:
            mime += "; charset=utf-8"
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(content)

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        path = unquote(parsed.path)
        params = {key: values[-1] for key, values in parse_qs(parsed.query).items()}
        try:
            if path == "/api/health":
                self._json({"ok": True, "stations": len(self.repository.stations)})
                return
            if path == "/api/meta":
                self._json(self.repository.meta())
                return
            if path == "/api/sources":
                self._json(self.repository.sources())
                return
            if path == "/api/geocode":
                self._json(self._geocode(params.get("q", "")))
                return
            if path == "/api/stations":
                bbox = tuple(float(value) for value in params["bbox"].split(",")) if params.get("bbox") else None
                if bbox and len(bbox) != 4:
                    raise ValueError("bbox must be west,south,east,north")
                lat, lon = _number(params.get("lat")), _number(params.get("lon"))
                center = {"lat": lat, "lon": lon} if lat is not None and lon is not None else None
                statuses = set(filter(None, params.get("status", "").split(","))) or None
                payload = self.repository.query(
                    grade=params.get("grade", "AI95"), statuses=statuses, bbox=bbox,
                    center=center, radius_km=_number(params.get("radius_km")),
                    search=params.get("q"), area=params.get("area"), sort=params.get("sort", "status"),
                    timeline=params.get("timeline"),
                    limit=min(_number(params.get("limit"), integer=True) or 250, 1000),
                    offset=max(_number(params.get("offset"), integer=True) or 0, 0), as_of=params.get("as_of"),
                )
                self._json(payload)
                return
            if path.startswith("/api/stations/"):
                station_id = path.removeprefix("/api/stations/")
                detail = self.repository.detail(station_id, as_of=params.get("as_of"))
                if detail is None:
                    self._error(HTTPStatus.NOT_FOUND, "Station not found")
                else:
                    self._json(detail)
                return
            if path.startswith("/api/"):
                self._error(HTTPStatus.NOT_FOUND, "API route not found")
                return
            self._serve_static(path)
        except (ValueError, TypeError, LookupError) as exc:
            self._error(HTTPStatus.BAD_REQUEST, str(exc))
        except RuntimeError as exc:
            self._error(HTTPStatus.BAD_GATEWAY, str(exc))
        except BrokenPipeError:
            pass

    def do_POST(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path != "/api/refresh":
            self._error(HTTPStatus.NOT_FOUND, "API route not found")
            return
        # A custom same-origin header prevents an unrelated web page from
        # silently triggering network fetches against this localhost server.
        if self.headers.get("X-SPBFI-Action") != "refresh":
            self._error(HTTPStatus.FORBIDDEN, "Missing refresh confirmation header")
            return
        if not self.refresh_lock.acquire(blocking=False):
            self._error(HTTPStatus.CONFLICT, "Обновление уже выполняется")
            return
        attempted = False
        try:
            elapsed = time.monotonic() - type(self).last_refresh_monotonic
            if type(self).last_refresh_monotonic and elapsed < REFRESH_COOLDOWN_SECONDS:
                wait_seconds = max(1, round(REFRESH_COOLDOWN_SECONDS - elapsed))
                self._error(HTTPStatus.TOO_MANY_REQUESTS, f"Повторное обновление доступно через {wait_seconds} сек.")
                return
            attempted = True
            # The same collector the scheduled job runs, so the local button and
            # the published snapshot can never drift apart.
            completed = subprocess.run(
                [sys.executable, str(REFRESH_SCRIPT)],
                cwd=ROOT,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=240,
                check=False,
            )
            if completed.returncode != 0:
                tail = "\n".join((completed.stdout + "\n" + completed.stderr).splitlines()[-12:])
                self._json({"ok": False, "error": "Не удалось обновить источники", "details": tail}, HTTPStatus.BAD_GATEWAY)
                return
            self.repository.reload()
            self._json({"ok": True, "meta": self.repository.meta()})
        except subprocess.TimeoutExpired:
            self._error(HTTPStatus.GATEWAY_TIMEOUT, "Источники не ответили за 4 минуты")
        finally:
            if attempted:
                type(self).last_refresh_monotonic = time.monotonic()
            self.refresh_lock.release()


def main() -> int:
    parser = argparse.ArgumentParser(description="Run SPB Fuel Intelligence locally")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    if not DATA_PATH.exists():
        raise SystemExit("data/stations.json is missing; run scripts/build_snapshot.py")
    AppHandler.repository = StationRepository(DATA_PATH, HISTORY_PATH)
    server = ThreadingHTTPServer((args.host, args.port), AppHandler)
    print(f"SPB Fuel Intelligence: http://{args.host}:{args.port}")
    print(f"Stations: {len(AppHandler.repository.stations)}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
