"""One reading of an episode number, written twice — and held to one answer (Q-02).

`integrations/php/EpisodeOrder.php` decides what the player offers next;
`src/media_server/naming.py` decides which files the title queue files under one
series. They are the same rule in two languages, and nothing but a comment said
they should agree. These names are put to both.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

from media_server.naming import _bare_number, episode_marker

EPISODE_ORDER = Path(__file__).resolve().parents[1] / "integrations" / "php" / "EpisodeOrder.php"

# A file name without its extension, the (season, episode) it spells out — or
# None — and, where it spells none, the bare number left once the technical
# description is struck out.
NAMES: list[tuple[str, tuple[int, int] | None, int | None]] = [
    ("Dr.House.S01E02 1080p.AVC.DTS.Lektor PL", (1, 2), None),
    ("1670 [S03E05] - Dar dla Tatarow", (3, 5), None),
    ("The X-Files [S03E03]", (3, 3), None),
    ("Show s1.e2", (1, 2), None),
    ("Show S01 E02", (1, 2), None),
    ("Show S01-E02", (1, 2), None),
    ("Show S01_E02", (1, 2), None),
    ("Firefly - 1x02 - The Train Job", (1, 2), None),
    ("Drake i Josh - 3x09 - Doktor Drake", (3, 9), None),
    ("Show 12X103 finale", (12, 103), None),
    ("E01 - Mr Bean [DD 2.0] 10Bit", (0, 1), None),
    ("Chip n Dale Rescue Rangers.E30.Seer No Evil..PL.1080p", (0, 30), None),
    ("Serial.E07.Tytul", (0, 7), None),
    ("Serial Ep 12", (0, 12), None),
    ("Serial Ep.12", (0, 12), None),
    ("Serial Episode 5", (0, 5), None),
    ("Serial Episode  5", (0, 5), None),
    ("Serial E   5", (0, 5), None),
    ("Serial episode-105", (0, 105), None),
    # Not episodes: a resolution, a codec, a title with a capital E beside digits.
    ("Film 1920x1080", None, None),
    ("Film x264 1080p", None, None),
    ("WALL-E (2008)", None, None),
    ("Se7en 1995 1080p", None, None),
    ("Ice Age (2002)", None, None),
    ("Blood Diamond (2006) [1080p] [AVC]", None, None),
    ("Movie S1234E01", None, None),
    # A bare number: read only after years, brackets and the release's own numbers are gone.
    ("03 - Jurodiwyj", None, 3),
    ("305 - Astrosmerf", None, 305),
    ("Toy Story 2 (1999)", None, 2),
    ("Escape Plan 2 Hades (2018)", None, 2),
    ("1 - Nasze wspolne marzenie (1949)", None, 1),
    ("Film 2019 720p x265 10bit 5.1 640kbps", None, None),
    ("Koncert 2007 [1080p 8 bits] [AVC 10.6 Mbs]", None, None),
    ("12 Angry Men 1957", None, 12),
    ("Odcinek 7 - Powrot", None, 7),
    ("Tytul bez liczb", None, None),
]


def _php_reading(names: list[str]) -> list[dict[str, object] | None]:
    php = shutil.which("php")
    if php is None:
        pytest.skip("PHP nie jest dostępne w PATH")
    environment = os.environ.copy()
    environment["MEDIA_EPISODE_ORDER"] = str(EPISODE_ORDER)
    environment["MEDIA_EPISODE_NAMES"] = json.dumps(names)
    result = subprocess.run(
        [
            php, "-r",
            "require getenv('MEDIA_EPISODE_ORDER');"
            "echo json_encode(array_map("
            "static fn (string $n) => TryHackX\\Media\\Integration\\EpisodeOrder::parse($n),"
            " json_decode(getenv('MEDIA_EPISODE_NAMES'), true)));",
        ],
        capture_output=True, text=True, encoding="utf-8", env=environment, check=True, timeout=60,
    )
    return json.loads(result.stdout)


def test_the_player_and_the_title_queue_read_a_name_the_same_way() -> None:
    # The player is handed the file's name, the queue its stem: the extension must not matter.
    from_php = _php_reading([f"{name}.mkv" for name, _, _ in NAMES])
    for (name, explicit, bare), php in zip(NAMES, from_php, strict=True):
        assert episode_marker(name) == explicit, name
        if explicit is not None:
            assert php == {"season": explicit[0], "episode": explicit[1], "scheme": "explicit"}, name
            continue
        assert _bare_number(name) == bare, name
        if bare is None:
            assert php is None, name
        else:
            assert php == {"season": 0, "episode": bare, "scheme": "bare"}, name


def test_an_extension_that_looks_like_a_number_is_not_one() -> None:
    """`.3gp` and `.m2ts` carry digits; the player strips the extension before it reads a number."""
    names = ["Wakacje.3gp", "Koncert.m2ts", "Odcinek 4.3gp"]
    assert _php_reading(names) == [None, None, {"season": 0, "episode": 4, "scheme": "bare"}]
    assert [_bare_number(Path(name).stem) for name in names] == [None, None, 4]
