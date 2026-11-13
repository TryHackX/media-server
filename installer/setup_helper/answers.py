"""The answers of the Debian installer: read from a file or typed into the wizard, checked in one place.

``zainstaluj-debian.sh`` can be driven by a person (whiptail or plain prompts) or
by a file (``--answers``). Either way the answers end up here as one nested
structure, and this module is the only place that says what a valid one is — the
interactive pages call the same check after every screen, so a file cannot
describe an installation the wizard would refuse, and the other way round.

A file is TOML (``*.toml``, the form the examples use, because it can carry
comments) or JSON (``*.json``, the same keys — the form the Windows wizard's
answer files use).

Three rules a file has to live with:

* **no passwords in it.** The administrator's password comes from
  ``admin.password_file`` (a file only root can read) or from the environment
  variable ``TRYHACKX_ADMIN_PASSWORD``; a literal ``password`` key is refused;
* **unknown keys are errors**, not noise — a typo in ``vps_adresses`` must not
  turn a private installation into a half-configured one;
* **every problem is reported**, not only the first.

Problems are data — ``{"code", "args"}`` — and are worded by the installer in the
user's language (``installer/debian/lang/*.sh``, keys ``problem.<code>``).

Standard library only.
"""
from __future__ import annotations

import ipaddress
import json
import posixpath
import re
import tomllib
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

from . import naming
from .apacheconf import MODES, ApacheConfError, normalise_addresses, normalise_host_name
from .vpsbundle import BundleError, home_target

FLOWS = ("install", "folders", "access", "admin", "update", "migrate", "vps", "rotate", "uninstall")
CERTIFICATES = ("letsencrypt", "selfsigned", "files")
VPS_RUN = ("manual", "ssh")
LANGUAGES = ("pl", "en")
ROLES = ("super_admin", "admin", "user")

# How people write the four shapes. The canonical names are the ones the shared
# Apache generator uses (``apacheconf.MODES``), so both installers mean the same.
MODE_ALIASES: dict[str, str] = {
    "direct": "direct", "s": "direct", "standalone": "direct", "public": "direct",
    "samodzielny": "direct", "publiczny": "direct",
    "vps": "vps", "p": "vps", "private": "vps", "prywatny": "vps",
    "lan": "lan", "d": "lan", "home": "lan", "dom": "lan",
    "local": "local", "c": "local", "localhost": "local",
}

_DB_NAME = re.compile(r"[A-Za-z0-9_]{1,64}")
# Four characters are kept for the suffix of the migration account (see debian.migrate_user).
_DB_USER = re.compile(r"[A-Za-z0-9_]{1,28}")
_USERNAME = re.compile(r"[A-Za-z0-9._-]{3,32}")
_EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+")
_PORT_RULE = re.compile(r"([0-9]{1,5})/(tcp|udp)")
_SSH_USER = re.compile(r"[a-z_][a-z0-9_-]{0,31}")
_SSH_FINGERPRINT = re.compile(r"SHA256:[A-Za-z0-9+/]{43}")
_TRUE = {"1", "true", "yes", "y", "tak", "t", "on"}
_FALSE = {"0", "false", "no", "n", "nie", "off", ""}

Problem = dict[str, Any]


def problem(code: str, *args: object) -> Problem:
    return {"code": code, "args": [str(arg) for arg in args]}


class AnswersError(ValueError):
    """The answers file cannot be read at all (missing, not TOML/JSON)."""


def load(path: str | Path) -> dict[str, Any]:
    """The raw content of an answers file. Shape and values are checked by ``normalise``."""
    file = Path(path)
    try:
        raw = file.read_bytes()
    except OSError as exc:
        raise AnswersError(f"Nie można odczytać pliku odpowiedzi: {exc}") from exc
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise AnswersError("Plik odpowiedzi musi być zapisany w UTF-8") from exc
    try:
        data = json.loads(text) if file.suffix.lower() == ".json" else tomllib.loads(text)
    except (json.JSONDecodeError, tomllib.TOMLDecodeError) as exc:
        kind = "JSON" if file.suffix.lower() == ".json" else "TOML"
        raise AnswersError(f"Plik odpowiedzi nie jest poprawnym {kind}: {exc}") from exc
    if not isinstance(data, dict):
        raise AnswersError("Plik odpowiedzi musi być obiektem (tabelą)")
    return data


# -- small converters: every value may arrive as text (from the shell) or typed (from a file) ----


class _Reader:
    """Reads fields out of one table, remembering which keys were asked for and what went wrong."""

    def __init__(self, table: object, path: str, problems: list[Problem]) -> None:
        self.path = path
        self.problems = problems
        self.seen: set[str] = set()
        if table is None:
            table = {}
        if not isinstance(table, Mapping):
            problems.append(problem("answers.type", path, "table"))
            table = {}
        self.table: Mapping[str, Any] = table

    def _name(self, key: str) -> str:
        return f"{self.path}.{key}" if self.path else key

    def raw(self, key: str) -> Any:
        self.seen.add(key)
        return self.table.get(key)

    def text(self, key: str, default: str = "") -> str:
        value = self.raw(key)
        if value is None:
            return default
        if isinstance(value, bool) or not isinstance(value, (str, int)):
            self.problems.append(problem("answers.type", self._name(key), "text"))
            return default
        text = str(value).strip()
        if any(ord(ch) < 0x20 or ord(ch) == 0x7F for ch in text):
            self.problems.append(problem("answers.type", self._name(key), "text"))
            return default
        return text

    def flag(self, key: str, default: bool) -> bool:
        value = self.raw(key)
        if value is None:
            return default
        if isinstance(value, bool):
            return value
        if isinstance(value, int) and value in (0, 1):
            return bool(value)
        if isinstance(value, str):
            lowered = value.strip().lower()
            if lowered in _TRUE:
                return True
            if lowered in _FALSE:
                return default if lowered == "" else False
        self.problems.append(problem("answers.type", self._name(key), "true/false"))
        return default

    def number(self, key: str, default: int, minimum: int, maximum: int) -> int:
        value = self.raw(key)
        if value is None or value == "":
            return default
        if isinstance(value, bool):
            value = None
        elif isinstance(value, str) and value.strip().isdigit():
            value = int(value.strip())
        if not isinstance(value, int) or not minimum <= value <= maximum:
            self.problems.append(problem("answers.number", self._name(key), minimum, maximum))
            return default
        return value

    def items(self, key: str) -> list[Any]:
        """A list; one line of comma- or space-separated text is accepted for lists of addresses."""
        value = self.raw(key)
        if value is None or value == "":
            return []
        if isinstance(value, str):
            return [part for part in re.split(r"[\s,;]+", value.strip()) if part]
        if isinstance(value, Sequence):
            return list(value)
        self.problems.append(problem("answers.type", self._name(key), "list"))
        return []

    def done(self) -> None:
        for key in sorted(set(self.table) - self.seen):
            self.problems.append(problem("answers.unknown_key", self._name(key)))


def check_folder_path(path: str, forbidden: Mapping[str, Sequence[str]]) -> tuple[str, list[Problem]]:
    """A media folder as a clean absolute path, and why it cannot be used (``forbidden`` maps a reason to prefixes)."""
    text = path.strip()
    if not text.startswith("/"):
        return text, [problem("folder.relative", text or "?")]
    if any(ch in text for ch in '"\\') or any(ord(ch) < 0x20 for ch in text):
        return text, [problem("folder.characters", text)]
    clean = posixpath.normpath(text)
    if clean.startswith("//"):
        clean = clean[1:]
    for reason, prefixes in forbidden.items():
        for prefix in prefixes:
            if clean == prefix or (prefix != "/" and clean.startswith(prefix.rstrip("/") + "/")):
                return clean, [problem(f"folder.{reason}", clean, prefix)]
    if clean == "/":
        return clean, [problem("folder.system", clean, "/")]
    return clean, []


def nesting_problems(paths: Sequence[str]) -> list[Problem]:
    """Two folders that are the same, or one inside the other: the catalogue would hold every file twice."""
    problems: list[Problem] = []
    for index, path in enumerate(paths):
        for other in paths[:index]:
            if path == other:
                problems.append(problem("folder.duplicate", path))
            elif path.startswith(other.rstrip("/") + "/") or other.startswith(path.rstrip("/") + "/"):
                problems.append(problem("folder.nested", path, other))
    return problems


def _addresses(values: Sequence[Any], code: str, problems: list[Problem]) -> list[str]:
    result: list[str] = []
    for value in values:
        try:
            result.extend(normalise_addresses([str(value)]))
        except ApacheConfError:
            problems.append(problem(code, value))
    return list(dict.fromkeys(result))


def _subnets(values: Sequence[Any], problems: list[Problem]) -> list[str]:
    result: list[str] = []
    for value in values:
        try:
            network = ipaddress.ip_network(str(value).strip(), strict=False)
        except ValueError:
            problems.append(problem("answers.subnet", value))
            continue
        if network.prefixlen == 0:
            # 0.0.0.0/0 as "the home network" would open everything to everybody.
            problems.append(problem("answers.subnet", value))
            continue
        result.append(str(network))
    return list(dict.fromkeys(result))


def normalise(
    raw: Mapping[str, Any],
    *,
    forbidden_folders: Mapping[str, Sequence[str]] | None = None,
    interactive: bool = False,
    password_in_environment: bool = False,
) -> tuple[dict[str, Any], list[Problem]]:
    """The answers with every field present and typed, and everything that is wrong with them.

    ``interactive`` relaxes exactly two things a person settles on the spot: where
    the administrator's password comes from (they type it), and the acceptance of
    the Let's Encrypt terms (they are asked).
    """
    problems: list[Problem] = []
    top = _Reader(raw, "", problems)

    flow = top.text("flow", "install").lower()
    if flow not in FLOWS:
        problems.append(problem("answers.flow", flow))
        flow = "install"
    language = top.text("language", "pl").lower()
    if language not in LANGUAGES:
        problems.append(problem("answers.language", language))
        language = "pl"

    # ---- access -----------------------------------------------------------------------------
    access_reader = _Reader(top.raw("access"), "access", problems)
    mode_text = access_reader.text("mode", "local").lower()
    mode = MODE_ALIASES.get(mode_text)
    if mode is None or mode not in MODES:
        problems.append(problem("answers.mode", mode_text))
        mode = "local"
    host_name = access_reader.text("host_name")
    certificate = access_reader.text("certificate", "letsencrypt").lower()
    certificate_file = access_reader.text("certificate_file")
    key_file = access_reader.text("key_file")
    acme_email = access_reader.text("acme_email")
    acme_agree = access_reader.flag("acme_agree_tos", False)
    vps_addresses = _addresses(access_reader.items("vps_addresses"), "answers.vps_invalid", problems)
    home_address = access_reader.text("home_address")
    allow_lan = access_reader.flag("allow_lan", False)
    disable_existing_https = access_reader.flag("disable_existing_https", False)
    regenerate = access_reader.flag("regenerate_certificate", False)
    access_reader.done()

    needs_access = flow in {"install", "access"}
    if mode in {"direct", "vps"}:
        if not host_name:
            if needs_access:
                problems.append(problem("answers.host_required"))
        else:
            try:
                host_name = normalise_host_name(host_name)
            except ApacheConfError:
                problems.append(problem("answers.host_invalid", host_name))
    else:
        host_name = ""
    if mode == "direct":
        if certificate not in CERTIFICATES:
            problems.append(problem("answers.certificate", certificate))
            certificate = "letsencrypt"
        if certificate == "files":
            for value in (certificate_file, key_file):
                if not value.startswith("/") or any(ch in value for ch in '"\\${'):
                    problems.append(problem("answers.certificate_files"))
                    break
        else:
            certificate_file = key_file = ""
        if certificate == "letsencrypt" and needs_access and not interactive and not acme_agree:
            problems.append(problem("answers.acme_tos"))
    else:
        certificate, certificate_file, key_file = ("origin" if mode == "vps" else "none"), "", ""
    if acme_email and _EMAIL.fullmatch(acme_email) is None:
        problems.append(problem("answers.acme_email", acme_email))
        acme_email = ""
    if mode == "vps":
        if needs_access and not vps_addresses and not any(p["code"] == "answers.vps_invalid" for p in problems):
            problems.append(problem("answers.vps_required"))
        if not home_address:
            if needs_access:
                problems.append(problem("answers.home_required"))
        else:
            try:
                target, kind = home_target(home_address)
            except BundleError:
                problems.append(problem("answers.home_invalid", home_address))
            else:
                home_address = target.strip("[]")
                if kind != "name" and home_address in vps_addresses:
                    problems.append(problem("answers.home_is_vps"))
    else:
        vps_addresses, home_address, allow_lan = [], "", False

    # ---- database ---------------------------------------------------------------------------
    database_reader = _Reader(top.raw("database"), "database", problems)
    database_name = database_reader.text("name", "media_server")
    database_user = database_reader.text("user", "media_server")
    database_reader.done()
    if _DB_NAME.fullmatch(database_name) is None:
        problems.append(problem("answers.db_name", database_name))
        database_name = "media_server"
    if _DB_USER.fullmatch(database_user) is None:
        problems.append(problem("answers.db_user", database_user))
        database_user = "media_server"

    # ---- folders ----------------------------------------------------------------------------
    folders: list[dict[str, str]] = []
    raw_folders = top.raw("folders")
    if raw_folders is None or raw_folders == "":
        raw_folders = []
    if not isinstance(raw_folders, Sequence) or isinstance(raw_folders, str):
        problems.append(problem("answers.type", "folders", "list"))
        raw_folders = []
    for index, entry in enumerate(raw_folders):
        reader = _Reader(entry, f"folders.{index}", problems)
        path = reader.text("path")
        kind = reader.text("kind").lower()
        identifier = reader.text("id").lower()
        reader.done()
        clean, path_problems = check_folder_path(path, forbidden_folders or {})
        problems.extend(path_problems)
        if kind not in naming.KINDS:
            problems.append(problem("answers.folder_kind", clean, kind or "?"))
            kind = "mixed"
        if identifier and naming.ROOT_ID.fullmatch(identifier) is None:
            problems.append(problem("answers.folder_id", identifier))
            identifier = ""
        folders.append({"path": clean, "kind": kind, "id": identifier})
    problems.extend(nesting_problems([folder["path"] for folder in folders if folder["path"].startswith("/")]))
    identifiers = [folder["id"] for folder in folders if folder["id"]]
    for identifier in sorted({value for value in identifiers if identifiers.count(value) > 1}):
        problems.append(problem("answers.folder_id_twice", identifier))
    if flow in {"install", "folders"} and not folders:
        problems.append(problem("answers.folders_required"))

    # ---- administrator ----------------------------------------------------------------------
    admin_reader = _Reader(top.raw("admin"), "admin", problems)
    username = admin_reader.text("username")
    email = admin_reader.text("email")
    password_file = admin_reader.text("password_file")
    role = admin_reader.text("role", "super_admin").lower()
    if admin_reader.raw("password") is not None:
        # Asked for by name so that it is refused with a reason instead of as "unknown key".
        problems.append(problem("answers.admin_password_literal"))
    admin_reader.done()
    if flow in {"install", "admin"}:
        if _USERNAME.fullmatch(username) is None:
            problems.append(problem("answers.admin_username", username or "?"))
        if not interactive and not password_file and not password_in_environment:
            problems.append(problem("answers.admin_password_source"))
    if email and (_EMAIL.fullmatch(email) is None or len(email) > 254):
        problems.append(problem("answers.admin_email", email))
        email = ""
    if role not in ROLES:
        problems.append(problem("answers.admin_role", role))
        role = "super_admin"
    if password_file and not password_file.startswith("/"):
        problems.append(problem("answers.admin_password_file", password_file))

    # ---- firewall ---------------------------------------------------------------------------
    firewall_reader = _Reader(top.raw("firewall"), "firewall", problems)
    manage_firewall = firewall_reader.flag("manage", True)
    trust_lan = firewall_reader.flag("trust_lan", True)
    lan_subnets = _subnets(firewall_reader.items("lan_subnets"), problems)
    extra_ports: list[str] = []
    for value in firewall_reader.items("extra_ports"):
        match = _PORT_RULE.fullmatch(str(value).strip().lower())
        if match is None or not 1 <= int(match.group(1)) <= 65535:
            problems.append(problem("answers.extra_port", value))
        else:
            extra_ports.append(f"{int(match.group(1))}/{match.group(2)}")
    firewall_reader.done()

    # ---- options ----------------------------------------------------------------------------
    options_reader = _Reader(top.raw("options"), "options", problems)
    options = {
        "fail2ban": options_reader.flag("fail2ban", mode == "direct"),
        "start_scan": options_reader.flag("start_scan", True),
        "build_frontend": options_reader.flag("build_frontend", False),
        "allow_unsupported_os": options_reader.flag("allow_unsupported_os", False),
        "service_port": options_reader.number("service_port", 0, 1024, 65535),
    }
    options_reader.done()
    if mode != "direct":
        # Behind a proxy every visitor arrives from the proxy's address: a ban on this
        # machine would ban everybody at once. Without the internet there is nobody to ban.
        options["fail2ban"] = False

    # ---- the VPS ----------------------------------------------------------------------------
    vps_reader = _Reader(top.raw("vps"), "vps", problems)
    run = vps_reader.text("run", "manual").lower()
    ssh_host = vps_reader.text("ssh_host")
    ssh_user = vps_reader.text("ssh_user", "root")
    ssh_port = vps_reader.number("ssh_port", 22, 1, 65535)
    ssh_identity = vps_reader.text("ssh_identity_file")
    ssh_fingerprint = vps_reader.text("ssh_host_fingerprint")
    vps_reader.done()
    if ssh_fingerprint and _SSH_FINGERPRINT.fullmatch(ssh_fingerprint) is None:
        problems.append(problem("answers.ssh_fingerprint", ssh_fingerprint))
        ssh_fingerprint = ""
    if run not in VPS_RUN:
        problems.append(problem("answers.vps_run", run))
        run = "manual"
    if _SSH_USER.fullmatch(ssh_user) is None:
        problems.append(problem("answers.ssh_user", ssh_user))
        ssh_user = "root"
    if ssh_host:
        try:
            ssh_host = normalise_addresses([ssh_host])[0]
        except ApacheConfError:
            try:
                ssh_host = normalise_host_name(ssh_host)
            except ApacheConfError:
                problems.append(problem("answers.ssh_host", ssh_host))
                ssh_host = ""
    if ssh_identity and not ssh_identity.startswith("/"):
        problems.append(problem("answers.ssh_identity", ssh_identity))
        ssh_identity = ""
    if run == "ssh" and not interactive and not ssh_identity and mode == "vps" and flow in {"install", "access", "vps", "rotate"}:
        # Without a person there is nobody to type a password; a key is the only way in.
        problems.append(problem("answers.ssh_needs_key"))

    # ---- uninstall --------------------------------------------------------------------------
    uninstall_reader = _Reader(top.raw("uninstall"), "uninstall", problems)
    uninstall = {
        "drop_database": uninstall_reader.flag("drop_database", False),
        "confirm_database": uninstall_reader.text("confirm_database"),
        "remove_data": uninstall_reader.flag("remove_data", False),
        "remove_config": uninstall_reader.flag("remove_config", False),
        "disable_firewall": uninstall_reader.flag("disable_firewall", False),
    }
    uninstall_reader.done()

    top.done()
    answers = {
        "flow": flow,
        "language": language,
        "access": {
            "mode": mode,
            "host_name": host_name,
            "certificate": certificate,
            "certificate_file": certificate_file,
            "key_file": key_file,
            "acme_email": acme_email,
            "acme_agree_tos": acme_agree,
            "vps_addresses": vps_addresses,
            "home_address": home_address,
            "allow_lan": allow_lan,
            "disable_existing_https": disable_existing_https,
            "regenerate_certificate": regenerate,
        },
        "database": {"name": database_name, "user": database_user},
        "folders": folders,
        "admin": {"username": username, "email": email, "password_file": password_file, "role": role},
        "firewall": {
            "manage": manage_firewall,
            "trust_lan": trust_lan,
            "lan_subnets": lan_subnets,
            "extra_ports": extra_ports,
        },
        "options": options,
        "vps": {
            "run": run,
            "ssh_host": ssh_host,
            "ssh_user": ssh_user,
            "ssh_port": ssh_port,
            "ssh_identity_file": ssh_identity,
            "ssh_host_fingerprint": ssh_fingerprint,
        },
        "uninstall": uninstall,
    }
    return answers, problems
