# SPB Fuel Intelligence — матрица возможностей источников

Снимок: **11 сентября 2026 года**, AOI `west=29.50, south=59.60, east=31.10, north=60.35`. Каждый `GREEN` подтверждён живым HTTP-запросом, повторным запросом и сохранённым sanitized fixture. `GREEN` означает «контракт данных доказан», а не «источник независим» и не «его разрешено/разумно часто опрашивать без соглашения».

## Легенда

- `REALTIME` — есть явный текущий station+grade status или датированное наблюдение.
- `INDIRECT` — платёж/активность на АЗС, но товарная позиция не доказана.
- `CATALOG` — штатный ассортимент или цена; это **не** наличие сейчас.
- `Y/N/U/Q/L` — yes / no / unknown / queue / limited.
- Разрешены только статусы Phase 0: `GREEN_VERIFIED_HTTP`, `GREEN_VERIFIED_BROWSER`, `YELLOW_NEEDS_KEY`, `YELLOW_NEEDS_MANUAL_HAR`, `CONTROL_ONLY`, `RED_BLOCKED`, `RED_NO_REALTIME_DATA`.

## Доступ и проверенный транспорт

| # | Источник | Статус | Проверенный interface / endpoint | Доступ и геофильтр | Station-level | Причина статуса |
|---:|---|---|---|---|:---:|---|
| 1 | Benzuber | `YELLOW_NEEDS_KEY` | Документация `/v1/stations`, `/{id}/columns`, `/price`, `/status`, `/ping` | Выданные партнёру `URL_BZ` + `apikey`; документирован `stationId`, bbox не доказан | Да | Контракт подробный, но без выданного ключа живой station response невозможен |
| 2 | Alfa Fuel | `RED_BLOCKED` | [Публичная страница](https://alfabank.ru/retail/azs/) | Страница не прошла TLS-проверку ни в curl, ни в Chrome; рабочий поток — приватное банковское приложение | Не доказано | Анонимного API не найдено; приватная авторизация по правилам задания означает RED |
| 3 | T-Bank Fuel | `RED_BLOCKED` | [Публичная страница](https://www.tbank.ru/gorod/fuel/); browser network capture | 82 сетевых события публичной страницы, station list/detail отсутствуют; поток в приватном приложении | Не доказано | Переиспользуемого анонимного station endpoint нет |
| 4 | Sber fuel map | `GREEN_VERIFIED_HTTP` | `GET https://sberazs.ru/api/stations?bbox=…`; `GET /api/stations/{id}`; `/meta` | Без входа; bbox | Да | Повторные bbox/detail responses содержат текущие поля по маркам |
| 5 | LUKOIL | `RED_NO_REALTIME_DATA` | `GET https://auto.lukoil.ru/api/cartography/GetSearchObjects?form=gasStation`; `/GetObjects?ids=gasStation1883&lng=RU` | Без входа; национальный список, AOI локально | Да | Живой API содержит только каталог топлива; `GasStationStatus` — работа станции, не остаток марки |
| 6 | Gazpromneft | `GREEN_VERIFIED_HTTP` | `POST https://gpnbonus.ru/api/stations/list`; `POST /api/stations/{GPNAZSID}` | Без входа; нужны обычные UA/Referer; список национальный, затем AOI-фильтр | Да | 105/105 AOI details дали HTTP 200; 97 содержат explicit `rest.avail` хотя бы для одной марки |
| 7 | Teboil | `RED_NO_REALTIME_DATA` | `POST https://azs.teboil.ru/map/ajax/map.php`, `cityId[]=353/354` | Без входа; город/регион | Да | Есть station ID и ассортимент, но нет stock status/timestamp |
| 8 | GdeBenz | `GREEN_VERIFIED_HTTP` | `GET https://gdebenz.ru/api/stations?lat1=…&lon1=…&lat2=…&lon2=…`; `/api/comments/{id}/recent` | Без входа; bbox | Да | Bbox + detail дают именованные марки, Y/N/Q, лимит и датированный crowd report |
| 9 | Benzas | `GREEN_VERIFIED_HTTP` | `GET https://benzas.ru/api/stations`; `/api/station/{id}/fuels`, `/recent`, `/insight` | Без входа; список национальный, AOI локально | Да | Текущие crowd statuses повторяемы; provenance цены виден отдельно |
| 10 | BenzinEst | `GREEN_VERIFIED_HTTP` | `GET https://benzinest.ru/api/stations?bbox={s},{w},{n},{e}`; `/api/stations/{id}` | Без входа; bbox | Да | Доступны status/confidence/price/limit/report age; это зависимый агрегатор |
| 11 | TutBenz | `GREEN_VERIFIED_HTTP` | `GET https://tutbenz.app/api/stations?bbox={w},{s},{e},{n}&prices=1`; `/api/stations/{uuid}`; `/api/stream` | Без входа; bbox/stream | Да | Есть parser/crowd state и payment hints; платёж без SKU не повышается выше `LIKELY` |
| 12 | GdeBenzin.rf | `GREEN_VERIFIED_HTTP` | `GET https://xn--90addebmh2bc.xn--p1ai/api/v1/map?bbox={s},{w},{n},{e}&zoom=11&price=1&confidence=1` | Без входа; bbox | Да | Station+grade rows живые; ID раскрывают зависимость от T-Bank/2GIS/Sber/Yandex/GdeBenz |
| 13 | AZS Radar (`azs-radar.ru`) | `RED_BLOCKED` | `GET https://azs-radar.ru/` | Две попытки; TLS certificate expired, обход TLS не применялся | Нет | Публичный интерфейс нельзя безопасно открыть и API не доказан |
| 14 | Benzonavt | `GREEN_VERIFIED_HTTP` | `GET https://benzonavt.ru/api/v1/stations?bbox={s},{w},{n},{e}`; `/stations/{id}`, `/nearest`, `/networks` | Без входа; bbox/radius | Да | Rich detail: grade status, conflicts, confidence, очередь, лимит, price и reports |
| 15 | Benzovoz | `YELLOW_NEEDS_MANUAL_HAR` | [iOS App Store](https://apps.apple.com/ru/app/id6790108201) | Веб-API не найден; нужен HAR с принадлежащего пользователю устройства | Заявлено | Описание обещает все марки, 3 банка, GdeBenz и 7-минутное обновление, но ответа API нет |
| 16 | BenzinKarta | `GREEN_VERIFIED_HTTP` | `GET https://benzinkarta.ru/api/stations?bbox={w},{s},{e},{n}`; `GET /api/station/w170262011` | Без login; один full reveal в день на устройство, затем paywall | Да | Full detail доказан, но бесплатная квота делает автоматический AOI collector непригодным |
| 17 | Rosneft / PTK | `RED_NO_REALTIME_DATA` | `GET https://rosneft-azs.ru/front-api/stations` | Без входа; национальный список, AOI локально | Да | Официальные station/fuel/price rows есть, текущего остатка нет |
| 18 | Tatneft | `RED_NO_REALTIME_DATA` | `GET https://api2.gs.tatneft.ru/api/v2/azs/`; `/features/`, `/fuel_types/` | Без входа; национальный список, AOI локально | Да | Официальный каталог и цены, но не availability now |
| 19 | Kirishiavtoservis | `RED_NO_REALTIME_DATA` | `GET https://kirishiavtoservis.ru/stations/`, embedded `data-markers` | Без входа; полный HTML-список, AOI локально | Да | Station ID/координаты/цены есть, realtime semantics нет |
| 20 | Toplivo Ryadom | `GREEN_VERIFIED_HTTP` | `GET https://tboo.ru/gpn/data.json`; `/predict.json`; `/gpn/api/tbank/near` | Без входа; национальные файлы + near, AOI локально | Да | Rest/prediction rows живые, но почти весь слой зависит от сетей и банков |
| 21 | Yandex Maps | `CONTROL_ONLY` | [Публичный поиск АЗС](https://yandex.ru/maps/2/saint-petersburg/search/%D0%90%D0%97%D0%A1/) | Публичный UI; повторяемый анонимный stock API не проверен | Да, как справочник | Только identity/manual control, не источник текущего наличия |
| 22 | 2GIS | `CONTROL_ONLY` | [Публичный поиск АЗС](https://2gis.ru/spb/search/%D0%90%D0%97%D0%A1) | Публичный UI; повторяемый анонимный stock API не проверен | Да, как справочник | Branch ID полезен для identity; те же IDs уже присутствуют у Sber |
| 23 | BenzinRadar (`benzinradar.ru`, дополнительный аналог) | `RED_NO_REALTIME_DATA` | `GET https://benzinradar.ru/api/stations?lat1=…&lon1=…&lat2=…&lon2=…` | Без входа; bbox | Да | 983 записи, но 0 свежих non-UNKNOWN grade observations за 24 часа |
| 24 | benzin.live (дополнительный аналог) | `RED_BLOCKED` | `GET /api/radar/stations?lat=59.94&lon=30.32&radius=.12&fuel=ai95`; `GET /api/stations` | Без входа; radius заявлен | Не доказано в ответе | Оба endpoint вернули HTTP 500: исчерпана дневная Cloudflare D1 read quota |

## Семантика данных

| Источник | Марки в ответе | Динамика | Timestamp | Цена | Свободно / карты | Очередь | Лимит | Provenance / независимость | Рекомендуемый polling |
|---|---|---|:---:|:---:|:---:|:---:|:---:|---|---|
| Benzuber | 92/95/98/100/ДТ — по продуктам партнёра | equipment/checkout, **не доказанный stock** | Частично | Да | Checkout semantics | Нет | Возможно в checkout | Direct после договора | Только по partner limits |
| Sber | 92/95/98/100/ДТ | Y/N/U + stale | Да | В sample нет | Не раскрыто | `crowdState` | Да | 2GIS catalog + Sber/FuelUp activity; mixed | 5 мин + backoff |
| Gazpromneft | 92/95, G-95, летний ДТ; возможны 98/100 на других АЗС | Explicit Y/N | Да (`since`, delivery, price update) | Да | Не раскрыто | Нет | Нет | Official/direct | 5 мин по AOI IDs |
| GdeBenz | 92/95/98/100/ДТ/LPG, как указано людьми | Y/N/Q | Да в detail comments | Да | `on_site`; точная форма продажи текстом | Да | Да | Own crowd; цены могут быть imported | 2–5 мин |
| Benzas | 92/95/98/100/ДТ/LPG | Y/N/Q | Да | Да | Не всегда | Да | В comments | Crowd independent; sample price=`benzuber` | 2–5 мин |
| BenzinEst | 92/95/98/100/ДТ | AVAILABLE/OUT/UNKNOWN | Да | Да | Может быть source text | Да/частично | Да | GdeBenz/Toplivo/Sber/MultiGO/imported; dependent | 5 мин, upstream dedup |
| TutBenz | 92/95/98/100/ДТ | parser/crowd + INDIRECT payment | Да | Да | Не доказано по payment | Да | Частично | Mixed + T-Bank; dependent rows marked | stream или 2–5 мин |
| GdeBenzin.rf | 92/95/98/100/ДТ/LPG | aggregated status | Да | Да | `card_only` | small/medium/large | Частично | T-Bank/2GIS/Sber/Yandex/GdeBenz; dependent | 5 мин, upstream dedup |
| Benzonavt | 92/95/98/100/ДТ | Y/N/conflict | Да | Да | В report origin/details | Да | Да | Crowd + imported/bank; mixed | 5 мин, keep report origin |
| BenzinKarta | 92/95/ДТ в раскрытом sample; schema поддерживает прочие | Y/N + confidence | Да | Да | Не раскрыто в sample | Да | Частично | Не раскрыт; independence unknown | Не опрашивать без соглашения |
| Toplivo Ryadom | 92/95/100/ДТ; 98 не обнаружен в prediction AOI | rest + prediction tiers | Да | Да | Не доказано | Нет/частично | Нет | GPN/LUKOIL/Teboil + Alfa/T-Bank/Sber/2GIS; dependent | 5 мин + conditional GET |
| LUKOIL | 92/95/100/ДТ, по станции | CATALOG | Нет stock TS | В sample `null` | Нет | Нет | Нет | Official catalog | 12–24 ч |
| Teboil | 92/95/98/100/ДТ, по станции | CATALOG | Нет | Нет в feed | Нет | Нет | Нет | Official catalog | 12–24 ч |
| Rosneft/PTK | 92/95/98/100/ДТ/LPG, где продаётся | CATALOG + price | Только дата цены | Да | Нет | Нет | Нет | Official catalog | 12–24 ч |
| Tatneft | 92/95/98/100/ДТ/LPG, где продаётся | CATALOG + price | Да для цены | Да | Нет | Нет | Нет | Official catalog | 12–24 ч |
| Kirishiavtoservis | 92/95/98/100/ДТ, где продаётся | CATALOG + price | Нет stock TS | Да | Нет | Нет | Нет | Official catalog | 12–24 ч |

## Фактический объём AOI

| Источник | Station records в AOI | Станции с динамическими данными | Что именно посчитано |
|---|---:|---:|---|
| Sber | 913 | 124 | хотя бы одна текущая grade-запись |
| Gazpromneft official | 105 | 97 explicit, 8 только UNKNOWN | Все 105 AOI station details опрошены; 70 Санкт-Петербург + 35 ближняя область/поселения |
| GdeBenz | 741 | 216 raw / 208 matched | positive или queue с именованной маркой |
| Benzas | 729 | 287 raw / 284 matched | свежий ≤24 ч positive/queue grade status |
| BenzinEst | 676 | 570 raw / 563 matched | свежий aggregated grade status |
| TutBenz | 769 | 363 raw / 356 matched | parser/payment/crowd activity ≤24 ч; payment может быть только indirect |
| GdeBenzin.rf | 879 | 517 raw / 509 matched | grade row ≤24 ч |
| Benzonavt | 782 | 693 raw / 658 matched | grade evidence ≤24 ч |
| BenzinKarta | 806 locked markers | 1 раскрытая | бесплатная квота исчерпана после доказательства |
| Toplivo Ryadom | 357 direct / 835 prediction | 487 raw / 482 matched | dynamic prediction ≤24 ч |
| LUKOIL | 122 | 0 | catalog only |
| Teboil | 73 (47 СПб + 26 ЛО) | 0 | catalog only |
| Rosneft/PTK | 132 | 0 | catalog/price only |
| Tatneft | 81 | 0 | catalog/price only |
| Kirishiavtoservis | 30 | 0 | catalog/price only |
| BenzinRadar analogue | 983 | 0 | нет свежих non-UNKNOWN observations |

`matched` — оценка сопоставления с denominator Sber/2GIS по ближайшей точке ≤75 м с отбрасыванием известных конфликтов бренда. Это только аналитика покрытия Phase 0: будущий canonical matcher не должен объединять станции одним расстоянием.

Полные параметры каждого источника в машиночитаемом виде находятся в `config/sources.yaml`; raw evidence — в `tests/fixtures/`.

## Добавлено 14 сентября 2026

Все пять проверены живыми запросами из России и из-за рубежа, без ключа и входа. Строки 2 (Alfa Fuel) и 13 (AZS Radar) выше описывают Phase 0 и устарели: Альфа-Банк отдаёт публичный список, если доверять корневому сертификату Минцифры, а сайт азс-радара переехал на азсрадар.рф. Объём — из одного снимка 14 сентября, 21:50 МСК; урезанные образцы ответов — в `tests/fixtures/_live-samples/`.

| Источник | Endpoint | Доступ | Станций СПб+ЛО / AOI | Марки и статусы | Время | Очередь | Лимит | Provenance | Опрос |
|---|---|---|---:|---|---|:---:|:---:|---|---|
| 2ГИС «Статус АЗС» | `GET benzin.api.2gis.ru/api/v1/stations?minLat=…&maxLon=…`, bbox ≤ 5° | без ключа; Origin и Referer 2gis.ru, gzip | 1324 / 891 | 92/95/98/100/ДТ/газ: есть / нет / null; «закрыта по расписанию» | время последней отметки по марке | до 25 / 25–50 / больше 50 | да | отметки водителей 2ГИС; гдебензин.рф и tboo.ru повторяют | каждый прогон, 2 запроса |
| ППР TransitCard | `GET locator.transitcard.ru/web/v2/point/transpose-list?…&services=…` | без ключа | 748 / 535 | 92/95/98/100/ДТ: available / has_limit / possibly_available / unavailable | нет: статус «сейчас» | нет | флаг без литров | транзакции топливных карт; состояние продаж то же, что у Альфы | каждый прогон, 5 запросов |
| Альфа-Банк | `GET alfabank.ru/api/v1/azs-stations/public/stations` | без ключа; корень Минцифры | 899 / 645 (16 375 по России) | 92/95/ДТ и общее ведро 98_100: available / probably_unavailable / unavailable / closed / unknown | у статуса нет; время последней оплаты по марке | нет | лимиты Benzuber | оплаты Альфы и Benzuber; tboo.ru повторяет время | раз в 15–20 мин |
| азсрадар.рф | `GET xn--80aaapn8cdd.xn--p1ai/api/stations?minLat=…&maxLng=…` | без ключа | 1061 / 681 | 92/95/98/ДТ: ok / empty / no_data; техперерыв | время отметки станции | до 5 / 5–20 / больше 20 | да | свои водители; поля Т-Банка и Сбера не берутся | каждый прогон |
| AZS MAP | `GET azsmap.com/api/data-model.js?city=lenobl` и `city=spb` | без ключа; JSON внутри скрипта | 1500 (потолок файла) / 1339 | 92/95/100/ДТ/газ: have / low / none / stale | возраст отметки и цены в минутах | нет | нет | часть статусов и цены — из ГдеБЕНЗ | каждый прогон, 2 запроса |

Что из этого голосует и что считается копией, описано в `docs/provenance-map.md`. Не подключены: Benzuber (целиком внутри списка Альфы), pinggi.ru (= Т-Банк), топливныйрадар.рф и gdebenzine.ru (= ГдеБЕНЗ), benzokarta.com (= ППР), MultiGO и FUELUP (нет живого статуса).
