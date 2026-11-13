from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Mapping

from .security import GrantItem, TransferGrant


class PathAccessError(ValueError):
    """The grant points outside an allowed root or not to a regular file."""


class PathMissingError(PathAccessError):
    """The grant names a file that is not there: deleted, renamed, or on a disk that is not mounted.

    Told apart from every other refusal because an archive can go on without
    such a file (``resolve_available``). It cannot go on past a path that tries
    to leave its root, and that stays a plain ``PathAccessError``.
    """


@dataclass(frozen=True, slots=True)
class ResolvedItem:
    path: Path
    archive_name: str
    size: int
    mtime_ns: int


# Windows rules on Windows only. On Linux a backslash and a colon are ordinary
# characters in a file name, and `Mission: Impossible (1996)/…` was catalogued,
# listed and shown — then answered every play, download and thumbnail with 404.
_WINDOWS = os.name == "nt"


def _relative_parts(raw: str) -> tuple[str, ...]:
    normalized = raw.replace("\\", "/") if _WINDOWS else raw
    parsed = PurePosixPath(normalized)
    if parsed.is_absolute() or not parsed.parts:
        raise PathAccessError("Niepoprawna ścieżka względna")
    parts = tuple(parsed.parts)
    if any(part in {"", ".", ".."} or "\x00" in part for part in parts):
        raise PathAccessError("Niepoprawna ścieżka względna")
    # A colon is a drive ("C:") in the first part and an alternate data stream
    # ("film.mkv:hidden") in any other, so on Windows it is refused everywhere.
    if _WINDOWS and any(":" in part for part in parts):
        raise PathAccessError("Niepoprawna ścieżka względna")
    return parts


def resolve_item(item: GrantItem, roots: Mapping[str, Path]) -> ResolvedItem:
    configured_root = roots.get(item.root)
    if configured_root is None:
        raise PathAccessError("Nieznane źródło")
    try:
        canonical_root = configured_root.resolve(strict=True)
        candidate = canonical_root.joinpath(*_relative_parts(item.path)).resolve(strict=True)
        if os.path.commonpath((str(canonical_root), str(candidate))) != str(canonical_root):
            raise PathAccessError("Ścieżka wychodzi poza źródło")
        stat = candidate.stat()
    except (FileNotFoundError, NotADirectoryError) as exc:
        raise PathMissingError("Plik jest niedostępny") from exc
    except (OSError, ValueError) as exc:
        raise PathAccessError("Plik jest niedostępny") from exc
    if not candidate.is_file():
        # A folder where the catalogue remembers a file: as gone as a deleted one.
        raise PathMissingError("Wskazany obiekt nie jest plikiem")
    archive_name = item.archive_name or candidate.name
    return ResolvedItem(path=candidate, archive_name=archive_name, size=stat.st_size, mtime_ns=stat.st_mtime_ns)


def resolve_grant(grant: TransferGrant, roots: Mapping[str, Path]) -> tuple[ResolvedItem, ...]:
    return tuple(resolve_item(item, roots) for item in grant.items)


def resolve_available(
    grant: TransferGrant, roots: Mapping[str, Path]
) -> tuple[tuple[ResolvedItem, ...], tuple[str, ...]]:
    """An archive's files that are on the disk, and the names of those that are not.

    The catalogue lags the disk: between two scans a file can be deleted or
    renamed, and one such file among three hundred used to turn the whole
    download into a 404 — 87 catalogued files were in that state on the day this
    was written. A file that is gone is left out and named; anything else wrong
    with a path (an unknown source, a path leaving its root) still refuses the
    whole grant.
    """
    found: list[ResolvedItem] = []
    missing: list[str] = []
    for item in grant.items:
        try:
            found.append(resolve_item(item, roots))
        except PathMissingError:
            missing.append(item.archive_name or PurePosixPath(item.path).name)
    return tuple(found), tuple(missing)
