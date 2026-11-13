"""The encrypted copy of an installation's secrets (``scripts/secret-backup.py``).

What it has to guarantee is short: the file is useless without the passphrase,
a changed file is refused rather than half-read, restoring never overwrites or
escapes its folder — and no password ever appears on a command line.
"""
from __future__ import annotations

import gzip
import importlib.util
import io
import subprocess
import sys
import tarfile
from pathlib import Path

import pytest

pytest.importorskip("cryptography")

PROJECT_ROOT = Path(__file__).resolve().parents[1]


def _load():
    spec = importlib.util.spec_from_file_location("secret_backup", PROJECT_ROOT / "scripts" / "secret-backup.py")
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules["secret_backup"] = module
    spec.loader.exec_module(module)
    return module


backup = _load()
PASSPHRASE = "correct horse battery staple"


@pytest.fixture(autouse=True)
def _quick_key_derivation(monkeypatch: pytest.MonkeyPatch) -> None:
    # The real parameters cost 64 MiB and a moment per derivation; the format is the same with the floor.
    monkeypatch.setattr(backup, "SCRYPT", {"n": 2**14, "r": 8, "p": 1})


def _installation(tmp_path: Path) -> Path:
    root = tmp_path / "server"
    (root / "config" / "origin").mkdir(parents=True)
    (root / "integrations" / "php" / "stage").mkdir(parents=True)
    (root / "config" / "config.local.toml").write_text(
        '[security]\ntransfer_key = "KEY-VALUE-THAT-MUST-STAY-SECRET"\n'
        '[database]\nhost = "127.0.0.1"\nport = 3306\nname = "media_server"\nuser = "media_server"\n'
        'password = "DB-PASSWORD-THAT-MUST-STAY-SECRET"\n',
        encoding="utf-8",
    )
    (root / "config" / "installer.local.json").write_text('{"version": 1}', encoding="utf-8")
    (root / "config" / "origin" / "origin-key.pem").write_text("ORIGIN-KEY-THAT-MUST-STAY-SECRET", encoding="utf-8")
    (root / "config" / "origin" / "origin-cert.pem").write_text("certificate", encoding="utf-8")
    (root / "config" / "config.example.toml").write_text("# not a secret, not collected", encoding="utf-8")
    return root


def test_what_was_sealed_comes_back_and_nothing_readable_is_in_the_file() -> None:
    sealed = backup.encrypt_bytes(b"DB-PASSWORD-THAT-MUST-STAY-SECRET " * 50, PASSPHRASE)
    assert sealed.startswith(b"THXBAK1\n")
    assert b"DB-PASSWORD" not in sealed and PASSPHRASE.encode() not in sealed
    assert backup.decrypt_bytes(sealed, PASSPHRASE) == b"DB-PASSWORD-THAT-MUST-STAY-SECRET " * 50
    # Sealing the same thing twice gives two different files: a fresh salt and nonce each time.
    assert backup.encrypt_bytes(b"x", PASSPHRASE) != backup.encrypt_bytes(b"x", PASSPHRASE)


def test_a_wrong_passphrase_and_a_changed_file_are_both_refused() -> None:
    sealed = backup.encrypt_bytes(b"secret", PASSPHRASE)
    with pytest.raises(backup.BackupError, match="złe hasło albo plik został zmieniony"):
        backup.decrypt_bytes(sealed, PASSPHRASE + "!")
    flipped = bytearray(sealed)
    flipped[-1] ^= 1
    with pytest.raises(backup.BackupError, match="zmieniony"):
        backup.decrypt_bytes(bytes(flipped), PASSPHRASE)
    # The header is authenticated too: weakening a parameter in it is a failed decryption.
    weakened = sealed.replace(b'"n": 16384', b'"n": 32768')
    assert weakened != sealed
    with pytest.raises(backup.BackupError):
        backup.decrypt_bytes(weakened, PASSPHRASE)
    with pytest.raises(backup.BackupError, match="THXBAK1"):
        backup.decrypt_bytes(b"PK\x03\x04 not ours", PASSPHRASE)
    with pytest.raises(backup.BackupError, match="nagłówek"):
        backup.decrypt_bytes(b"THXBAK1\n{not json}\nxxxx", PASSPHRASE)


def test_parameters_that_would_protect_nothing_or_exhaust_memory_are_refused() -> None:
    sealed = backup.encrypt_bytes(b"secret", PASSPHRASE)
    for bad in (b'"n": 2', b'"n": 1073741824', b'"n": 16385'):
        with pytest.raises(backup.BackupError, match="parametry"):
            backup.decrypt_bytes(sealed.replace(b'"n": 16384', bad), PASSPHRASE)


def test_a_short_passphrase_is_not_accepted() -> None:
    with pytest.raises(backup.BackupError, match="co najmniej 12"):
        backup.encrypt_bytes(b"secret", "short")


def test_only_private_files_are_collected(tmp_path: Path) -> None:
    root = _installation(tmp_path)
    outside = tmp_path / "notes.txt"
    outside.write_text("deploy notes", encoding="utf-8")
    names = [name for name, _path in backup.collect_files(root, [str(outside), "config/installer.local.json"])]
    assert names == [
        "config/config.local.toml", "config/installer.local.json", "config/origin/origin-cert.pem",
        "config/origin/origin-key.pem", "external/notes.txt",
    ]
    with pytest.raises(backup.BackupError, match="Nie ma takiego pliku"):
        backup.collect_files(root, ["config/nie-ma.toml"])


def test_the_archive_restores_into_an_empty_folder_and_overwrites_nothing(tmp_path: Path) -> None:
    root = _installation(tmp_path)
    payload = backup.build_archive(backup.collect_files(root), b"-- dump\nCREATE TABLE x (id INT);\n", moment=1_780_000_000)
    assert backup.list_archive(payload) == [
        ("config/config.local.toml", (root / "config/config.local.toml").stat().st_size),
        ("config/installer.local.json", 14),
        ("config/origin/origin-cert.pem", 11),
        ("config/origin/origin-key.pem", 32),
        ("database/dump.sql", 33),
    ]
    target = tmp_path / "restored"
    written = backup.extract_archive(payload, target)
    assert len(written) == 5
    assert (target / "config/config.local.toml").read_bytes() == (root / "config/config.local.toml").read_bytes()
    assert (target / "database/dump.sql").read_bytes() == b"-- dump\nCREATE TABLE x (id INT);\n"

    (target / "database/dump.sql").write_bytes(b"something newer")
    with pytest.raises(backup.BackupError, match="nie zostało nadpisane"):
        backup.extract_archive(payload, target)
    assert (target / "database/dump.sql").read_bytes() == b"something newer"


@pytest.mark.parametrize("name", ["../outside.txt", "/etc/passwd", "C:/Windows/x", "a\\..\\b"])
def test_an_archive_that_tries_to_leave_its_folder_is_refused(tmp_path: Path, name: str) -> None:
    buffer = io.BytesIO()
    with gzip.GzipFile(fileobj=buffer, mode="wb") as compressed, tarfile.open(fileobj=compressed, mode="w") as archive:
        info = tarfile.TarInfo(name)
        info.size = 1
        archive.addfile(info, io.BytesIO(b"x"))
    with pytest.raises(backup.BackupError, match="niedozwolony wpis"):
        backup.extract_archive(buffer.getvalue(), tmp_path / "out")
    assert not (tmp_path / "outside.txt").exists()


def test_the_database_password_reaches_mysqldump_through_a_file_never_the_command_line(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = _installation(tmp_path)
    seen: dict[str, object] = {}

    def fake_run(command: list[str], **kwargs: object) -> subprocess.CompletedProcess[bytes]:
        options = Path(command[1].split("=", 1)[1])
        seen.update(command=command, options=options, text=options.read_text(encoding="utf-8"))
        return subprocess.CompletedProcess(command, 0, stdout=b"-- dump of media_server\n", stderr=b"")

    monkeypatch.setattr(backup.subprocess, "run", fake_run)
    dump = backup.dump_database(root / "config" / "config.local.toml", "mysqldump")

    assert dump == b"-- dump of media_server\n"
    command = seen["command"]
    assert command[0] == "mysqldump" and command[1].startswith("--defaults-extra-file=") and command[-1] == "media_server"
    assert "--single-transaction" in command and "--no-tablespaces" in command
    assert not any("SECRET" in part for part in command)
    assert 'password="DB-PASSWORD-THAT-MUST-STAY-SECRET"' in seen["text"] and 'user="media_server"' in seen["text"]
    assert not seen["options"].exists(), "the option file is removed as soon as the dump is taken"


def test_a_failed_dump_says_so_and_leaves_no_password_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    root = _installation(tmp_path)
    files: list[Path] = []

    def fake_run(command: list[str], **kwargs: object) -> subprocess.CompletedProcess[bytes]:
        files.append(Path(command[1].split("=", 1)[1]))
        return subprocess.CompletedProcess(command, 2, stdout=b"", stderr=b"mysqldump: Got error: 1045: Access denied\n")

    monkeypatch.setattr(backup.subprocess, "run", fake_run)
    with pytest.raises(backup.BackupError, match="1045"):
        backup.dump_database(root / "config" / "config.local.toml", "mysqldump")
    assert files and not files[0].exists()


def test_the_whole_command_from_installation_to_restored_folder(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    root = _installation(tmp_path)
    monkeypatch.setattr(backup, "PROJECT_ROOT", root)
    monkeypatch.setattr(backup, "dump_database", lambda _config, _tool: b"-- DUMP-THAT-MUST-STAY-SECRET\n")
    monkeypatch.setattr(backup, "find_mysqldump", lambda _explicit=None: "mysqldump")
    monkeypatch.setenv("SECRET_BACKUP_PASSPHRASE", PASSPHRASE)
    sealed = tmp_path / "copy.thxbak"

    assert backup.main(["encrypt", "--output", str(sealed)]) == 0
    out = capsys.readouterr().out
    assert "config/config.local.toml" in out and "database/dump.sql" in out
    raw = sealed.read_bytes()
    for secret in (b"KEY-VALUE-THAT-MUST-STAY-SECRET", b"DB-PASSWORD-THAT-MUST-STAY-SECRET", b"ORIGIN-KEY-THAT-MUST-STAY-SECRET",
                   b"DUMP-THAT-MUST-STAY-SECRET", b"config.local.toml"):
        assert secret not in raw, "not even the file names are readable without the passphrase"
    # An existing copy is never overwritten.
    assert backup.main(["encrypt", "--output", str(sealed)]) == 1
    assert "nie zostanie nadpisany" in capsys.readouterr().err

    assert backup.main(["list", str(sealed)]) == 0
    assert "config/origin/origin-key.pem" in capsys.readouterr().out

    restored = tmp_path / "restored"
    assert backup.main(["decrypt", str(sealed), "--output-dir", str(restored)]) == 0
    assert (restored / "config/origin/origin-key.pem").read_text(encoding="utf-8") == "ORIGIN-KEY-THAT-MUST-STAY-SECRET"
    assert (restored / "database/dump.sql").read_bytes() == b"-- DUMP-THAT-MUST-STAY-SECRET\n"
    capsys.readouterr()

    monkeypatch.setenv("SECRET_BACKUP_PASSPHRASE", "not the passphrase at all")
    assert backup.main(["decrypt", str(sealed), "--output-dir", str(tmp_path / "other")]) == 1
    assert "złe hasło" in capsys.readouterr().err and not (tmp_path / "other").exists()


def test_the_passphrase_can_come_from_a_file_and_never_from_a_pipe_by_accident(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    secret = tmp_path / "passphrase.txt"
    secret.write_text("\ufeff" + PASSPHRASE + "\nsecond line is ignored\n", encoding="utf-8")
    args = backup._parser().parse_args(["list", "x.thxbak", "--passphrase-file", str(secret)])
    assert backup.read_passphrase(args, confirm=False) == PASSPHRASE

    monkeypatch.delenv("SECRET_BACKUP_PASSPHRASE", raising=False)
    monkeypatch.setattr(backup.sys, "stdin", io.StringIO(PASSPHRASE))
    args = backup._parser().parse_args(["list", "x.thxbak"])
    with pytest.raises(backup.BackupError, match="Brak terminala"):
        backup.read_passphrase(args, confirm=False)


def test_without_a_dump_tool_the_backup_says_how_to_continue(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    root = _installation(tmp_path)
    monkeypatch.setattr(backup, "PROJECT_ROOT", root)
    monkeypatch.setattr(backup, "find_mysqldump", lambda _explicit=None: None)
    monkeypatch.setenv("SECRET_BACKUP_PASSPHRASE", PASSPHRASE)
    assert backup.main(["encrypt", "--output", str(tmp_path / "a.thxbak")]) == 1
    assert "--no-database" in capsys.readouterr().err
    assert backup.main(["encrypt", "--output", str(tmp_path / "a.thxbak"), "--no-database"]) == 0
    payload = backup.decrypt_bytes((tmp_path / "a.thxbak").read_bytes(), PASSPHRASE)
    assert "database/dump.sql" not in [name for name, _size in backup.list_archive(payload)]
