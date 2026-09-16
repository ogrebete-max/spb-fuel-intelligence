"""Measure: how many Yandex Maps stations the collector's requests reach.

A Yandex Maps search page lists at most 25 stations whatever the zoom, and
neither `page` nor `results` brings more (16 Sep 2026). The collector
(scripts/collectors.py, collect_yandex) therefore asks from many sides. This
script asks a wider pool once, gently, and says what the collector's own
requests miss.

Pool
    views     the 110-point grid the collector used before 16 Sep 2026
              (z=14, «АЗС» around each point)
    searches  «АЗС <chain>» for 10 chains and «АЗС <district> район» for the
              18 districts of St Petersburg, without a map point

Output
    stations the pool reached, what the collector's requests reach, and the
    fewest pool requests (greedy) that reach all of it. Measured twice on
    16 Sep 2026, two hours apart: 571 and 570 stations, the old grid 488, the
    77 requests now in the collector all of them both times.

Usage
    python yandex-coverage.py [--save pool.json]
"""

from __future__ import annotations

import argparse
import html
import json
from pathlib import Path
import re
import sys
import time
from urllib.parse import quote
from urllib.request import Request, urlopen

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))
from collectors import BROWSER_UA, yandex_requests  # noqa: E402

BASE = "https://yandex.ru/maps/2/saint-petersburg/search/"
STATE = re.compile(r'<script type="application/json" class="state-view">(.*?)</script>', re.S)
LONS = (29.70, 29.81, 29.93, 30.04, 30.16, 30.27, 30.39, 30.50, 30.62, 30.73, 30.85)
LATS = (59.66, 59.71, 59.77, 59.82, 59.88, 59.93, 59.99, 60.04, 60.10, 60.15)
CHAINS = ("Лукойл", "Роснефть", "Газпромнефть", "Татнефть", "Teboil", "ПТК", "Сургутнефтегаз",
          "Киришиавтосервис", "Кинеф", "Опти")
DISTRICTS = ("Адмиралтейский", "Василеостровский", "Выборгский", "Калининский", "Кировский", "Колпинский",
             "Красногвардейский", "Красносельский", "Кронштадтский", "Курортный", "Московский", "Невский",
             "Петроградский", "Петродворцовый", "Приморский", "Пушкинский", "Фрунзенский", "Центральный")


def pool() -> list[tuple[str, str]]:
    views = [(f"{lon},{lat}", f"{BASE}{quote('АЗС')}/?ll={lon:.4f}%2C{lat:.4f}&z=14") for lat in LATS for lon in LONS]
    texts = [f"АЗС {chain}" for chain in CHAINS] + [f"АЗС {district} район" for district in DISTRICTS]
    return views + [(text, f"{BASE}{quote(text)}/") for text in texts]


def stations_on(url: str) -> list[str]:
    request = Request(url, headers={"User-Agent": BROWSER_UA, "Accept": "text/html", "Accept-Language": "ru,en;q=0.8"})
    with urlopen(request, timeout=60) as response:
        page = response.read().decode("utf-8", "replace")
    if "showcaptcha" in page:
        raise RuntimeError("captcha")
    match = STATE.search(page)
    if not match:
        return []
    state = json.loads(html.unescape(match.group(1)))
    items = [item for stack in state.get("stack", []) for item in ((stack.get("results") or {}).get("items") or [])]
    return [str(item.get("id")) for item in items if item.get("fuelAvailability") and len(item.get("coordinates") or []) == 2]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--save", type=Path, help="write every request and the stations it returned")
    args = parser.parse_args()

    requests = dict(pool())
    requests.update(yandex_requests())
    reached: dict[str, set[str]] = {}
    for index, (label, url) in enumerate(requests.items()):
        if index:
            time.sleep(1.2)
        try:
            reached[label] = set(stations_on(url))
        except Exception as exc:  # noqa: BLE001 - one failed page is reported, not fatal
            print(f"{label}: {type(exc).__name__}: {exc}", file=sys.stderr)
            if "captcha" in str(exc):
                break
    everything = set().union(*reached.values()) if reached else set()
    ours = set().union(*[reached.get(label, set()) for label, _ in yandex_requests()])
    grid = set().union(*[reached.get(label, set()) for label, _ in pool()[:len(LONS) * len(LATS)]])
    chosen, covered, left = [], set(), dict(reached)
    while covered != everything:
        best = max(left, key=lambda label: len(left[label] - covered))
        chosen.append(best)
        covered |= left.pop(best)
    print(json.dumps({
        "requests_asked": len(reached),
        "stations_reached_by_all": len(everything),
        "collector_requests": len(yandex_requests()),
        "collector_reaches": len(ours),
        "collector_misses": len(everything - ours),
        "old_grid_reaches": len(grid),
        "fewest_requests_for_all": len(chosen),
        "fewest_requests": chosen,
    }, ensure_ascii=False, indent=1))
    if args.save:
        args.save.write_text(json.dumps({label: sorted(ids) for label, ids in reached.items()}, ensure_ascii=False), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
