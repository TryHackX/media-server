from __future__ import annotations

import base64
import ipaddress
import os
import re
import tomllib
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping


class ConfigError(RuntimeError):
    """Raised when the private runtime configuration is unsafe or incomplete."""


@dataclass(frozen=True, slots=True)
class ServerConfig:
    host: str = "127.0.0.1"
    port: int = 8765
    allow_remote_bind: bool = False


@dataclass(frozen=True, slots=True)
class SecurityConfig:
    transfer_key: bytes
    max_token_ttl_seconds: int = 900
    clock_skew_seconds: int = 30
    max_token_bytes: int = 65536


@dataclass(frozen=True, slots=True)
class TransferConfig:
    chunk_size: int = 512 * 1024
    max_concurrent_transfers: int = 8
    queue_timeout_seconds: float = 10.0
    max_archive_entries: int = 1000


@dataclass(frozen=True, slots=True)
class ThumbnailConfig:
    cache_path: Path | None = None
    seek_seconds: int = 120


@dataclass(frozen=True, slots=True)
class StereoConfig:
    ffmpeg_path: str | None = None
    bitrate_kbps: int = 192
    video_encoder: str = "libx264"
    max_concurrent_jobs: int = 2
    timeout_seconds: int = 21600
    subtitle_cache_path: Path | None = None
    # How long one picture-subtitle track may take to render before it is given
    # up on. Tens of seconds is normal; the ceiling is for a file that misbehaves.
    subtitle_render_timeout_seconds: int = 1800


@dataclass(frozen=True, slots=True)
class DatabaseConfig:
    host: str
    port: int
    name: str
    user: str
    password: str


@dataclass(frozen=True, slots=True)
class AppConfig:
    source_path: Path
    server: ServerConfig
    security: SecurityConfig
    transfer: TransferConfig
    database: DatabaseConfig
    roots: Mapping[str, Path]
    thumbnails: ThumbnailConfig = ThumbnailConfig()
    stereo: StereoConfig = StereoConfig()


_ROOT_ID = re.compile(r"^[a-z][a-z0-9_-]{0,31}$")
_DATABASE_NAME = re.compile(r"^[A-Za-z0-9_]{1,64}$")

# Base for relative project-internal paths (caches, bundled FFmpeg). Resolving them
# against the source tree — not the CWD or the config file — keeps one private config
# valid when the whole tree is moved out of DocumentRoot or deployed to /opt.
PROJECT_ROOT = Path(__file__).resolve().parents[2]


def _project_path(raw: object, name: str) -> Path:
    if not isinstance(raw, str) or raw == "" or "\x00" in raw:
        raise ConfigError(f"{name} must be a path")
    path = Path(raw).expanduser()
    return path if path.is_absolute() else (PROJECT_ROOT / path).resolve()


def _as_table(raw: dict, name: str) -> dict:
    value = raw.get(name, {})
    if not isinstance(value, dict):
        raise ConfigError(f"Sekcja [{name}] musi być tabelą TOML")
    return value


def _bounded_int(value: object, name: str, minimum: int, maximum: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError) as exc:
        raise ConfigError(f"{name} musi być liczbą całkowitą") from exc
    if not minimum <= parsed <= maximum:
        raise ConfigError(f"{name} musi mieścić się w zakresie {minimum}..{maximum}")
    return parsed


def _decode_transfer_key(value: str) -> bytes:
    if value == "GENERATE_WITH_INSTALLER":
        raise ConfigError("Klucz transferowy nie został wygenerowany")
    try:
        padding = "=" * (-len(value) % 4)
        key = base64.urlsafe_b64decode(value + padding)
    except Exception as exc:
        raise ConfigError("security.transfer_key nie jest poprawnym base64url") from exc
    if len(key) != 32:
        raise ConfigError("security.transfer_key musi kodować dokładnie 32 losowe bajty")
    return key


def _is_loopback(host: str) -> bool:
    if host.lower() == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def load_config(path: str | os.PathLike[str] | None = None) -> AppConfig:
    selected = Path(path or os.environ.get("MEDIA_SERVER_CONFIG", "config/config.local.toml"))
    selected = selected.expanduser().resolve()
    if not selected.is_file():
        raise ConfigError(f"Brak konfiguracji: {selected}")

    try:
        raw = tomllib.loads(selected.read_text(encoding="utf-8"))
    except (OSError, tomllib.TOMLDecodeError) as exc:
        raise ConfigError(f"Nie można odczytać konfiguracji: {exc}") from exc

    server_raw = _as_table(raw, "server")
    host = str(server_raw.get("host", "127.0.0.1")).strip()
    allow_remote = bool(server_raw.get("allow_remote_bind", False))
    if not _is_loopback(host) and not allow_remote:
        raise ConfigError("Nasłuch poza loopback wymaga server.allow_remote_bind = true")
    server = ServerConfig(
        host=host,
        port=_bounded_int(server_raw.get("port", 8765), "server.port", 1, 65535),
        allow_remote_bind=allow_remote,
    )

    security_raw = _as_table(raw, "security")
    encoded_key = os.environ.get("MEDIA_SERVER_TRANSFER_KEY", str(security_raw.get("transfer_key", "")))
    security = SecurityConfig(
        transfer_key=_decode_transfer_key(encoded_key),
        max_token_ttl_seconds=_bounded_int(
            security_raw.get("max_token_ttl_seconds", 900),
            "security.max_token_ttl_seconds",
            30,
            86400,
        ),
        clock_skew_seconds=_bounded_int(
            security_raw.get("clock_skew_seconds", 30),
            "security.clock_skew_seconds",
            0,
            300,
        ),
        max_token_bytes=_bounded_int(
            security_raw.get("max_token_bytes", 65536),
            "security.max_token_bytes",
            1024,
            262144,
        ),
    )

    transfer_raw = _as_table(raw, "transfer")
    transfer = TransferConfig(
        chunk_size=_bounded_int(
            transfer_raw.get("chunk_size_kib", 512),
            "transfer.chunk_size_kib",
            64,
            4096,
        )
        * 1024,
        max_concurrent_transfers=_bounded_int(
            transfer_raw.get("max_concurrent_transfers", 8),
            "transfer.max_concurrent_transfers",
            1,
            256,
        ),
        queue_timeout_seconds=float(transfer_raw.get("queue_timeout_seconds", 10)),
        max_archive_entries=_bounded_int(
            transfer_raw.get("max_archive_entries", 1000),
            "transfer.max_archive_entries",
            1,
            10000,
        ),
    )
    if not 0.1 <= transfer.queue_timeout_seconds <= 300:
        raise ConfigError("transfer.queue_timeout_seconds musi mieścić się w zakresie 0.1..300")

    database_raw = _as_table(raw, "database")
    database_name = str(database_raw.get("name", "media_server")).strip()
    if not _DATABASE_NAME.fullmatch(database_name):
        raise ConfigError("database.name może zawierać tylko litery, cyfry i podkreślenia")
    database = DatabaseConfig(
        host=str(database_raw.get("host", "127.0.0.1")).strip(),
        port=_bounded_int(database_raw.get("port", 3306), "database.port", 1, 65535),
        name=database_name,
        user=str(database_raw.get("user", "media_server")).strip(),
        password=os.environ.get("MEDIA_SERVER_DB_PASSWORD", str(database_raw.get("password", ""))),
    )
    if not database.user:
        raise ConfigError("database.user nie może być pusty")

    thumbnails_raw = _as_table(raw, "thumbnails")
    thumbnail_path_raw = thumbnails_raw.get("cache_path")
    thumbnail_path = None
    if thumbnail_path_raw not in {None, ""}:
        thumbnail_path = _project_path(thumbnail_path_raw, "thumbnails.cache_path")
    thumbnails = ThumbnailConfig(
        cache_path=thumbnail_path,
        seek_seconds=_bounded_int(
            thumbnails_raw.get("seek_seconds", 120),
            "thumbnails.seek_seconds",
            1,
            3600,
        ),
    )

    stereo_raw = _as_table(raw, "stereo")
    ffmpeg_raw = stereo_raw.get("ffmpeg_path")
    ffmpeg_path = None
    if ffmpeg_raw not in {None, ""}:
        if not isinstance(ffmpeg_raw, str) or "\x00" in ffmpeg_raw or "\r" in ffmpeg_raw or "\n" in ffmpeg_raw:
            raise ConfigError("stereo.ffmpeg_path is invalid")
        if re.fullmatch(r"[A-Za-z0-9._-]+", ffmpeg_raw) is not None:
            # A bare executable name is looked up on PATH by the process.
            ffmpeg_path = ffmpeg_raw
        else:
            # Absolute, or relative to the project tree (e.g. a bundled build in runtime/).
            ffmpeg_path = str(_project_path(ffmpeg_raw, "stereo.ffmpeg_path"))
    subtitle_cache_raw = stereo_raw.get("subtitle_cache_path")
    subtitle_cache_path = None
    if subtitle_cache_raw not in {None, ""}:
        subtitle_cache_path = _project_path(subtitle_cache_raw, "stereo.subtitle_cache_path")
    stereo = StereoConfig(
        ffmpeg_path=ffmpeg_path,
        bitrate_kbps=_bounded_int(stereo_raw.get("bitrate_kbps", 192), "stereo.bitrate_kbps", 64, 512),
        video_encoder=str(stereo_raw.get("video_encoder", "libx264")),
        max_concurrent_jobs=_bounded_int(
            stereo_raw.get("max_concurrent_jobs", 2), "stereo.max_concurrent_jobs", 1, 4
        ),
        timeout_seconds=_bounded_int(
            stereo_raw.get("timeout_seconds", 21600), "stereo.timeout_seconds", 60, 86400
        ),
        subtitle_cache_path=subtitle_cache_path,
        subtitle_render_timeout_seconds=_bounded_int(
            stereo_raw.get("subtitle_render_timeout_seconds", 1800),
            "stereo.subtitle_render_timeout_seconds", 60, 21600,
        ),
    )
    if stereo.video_encoder not in {"libx264", "h264_nvenc"}:
        raise ConfigError("stereo.video_encoder must be libx264 or h264_nvenc")
    roots_raw = _as_table(raw, "roots")
    roots: dict[str, Path] = {}
    for root_id, root_value in roots_raw.items():
        if not _ROOT_ID.fullmatch(root_id):
            raise ConfigError(f"Niepoprawny identyfikator źródła: {root_id!r}")
        if not isinstance(root_value, dict) or not isinstance(root_value.get("path"), str):
            raise ConfigError(f"roots.{root_id}.path musi być ścieżką")
        root_path = Path(root_value["path"]).expanduser()
        if not root_path.is_absolute():
            raise ConfigError(f"roots.{root_id}.path musi być ścieżką bezwzględną")
        roots[root_id] = root_path
    if not roots:
        raise ConfigError("Należy skonfigurować co najmniej jedno źródło mediów")

    return AppConfig(
        source_path=selected,
        server=server,
        security=security,
        transfer=transfer,
        database=database,
        roots=roots,
        thumbnails=thumbnails,
        stereo=stereo,
    )
