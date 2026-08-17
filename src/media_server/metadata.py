from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

# What is extracted from an audio file's tags. Bumping this re-reads every track
# on the next scan, the same way PROBE_SCHEMA does for films.
TAG_SCHEMA = 2


class MetadataError(RuntimeError):
    pass


@dataclass(frozen=True, slots=True)
class AudioMetadata:
    title: str | None
    artist: str | None
    album: str | None
    duration_ms: int | None
    technical: dict[str, int | str]


def _first(tags: Any, key: str) -> str | None:
    if not tags:
        return None
    value = tags.get(key)
    if isinstance(value, (list, tuple)):
        value = value[0] if value else None
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def release_year(raw: str | None) -> int | None:
    """
    The release year a tag states, as a number.

    Taggers write the date every way there is — "1959", "1940-03-25", "1957-03",
    "1904-01-01 00:00:00" — and Vorbis comments in particular carry the full one
    under `date`. Only the leading year is wanted: the field is called `year`,
    it is shown as a year, and a year is what every query against it means.
    Anything outside living memory of recorded music is a broken tag, not a date.
    """
    head = (raw or "").strip()[:4]
    if not head.isdigit():
        return None
    year = int(head)
    return year if 1880 <= year <= 2049 else None


def _positive_int(value: Any) -> int | None:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed > 0 else None


def read_audio_metadata(path: Path) -> AudioMetadata:
    try:
        import mutagen
    except ImportError as exc:
        raise MetadataError("Mutagen is not installed") from exc

    try:
        audio = mutagen.File(path, easy=True)
    except Exception as exc:
        raise MetadataError(f"Cannot read audio metadata: {exc}") from exc
    if audio is None:
        raise MetadataError("Unsupported or damaged audio container")

    info = getattr(audio, "info", None)
    length = getattr(info, "length", None)
    duration_ms = None
    if isinstance(length, (int, float)) and length > 0:
        duration_ms = round(length * 1000)

    technical: dict[str, int | str] = {"parser": "mutagen", "schema": TAG_SCHEMA}
    for source_name, target_name in (
        ("bitrate", "bitrate"),
        ("sample_rate", "sample_rate"),
        ("channels", "channels"),
    ):
        parsed = _positive_int(getattr(info, source_name, None))
        if parsed is not None:
            technical[target_name] = parsed
    year = _first(audio.tags, "date") or _first(audio.tags, "year")
    genre = _first(audio.tags, "genre")
    if year is not None:
        # A tag that does not start with a plausible year is kept verbatim: we
        # cannot tell what it means, and guessing would destroy the only record
        # of what the tagger actually wrote.
        parsed = release_year(year)
        technical["year"] = str(parsed) if parsed is not None else year
    if genre is not None:
        technical["genre"] = genre

    return AudioMetadata(
        title=_first(audio.tags, "title"),
        artist=_first(audio.tags, "artist"),
        album=_first(audio.tags, "album"),
        duration_ms=duration_ms,
        technical=technical,
    )
