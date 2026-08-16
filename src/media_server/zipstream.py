from __future__ import annotations

import time
import zipfile
from pathlib import PurePosixPath

from starlette.concurrency import iterate_in_threadpool

from .paths import ResolvedItem


class _ZipSink:
    """Minimalny, niesekwencyjny odbiornik wymuszający streaming w zipfile."""

    def __init__(self) -> None:
        self._buffer = bytearray()
        self._offset = 0

    def write(self, data: bytes) -> int:
        self._buffer += data
        self._offset += len(data)
        return len(data)

    def tell(self) -> int:
        return self._offset

    def flush(self) -> None:
        return None

    def drain(self) -> bytes:
        data = bytes(self._buffer)
        self._buffer.clear()
        return data


def _clean_segment(segment: str) -> str:
    cleaned = "".join(character for character in segment if ord(character) >= 32 and character not in '<>:"|?*')
    cleaned = cleaned.strip().strip(".")
    return cleaned or "file"


def safe_archive_name(raw: str, seen: dict[str, int]) -> str:
    normalized = raw.replace("\\", "/")
    parts = [_clean_segment(part) for part in PurePosixPath(normalized).parts if part not in {"", ".", "..", "/"}]
    name = "/".join(parts) or "file"
    count = seen.get(name, 0)
    if count:
        path = PurePosixPath(name)
        stem = path.stem or "file"
        suffix = path.suffix
        parent = "" if str(path.parent) == "." else f"{path.parent}/"
        candidate = f"{parent}{stem} ({count}){suffix}"
        while candidate in seen:
            count += 1
            candidate = f"{parent}{stem} ({count}){suffix}"
        seen[name] = count + 1
        seen[candidate] = 1
        return candidate
    seen[name] = 1
    return name


def zip_chunks(entries: tuple[ResolvedItem, ...], chunk_size: int = 1024 * 1024):
    """Tworzy ZIP64 metodą STORE, bez pliku tymczasowego i bez buforowania archiwum."""

    sink = _ZipSink()
    seen: dict[str, int] = {}
    with zipfile.ZipFile(sink, mode="w", compression=zipfile.ZIP_STORED, allowZip64=True) as archive:
        for entry in entries:
            archive_name = safe_archive_name(entry.archive_name, seen)
            timestamp = time.localtime(entry.mtime_ns / 1_000_000_000)[:6]
            if timestamp[0] < 1980:
                timestamp = (1980, 1, 1, 0, 0, 0)
            info = zipfile.ZipInfo(filename=archive_name, date_time=timestamp)
            info.compress_type = zipfile.ZIP_STORED
            info.external_attr = 0o100644 << 16
            info.file_size = entry.size
            with archive.open(
                info,
                mode="w",
                force_zip64=entry.size >= zipfile.ZIP64_LIMIT,
            ) as destination, entry.path.open("rb") as source:
                while chunk := source.read(chunk_size):
                    destination.write(chunk)
                    if data := sink.drain():
                        yield data
            if data := sink.drain():
                yield data
    if tail := sink.drain():
        yield tail


async def async_zip_chunks(entries: tuple[ResolvedItem, ...]):
    async for chunk in iterate_in_threadpool(zip_chunks(entries)):
        yield chunk
