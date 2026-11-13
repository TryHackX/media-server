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


# 1980-01-02 00:00 UTC — a day past ZIP's first representable date, so no time
# zone can push it back before 1980.
_ZIP_EPOCH_SECONDS = 315_619_200


# What an archive says about the files it could not include (see missing_note).
MISSING_NOTE_NAME = "_BRAKUJACE-PLIKI.txt"
_MISSING_NOTE_NAMES = 500


def missing_note(names: tuple[str, ...]) -> tuple[str, str] | None:
    """A small text file for the archive, naming what it should have held and does not.

    A header says so too (``X-Archive-Missing``), but a header is read by
    programs; the person who opens the archive finds this.
    """
    if not names:
        return None
    listed = [f"- {name}" for name in names[:_MISSING_NOTE_NAMES]]
    if len(names) > _MISSING_NOTE_NAMES:
        listed.append(f"… (+{len(names) - _MISSING_NOTE_NAMES})")
    text = "\r\n".join([
        f"Brakujące pliki: {len(names)}",
        "",
        "Tych plików nie było na dysku w chwili pobierania, więc archiwum ich nie zawiera.",
        "(These files were not on the disk when the archive was made, so it does not hold them.)",
        "",
        *listed,
        "",
    ])
    return MISSING_NOTE_NAME, text


def zip_chunks(
    entries: tuple[ResolvedItem, ...],
    chunk_size: int = 1024 * 1024,
    note: tuple[str, str] | None = None,
):
    """Tworzy ZIP64 metodą STORE, bez pliku tymczasowego i bez buforowania archiwum.

    ``note`` to nazwa i treść małego pliku tekstowego dopisywanego na końcu
    (``missing_note``).
    """

    sink = _ZipSink()
    seen: dict[str, int] = {}
    with zipfile.ZipFile(sink, mode="w", compression=zipfile.ZIP_STORED, allowZip64=True) as archive:
        for entry in entries:
            archive_name = safe_archive_name(entry.archive_name, seen)
            # Clamped before converting, not after: Windows cannot turn a time
            # before 1970 into a date at all, so one such file used to abort the
            # archive half-way through the download. ZIP itself starts in 1980.
            seconds = max(entry.mtime_ns / 1_000_000_000, _ZIP_EPOCH_SECONDS)
            timestamp = time.localtime(seconds)[:6]
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
        if note is not None:
            info = zipfile.ZipInfo(filename=safe_archive_name(note[0], seen), date_time=time.localtime()[:6])
            info.compress_type = zipfile.ZIP_STORED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, note[1].encode("utf-8"))
            if data := sink.drain():
                yield data
    if tail := sink.drain():
        yield tail


async def async_zip_chunks(entries: tuple[ResolvedItem, ...], note: tuple[str, str] | None = None):
    async for chunk in iterate_in_threadpool(zip_chunks(entries, note=note)):
        yield chunk
