from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Mapping

from .security import GrantItem, TransferGrant


class PathAccessError(ValueError):
    """The grant points outside an allowed root or not to a regular file."""


@dataclass(frozen=True, slots=True)
class ResolvedItem:
    path: Path
    archive_name: str
    size: int
    mtime_ns: int


def _relative_parts(raw: str) -> tuple[str, ...]:
    normalized = raw.replace("\\", "/")
    parsed = PurePosixPath(normalized)
    if parsed.is_absolute() or not parsed.parts:
        raise PathAccessError("Niepoprawna ścieżka względna")
    parts = tuple(parsed.parts)
    if any(part in {"", ".", ".."} or "\x00" in part for part in parts):
        raise PathAccessError("Niepoprawna ścieżka względna")
    if ":" in parts[0]:
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
    except (OSError, ValueError) as exc:
        raise PathAccessError("Plik jest niedostępny") from exc
    if not candidate.is_file():
        raise PathAccessError("Wskazany obiekt nie jest plikiem")
    archive_name = item.archive_name or candidate.name
    return ResolvedItem(path=candidate, archive_name=archive_name, size=stat.st_size, mtime_ns=stat.st_mtime_ns)


def resolve_grant(grant: TransferGrant, roots: Mapping[str, Path]) -> tuple[ResolvedItem, ...]:
    return tuple(resolve_item(item, roots) for item in grant.items)
