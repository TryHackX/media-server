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


# -- MySQL-backed bridge tests (tests/test_bridge_*.py, see tests/bridge_harness.py) --------------
#
# Session-scoped and lazy: nothing here runs unless a test asks for it, and every piece
# skips when PHP, MySQL or the test database is missing.


@pytest.fixture(scope="session")
def _bridge_database_session():
    from bridge_harness import BridgeDatabase, database_config, php_binary

    php_binary()
    database = BridgeDatabase(database_config())
    try:
        database.rebuild()
        yield database
    finally:
        database.close()


@pytest.fixture
def bridge_db(_bridge_database_session):
    """The test database, emptied back to what the migrations leave."""
    _bridge_database_session.reset()
    return _bridge_database_session


@pytest.fixture(scope="session")
def _bridge_runner_session(_bridge_database_session, tmp_path_factory: pytest.TempPathFactory):
    from bridge_harness import PhpRunner, new_transfer_key

    return PhpRunner(_bridge_database_session, tmp_path_factory.mktemp("bridge-php"), new_transfer_key())


@pytest.fixture
def bridge_php(bridge_db, _bridge_runner_session):
    """Run PHP against the bridge classes: ``bridge_php.run("...; out($value);")``."""
    _bridge_runner_session.clear_mail()
    return _bridge_runner_session


@pytest.fixture
def bridge_library(bridge_db, tmp_path: Path):
    """Folders of empty files under ``tmp_path``, catalogued by the real scanner."""
    from bridge_harness import Library

    return Library(bridge_db, tmp_path / "library")


@pytest.fixture(scope="session")
def _bridge_server_session(_bridge_database_session, _bridge_runner_session, tmp_path_factory: pytest.TempPathFactory):
    from bridge_harness import BridgeServer

    server = BridgeServer(_bridge_runner_session, _bridge_database_session, tmp_path_factory.mktemp("bridge-http"))
    try:
        yield server
    finally:
        server.stop()


@pytest.fixture
def bridge_http(bridge_db, bridge_php, _bridge_server_session):
    """``stage/bridge.php`` over HTTP (PHP's built-in server): ``bridge_http.client()`` is one browser."""
    return _bridge_server_session


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
