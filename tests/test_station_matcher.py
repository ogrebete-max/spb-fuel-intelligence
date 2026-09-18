from __future__ import annotations

import unittest

from src.station_matcher import _same_network, is_match, merge_stations


def station(source, station_id, network="Лукойл", address="Невский проспект, 1", lat=59.93, lon=30.33):
    return {"source": source, "station_id": station_id, "network": network, "address": address, "location": {"lat": lat, "lon": lon}}


class StationMatcherTests(unittest.TestCase):
    def test_distance_alone_never_matches(self):
        left = station("a", "1", network="Лукойл", address="Невский проспект, 1")
        right = station("b", "2", network="Газпромнефть", address="Московский проспект, 99", lat=59.93001)
        self.assertFalse(is_match(left, right)[0])

    def test_network_address_and_distance_match(self):
        left = station("a", "1")
        right = station("b", "2", address="Санкт-Петербург, Невский проспект, дом 1", lat=59.93002)
        self.assertTrue(is_match(left, right)[0])

    def test_sber_upstream_id_matches(self):
        left = station("sber", "70000001000000001", network="АЗС")
        right = station("gdebenzin", "2gis:70000001000000001", network="Прочие АЗС")
        self.assertTrue(is_match(left, right)[0])


class TwinCardTests(unittest.TestCase):
    """Rows that stood as two cards on one forecourt in the snapshot of 15 Sep 2026."""

    def test_gde_benzin_files_gazpromneft_under_gazprom(self):
        pairs = (
            (station("sber", "70000001051057670", "Газпромнефть, АЗС", "Санкт-Петербург, Санкт-Петербург, Школьная улица, 100", 59.990815, 30.221422),
             station("gde-benzin", "51255", "gazprom", "Школьная улица 100", 59.9908003, 30.2213814)),
            (station("sber", "70000001023099678", "Газпромнефть, АЗС", "Санкт-Петербург, Санкт-Петербург, Индустриальный проспект, 68", 59.969657, 30.455939),
             station("gde-benzin", "52176", "gazprom", "Индустриальный проспект", 59.9696453, 30.4561336)),
            (station("sber", "70000001051057684", "Газпромнефть, АЗС", "Санкт-Петербург, Санкт-Петербург, проспект Культуры, 33 лит А", 60.051725, 30.382655),
             station("gde-benzin", "51204", "gazprom", "проспект Культуры 33", 60.0516616, 30.3825635)),
        )
        for card, twin in pairs:
            with self.subTest(twin["address"]):
                self.assertEqual(is_match(card, twin), (True, "network+25m"))

    def test_one_forecourt_under_the_names_of_its_owners(self):
        pairs = (
            (station("sber", "5348552838740531", "Сургутнефтегаз, заправочная станция", "Санкт-Петербург, Санкт-Петербург, Привокзальная улица, 18 лит Д", 59.734739, 30.098863),
             station("benzinest", "125418363", "Киришиавтосервис", "Привокзальная улица, 18 литД", 59.7348058, 30.0989582)),
            (station("sber", "70000001051336906", "Татнефть, АЗС", "Ленинградская область, д. Большое Верево, трасса Р-23 31 километр, 1а", 59.624715, 30.183443),
             station("benzinest", "220466984", "Neste", "Киевское шоссе, 35-й км", 59.6247138, 30.1834815)),
            (station("sber", "5348552838656754", "Тебойл, АЗС", "Санкт-Петербург, Санкт-Петербург, Краснопутиловская улица, 86 лит А", 59.852512, 30.305361),
             station("gdebenzi", "27261", "ЛУКОЙЛ-Интер-Кард", "Краснопутиловская ул., 86А,г. Санкт-Петербург", 59.852508, 30.305322)),
        )
        for card, twin in pairs:
            with self.subTest(twin["network"]):
                self.assertEqual(is_match(card, twin), (True, "network+25m"))

    def test_rows_that_name_no_network_join_the_station_they_stand_on(self):
        # In the order build_snapshot reads the feeds.
        kudrovo = [
            station("sber", "70000001112334962", "Норд-Лайн", "Ленинградская область, Кудрово", 59.900802, 30.524855),
            station("gdebenzin", "tb:01KX3GXSWPCX58M481886NYEGV", "Nord-Line", "Ленинградская область, Всеволожский район, Кудрово, микрорайон Южное Кудрово", 59.900798, 30.524817),
            station("benzonavt", "16958", "Nord-Line", "Кудрово, пр-т Строителей, 25", 59.9008689, 30.5249736),
            station("tofuel", "6a3fb4d7fdf5fcd1d45d4acf", "Норд-Лайн 3 Автополе", None, 59.9008689, 30.5249736),
            station("gdezapravka", "10444", "Независимая / Прочее", None, 59.9008689, 30.5249736),
            station("gde-benzin", "50920", "other", "КАД", 59.9008689, 30.5249736),
        ]
        krasnoe_selo = [
            station("sber", "5348552838740531", "Сургутнефтегаз, заправочная станция", "Санкт-Петербург, Санкт-Петербург, Привокзальная улица, 18 лит Д", 59.734739, 30.098863),
            station("benzinest", "125418363", "Киришиавтосервис", "Привокзальная улица, 18 литД", 59.7348058, 30.0989582),
            station("gde-benzin", "51487", "other", "Привокзальная улица 18 литД", 59.7348058, 30.0989582),
        ]
        for rows in (kudrovo, krasnoe_selo):
            with self.subTest(rows[0]["network"]):
                merged = merge_stations(rows)
                self.assertEqual(len(merged), 1)
                self.assertEqual({ref["source"] for ref in merged[0]["source_refs"]}, {row["source"] for row in rows})
                # The card keeps the name and the id of the row that started it.
                self.assertEqual(merged[0]["network"], rows[0]["network"])
                self.assertEqual(merged[0]["id"], merge_stations(rows[:1])[0]["id"])

    def test_a_card_nobody_named_takes_the_first_real_name(self):
        rows = [
            station("gdezapravka", "3001", "Независимая / Прочее", "улица Маяковского, 2Б", 59.745929, 31.084307),
            station("gde-benzin", "3002", "other", "улица Маяковского 2Б", 59.745929, 31.084307),
            station("tbank-fuel", "3003", "Неваойл", "Ленинградская область, городской посёлок Мга", 59.745929, 31.084307),
        ]
        (merged,) = merge_stations(rows)
        self.assertEqual(merged["network"], "Неваойл")

    def test_spellings_of_one_network(self):
        for left, right in (
            ("Нева Ойл", "Неваойл"), ("BENZO", "БензоМодуль"), ("Деко, автоматическая АЗС", "Deko"),
            ("Norд-Лайн", "Норд-Лайн 3 Автополе"), ("Бензо Стайл, заправочная станция", "Benzo-Style"),
            ("Роял ойл", "Royal Oil"), ("Кинеф", "Киришиавтосервис"), ('ООО "РН-Карт"', "Роснефть"),
            ("Прочие АЗС", "Лукойл"), ("other", "Газпромнефть, АЗС"),
        ):
            with self.subTest(left=left, right=right):
                self.assertTrue(_same_network(left, right, near=True))

    def test_names_of_different_stations(self):
        for left, right in (
            ("VGaz", "Benzo Style"), ("Лукойл", "Роснефть"), ("Кириши", "Кириш Петролеум"),
            # «Газпром» written out is Gazprom's methane pumps.
            ("Газпром", "Газпромнефть, АЗС"),
        ):
            with self.subTest(left=left, right=right):
                self.assertFalse(_same_network(left, right, near=True))

    def test_new_readings_never_join_a_gas_name_with_another(self):
        for left, right in (
            ("Митекс", "Митекс, АГЗС"), ("АЗС самообслуживания", "Пропан, АГЗС"),
            ("other", "Global Gas"), ("Независимая / Прочее", "Vervex"),
        ):
            with self.subTest(left=left, right=right):
                self.assertFalse(_same_network(left, right, near=True))

    def test_a_card_is_found_by_every_network_name_it_holds(self):
        # The official Киришиавтосервис row stands 58 m from Sber's
        # Сургутнефтегаз, farther than one spot.
        rows = [
            station("sber", "5348552841624264", "Сургутнефтегаз, заправочная станция", "Ленинградская область, городской пос. Янино-1, Промзона Янино, участок 1 лит А", 59.944253, 30.592161),
            station("benzinest", "157073221", "Киришиавтосервис", "Янино-1, Шоссейная улица", 59.9442576, 30.5917831),
            station("kirishiavtoservis", "1889", "Киришиавтосервис", "Ленинградская область, Всеволожский муниципальный район, Заневское городское поселение, г.п. Янино-1, производственная зона Янино, ул. Шоссейная, здание №106", 59.944262, 30.591116),
        ]
        self.assertEqual(len(merge_stations(rows)), 1)

    def test_rows_on_one_forecourt_make_one_card_however_they_name_it(self):
        """Two forecourts cannot stand fifteen metres apart (18 Sep 2026).

        The owner opened such a card in Yandex and read «Больше не работает»
        while ours said «скорее есть»: the crowd feeds kept a dead brand alive
        beside the live one. A card that close joins the best known of them —
        here the one Sber, ГдеБЕНЗ and the chain itself all describe.
        """
        rows = [
            station("sber", "70000001000009001", "Газпромнефть, АЗС", "Санкт-Петербург, Витебский проспект, 9 к2", 59.87517, 30.35112),
            station("tofuel", "6a4a0000linos", "Линос", "Витебский, 9, 2А", 59.87509, 30.35112),
            station("gde-benzin", "52001", "other", "Витебский проспект", 59.87512, 30.35110),
            station("gazpromneft", "400000999", "Газпромнефть", "Санкт-Петербург, Витебский, 9, 2А", 59.87509, 30.35112),
        ]
        cards = {card["network"]: {ref["source"] for ref in card["source_refs"]} for card in merge_stations(rows)}
        self.assertEqual(cards, {"Газпромнефть, АЗС": {"sber", "gde-benzin", "gazpromneft", "tofuel"}})

    def test_a_folded_card_keeps_its_old_id_as_a_name(self):
        """Marks are filed under the id of the card they were made on.

        18 Sep 2026: four of the day's club marks lost their station the moment
        two cards became one, and people stopped seeing what they had marked.
        """
        rows = [
            station("azsmap", "np", "Nord Point", "Санкт-Петербург, Выборгская набережная", 59.97180, 30.33500),
            station("gde-benzin", "np-2", "Nord Point", "Санкт-Петербург, Выборгская набережная", 59.97180, 30.33500),
            station("sber", "70000001000000057", "Газпромнефть, АЗС", "Санкт-Петербург, Выборгская набережная, 57 к1", 59.97200, 30.33500),
        ]
        alone = {card["network"]: card["id"] for card in merge_stations(rows[:2])}
        [card] = merge_stations(rows)
        self.assertEqual(card["network"], "Газпромнефть, АЗС")
        self.assertIn(alone["Nord Point"], card["also_ids"])

    def test_a_little_further_apart_the_house_number_decides(self):
        """«Газпром» and «Газпромнефть», one house, twenty-two metres apart."""
        rows = [
            station("azsmap", "obuhov-303", "Газпром", "пр-кт Обуховской Обороны, 303", 59.86680, 30.46320),
            station("gdebenzin24", "obuhov", "Газпром", "пр-кт Обуховской Обороны, 303", 59.86681, 30.46320),
            station("sber", "70000001000000303", "Газпромнефть, АЗС", "Санкт-Петербург, Санкт-Петербург, проспект Обуховской Обороны, 303", 59.86700, 30.46320),
            station("gazpromneft", "1303", "Газпромнефть, АЗС", "Санкт-Петербург, проспект Обуховской Обороны, 303", 59.86700, 30.46320),
        ]
        # The card the chain itself and Sber describe takes the pair.
        self.assertEqual([card["network"] for card in merge_stations(rows)], ["Газпромнефть, АЗС"])

    def test_a_card_only_the_crowd_feeds_know_joins_the_one_beside_it(self):
        """«Nord Point» twenty metres from Газпромнефть, 18 Sep 2026.

        Neither Yandex, nor Sber, nor 2GIS, nor the chain itself knows a
        station of that name there; the crowd feeds copy each other and keep a
        brand that was painted over. It is the same forecourt.
        """
        rows = [
            station("azsmap", "np-vyb", "Nord Point", "Санкт-Петербург, Выборгская набережная", 59.97180, 30.33500),
            station("azsradar-rf", "np-vyb-2", "Nord Point", "Санкт-Петербург, Выборгская набережная", 59.97180, 30.33500),
            station("sber", "70000001000000057", "Газпромнефть, АЗС", "Санкт-Петербург, Выборгская набережная, 57 к1", 59.97200, 30.33500),
        ]
        cards = {card["network"]: {ref["source"] for ref in card["source_refs"]} for card in merge_stations(rows)}
        self.assertEqual(cards, {"Газпромнефть, АЗС": {"sber", "azsmap", "azsradar-rf"}})

    def test_the_crowd_places_a_forecourt_by_eye_and_still_joins_it(self):
        """The last «Nord Point», 34 m from Газпромнефть on улица Руставели.

        A card only the crowd feeds carry is given forty metres: they place a
        forecourt by eye, and the house was written «54» against «54а».
        """
        rows = [
            station("azsmap", "np-rust", "Nord Point", "ул. Руставели, 54, Санкт-Петербург", 60.02650, 30.41300),
            station("gde-benzin", "np-rust-2", "Nord Point", "ул. Руставели, 54", 60.02650, 30.41300),
            station("sber", "70000001000000054", "Газпромнефть, АЗС", "Санкт-Петербург, улица Руставели, 54а", 60.02681, 30.41300),
        ]
        self.assertEqual([card["network"] for card in merge_stations(rows)], ["Газпромнефть, АЗС"])

    def test_forty_metres_is_where_it_stops(self):
        # Further than that the app keeps both cards, whoever lists them.
        rows = [
            station("azsmap", "far-1", "Nord Point", "ул. Руставели, 54", 60.02650, 30.41300),
            station("sber", "70000001000000055", "Газпромнефть, АЗС", "Санкт-Петербург, улица Руставели, 54а", 60.02700, 30.41300),
        ]
        self.assertEqual(sorted(card["network"] for card in merge_stations(rows)), ["Nord Point", "Газпромнефть, АЗС"])

    def test_a_chain_naming_its_own_station_is_not_a_stale_name(self):
        """Both sides known to someone who keeps names: two cards, two stations.

        Газпромнефть's own feed puts a station at «Благодатная, 2» and the
        directories put «Опти» at «Благодатная, 2а», nineteen metres away. A
        chain knows where its own forecourts are, so neither name is stale.
        """
        rows = [
            station("gazpromneft", "otradnoe", "Газпромнефть", "Отрадное, Благодатная, 2", 59.77800, 30.81000),
            station("sber", "70000001000000021", "Опти, АЗС", "Отрадное, Благодатная улица, 2а", 59.77817, 30.81000),
            station("2gis-benzin", "opti-2a", "Опти, АЗС", "Отрадное, Благодатная улица, 2а", 59.77817, 30.81000),
        ]
        cards = sorted(card["network"] for card in merge_stations(rows))
        self.assertEqual(cards, ["Газпромнефть", "Опти, АЗС"])

    def test_two_house_numbers_that_differ_keep_their_own_cards(self):
        """«Благодатная, 2» and «Благодатная, 2а» are two, and stay two."""
        rows = [
            station("gazpromneft", "otradnoe-2", "Газпромнефть", "Отрадное, Благодатная, 2", 59.77800, 30.81000),
            station("sber", "70000001000000002", "Опти, АЗС", "Отрадное, Благодатная улица, 2а", 59.77817, 30.81000),
        ]
        self.assertEqual(sorted(card["network"] for card in merge_stations(rows)), ["Газпромнефть", "Опти, АЗС"])

    def test_a_row_that_names_no_network_does_not_open_a_card_to_every_network(self):
        # The same rows, but the other brand stands sixty metres up the road —
        # too far to be one forecourt, and a row naming nobody must not glue it
        # to the chain's card.
        rows = [
            station("sber", "70000001000009001", "Газпромнефть, АЗС", "Санкт-Петербург, Витебский проспект, 9 к2", 59.87517, 30.35112),
            station("tofuel", "6a4a0000linos", "Линос", "Витебский, 11", 59.87563, 30.35112),
            station("gde-benzin", "52001", "other", "Витебский проспект", 59.87512, 30.35110),
            station("gazpromneft", "400000999", "Газпромнефть", "Санкт-Петербург, Витебский, 9, 2А", 59.87509, 30.35112),
        ]
        cards = {card["network"]: {ref["source"] for ref in card["source_refs"]} for card in merge_stations(rows)}
        self.assertEqual(cards, {"Газпромнефть, АЗС": {"sber", "gde-benzin", "gazpromneft"}, "Линос": {"tofuel"}})

    def test_gde_benzin_files_gazprom_methane_pumps_under_the_same_id(self):
        # Joined to the pump's card, such a row leaves the map with it.
        self.assertTrue(_same_network("gazprom", "Газпром газомоторное топливо, АГНКС", near=True))
        self.assertTrue(_same_network("gazprom", "Газпром", near=False))

    def test_what_holds_on_one_spot_does_not_hold_across_a_road(self):
        # Lukoil runs Teboil, and Sber lists both of these, 114 m apart.
        lukoil = station("sber", "L1", "Лукойл, АЗС", "Санкт-Петербург, Санкт-Петербург, Комендантский проспект, 43 к2", 60.027149, 30.238237)
        teboil = station("sber", "T1", "Тебойл, АЗС", "Санкт-Петербург, Санкт-Петербург, Комендантский проспект, 41а", 60.026204, 30.239021)
        self.assertEqual(is_match(lukoil, teboil), (False, None))
        nameless = station("gdezapravka", "Z1", "Независимая / Прочее", "Санкт-Петербург, Комендантский проспект, 41а", 60.026204, 30.239021)
        self.assertEqual(is_match(lukoil, nameless), (False, None))
        self.assertFalse(_same_network("Норд-Лайн", "Норд-Лайн 3 Автополе", near=False))
        self.assertTrue(_same_network("gazprom", "Газпромнефть, АЗС", near=False))

    def test_two_networks_on_one_corner_stay_two_stations(self):
        gazpromneft = station("sber", "70000001066613631", "Газпромнефть, АЗС", "Санкт-Петербург, Санкт-Петербург, Химический переулок, 1 к1 лит А", 59.890976, 30.280767)
        rosneft = station("rosneft-ptk", "136913", "Роснефть", "Российская Федерация, г. Санкт-Петербург, ул. Маршала Говорова, д. 35, к. 3, литера А", 59.890693, 30.280032)
        self.assertEqual(is_match(gazpromneft, rosneft), (False, None))


if __name__ == "__main__":
    unittest.main()
