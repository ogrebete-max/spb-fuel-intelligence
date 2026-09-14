"""Prototype collector: Alfa-Bank public fuel map (https://alfabank.ru/azs/).

Endpoint
    GET https://alfabank.ru/api/v1/azs-stations/public/stations
    Anonymous: no key, cookie or query parameters. One JSON list for all of
    Russia (about 16 400 stations, 20 MB, 3.2 MB with gzip). The SPb/LO part
    is cut out locally.

Record
    station_id (uuid), brand.name, address.fullname,
    address.location {latitude, longitude},
    fuels[] for AI92 / AI95 / AI98_100 / DIESEL:
        status: available | probably_unavailable | unavailable | closed | unknown
        price, last_transaction_at,
        restrictions[] {type limit|disabled, payment_type all|mobile,
                        partner_name "benzuber", limit, start_date, end_date, comment}
    partner_stations[] {partner_station_id, is_active}   (Benzuber station ids)
    last_alfa_transaction_time, last_24h_alfa_transactions_count

TLS
    alfabank.ru presents a certificate issued by the Russian Trusted Root CA
    (Ministry of Digital Development). That root is missing from the Windows,
    Ubuntu and certifi stores, so a bare urlopen fails with
    CERTIFICATE_VERIFY_FAILED. Verification stays on: the public root below is
    added to the default store. It is the file
    https://gu-st.ru/content/Other/doc/russian_trusted_root_ca.cer, SHA-256
    D2:6D:2D:02:31:B7:C3:9F:92:CC:73:85:12:BA:54:10:35:19:E4:40:5D:68:B5:BD:70:3E:97:88:CA:8E:CF:31

Notes
    The HTML page /azs/ answers with a ServicePipe JavaScript check; the API
    path does not. alfabank.ru/robots.txt carries "Disallow: /api/*".
    The same per-grade transaction times already reach the project through the
    tboo.ru/gpn relay (src "a" in predict.json), but without Alfa's own status,
    limits, Benzuber restrictions and prices.

Usage
    python alfa-azs.py [--direct] [--save full.json] [--sample sample.json]
"""

from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime, timezone
import gzip
import json
from pathlib import Path
import ssl
import sys
from typing import Any
from urllib.request import HTTPSHandler, ProxyHandler, Request, build_opener

URL = "https://alfabank.ru/api/v1/azs-stations/public/stations"
BBOX = {"south": 58.4, "north": 61.4, "west": 27.6, "east": 35.8}
CITY_AOI = {"south": 59.60, "north": 60.35, "west": 29.50, "east": 31.10}
BROWSER_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"
)
RUSSIAN_TRUSTED_ROOT_CA = """-----BEGIN CERTIFICATE-----
MIIFwjCCA6qgAwIBAgICEAAwDQYJKoZIhvcNAQELBQAwcDELMAkGA1UEBhMCUlUx
PzA9BgNVBAoMNlRoZSBNaW5pc3RyeSBvZiBEaWdpdGFsIERldmVsb3BtZW50IGFu
ZCBDb21tdW5pY2F0aW9uczEgMB4GA1UEAwwXUnVzc2lhbiBUcnVzdGVkIFJvb3Qg
Q0EwHhcNMjIwMzAxMjEwNDE1WhcNMzIwMjI3MjEwNDE1WjBwMQswCQYDVQQGEwJS
VTE/MD0GA1UECgw2VGhlIE1pbmlzdHJ5IG9mIERpZ2l0YWwgRGV2ZWxvcG1lbnQg
YW5kIENvbW11bmljYXRpb25zMSAwHgYDVQQDDBdSdXNzaWFuIFRydXN0ZWQgUm9v
dCBDQTCCAiIwDQYJKoZIhvcNAQEBBQADggIPADCCAgoCggIBAMfFOZ8pUAL3+r2n
qqE0Zp52selXsKGFYoG0GM5bwz1bSFtCt+AZQMhkWQheI3poZAToYJu69pHLKS6Q
XBiwBC1cvzYmUYKMYZC7jE5YhEU2bSL0mX7NaMxMDmH2/NwuOVRj8OImVa5s1F4U
zn4Kv3PFlDBjjSjXKVY9kmjUBsXQrIHeaqmUIsPIlNWUnimXS0I0abExqkbdrXbX
YwCOXhOO2pDUx3ckmJlCMUGacUTnylyQW2VsJIyIGA8V0xzdaeUXg0VZ6ZmNUr5Y
Ber/EAOLPb8NYpsAhJe2mXjMB/J9HNsoFMBFJ0lLOT/+dQvjbdRZoOT8eqJpWnVD
U+QL/qEZnz57N88OWM3rabJkRNdU/Z7x5SFIM9FrqtN8xewsiBWBI0K6XFuOBOTD
4V08o4TzJ8+Ccq5XlCUW2L48pZNCYuBDfBh7FxkB7qDgGDiaftEkZZfApRg2E+M9
G8wkNKTPLDc4wH0FDTijhgxR3Y4PiS1HL2Zhw7bD3CbslmEGgfnnZojNkJtcLeBH
BLa52/dSwNU4WWLubaYSiAmA9IUMX1/RpfpxOxd4Ykmhz97oFbUaDJFipIggx5sX
ePAlkTdWnv+RWBxlJwMQ25oEHmRguNYf4Zr/Rxr9cS93Y+mdXIZaBEE0KS2iLRqa
OiWBki9IMQU4phqPOBAaG7A+eP8PAgMBAAGjZjBkMB0GA1UdDgQWBBTh0YHlzlpf
BKrS6badZrHF+qwshzAfBgNVHSMEGDAWgBTh0YHlzlpfBKrS6badZrHF+qwshzAS
BgNVHRMBAf8ECDAGAQH/AgEEMA4GA1UdDwEB/wQEAwIBhjANBgkqhkiG9w0BAQsF
AAOCAgEAALIY1wkilt/urfEVM5vKzr6utOeDWCUczmWX/RX4ljpRdgF+5fAIS4vH
tmXkqpSCOVeWUrJV9QvZn6L227ZwuE15cWi8DCDal3Ue90WgAJJZMfTshN4OI8cq
W9E4EG9wglbEtMnObHlms8F3CHmrw3k6KmUkWGoa+/ENmcVl68u/cMRl1JbW2bM+
/3A+SAg2c6iPDlehczKx2oa95QW0SkPPWGuNA/CE8CpyANIhu9XFrj3RQ3EqeRcS
AQQod1RNuHpfETLU/A2gMmvn/w/sx7TB3W5BPs6rprOA37tutPq9u6FTZOcG1Oqj
C/B7yTqgI7rbyvox7DEXoX7rIiEqyNNUguTk/u3SZ4VXE2kmxdmSh3TQvybfbnXV
4JbCZVaqiZraqc7oZMnRoWrXRG3ztbnbes/9qhRGI7PqXqeKJBztxRTEVj8ONs1d
WN5szTwaPIvhkhO3CO5ErU2rVdUr89wKpNXbBODFKRtgxUT70YpmJ46VVaqdAhOZ
D9EUUn4YaeLaS8AjSF/h7UkjOibNc4qVDiPP+rkehFWM66PVnP1Msh93tc+taIfC
EYVMxjh8zNbFuoc7fzvvrFILLe7ifvEIUqSVIC/AzplM/Jxw7buXFeGP1qVCBEHq
391d/9RAfaZ12zkwFsl+IKwE/OZxW8AHa9i1p4GO0YSNuczzEm4=
-----END CERTIFICATE-----
"""


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(value: Any) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None


def _opener(direct: bool):
    context = ssl.create_default_context()
    context.load_verify_locations(cadata=RUSSIAN_TRUSTED_ROOT_CA)
    handlers: list[Any] = [HTTPSHandler(context=context)]
    if direct:
        handlers.insert(0, ProxyHandler({}))
    return build_opener(*handlers)


def _inside(row: dict[str, Any], box: dict[str, float]) -> bool:
    location = (row.get("address") or {}).get("location") or {}
    try:
        lat, lon = float(location["latitude"]), float(location["longitude"])
    except (KeyError, TypeError, ValueError):
        return False
    return box["south"] <= lat <= box["north"] and box["west"] <= lon <= box["east"]


def collect(direct: bool = False, timeout: int = 90) -> dict[str, Any]:
    request = Request(URL, headers={
        "User-Agent": BROWSER_UA,
        "Accept": "application/json",
        "Accept-Encoding": "gzip",
        "Accept-Language": "ru,en;q=0.8",
        "Referer": "https://alfabank.ru/azs/",
    })
    with _opener(direct).open(request, timeout=timeout) as response:
        body = response.read()
        if response.headers.get("Content-Encoding") == "gzip":
            body = gzip.decompress(body)
    rows = json.loads(body.decode("utf-8"))
    return {
        "captured_at": _now().isoformat().replace("+00:00", "Z"),
        "source": URL,
        "russia_total": len(rows),
        "stations": [row for row in rows if _inside(row, BBOX)],
    }


def _bucket(stamp: datetime | None, now: datetime) -> str:
    if stamp is None:
        return "none"
    hours = (now - stamp).total_seconds() / 3600
    return "<1h" if hours < 1 else "<3h" if hours < 3 else "<24h" if hours < 24 else "older"


def summary(payload: dict[str, Any]) -> None:
    now = _now()
    stations = payload["stations"]
    city = sum(1 for row in stations if _inside(row, CITY_AOI))
    print(f"Alfa-Bank: {len(stations)} stations in the SPb/LO bbox ({city} in the city AOI), "
          f"{payload['russia_total']} in Russia")
    by_grade: dict[str, Counter[str]] = {}
    limits: Counter[Any] = Counter()
    disabled: Counter[Any] = Counter()
    for row in stations:
        for fuel in row.get("fuels") or []:
            by_grade.setdefault(str(fuel.get("category")), Counter())[str(fuel.get("status"))] += 1
            for rule in fuel.get("restrictions") or []:
                if rule.get("type") == "limit":
                    limits[rule.get("limit")] += 1
                elif rule.get("type") == "disabled":
                    disabled[rule.get("payment_type")] += 1
    for grade in sorted(by_grade):
        print(f"  {grade:9} " + ", ".join(f"{key}={value}" for key, value in by_grade[grade].most_common()))
    print(f"  limit restrictions (litres -> grade entries): {dict(limits.most_common(6))}")
    print(f"  sale switched off (payment type -> grade entries): {dict(disabled)}")
    grade_stamps = [_iso(fuel.get("last_transaction_at")) for row in stations for fuel in row.get("fuels") or []]
    station_stamps = [_iso(row.get("last_alfa_transaction_time")) for row in stations]
    print(f"  per-grade last_transaction_at: {dict(Counter(_bucket(t, now) for t in grade_stamps))}")
    print(f"  station last_alfa_transaction_time: {dict(Counter(_bucket(t, now) for t in station_stamps))}")
    known = [t for t in grade_stamps + station_stamps if t]
    if known:
        newest = max(known)
        print(f"  newest timestamp {newest.isoformat()} ({(now - newest).total_seconds() / 60:.0f} min ago)")


def trimmed(payload: dict[str, Any], max_bytes: int = 48_000) -> dict[str, Any]:
    city = [row for row in payload["stations"] if _inside(row, CITY_AOI)]
    city.sort(key=lambda row: str(row.get("last_alfa_transaction_time") or ""), reverse=True)
    count = min(40, len(city))
    while True:
        sample = {
            "captured_at": payload["captured_at"],
            "source": payload["source"],
            "russia_total": payload["russia_total"],
            "stations_total_spb_lo": len(payload["stations"]),
            "stations_in_sample": count,
            "stations": city[:count],
        }
        size = len(json.dumps(sample, ensure_ascii=False, indent=1).encode("utf-8"))
        if count <= 1 or size <= max_bytes:
            return sample
        count -= 1


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--direct", action="store_true", help="ignore HTTPS_PROXY")
    parser.add_argument("--save", type=Path, help="write the SPb/LO payload")
    parser.add_argument("--sample", type=Path, help="write a trimmed sample")
    args = parser.parse_args()
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass
    payload = collect(direct=args.direct)
    summary(payload)
    if args.save:
        args.save.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    if args.sample:
        args.sample.write_text(json.dumps(trimmed(payload), ensure_ascii=False, indent=1), encoding="utf-8")
    return 0 if payload["stations"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
