from __future__ import annotations

from email.utils import formatdate
from pathlib import Path
from urllib.parse import quote

import aiofiles


def content_disposition(disposition: str, filename: str) -> str:
    cleaned = filename.replace("\r", "").replace("\n", "").replace('"', "'")
    ascii_name = cleaned.encode("ascii", "ignore").decode("ascii").strip() or "download"
    encoded = quote(cleaned, safe="")
    return f"{disposition}; filename=\"{ascii_name}\"; filename*=UTF-8''{encoded}"


def last_modified(mtime_ns: int) -> str:
    return formatdate(mtime_ns / 1_000_000_000, usegmt=True)


async def file_chunks(path: Path, *, start: int, end: int, chunk_size: int):
    remaining = end - start + 1
    async with aiofiles.open(path, "rb") as handle:
        if start:
            await handle.seek(start)
        while remaining > 0:
            chunk = await handle.read(min(chunk_size, remaining))
            if not chunk:
                break
            remaining -= len(chunk)
            yield chunk
