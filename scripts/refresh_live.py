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
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = ROOT / "data" / "live"
AOI_WSEN = "29.50,59.60,31.10,60.35"
AOI_SWNE = "59.60,29.50,60.35,31.10"
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
)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def fetch_one(name: str, url: str, referer: str) -> dict[str, Any]:
    started = datetime.now(timezone.utc)
    target = OUT_DIR / f"{name}.json"
    temporary = target.with_suffix(".next.json")
    headers = {"Accept": "application/json", "Referer": referer, "User-Agent": "Mozilla/5.0 Chrome/140 Safari/537.36"}
    try:
        request = Request(url, headers=headers)
        with urlopen(request, timeout=75) as response:
            body = response.read()
            status = getattr(response, "status", 200)
        parsed = json.loads(body.decode("utf-8"))
        temporary.write_text(json.dumps(parsed, ensure_ascii=False), encoding="utf-8")
        temporary.replace(target)
        return {"name": name, "ok": True, "http_status": status, "bytes": len(body), "captured_at": now_iso(), "elapsed_ms": round((datetime.now(timezone.utc) - started).total_seconds() * 1000), "error": None}
    except (HTTPError, URLError, TimeoutError, OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        temporary.unlink(missing_ok=True)
        return {"name": name, "ok": False, "http_status": getattr(exc, "code", 0), "bytes": target.stat().st_size if target.exists() else 0, "captured_at": now_iso(), "elapsed_ms": round((datetime.now(timezone.utc) - started).total_seconds() * 1000), "error": str(exc)}


def collect_gpn() -> dict[str, Any]:
    started = datetime.now(timezone.utc)
    target = OUT_DIR / "gpn-official.json"
    completed = subprocess.run([sys.executable, str(ROOT / "scripts" / "collect_gpn.py"), "--output", str(target)], cwd=ROOT, capture_output=True, text=True, check=False)
    return {"name": "gpn-official", "ok": completed.returncode == 0 and target.exists(), "http_status": 200 if completed.returncode == 0 else "partial_or_failed", "bytes": target.stat().st_size if target.exists() else 0, "captured_at": now_iso(), "elapsed_ms": round((datetime.now(timezone.utc) - started).total_seconds() * 1000), "error": None if completed.returncode == 0 else (completed.stderr or completed.stdout)[-800:]}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--skip-build", action="store_true")
    args = parser.parse_args()
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    rows: list[dict[str, Any]] = []
    with ThreadPoolExecutor(max_workers=5) as pool:
        futures = [pool.submit(fetch_one, *item) for item in ENDPOINTS]
        for future in as_completed(futures):
            rows.append(future.result())
    rows.append(collect_gpn())
    rows.sort(key=lambda item: item["name"])
    (OUT_DIR / "full-aoi-probe-results.json").write_text(json.dumps(rows, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    success = sum(1 for row in rows if row["ok"])
    print(f"Completed: {success}/{len(rows)} endpoints")
    if success == 0:
        return 2
    if not args.skip_build:
        for script in ("build_snapshot.py", "update_history.py"):
            completed = subprocess.run([sys.executable, str(ROOT / "scripts" / script)], cwd=ROOT, check=False)
            if completed.returncode:
                return completed.returncode
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
