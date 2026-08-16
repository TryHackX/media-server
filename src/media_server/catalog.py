from __future__ import annotations

import hashlib
import mimetypes
import os
import stat
import time
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterator, Literal

import pymysql
from pymysql.cursors import DictCursor

from .config import DatabaseConfig
from .fingerprint import fingerprint_file
from .metadata import TAG_SCHEMA
from .metadata_queue import enqueue_metadata_jobs
from .naming import release_year_from_path, search_subject_from_path
from .probe import PROBE_SCHEMA


class CatalogError(RuntimeError):
    pass


@dataclass(frozen=True, slots=True)
class DiscoveredFile:
    path: Path
    relative_path: str
    path_hash: bytes
    media_kind: Literal["audio", "video", "image", "other"]
    mime_type: str | None
    fallback_title: str
    size_bytes: int
    mtime_ns: int
    directory_path: str = ""
    directory_hash: bytes = b""
    file_extension: str = ""


@dataclass(frozen=True, slots=True)
class DiscoveredDirectory:
    relative_path: str
    path_hash: bytes
    parent_path_hash: bytes | None
    name: str
    depth: int


@dataclass(frozen=True, slots=True)
class ExistingItem:
    id: int
    size_bytes: int | None
    mtime_ns: int | None
    catalog_status: str
    deleted: bool
    directory_hash: bytes | None = b""
    """Version of the stored audio tags (metadata_json.audio.schema)."""
    metadata_schema: int = 0
    """Version of the stored ffprobe result (metadata_json.video.schema)."""
    probe_schema: int = 0


_AUDIO_EXTENSIONS = frozenset(
    {
        ".aac",
        ".aif",
        ".aiff",
        ".ape",
        ".flac",
        ".m4a",
        ".m4b",
        ".mka",
        ".mp3",
        ".mpc",
        ".oga",
        ".ogg",
        ".opus",
        ".wav",
        ".wma",
        ".wv",
    }
)
_VIDEO_EXTENSIONS = frozenset(
    {
        ".3gp",
        ".asf",
        ".avi",
        ".divx",
        ".flv",
        ".m2ts",
        ".m2v",
        ".m4v",
        ".mkv",
        ".mov",
        ".mp4",
        ".mpeg",
        ".mpg",
        ".mts",
        ".ogv",
        ".rm",
        ".rmvb",
        ".ts",
        ".vob",
        ".webm",
        ".wmv",
    }
)
_IMAGE_EXTENSIONS = frozenset({".avif", ".bmp", ".gif", ".jpeg", ".jpg", ".png", ".webp"})
_SAFE_AUXILIARY_EXTENSIONS = frozenset(
    {".7z", ".ass", ".cue", ".nfo", ".pdf", ".rar", ".srt", ".torrent", ".txt", ".vtt", ".zip"}
)
_ROOT_KINDS = frozenset({"music", "movies", "mixed"})


def _path_hash(root_slug: str, relative_path: str) -> bytes:
    return hashlib.sha256(f"{root_slug}\0{relative_path}".encode("utf-8")).digest()


def _is_reparse_or_symlink(entry: os.DirEntry[str]) -> bool:
    if entry.is_symlink():
        return True
    try:
        entry_stat = entry.stat(follow_symlinks=False)
    except OSError:
        raise
    attributes = getattr(entry_stat, "st_file_attributes", 0)
    reparse_flag = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0)
    return bool(reparse_flag and attributes & reparse_flag)


def _kind_for_suffix(
    root_kind: str,
    suffix: str,
    *,
    include_auxiliary: bool = False,
) -> Literal["audio", "video", "image", "other"] | None:
    if root_kind in {"music", "mixed"} and suffix in _AUDIO_EXTENSIONS:
        return "audio"
    if root_kind in {"movies", "mixed"} and suffix in _VIDEO_EXTENSIONS:
        return "video"
    if include_auxiliary and suffix in _IMAGE_EXTENSIONS:
        return "image"
    if include_auxiliary and suffix in _SAFE_AUXILIARY_EXTENSIONS:
        return "other"
    return None


def discover_catalog(
    root_slug: str,
    root_path: Path,
    root_kind: str,
) -> Iterator[DiscoveredDirectory | DiscoveredFile]:
    if root_kind not in _ROOT_KINDS:
        raise CatalogError(f"Unsupported root kind: {root_kind}")
    try:
        canonical_root = root_path.expanduser().resolve(strict=True)
    except OSError as exc:
        raise CatalogError(f"Media root is unavailable: {root_path}") from exc
    if not canonical_root.is_dir():
        raise CatalogError(f"Media root is not a directory: {canonical_root}")

    pending = [canonical_root]
    while pending:
        current = pending.pop()
        try:
            resolved_current = current.resolve(strict=True)
            if os.path.commonpath((str(canonical_root), str(resolved_current))) != str(canonical_root):
                raise CatalogError(f"Directory escaped the configured root: {current}")
            relative_directory = current.relative_to(canonical_root).as_posix()
            if relative_directory == ".":
                relative_directory = ""
            parent_path = str(Path(relative_directory).parent).replace("\\", "/") if relative_directory else ""
            if parent_path == ".":
                parent_path = ""
            yield DiscoveredDirectory(
                relative_path=relative_directory,
                path_hash=_path_hash(root_slug, relative_directory),
                parent_path_hash=_path_hash(root_slug, parent_path) if relative_directory else None,
                name=current.name if relative_directory else root_slug,
                depth=len(Path(relative_directory).parts) if relative_directory else 0,
            )
            with os.scandir(current) as entries:
                for entry in entries:
                    if _is_reparse_or_symlink(entry):
                        continue
                    if entry.is_dir(follow_symlinks=False):
                        pending.append(Path(entry.path))
                        continue
                    if not entry.is_file(follow_symlinks=False):
                        continue
                    suffix = Path(entry.name).suffix.lower()
                    media_kind = _kind_for_suffix(root_kind, suffix, include_auxiliary=True)
                    if media_kind is None:
                        continue
                    item_stat = entry.stat(follow_symlinks=False)
                    candidate = Path(entry.path)
                    relative_path = candidate.relative_to(canonical_root).as_posix()
                    mime_type = mimetypes.guess_type(entry.name, strict=False)[0]
                    yield DiscoveredFile(
                        path=candidate,
                        relative_path=relative_path,
                        path_hash=_path_hash(root_slug, relative_path),
                        media_kind=media_kind,
                        mime_type=mime_type,
                        fallback_title=candidate.stem,
                        size_bytes=item_stat.st_size,
                        mtime_ns=item_stat.st_mtime_ns,
                        directory_path=relative_directory,
                        directory_hash=_path_hash(root_slug, relative_directory),
                        file_extension=suffix.removeprefix("."),
                    )
        except CatalogError:
            raise
        except OSError as exc:
            raise CatalogError(f"Cannot scan directory {current}: {exc}") from exc


def classify_item(
    existing: ExistingItem | None,
    candidate: DiscoveredFile,
    *,
    metadata_enabled: bool,
) -> Literal["new", "updated", "unchanged"]:
    if existing is None:
        return "new"
    if existing.directory_hash != candidate.directory_hash:
        return "updated"
    same_file = (
        existing.size_bytes == candidate.size_bytes and existing.mtime_ns == candidate.mtime_ns and not existing.deleted
    )
    if not same_file:
        return "updated"
    if existing.catalog_status in {"legacy", "missing", "pending"}:
        return "updated"
    if existing.catalog_status == "error" and metadata_enabled:
        return "updated"
    if metadata_enabled and candidate.media_kind == "audio" and existing.metadata_schema < TAG_SCHEMA:
        return "updated"
    # A file whose bytes did not move still needs re-reading when what we extract
    # from it has changed — that is what the schema versions record.
    if metadata_enabled and candidate.media_kind == "video" and existing.probe_schema < PROBE_SCHEMA:
        return "updated"
    return "unchanged"


def _ensure_safe_missing(
    active_items: int,
    missing_items: int,
    *,
    allow_mass_missing: bool,
) -> None:
    if allow_mass_missing or active_items == 0 or missing_items == 0:
        return
    all_items_missing = missing_items == active_items
    majority_of_large_catalog_missing = missing_items >= 100 and missing_items * 2 > active_items
    if all_items_missing or majority_of_large_catalog_missing:
        raise CatalogError(
            f"Refusing to mark {missing_items} of {active_items} active items as missing; "
            "verify the mounted disk and repeat with --allow-mass-missing only if intentional"
        )


def _connect(config: DatabaseConfig):
    return pymysql.connect(
        host=config.host,
        port=config.port,
        user=config.user,
        password=config.password,
        database=config.name,
        charset="utf8mb4",
        cursorclass=DictCursor,
        autocommit=True,
        connect_timeout=5,
        read_timeout=120,
        write_timeout=120,
    )


def _validate_schema(connection: Any, database_name: str) -> None:
    required = {
        "catalog_scans": {"id", "root_id", "status"},
        "media_items": {
            "id",
            "root_id",
            "path_hash",
            "last_seen_scan_id",
            "last_error",
        },
        "media_roots": {"id", "slug", "media_kind"},
        "media_directories": {"id", "root_id", "path_hash", "parent_path_hash"},
    }
    with connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT table_name AS table_key, column_name AS column_key
            FROM information_schema.columns
            WHERE table_schema = %s
              AND table_name IN ('catalog_scans', 'media_directories', 'media_items', 'media_roots')
            """,
            (database_name,),
        )
        available: dict[str, set[str]] = {}
        for row in cursor.fetchall():
            available.setdefault(str(row["table_key"]), set()).add(str(row["column_key"]))
    missing = []
    for table, columns in required.items():
        absent = sorted(columns - available.get(table, set()))
        if absent:
            missing.append(f"{table}: {', '.join(absent)}")
    if missing:
        raise CatalogError("Catalog schema is not migrated (" + "; ".join(missing) + ")")


def _register_root(connection: Any, slug: str, root_path: Path, root_kind: str) -> int:
    filesystem_path = str(root_path)
    if len(filesystem_path) > 1024:
        raise CatalogError("The configured media root path is too long for the database")
    with connection.cursor() as cursor:
        cursor.execute(
            """
            INSERT INTO media_roots (slug, media_kind, display_name, filesystem_path, is_enabled)
            VALUES (%s, %s, %s, %s, 1)
            ON DUPLICATE KEY UPDATE
              media_kind = VALUES(media_kind),
              display_name = VALUES(display_name),
              filesystem_path = VALUES(filesystem_path),
              is_enabled = 1
            """,
            (slug, root_kind, slug.replace("_", " ").replace("-", " ").title(), filesystem_path),
        )
        cursor.execute("SELECT id FROM media_roots WHERE slug = %s", (slug,))
        row = cursor.fetchone()
    if not row:
        raise CatalogError("Cannot register the media root")
    return int(row["id"])


def _find_root(connection: Any, slug: str) -> int | None:
    with connection.cursor() as cursor:
        cursor.execute("SELECT id FROM media_roots WHERE slug = %s", (slug,))
        row = cursor.fetchone()
    return int(row["id"]) if row else None


def _load_existing(connection: Any, root_id: int | None) -> dict[bytes, ExistingItem]:
    if root_id is None:
        return {}
    with connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT id, path_hash, directory_hash, size_bytes, mtime_ns, catalog_status, deleted_at,
                   COALESCE(JSON_UNQUOTE(JSON_EXTRACT(metadata_json, '$.audio.schema')), 0) AS metadata_schema,
                   COALESCE(JSON_UNQUOTE(JSON_EXTRACT(metadata_json, '$.video.schema')), 0) AS probe_schema
            FROM media_items
            WHERE root_id = %s
            """,
            (root_id,),
        )
        rows = cursor.fetchall()
    return {
        bytes(row["path_hash"]): ExistingItem(
            id=int(row["id"]),
            size_bytes=int(row["size_bytes"]) if row["size_bytes"] is not None else None,
            mtime_ns=int(row["mtime_ns"]) if row["mtime_ns"] is not None else None,
            catalog_status=str(row["catalog_status"]),
            deleted=row["deleted_at"] is not None,
            directory_hash=bytes(row["directory_hash"]) if row["directory_hash"] is not None else None,
            metadata_schema=int(row["metadata_schema"] or 0),
            probe_schema=int(row["probe_schema"] or 0),
        )
        for row in rows
    }


_UPSERT_SQL = """
    INSERT INTO media_items (
      root_id, relative_path, path_hash, directory_hash, media_kind, mime_type, file_extension,
      title, artist, album, duration_ms, size_bytes, mtime_ns,
      metadata_json, catalog_status, last_seen_scan_id, last_error,
      indexed_at, deleted_at
    )
    VALUES (
      %s, %s, %s, %s, %s, %s, %s,
      %s, %s, %s, %s, %s, %s,
      %s, %s, %s, %s,
      CURRENT_TIMESTAMP(6), NULL
    )
    ON DUPLICATE KEY UPDATE
      relative_path = VALUES(relative_path),
      directory_hash = VALUES(directory_hash),
      media_kind = VALUES(media_kind),
      mime_type = VALUES(mime_type),
      file_extension = VALUES(file_extension),
      title = CASE
        WHEN VALUES(metadata_json) IS NULL THEN COALESCE(media_items.title, VALUES(title))
        ELSE COALESCE(VALUES(title), media_items.title)
      END,
      artist = COALESCE(VALUES(artist), media_items.artist),
      album = COALESCE(VALUES(album), media_items.album),
      duration_ms = COALESCE(VALUES(duration_ms), media_items.duration_ms),
      size_bytes = VALUES(size_bytes),
      mtime_ns = VALUES(mtime_ns),
      metadata_json = COALESCE(VALUES(metadata_json), media_items.metadata_json),
      catalog_status = VALUES(catalog_status),
      last_seen_scan_id = VALUES(last_seen_scan_id),
      last_error = VALUES(last_error),
      indexed_at = CURRENT_TIMESTAMP(6),
      deleted_at = NULL
"""


def _directory_ancestors(root_slug: str, directory_path: str) -> list[bytes]:
    values = [_path_hash(root_slug, "")]
    if not directory_path:
        return values
    parts = directory_path.split("/")
    values.extend(_path_hash(root_slug, "/".join(parts[:index])) for index in range(1, len(parts) + 1))
    return values


def _upsert_directories(
    connection: Any,
    *,
    root_id: int,
    scan_id: int,
    directories: dict[bytes, DiscoveredDirectory],
    direct_counts: Counter[bytes],
    descendant_counts: Counter[bytes],
    total_sizes: Counter[bytes],
    preview_candidates: dict[bytes, tuple[int, bytes]],
) -> None:
    rows = [
        (
            root_id,
            directory.relative_path,
            directory.path_hash,
            directory.parent_path_hash,
            directory.name[:512],
            directory.depth,
            direct_counts[directory.path_hash],
            descendant_counts[directory.path_hash],
            total_sizes[directory.path_hash],
            scan_id,
        )
        for directory in directories.values()
    ]
    with connection.cursor() as cursor:
        cursor.executemany(
            """
            INSERT INTO media_directories (
              root_id, relative_path, path_hash, parent_path_hash, name, depth,
              direct_file_count, descendant_file_count, total_size_bytes,
              preview_media_item_id, last_seen_scan_id, indexed_at, deleted_at
            )
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, NULL, %s, CURRENT_TIMESTAMP(6), NULL)
            ON DUPLICATE KEY UPDATE
              relative_path = VALUES(relative_path),
              parent_path_hash = VALUES(parent_path_hash),
              name = VALUES(name),
              depth = VALUES(depth),
              direct_file_count = VALUES(direct_file_count),
              descendant_file_count = VALUES(descendant_file_count),
              total_size_bytes = VALUES(total_size_bytes),
              preview_media_item_id = NULL,
              last_seen_scan_id = VALUES(last_seen_scan_id),
              indexed_at = CURRENT_TIMESTAMP(6),
              deleted_at = NULL
            """,
            rows,
        )
        preview_rows = [
            (item_hash, root_id, directory_hash)
            for directory_hash, (_, item_hash) in preview_candidates.items()
        ]
        if preview_rows:
            cursor.executemany(
                """
                UPDATE media_directories md
                INNER JOIN media_items mi
                  ON mi.root_id = md.root_id AND mi.path_hash = %s AND mi.deleted_at IS NULL
                SET md.preview_media_item_id = mi.id
                WHERE md.root_id = %s AND md.path_hash = %s
                """,
                preview_rows,
            )

def _flush(
    connection: Any,
    upserts: list[tuple[Any, ...]],
    unchanged: list[tuple[int, int]],
) -> None:
    with connection.cursor() as cursor:
        if upserts:
            cursor.executemany(_UPSERT_SQL, upserts)
            upserts.clear()
        if unchanged:
            cursor.executemany(
                """
                UPDATE media_items
                SET last_seen_scan_id = %s, indexed_at = CURRENT_TIMESTAMP(6)
                WHERE id = %s
                """,
                unchanged,
            )
            unchanged.clear()


def _apply_name_derived_fields(connection: Any, root_id: int, root_slug: str) -> int:
    """
    Fill in what a video's own path states, and return how many rows moved.

    Two facts come from the path and nowhere else: the release year, and which
    *work* the file belongs to — one film, or one series that a few hundred
    episodes share. The second is a hash rather than a name so that the lookup
    queue can join on it, the same way path_hash lets the scan find a file
    without comparing strings.

    This is a sweep rather than a column on the upsert because both are
    functions of relative_path, and an unchanged file never reaches the upsert —
    so a file catalogued before this existed, or one the parser reads
    differently after a fix, would otherwise keep an empty column forever.
    Asking the question again for every row costs one read of a column the scan
    has just walked anyway, and writes only where the answer changed, so a
    steady library writes nothing.

    Only videos are asked. A year in a track name is usually the album's and
    belongs in a tag, and the smart collections this feeds are about films.

    Rows the scan does not own are left alone: once release_year_source names an
    external lookup or a person, a walk of the file tree must not overrule it.
    """
    with connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT id, relative_path, release_year, release_year_source, title_subject_hash
            FROM media_items
            WHERE root_id = %s
              AND media_kind = 'video'
              AND deleted_at IS NULL
            """,
            (root_id,),
        )
        changes = []
        for row in cursor.fetchall():
            path = str(row["relative_path"])
            owned = row["release_year_source"] in (None, "filename")
            year = release_year_from_path(path) if owned else row["release_year"]
            source = ("filename" if year is not None else None) if owned else row["release_year_source"]
            subject = search_subject_from_path(path)
            subject_hash = _path_hash(root_slug, subject.group_key) if subject is not None else None

            current_year = int(row["release_year"]) if row["release_year"] is not None else None
            current_hash = bytes(row["title_subject_hash"]) if row["title_subject_hash"] is not None else None
            if year != current_year or source != row["release_year_source"] or subject_hash != current_hash:
                changes.append((year, source, subject_hash, int(row["id"])))
        for group in (changes[offset : offset + 500] for offset in range(0, len(changes), 500)):
            cursor.executemany(
                """
                UPDATE media_items
                SET release_year = %s, release_year_source = %s, title_subject_hash = %s
                WHERE id = %s
                """,
                group,
            )
    return len(changes)


def _apply_fingerprints(connection: Any, root_id: int, root_path: Path, limit: int) -> int:
    """
    Fingerprint files that have none yet, up to `limit`, and say how many.

    Bounded on purpose. Unlike the year sweep next door this one touches the
    disk — two reads per file — and a library of twenty thousand would turn one
    scan into a long one. A cap means every scan does a slice and the column
    fills in over a few runs, which is the right trade for something no feature
    is blocked on.

    A file is fingerprinted again when its size or mtime moved, because that is
    a different file wearing the same name.
    """
    if limit < 1:
        return 0
    with connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT id, relative_path, size_bytes
            FROM media_items
            WHERE root_id = %s
              AND deleted_at IS NULL
              AND media_kind IN ('audio', 'video')
              AND content_fingerprint IS NULL
            ORDER BY id
            LIMIT %s
            """,
            (root_id, limit),
        )
        rows = cursor.fetchall()
        computed = []
        for row in rows:
            relative = str(row["relative_path"]).replace("\\", "/")
            value = fingerprint_file(
                root_path.joinpath(*relative.split("/")),
                int(row["size_bytes"]) if row["size_bytes"] is not None else None,
            )
            if value is not None:
                computed.append((value, int(row["id"])))
        for group in (computed[offset : offset + 500] for offset in range(0, len(computed), 500)):
            cursor.executemany(
                "UPDATE media_items SET content_fingerprint = %s WHERE id = %s",
                group,
            )
    return len(computed)


def _start_scan(connection: Any, root_id: int, metadata_enabled: bool) -> int:
    with connection.cursor() as cursor:
        cursor.execute(
            "INSERT INTO catalog_scans (root_id, metadata_enabled) VALUES (%s, %s)",
            (root_id, int(metadata_enabled)),
        )
        return int(cursor.lastrowid)


def _finish_scan(connection: Any, scan_id: int, report: dict[str, Any], root_id: int) -> None:
    connection.begin()
    try:
        with connection.cursor() as cursor:
            cursor.execute(
                """
                UPDATE media_items
                SET catalog_status = 'missing',
                    deleted_at = COALESCE(deleted_at, CURRENT_TIMESTAMP(6)),
                    last_error = NULL
                WHERE root_id = %s
                  AND (last_seen_scan_id IS NULL OR last_seen_scan_id <> %s)
                  AND deleted_at IS NULL
                """,
                (root_id, scan_id),
            )
            report["missing"] = int(cursor.rowcount)
            cursor.execute(
                """
                UPDATE media_directories
                SET deleted_at = COALESCE(deleted_at, CURRENT_TIMESTAMP(6)),
                    preview_media_item_id = NULL
                WHERE root_id = %s
                  AND (last_seen_scan_id IS NULL OR last_seen_scan_id <> %s)
                  AND deleted_at IS NULL
                """,
                (root_id, scan_id),
            )
            cursor.execute(
                """
                UPDATE catalog_scans
                SET status = 'completed',
                    discovered_count = %s,
                    new_count = %s,
                    updated_count = %s,
                    unchanged_count = %s,
                    missing_count = %s,
                    error_count = %s,
                    finished_at = CURRENT_TIMESTAMP(6)
                WHERE id = %s AND status = 'running'
                """,
                (
                    report["discovered"],
                    report["new"],
                    report["updated"],
                    report["unchanged"],
                    report["missing"],
                    report["errors"],
                    scan_id,
                ),
            )
            if cursor.rowcount != 1:
                raise CatalogError("The catalog scan state changed unexpectedly")
        connection.commit()
    except BaseException:
        connection.rollback()
        raise


def _fail_scan(connection: Any, scan_id: int, report: dict[str, Any], error: str, status: str = "failed") -> None:
    try:
        with connection.cursor() as cursor:
            cursor.execute(
                """
                UPDATE catalog_scans
                SET status = %s,
                    discovered_count = %s,
                    new_count = %s,
                    updated_count = %s,
                    unchanged_count = %s,
                    error_count = %s,
                    error_text = %s,
                    finished_at = CURRENT_TIMESTAMP(6)
                WHERE id = %s AND status = 'running'
                """,
                (
                    status,
                    report["discovered"],
                    report["new"],
                    report["updated"],
                    report["unchanged"],
                    report["errors"],
                    error[:4000],
                    scan_id,
                ),
            )
    except pymysql.MySQLError:
        pass


def scan_catalog(
    *,
    database: DatabaseConfig,
    root_slug: str,
    root_path: Path,
    root_kind: str,
    apply: bool = False,
    metadata_enabled: bool = False,
    batch_size: int = 500,
    allow_mass_missing: bool = False,
    fingerprint_limit: int = 2000,
) -> dict[str, Any]:
    if root_kind not in _ROOT_KINDS:
        raise CatalogError(f"Unsupported root kind: {root_kind}")
    if not 10 <= batch_size <= 5000:
        raise CatalogError("Batch size must be in the range 10..5000")

    started = time.monotonic()
    report: dict[str, Any] = {
        "root": root_slug,
        "kind": root_kind,
        "mode": "apply" if apply else "dry-run",
        "status": "running",
        "scan_id": None,
        "discovered": 0,
        "new": 0,
        "updated": 0,
        "unchanged": 0,
        "missing": 0,
        "errors": 0,
        "metadata_jobs": 0,
        "named_facts": 0,
        "fingerprints": 0,
        "directories": 0,
        "images": 0,
        "auxiliary": 0,
    }
    lock_name = f"tryhackx:catalog:{root_slug}"
    locked = False
    scan_id: int | None = None

    try:
        with _connect(database) as connection:
            _validate_schema(connection, database.name)
            if apply:
                with connection.cursor() as cursor:
                    cursor.execute("SELECT GET_LOCK(%s, 0) AS acquired", (lock_name,))
                    row = cursor.fetchone()
                if not row or int(row["acquired"] or 0) != 1:
                    raise CatalogError(f"A catalog scan is already running for root {root_slug}")
                locked = True
                root_id = _register_root(connection, root_slug, root_path.resolve(strict=True), root_kind)
            else:
                root_id = _find_root(connection, root_slug)

            existing = _load_existing(connection, root_id)
            if apply:
                scan_id = _start_scan(connection, root_id, metadata_enabled)
                report["scan_id"] = scan_id
            seen: set[bytes] = set()
            directories: dict[bytes, DiscoveredDirectory] = {}
            direct_counts: Counter[bytes] = Counter()
            descendant_counts: Counter[bytes] = Counter()
            total_sizes: Counter[bytes] = Counter()
            preview_candidates: dict[bytes, tuple[int, bytes]] = {}
            upserts: list[tuple[Any, ...]] = []
            unchanged: list[tuple[int, int]] = []
            metadata_hashes: list[bytes] = []

            try:
                for entry in discover_catalog(root_slug, root_path, root_kind):
                    if isinstance(entry, DiscoveredDirectory):
                        directories[entry.path_hash] = entry
                        continue

                    candidate = entry
                    report["discovered"] += 1
                    if candidate.media_kind == "image":
                        report["images"] += 1
                    elif candidate.media_kind == "other":
                        report["auxiliary"] += 1
                    seen.add(candidate.path_hash)
                    direct_counts[candidate.directory_hash] += 1
                    priority = {"image": 0, "video": 1, "audio": 2, "other": 3}[candidate.media_kind]
                    for directory_hash in _directory_ancestors(root_slug, candidate.directory_path):
                        descendant_counts[directory_hash] += 1
                        total_sizes[directory_hash] += candidate.size_bytes
                        current_preview = preview_candidates.get(directory_hash)
                        if current_preview is None or priority < current_preview[0]:
                            preview_candidates[directory_hash] = (priority, candidate.path_hash)

                    old = existing.get(candidate.path_hash)
                    classification = classify_item(old, candidate, metadata_enabled=metadata_enabled)
                    report[classification] += 1
                    if classification != "unchanged" and metadata_enabled and candidate.media_kind in {"audio", "video"}:
                        metadata_hashes.append(candidate.path_hash)
                    if not apply:
                        continue
                    if classification == "unchanged":
                        if old is None or scan_id is None:
                            raise CatalogError("Internal catalog classification error")
                        unchanged.append((scan_id, old.id))
                    else:
                        upserts.append(
                            (
                                root_id,
                                candidate.relative_path,
                                candidate.path_hash,
                                candidate.directory_hash,
                                candidate.media_kind,
                                candidate.mime_type,
                                candidate.file_extension,
                                candidate.fallback_title,
                                None,
                                None,
                                None,
                                candidate.size_bytes,
                                candidate.mtime_ns,
                                None,
                                "ready",
                                scan_id,
                                None,
                            )
                        )
                    if len(upserts) + len(unchanged) >= batch_size:
                        _flush(connection, upserts, unchanged)

                report["directories"] = len(directories)
                active_items = sum(1 for item in existing.values() if not item.deleted)
                potential_missing = sum(
                    1 for path_hash, item in existing.items() if not item.deleted and path_hash not in seen
                )
                report["metadata_jobs"] = len(set(metadata_hashes))
                if apply:
                    if scan_id is None or root_id is None:
                        raise CatalogError("Internal catalog scan state error")
                    _flush(connection, upserts, unchanged)
                    _ensure_safe_missing(
                        active_items,
                        potential_missing,
                        allow_mass_missing=allow_mass_missing,
                    )
                    _upsert_directories(
                        connection,
                        root_id=root_id,
                        scan_id=scan_id,
                        directories=directories,
                        direct_counts=direct_counts,
                        descendant_counts=descendant_counts,
                        total_sizes=total_sizes,
                        preview_candidates=preview_candidates,
                    )
                    report["named_facts"] = _apply_name_derived_fields(connection, root_id, root_slug)
                    report["fingerprints"] = _apply_fingerprints(
                        connection, root_id, root_path.resolve(strict=True), fingerprint_limit
                    )
                    if metadata_enabled:
                        report["metadata_jobs"] = enqueue_metadata_jobs(
                            connection,
                            root_id=root_id,
                            path_hashes=metadata_hashes,
                        )
                    _finish_scan(connection, scan_id, report, root_id)
                    report["status"] = "completed"
                else:
                    report["missing"] = potential_missing
                    report["status"] = "analyzed"
            except KeyboardInterrupt:
                if apply and scan_id is not None:
                    _fail_scan(connection, scan_id, report, "Interrupted", status="cancelled")
                raise
            except Exception as exc:
                if apply and scan_id is not None:
                    _fail_scan(connection, scan_id, report, str(exc))
                raise
            finally:
                if locked:
                    try:
                        with connection.cursor() as cursor:
                            cursor.execute("SELECT RELEASE_LOCK(%s)", (lock_name,))
                    except pymysql.MySQLError:
                        pass
    except CatalogError:
        raise
    except pymysql.MySQLError as exc:
        raise CatalogError(f"Catalog database operation failed: {exc}") from exc
    except OSError as exc:
        raise CatalogError(f"Catalog filesystem operation failed: {exc}") from exc
    finally:
        report["elapsed_ms"] = round((time.monotonic() - started) * 1000)

    return report
