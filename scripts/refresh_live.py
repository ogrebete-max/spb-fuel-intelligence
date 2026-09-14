"""Portable public-source refresh for GitHub Actions and local Python."""

from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import subprocess
import sys
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from collectors import COLLECTORS  # noqa: E402

OUT_DIR = ROOT / "data" / "live"
AOI_WSEN = "29.50,59.60,31.10,60.35"
AOI_SWNE = "59.60,29.50,60.35,31.10"
BROWSER_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"
)
ENDPOINTS = (
    ("sber-full-aoi", f"https://sberazs.ru/api/stations?bbox={AOI_WSEN}", "https://sberazs.ru/"),
    # gdebenz.org is a live mirror of the same service; it is tried only when
    # the primary host fails, so a single bad host does not cost a whole
    # provenance cluster for that refresh.
    ("gdebenz-full-aoi", (
        "https://gdebenz.ru/api/stations?lat1=59.60&lon1=29.50&lat2=60.35&lon2=31.10",
        "https://gdebenz.org/api/stations?lat1=59.60&lon1=29.50&lat2=60.35&lon2=31.10",
    ), "https://gdebenz.ru/"),
    ("benzas-full-aoi", "https://benzas.ru/api/stations?lat1=59.60&lon1=29.50&lat2=60.35&lon2=31.10", "https://benzas.ru/"),
    ("benzas-comments-full-aoi", "https://benzas.ru/api/comments?lat1=59.60&lon1=29.50&lat2=60.35&lon2=31.10", "https://benzas.ru/"),
    ("benzinest-full-aoi", f"https://benzinest.ru/api/stations?bbox={AOI_SWNE}", "https://benzinest.ru/"),
    ("tutbenz-full-aoi", f"https://tutbenz.app/api/stations?bbox={AOI_WSEN}&prices=1", "https://tutbenz.app/"),
    ("gdebenzin-full-aoi", f"https://xn--90addebmh2bc.xn--p1ai/api/v1/map?bbox={AOI_SWNE}&zoom=10&price=1&confidence=1", "https://xn--90addebmh2bc.xn--p1ai/"),
    ("benzonavt-full-aoi", f"https://benzonavt.ru/api/v1/stations?bbox={AOI_SWNE}", "https://benzonavt.ru/"),
    ("toplivo-data", "https://tboo.ru/gpn/data.json", "https://tboo.ru/gpn/"),
    ("toplivo-predict", "https://tboo.ru/gpn/predict.json", "https://tboo.ru/gpn/"),
    ("benzinradar-full-aoi", "https://benzinradar.ru/api/stations?lat1=59.60&lon1=29.50&lat2=60.35&lon2=31.10", "https://benzinradar.ru/"),
    ("tatneft-azs", "https://api2.gs.tatneft.ru/api/v2/azs/", "https://azs.tatneft.ru/"),
    ("tatneft-fuel-types", "https://api2.gs.tatneft.ru/api/v2/azs/fuel_types/", "https://azs.tatneft.ru/"),
    ("rosneft-stations", "https://rosneft-azs.ru/front-api/stations", "https://rosneft-azs.ru/"),
    ("lukoil-search", "https://auto.lukoil.ru/api/cartography/GetSearchObjects?form=gasStation", "https://auto.lukoil.ru/"),
)
# A source that legitimately answers with nothing for the AOI must not look
# like a broken collector, so an empty payload is reported separately.
MIN_BYTES = 200
# Feeds that are legitimately tiny when nothing has happened: an empty list of
# eyewitness reports is a healthy answer, not a broken collector.
MAY_BE_EMPTY = {"own-reports"}

# Nobody is served by asking a source for data faster than that data changes.
# Yandex signals are two hours old at the median, and one pass over it costs a
# hundred and ten page requests, so polling it every ten minutes would mean
# fifteen thousand requests a day to learn nothing new. Anything not listed
# here is a single cheap request and is refreshed every run.
MIN_INTERVAL_SECONDS = {
    "yandex-maps": 30 * 60,
    "gdebenzfuel": 20 * 60,
    "tbank-fuel": 20 * 60,
    "telegram-benzinspb78": 15 * 60,
    # All of Russia in one 3 MB answer; its statuses move with card payments,
    # so every other ten-minute run is enough.
    "alfa-azs": 15 * 60,
    "lukoil-search": 6 * 3600,
    "rosneft-stations": 3600,
    "tatneft-azs": 3600,
    "tatneft-fuel-types": 12 * 3600,
    "teboil-official": 6 * 3600,
    "kirishi-official": 3600,
    "benzinradar-full-aoi": 3600,
}


def _seconds_since_capture(name: str) -> float | None:
    """Age of the stored payload for one source, or None when there is none."""
    target = OUT_DIR / f"{name}.json"
    if not target.exists():
        return None
    try:
        payload = json.loads(target.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    stamp = payload.get("captured_at") if isinstance(payload, dict) else None
    if stamp:
        try:
            captured = datetime.fromisoformat(str(stamp).replace("Z", "+00:00"))
        except ValueError:
            captured = None
        if captured:
            return (datetime.now(timezone.utc) - captured).total_seconds()
    return max(0.0, datetime.now(timezone.utc).timestamp() - target.stat().st_mtime)


def _skip_result(name: str, age: float) -> dict[str, Any]:
    target = OUT_DIR / f"{name}.json"
    return {
        "name": name, "ok": True, "http_status": "cached", "skipped": True,
        "bytes": target.stat().st_size if target.exists() else 0,
        "captured_at": now_iso(), "elapsed_ms": 0, "age_seconds": round(age),
        "error": None,
    }


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _result(name: str, started: datetime, *, ok: bool, status: Any, size: int, error: str | None) -> dict[str, Any]:
    return {
        "name": name, "ok": ok, "http_status": status, "bytes": size,
        "captured_at": now_iso(),
        "elapsed_ms": round((datetime.now(timezone.utc) - started).total_seconds() * 1000),
        "error": error,
    }


def _write_atomic(target: Path, payload: Any) -> int:
    temporary = target.with_suffix(".next.json")
    text = json.dumps(payload, ensure_ascii=False)
    temporary.write_text(text, encoding="utf-8")
    temporary.replace(target)
    return len(text.encode("utf-8"))


def fetch_one(name: str, url: str | tuple[str, ...], referer: str) -> dict[str, Any]:
    started = datetime.now(timezone.utc)
    target = OUT_DIR / f"{name}.json"
    temporary = target.with_suffix(".next.json")
    headers = {"Accept": "application/json", "Referer": referer, "User-Agent": BROWSER_UA}
    candidates = (url,) if isinstance(url, str) else tuple(url)
    failures: list[str] = []
    last_status: Any = 0
    for candidate in candidates:
        try:
            request = Request(candidate, headers=headers)
            with urlopen(request, timeout=75) as response:
                body = response.read()
                last_status = getattr(response, "status", 200)
            parsed = json.loads(body.decode("utf-8"))
            size = _write_atomic(target, parsed)
            if size < MIN_BYTES:
                failures.append(f"{candidate}: empty payload")
                continue
            return _result(name, started, ok=True, status=last_status, size=size, error=None)
        except (HTTPError, URLError, TimeoutError, OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
            temporary.unlink(missing_ok=True)
            last_status = getattr(exc, "code", 0)
            failures.append(f"{candidate}: {exc}")
    return _result(name, started, ok=False, status=last_status,
                   size=target.stat().st_size if target.exists() else 0, error="; ".join(failures))


def run_collector(name: str) -> dict[str, Any]:
    started = datetime.now(timezone.utc)
    target = OUT_DIR / f"{name}.json"
    try:
        size = _write_atomic(target, COLLECTORS[name]())
        enough = size >= MIN_BYTES or name in MAY_BE_EMPTY
        return _result(name, started, ok=enough, status=200, size=size,
                       error=None if enough else "empty payload")
    except Exception as exc:  # a single upstream must not abort the refresh
        # An optional collector that has not been set up is not a failure, and
        # must not sit in the health banner looking like a broken source.
        if "no reports endpoint configured" in str(exc):
            return _result(name, started, ok=True, status="off", size=0, error=None) | {"disabled": True}
        return _result(name, started, ok=False, status=0,
                       size=target.stat().st_size if target.exists() else 0, error=f"{type(exc).__name__}: {exc}")


def collect_gpn() -> dict[str, Any]:
    started = datetime.now(timezone.utc)
    target = OUT_DIR / "gpn-official.json"
    completed = subprocess.run(
        [sys.executable, str(ROOT / "scripts" / "collect_gpn.py"), "--output", str(target)],
        cwd=ROOT, capture_output=True, text=True, check=False,
    )
    ok = completed.returncode == 0 and target.exists()
    if not ok and os.environ.get("GITHUB_ACTIONS"):
        # gpnbonus.ru silently drops connections from GitHub's address ranges;
        # the same feed arrives through the tboo.ru relay. The attempt is kept
        # so an unblock would be noticed, but a block is the expected state
        # here and must not read as a source that broke.
        return _result("gpn-official", started, ok=True, status="off", size=0, error=None) | {
            "disabled": True,
            "note": "gpnbonus.ru не отвечает с серверов GitHub; те же данные приходят через ретранслятор tboo.ru/gpn",
        }
    return _result(
        "gpn-official", started, ok=ok, status=200 if ok else "partial_or_failed",
        size=target.stat().st_size if target.exists() else 0,
        error=None if ok else (completed.stderr or completed.stdout or "").strip()[-800:],
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--skip-build", action="store_true")
    args = parser.parse_args()
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    rows: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []

    def due(name: str) -> bool:
        interval = MIN_INTERVAL_SECONDS.get(name)
        if not interval:
            return True
        age = _seconds_since_capture(name)
        if age is None or age >= interval:
            return True
        skipped.append(_skip_result(name, age))
        return False

    with ThreadPoolExecutor(max_workers=6) as pool:
        futures = [pool.submit(fetch_one, *item) for item in ENDPOINTS if due(item[0])]
        futures += [pool.submit(run_collector, name) for name in COLLECTORS if due(name)]
        if due("gpn-official"):
            futures.append(pool.submit(collect_gpn))
        for future in as_completed(futures):
            rows.append(future.result())
    rows.extend(skipped)
    rows.sort(key=lambda item: item["name"])
    (OUT_DIR / "full-aoi-probe-results.json").write_text(
        json.dumps(rows, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    for row in rows:
        mark = "off " if row.get("disabled") else "kept" if row.get("skipped") else "ok  " if row["ok"] else "FAIL"
        detail = "" if row["ok"] else "  " + " ".join(str(row["error"]).split())[:600]
        print(f"{mark} {row['name']:26} http={row['http_status']!s:>18} {row['bytes']:>9} B {row['elapsed_ms']:>6} ms{detail}")
    success = sum(1 for row in rows if row["ok"])
    print(f"Completed: {success}/{len(rows)} sources")
    if success == 0:
        return 2
    if not args.skip_build:
        stages: tuple[tuple[str, list[str]], ...] = (
            ("build_snapshot.py", ["--raw-dir", str(OUT_DIR), "--output", str(ROOT / "data" / "stations.json")]),
            ("update_history.py", []),
        )
        for script, extra in stages:
            completed = subprocess.run([sys.executable, str(ROOT / "scripts" / script), *extra], cwd=ROOT, check=False)
            if completed.returncode:
                return completed.returncode
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
