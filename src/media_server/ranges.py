from __future__ import annotations

import re
from datetime import timezone
from email.utils import parsedate_to_datetime
from pathlib import Path


class ByteRangeError(ValueError):
    def __init__(self, size: int) -> None:
        super().__init__("Zakres bajtów jest nieprawidłowy")
        self.content_range = f"bytes */{max(0, size)}"


# More digits than any file's length has. A position written longer than this is
# past the end of everything, and is treated so without being parsed: Python
# refuses to turn more than 4300 digits into a number, and that refusal used to
# leave here as a 500.
_MAX_POSITION_DIGITS = 19
_PAST_ANY_FILE = 10**_MAX_POSITION_DIGITS


def _position(digits: str) -> int:
    return int(digits) if len(digits) <= _MAX_POSITION_DIGITS else _PAST_ANY_FILE


def parse_single_range(value: str | None, size: int) -> tuple[int, int] | None:
    if not value:
        return None
    unit, separator, spec = value.strip().partition("=")
    # A unit this server does not speak is not a mistake to answer with 416: the
    # header is ignored and the whole file goes out (RFC 9110, 14.2). Range unit
    # names are case-insensitive.
    if not separator or unit.strip().lower() != "bytes":
        return None
    if "," in spec:
        return None
    match = re.fullmatch(r"(\d*)-(\d*)", spec)
    if match is None or size < 1:
        raise ByteRangeError(size)
    first, last = match.groups()
    if first == "" and last == "":
        raise ByteRangeError(size)
    if first == "":
        suffix = _position(last)
        if suffix <= 0:
            raise ByteRangeError(size)
        return max(0, size - suffix), size - 1
    start = _position(first)
    end = _position(last) if last else size - 1
    if start >= size or end < start:
        raise ByteRangeError(size)
    return start, min(end, size - 1)


def make_etag(path: Path, size: int, mtime_ns: int) -> str:
    stat = path.stat()
    identity = f"{getattr(stat, 'st_dev', 0):x}-{getattr(stat, 'st_ino', 0):x}-{size:x}-{mtime_ns:x}"
    return f'"{identity}"'


def if_range_matches(value: str | None, etag: str, mtime_ns: int) -> bool:
    if not value:
        return True
    candidate = value.strip()
    if candidate.startswith("W/"):
        return False
    if candidate.startswith('"'):
        return candidate == etag
    try:
        parsed = parsedate_to_datetime(candidate)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        # Only the exact Last-Modified date matches (RFC 9110, 13.1.5). "Not newer
        # than" let a client holding the start of an older file — any date after
        # it, its own clock included — splice a range of the new one onto it.
        # Whole seconds, floored, the way Last-Modified is written.
        return mtime_ns // 1_000_000_000 == int(parsed.timestamp())
    except (TypeError, ValueError, OverflowError):
        return False
