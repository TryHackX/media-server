"""
Reading the release year out of a path.

Nothing opens a file to learn this. ffprobe reads the picture and the sound and
has no opinion on the story, audio tags carry a genre once in 12,807 tracks, and
so the only thing on this disk that knows a film came out in 2006 is the name
somebody typed: ``Blood Diamond (2006) [1080p] [AVC] [BluRay] [Lektor PL].mkv``.

A file name is a hostile place to look for a year, because a release name is
mostly numbers that are not one::

    [1080p] [8 bits] [HEVC ~4000 kbs] [AC-3 640 kbs] 1920x1080 x264 5.1 S02E20

so every one of those is struck out before a year is read, the same way
``EpisodeOrder`` strikes them out before reading an episode number. Three rules
then decide, and all three exist because of a real name in this library:

* **A range is not a year.** ``Pokémon (1997 – 2023)`` and ``The X-Files
  [S01-S11] (1993 – 2018)`` are how a series folder writes down its span, and
  the episode inside it came out somewhere in the middle, not in 1993. Ranges
  are removed before anything is read, so a span never answers "what year is
  this file", and an episode whose name does not say simply gets no year rather
  than a wrong one.
* **Brackets beat bare digits.** ``1917 (2019)`` and ``1670 [S01E03] (2023)``
  are both a number that is a title next to a number that is a year, and only
  the parentheses tell them apart.
* **A bare year may not open the name.** It is the same trap without the
  brackets: a name that starts with four digits starts with its title.

What is not found is left empty. A wrong year is worse than no year here,
because a smart collection asking for the nineties would quietly fill up with
films that are not from the nineties, and nothing on screen would say why.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

__all__ = [
    "SearchSubject",
    "episode_marker",
    "release_year_from_path",
    "search_subject_from_path",
    "strip_technical_tokens",
]

# 1888 is Roundhay Garden Scene; the upper bound only has to sit above anything
# anyone will name a file and below a four digit number that is not a year
# ("Order.2472" is an episode title in this library).
_MIN_YEAR = 1888
_MAX_YEAR = 2049

_YEAR = r"(?:18[89]\d|19\d{2}|20[0-4]\d)"

# Hyphen, non breaking hyphen, figure/en/em dash and horizontal bar: a folder
# named by hand uses whichever one the keyboard offered that day.
_DASH = "[-‐‑‒–—―]"

_BRACKETED_YEAR = re.compile(r"[(\[]\s*(" + _YEAR + r")\s*[)\]]")
_BARE_YEAR = re.compile(r"(?<![A-Za-z0-9])(" + _YEAR + r")(?![0-9])")

# "1997 - 2023", "1989–1990", "2023 -" (a series still running).
_YEAR_RANGE = re.compile(_YEAR + r"\s*" + _DASH + r"\s*(?:" + _YEAR + r")?")

# Everything that carries digits and is never a year. Order matters only in that
# the wider patterns must not eat a narrower one's left edge, which is why each
# is anchored on a non-alphanumeric boundary.
_TECHNICAL_TOKENS = (
    re.compile(r"(?<![A-Za-z0-9])s\s*\d{1,2}\s*[._\- ]?\s*e\s*\d{1,3}(?![0-9])", re.I),  # S01E02
    re.compile(r"(?<![A-Za-z0-9])s\s*\d{1,2}(?![0-9])", re.I),                            # S01
    re.compile(r"(?<![A-Za-z0-9])\d{3,4}\s?x\s?\d{3,4}(?![0-9])"),                        # 1920x1080
    re.compile(r"(?<![A-Za-z0-9])\d{3,4}[pi](?![A-Za-z0-9])", re.I),                      # 1080p, 576i
    re.compile(r"(?<![A-Za-z0-9])[xh]\s?26[45](?![0-9])", re.I),                          # x264, h265
    re.compile(r"H\.\s?26[45]", re.I),                                                    # H.264
    re.compile(r"(?<![A-Za-z0-9])\d{1,2}\s?bits?(?![A-Za-z])", re.I),                     # 8 bits, 10Bit
    re.compile(r"(?<![A-Za-z0-9])\d{2,6}\s?k?b(?:ps|it)?s?(?![A-Za-z])", re.I),           # 4000 kbs
    re.compile(r"(?<![A-Za-z0-9])\d{2,5}(?:\.\d+)?\s?[MG]B(?![A-Za-z])", re.I),           # 800MB
    re.compile(r"(?<![A-Za-z0-9])[2457]\.[01](?![0-9])"),                                 # 5.1, 7.1
    re.compile(r"(?<![A-Za-z0-9])(?:AC\s?-?\s?3|DD\s?P?\s?\d(?:\.\d)?|MPEG\s?-?\s?[24]|MP3)", re.I),
)

_EXTENSION = re.compile(r"\.[A-Za-z0-9]{1,5}$")


def strip_technical_tokens(name: str) -> str:
    """
    The name with every digit-bearing release tag replaced by a space.

    Shared with the year reader rather than inlined so that whatever else needs
    to read a name later — a search title for an external lookup, say — strikes
    out exactly the same things.
    """
    for pattern in _TECHNICAL_TOKENS:
        name = pattern.sub(" ", name)
    return name


def _plausible(year: int) -> bool:
    return _MIN_YEAR <= year <= _MAX_YEAR


def _year_in(name: str) -> int | None:
    """The year a single path segment states, or None when it states none."""
    cleaned = _YEAR_RANGE.sub(" ", strip_technical_tokens(name))

    bracketed = [int(value) for value in _BRACKETED_YEAR.findall(cleaned)]
    bracketed = [value for value in bracketed if _plausible(value)]
    if bracketed:
        # The last one wins: "Trylogia (1977) - Powrót Jedi (1983)" names the
        # collection first and this film second.
        return bracketed[-1]

    for match in reversed(list(_BARE_YEAR.finditer(cleaned))):
        # A name that opens with four digits opens with its title ("1670",
        # "1917", "2012"). Leading punctuation and brackets do not count as text.
        if not cleaned[: match.start()].strip(" .-_[](){}"):
            continue
        value = int(match.group(1))
        if _plausible(value):
            return value
    return None


def release_year_from_path(relative_path: str) -> int | None:
    """
    The release year for a catalogued file, or None when the path does not say.

    The file's own name is asked first and the folders after it, nearest first:
    ``Tarot (2024)/Tarot (2024)/Tarot (2024) [1080p] ....mkv`` agrees with itself
    all the way up, but ``Happy Death Day (2017 - 2019)/Happy Death Day 2U
    (2019)/[4K]/00001.m2ts`` only agrees on the level that names the film.
    """
    segments = [segment for segment in relative_path.replace("\\", "/").split("/") if segment]
    if not segments:
        return None
    segments[-1] = _EXTENSION.sub("", segments[-1])
    for segment in reversed(segments):
        year = _year_in(segment)
        if year is not None:
            return year
    return None


# "S01E02", "[S03E03]", "1x02", "S1.E2", and the season-less "E30" that a show
# ripped in one run tends to use — an unambiguous claim to being an episode.
#
# A bare number is deliberately not here. "1 - Astrosmerf.avi" is an episode of
# a cartoon and "1 - Nasze wspólne marzenie (1949).mkv" is a Looney Tunes short
# that Filmweb catalogues on its own, and nothing in either name tells them
# apart; EpisodeOrder can weigh one up against the rest of its folder because it
# is asked about a whole folder at once, and this is not. Those land in the
# review queue, which is where a question nobody can answer from a name belongs.
_EPISODE_MARKER = re.compile(
    r"(?<![A-Za-z0-9])s\s*(\d{1,2})\s*[._\- ]?\s*e\s*(\d{1,3})(?![0-9])"
    r"|(?<![A-Za-z0-9])(\d{1,2})\s*x\s*(\d{1,3})(?![0-9])"
    r"|(?<![A-Za-z0-9])e(?:p|pisode)?\s?[._\- ]?()(\d{1,3})(?![0-9])",
    re.I,
)

# A folder called "S03", "Season 4", "Sezon 2" or "S04 720p" says series even
# when the files inside it are named after nothing but their plot. The same
# marker appearing anywhere in a folder's name — "Pokemon S01 - Indigo League",
# "The X-Files [S01-S11]" — means that folder is a season or a run of them
# rather than the show itself.
_SEASON_FOLDER = re.compile(r"^(?:s|season|sezon|seria)\s?\.?\s?\d{1,2}\b", re.I)
_SEASON_MARKER = re.compile(r"(?<![A-Za-z0-9])(?:s|season|sezon|seria)\s?\.?\s?\d{1,2}(?![0-9])", re.I)

# Words a release name carries that no catalogue would ever call a title. Kept
# to what actually appears on this disk; anything unknown is left in the title,
# because a stray word costs a fuzzy match far less than a truncated title does.
_RELEASE_WORDS = re.compile(
    r"(?<![A-Za-z0-9])(?:"
    r"blu\s?-?ray|bluray|brrip|bdrip|dvdrip|dvdscr|web\s?-?dl|webrip|hdtv|hdrip|remux|"
    r"lektor|napisy|dubbing|dub|pl\s?dub|pl\s?sub|multi|subbed|"
    r"nf|amzn|dsnp|hmax|atvp|itunes|"
    r"avc|hevc|xvid|divx|x?264|x?265|aac|ac\s?-?3|dts|hd|uhd|sdr|hdr|imax|"
    r"theatrical|extended|unrated|directors?\s?cut|remastered|repack|proper|"
    r"complete|animated|anthology|collection|pentalogy|trilogy|tetralogy|duologia|trylogia|"
    r"pl|eng|pol|ita|ger|fra|esp|vo|ov"
    r")(?![A-Za-z0-9])",
    re.I,
)

_HYPHEN_TAG = re.compile(r"[-–]\s*([A-Za-z0-9]+)")


def _looks_like_release_group(token: str) -> bool:
    """
    Whether a hyphenated token is a scene tag rather than half of a title.

    Vocabulary cannot answer this — new groups are named every week — but shape
    can: a group name carries a digit or a second capital somewhere after its
    first letter ("HD4U", "GalaxyRG", "NoNaNo", "MiKOLOK", "BS"), while the tail
    of a hyphenated title does not ("X-Files", "Spider-Man", "WALL-E"). Getting
    this wrong in the permissive direction quietly truncates titles, so anything
    that does not clearly look like a tag is left alone.
    """
    return any(character.isdigit() for character in token) or any(character.isupper() for character in token[1:])


def _drop_release_group(text: str) -> str:
    """Everything from the first scene tag onwards is packaging, not title."""
    for match in _HYPHEN_TAG.finditer(text):
        if _looks_like_release_group(match.group(1)):
            return text[: match.start()]
    return text

_BRACKETED_GROUP = re.compile(r"\[[^\]]*\]|\{[^}]*\}|\([^)]*\)")


@dataclass(frozen=True)
class SearchSubject:
    """What to look up for one catalogued file, and how sure we are of it."""

    title: str
    year: int | None
    is_episode: bool
    # For an episode this is the series folder, which is what gets looked up;
    # every episode under it shares one answer and one network call.
    group_key: str


def episode_marker(name: str) -> tuple[int, int] | None:
    """
    The (season, episode) a name spells out, or None when it does not.

    A season-less "E30" reports season 0, the same way EpisodeOrder does: the
    folder knows which season it is and the file does not.
    """
    match = _EPISODE_MARKER.search(name)
    if match is None:
        return None
    if match.group(1) is not None:
        return int(match.group(1)), int(match.group(2))
    if match.group(3) is not None:
        return int(match.group(3)), int(match.group(4))
    return 0, int(match.group(6))


def _tidy(text: str) -> str:
    # Dots and underscores stand in for spaces in a scene release name.
    text = re.sub(r"[._]+", " ", text)
    text = _RELEASE_WORDS.sub(" ", text)
    text = re.sub(r"\s+", " ", text).strip(" -–—_.")
    text = _drop_release_group(text)
    return re.sub(r"\s+", " ", text).strip(" -–—_.")


def _clean_title(segment: str) -> str:
    """
    A path segment reduced to the words a person would search for.

    The year comes out because it is not part of the title — except when it is.
    "1917", "2012" and "1670" are films and shows whose whole name is a year, so
    if striking the year out leaves nothing behind, the year was the title.
    """
    text = _EXTENSION.sub("", segment)
    text = strip_technical_tokens(text)
    text = _YEAR_RANGE.sub(" ", text)
    # Bracketed groups hold technical description in this library, never a title.
    text = _BRACKETED_GROUP.sub(" ", text)
    without_year = _tidy(_BARE_YEAR.sub(" ", text))
    return without_year or _tidy(text)


def _names_something(title: str) -> bool:
    """
    Whether a cleaned title is worth searching for.

    "00001.m2ts" and "22392.mp4" are a disc stream and a camera dump; neither
    names a work, and the folder above them usually does. A bare year is the
    exception, because that is how "1917" is spelled.
    """
    if not title:
        return False
    if any(character.isalpha() for character in title):
        return True
    return bool(re.fullmatch(_YEAR, title)) and _plausible(int(title))


def _series_folder(ancestors: list[str]) -> str:
    """
    Which folder above an episode names the show.

    Not the topmost one. "Gwiezdne Wojny Kolekcja" is somebody's Star Wars shelf
    and holds two different series plus the films, so treating the top of the
    tree as the show would look up one title for all of them. Not the nearest
    one either, because that is usually a season.

    So: the deepest folder whose name does not carry a season marker anywhere in
    it — which skips "S04 720p" and "Pokemon S01 - Indigo League" alike, and
    stops at "Star Wars Tales of the Empire". When every level is marked, as in
    "The X-Files [S01-S11] (1993 – 2018)", the top of the tree is all there is.
    """
    if not ancestors:
        return ""
    for folder in reversed(ancestors):
        if not _SEASON_MARKER.search(folder):
            return folder
    return ancestors[0]


def search_subject_from_path(relative_path: str) -> SearchSubject | None:
    """
    The work to look up for a catalogued file, or None when the path names none.

    An episode is looked up as its **series**, not as itself. Filmweb and IMDb
    both file a genre against the show rather than against episode 7 of season 6,
    the year that matters is the year the show started, and one answer per series
    folder turns 6,617 files into a few hundred questions — which is the
    difference between a background job and an afternoon of hammering somebody
    else's server.
    """
    segments = [segment for segment in relative_path.replace("\\", "/").split("/") if segment]
    if not segments:
        return None
    file_name = _EXTENSION.sub("", segments[-1])

    inside_a_season = any(_SEASON_FOLDER.match(part) for part in segments[:-1])
    if episode_marker(file_name) is not None or inside_a_season:
        series_folder = _series_folder(segments[:-1])
        title = _clean_title(series_folder)
        if not _names_something(title):
            return None
        return SearchSubject(
            title=title,
            year=_year_in(series_folder) or _series_start_year(series_folder),
            is_episode=True,
            group_key=series_folder,
        )

    # "Happy Death Day 2U (2019)/[4K] [10 Bit] [HDR]/00001.m2ts" — the file is a
    # disc stream number, so the nearest folder that names something wins.
    for index in range(len(segments) - 1, -1, -1):
        title = _clean_title(file_name if index == len(segments) - 1 else segments[index])
        if _names_something(title):
            return SearchSubject(
                title=title,
                year=release_year_from_path(relative_path),
                is_episode=False,
                group_key=segments[index],
            )
    return None


def _series_start_year(segment: str) -> int | None:
    """
    The first year of a span like "(1997 – 2023)".

    Used only as a hint for picking the right show out of a search result, never
    written down as a release year: it says when the series began, which is not
    when the episode in hand came out.
    """
    match = re.search(_YEAR + r"\s*" + _DASH, strip_technical_tokens(segment))
    if match is None:
        return None
    value = int(re.match(_YEAR, match.group(0)).group(0))  # type: ignore[union-attr]
    return value if _plausible(value) else None
