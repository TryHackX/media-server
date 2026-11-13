"""The Filmweb matcher's judgement, without the network."""

from __future__ import annotations

import json

import pytest

from media_server.filmweb import (
    ACCEPT_CONFIDENCE,
    Candidate,
    best_match,
    candidates_from_stored,
    other_part,
)
from media_server.naming import SearchSubject
from media_server.title_worker import rejudge_review


def film(filmweb_id: int, title: str, original: str, year: int, minutes: int, genres: tuple[int, ...] = (13,)) -> Candidate:
    return Candidate(
        filmweb_id=filmweb_id,
        entity="film",
        title=title,
        original_title=original,
        year=year,
        duration_minutes=minutes,
        genre_ids=genres,
    )


SCARY_MOVIE = film(10, "Straszny film", "Scary Movie", 2000, 90)
SCARY_MOVIE_2 = film(11, "Straszny film 2", "Scary Movie 2", 2001, 83)
SCARY_MOVIE_1991 = film(12, "Scary Movie", "Scary Movie", 1991, 82, (7,))


def subject(title: str, year: int | None) -> SearchSubject:
    return SearchSubject(title=title, year=year, is_episode=False, group_key=title.lower())


@pytest.mark.parametrize(
    ("left", "right", "expected"),
    [
        ("Scary Movie", "Scary Movie 2", True),
        ("Rocky", "Rocky IV", True),
        ("Kill Bill: Vol. 1", "Kill Bill: Vol. 2", True),
        ("Fast & Furious 6", "Fast & Furious 7", True),
        ("Apollo 13", "Apollo 13", False),
        ("Scary Movie 2", "Scary Movie 2", False),
        # Four digits are a title, not a part.
        ("Blade Runner 2049", "Blade Runner", False),
        ("2012", "2012", False),
        ("Batman Forever", "Batman", False),
    ],
)
def test_a_part_number_names_a_different_film(left: str, right: str, expected: bool) -> None:
    assert other_part(left, right) is expected


def test_the_first_part_of_a_series_is_no_longer_too_close_to_call() -> None:
    # The case from the review list: exact title and year, runtime five minutes
    # out — against the sequel, which used to score 89 to the film's 92.
    match = best_match(
        subject("Scary Movie", 2000),
        [SCARY_MOVIE, SCARY_MOVIE_2, SCARY_MOVIE_1991],
        duration_ms=85 * 60_000,
    )
    assert match.accepted
    assert match.candidate == SCARY_MOVIE
    assert all(value < match.confidence for _, value in match.alternatives)


def test_the_sequel_is_still_found_for_the_sequel() -> None:
    match = best_match(
        subject("Scary Movie 2", 2001),
        [SCARY_MOVIE, SCARY_MOVIE_2],
        duration_ms=83 * 60_000,
    )
    assert match.accepted
    assert match.candidate == SCARY_MOVIE_2


def test_two_films_with_one_name_still_go_to_review() -> None:
    # Nothing but the name to go on: the guard against coin tosses stays.
    match = best_match(
        subject("Batman", None),
        [film(1, "Batman", "Batman", 1989, 126), film(2, "Batman", "Batman", 1966, 105)],
    )
    assert not match.accepted


def test_a_close_call_lists_no_alternative_above_the_guess() -> None:
    match = best_match(
        subject("Batman", 1989),
        [film(1, "Batman", "Batman", 1989, 126), film(2, "Batman", "Batman", 1989, 120)],
        duration_ms=124 * 60_000,
    )
    assert not match.accepted
    assert match.confidence == ACCEPT_CONFIDENCE - 1
    assert all(value <= match.confidence for _, value in match.alternatives)


def test_a_review_row_is_rejudged_from_what_it_stored() -> None:
    stored = json.dumps([
        {**SCARY_MOVIE.as_dict(), "confidence": 81},
        {**SCARY_MOVIE_2.as_dict(), "confidence": 89},
    ])
    match = rejudge_review(subject("Scary Movie", 2000), stored, duration_ms=85 * 60_000)
    assert match is not None and match.accepted
    assert match.candidate is not None and match.candidate.filmweb_id == SCARY_MOVIE.filmweb_id
    assert match.candidate.genre_ids == SCARY_MOVIE.genre_ids


@pytest.mark.parametrize("stored", ["not json", json.dumps({"a": 1}), json.dumps([]), json.dumps([{"title": "x"}])])
def test_an_unreadable_review_row_is_left_alone(stored: str) -> None:
    assert rejudge_review(subject("Scary Movie", 2000), stored, duration_ms=None) is None


def test_stored_candidates_survive_missing_fields() -> None:
    rebuilt = candidates_from_stored([{"filmweb_id": "5", "title": "A", "year": None, "genre_ids": ["3"]}])
    assert rebuilt == [Candidate(5, "film", "A", "", None, None, (3,))]


def test_nothing_plausible_is_not_a_review() -> None:
    # A trailer of something else, matched against whatever the search returned.
    match = best_match(
        subject("Lily & Kat Official Trailer 1 - Drama Movie", 2015),
        [film(20, "Asterix i Obelix: Misja Kleopatra", "Asterix & Obelix: Mission Cleopatre", 2002, 107)],
        duration_ms=2 * 60_000,
    )
    assert match.candidate is None
    assert "no plausible candidate" in match.reasons


def test_a_longer_cut_of_the_only_exact_match_is_still_the_film() -> None:
    gladiator = film(30, "Gladiator", "Gladiator", 2000, 155)
    match = best_match(subject("Gladiator", 2000), [gladiator], duration_ms=171 * 60_000)
    assert match.accepted and match.candidate == gladiator
    assert "exact title and year, nothing else close" in match.reasons


@pytest.mark.parametrize(
    ("candidates", "minutes", "year"),
    [
        # A rival worth offering: a person decides.
        ([film(30, "Gladiator", "Gladiator", 2000, 155), film(31, "Gladiator", "Gladiator", 2000, 100)], 171, 2000),
        # A two-minute file is not a director's cut.
        ([film(30, "Gladiator", "Gladiator", 2000, 155)], 2, 2000),
        # The year has to agree exactly.
        ([film(30, "Gladiator", "Gladiator", 2000, 155)], 171, 2001),
    ],
)
def test_the_sole_match_rule_stays_narrow(candidates: list[Candidate], minutes: int, year: int) -> None:
    assert not best_match(subject("Gladiator", year), candidates, duration_ms=minutes * 60_000).accepted


def test_a_series_without_a_year_still_goes_to_a_person() -> None:
    witcher = Candidate(40, "serial", "Wiedzmin", "The Witcher", 2019, None, (5,))
    episode = SearchSubject(title="Wiedzmin", year=None, is_episode=True, group_key="wiedzmin")
    assert not best_match(episode, [witcher]).accepted


def test_cached_answers_do_not_share_a_file_across_alphabets_or_long_titles(tmp_path) -> None:
    """The name kept only Latin letters: every Cyrillic or Japanese title was `search.json` (T-10)."""
    import hashlib

    from media_server.filmweb import FilmwebClient

    client = FilmwebClient(cache_path=tmp_path, min_interval=0)
    long_title = "search-" + "a" * 200
    keys = ["search-война и мир", "search-七人の侍", "search-братья", long_title, long_title + "b",
            "search-matrix", "search-matrix 2", "film-603"]
    names = [client._cache_file(key).name for key in keys]
    assert len(set(names)) == len(keys)
    assert all(len(name) <= 90 and name.endswith(".json") for name in names)
    # Still readable where the key is, and the same name in every process (no hash()).
    expected = "search-matrix-" + hashlib.sha256(b"search-matrix").hexdigest()[:20] + ".json"
    assert client._cache_file("search-matrix").name == expected
    assert client._cache_file("search-война и мир").name.startswith("search-")

    # An answer stored for one title is not read back for another.
    client._write_cache("search-война и мир", {"searchHits": [{"id": 1}]})
    assert client._read_cache("search-война и мир") == {"searchHits": [{"id": 1}]}
    assert client._read_cache("search-七人の侍") is None
