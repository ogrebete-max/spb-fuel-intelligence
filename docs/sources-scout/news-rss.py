#!/usr/bin/env python3
"""Prototype: regional news RSS for SPb and Leningrad oblast, filtered to fuel items.

One plain GET per public feed, no key, no session.  Fuel items get the same
mention extraction as telegram-channels.py (districts, brands, grades,
highways, addresses, limits, queues, closures), so both prototypes return the
same shape of hints.

    python news-rss.py                               # default feeds, proxy env
    python news-rss.py --direct                      # ignore HTTPS_PROXY
    python news-rss.py --feeds 47news,fontanka --save news-rss.json
    python news-rss.py --all-items --max-text 300

A feed item carries a title and a short lead.  Station-level detail, when a
newsroom has it, sits in the article body, which this prototype does not fetch.
"""

from __future__ import annotations

import argparse
import html
import importlib.util
import json
import re
import sys
import time
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from typing import Any
from urllib.request import ProxyHandler, Request, build_opener

HERE = Path(__file__).resolve().parent
BROWSER_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"
)
MOSCOW = timezone(timedelta(hours=3))
FEEDS = {
    "47news": "https://47news.ru/rss/",
    "fontanka": "https://fontanka.ru/rss-feeds/rss.xml",
    "mr7": "https://mr-7.ru/feed/rss",
    "lenobl": "https://lenobl.ru/rss/",
    # Checked on 14.09.2026 and left out of the default run.  asmap posts
    # fuel-card limits for whole networks, nothing regional; the others carry
    # next to no regional fuel items (federal news or top stories only).
    "asmap": "https://www.asmap-service.ru/news/rss/",
    "kp_spb": "https://www.spb.kp.ru/rss/allsections.xml",
    "lenta": "https://lenta.ru/rss/news",
    "bezformata_spb": "https://sanktpeterburg.bezformata.com/rsstop.xml",
}
DEFAULT_FEEDS = ("47news", "fontanka", "mr7", "lenobl")
FUEL = re.compile(r"бензин|(?<!био)топлив|\bАЗС\b|заправ|дизел|АИ-?9[258]|дефицит|нефтепродукт|\bГСМ\b", re.I)


def _sibling(module_name: str, filename: str) -> Any:
    spec = importlib.util.spec_from_file_location(module_name, HERE / filename)
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot load {filename}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# One dictionary of brands, grades, places and roads for both prototypes.
TG = _sibling("telegram_channels", "telegram-channels.py")


def _iso(value: datetime | None) -> str | None:
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z") if value else None


def _clean(value: str | None) -> str:
    text = html.unescape(value or "")
    text = re.sub(r"<(script|style)\b.*?</\1>", " ", text, flags=re.S | re.I)
    text = re.sub(r"<br\s*/?>|</p>", "\n", text, flags=re.I)
    text = html.unescape(re.sub(r"<[^>]+>", " ", text))
    text = re.sub(r"[ \t\r\f\v\xa0]+", " ", text)
    return re.sub(r"\s*\n\s*", "\n", text).strip()


def parse_when(value: str | None) -> datetime | None:
    if not value:
        return None
    value = value.strip()
    try:
        parsed = parsedate_to_datetime(value)
    except (TypeError, ValueError, IndexError):
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
    if parsed.tzinfo is None:
        # "-0000" is RFC 2822 for UTC without a local zone (lenobl.ru uses it);
        # a stamp with no zone at all is taken as Moscow time.
        utc = re.search(r"(?:[+-]0000|GMT|UTC?|Z)\s*$", value)
        parsed = parsed.replace(tzinfo=timezone.utc if utc else MOSCOW)
    return parsed.astimezone(timezone.utc)


def _parse_loosely(text: str) -> list[dict[str, str]]:
    """Fallback for feeds that are not well-formed XML (a stray & is enough)."""
    entries: list[dict[str, str]] = []
    for block in re.findall(r"<item\b.*?</item>", text, re.S | re.I):
        fields: dict[str, str] = {}
        for name in ("title", "link", "guid", "pubDate", "description"):
            match = re.search(rf"<{name}\b[^>]*>(.*?)</{name}>", block, re.S | re.I)
            if match:
                fields[name] = re.sub(r"^\s*<!\[CDATA\[|\]\]>\s*$", "", match.group(1))
        entries.append(fields)
    return entries


def parse_feed(raw: bytes) -> list[dict[str, str]]:
    """Return RSS <item> / Atom <entry> children as {local tag name: text}."""
    try:
        root = ET.fromstring(raw)
    except ET.ParseError:
        return _parse_loosely(raw.decode("utf-8", "replace"))
    entries: list[dict[str, str]] = []
    for node in root.iter():
        if node.tag.rsplit("}", 1)[-1] not in ("item", "entry"):
            continue
        fields: dict[str, str] = {}
        for child in node:
            name = child.tag.rsplit("}", 1)[-1]
            if name == "link" and child.get("href"):
                fields.setdefault("link", child.get("href", ""))
            elif child.text and child.text.strip():
                fields.setdefault(name, child.text)
        entries.append(fields)
    return entries


def normalize(feed: str, fields: dict[str, str], max_text: int) -> dict[str, Any]:
    title = _clean(fields.get("title"))
    summary = _clean(fields.get("description") or fields.get("summary"))
    body = _clean(fields.get("encoded") or fields.get("full-text") or fields.get("content"))
    text = "\n".join(part for part in (title, summary, body) if part)
    published = parse_when(fields.get("pubDate") or fields.get("published") or fields.get("updated") or fields.get("date"))
    lead = summary or body
    fuel = bool(FUEL.search(text))
    return {
        "feed": feed,
        "guid": (fields.get("guid") or fields.get("id") or fields.get("link") or "").strip(),
        "published_at": _iso(published),
        "title": title,
        "link": (fields.get("link") or "").strip(),
        "summary": lead[:max_text] if max_text else lead,
        "text_chars": len(text),
        "fuel_related": fuel,
        "mentions": TG.mentions(text) if fuel else None,
    }


def fetch(opener: Any, url: str, timeout: int = 40) -> tuple[int, bytes]:
    request = Request(url, headers={
        "User-Agent": BROWSER_UA,
        "Accept": "application/rss+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5",
        "Accept-Language": "ru,en;q=0.8",
    })
    with opener.open(request, timeout=timeout) as response:
        return response.status, response.read()


def _stamp(item: dict[str, Any]) -> datetime | None:
    value = item.get("published_at")
    return datetime.fromisoformat(value.replace("Z", "+00:00")) if value else None


def _age(now: datetime, value: datetime | None) -> float | None:
    return round((now - value).total_seconds() / 3600, 1) if value else None


def collect(names: list[str], *, direct: bool = False, all_items: bool = False,
            max_text: int = 400, pause: float = 1.0) -> dict[str, Any]:
    opener = build_opener(ProxyHandler({})) if direct else build_opener()
    now = datetime.now(timezone.utc)
    feeds: dict[str, Any] = {}
    kept: list[dict[str, Any]] = []
    for index, name in enumerate(names):
        if index:
            time.sleep(pause)
        info: dict[str, Any] = {"url": FEEDS[name], "via": "direct" if direct else "proxy-env", "ok": False}
        try:
            status, raw = fetch(opener, FEEDS[name])
            items = [normalize(name, fields, max_text) for fields in parse_feed(raw)]
        except Exception as exc:  # noqa: BLE001 - report and go on with the next feed
            info["error"] = f"{type(exc).__name__}: {exc}"
            feeds[name] = info
            continue
        fuel = [item for item in items if item["fuel_related"]]
        stamps = sorted(stamp for stamp in map(_stamp, items) if stamp)
        fuel_stamps = sorted(stamp for stamp in map(_stamp, fuel) if stamp)

        def with_(key: str) -> int:
            return sum(1 for item in fuel if item["mentions"][key])

        info.update({
            "ok": True,
            "http_status": status,
            "bytes": len(raw),
            "items": len(items),
            "window_hours": round((stamps[-1] - stamps[0]).total_seconds() / 3600, 1) if len(stamps) > 1 else None,
            "newest_item_at": _iso(stamps[-1]) if stamps else None,
            "newest_age_hours": _age(now, stamps[-1] if stamps else None),
            "fuel_items": len(fuel),
            "fuel_items_spb_lo": with_("region"),
            "newest_fuel_at": _iso(fuel_stamps[-1]) if fuel_stamps else None,
            "newest_fuel_age_hours": _age(now, fuel_stamps[-1] if fuel_stamps else None),
            "fuel_with": {key: with_(field) for key, field in (
                ("district", "districts"), ("brand", "brands"), ("grade", "grades"),
                ("address_or_km", "addresses"), ("highway", "highways"), ("limit", "limit_liters"),
                ("queue", "queue"), ("closure", "closure"),
            )},
        })
        feeds[name] = info
        kept.extend(items if all_items else fuel)
    return {"captured_at": _iso(now), "feeds": feeds, "items": kept}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--feeds", default=",".join(DEFAULT_FEEDS), help=f"comma list from: {', '.join(FEEDS)}")
    parser.add_argument("--direct", action="store_true", help="ignore proxy environment variables")
    parser.add_argument("--save", help="write the JSON result here")
    parser.add_argument("--all-items", action="store_true", help="keep non-fuel items in the JSON too")
    parser.add_argument("--max-text", type=int, default=400, help="truncate the lead in the JSON (0 = full)")
    args = parser.parse_args()
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    names = [name.strip() for name in args.feeds.split(",") if name.strip()]
    unknown = [name for name in names if name not in FEEDS]
    if unknown:
        parser.error(f"unknown feeds: {unknown}")

    result = collect(names, direct=args.direct, all_items=args.all_items, max_text=args.max_text)
    for name, info in result["feeds"].items():
        if not info["ok"]:
            print(f"{name}: FAILED {info['error']}")
            continue
        found = info["fuel_with"]
        print(
            f"{name}: {info['items']} items over {info['window_hours']} h, newest {info['newest_age_hours']} h ago | "
            f"fuel {info['fuel_items']} (SPb/LO {info['fuel_items_spb_lo']}), newest fuel {info['newest_fuel_age_hours']} h ago | "
            f"fuel items with district {found['district']}, brand {found['brand']}, grade {found['grade']}, "
            f"address/km {found['address_or_km']}, highway {found['highway']}, limit {found['limit']}, "
            f"queue {found['queue']}, closure {found['closure']}"
        )
    fuel_items = sorted((item for item in result["items"] if item["fuel_related"]),
                        key=lambda item: item["published_at"] or "", reverse=True)
    for item in fuel_items[:15]:
        found = item["mentions"]
        tags = ", ".join(part for part in (
            "районы " + "/".join(found["districts"]) if found["districts"] else "",
            "бренды " + "/".join(found["brands"]) if found["brands"] else "",
            "марки " + "/".join(found["grades"]) if found["grades"] else "",
            "адреса " + " | ".join(found["addresses"][:3]) if found["addresses"] else "",
        ) if part)
        print(f"  {item['published_at']} [{item['feed']}] {item['title'][:110]}" + (f"  ({tags})" if tags else ""))
    if args.save:
        Path(args.save).write_text(json.dumps(result, ensure_ascii=False, indent=1), "utf-8")
        print(f"saved {len(result['items'])} items -> {args.save}")
    return 0 if any(info["ok"] for info in result["feeds"].values()) else 1


if __name__ == "__main__":
    raise SystemExit(main())
