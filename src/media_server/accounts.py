"""Accounts from the command line — above all the first one.

A fresh installation has no account, and registration comes switched off, so the
login page under the server's address opens for nobody. Until now the way in was
three rounds of SQL: open registration, sign up in a browser, promote the account
by hand, close registration again. ``media-server account-create`` does it in one
step and never opens the door to anybody else.

The password is hashed by PHP, not here. The bridge checks it with
``password_verify()``, and what that accepts is whatever its own
``password_hash()`` produces — bcrypt today, perhaps something else after a PHP
upgrade. Producing the hash anywhere else would mean re-implementing that choice
and hoping it stays in step; asking PHP is one short process, and PHP is on every
machine this runs on (it serves the bridge; on Debian the digest unit runs
``/usr/bin/php``). The password travels to it on stdin, never on a command line,
where any other user of the machine could read it in the process list.
"""
from __future__ import annotations

import json
import re
import shutil
import subprocess
from pathlib import Path

import pymysql

from .config import DatabaseConfig
from .database import _connect

# Mirrors of AccountGateway::USERNAME_PATTERN and ::MINIMUM_PASSWORD_LENGTH — one
# policy for every way an account comes to be (tests/test_accounts.py compares).
USERNAME_PATTERN = re.compile(r"[A-Za-z0-9._-]{3,32}")
USERNAME_RULE = "Nazwa użytkownika może mieć 3-32 znaki: litery, cyfry, kropka, podkreślenie lub myślnik."
MINIMUM_PASSWORD_LENGTH = 12
# PHP measures both in bytes (strlen), so they are measured in bytes here too.
MAXIMUM_PASSWORD_BYTES = 4096
ROLES = ("super_admin", "admin", "user")

# Hashes, verifies its own result and prints nothing else; warnings go to stderr.
_PHP_HASH = (
    "$p = stream_get_contents(STDIN);"
    " $h = password_hash($p, PASSWORD_DEFAULT);"
    " if (!is_string($h) || !password_verify($p, $h)) { exit(3); }"
    " echo $h;"
)
_HASH_SHAPE = re.compile(r"\$(?:2y\$\d{2}\$[./A-Za-z0-9]{53}|argon2id?\$v=\d+\$m=\d+,t=\d+,p=\d+\$\S+)")


class AccountError(ValueError):
    """A refusal worth reading as it is: the operator typed something we will not store."""


def validate_username(username: str) -> str:
    if USERNAME_PATTERN.fullmatch(username) is None:
        raise AccountError(USERNAME_RULE)
    return username


def validate_email(email: str | None) -> str | None:
    """Optional, but when given it has to look like an address and be storable."""
    if email is None:
        return None
    email = email.strip()
    if not email:
        return None
    local, separator, domain = email.rpartition("@")
    if not separator or not local or "." not in domain or len(email) > 254 or any(ch.isspace() for ch in email):
        raise AccountError("Nieprawidłowy adres e-mail.")
    return email


def validate_password(password: str) -> str:
    size = len(password.encode("utf-8"))
    if size < MINIMUM_PASSWORD_LENGTH:
        raise AccountError(f"Hasło musi mieć co najmniej {MINIMUM_PASSWORD_LENGTH} znaków.")
    if size > MAXIMUM_PASSWORD_BYTES:
        raise AccountError("Hasło jest za długie.")
    return password


def resolve_php(explicit: str | None) -> str:
    """The PHP executable: the one named, or the first on PATH."""
    if explicit:
        candidate = Path(explicit)
        if candidate.is_file():
            return str(candidate)
        found = shutil.which(explicit)
        if found:
            return found
        raise AccountError(f"Nie znaleziono PHP: {explicit}")
    found = shutil.which("php")
    if found is None:
        raise AccountError(
            "Nie znaleziono PHP w PATH — hasło liczy password_hash() mostu. Wskaż je przez --php."
        )
    return found


def php_password_hash(password: str, php: str) -> str:
    """The hash the bridge's ``password_verify()`` accepts, made by PHP itself."""
    try:
        result = subprocess.run(
            [php, "-d", "display_errors=stderr", "-r", _PHP_HASH],
            input=password.encode("utf-8"),
            capture_output=True,
            timeout=60,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise AccountError(f"Nie udało się uruchomić PHP ({php}): {exc}") from exc
    lines = result.stdout.decode("ascii", errors="replace").strip().splitlines()
    hashed = lines[-1].strip() if lines else ""
    if result.returncode != 0 or _HASH_SHAPE.fullmatch(hashed) is None:
        detail = result.stderr.decode("utf-8", errors="replace").strip()[-400:]
        raise AccountError(f"PHP nie wydało skrótu hasła (kod {result.returncode}). {detail}".strip())
    return hashed


def create_account(
    database: DatabaseConfig,
    *,
    username: str,
    email: str | None,
    password_hash: str,
    role: str,
) -> int:
    """Insert one active, confirmed account into the system user group.

    Confirmed, because the operator typing the command vouches for it, and an
    account waiting for an activation e-mail is exactly the dead end this command
    exists to avoid. The group is the system ``user`` group, like every
    self-registered account: the role opens the panel, the group decides what the
    account may reach, and both can be changed there afterwards.
    """
    validate_username(username)
    if role not in ROLES:
        raise AccountError("Nieznana rola.")
    try:
        with _connect(database) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT COUNT(*) FROM information_schema.tables"
                    " WHERE table_schema = DATABASE() AND table_name IN ('users', 'permission_groups', 'audit_log')"
                )
                if int(cursor.fetchone()[0]) != 3:
                    raise AccountError("Baza nie ma jeszcze tabel kont — najpierw media-server migrate.")
                cursor.execute(
                    "SELECT 1 FROM users WHERE username = %s OR (%s IS NOT NULL AND email = %s) LIMIT 1",
                    (username, email, email),
                )
                if cursor.fetchone() is not None:
                    raise AccountError("Konto o tej nazwie albo z tym adresem e-mail już istnieje.")
                cursor.execute("SELECT id FROM permission_groups WHERE slug = 'user' AND is_system = 1 LIMIT 1")
                group = cursor.fetchone()
                group_id = int(group[0]) if group is not None else None
                connection.begin()
                try:
                    cursor.execute(
                        "INSERT INTO users (username, email, password_hash, role, is_guest, is_active,"
                        " permission_group_id, email_verified_at)"
                        " VALUES (%s, %s, %s, %s, 0, 1, %s, CURRENT_TIMESTAMP(6))",
                        (username, email, password_hash, role, group_id),
                    )
                    user_id = int(cursor.lastrowid)
                    # The same trail the panel leaves when an administrator creates
                    # an account, with nobody as the actor: nobody was signed in.
                    cursor.execute(
                        "INSERT INTO audit_log (actor_user_id, action, target_type, target_id, details_json)"
                        " VALUES (NULL, 'user.create', 'user', %s, %s)",
                        (
                            str(user_id),
                            json.dumps(
                                {"username": username, "role": role, "permission_group_id": group_id, "via": "cli"},
                                ensure_ascii=False,
                            ),
                        ),
                    )
                    connection.commit()
                except BaseException:
                    connection.rollback()
                    raise
    except pymysql.err.IntegrityError as exc:
        raise AccountError("Konto o tej nazwie albo z tym adresem e-mail już istnieje.") from exc
    except pymysql.MySQLError as exc:
        raise AccountError(f"Nie udało się zapisać konta: {exc}") from exc
    return user_id
