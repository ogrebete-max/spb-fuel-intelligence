"""Which station sources each collector's capture feeds."""

from __future__ import annotations

# Which station sources each capture feeds, so a collector that failed can be
# tied to the stations it used to list (scripts/build_snapshot.py), and one
# that answered to the marks it brought (StationRepository.quiet_sources). A
# capture that makes no stations of its own is mapped to nothing: grade titles
# for Tatneft, and the club's marks, which never make a station by themselves.
CAPTURE_SOURCES: dict[str, tuple[str, ...]] = {
    "sber-full-aoi": ("sber",),
    "gdebenz-full-aoi": ("gdebenz",),
    "benzas-full-aoi": ("benzas",),
    "benzas-comments-full-aoi": ("benzas",),
    "benzinest-full-aoi": ("benzinest",),
    "tutbenz-full-aoi": ("tutbenz",),
    "gdebenzin-full-aoi": ("gdebenzin",),
    "benzonavt-full-aoi": ("benzonavt",),
    "toplivo-data": ("toplivo-ryadom",),
    "toplivo-predict": ("toplivo-ryadom",),
    "benzinradar-full-aoi": ("benzinradar-analogue",),
    "tatneft-azs": ("tatneft",),
    "tatneft-fuel-types": (),
    "rosneft-stations": ("rosneft-ptk",),
    "lukoil-search": ("lukoil",),
    "gdezapravka-full-aoi": ("gdezapravka",),
    "tofuel-full-aoi": ("tofuel",),
    "teboil-official": ("teboil",),
    "kirishi-official": ("kirishiavtoservis",),
    "telegram-benzinspb78": ("telegram-benzinspb78",),
    "yandex-maps": ("yandex-maps",),
    "gdebenzin24": ("gdebenzin24",),
    "gde-benzin": ("gde-benzin",),
    "gdebenzin-net": ("gdebenzin-net",),
    "gdebenzfuel": ("gdebenzfuel",),
    "tbank-fuel": ("tbank-fuel",),
    "gdebenzi": ("gdebenzi",),
    "own-reports": (),
    "gpn-official": ("gazpromneft",),
    "2gis-benzin": ("2gis-benzin",),
    "transitcard": ("transitcard",),
    "alfa-azs": ("alfa-azs",),
    "azsradar-rf": ("azsradar-rf",),
    "azsmap": ("azsmap",),
}
