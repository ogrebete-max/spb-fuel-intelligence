"""Portable public-source refresh for GitHub Actions and local Python."""

from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
import json
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
    ("gdebenz-full-aoi", "https://gdebenz.ru/api/stations?lat1=59.60&lon1=29.50&lat2=60.35&lon2=31.10", "https://gdebenz.ru/"),
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


def fetch_one(name: str, url: str, referer: str) -> dict[str, Any]:
    started = datetime.now(timezone.utc)
    target = OUT_DIR / f"{name}.json"
    temporary = target.with_suffix(".next.json")
    headers = {"Accept": "application/json", "Referer": referer, "User-Agent": BROWSER_UA}
    try:
        request = Request(url, headers=headers)
        with urlopen(request, timeout=75) as response:
            body = response.read()
            status = getattr(response, "status", 200)
        parsed = json.loads(body.decode("utf-8"))
        size = _write_atomic(target, parsed)
        return _result(name, started, ok=size >= MIN_BYTES, status=status, size=size,
                       error=None if size >= MIN_BYTES else "empty payload")
    except (HTTPError, URLError, TimeoutError, OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        temporary.unlink(missing_ok=True)
        return _result(name, started, ok=False, status=getattr(exc, "code", 0),
                       size=target.stat().st_size if target.exists() else 0, error=str(exc))


def run_collector(name: str) -> dict[str, Any]:
    started = datetime.now(timezone.utc)
    target = OUT_DIR / f"{name}.json"
    try:
        size = _write_atomic(target, COLLECTORS[name]())
        return _result(name, started, ok=size >= MIN_BYTES, status=200, size=size,
                       error=None if size >= MIN_BYTES else "empty payload")
    except Exception as exc:  # a single upstream must not abort the refresh
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
    with ThreadPoolExecutor(max_workers=6) as pool:
        futures = [pool.submit(fetch_one, *item) for item in ENDPOINTS]
        futures += [pool.submit(run_collector, name) for name in COLLECTORS]
        futures.append(pool.submit(collect_gpn))
        for future in as_completed(futures):
            rows.append(future.result())
    rows.sort(key=lambda item: item["name"])
    (OUT_DIR / "full-aoi-probe-results.json").write_text(
        json.dumps(rows, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    for row in rows:
        mark = "ok  " if row["ok"] else "FAIL"
        detail = "" if row["ok"] else f"  {str(row['error'])[:140]}"
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
