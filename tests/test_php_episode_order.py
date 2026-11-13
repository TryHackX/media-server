"""Episode order read out of file names (integrations/php/EpisodeOrder.php).

Nothing in the catalogue marks a folder as a series, so the "watch next"
suggestion leans entirely on naming habits. These cases are taken from the real
library: what must be recognised, and — more importantly — what must not, since
a wrong guess proposes a bonus feature as the next episode.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

EPISODE_ORDER = Path(__file__).resolve().parents[1] / "integrations" / "php" / "EpisodeOrder.php"


def _php() -> str:
    php = shutil.which("php")
    if php is None:
        pytest.skip("PHP nie jest dostępne w PATH")
    return php


def _run(code: str) -> object:
    environment = os.environ.copy()
    environment["MEDIA_EPISODE_ORDER"] = str(EPISODE_ORDER)
    result = subprocess.run(
        [_php(), "-r", "require getenv('MEDIA_EPISODE_ORDER');" + code],
        capture_output=True,
        text=True,
        encoding="utf-8",
        env=environment,
        check=True,
    )
    return json.loads(result.stdout)


def _parse(names: list[str]) -> list[dict[str, object] | None]:
    payload = json.dumps(names)
    return _run(
        "$names = json_decode(<<<'JSON'\n"
        + payload
        + "\nJSON, true);"
        "echo json_encode(array_map("
        "static fn (string $n) => TryHackX\\Media\\Integration\\EpisodeOrder::parse($n), $names));"
    )


def _scheme(names: list[str]) -> str | None:
    payload = json.dumps(names)
    return _run(
        "$names = json_decode(<<<'JSON'\n"
        + payload
        + "\nJSON, true);"
        "echo json_encode(TryHackX\\Media\\Integration\\EpisodeOrder::scheme($names));"
    )


def test_explicit_markers_are_read_in_every_spelling() -> None:
    parsed = _parse(
        [
            "Dr.House.S01E02 1080p.AVC.DTS.Lektor PL.mkv",
            "1670 [S03E05] - Dar dla Tatarow.mkv",
            "Firefly - 1x02 - The Train Job.mkv",
            "Serial.E07.Tytul.mkv",
            "Show S2.E11 [1080p].mkv",
        ]
    )
    assert [(row["season"], row["episode"], row["scheme"]) for row in parsed] == [
        (1, 2, "explicit"),
        (3, 5, "explicit"),
        (1, 2, "explicit"),
        (0, 7, "explicit"),
        (2, 11, "explicit"),
    ]


def test_technical_tags_are_never_mistaken_for_an_episode() -> None:
    """Resolutions, years, codecs, bit depths and bitrates all look like numbers."""
    parsed = _parse(
        [
            "Blood Diamond (2006) [1080p] [AVC] [AC-3] [BluRay] [Lektor PL].mkv",
            "1917 (2019) [1080p 8 bits] [AVC 12.0 Mbs] [AC-3 192 kbs] [Bluray] [LP].mkv",
            "Back to the Future Part II (1989).mkv",
            "Se7en (1995) 1920x1080 x264.mkv",
            "Batman Begins (2005) [1080p60 8 bits] [HEVC 6 134 kbs] [DTS XLL 4 382 kbs].mkv",
        ]
    )
    assert parsed == [None, None, None, None, None]


def test_bare_numbering_is_read_but_only_as_a_bare_number() -> None:
    parsed = _parse(["03 - Jurodiwyj.mkv", "12. Ostatni odcinek.mkv"])
    assert [(row["episode"], row["scheme"]) for row in parsed] == [(3, "bare"), (12, "bare")]


def test_a_season_folder_is_recognised_as_a_series() -> None:
    assert (
        _scheme(
            [
                "Dr.House.S01E01 1080p.AVC.DTS.Lektor PL.mkv",
                "Dr.House.S01E02 1080p.AVC.DTS.Lektor PL.mkv",
                "Dr.House.S01E03 1080p.AVC.DTS.Lektor PL.mkv",
            ]
        )
        == "explicit"
    )
    assert _scheme(["01 - Pilot.mkv", "02 - Drugi.mkv", "03 - Trzeci.mkv", "04 - Czwarty.mkv"]) == "bare"


def test_a_film_collection_is_not_a_series() -> None:
    """Sequels share a folder too; without this they would be offered as episodes."""
    assert (
        _scheme(
            [
                "Back to the Future (1985).mkv",
                "Back to the Future Part II (1989).mkv",
                "Back to the Future Part III (1990).mkv",
            ]
        )
        is None
    )
    assert (
        _scheme(
            [
                "I Spit on Your Grave (2010) [1080p] [AVC] [MLP FBA] [BluRay] [Lektor PL].mkv",
                "I Spit on Your Grave 2 (2013) [1080p] [AVC] [DTS] [Bluray] [Lektor PL].mkv",
                "I Spit on Your Grave 3 (2015) [1080p] [AVC] [DTS XLL] [Bluray] [Lektor PL].mkv",
            ]
        )
        is None
    )
    assert _scheme(["Blood Diamond (2006) [1080p] [AVC] [AC-3] [BluRay] [Lektor PL].mkv"]) is None


def test_rank_orders_seasons_before_episodes() -> None:
    ranks = _run(
        "$order = static fn (string $n) => TryHackX\\Media\\Integration\\EpisodeOrder::rank("
        "TryHackX\\Media\\Integration\\EpisodeOrder::parse($n));"
        "echo json_encode([$order('S01E09.mkv'), $order('S01E10.mkv'), $order('S02E01.mkv')]);"
    )
    assert ranks == sorted(ranks)
