from __future__ import annotations

import hashlib
import re
from pathlib import Path

import pymysql
from pymysql.cursors import DictCursor

from .config import DatabaseConfig


class MigrationError(RuntimeError):
    pass


_MIGRATION_NAME = re.compile(r"^(\d+)_.*\.sql$")
_SPLIT_MARKER = "-- migrate:split"


def _connect(config: DatabaseConfig):
    return pymysql.connect(
        host=config.host,
        port=config.port,
        user=config.user,
        password=config.password,
        database=config.name,
        charset="utf8mb4",
        autocommit=True,
        connect_timeout=5,
        read_timeout=30,
        write_timeout=30,
    )


def connect_rows(config: DatabaseConfig):
    """A connection whose rows are dictionaries, with the long timeouts a scan or a worker needs.

    The scanner, the metadata worker, the title worker and the subtitle job each
    spelt this out for themselves; the fifth copy had lost its timeouts on the
    way, so a database that stopped answering held that job for ever.
    """
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


def load_archive_manifest(config: DatabaseConfig, manifest_id: str) -> bytes | None:
    """The stored file list of a large archive (migration 042), while it is valid.

    Expiry is asked of the database, whose clock the bridge dated the row with.
    The bytes come back exactly as stored: the token's digest covers them.
    """
    with _connect(config) as connection:
        with connection.cursor() as cursor:
            cursor.execute(
                "SELECT items_json FROM archive_manifests"
                " WHERE manifest_key = UNHEX(%s) AND expires_at > CURRENT_TIMESTAMP(6) LIMIT 1",
                (manifest_id,),
            )
            row = cursor.fetchone()
    return None if row is None else bytes(row[0])


def check_database(config: DatabaseConfig) -> None:
    with _connect(config) as connection:
        with connection.cursor() as cursor:
            cursor.execute("SELECT 1")
            if cursor.fetchone() != (1,):
                raise MigrationError("Baza nie odpowiedziała poprawnie")


def apply_migrations(config: DatabaseConfig, migration_dir: Path) -> list[str]:
    migrations: list[tuple[int, Path]] = []
    for path in migration_dir.glob("*.sql"):
        match = _MIGRATION_NAME.fullmatch(path.name)
        if match:
            migrations.append((int(match.group(1)), path))
    migrations.sort(key=lambda row: row[0])
    if not migrations:
        raise MigrationError(f"Brak migracji w {migration_dir}")

    applied_now: list[str] = []
    with _connect(config) as connection:
        with connection.cursor() as cursor:
            cursor.execute("SELECT GET_LOCK(%s, 30)", ("tryhackx_media_schema",))
            locked = cursor.fetchone()
            if not locked or locked[0] != 1:
                raise MigrationError("Nie udało się uzyskać blokady migracji")
            try:
                cursor.execute(
                    """
                    CREATE TABLE IF NOT EXISTS schema_migrations (
                        version BIGINT UNSIGNED NOT NULL PRIMARY KEY,
                        filename VARCHAR(255) NOT NULL,
                        checksum CHAR(64) NOT NULL,
                        applied_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
                    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
                    """
                )
                cursor.execute("SELECT version, checksum FROM schema_migrations")
                applied = {int(version): str(checksum) for version, checksum in cursor.fetchall()}

                for version, path in migrations:
                    source = path.read_text(encoding="utf-8")
                    checksum = hashlib.sha256(source.encode("utf-8")).hexdigest()
                    if version in applied:
                        if applied[version] != checksum:
                            raise MigrationError(f"Zmieniono zastosowaną migrację {path.name}")
                        continue
                    statements = [part.strip() for part in source.split(_SPLIT_MARKER) if part.strip()]
                    try:
                        for statement in statements:
                            cursor.execute(statement)
                        cursor.execute(
                            "INSERT INTO schema_migrations (version, filename, checksum) VALUES (%s, %s, %s)",
                            (version, path.name, checksum),
                        )
                    except Exception as exc:
                        raise MigrationError(f"Migracja {path.name} nie powiodła się: {exc}") from exc
                    applied_now.append(path.name)
            finally:
                cursor.execute("SELECT RELEASE_LOCK(%s)", ("tryhackx_media_schema",))
    return applied_now
