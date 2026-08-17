from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

LOADER = Path(__file__).resolve().parents[1] / "integrations" / "php" / "BridgeConfigLoader.php"


def _php_load(config: Path) -> subprocess.CompletedProcess[str]:
    php = shutil.which("php")
    if php is None:
        pytest.skip("PHP nie jest dostępne w PATH")
    body = (
        f"require {json.dumps(str(LOADER))};"
        f"$c=TryHackX\\Media\\Integration\\BridgeConfigLoader::load({json.dumps(str(config))});"
        "echo json_encode($c, JSON_THROW_ON_ERROR);"
    )
    return subprocess.run([php, "-r", body], capture_output=True, text=True)


def test_toml_is_mapped_to_php_bridge_config(tmp_path: Path) -> None:
    config = tmp_path / "config.toml"
    config.write_text(
        '[security]\ntransfer_key = "' + "A" * 43 + '"\n\n'
        '[database]\nhost = "127.0.0.1"\nport = 3306\n'
        'name = "media_server_stage"\nuser = "media"\npassword = "secret"\n',
        encoding="utf-8",
    )

    result = _php_load(config)

    assert result.returncode == 0, result.stderr
    loaded = json.loads(result.stdout)
    assert loaded["database"] == {
        "dsn": "mysql:host=127.0.0.1;port=3306;dbname=media_server_stage;charset=utf8mb4",
        "user": "media",
        "password": "secret",
    }
    assert loaded["transfer"] == {
        "key": "A" * 43,
        "base_url": "/media-transfer",
        "internal_url": "http://127.0.0.1:8765",
    }
    # Our own cookie, not the PHPSESSID the portal in the same DocumentRoot used
    # to share: a session here can no longer be handed to anything else on the host.
    assert loaded["session"] == {"name": "TRYHACKXSESSID", "require_https": True}


def _php_parse_toml(source: str) -> subprocess.CompletedProcess[str]:
    php = shutil.which("php")
    if php is None:
        pytest.skip("PHP nie jest dostępne w PATH")
    body = (
        f"require {json.dumps(str(LOADER))};"
        f"$c=TryHackX\\Media\\Integration\\BridgeConfigLoader::parseToml({json.dumps(source)});"
        "echo json_encode($c, JSON_THROW_ON_ERROR);"
    )
    return subprocess.run([php, "-r", body], capture_output=True, text=True, encoding="utf-8")


def test_toml_comments_and_types_match_python_tomllib(tmp_path: Path) -> None:
    import tomllib

    source = (
        "# komentarz z nawiasami (parse_ini_file odrzucał cały plik)\n"
        "[server]\n"
        "port = 8765 # komentarz w linii\n"
        "allow_remote_bind = false\n"
        "\n"
        "[security]\n"
        'transfer_key = "abc\\"def#nie-komentarz" # prawdziwy komentarz\n'
        "\n"
        "[roots.movies]\n"
        'path = "E:\\\\Filmy Video"\n'
        "\n"
        "[roots.music]\n"
        "path = 'E:\\Muzyka'\n"
        "\n"
        "[mail]\n"
        "port = 2_525\n"
        'from_name = "Zażółć \\u00e9"\n'
        "ratio = 1.5\n"
        "hex = 0x1F\n"
        "negative = -7\n"
        "[deep]\n"
        "a.b = 1\n"
        'a."c d" = 2\n'
    )

    result = _php_parse_toml(source)

    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout) == tomllib.loads(source)


@pytest.mark.parametrize(
    "source",
    [
        "a = [1, 2]",
        "a = {b = 1}",
        'a = """multi"""',
        "[[arr]]\nx = 1",
        "[t]\nx = 1\n[t]\ny = 2",
        "x = 1\nx = 2",
        "a.b = 1\na = 2",
        "a = 2026-01-01",
        'a = "unterminated',
        "= 1",
        'a = "x" y',
        'a = "bad \\q escape"',
    ],
)
def test_toml_parser_rejects_unsupported_or_invalid_syntax(source: str) -> None:
    result = _php_parse_toml(source)

    assert result.returncode != 0
    assert "RuntimeException" in result.stdout + result.stderr


def test_example_toml_parses_and_documents_every_bridge_key() -> None:
    example = LOADER.parents[2] / "config" / "config.example.toml"

    result = _php_parse_toml(example.read_text(encoding="utf-8"))

    assert result.returncode == 0, result.stderr
    loaded = json.loads(result.stdout)
    assert loaded["database"]["name"] == "media_server"
    assert loaded["server"]["port"] == 8765
    assert set(loaded["roots"]) == {"music", "movies"}


def test_optional_sections_share_defaults_across_toml_and_php(tmp_path: Path) -> None:
    toml_config = tmp_path / "config.toml"
    toml_config.write_text(
        '[security]\ntransfer_key = "' + "A" * 43 + '"\n\n'
        '[database]\nhost = "127.0.0.1"\nport = 3306\n'
        'name = "media_server_stage"\nuser = "media"\npassword = "secret"\n'
        '[mail]\nport = 2525\nfrom_name = "Stage"\n',
        encoding="utf-8",
    )
    php_config = tmp_path / "config.php"
    php_config.write_text(
        "<?php return ['database' => ['dsn' => 'mysql:host=127.0.0.1;port=3306;dbname=x;charset=utf8mb4',"
        " 'user' => 'media', 'password' => 'secret'], 'transfer' => ['key' => '"
        + "A" * 43
        + "', 'base_url' => '/media-transfer', 'internal_url' => 'http://127.0.0.1:8765'],"
        " 'session' => ['name' => 'TRYHACKXSESSID', 'require_https' => true]];",
        encoding="utf-8",
    )

    from_toml = _php_load(toml_config)
    from_php = _php_load(php_config)

    assert from_toml.returncode == 0, from_toml.stderr
    assert from_php.returncode == 0, from_php.stderr
    toml_loaded = json.loads(from_toml.stdout)
    php_loaded = json.loads(from_php.stdout)
    assert toml_loaded["mail"]["port"] == 2525
    assert toml_loaded["mail"]["from_name"] == "Stage"
    assert toml_loaded["mail"]["security"] == "starttls"
    assert php_loaded["mail"]["port"] == 587
    assert php_loaded["mail"]["from_address"] == "no-reply@localhost"
    # Both formats fall back to the same on-disk spool so activation works without SMTP.
    assert toml_loaded["mail"]["spool_path"] == php_loaded["mail"]["spool_path"]
    assert toml_loaded["mail"]["spool_path"].replace("\\", "/").endswith("/logs/mail")
    # The root: where the frontend is built to stand unless somebody asks for a
    # subdirectory. A default pointing anywhere else sends activation links to a
    # path the server does not serve.
    assert toml_loaded["app"] == php_loaded["app"] == {"base_url": "/"}


@pytest.mark.parametrize("host", ["127.0.0.1;charset=latin1", "localhost;unix_socket=x"])
def test_toml_rejects_dsn_injection(tmp_path: Path, host: str) -> None:
    config = tmp_path / "config.toml"
    config.write_text(
        '[security]\ntransfer_key = "' + "A" * 43 + '"\n\n'
        f'[database]\nhost = "{host}"\nport = 3306\n'
        'name = "media_server"\nuser = "media"\npassword = "secret"\n',
        encoding="utf-8",
    )

    result = _php_load(config)

    assert result.returncode != 0
    failure = result.stdout + result.stderr
    assert "RuntimeException" in failure
    assert "BridgeConfigLoader.php" in failure
