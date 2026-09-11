# SPB Fuel Intelligence — результаты Phase 0

Дата разведки: **10–11 сентября 2026 года**. Phase 0 завершён; разработка frontend, Evidence Engine и полноценного приложения не начиналась.

## Решение

**Переходить к ограниченному MVP можно.** Уже доказано, что по конкретной АЗС и конкретной марке топлива можно получать текущие сигналы из нескольких публичных источников. Но нельзя обещать «точное realtime-наличие на каждой АЗС»: строго подтверждаемое свежее покрытие сильно зависит от марки и составляет от **7,3% для АИ-98** до **46,4% для ДТ** от станций, где эта марка есть в каталоге.

Правильный продукт — не ещё одна карта с бинарным «бензин есть/нет», а **интерпретатор доказательств**:

- отдельный статус для АИ-92, АИ-95, АИ-98, АИ-100 и ДТ;
- возраст последнего сигнала и срок его пригодности;
- тип факта: официальный остаток, сообщение водителя, платёж конкретной марки, платёж неизвестной марки, каталог или цена;
- очередь, лимит и режим продажи, когда источник это сообщает;
- конфликт источников вместо скрытого усреднения;
- понятное «Почему такой результат?» с provenance;
- честное `НЕТ СВЕЖИХ ДАННЫХ` вместо выдуманного `НЕТ`.

Без этих правил приложение действительно не отличалось бы от стандартных карт. С ними оно отвечает на другой вопрос: не «какая АЗС рядом и что она обычно продаёт», а «насколько обоснованно считать, что **нужная мне марка** доступна **сейчас**, и почему».

## Итог классификации

### Реально доступны сейчас — GREEN

| Источник | Что реально отдаёт | Главная оговорка |
|---|---|---|
| Sber fuel map | 913 stations AOI; station ID/2GIS ID, координаты, адрес, сеть, per-grade status, `lastFuelingAt`, update time, limit, crowd state | Точная модель Sber/FuelUp не раскрыта; stale false нельзя трактовать как актуальное NO |
| Gazpromneft | Официальный station detail: per-grade `rest.avail`, `since`, delivery, price и price timestamp; 105/105 AOI details успешно получены | Национальный список; AOI фильтруется локально; 97 stations имеют explicit stock хотя бы по одной марке |
| GdeBenz | Bbox, station IDs, марки, crowd Y/N/QUEUE, timestamp в comments, очередь, лимит, on-site/reliable, prices | Для корректной freshness нужен detail/recent, не только список |
| Benzas | Станции, fresh crowd state, марки, очередь, comments, price source | В sample price пришла от Benzuber и не является crowd stock evidence |
| BenzinEst | Per-grade AVAILABLE/OUT/UNKNOWN, confidence, prices, limits, report age/count | Зависимый агрегатор: imported/GdeBenz/Toplivo/Sber/MultiGO |
| TutBenz | Per-grade parser/crowd state, prices, timestamps, queue и T-Bank transaction hints | Generic payment не доказывает конкретную марку и нормализуется в `LIKELY` |
| GdeBenzin.rf | Bbox map, grade states, prices, confidence, очередь, `card_only`, timestamps | Префиксы IDs показывают upstream T-Bank/2GIS/Sber/Yandex/GdeBenz |
| Benzonavt | Grade status, confidence, conflicts, prices, limits, очередь и report origins | Не весь upstream раскрыт; агрегат нельзя считать целиком независимым |
| BenzinKarta | 806 AOI markers; раскрытый station detail со статусами 92/95/ДТ, ценами, возрастом, очередью, confidence | Один бесплатный station reveal в день на устройство; для collector нужен договор/иной легитимный доступ |
| Toplivo Ryadom | Direct-labelled rest rows и prediction/payment timestamps для большого числа stations/grades | Зависит от GPN/LUKOIL/Teboil/Alfa/T-Bank/Sber/2GIS; независимо сверена только GPN sample |

Все десять помечены `GREEN_VERIFIED_HTTP`. `GREEN_VERIFIED_BROWSER` не потребовался: найденные рабочие data endpoints удалось повторить прямым HTTP. Raw response и параметры запроса сохранены в `tests/fixtures/<source>/2026-09-11-spb.json`.

### Требуют дополнительного доступа — YELLOW

| Источник | Статус | Что требуется |
|---|---|---|
| Benzuber | `YELLOW_NEEDS_KEY` | Договор/онбординг и выданные `URL_BZ` + `apikey`; документированы stations, products, columns/nozzles, price, status и ping |
| Benzovoz | `YELLOW_NEEDS_MANUAL_HAR` | HAR с принадлежащего пользователю iPhone/устройства без обхода защиты; затем replay конкретного station response |

Benzuber нельзя повысить до GREEN по одной документации. Даже после ключа `pump active`, `nozzle configured` и `product configured` останутся checkout/equipment facts, а не автоматическим доказательством физического остатка.

### Не подходят для realtime collector — RED

| Источник | Статус | Что произошло |
|---|---|---|
| Alfa Fuel | `RED_BLOCKED` | Публичная страница дважды не прошла TLS trust в curl; Chrome также показал certificate authority error; station flow находится в приватном банковском приложении |
| T-Bank Fuel | `RED_BLOCKED` | Публичная страница 200, но browser capture не выявил анонимного station list/detail; приватная банковская авторизация запрещена правилами Phase 0 |
| AZS Radar | `RED_BLOCKED` | Две попытки завершились `SEC_E_CERT_EXPIRED`; TLS не обходился |
| benzin.live | `RED_BLOCKED` | Оба публичных JSON route вернули HTTP 500 из-за исчерпанной дневной Cloudflare D1 read quota |
| LUKOIL | `RED_NO_REALTIME_DATA` | API работает, но это station/fuel catalog; price в sample `null`, grade stock timestamp отсутствует |
| Teboil | `RED_NO_REALTIME_DATA` | Региональный endpoint работает; только station + configured fuels |
| Rosneft/PTK | `RED_NO_REALTIME_DATA` | 132 AOI stations с ценами/датой и ассортиментом, но без stock now |
| Tatneft | `RED_NO_REALTIME_DATA` | 81 AOI stations с официальными ценами/марками, но без stock now |
| Kirishiavtoservis | `RED_NO_REALTIME_DATA` | 30 AOI stations из embedded HTML, цены и ассортимент, но нет availability |
| BenzinRadar analogue | `RED_NO_REALTIME_DATA` | Endpoint вернул 983 AOI records, но ни одного свежего non-UNKNOWN grade observation за 24 часа |

Yandex и 2GIS классифицированы `CONTROL_ONLY`: они полезны для station identity, адреса и ручной сверки. В частности, Sber station ID sample совпадает с 2GIS branch ID, поэтому эти домены нельзя считать независимыми stock sources.

## Метод проверки

1. Открыты публичные интерфейсы и изучены frontend scripts/network requests.
2. Для Sber и T-Bank записан browser network log. Sber показал station XHR; T-Bank public page — только маркетинговый поток без station API. Alfa не прошла безопасную TLS-проверку браузера.
3. Найденные endpoint повторены прямым `curl` с проверкой системного TLS; CAPTCHA, login и сертификаты не обходились.
4. Для geo-capable sources использован малый bbox Петербурга, затем соседний bbox или полный AOI, чтобы доказать изменение выборки.
5. Для national-only API Россия была получена только там, где сервер не предложил AOI-параметр; анализ сразу отфильтрован по AOI.
6. Для каждого источника сохранён sanitized fixture с request URL/method, HTTP status, capture time, исходным SHA-256 и минимальным реальным body.
7. Один и тот же endpoint запрошен повторно. Динамические Sber/GdeBenz responses изменили hash ожидаемо; стабильные справочники совпали. Один второй LUKOIL request завершился timeout после ранее успешных ответов и сохранён как transient failure, а не скрыт.
8. Fixtures и live-снимок пропущены через консервативные normalizers и полный набор из 31 unit-теста Evidence Engine, normalizers, repository и matcher.

AOI:

```text
west  29.50
south 59.60
east  31.10
north 60.35
```

Это Санкт-Петербург и ближайшая Ленинградская область. Denominator — 913 station records из публичного ответа Sber, использующего стабильные 2GIS branch IDs. Это наиболее практичный доступный baseline, но не государственный или канонический реестр.

## Живые примеры station-level данных

| Источник | Реальная тестовая АЗС | Проверенные поля и вывод |
|---|---|---|
| Sber | ID `70000001051057670`, Gazpromneft, Школьная ул., 100, `59.990815, 30.221422` | АИ-92 `AVAILABLE`, ДТ `AVAILABLE`, лимит 40 л; АИ-95 имел stale status и нормализован в `UNKNOWN` |
| Gazpromneft | ID `1108`, Дунайский пр., 29, `59.83239, 30.36994` | В свежем batch АИ-92/95/G-95 и летний ДТ `AVAILABLE`; цены 65,61 / 70,52 / 72,52 / 79,95 ₽ и official rest fields. Более ранний fixture остаётся воспроизводимым примером изменения статуса во времени |
| LUKOIL | ID `1883`, Кушелевская дор., 9А, `59.990538, 30.376595` | АИ-92/95/100/ДТ — только configured fuels, поэтому все `UNKNOWN` для current stock |
| GdeBenz | ID `usr_S_fJptEOyCs`, LUKOIL, Софийская ул., 59, `59.862982, 30.416660` | Именованные crowd reports по 92/95/ДТ, on-site/reliable flags; другие comments показывают QUEUE, диапазон очереди и лимит 30 л |
| Benzas | ID `10605980726`, Санкт-Петербург, `59.989845, 30.325743` | Crowd queue по нескольким маркам с timestamp; insight отдельно указывает price source `benzuber` |
| BenzinEst | ID `100306471`, Rosneft, Северная пл., 2, `60.023472, 30.407043` | Per-grade OUT/AVAILABLE/UNKNOWN, price, confidence, limit 30 л и report counts; source=`imported` |
| TutBenz | UUID `020d219b-f308-4024-b286-2157a3aed213`, `59.950214, 30.384414` | Одинаковый T-Bank transaction time проецировался на 92/95 — normalizer понизил оба до `LIKELY` |
| GdeBenzin.rf | ID `tb:01KX3GXVAE5Z0Z1VDB5GG2VDKN`, `60.030851, 30.342187` | AI-92/95/100 payment projections, prices/confidence; `tb:` сохранён как upstream, statuses только `LIKELY` |
| Benzonavt | ID `7`, Gazpromneft, Руставели, 54А, `60.031898, 30.431773` | ДТ current, 92/95/98/100 out, цены, лимиты, confidence и reports с origin |
| BenzinKarta | ID `w170262011`, `59.840134, 30.298282` | В исходном detail 92/95/ДТ были `AVAILABLE`, цены, timestamp, confidence 84 и recent queue; более поздний повтор показал AI-92 `yes`, AI-95/ДТ `queue`, а две немедленные повторные выдачи совпали; quota left=0 |

Эти примеры не являются демонстрационными mock-данными: они вырезаны из фактических responses и лежат в fixtures.

## Реальный охват

### На уровне локаций

| Срез | Станций из 913 | Доля | Смысл |
|---|---:|---:|---|
| Свежий/текущий signal с известным provenance | 502 | **55,0%** | Есть динамический station-level сигнал; он не обязательно доказывает каждую марку |
| С добавлением зависимых агрегаторов | 709 | **77,7%** | Полезно как assisted coverage, но повторы upstream не независимы |

Сопоставление сделано аналитически: ближайшая точка ≤75 м и отбрасывание известных конфликтов бренда. Это оценка Phase 0, а не будущий canonical registry. Реализация обязана использовать official IDs + 2GIS/OSM/external aliases + адрес/бренд и не объединять станции только по расстоянию.

### На уровне конкретной марки

| Марка | Stations с маркой в catalog baseline | Strict fresh, известный provenance | Current view + GdeBenz без list timestamp | С зависимыми агрегаторами |
|---|---:|---:|---:|---:|
| АИ-92 | 633 | 164 (**25,9%**) | 179 (28,3%) | 591 (93,4%) |
| АИ-95 | 704 | 171 (**24,3%**) | 192 (27,3%) | 637 (90,5%) |
| АИ-98 | 137 | 10 (**7,3%**) | 11 (8,0%) | 136 (99,3%) |
| АИ-100 | 282 | 43 (**15,2%**) | 46 (16,3%) | 272 (96,5%) |
| ДТ | 623 | 289 (**46,4%**) | 327 (52,5%) | 580 (93,1%) |

Как читать таблицу:

- `Strict fresh` использует station+grade evidence с пригодным timestamp из известных provenance (консервативное ядро Sber + свежий Benzas). GdeBenz list не имеет timestamp самого mark, поэтому он вынесен в отдельный current-view столбец; detail можно догружать по конкретной станции.
- Высокие 90–99% — **не** доказательство независимого realtime-покрытия. Это потенциальная видимость через BenzinEst/GdeBenzin/Benzonavt/Toplivo и те же банковские/crowd upstreams. Такой слой годится для `СКОРЕЕ ЕСТЬ/НЕТ`, но не для маркетингового обещания «подтверждено».
- Таблица strict coverage выше зафиксирована для первоначального единого Phase-0 окна и не пересчитана задним числом с более поздним batch, чтобы не смешивать capture windows. Отдельный текущий batch «Газпромнефти» теперь проверен полностью: 105/105 details, 97 с explicit stock и 8 только с `UNKNOWN`.
- LPG встречается в нескольких каталогах/crowd schemas, но обязательные метрики рассчитаны для 92/95/98/100/ДТ.

## Что должен показывать MVP

Для каждой пары `station × grade` допустимы семь пользовательских состояний из задания:

| Пользовательский статус | Минимальная доказательная семантика |
|---|---|
| `МОЖНО ЗАПРАВИТЬСЯ` | свежий official stock или достаточное независимое grade-specific подтверждение |
| `СКОРЕЕ ЕСТЬ` | один свежий crowd/grade-payment signal или согласованные зависимые hints |
| `ДАННЫЕ РАСХОДЯТСЯ` | свежие Y и N из разных первичных clusters |
| `ОГРАНИЧЕННАЯ ПРОДАЖА` | явный литровый лимит, талоны/карты или ограничение в report |
| `СКОРЕЕ НЕТ` | один свежий, но не окончательный grade-specific N |
| `ПОДТВЕРЖДЕНО НЕТ` | свежий official N или достаточное независимое grade-specific подтверждение |
| `НЕТ СВЕЖИХ ДАННЫХ` | только catalog/price/stale/generic activity или вообще нет evidence |

Обязательная карточка АЗС:

```text
Газпромнефть · Дунайский, 29 · 3,1 км
АИ-95  МОЖНО ЗАПРАВИТЬСЯ  обновлено 18 мин назад
ДТ     ДАННЫЕ РАСХОДЯТСЯ обновлено 18 мин назад
Очередь: данных нет · Лимит: данных нет
Почему: официальный остаток Gazpromneft подтверждает ДТ, но свежий crowd-source ему противоречит
```

Внутренний score пользователю не нужен. Ему нужны итог, возраст, ограничения и короткое объяснение происхождения.

## Рекомендованный состав MVP

1. **Primary dynamic:** Gazpromneft official, Sber, GdeBenz, Benzas.
2. **Assisted overlays:** TutBenz, GdeBenzin.rf, BenzinEst, Benzonavt, Toplivo Ryadom — только с upstream labels и дедупликацией.
3. **Catalog/identity:** LUKOIL, Teboil, Rosneft/PTK, Tatneft, Kirishi, 2GIS/OSM aliases. Каталог определяет возможные марки, но не current status.
4. **On-demand only:** BenzinKarta до коммерческого соглашения; один бесплатный reveal не превращать в collector.
5. **Later access:** Benzuber после легитимного API key; Benzovoz после ручного HAR владельца устройства.

Go-критерий для MVP: показывать unknown и provenance как первоклассные состояния. No-go для обещания «мы знаем остатки на всех АЗС в реальном времени».

## Артефакты и воспроизводимость

- `docs/source-capability-matrix.md` — полная классификация и capability matrix.
- `docs/provenance-map.md` — upstream clusters и правила недвойного счёта.
- `config/sources.yaml` — машиночитаемый реестр 24 источников.
- `tests/fixtures/` — 24 source fixtures + 9 журналов probe evidence, включая sanitized browser network traces; секреты/cookies/IP/PII не сохранены.
- `src/normalizers.py` — короткий нормализатор evidence semantics.
- `tests/test_normalizers.py` — 15 тестов, включая stale/UNKNOWN, catalog-vs-stock и generic-payment semantics.

Команда проверки:

```powershell
python -m unittest discover -s tests -v
```

Результат текущего снимка: **15 tests, OK**.

## Ограничения и STOP

- Публичные endpoint и квоты могут измениться; production polling требует backoff, кеширования и проверки условий использования каждого сервиса.
- Phase 0 доказывает техническую доступность и семантику, но не предоставляет договорных прав на массовое использование.
- Coverage — измерение одного временного снимка и доступного baseline, не SLA.
- Alfa/T-Bank private login, CAPTCHA, TLS failures и paywalls не обходились.
- Полноценный frontend, canonical matcher, provenance deduplicator и Evidence Engine **не реализованы**, как требует stop condition.

**Итог:** техническая база для полезного evidence-first MVP существует. Его конкурентное преимущество — не больше цветных меток, а более строгая и объяснимая информация о конкретной марке: текущий сигнал, свежесть, ограничения, конфликт и происхождение. Phase 0 на этом остановлен.
