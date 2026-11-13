"""``media-server account-create``: the way into a fresh installation."""
from __future__ import annotations

import io
import re
import shutil
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

from media_server import accounts, cli

GATEWAY = Path(__file__).resolve().parents[1] / "integrations" / "php" / "AccountGateway.php"


def test_the_rules_match_the_bridge_that_signs_people_in() -> None:
    """One policy for every way an account comes to be — sign-up, panel, command line."""
    source = GATEWAY.read_text(encoding="utf-8")
    minimum = re.search(r"MINIMUM_PASSWORD_LENGTH\s*=\s*(\d+);", source)
    pattern = re.search(r"USERNAME_PATTERN\s*=\s*'/\\A(.+?)\\z/D';", source)
    assert minimum is not None and pattern is not None
    assert int(minimum.group(1)) == accounts.MINIMUM_PASSWORD_LENGTH
    assert pattern.group(1) == accounts.USERNAME_PATTERN.pattern


@pytest.mark.parametrize("username", ["ab", "a" * 33, "with space", "zażółć", "tab\tname", ""])
def test_a_username_the_bridge_would_refuse_is_refused_here(username: str) -> None:
    with pytest.raises(accounts.AccountError):
        accounts.validate_username(username)


def test_passwords_and_addresses_are_checked_like_the_bridge_checks_them() -> None:
    assert accounts.validate_username("owner.main-1") == "owner.main-1"
    with pytest.raises(accounts.AccountError):
        accounts.validate_password("x" * 11)
    assert accounts.validate_password("x" * 12)
    # Bytes, as PHP's strlen counts them: twelve Polish letters are 24 bytes.
    assert accounts.validate_password("ż" * 6)
    with pytest.raises(accounts.AccountError):
        accounts.validate_password("x" * 4097)
    assert accounts.validate_email(None) is None
    assert accounts.validate_email("  ") is None
    assert accounts.validate_email(" owner@example.org ") == "owner@example.org"
    for wrong in ("owner", "owner@", "@example.org", "owner@localhost", "a b@example.org"):
        with pytest.raises(accounts.AccountError):
            accounts.validate_email(wrong)


def test_php_makes_a_hash_its_own_password_verify_accepts() -> None:
    php = shutil.which("php")
    if php is None:
        pytest.skip("PHP nie jest dostępne w PATH")
    password = "zażółć gęślą jaźń 2026"
    hashed = accounts.php_password_hash(password, php)
    assert hashed.startswith("$") and password not in hashed
    check = subprocess.run(
        [php, "-r", "[$p, $h] = explode(\"\\n\", stream_get_contents(STDIN), 2); echo password_verify($p, $h) ? 'yes' : 'no';"],
        input=f"{password}\n{hashed}".encode("utf-8"),
        capture_output=True,
        check=True,
    )
    assert check.stdout == b"yes"


class _Stdin:
    def __init__(self, data: bytes, tty: bool = False) -> None:
        self.buffer = io.BytesIO(data)
        self._tty = tty

    def isatty(self) -> bool:
        return self._tty


def _run(monkeypatch, capsys, argv: list[str], stdin: _Stdin) -> tuple[int, list[dict], str, str]:
    created: list[dict] = []
    monkeypatch.setattr(cli, "_load", lambda _selected: SimpleNamespace(database="db"))
    monkeypatch.setattr(accounts, "resolve_php", lambda explicit: "php")
    monkeypatch.setattr(accounts, "php_password_hash", lambda password, php: f"$hash-of-{len(password)}")

    def fake_create(database, **fields):
        created.append({"database": database, **fields})
        return 41

    monkeypatch.setattr(accounts, "create_account", fake_create)
    monkeypatch.setattr(sys, "stdin", stdin)
    code = cli.main(argv)
    out, err = capsys.readouterr()
    return code, created, out, err


def test_the_password_comes_from_stdin_and_is_never_printed(monkeypatch, capsys) -> None:
    secret = "correct horse battery staple"
    code, created, out, err = _run(
        monkeypatch,
        capsys,
        ["account-create", "--username", "owner", "--email", "owner@example.org", "--password-stdin"],
        _Stdin(("\ufeff" + secret + "\r\nsecond line ignored\n").encode("utf-8")),
    )
    assert code == 0
    assert created == [{
        "database": "db",
        "username": "owner",
        "email": "owner@example.org",
        "password_hash": f"$hash-of-{len(secret)}",
        "role": "super_admin",
    }]
    assert '"status": "created"' in out and '"id": 41' in out
    assert secret not in out and secret not in err


def test_there_is_no_way_to_put_the_password_on_the_command_line(monkeypatch, capsys) -> None:
    with pytest.raises(SystemExit):
        cli._parser().parse_args(["account-create", "--username", "owner", "--password", "hunter2hunter2"])


def test_without_a_terminal_it_asks_for_stdin_instead_of_hanging(monkeypatch, capsys) -> None:
    code, created, _, err = _run(monkeypatch, capsys, ["account-create", "--username", "owner"], _Stdin(b""))
    assert code == 1 and created == []
    assert "--password-stdin" in err


def test_a_short_password_and_a_mismatch_create_nothing(monkeypatch, capsys) -> None:
    code, created, _, err = _run(
        monkeypatch, capsys, ["account-create", "--username", "owner", "--password-stdin"], _Stdin(b"too short\n")
    )
    assert code == 1 and created == [] and "12" in err

    answers = iter(["first password 1", "second password 2"])
    monkeypatch.setattr(cli.getpass, "getpass", lambda _prompt: next(answers))
    code, created, _, err = _run(monkeypatch, capsys, ["account-create", "--username", "owner"], _Stdin(b"", tty=True))
    assert code == 1 and created == [] and "identyczne" in err
