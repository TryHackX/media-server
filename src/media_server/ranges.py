from __future__ import annotations

import re
from datetime import timezone
from email.utils import parsedate_to_datetime
from pathlib import Path


class ByteRangeError(ValueError):
    def __init__(self, size: int) -> None:
        super().__init__("Zakres bajtów jest nieprawidłowy")
        self.content_range = f"bytes */{max(0, size)}"


def parse_single_range(value: str | None, size: int) -> tuple[int, int] | None:
    if not value:
        return None
    if "," in value:
        return None
    match = re.fullmatch(r"bytes=(\d*)-(\d*)", value.strip())
    if match is None or size < 1:
        raise ByteRangeError(size)
    first, last = match.groups()
    if first == "" and last == "":
        raise ByteRangeError(size)
    if first == "":
        suffix = int(last)
        if suffix <= 0:
            raise ByteRangeError(size)
        return max(0, size - suffix), size - 1
    start = int(first)
    end = int(last) if last else size - 1
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
        return int(mtime_ns / 1_000_000_000) <= int(parsed.timestamp())
    except (TypeError, ValueError, OverflowError):
        return False
