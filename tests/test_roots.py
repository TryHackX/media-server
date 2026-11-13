"""Roots without a scan (``media_server.roots``) and the two CLI doors the installer uses.

The wizard has to tell the catalogue what each folder holds without cataloguing it,
and has to run migrations as an account that is allowed to — the application's own
is not. Both used to be a Python one-liner out of the testing notes.
"""
from __future__ import annotations

import dataclasses
import io
import json
from pathlib import Path

import pytest

from media_server import cli, roots
from media_server.catalog import CatalogError
from media_server.config import AppConfig
from media_server.maintenance import _root_kinds


def _refuse_to_connect(*_args: object, **_kwargs: object) -> None:
    raise AssertionError("the database must not be touched before the request is known to be sound")


@pytest.mark.parametrize(
    ("kinds", "message"),
    [
        ({"films": "movies"}, "nie ma w konfiguracji"),
        ({"music": "audio"}, "Nieznany rodzaj"),
    ],
)
def test_a_wrong_request_is_refused_before_anything_is_written(
    app_config: AppConfig, monkeypatch: pytest.MonkeyPatch, kinds: dict[str, str], message: str
) -> None:
    monkeypatch.setattr(roots, "connect_rows", _refuse_to_connect)
    with pytest.raises(CatalogError, match=message):
        roots.sync_roots(app_config, kinds)


def test_a_folder_that_is_not_there_is_refused(app_config: AppConfig, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(roots, "connect_rows", _refuse_to_connect)
    gone = dataclasses.replace(app_config, roots={"music": app_config.roots["music"] / "nie-ma"})
    with pytest.raises(CatalogError, match="nie istnieje"):
        roots.sync_roots(gone, {"music": "music"})


def _config(app_config: AppConfig, bridge_db, tmp_path: Path, *names: str) -> AppConfig:
    paths = {}
    for name in names:
        paths[name] = tmp_path / name
        paths[name].mkdir(exist_ok=True)
    return dataclasses.replace(app_config, database=bridge_db.config, roots=paths)


def test_the_kind_is_recorded_without_reading_a_single_file(app_config, bridge_db, tmp_path: Path) -> None:
    config = _config(app_config, bridge_db, tmp_path, "music", "films")
    (tmp_path / "music" / "song.mp3").write_bytes(b"not read")

    report = roots.sync_roots(config, {"music": "music", "films": "movies"})

    assert [(entry["id"], entry["kind"], entry["created"]) for entry in report["registered"]] == [
        ("films", "movies", True),
        ("music", "music", True),
    ]
    assert report["disabled"] == [] and report["unregistered"] == []
    # Nothing was catalogued: the row exists, the library is still empty.
    assert bridge_db.value("SELECT COUNT(*) FROM media_items") == 0
    assert bridge_db.value("SELECT COUNT(*) FROM catalog_scans") == 0
    # And this is what the scheduled run reads before it scans.
    assert _root_kinds(config) == {"films": "movies", "music": "music"}


def test_a_root_nobody_described_is_reported_not_guessed(app_config, bridge_db, tmp_path: Path) -> None:
    config = _config(app_config, bridge_db, tmp_path, "music", "archiwum")
    report = roots.sync_roots(config, {"music": "music"})
    assert report["unregistered"] == ["archiwum"]


def test_a_root_taken_out_of_the_configuration_is_switched_off_and_comes_back(
    app_config, bridge_db, bridge_library, tmp_path: Path
) -> None:
    bridge_library.scan("films", "movies", ["Film (1999)/Film.mkv"])
    config = _config(app_config, bridge_db, tmp_path, "music")

    # Not asked for: an old root is left exactly as it was.
    assert roots.sync_roots(config, {"music": "music"})["disabled"] == []
    assert bridge_db.value("SELECT is_enabled FROM media_roots WHERE slug = 'films'") == 1

    report = roots.sync_roots(config, {"music": "music"}, disable_unconfigured=True)
    assert report["disabled"] == ["films"]
    assert bridge_db.value("SELECT is_enabled FROM media_roots WHERE slug = 'films'") == 0
    # Switched off, not deleted: the catalogue keeps what it knew.
    assert bridge_db.value("SELECT COUNT(*) FROM media_items") == 1

    back = dataclasses.replace(config, roots={**config.roots, "films": bridge_library.root_path("films")})
    again = roots.sync_roots(back, {"films": "movies"}, disable_unconfigured=True)
    assert again["registered"] == [{"id": "films", "kind": "movies", "previous_kind": "movies", "created": False}]
    assert bridge_db.value("SELECT is_enabled FROM media_roots WHERE slug = 'films'") == 1


def test_the_list_shows_both_what_is_configured_and_what_is_remembered(
    app_config, bridge_db, bridge_library, tmp_path: Path
) -> None:
    bridge_library.scan("old", "mixed", ["a.mp3"])
    config = _config(app_config, bridge_db, tmp_path, "music")
    roots.sync_roots(config, {"music": "music"})

    listed = {entry["id"]: entry for entry in roots.list_roots(config)["roots"]}

    assert listed["music"]["configured"] is True and listed["music"]["kind"] == "music"
    assert listed["music"]["exists"] is True
    assert listed["old"]["configured"] is False and listed["old"]["kind"] == "mixed"
    assert listed["old"]["path"] is None and listed["old"]["recorded_path"]


def _write_config(tmp_path: Path, transfer_key: bytes, media_root: Path) -> Path:
    import base64

    key = base64.urlsafe_b64encode(transfer_key).rstrip(b"=").decode("ascii")
    path = tmp_path / "config.local.toml"
    path.write_text(
        f'[security]\ntransfer_key = "{key}"\n'
        '[database]\nhost = "127.0.0.1"\nport = 3306\nname = "media_server_test"\nuser = "app"\npassword = "app-secret"\n'
        f'[roots.music]\npath = "{media_root.as_posix()}"\n',
        encoding="utf-8",
    )
    return path


def test_the_cli_refuses_a_kind_without_a_root(
    tmp_path: Path, transfer_key: bytes, media_root: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    config = _write_config(tmp_path, transfer_key, media_root)
    assert cli.main(["--config", str(config), "roots", "sync", "--kind", "music"]) == 1
    assert "ID=RODZAJ" in capsys.readouterr().err


def test_the_cli_hands_the_request_over_and_prints_the_report(
    tmp_path: Path, transfer_key: bytes, media_root: Path, monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    seen: dict[str, object] = {}

    def record(config: AppConfig, kinds: dict[str, str], *, disable_unconfigured: bool) -> dict[str, object]:
        seen.update(kinds=kinds, disable=disable_unconfigured, roots=sorted(config.roots))
        return {"status": "ok", "registered": [], "disabled": [], "unregistered": []}

    monkeypatch.setattr(cli, "sync_roots", record)
    config = _write_config(tmp_path, transfer_key, media_root)
    code = cli.main(["--config", str(config), "roots", "sync", "--kind", "Music=MUSIC", "--disable-unconfigured"])

    assert code == 0
    assert seen == {"kinds": {"music": "music"}, "disable": True, "roots": ["music"]}
    assert json.loads(capsys.readouterr().out)["status"] == "ok"


class _Stdin:
    def __init__(self, data: bytes) -> None:
        self.buffer = io.BytesIO(data)

    def isatty(self) -> bool:
        return False


@pytest.mark.parametrize(
    ("line", "expected"),
    [
        (b"root-secret\r\n", "root-secret"),
        # WAMP's default: an administrator with no password at all.
        (b"\n", ""),
        (b"", ""),
        # A pipe from PowerShell may open with a byte-order mark.
        ((chr(0xFEFF) + "ząb\n").encode("utf-8"), "ząb"),
    ],
)
def test_migrations_can_run_as_another_account_whose_password_never_touches_the_command_line(
    tmp_path: Path, transfer_key: bytes, media_root: Path, monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str], line: bytes, expected: str,
) -> None:
    used: dict[str, object] = {}

    def record(database, migration_dir: Path) -> list[str]:
        used.update(user=database.user, password=database.password, name=database.name, dir=migration_dir)
        return ["001_foundation.sql"]

    monkeypatch.setattr(cli, "apply_migrations", record)
    monkeypatch.setattr(cli.sys, "stdin", _Stdin(line))
    config = _write_config(tmp_path, transfer_key, media_root)

    assert cli.main(["--config", str(config), "migrate", "--as-user", "root", "--password-stdin"]) == 0

    assert (used["user"], used["password"], used["name"]) == ("root", expected, "media_server_test")
    out = capsys.readouterr()
    assert json.loads(out.out) == {"applied": ["001_foundation.sql"], "status": "ok"}
    assert "root-secret" not in out.out + out.err


def test_migrations_still_run_as_the_application_account_when_nothing_else_is_named(
    tmp_path: Path, transfer_key: bytes, media_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    used: dict[str, object] = {}
    monkeypatch.setattr(cli, "apply_migrations", lambda database, _dir: used.update(user=database.user) or [])
    monkeypatch.delenv("MEDIA_SERVER_DB_PASSWORD", raising=False)
    config = _write_config(tmp_path, transfer_key, media_root)

    assert cli.main(["--config", str(config), "migrate"]) == 0
    assert used == {"user": "app"}


def test_a_password_on_stdin_without_an_account_is_a_mistake_worth_naming(
    tmp_path: Path, transfer_key: bytes, media_root: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    config = _write_config(tmp_path, transfer_key, media_root)
    assert cli.main(["--config", str(config), "migrate", "--password-stdin"]) == 1
    assert "--as-user" in capsys.readouterr().err


def test_without_a_terminal_the_password_has_to_come_on_stdin(
    tmp_path: Path, transfer_key: bytes, media_root: Path, monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    monkeypatch.setattr(cli.sys, "stdin", _Stdin(b""))
    config = _write_config(tmp_path, transfer_key, media_root)
    assert cli.main(["--config", str(config), "migrate", "--as-user", "root"]) == 1
    assert "--password-stdin" in capsys.readouterr().err
