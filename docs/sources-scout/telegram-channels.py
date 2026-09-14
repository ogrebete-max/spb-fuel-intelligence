#!/usr/bin/env python3
"""Prototype: public Telegram channels through the t.me/s/<handle> web preview.

This is what a browser without a Telegram account sees: the newest ~20 posts
of a public channel, and older ones with ?before=<post id>.  No MTProto, no
bot token, no login, no protected content.  At most two pages per channel.

    python telegram-channels.py                         # default channels, 1 page each
    python telegram-channels.py fontankaspb --pages 2
    python telegram-channels.py --direct                # ignore HTTPS_PROXY
    python telegram-channels.py --from-dir raw/news     # parse saved tg_<handle>_p<N>.html
    python telegram-channels.py --save out.json --fuel-only --max-text 600

Network note (14.09.2026): from the Russian home IP t.me does not accept a TCP
connection at all, so this only works from abroad (proxy / GitHub runners).
Comments under posts are not part of the preview and are not read.
"""

from __future__ import annotations

import argparse
import html
import json
import re
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from urllib.request import ProxyHandler, Request, build_opener

BROWSER_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"
)
# Fresh channels that carried SPb/LO fuel posts on 12-14.09.2026 (see scouting notes).
DEFAULT_CHANNELS = (
    "fontankaspb", "allnews47", "Megapolisonline", "dtp_spb78",
    "dtp_chp_kudrovo1", "telekudrovo", "sertolovoonline", "drozdenko_au_lo",
)
# Local channels: a post that names a brand but no town is about this town.
CHANNEL_PLACE = {
    "sertolovoonline": "Сертолово", "tmurino": "Мурино", "telekudrovo": "Кудрово",
    "dtp_chp_kudrovo1": "Кудрово", "tosnogorod": "Тосно", "gatchina47ru": "Гатчина",
    "kingiseppsegodnya": "Кингисепп", "kirishi_online_tg": "Кириши", "gazetavyborg": "Выборг",
}
MAX_PAGES = 2
MOSCOW = timezone(timedelta(hours=3))
LAT_RANGE, LON_RANGE = (58.4, 61.4), (27.6, 35.8)
GRADE_ORDER = ["92", "95", "98", "100", "ДТ"]

FUEL = re.compile(
    r"бензин|(?<!био)топлив|\bазс\b|заправ|дизел|солярк|\bдт\b|\bгсм\b|нефтепродукт"
    r"|\bаи[\s\-–]?(?:9[258]|100)\b|дефицит",
    re.I,
)
SPB_LO = re.compile(r"петербург|\bспб\b|\bпитер|ленобласт|ленинградск\w*\s+област|\bло\b|\bкад\b", re.I)
AD = re.compile(r"\berid\b|#реклама|\bреклама\b|на\s+правах\s+рекламы|партн[её]рск\w+\s+материал", re.I)
# "ООО «Татнефть-АЗС-Северо-Запад» ИНН: ..." under every post of a brand channel is not content.
LEGAL_FOOTER = re.compile(r"\b(?:ООО|АО|ПАО|ИП)\s+«[^»\n]{1,80}»\s*,?\s*ИНН:?\s*\d{10,12}")

BRANDS = {name: re.compile(pattern, re.I) for name, pattern in {
    "Лукойл": r"лукойл|lukoil",
    "Роснефть": r"роснефт|rosneft",
    "ПТК": r"\bптк\b|петербургск\w*\s+топливн\w*\s+компан",
    "Газпромнефть": r"газпром\s*нефт|газпромнефт|\bгпн\b|\bопти\b|\bopti\b",
    "Газпром (АЗС)": r"[«\"]газпром[»\"]|\bазс\s+газпром\b(?!\s*нефт)",
    "Татнефть": r"татнефт|tatneft",
    "Teboil": r"teboil|тебойл|теболл",
    "Shell": r"\bshell\b|\bшелл\b",
    "Neste": r"\bneste\b|\bнесте\b",
    "Круг": r"[«\"]круг[»\"]|\bазс\s+круг\b",
    "Трасса": r"[«\"]трасса[»\"]",
    "Нефтьмагистраль": r"нефтьмагистрал",
    # "КИНЕФ" alone is the refinery, not a station, so only the retail name counts.
    "Киришиавтосервис": r"киришиавтосервис|азс\s+[«\"]?кинеф",
    "Фаэтон": r"faeton|фаэтон",
    "Линос": r"\bлинос\b|\blinos\b",
    "BP": r"\bbp\b",
    "Movement": r"\bmovement\b|мувмент",
}.items()}

GRADE_SINGLE = re.compile(
    r"(?:аи|ai)[\s\-–]*(92|95|98|100)\b"
    r"|\b(92|95|98|100)-?(?:й|го|ого|ой|ым)\b"
    r"|\b(92|95|98|100)\s+бензин"
    r"|бензин\w*\s+(?:марки\s+)?(92|95|98|100)\b",
    re.I,
)
GRADE_LIST = re.compile(
    r"\b(?:92|95|98|100)(?:(?:\s*[/\-–]\s*|,\s*|\s+и\s+|\s+или\s+)(?:92|95|98|100))+\b"
    r"(?!\s*(?:руб|₽|%|км|тыс|млн|шт|л\b|литр))",
    re.I,
)
DIESEL = re.compile(r"\bдт\b|дизел|солярк|\bdiesel\b", re.I)

_NUM = r"(?:,?\s*(?:д\.\s*)?\d{1,4}[а-яА-Я]?(?:[/к]\d{1,3})?)?"
_NAME = r"[А-ЯЁ0-9][\w\-]*(?:\s+[А-ЯЁ][\w\-]*)?"
_ROAD = r"(?:\b[МАРMAP][\-–]?\d{1,3}\b|(?i:\bкад\b|трасс\w*|шоссе|скандинави\w*|мурманк\w*))"
ADDRESS = re.compile(
    r"(?i:\bазс\s*(?:№|n|#)\s*)\d{1,5}"
    rf"|(?i:\b(?:ул|пр|просп|пер|наб|пл|бул|ш|шос))\.\s*{_NAME}{_NUM}"
    rf"|(?i:\b(?:пр-т|б-р))\.?\s+{_NAME}{_NUM}"
    rf"|\b[А-ЯЁ][\w\-]+\s+(?i:ул|пр|пр-т|просп|ш|наб|пер|б-р)\.{_NUM}"
    rf"|(?i:\b(?:улиц[аеиуы]|проспект[аеу]?|шоссе|набережн\w+|переул\w+|бульвар\w*))\s+{_NAME}{_NUM}"
    rf"|\b[А-ЯЁ][\w\-]+(?:ое|ий|ая|ый|ой|ом|ем)\s+(?i:шоссе|проспект\w*|улиц\w+|набережн\w+){_NUM}"
    rf"|\b\d{{1,4}}(?:-?й|-?м)?\s*(?i:км|километр\w*)\b[^.\n]{{0,25}}?{_ROAD}"
    rf"|{_ROAD}[^.\n]{{0,25}}?\b\d{{1,4}}(?:-?й|-?м)?\s*(?i:км\b|километр\w*)"
)

HIGHWAYS = {name: re.compile(pattern) for name, pattern in {
    "М-10": r"\b[МM][\-–]?10\b",
    "М-11": r"\b[МM][\-–]?11\b|(?i:трасс\w*\s+[«\"]?нева)",
    "Р-21": r"\b[РP][\-–]?21\b|(?i:мурманк\w*|мурманск\w+\s+шоссе|трасс\w*\s+[«\"]?кола)",
    "А-181": r"\b[АA][\-–]?181\b|(?i:скандинави\w*)",
    "Р-23/М-20": r"\b[РP][\-–]?23\b|\b[МM][\-–]?20\b|(?i:киевск\w+\s+шоссе)",
    "А-180": r"\b[АA][\-–]?180\b|(?i:трасс\w*\s+[«\"]?нарва|таллинск\w+\s+шоссе)",
    "А-121": r"\b[АA][\-–]?121\b|(?i:трасс\w*\s+[«\"]?сортавала)",
    "КАД": r"\bКАД\b",
}.items()}

PLACES = {name: re.compile(pattern, re.I) for name, pattern in {
    "Гатчина": r"гатчин", "Всеволожск": r"всеволожск", "Мурино": r"\bмурин[оеа]\b",
    "Кудрово": r"\bкудров[оеа]\b", "Выборг": r"\bвыборг(?:[ауе]|ом)?\b", "Кингисепп": r"кингисепп",
    "Луга": r"(?<!усть-)\bлуг[аиеу]\b|\bлужск", "Тосно": r"\bтосно\b|тосненск",
    # "Киришинефтеоргсинтез" is the refinery; only the town and the district count.
    "Кириши": r"\bкириш(?:и|ах|ам|ей|ск\w*)\b",
    "Сосновый Бор": r"соснов\w*\s+бор|сосновоборск", "Тихвин": r"тихвин", "Приозерск": r"приозерск",
    "Сертолово": r"сертолов", "Волхов": r"\bволхов", "Волосово": r"волосов",
    "Бокситогорск": r"бокситогорск", "Пикалёво": r"пикал[её]в", "Лодейное Поле": r"лодейн\w+\s+пол|лодейнопольск",
    "Подпорожье": r"подпорож", "Сланцы": r"\bсланц(?:ы|ах|ев)\b|сланцевск", "Кировск": r"\bкировске?\b",
    "Шлиссельбург": r"шлиссельбург", "Отрадное": r"\bотрадн(?:ое|ом)\b", "Никольское": r"\bникольск(?:ое|ом)\b",
    "Коммунар": r"\bкоммунар[е]?\b", "Сиверский": r"сиверск", "Вырица": r"выриц", "Токсово": r"токсов",
    "Янино": r"\bянин[оеа]\b", "Бугры": r"\bбугр(?:ы|ах)\b", "Девяткино": r"девяткин", "Рощино": r"\bрощин[оеа]\b",
    "Светогорск": r"светогорск", "Каменногорск": r"каменногорск", "Приморск": r"\bприморске?\b",
    "Ивангород": r"ивангород", "Усть-Луга": r"усть-луг", "Любань": r"\bлюбан[ьи]\b", "Ульяновка": r"ульяновк",
    "Мга": r"\bмг[аеи]\b", "Колпино": r"колпин", "Пушкин": r"\bпушкине?\b", "Петергоф": r"петергоф",
    "Кронштадт": r"кронштадт", "Сестрорецк": r"сестрорецк", "Зеленогорск": r"зеленогорск",
    "Красное Село": r"красн\w+\s+сел[оеа]", "Парголово": r"парголов", "Шушары": r"шушар",
    "Кузьмоловский": r"кузьмолов", "Ломоносовский р-н": r"ломоносовск\w+\s+район",
}.items()}
PLACE_DISTRICT = {
    **dict.fromkeys(("Гатчина", "Коммунар", "Сиверский", "Вырица"), "Гатчинский"),
    **dict.fromkeys(("Всеволожск", "Мурино", "Кудрово", "Сертолово", "Токсово", "Янино", "Бугры",
                     "Девяткино", "Кузьмоловский"), "Всеволожский"),
    **dict.fromkeys(("Выборг", "Светогорск", "Каменногорск", "Приморск", "Рощино"), "Выборгский"),
    **dict.fromkeys(("Кингисепп", "Ивангород", "Усть-Луга"), "Кингисеппский"),
    **dict.fromkeys(("Тосно", "Никольское", "Любань", "Ульяновка"), "Тосненский"),
    **dict.fromkeys(("Кировск", "Шлиссельбург", "Отрадное", "Мга"), "Кировский (ЛО)"),
    **dict.fromkeys(("Бокситогорск", "Пикалёво"), "Бокситогорский"),
    **dict.fromkeys(("Колпино", "Пушкин", "Петергоф", "Кронштадт", "Сестрорецк", "Зеленогорск",
                     "Красное Село", "Парголово", "Шушары"), "СПб"),
    "Луга": "Лужский", "Кириши": "Киришский", "Сосновый Бор": "Сосновоборский", "Тихвин": "Тихвинский",
    "Приозерск": "Приозерский", "Волхов": "Волховский", "Волосово": "Волосовский",
    "Лодейное Поле": "Лодейнопольский", "Подпорожье": "Подпорожский", "Сланцы": "Сланцевский",
    "Ломоносовский р-н": "Ломоносовский",
}

LIMIT = re.compile(
    r"(?:лимит\w*|ограничени\w*|не\s+более|не\s+больше|максимум|до|по)[\s:—–\-]+(?:в\s+)?(\d{1,3})\s*(?:л\b|л\.|литр\w*)"
    r"|(\d{1,3})\s*(?:л\b|л\.|литр\w*)\s+(?:в\s+одни\s+руки|на\s+(?:одн[уо]\w*\s+|один\s+)?"
    r"(?:машин\w*|авто\w*|чек\w*|карт\w*|клиент\w*|человек\w*|бак\w*|заправк\w*)|в\s+(?:сутки|день))",
    re.I,
)
# "в первую очередь", "в свою очередь" and "очередной" are not queues.
QUEUE = re.compile(
    r"(?<!первую\s)(?<!свою\s)очеред(?!н)\w*[^.\n!?]{0,40}|пробк\w*\s+(?:на|у|к|возле)\s+азс[^.\n!?]{0,30}",
    re.I,
)
_STATION = r"(?:азс|заправк\w*|колонк\w*|станци\w*)"
_SHUT = r"(?:закрыт\w*|закрыл\w*|не\s+работа\w*|приостанов\w*)"
CLOSURE = re.compile(
    rf"{_STATION}[^.\n!?]{{0,30}}?\b{_SHUT}[^.\n!?]{{0,20}}"
    rf"|\b{_SHUT}\s+(?:\w+\s+)?(?:{_STATION}|продаж\w*|отпуск\w*)[^.\n!?]{{0,20}}"
    r"|\bнет\s+(?:в\s+наличии\s+)?(?:топлива|бензина|аи|92|95|98|дт|дизел\w*|солярк\w*)[^.\n!?]{0,30}"
    r"|(?:топлив\w*|бензин\w*|дизел\w*)\s+(?:нет|законч\w*|кончил\w*|отсутств\w*)[^.\n!?]{0,30}"
    r"|отсутств\w+\s+(?:топлив|бензин|аи|дт)\w*",
    re.I,
)
AVAILABLE = re.compile(
    r"\bесть\s+(?:в\s+наличии\s+)?(?:топливо|бензин|аи|92|95|98|100|дт|дизел\w*)[^.\n!?]{0,30}"
    r"|\bв\s+наличии\b[^.\n!?]{0,30}|появил\w*\s+(?:бензин|топливо|аи|92|95|дт)[^.\n!?]{0,30}"
    r"|\bбез\s+ограничени\w*|\bзавез\w*[^.\n!?]{0,30}|\bпривез\w*[^.\n!?]{0,30}",
    re.I,
)
COORD_LINK = re.compile(r"(?:[?&](?:pt|ll|q|query|destination|rtext)=|@)(-?\d{1,2}\.\d{3,})(?:,|%2C)(-?\d{1,2}\.\d{3,})")

WRAP = re.compile(r'<div class="tgme_widget_message_wrap')
DATA_POST = re.compile(r'data-post="([^"/]+)/(\d+)"')
TEXT_OPEN = re.compile(r'<div class="tgme_widget_message_text(?![^"]*js-message_reply_text)[^"]*"[^>]*>')
DATE = re.compile(r'<a class="tgme_widget_message_date"[^>]*>\s*<time datetime="([^"]+)"')
ANY_TIME = re.compile(r'<time datetime="([^"]+)"')
VIEWS = re.compile(r'<span class="tgme_widget_message_views">([^<]+)</span>')
FORWARDED = re.compile(r'class="tgme_widget_message_forwarded_from_name"[^>]*>(.*?)</(?:a|span)>', re.S)
TITLE = re.compile(r'<div class="tgme_channel_info_header_title"[^>]*>(.*?)</div>', re.S)
COUNTERS = re.compile(r'<span class="counter_value">([^<]+)</span>\s*<span class="counter_type">([^<]+)</span>')
DIV_TAG = re.compile(r"<div\b|</div>")
HREF = re.compile(r'href="([^"]+)"')


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def plain_text(block: str) -> str:
    text = re.sub(r"<br\s*/?>", "\n", block)
    text = re.sub(r"<[^>]+>", "", text)
    return html.unescape(text).strip()


def parse_count(value: str | None) -> int | None:
    match = re.fullmatch(r"\s*([\d.,]+)\s*([KkMm]?)\s*", value or "")
    if not match:
        return None
    number = float(match.group(1).replace(",", "."))
    return int(number * {"": 1, "k": 1_000, "m": 1_000_000}[match.group(2).lower()])


def _inner_div(page: str, start: int) -> str:
    """Return the markup up to the </div> that closes the div opened just before start."""
    depth = 1
    for tag in DIV_TAG.finditer(page, start):
        depth += -1 if tag.group(0) == "</div>" else 1
        if depth == 0:
            return page[start:tag.start()]
    return page[start:]


def _snippet(match: re.Match[str] | None) -> str | None:
    return re.sub(r"\s+", " ", match.group(0)).strip() if match else None


def mentions(text: str, home_place: str | None = None) -> dict[str, Any]:
    """Extract station-level hints from free Russian text; shared with news-rss.py."""
    grades: set[str] = set()
    for match in GRADE_SINGLE.finditer(text):
        grades.add(next(group for group in match.groups() if group))
    for match in GRADE_LIST.finditer(text):
        grades.update(re.findall(r"92|95|98|100", match.group(0)))
    if DIESEL.search(text):
        grades.add("ДТ")
    limits = [int(a or b) for a, b in LIMIT.findall(text)]
    limits = [value for value in limits if 5 <= value <= 300]
    addresses: list[str] = []
    for match in ADDRESS.finditer(text):
        value = re.sub(r"\s+", " ", match.group(0)).strip(" ,")
        if value not in addresses:
            addresses.append(value)
    places = sorted(name for name, rx in PLACES.items() if rx.search(text))
    highways = sorted(name for name, rx in HIGHWAYS.items() if rx.search(text))
    channel_place = home_place if home_place and not places else None
    districts = {PLACE_DISTRICT[name] for name in places if name in PLACE_DISTRICT}
    if channel_place in PLACE_DISTRICT:
        districts.add(PLACE_DISTRICT[channel_place])
    return {
        "brands": sorted(name for name, rx in BRANDS.items() if rx.search(text)),
        "grades": sorted(grades, key=GRADE_ORDER.index),
        "addresses": addresses[:12],
        "places": places,
        "channel_place": channel_place,
        "districts": sorted(districts),
        "highways": highways,
        "region": bool(places or channel_place or highways or SPB_LO.search(text)),
        "limit_liters": min(limits) if limits else None,
        "queue": _snippet(QUEUE.search(text)),
        "closure": _snippet(CLOSURE.search(text)),
        "available": _snippet(AVAILABLE.search(text)),
    }


def _coordinates(links: list[str]) -> dict[str, float] | None:
    for link in links:
        for first, second in COORD_LINK.findall(html.unescape(link)):
            a, b = float(first), float(second)
            if LAT_RANGE[0] <= a <= LAT_RANGE[1] and LON_RANGE[0] <= b <= LON_RANGE[1]:
                return {"lat": a, "lon": b}
            if LON_RANGE[0] <= a <= LON_RANGE[1] and LAT_RANGE[0] <= b <= LAT_RANGE[1]:
                return {"lat": b, "lon": a}
    return None


def station_level(found: dict[str, Any]) -> str | None:
    if found["addresses"]:
        return "address"
    if found["brands"] and (found["places"] or found["highways"]):
        return "brand+place"
    if found["brands"] and found.get("channel_place"):
        return "brand+channel_place"
    return None


def channel_info(page: str) -> dict[str, Any]:
    title = TITLE.search(page)
    counters = {kind.strip(): value.strip() for value, kind in COUNTERS.findall(page)}
    label = counters.get("subscribers") or counters.get("members")
    return {
        "title": plain_text(title.group(1)) if title else None,
        "subscribers": parse_count(label),
        "subscribers_label": label,
        "preview": "tgme_channel_info" in page,
    }


def parse_posts(page: str, home_place: str | None = None) -> list[dict[str, Any]]:
    posts: list[dict[str, Any]] = []
    for chunk in WRAP.split(page)[1:]:
        ident = DATA_POST.search(chunk)
        if not ident:
            continue
        opening = TEXT_OPEN.search(chunk)
        body = _inner_div(chunk, opening.end()) if opening else ""
        text = plain_text(body)
        stamp = DATE.search(chunk) or ANY_TIME.search(chunk)
        views = VIEWS.search(chunk)
        forwarded = FORWARDED.search(chunk)
        advertising = bool(AD.search(text))
        match_text = LEGAL_FOOTER.sub(" ", text)
        found = mentions(match_text, home_place)
        fuel = bool(FUEL.search(match_text)) and not advertising
        posts.append({
            "channel": ident.group(1),
            "post_id": int(ident.group(2)),
            "url": f"https://t.me/{ident.group(1)}/{ident.group(2)}",
            "published_at": _iso(datetime.fromisoformat(stamp.group(1))) if stamp else None,
            "views": parse_count(views.group(1)) if views else None,
            "forwarded_from": plain_text(forwarded.group(1)) if forwarded else None,
            "text": text,
            "advertising": advertising,
            "fuel_related": fuel,
            "station_level": station_level(found) if fuel else None,
            "coordinates": _coordinates(HREF.findall(body)),
            "mentions": found,
        })
    return posts


def fetch_page(opener: Any, handle: str, before: int | None, timeout: int = 40) -> str:
    url = f"https://t.me/s/{handle}" + (f"?before={before}" if before else "")
    request = Request(url, headers={
        "User-Agent": BROWSER_UA,
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "ru,en;q=0.8",
    })
    with opener.open(request, timeout=timeout) as response:
        final_url = response.geturl()
        page = response.read().decode("utf-8", "replace")
    if "/s/" not in final_url:
        raise RuntimeError(f"no public preview (redirected to {final_url})")
    return page


def summarize(meta: dict[str, Any], posts: list[dict[str, Any]], now: datetime) -> dict[str, Any]:
    stamps = sorted(datetime.fromisoformat(p["published_at"].replace("Z", "+00:00")) for p in posts if p["published_at"])
    fuel = [p for p in posts if p["fuel_related"]]
    span_days = (stamps[-1] - stamps[0]).total_seconds() / 86400 if len(stamps) > 1 else 0.0
    rate = (len(stamps) - 1) / span_days if span_days > 0 else None
    fuel_rate = len(fuel) / span_days if span_days > 0 else None
    counts = {
        "station_level": sum(1 for p in fuel if p["station_level"]),
        "address_or_km": sum(1 for p in fuel if p["mentions"]["addresses"]),
        "brand_plus_place": sum(1 for p in fuel if p["station_level"] in ("brand+place", "brand+channel_place")),
        "brand": sum(1 for p in fuel if p["mentions"]["brands"]),
        "grade": sum(1 for p in fuel if p["mentions"]["grades"]),
        "station_or_grade": sum(1 for p in fuel if p["station_level"] or p["mentions"]["grades"]),
        "district": sum(1 for p in fuel if p["mentions"]["districts"]),
        "limit": sum(1 for p in fuel if p["mentions"]["limit_liters"]),
        "queue": sum(1 for p in fuel if p["mentions"]["queue"]),
        "closure": sum(1 for p in fuel if p["mentions"]["closure"]),
        "available": sum(1 for p in fuel if p["mentions"]["available"]),
        "coordinates": sum(1 for p in fuel if p["coordinates"]),
        "ads_skipped": sum(1 for p in posts if p["advertising"]),
    }
    return {
        **meta,
        "posts": len(posts),
        "fuel_posts": len(fuel),
        "fuel_counts": counts,
        "newest_post_at": _iso(stamps[-1]) if stamps else None,
        "oldest_post_at": _iso(stamps[0]) if stamps else None,
        "newest_age_hours": round((now - stamps[-1]).total_seconds() / 3600, 1) if stamps else None,
        "posts_per_day": round(rate, 1) if rate is not None else None,
        "fuel_posts_per_day": round(fuel_rate, 1) if fuel_rate is not None else None,
    }


def collect(handles: list[str], pages: int, *, direct: bool = False, from_dir: str | None = None,
            dump_dir: str | None = None, pause: float = 1.5) -> dict[str, Any]:
    opener = build_opener(ProxyHandler({})) if direct else build_opener()
    now = _now()
    channels: dict[str, Any] = {}
    all_posts: list[dict[str, Any]] = []
    requests_made = 0
    for handle in handles:
        meta: dict[str, Any] = {"pages": 0, "errors": [], "via": "file" if from_dir else ("direct" if direct else "proxy-env"),
                                "home_place": CHANNEL_PLACE.get(handle.lower())}
        by_id: dict[int, dict[str, Any]] = {}
        before: int | None = None
        for page_no in range(1, min(pages, MAX_PAGES) + 1):
            try:
                if from_dir:
                    path = Path(from_dir) / f"tg_{handle}_p{page_no}.html"
                    if not path.exists():
                        break
                    page = path.read_text("utf-8", errors="replace")
                else:
                    if requests_made:
                        time.sleep(pause)
                    requests_made += 1
                    page = fetch_page(opener, handle, before)
                    if dump_dir:
                        Path(dump_dir).mkdir(parents=True, exist_ok=True)
                        (Path(dump_dir) / f"tg_{handle}_p{page_no}.html").write_text(page, "utf-8")
            except Exception as exc:  # noqa: BLE001 - a prototype reports and moves on
                meta["errors"].append(f"page {page_no}: {type(exc).__name__}: {exc}")
                break
            meta["pages"] += 1
            if page_no == 1:
                meta.update(channel_info(page))
            parsed = parse_posts(page, meta["home_place"])
            if not parsed:
                break
            for post in parsed:
                by_id[post["post_id"]] = post
            before = min(post["post_id"] for post in parsed)
        posts = sorted(by_id.values(), key=lambda p: p["post_id"], reverse=True)
        channels[handle] = summarize(meta, posts, now)
        all_posts.extend(posts)
    return {"captured_at": _iso(now), "source": "https://t.me/s/<handle> public web preview",
            "channels": channels, "posts": all_posts}


def _moscow(value: str | None) -> str:
    if not value:
        return "-"
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(MOSCOW).strftime("%d.%m %H:%M")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("handles", nargs="*", default=list(DEFAULT_CHANNELS))
    parser.add_argument("--pages", type=int, default=1, help="1 or 2 preview pages per channel")
    parser.add_argument("--direct", action="store_true", help="ignore proxy environment variables")
    parser.add_argument("--from-dir", help="parse saved tg_<handle>_p<N>.html instead of fetching")
    parser.add_argument("--dump-dir", help="also save fetched pages as tg_<handle>_p<N>.html")
    parser.add_argument("--save", help="write the JSON result here")
    parser.add_argument("--fuel-only", action="store_true", help="keep only fuel-related posts in the JSON")
    parser.add_argument("--max-text", type=int, default=0, help="truncate post text in the JSON (0 = full)")
    args = parser.parse_args()
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")

    result = collect(args.handles, args.pages, direct=args.direct, from_dir=args.from_dir, dump_dir=args.dump_dir)
    for handle, info in result["channels"].items():
        counts = info["fuel_counts"]
        print(
            f"{handle} [{info.get('title')}] {info.get('subscribers_label') or '?'} subs | pages {info['pages']} | "
            f"posts {info['posts']}, fuel {info['fuel_posts']}, station-level {counts['station_level']}, "
            f"station-or-grade {counts['station_or_grade']} | fuel posts with: address/АЗС№/км {counts['address_or_km']}, "
            f"brand+place {counts['brand_plus_place']}, brand {counts['brand']}, grade {counts['grade']}, "
            f"district {counts['district']}, limit {counts['limit']}, queue {counts['queue']}, closure {counts['closure']}, "
            f"available {counts['available']}, coords {counts['coordinates']}, ads skipped {counts['ads_skipped']} | "
            f"newest {_moscow(info['newest_post_at'])} MSK ({info['newest_age_hours']} h ago), "
            f"oldest {_moscow(info['oldest_post_at'])} | {info['posts_per_day']} posts/day, {info['fuel_posts_per_day']} fuel/day"
            + (f" | errors: {info['errors']}" if info["errors"] else "")
        )
    if args.save:
        posts = [p for p in result["posts"] if p["fuel_related"]] if args.fuel_only else result["posts"]
        if args.max_text:
            posts = [{**p, "text": p["text"][:args.max_text]} for p in posts]
        Path(args.save).write_text(json.dumps({**result, "posts": posts}, ensure_ascii=False, indent=1), "utf-8")
        print(f"saved {len(posts)} posts -> {args.save}")
    return 0 if any(info["posts"] for info in result["channels"].values()) else 1


if __name__ == "__main__":
    raise SystemExit(main())
