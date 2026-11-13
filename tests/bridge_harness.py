"""MySQL-backed harness for the PHP bridge (``tests/test_bridge_*.py``).

The bridge classes speak MySQL — ``ON DUPLICATE KEY``, ``JSON_EXTRACT``, ``FOR UPDATE``,
generated columns — so SQLite cannot stand in for it, and the classes that carry the
authorisation rules (CatalogActions, LibraryBrowser, GuestLinks, ...) had no test at all.
This harness gives them a database of their own:

* ``media_server_test`` on the local MySQL (or whatever ``MEDIA_SERVER_TEST_DB_*`` names),
  **never** the installation's database: a name that does not end with ``_test`` is refused;
* rebuilt from ``migrations/`` once per session and emptied before every test;
* a tiny library of real (empty) files catalogued by the real scanner;
* the classes run in a PHP process, and the bridge itself behind PHP's built-in server.

Everything skips cleanly when PHP, MySQL or that database is not there, so the gate on
a machine without MySQL (CI, a fresh Debian) passes without them. Create the database once::

    CREATE DATABASE media_server_test CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
"""
from __future__ import annotations

import base64
import http.cookiejar
import json
import os
import re
import secrets
import shutil
import socket
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Iterable

import pymysql
import pytest

from media_server.catalog import scan_catalog
from media_server.config import DatabaseConfig
from media_server.database import apply_migrations

PROJECT_ROOT = Path(__file__).resolve().parents[1]
PHP_INTEGRATION = PROJECT_ROOT / "integrations" / "php"
MIGRATIONS = PROJECT_ROOT / "migrations"

# Filled by migrations and never touched by a test.
_KEPT_TABLES = frozenset({"schema_migrations", "media_genres"})
# Filled by migrations and changed by tests: emptied and refilled from a snapshot.
_RESTORED_TABLES = ("permission_groups", "app_settings")
_SESSION_LOCK = "tryhackx_media_test_session"

# The password every test account shares; hashed once per session by PHP itself.
TEST_PASSWORD = "correct horse battery staple"


def database_config() -> DatabaseConfig:
    name = os.environ.get("MEDIA_SERVER_TEST_DB_NAME", "media_server_test")
    if re.fullmatch(r"[A-Za-z0-9_]+_test", name) is None:
        pytest.skip("MEDIA_SERVER_TEST_DB_NAME musi kończyć się na _test — testy nie dotykają żadnej innej bazy")
    return DatabaseConfig(
        host=os.environ.get("MEDIA_SERVER_TEST_DB_HOST", "127.0.0.1"),
        port=int(os.environ.get("MEDIA_SERVER_TEST_DB_PORT", "3306")),
        name=name,
        user=os.environ.get("MEDIA_SERVER_TEST_DB_USER", "root"),
        password=os.environ.get("MEDIA_SERVER_TEST_DB_PASSWORD", ""),
    )


def php_binary() -> str:
    php = shutil.which("php")
    if php is None:
        pytest.skip("PHP nie jest dostępne w PATH")
    return php


class BridgeDatabase:
    """The test database: rebuilt once, emptied per test, with a few inserts worth naming."""

    def __init__(self, config: DatabaseConfig) -> None:
        self.config = config
        try:
            self.connection = pymysql.connect(
                host=config.host, port=config.port, user=config.user, password=config.password,
                database=config.name, charset="utf8mb4", autocommit=True,
                connect_timeout=3, read_timeout=60, write_timeout=60,
                cursorclass=pymysql.cursors.DictCursor,
            )
        except pymysql.MySQLError as error:
            pytest.skip(f"baza testowa {config.name} jest niedostępna ({error.args[0]}) — patrz docs/TESTING.md")
        self._snapshot: dict[str, list[dict[str, Any]]] = {}
        self._tables: list[str] = []
        self.password_hash = ""
        # The account PHP connects with: data only, like the application's own
        # (migrations run as an administrator, the bridge never does).
        self.app_user = ""
        self.app_password = ""

    # -- session set-up ---------------------------------------------------

    def rebuild(self) -> None:
        """Drop every table and run the migrations: the schema under test is the one in the tree."""
        if self.value("SELECT GET_LOCK(%s, 0)", (_SESSION_LOCK,)) != 1:
            pytest.skip("baza testowa jest zajęta przez inny przebieg testów")
        with self.connection.cursor() as cursor:
            cursor.execute("SET FOREIGN_KEY_CHECKS = 0")
            cursor.execute("SHOW FULL TABLES WHERE Table_type = 'BASE TABLE'")
            for row in cursor.fetchall():
                cursor.execute(f"DROP TABLE `{next(iter(row.values()))}`")
            cursor.execute("SET FOREIGN_KEY_CHECKS = 1")
        apply_migrations(self.config, MIGRATIONS)
        with self.connection.cursor() as cursor:
            cursor.execute("SHOW FULL TABLES WHERE Table_type = 'BASE TABLE'")
            self._tables = [str(next(iter(row.values()))) for row in cursor.fetchall()]
        for table in _RESTORED_TABLES:
            self._snapshot[table] = self.rows(f"SELECT * FROM `{table}`")
        self._prepare_app_account()
        php = php_binary()
        hashed = subprocess.run(
            [php, "-r", "echo password_hash(stream_get_contents(STDIN), PASSWORD_DEFAULT);"],
            input=TEST_PASSWORD, capture_output=True, text=True, check=True, timeout=30,
        )
        self.password_hash = hashed.stdout.strip()

    def _prepare_app_account(self) -> None:
        """The bridge refuses an empty database password, and should not test as an administrator.

        Either the environment names an account that already exists
        (``MEDIA_SERVER_TEST_DB_APP_USER`` / ``_APP_PASSWORD``), or one is kept for
        this database alone: ``media_server_test``@``localhost``, data rights on the
        test database only, with a fresh random password every session.
        """
        named = os.environ.get("MEDIA_SERVER_TEST_DB_APP_USER", "")
        if named:
            self.app_user = named
            self.app_password = os.environ.get("MEDIA_SERVER_TEST_DB_APP_PASSWORD", "")
            return
        user = "media_server_test"
        password = secrets.token_urlsafe(24)
        try:
            with self.connection.cursor() as cursor:
                cursor.execute(f"CREATE USER IF NOT EXISTS '{user}'@'localhost' IDENTIFIED BY %s", (password,))
                cursor.execute(f"ALTER USER '{user}'@'localhost' IDENTIFIED BY %s", (password,))
                cursor.execute(
                    f"GRANT SELECT, INSERT, UPDATE, DELETE ON `{self.config.name}`.* TO '{user}'@'localhost'"
                )
        except pymysql.MySQLError as error:
            pytest.skip(f"nie można przygotować konta bazy testowej ({error.args[0]}) — patrz docs/TESTING.md")
        self.app_user = user
        self.app_password = password

    def reset(self) -> None:
        """Back to what the migrations left: no accounts, no library, the seeded settings and groups."""
        with self.connection.cursor() as cursor:
            cursor.execute("SET FOREIGN_KEY_CHECKS = 0")
            for table in self._tables:
                if table not in _KEPT_TABLES:
                    cursor.execute(f"DELETE FROM `{table}`")
            for table, rows in self._snapshot.items():
                for row in rows:
                    columns = ", ".join(f"`{name}`" for name in row)
                    marks = ", ".join(["%s"] * len(row))
                    cursor.execute(f"INSERT INTO `{table}` ({columns}) VALUES ({marks})", list(row.values()))
            cursor.execute("SET FOREIGN_KEY_CHECKS = 1")

    def close(self) -> None:
        try:
            self.connection.close()
        except pymysql.MySQLError:
            pass

    # -- plain SQL --------------------------------------------------------

    def execute(self, sql: str, params: Iterable[Any] = ()) -> int:
        with self.connection.cursor() as cursor:
            cursor.execute(sql, tuple(params))
            return int(cursor.lastrowid or 0)

    def rows(self, sql: str, params: Iterable[Any] = ()) -> list[dict[str, Any]]:
        with self.connection.cursor() as cursor:
            cursor.execute(sql, tuple(params))
            return list(cursor.fetchall())

    def row(self, sql: str, params: Iterable[Any] = ()) -> dict[str, Any] | None:
        found = self.rows(sql, params)
        return found[0] if found else None

    def value(self, sql: str, params: Iterable[Any] = ()) -> Any:
        found = self.row(sql, params)
        return None if found is None else next(iter(found.values()))

    def insert(self, table: str, **columns: Any) -> int:
        names = ", ".join(f"`{name}`" for name in columns)
        marks = ", ".join(["%s"] * len(columns))
        return self.execute(f"INSERT INTO `{table}` ({names}) VALUES ({marks})", columns.values())

    # -- things tests keep needing ----------------------------------------

    def setting(self, key: str, value: str | None) -> None:
        if value is None:
            self.execute("DELETE FROM app_settings WHERE setting_key = %s", (key,))
            return
        self.execute(
            "INSERT INTO app_settings (setting_key, setting_value) VALUES (%s, %s)"
            " ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)",
            (key, value),
        )

    def group_id(self, slug: str) -> int:
        return int(self.value("SELECT id FROM permission_groups WHERE slug = %s", (slug,)))

    def group(self, slug: str, **flags: Any) -> int:
        """A permission group of the test's own; every right off unless named."""
        columns = {
            "can_download_file": 0, "can_download_selection": 0, "can_download_folder": 0,
            "can_download_library": 0, "can_rate": 0, "can_favorite": 0, "can_create_collections": 0,
            "can_browse_collections": 0, "can_browse_profiles": 0, "can_share": 0,
            "can_access_music": 0, "can_access_movies": 0, "can_stream_compat": 0, "can_edit_metadata": 0,
        }
        columns.update(flags)
        return self.insert("permission_groups", slug=slug, name=slug, **columns)

    def user(
        self,
        username: str,
        *,
        role: str = "user",
        guest: bool = False,
        group: int | str | None = "user",
        active: bool = True,
        email: str | None = None,
        verified: bool = True,
    ) -> int:
        group_id = self.group_id("guest" if guest and group == "user" else group) if isinstance(group, str) else group
        user_id = self.insert(
            "users", username=username, email=email or f"{username}@example.test",
            password_hash=self.password_hash, role=role, is_guest=int(guest), is_active=int(active),
            permission_group_id=group_id,
        )
        if verified:
            self.execute("UPDATE users SET email_verified_at = CURRENT_TIMESTAMP(6) WHERE id = %s", (user_id,))
        return user_id

    def item_id(self, relative_path: str, root: str | None = None) -> int:
        # Byte for byte: the column's collation would take "Café" for "Cafe".
        sql = (
            "SELECT mi.id FROM media_items mi INNER JOIN media_roots mr ON mr.id = mi.root_id"
            " WHERE mi.relative_path = %s COLLATE utf8mb4_bin"
        )
        params: list[Any] = [relative_path]
        if root is not None:
            sql += " AND mr.slug = %s"
            params.append(root)
        found = self.value(sql, params)
        assert found is not None, f"no catalogued file {relative_path!r}"
        return int(found)

    def directory_id(self, relative_path: str, root: str) -> int:
        found = self.value(
            "SELECT md.id FROM media_directories md INNER JOIN media_roots mr ON mr.id = md.root_id"
            " WHERE md.relative_path = %s COLLATE utf8mb4_bin AND mr.slug = %s",
            (relative_path, root),
        )
        assert found is not None, f"no catalogued folder {relative_path!r}"
        return int(found)

    def tag(self, relative_path: str, **columns: Any) -> int:
        """Set catalogue columns of one file (title, artist, album, duration_ms, ...)."""
        item_id = self.item_id(relative_path)
        assignments = ", ".join(f"`{name}` = %s" for name in columns)
        self.execute(f"UPDATE media_items SET {assignments} WHERE id = %s", [*columns.values(), item_id])
        return item_id


class Library:
    """Real folders of empty files, catalogued by the real scanner."""

    def __init__(self, database: BridgeDatabase, base: Path) -> None:
        self.database = database
        self.base = base

    def root_path(self, slug: str) -> Path:
        return self.base / slug

    def scan(self, slug: str, kind: str, files: Iterable[str] = (), *, allow_mass_missing: bool = True) -> dict[str, Any]:
        """Create ``files`` under the root (paths with ``/``) and scan it."""
        root = self.root_path(slug)
        root.mkdir(parents=True, exist_ok=True)
        for relative in files:
            target = root.joinpath(*relative.split("/"))
            target.parent.mkdir(parents=True, exist_ok=True)
            if not target.exists():
                # A few distinct bytes: the scanner fingerprints content, and
                # every empty file would be "the same file".
                target.write_bytes(f"{slug}:{relative}".encode("utf-8"))
        return scan_catalog(
            database=self.database.config, root_slug=slug, root_path=root, root_kind=kind,
            apply=True, allow_mass_missing=allow_mass_missing,
        )


class PhpRunner:
    """Runs a snippet against the bridge classes with a PDO connection to the test database."""

    PRELUDE = r"""<?php
declare(strict_types=1);
foreach (['BridgeException.php', 'LegacyIdentity.php', 'LegacySessionBridge.php', 'TransferToken.php',
          'TrustedProxy.php', 'CatalogTransferGateway.php', 'LibraryBrowser.php', 'CatalogActions.php',
          'BridgeConfigLoader.php', 'Mailer.php', 'AccountGateway.php', 'ProofOfWork.php', 'CaptchaGuard.php',
          'StepUpGuard.php', 'Totp.php', 'TwoFactor.php', 'PermissionGroups.php', 'GuestLinks.php',
          'LibraryDigest.php', 'PlaylistParser.php', 'PlaylistImporter.php'] as $file) {
    require_once __INTEGRATION__ . '/' . $file;
}
foreach (glob(__INTEGRATION__ . '/*.php') ?: [] as $file) {
    require_once $file;
}
use TryHackX\Media\Integration\{AccountGateway, BridgeAuthenticationException, BridgeAuthorizationException,
    BridgeCaptchaRequiredException, BridgeException, BridgeRateLimitException, BridgeRequestException, BridgeTime,
    CaptchaGuard, CatalogActions, CatalogItemNotFoundException, CatalogTransferGateway, GuestLinks, HomeShelves,
    LegacyIdentity, LegacySessionBridge, LibraryBrowser, LibraryDigest, Mailer, PermissionGroups,
    PlaylistImporter, PlaylistParser, ProofOfWork, StepUpGuard, TransferToken, TrustedProxy, TwoFactor};
$db = new PDO(getenv('MEDIA_TEST_DSN'), getenv('MEDIA_TEST_DB_USER'), (string) getenv('MEDIA_TEST_DB_PASSWORD'), [
    PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
    PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
    PDO::ATTR_EMULATE_PREPARES => false,
]);
$transferKey = (string) getenv('MEDIA_TEST_TRANSFER_KEY');
$spool = (string) getenv('MEDIA_TEST_SPOOL');
$mailer = new Mailer(['spool_path' => $spool]);
function identity(PDO $db, string $username): LegacyIdentity {
    $statement = $db->prepare('SELECT id, username, role, is_guest FROM users WHERE username = :name');
    $statement->execute(['name' => $username]);
    return LegacyIdentity::fromDatabaseRow($statement->fetch());
}
/** What a call did, as data: its value, or the class and message of what it refused with. */
function attempt(callable $call): array {
    try {
        return ['ok' => true, 'value' => $call()];
    } catch (BridgeException $error) {
        return ['ok' => false, 'error' => (new ReflectionClass($error))->getShortName(), 'message' => $error->getMessage()]
            + ($error instanceof BridgeRateLimitException ? ['retry_after' => $error->retryAfter] : []);
    }
}
function out(mixed $value): void {
    echo json_encode($value, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
}
"""

    def __init__(self, database: BridgeDatabase, work: Path, transfer_key: bytes) -> None:
        self.php = php_binary()
        self.work = work
        self.spool = work / "mail"
        self.spool.mkdir(parents=True, exist_ok=True)
        # What the classes say through error_log() — a mail that could not be sent, a
        # digest that failed — is kept with the run. Left to php.ini it went to the
        # installation's own PHP log (on WAMP: logs/php_error.log), where a test's
        # deliberate failure reads like the live bridge's; with no error_log set at
        # all it goes to stderr, which fails the test.
        self.error_log = work / "php-cli-error.log"
        self.transfer_key = transfer_key
        self.encoded_key = base64.urlsafe_b64encode(transfer_key).rstrip(b"=").decode("ascii")
        config = database.config
        self.environment = os.environ.copy()
        self.environment.update({
            "MEDIA_TEST_DSN": f"mysql:host={config.host};port={config.port};dbname={config.name};charset=utf8mb4",
            "MEDIA_TEST_DB_USER": database.app_user,
            "MEDIA_TEST_DB_PASSWORD": database.app_password,
            "MEDIA_TEST_TRANSFER_KEY": self.encoded_key,
            "MEDIA_TEST_SPOOL": str(self.spool),
        })
        self._counter = 0

    def run(self, body: str, timeout: float = 60) -> Any:
        self._counter += 1
        script = self.work / f"case-{self._counter}.php"
        script.write_text(
            self.PRELUDE.replace("__INTEGRATION__", json.dumps(str(PHP_INTEGRATION))) + body,
            encoding="utf-8",
        )
        # Warnings and notices go to stderr, and anything on stderr fails the
        # test: a snippet's answer is its JSON and nothing else.
        result = subprocess.run(
            [self.php, "-d", "display_errors=stderr", "-d", "log_errors=1", "-d", f"error_log={self.error_log}",
             str(script)],
            capture_output=True, text=True, encoding="utf-8", env=self.environment, timeout=timeout,
        )
        if result.returncode != 0 or result.stderr.strip():
            raise AssertionError(f"PHP failed ({result.returncode}):\n{result.stdout[-2000:]}\n{result.stderr[-4000:]}")
        return json.loads(result.stdout)

    def mail(self) -> list[str]:
        """Messages spooled so far, oldest first (the Mailer writes ``.eml`` files without a mail host)."""
        return [path.read_text(encoding="utf-8") for path in sorted(self.spool.glob("*.eml"))]

    def clear_mail(self) -> None:
        for path in self.spool.glob("*.eml"):
            path.unlink()


class BridgeServer:
    """``stage/bridge.php`` behind PHP's built-in server, against the test database."""

    def __init__(self, runner: PhpRunner, database: BridgeDatabase, work: Path) -> None:
        self.work = work
        sessions = work / "sessions"
        sessions.mkdir(parents=True, exist_ok=True)
        config = database.config
        config_file = work / "bridge-config.php"
        config_file.write_text(
            "<?php\nreturn " + _php_array({
                "database": {
                    "dsn": f"mysql:host={config.host};port={config.port};dbname={config.name};charset=utf8mb4",
                    "user": database.app_user,
                    "password": database.app_password,
                },
                "transfer": {
                    "key": runner.encoded_key,
                    "base_url": "/media-transfer",
                    # Nothing listens there: the jobs these tests ask for must fail closed.
                    "internal_url": "http://127.0.0.1:9",
                },
                "session": {"name": "TRYHACKXTESTSESSID", "require_https": True},
                "mail": {"spool_path": str(runner.spool)},
                "app": {"base_url": "http://media.test/"},
            }) + ";\n",
            encoding="utf-8",
        )
        router = work / "router.php"
        router.write_text(
            "<?php\n"
            "if (parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH) === '/media-next-api') {\n"
            f"    require {json.dumps(str(PHP_INTEGRATION / 'stage' / 'bridge.php'))};\n"
            "    return true;\n"
            "}\n"
            "http_response_code(404);\n",
            encoding="utf-8",
        )
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            self.port = probe.getsockname()[1]
        environment = os.environ.copy()
        environment["TRYHACKX_BRIDGE_CONFIG"] = str(config_file)
        environment["TRYHACKX_BRIDGE_ALLOW_HTTP_LOCAL"] = "1"
        self.error_log = work / "php-error.log"
        self.process = subprocess.Popen(
            [runner.php, "-d", f"session.save_path={sessions}", "-d", "log_errors=1",
             "-d", f"error_log={self.error_log}", "-d", "display_errors=0",
             "-S", f"127.0.0.1:{self.port}", str(router)],
            env=environment, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, cwd=str(work),
        )
        self.base = f"http://127.0.0.1:{self.port}/media-next-api"
        deadline = time.monotonic() + 15
        while True:
            try:
                with socket.create_connection(("127.0.0.1", self.port), timeout=0.5):
                    break
            except OSError:
                if self.process.poll() is not None or time.monotonic() > deadline:
                    self.stop()
                    pytest.skip("wbudowany serwer PHP nie wystartował")
                time.sleep(0.05)

    def stop(self) -> None:
        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=10)

    def client(self) -> "BridgeClient":
        return BridgeClient(self.base)

    def errors(self) -> str:
        return self.error_log.read_text(encoding="utf-8", errors="replace") if self.error_log.exists() else ""


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args: Any, **kwargs: Any) -> None:
        return None


class Response:
    def __init__(self, status: int, headers: Any, body: bytes) -> None:
        self.status = status
        self.headers = headers
        self.body = body
        try:
            self.json: Any = json.loads(body) if body else None
        except ValueError:
            self.json = None

    def header_values(self, name: str) -> list[str]:
        return [value for key, value in self.headers.items() if key.lower() == name.lower()]


class BridgeClient:
    """One browser: a cookie jar and the CSRF token the bridge handed out."""

    def __init__(self, base: str) -> None:
        self.base = base
        self.jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar), _NoRedirect())
        self.csrf = ""

    def request(self, method: str, action: str, payload: Any = None, headers: dict[str, str] | None = None,
                **query: Any) -> Response:
        parts = [f"action={urllib.request.quote(action)}"]
        parts += [f"{urllib.request.quote(str(key))}={urllib.request.quote(str(value))}" for key, value in query.items()]
        sent = {"Accept": "application/json", **(headers or {})}
        data = None
        if payload is not None:
            data = json.dumps(payload).encode("utf-8")
            sent.setdefault("Content-Type", "application/json")
            sent.setdefault("X-CSRF-Token", self.csrf)
        request = urllib.request.Request(f"{self.base}?{'&'.join(parts)}", data=data, headers=sent, method=method)
        try:
            with self.opener.open(request, timeout=30) as answer:
                response = Response(answer.status, answer.headers, answer.read())
        except urllib.error.HTTPError as error:
            response = Response(error.code, error.headers, error.read())
        if isinstance(response.json, dict) and isinstance(response.json.get("csrf_token"), str):
            self.csrf = response.json["csrf_token"]
        return response

    def get(self, action: str, **query: Any) -> Response:
        return self.request("GET", action, None, None, **query)

    def post(self, action: str, payload: Any = None, **query: Any) -> Response:
        return self.request("POST", action, {} if payload is None else payload, None, **query)

    def sign_in(self, username: str, password: str = TEST_PASSWORD) -> Response:
        self.get("auth_state")
        return self.post("login", {"username": username, "password": password})

    def cookie(self, name: str) -> str | None:
        for cookie in self.jar:
            if cookie.name == name:
                return cookie.value
        return None


def _php_array(value: Any, indent: int = 0) -> str:
    pad = "    " * (indent + 1)
    if isinstance(value, dict):
        rows = [f"{pad}{_php_string(key)} => {_php_array(item, indent + 1)}," for key, item in value.items()]
        return "[\n" + "\n".join(rows) + "\n" + "    " * indent + "]"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    return _php_string(str(value))


def _php_string(value: str) -> str:
    return "'" + value.replace("\\", "\\\\").replace("'", "\\'") + "'"


def new_transfer_key() -> bytes:
    return secrets.token_bytes(32)
