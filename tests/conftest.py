from __future__ import annotations

from pathlib import Path

import pytest

from media_server.config import (
    AppConfig,
    DatabaseConfig,
    SecurityConfig,
    ServerConfig,
    TransferConfig,
)


@pytest.fixture
def transfer_key() -> bytes:
    return bytes(range(32))


@pytest.fixture
def media_root(tmp_path: Path) -> Path:
    root = tmp_path / "media"
    root.mkdir()
    return root


@pytest.fixture
def app_config(tmp_path: Path, media_root: Path, transfer_key: bytes) -> AppConfig:
    return AppConfig(
        source_path=tmp_path / "config.local.toml",
        server=ServerConfig(),
        security=SecurityConfig(
            transfer_key=transfer_key,
            max_token_ttl_seconds=900,
            clock_skew_seconds=0,
            max_token_bytes=65536,
        ),
        transfer=TransferConfig(
            chunk_size=4,
            max_concurrent_transfers=2,
            queue_timeout_seconds=1,
            max_archive_entries=100,
        ),
        database=DatabaseConfig(
            host="127.0.0.1",
            port=3306,
            name="media_server_test",
            user="test",
            password="test",
        ),
        roots={"music": media_root},
    )
