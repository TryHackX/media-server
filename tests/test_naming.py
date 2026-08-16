"""
Every path here is a real one from this library, copied out of media_items.

The parser is only interesting where names fight back, so the cases are grouped
by the trap they carry rather than by the branch they take.
"""

from __future__ import annotations

import pytest

from media_server.naming import (
    episode_marker,
    release_year_from_path,
    search_subject_from_path,
    strip_technical_tokens,
)


@pytest.mark.parametrize(
    "path, expected",
    [
        # The ordinary shape of a film in this library: title, year, then tags.
        ("Tarot (2024)/Tarot (2024)/Tarot (2024) [1080p] [AVC] [AC-3] [BluRay] [Lektor PL].mkv", 2024),
        ("After Death (2015).mp4", 2015),
        (
            "Girl In The Basement (2021)/Girl In The Basement (2021)/"
            "Girl In The Basement (2021) [1080p] [AVC] [AAC LC] [Bluray] [Napisy PL].mkv",
            2021,
        ),
        # A dotted release name, where the year has no brackets to stand in.
        ("Ace.Ventura.Pet.Detective.1994.1080p.BluRay.x264-HD4U.mkv", 1994),
        ("A.Nightmare.on.Elm.Street.2010.MULTi.1080p.BluRay.x264.DTS.AC3-DENDA.mkv.ts", 2010),
        # A number in the title that is not a year, next to one that is.
        ("Final Destination (2000 - 2011)/Final Destination 3 (2006) [1080p] [AVC] [BluRay].mkv", 2006),
        (
            "3 Bill i Ted ratują wszechświat - Bill and Ted Face the Music 2020 "
            "[10Bit] [1080p.BluRay.H265.AC3.5.1-NoNaNo-NitroTeam].mkv",
            2020,
        ),
        ("47 Roninów - 47 Ronin 2013 [1080p.BluRay.H265.AC3.5.1] [ENG-Lektor PL].mkv", 2013),
        # The year is only on the folder; the file names an extra, not the film.
        ("Last Shift (2014)/Last Shift (2014)/The Making of Last Shift.mkv", 2014),
        (
            "Happy Death Day (2017 - 2019)/Happy Death Day 2U (2019)/[4K] [10 Bit] [HDR]/00001.m2ts",
            2019,
        ),
    ],
)
def test_reads_the_year_a_name_states(path: str, expected: int) -> None:
    assert release_year_from_path(path) == expected


@pytest.mark.parametrize(
    "path",
    [
        # A span is how a series folder writes down its run, and the episode
        # inside came out somewhere in it, not at its start.
        "Pokémon (1997 – 2023)/Pokémon (1997 – 2023)/Pokemon S01 - Indigo League/"
        "Pokemon S01E06 - Clefairy and the Moon Stone.mkv",
        "The X-Files [S01-S11] (1993 – 2018)/The X-Files [S01-S11] (1993 – 2018)/S11/"
        "The X-Files (1993 - 2018) [S11e05] [1080p 8 bits] [HEVC ~4000 kbs] [AAC LC] [BRRip].mkv",
        "Chip n Dale Rescue Rangers (1989–1990)/Chip n Dale Rescue Rangers.E30.Seer No Evil..PL.1080p.WEB-DL.H.264.mkv",
        "Teenage Mutant Ninja Turtles (2003 - 2009)/Teenage Mutant Ninja Turtles. 2003-2009.S02E25.PL.720p.WEB-DL.H264.mkv",
        "Monk (2002 - 2009) [S01 - S08]/S03/Monk (2002 - 2009) [S03E04] [1080p 8 bits] [AVC] [AC-3] [WEB-DL].mkv",
        # Nothing anywhere in the path claims a year.
        "Przyjaciele/S06/Przyjaciele [S06E07] - Ten, w którym Phoebe biega.mkv",
        "Świat Według Bundych/S11/Świat.Według.Bundych.S11E01.Tornado.480p.Lektor.PL.DVDRip.x264-BS.mkv",
        "Smerfy/305 - Maloglowe Smerfy.avi",
        "Drake i Josh/S03/Drake i Josh - 3x09 - Doktor Drake.avi",
        "22392.mp4",
    ],
)
def test_says_nothing_rather_than_guessing(path: str) -> None:
    assert release_year_from_path(path) is None


def test_a_title_that_is_a_year_is_not_the_year() -> None:
    # "1670" is the name of the show; the parenthesised year is the release.
    assert release_year_from_path("1670 (2023 - 2026)/S01 (2023)/1670 [S01E03] (2023) [1080p] [AVC].mkv") == 2023
    # And with no bracketed year anywhere, the leading digits stay a title.
    assert release_year_from_path("1670 (2023 - 2026)/1670 [S01E03] [1080p] [AVC].mkv") is None
    assert release_year_from_path("1917 (2019)/1917 (2019) 4K HDR.mkv") == 2019


def test_the_file_outranks_its_folders() -> None:
    path = "Pirates of the Caribbean Pentalogy (2003 - 2017)/Pirates of the Caribbean Dead Men Tell No Tales (2017) [1080P] [BLURAY].mkv"
    assert release_year_from_path(path) == 2017


@pytest.mark.parametrize(
    "name",
    [
        "Film [1080p] [AVC].mkv",
        "Film [2160p] [HEVC ~4000 kbs].mkv",
        "Film 1920x1080 x264 5.1.mkv",
        "Film [8 bits] [10Bit] [AC-3 640 kbs] [DDP5.1].mkv",
        "Film S04E02 1x02 H.264 480i.mkv",
        "Utopia.S01E05.Order.2472.mkv",
    ],
)
def test_technical_tags_are_never_read_as_a_year(name: str) -> None:
    assert release_year_from_path(name) is None


def test_a_year_survives_the_technical_strip() -> None:
    # Struck-out tags must not take the year with them.
    assert "2006" in strip_technical_tokens("Blood Diamond (2006) [1080p] [AVC] [AC-3 640 kbs]")
    assert "1080p" not in strip_technical_tokens("Blood Diamond (2006) [1080p]")


def test_out_of_range_numbers_are_not_years() -> None:
    assert release_year_from_path("Something (1600).mkv") is None
    assert release_year_from_path("Something (2472).mkv") is None
    assert release_year_from_path("Roundhay Garden Scene (1888).mkv") == 1888


def test_an_empty_or_bare_path_is_handled() -> None:
    assert release_year_from_path("") is None
    assert release_year_from_path("/") is None


@pytest.mark.parametrize(
    "path, title",
    [
        ("Tarot (2024)/Tarot (2024)/Tarot (2024) [1080p] [AVC] [BluRay] [Lektor PL].mkv", "Tarot"),
        ("Ace.Ventura.Pet.Detective.1994.1080p.BluRay.x264-HD4U.mkv", "Ace Ventura Pet Detective"),
        ("Little Bone Lodge 2023 720p AMZN WEBRip 800MB x264-GalaxyRG TR.mp4", "Little Bone Lodge"),
        ("Arisaka (2021) PLSUB..1080p.NF.WEB-DL.H264.DDP5.1-MiKOLOK   Napisy PL.mkv.mts", "Arisaka"),
        ("Batman i Robin 1080p Brrip x264 Lektor.pl -p2p.mkv", "Batman i Robin"),
        # A hyphenated title is not a scene tag, however much it looks like one.
        ("Spider-Man No Way Home (2021) [1080p] [AVC].mkv", "Spider-Man No Way Home"),
        ("WALL-E (2008).mkv", "WALL-E"),
        # A file that is only a disc stream number borrows the folder's name.
        ("Happy Death Day 2U (2019)/[4K] [10 Bit] [HDR]/00001.m2ts", "Happy Death Day 2U"),
    ],
)
def test_reads_a_searchable_title_for_a_film(path: str, title: str) -> None:
    subject = search_subject_from_path(path)
    assert subject is not None
    assert subject.title == title
    assert subject.is_episode is False


@pytest.mark.parametrize(
    "path, title",
    [
        (
            "The X-Files [S01-S11] (1993 – 2018)/S02/The X-Files (1993 - 2018) [S02e20] [1080p 8 bits].mkv",
            "The X-Files",
        ),
        ("Przyjaciele/S06/Przyjaciele [S06E07] - Ten, w którym Phoebe biega.mkv", "Przyjaciele"),
        (
            "Pokémon (1997 – 2023)/Pokémon (1997 – 2023)/Pokemon S01 - Indigo League/Pokemon S01E06 - Clefairy.mkv",
            "Pokémon",
        ),
        ("Drake i Josh/S03/Drake i Josh - 3x09 - Doktor Drake.avi", "Drake i Josh"),
    ],
)
def test_an_episode_is_looked_up_as_its_series(path: str, title: str) -> None:
    subject = search_subject_from_path(path)
    assert subject is not None
    assert subject.is_episode is True
    assert subject.title == title
    # Every episode of one show has to land on one lookup, or the worker asks
    # somebody else's server the same question a few hundred times.
    assert subject.group_key == path.split("/")[0]


def test_a_span_is_a_hint_for_the_search_but_never_a_release_year() -> None:
    path = "Pokémon (1997 – 2023)/Pokémon (1997 – 2023)/Pokemon S01 - Indigo League/Pokemon S01E06 - Clefairy.mkv"
    subject = search_subject_from_path(path)
    assert subject is not None
    assert subject.year == 1997
    assert release_year_from_path(path) is None


@pytest.mark.parametrize(
    "name, expected",
    [
        ("Dr.House.S01E02 1080p.mkv", (1, 2)),
        ("The X-Files [S03E03].mkv", (3, 3)),
        ("Drake i Josh - 3x09 - Doktor Drake.avi", (3, 9)),
        # A show ripped in one run numbers episodes without a season.
        ("E01 - Mr Bean [DD 2.0] 10Bit.mkv", (0, 1)),
        ("Chip n Dale Rescue Rangers.E30.Seer No Evil..PL.1080p.mkv", (0, 30)),
        ("Blood Diamond (2006) [1080p] [AVC].mkv", None),
        ("Film 1920x1080.mkv", None),
        # A capital E next to digits is common in titles, and none of these is
        # an episode number.
        ("WALL-E (2008).mkv", None),
        ("Se7en 1995 1080p.mkv", None),
        ("Escape Plan 2 Hades (2018).mkv", None),
        ("Ice Age (2002).mkv", None),
    ],
)
def test_episode_marker_reads_only_an_unambiguous_claim(name: str, expected: tuple[int, int] | None) -> None:
    assert episode_marker(name) == expected


@pytest.mark.parametrize(
    "path, series",
    [
        # A season folder says series even when the file is named after its plot.
        (
            "Victoria Znaczy Zwyciętwo (2010 - 2013)/Victoria Znaczy Zwyciętwo (2010 - 2013)/S03/"
            "Robbie sprzedaje Rexa 20.mkv",
            "Victoria Znaczy Zwyciętwo (2010 - 2013)",
        ),
        (
            "Nie z tego świata (2005 - 2020)/Nie z tego świata - Supernatural [S01 - S15] (2005 - 2020)/"
            "S04 720p/Supernatural S04E11 [720p WEB-DL] [Lektor PL].avi",
            "Nie z tego świata (2005 - 2020)",
        ),
        ("Mr. Bean/E01 - Mr Bean [DD 2.0] 10Bit.mkv", "Mr. Bean"),
    ],
)
def test_a_season_folder_or_a_bare_episode_number_groups_under_the_show(path: str, series: str) -> None:
    subject = search_subject_from_path(path)
    assert subject is not None
    assert subject.is_episode is True
    assert subject.group_key == series


@pytest.mark.parametrize(
    "path, series",
    [
        # A shelf holding several shows is not itself a show.
        (
            "Gwiezdne Wojny Kolekcja/Star Wars Tales of the Empire/Star.Wars.Tales.of.the.Empire.S01E02.MULTi.mkv",
            "Star Wars Tales of the Empire",
        ),
        # A folder named after a season of a show is not the show either.
        (
            "Pokémon (1997 – 2023)/Pokémon (1997 – 2023)/Pokemon S01 - Indigo League/Pokemon S01E06 - Clefairy.mkv",
            "Pokémon (1997 – 2023)",
        ),
        # When every level carries a season marker there is nothing else to pick.
        (
            "The X-Files [S01-S11] (1993 – 2018)/The X-Files [S01-S11] (1993 – 2018)/S02/The X-Files [S02e20].mkv",
            "The X-Files [S01-S11] (1993 – 2018)",
        ),
    ],
)
def test_the_show_is_the_deepest_folder_that_is_not_a_season(path: str, series: str) -> None:
    subject = search_subject_from_path(path)
    assert subject is not None
    assert subject.group_key == series


def test_a_numbered_short_with_its_own_year_stays_its_own_work() -> None:
    # Filmweb catalogues Looney Tunes shorts individually, so merging them into
    # the anthology folder would look up the wrong thing entirely.
    subject = search_subject_from_path(
        "Looney Tunes - Complete Animated Anthology (1933 - 2023)/1 - Nasze wspólne marzenie (1949).mkv"
    )
    assert subject is not None
    assert subject.is_episode is False
    assert subject.year == 1949


def test_a_path_that_names_nothing_yields_no_subject() -> None:
    assert search_subject_from_path("") is None
    assert search_subject_from_path("[1080p] [AVC].mkv") is None
