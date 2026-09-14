# SPB Fuel Intelligence — карта происхождения данных

Снимок: 11 сентября 2026 года. Карта отделяет **транспортный источник** (откуда скачан JSON) от **первичного наблюдения** (кто реально видел остаток, платёж или сообщение водителя). Пять API, повторивших один факт Sber/T-Bank, дают один provenance cluster, а не пять голосов.

## Наблюдаемые зависимости

```mermaid
flowchart LR
    GPN[Gazpromneft official\nstock + price] --> TR[Toplivo Ryadom]
    GPN --> BE[BenzinEst]

    LK[LUKOIL official\ncatalog verified; claimed rest upstream] --> TR
    TB[Teboil official\ncatalog verified; claimed rest upstream] --> TR

    S[Sber / FuelUp activity] --> TR
    S --> GBF[GdeBenzin.rf]
    S --> BE
    DG[2GIS branch catalog] --> S
    DG --> GBF

    TBT[T-Bank transaction] --> Tut[TutBenz]
    TBT --> TR
    TBT --> GBF

    AL[Alfa grade/payment timestamps] --> TR

    GDB[GdeBenz crowd] --> GBF
    GDB --> BE
    GDB --> BVZ[Benzovoz — claimed]

    BNZ[Benzas crowd] --> BNZP[Benzuber price layer\nin sample insight]
    TR --> BE
    MG[MultiGO / imported] --> BE

    YM[Yandex identity] --> GBF

    CrowdB[Benzonavt crowd] --> BNA[Benzonavt]
    ImportB[Imported/data/bank origins] --> BNA

    BKU[Undisclosed upstream] --> BK[BenzinKarta]

    TGB[2GIS «Статус АЗС»\nотметки водителей] --> GBF
    TGB --> TR
    AL --> AFM[Alfa-Bank map\nstatus + Benzuber limits]
    PPR[ППР / TransitCard\ncard sales state] -. одно состояние продаж .- AFM
    GDB --> AZM[AZS MAP]
```

Стрелка означает наблюдаемую или самим интерфейсом заявленную зависимость. Для Toplivo Ryadom официальным detail cross-check подтверждён слой Gazpromneft. Заявления о direct-rest LUKOIL/Teboil не удалось независимо подтвердить их официальными интерфейсами, поэтому они остаются `claimed_upstream`, а не новым официальным фактом.

## Provenance clusters для MVP

| Cluster | Первичный факт | Возможные транспорты | Что разрешено заключить | Что запрещено заключить |
|---|---|---|---|---|
| `gpn-official-stock` | `rest.avail` конкретной марки на станции | Gazpromneft, повтор в Toplivo Ryadom/BenzinEst | Текущий Y/N по известной марке с возрастом | Считать повторы агрегаторов независимыми голосами |
| `sber-fuelup-activity` | Sber/FuelUp per-grade inference/last fueling | Sber, Toplivo Ryadom, GdeBenzin.rf, BenzinEst | Grade status ровно в рамках исходной семантики и freshness | Повышать confidence из-за четырёх копий одного upstream |
| `tbank-station-payment` | Транзакция на станции, SKU часто неизвестен | TutBenz, Toplivo Ryadom, GdeBenzin.rf | `LIKELY` для станции/времени; вспомогательный сигнал | `AVAILABLE` для АИ-92/95/98/100/ДТ без товарной позиции |
| `alfa-grade-payment` | В Toplivo наблюдались timestamp по конкретной марке | Toplivo Ryadom | Grade-specific hint, пока не проверен первичный Alfa API | Называть его независимым официальным API Alfa |
| `gdebenz-crowd` | Отчёт пользователя с маркой, статусом и временем | GdeBenz, GdeBenzin.rf, BenzinEst, заявлено Benzovoz | Crowd Y/N/Q/L с возрастом и числом подтверждений | Считать републикации новыми очевидцами |
| `benzas-crowd` | Собственный crowd status/comment | Benzas | Отдельный crowd vote; price provenance хранить отдельно | Считать цену Benzuber подтверждением stock |
| `benzonavt-crowd` | Crowd report/конфликт | Benzonavt | Отдельный vote, если report origin = crowd и известен timestamp | Делать independent весь агрегированный station status |
| `network-catalog` | Штатный ассортимент/цена | LUKOIL, Teboil, Rosneft, Tatneft, Kirishi | Станция продаёт эту марку в принципе; цена может быть свежей | «Топливо есть сейчас» |
| `benzinkarta-undisclosed` | Full revealed status с нераскрытым upstream | BenzinKarta | Показывать как отдельный dependent/unknown-provenance hint | Использовать как независимое corroboration |
| `identity-2gis-osm-official` | Station identity/координаты | 2GIS/Sber IDs, OSM/GdeBenz IDs, IDs сетей | Построение canonical candidates | Считать совпадение координат доказательством одной АЗС без ID/бренд-проверки |

## Минимальная модель evidence

Каждая нормализованная запись должна хранить не только итоговый status:

```text
canonical_station_id (пока nullable)
source_station_id
source_transport
upstream_cluster
fuel_grade
observation_kind = official_stock | crowd | grade_payment | station_payment | catalog | price
raw_status
normalized_status = AVAILABLE | NOT_AVAILABLE | LIKELY | QUEUE | LIMITED | CONFLICT | UNKNOWN
observed_at
captured_at
expires_at / freshness_policy
price
queue
limit
sale_mode
confidence_from_source
independent
raw_fixture_sha256
```

Именно поэтому fixture Benzas разделяет crowd-availability и цену с `price_source=benzuber`, а TutBenz/GdeBenzin не повышают generic bank payment выше `LIKELY`.

## Правила дедупликации и station identity

1. Сначала точное соответствие официального station ID или стабильного external ID.
2. Затем проверяем alias IDs: 2GIS branch ID, OSM ID, ID сети, ID агрегатора.
3. Только затем создаём candidate match по координатам, нормализованному адресу и бренду.
4. Расстояние само по себе никогда не объединяет станции: соседние стороны дороги и две сети могут находиться ближе 75 метров.
5. У evidence дедупликация идёт по `upstream_cluster + station + grade + observed_at/transaction_id`, а не по домену API.
6. `UNKNOWN` не становится `NOT_AVAILABLE`; просроченный факт становится `UNKNOWN`.
7. `CATALOG_FUEL`, price update, working station, active pump/nozzle и generic payment — разные виды фактов.

## Что считать независимым сейчас

- **Прямой официальный stock:** Gazpromneft.
- **Известный, но смешанный upstream:** Sber/FuelUp; хранить 2GIS catalog отдельно от dynamic inference.
- **Самостоятельный crowd:** первичные отчёты GdeBenz и Benzas; Benzonavt — только отдельные rows с ясным crowd origin.
- **Зависимые представления:** BenzinEst, GdeBenzin.rf, Toplivo Ryadom, значительная часть TutBenz/Benzonavt, BenzinKarta с нераскрытым upstream, заявленный Benzovoz.
- **Только каталог:** LUKOIL, Teboil, Rosneft/PTK, Tatneft, Kirishiavtoservis, Yandex/2GIS controls.

Эта карта — результат Phase 0, не реализация Evidence Engine. Весовые коэффициенты и пользовательский итоговый статус сознательно оставлены для следующей фазы.


## Источники, добавленные после Phase 0

| Cluster | Первичный факт | Транспорт | Независимость | Что запрещено заключить |
|---|---|---|---|---|
| `gazpromneft-official` | `rest.avail` по марке на конкретной АЗС | прямой `gpnbonus.ru` **или** ретранслятор `tboo.ru/gpn` | да, но прямое чтение и ретрансляция — **один** кластер | Считать ретранслятор и оригинал двумя независимыми подтверждениями |
| `gdezapravka-crowd` | сообщения водителей своего сообщества поверх базы OSM | `gdezapravka.ru` | да, отдельное сообщество | Считать отсутствие марки в `available_fuels` подтверждённым отсутствием: это мягкий отрицательный признак |
| `telegram-benzinspb78` | подтверждения водителей из чата канала | публичное веб-превью `t.me/s/benzinspb78` | да, отдельное сообщество | Ждать от канала отрицательных сигналов: он публикует только наличие |
| `tofuel-mixed-upstream` | собственные голоса, смешанные с тремя нераскрытыми провайдерами | `tofuel.ru` | нет | Считать его голосом, независимым от банковских лент |
| `tatneft-official`, `rosneft-official`, `teboil-official`, `kirishi-official`, `lukoil-official` | штатный ассортимент и цены сети | официальные API и встроенный в HTML JSON | да как каталог | Выводить из каталога текущий остаток |
| `2gis-benzin` | отметка водителя в 2ГИС: марка есть/нет, очередь, лимит, время отметки | `benzin.api.2gis.ru`; с опозданием — гдебензин.рф (id `2gis:`) и tboo.ru (время `g`, очередь) | да, своё сообщество | Считать гдебензин.рф и tboo.ru вторым и третьим голосом; хранить `user_id` водителей из карточки АЗС |
| `alfa-payments` | состояние продаж марки у Альфа-Банка и Benzuber: продаётся / остановлено, лимит | `alfabank.ru`; tboo.ru повторяет время оплат (`a`); ППР читает то же состояние продаж | нет, платёжный сигнал | Считать tboo.ru и совпадающий с Альфой ППР отдельными голосами; читать «probably_unavailable» как «нет» |
| `transitcard-payments` | продажи марки по топливным картам ППР: есть / с лимитом / нет | `locator.transitcard.ru` (тот же бэкенд у Petrol Plus и E1 CARD; benzokarta.com повторяет) | нет; совпадающий с Альфой статус считается голосом Альфы | Считать ночное «нет» отсутствием топлива; приписывать статусу время |
| `azsradar-crowd` | отметка своего водителя: ok/empty, очередь в машинах, лимит, техперерыв | азсрадар.рф | да, своё сообщество | Брать с этого сайта поля Т-Банка и Сбера как новый голос |
| `azsmap-crowd` | отметка на карте с возрастом в минутах | `azsmap.com`; станции, цены и часть статусов — из ГдеБЕНЗ | да, но совпадающая с ГдеБЕНЗ отметка считается ГдеБЕНЗ | Заводить АЗС по его карточкам; читать ключ `ai98` как АИ-98 (на сайте это АИ-100) |
| `alfa-2gis-price` | цена марки | Альфа-Банк (на момент последней оплаты) и 2ГИС | нет | Считать две одинаковые цены двумя подтверждениями |

Ретрансляция официальной ленты — отдельный вид свидетельства `official_relay`: содержание официальное, доставка нет. Он отвечает так же, как прямое чтение, но всегда называет себя в объяснении и получает оценку достоверности не выше 90.

## Копии одного наблюдения (замер 14 сентября 2026)

Пять лент, добавленных 14 сентября, во многом повторяют уже прочитанное. Правило «копия считается один раз» проверено на одном снимке всех источников, снятом за одну минуту:

- **гдебензин.рф → 2ГИС.** 248 из 250 станций с id `2gis:` — это id 2ГИС; статусы совпали в 59 из 67 марок, медианное отставание 127 мин. Кластер `gdebenzin:2gis` теперь относится к семье `2gis-benzin`.
- **tboo.ru/gpn → Альфа-Банк, 2ГИС, Т-Банк.** Время `a` в прогнозе совпало с последней оплатой марки у Альфы до минуты в 2538 случаях, `g` — с отметкой 2ГИС в 379 из 397, `t` — с последней транзакцией Т-Банка в 240 случаях (ещё 292 — более старые копии). Уровень tboo считается голосом той ленты, чьё время в нём самое свежее, если эта лента читается напрямую для той же марки; иначе он голосует сам. Уровень без единого времени — не наблюдение: раньше он получал дату нашего опроса и примерно 450 марок за обновление получали свежее «скорее нет».
- **ППР ↔ Альфа-Банк.** Из 321 марки, где Альфа пишет «unavailable», ППР говорит то же в 317 — независимо от того, видела ли Альфа оплаты на этой АЗС за сутки; на АЗС «Газпромнефти» обе расходились с официальным остатком вместе 20 раз и порознь 2. Совпадающий статус ППР считается голосом Альфы; из двух равных копий остаётся та, что сообщает лимит. «probably_unavailable» Альфы — это тишина: для 289 из 354 таких марок ППР пишет «мало транзакций».
- **AZS MAP → ГдеБЕНЗ.** На общих OSM id 139 отметок совпали, 62 разошлись; цены совпали в 31 из 39. Совпадающая отметка считается голосом ГдеБЕНЗ, цены лежат в ценовом кластере ГдеБЕНЗ. Карточки, которых нет ни у кого больше (124 — организации Яндекса, пользовательские метки, среди них больница), АЗС не создают.
- **2ГИС и Сбер — два голоса.** Id станций общие (875 из 913 у Сбера), но где Сбер видел продажу марки, водители 2ГИС согласились в 62 из 184 случаев.
- **Цены 2ГИС и Альфы** совпали в 1237 из 1302 марок — это один ценовой кластер.
