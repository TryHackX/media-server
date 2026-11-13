"""Apache configuration for a WampServer installation: generated, edited and undone as text.

Three files are involved, and each is treated differently on purpose:

* **Our own file** in WAMP's ``alias`` directory. It is generated whole from
  ``deploy/apache/media-next-stage-wamp.conf.example`` — the one description of how
  the application is served that the project keeps current and tests — with the
  access rules, the service port and, for the two public shapes, an HTTPS virtual
  host filled in. Nothing is typed twice, so a route closed in the example is
  closed in every generated file.
* **``httpd-vhosts.conf``**. The application stands at ``/``, and that is the
  ``DocumentRoot`` of WAMP's own ``localhost`` host; an ``Alias "/"`` would bury
  every other alias on the server. One line is changed, the previous value is
  kept beside it, and ``restore_document_root`` puts it back.
* **``httpd.conf``**. Modules that ship switched off are switched on by removing
  the comment sign of their own ``LoadModule`` line. Nothing is added or reordered.

Every function here takes text and returns text. Reading, backing up, writing,
``httpd -t`` and the rollback are the wizard's job, which is also what makes a
dry run honest: it calls the same functions and writes nothing.

Standard library only.
"""
from __future__ import annotations

import ipaddress
import re
from collections.abc import Sequence
from dataclasses import dataclass

MANAGED_MARKER = "# TRYHACKX-MEDIA-SERVER-MANAGED"
DOCROOT_MARKER = "#TRYHACKX-PREVIOUS#"
VHOST_OFF_MARKER = "#TRYHACKX-OFF# "
# Written into WAMP's own file, whose encoding is whatever its last editor used:
# pure ASCII, so the edit can be made byte for byte without knowing it.
_DOCROOT_NOTES = (
    "# TryHackX Media Server: the application is served at the root address. The wizard",
    "# restores the previous value on uninstall (kept in the next line - do not remove it).",
)

# Private address space: what "the home network" means when no subnet is named.
PRIVATE_RANGES = ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16", "fc00::/7", "fe80::/10")

# The name the origin answers to when the request carries none. Deliberately not
# the public name: an HTTP/1.0 request without a Host header makes Apache build
# redirects from ServerName, and that must not tell a scanner which site lives here -
# nor which program: the product's name is the owner's brand too (audit P2-7).
ORIGIN_SERVER_NAME = "origin.invalid"

# Directives of the example file → modules that must be loaded for them to parse.
BASE_MODULES = ("alias_module", "authz_core_module", "authz_host_module", "dir_module", "env_module",
                "headers_module", "mime_module", "proxy_module", "proxy_http_module")
TLS_MODULES = ("ssl_module", "socache_shmcb_module")

MODES = ("local", "lan", "direct", "vps")


class ApacheConfError(ValueError):
    """The text could not be produced or changed safely; nothing should be written."""


def forward_slashes(path: str) -> str:
    return path.replace("\\", "/").rstrip("/")


def _quote_path(path: str) -> str:
    cleaned = forward_slashes(path)
    if '"' in cleaned or "\n" in cleaned or "\r" in cleaned or "${" in cleaned:
        raise ApacheConfError(f"Ścieżki nie da się zapisać w konfiguracji Apache: {path!r}")
    return cleaned


def normalise_addresses(addresses: Sequence[str]) -> list[str]:
    result: list[str] = []
    for raw in addresses:
        try:
            address = str(ipaddress.ip_address(raw.strip()))
        except ValueError as exc:
            raise ApacheConfError(f"„{raw}” nie jest adresem IP") from exc
        if address not in result:
            result.append(address)
    return result


def normalise_host_name(name: str) -> str:
    """A public host name as it may appear in ServerName and in a redirect target."""
    candidate = name.strip().rstrip(".").lower()
    try:
        candidate = candidate.encode("idna").decode("ascii")
    except UnicodeError as exc:
        raise ApacheConfError(f"„{name}” nie jest poprawną nazwą hosta") from exc
    label = r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?"
    if len(candidate) > 253 or re.fullmatch(rf"{label}(?:\.{label})+", candidate) is None:
        raise ApacheConfError(f"„{name}” nie jest poprawną nazwą hosta (oczekiwano np. media.example.org)")
    return candidate


def access_lines(mode: str, vps_addresses: Sequence[str] = (), allow_lan: bool = False) -> list[str]:
    """The ``Require`` lines that replace the example's ``Require all granted``."""
    if mode == "direct":
        return ["Require all granted"]
    lines = ["Require local"]
    if mode == "vps":
        addresses = normalise_addresses(vps_addresses)
        if not addresses:
            raise ApacheConfError("Tryb przez VPS wymaga co najmniej jednego adresu VPS")
        lines.append("Require ip " + " ".join(addresses))
    if mode == "lan" or (mode == "vps" and allow_lan):
        lines.append("Require ip " + " ".join(PRIVATE_RANGES))
    return lines


@dataclass(frozen=True)
class WampConf:
    """Everything the generated alias file depends on."""

    root: str
    service_port: int = 8765
    mode: str = "local"
    host_name: str | None = None
    vps_addresses: tuple[str, ...] = ()
    allow_lan: bool = False
    certificate_file: str | None = None
    certificate_key_file: str | None = None
    add_listen_443: bool = False
    generated: str = ""


def required_modules(mode: str) -> tuple[str, ...]:
    return BASE_MODULES + (TLS_MODULES if mode in {"direct", "vps"} else ())


def render_wamp_conf(template: str, conf: WampConf) -> str:
    """The alias file for one installation, built from the project's WAMP example."""
    if conf.mode not in MODES:
        raise ApacheConfError(f"Nieznany tryb dostępu: {conf.mode}")
    if not 1 <= conf.service_port <= 65535:
        raise ApacheConfError("Port usługi musi mieścić się w zakresie 1..65535")
    root = _quote_path(conf.root)
    lines = template.replace("\r\n", "\n").split("\n")

    define_at = [i for i, line in enumerate(lines) if line.startswith("Define TRYHACKX_MEDIA_ROOT ")]
    if len(define_at) != 1:
        raise ApacheConfError("Szablon Apache nie ma dokładnie jednej linii Define TRYHACKX_MEDIA_ROOT")
    body = lines[define_at[0] + 1:]

    access = access_lines(conf.mode, conf.vps_addresses, conf.allow_lan)
    replaced: list[str] = []
    grants = 0
    for line in body:
        if line.strip() == "Require all granted":
            grants += 1
            indent = line[: len(line) - len(line.lstrip())]
            replaced.extend(indent + entry for entry in access)
        else:
            replaced.append(line)
    # Four places open the application in the example: the built frontend, the
    # bridge script, the bridge route and the transfer route. A fifth would be a
    # route this module does not know how to close.
    if grants != 4:
        raise ApacheConfError(f"Szablon Apache ma {grants} reguł „Require all granted”, oczekiwano 4")
    text = "\n".join(replaced)

    upstream = "http://127.0.0.1:8765/"
    if text.count(upstream) != 2:
        raise ApacheConfError("Szablon Apache nie ma dwóch linii trasy transferu na porcie 8765")
    text = text.replace(upstream, f"http://127.0.0.1:{conf.service_port}/")

    described = {
        "local": "tylko ten komputer (localhost)",
        "lan": "sieć domowa, HTTP bez szyfrowania",
        "direct": "własna domena wprost na tym komputerze (HTTPS)",
        "vps": "przez VPS (reverse proxy); HTTPS tylko dla adresów VPS",
    }[conf.mode]
    header = [
        f"{MANAGED_MARKER} v1",
        "# Plik wygenerowany przez kreator TryHackX Media Server (Zainstaluj.cmd).",
        "# Nie edytuj go ręcznie: każde ponowne uruchomienie kreatora zapisuje go od nowa.",
        "# Zmiana ustawień: Zainstaluj.cmd → „Sposób dostępu”. Opis: docs/INSTALL-WINDOWS.md.",
        f"# Tryb dostępu: {described}.",
    ]
    if conf.generated:
        header.append(f"# Wygenerowano: {conf.generated}")
    header += ["", "# Jedyne miejsce ze ścieżką drzewa projektu w tym pliku.", f'Define TRYHACKX_MEDIA_ROOT "{root}"']

    tail: list[str] = []
    if conf.mode in {"direct", "vps"}:
        if not conf.certificate_file or not conf.certificate_key_file:
            raise ApacheConfError("Tryb z HTTPS wymaga pliku certyfikatu i pliku klucza")
        certificate = _quote_path(conf.certificate_file)
        key = _quote_path(conf.certificate_key_file)
        tail += ["", "# ————— HTTPS —————"]
        if conf.add_listen_443:
            tail += [
                "# WAMP nasłuchuje domyślnie tylko na porcie 80. `Listen 443` stoi tutaj, a nie",
                "# w httpd.conf, żeby usunięcie tego pliku cofało całą zmianę.",
                "Listen 443",
            ]
        if conf.mode == "direct":
            host = normalise_host_name(conf.host_name or "")
            tail += [
                "",
                "# Port 80 dla nazwy publicznej tylko przekierowuje: most odrzuca logowanie po",
                "# zwykłym HTTP, więc aplikacja podana tutaj odbijałaby każde kliknięcie.",
                "<VirtualHost *:80>",
                f"    ServerName {host}",
                f'    RedirectMatch permanent "^/(.*)$" "https://{host}/$1"',
                "</VirtualHost>",
                "",
                "<VirtualHost *:443>",
                f"    ServerName {host}",
                '    DocumentRoot "${TRYHACKX_MEDIA_ROOT}/public/assets/build"',
                "",
                "    SSLEngine on",
                "    SSLProtocol all -SSLv3 -TLSv1 -TLSv1.1",
                f'    SSLCertificateFile "{certificate}"',
                f'    SSLCertificateKeyFile "{key}"',
                "",
                "    # HSTS należy do hosta kończącego TLS.",
                '    Header always set Strict-Transport-Security "max-age=31536000"',
                "</VirtualHost>",
            ]
        else:
            tail += [
                "",
                "# Jedyny gość tego hosta to VPS: sprawdza ten certyfikat co do bajtu (plik",
                "# origin.crt w paczce dla VPS), a zapora Windows wpuszcza na port 443 tylko jego",
                "# adres. Nazwa i certyfikat celowo NIE zawierają publicznej domeny — ktoś, kto",
                "# trafi na ten adres skanerem, nie dowie się, czyj to serwer. HSTS i Let's Encrypt",
                "# są po stronie VPS.",
                "<VirtualHost *:443>",
                f"    ServerName {ORIGIN_SERVER_NAME}",
                '    DocumentRoot "${TRYHACKX_MEDIA_ROOT}/public/assets/build"',
                "",
                "    SSLEngine on",
                "    SSLProtocol all -SSLv3 -TLSv1 -TLSv1.1",
                f'    SSLCertificateFile "{certificate}"',
                f'    SSLCertificateKeyFile "{key}"',
                "</VirtualHost>",
            ]

    result = "\n".join(header) + "\n" + text.rstrip("\n") + "\n" + ("\n".join(tail) + "\n" if tail else "")
    return result


# -- httpd-vhosts.conf ---------------------------------------------------------------------

_VHOST_OPEN = re.compile(r"^\s*<VirtualHost\s+([^>]+)>\s*$", re.IGNORECASE)
_VHOST_CLOSE = re.compile(r"^\s*</VirtualHost>\s*$", re.IGNORECASE)
_DOCROOT = re.compile(r"^(\s*)DocumentRoot\s+(.+?)\s*$", re.IGNORECASE)
_SERVER_NAME = re.compile(r"^\s*ServerName\s+(\S+)", re.IGNORECASE)


@dataclass
class VirtualHost:
    start: int
    end: int  # index of the closing line
    addresses: tuple[str, ...]
    server_name: str | None
    document_root: str | None
    document_root_line: int | None

    @property
    def ports(self) -> tuple[int, ...]:
        ports = []
        for address in self.addresses:
            _host, separator, port = address.rpartition(":")
            ports.append(int(port) if separator and port.isdigit() else 80)
        return tuple(ports)


def find_virtual_hosts(text: str) -> list[VirtualHost]:
    lines = text.replace("\r\n", "\n").split("\n")
    hosts: list[VirtualHost] = []
    current: VirtualHost | None = None
    for index, line in enumerate(lines):
        stripped = line.lstrip()
        if stripped.startswith("#"):
            continue
        opened = _VHOST_OPEN.match(line)
        if opened and current is None:
            current = VirtualHost(index, index, tuple(opened.group(1).split()), None, None, None)
            continue
        if current is None:
            continue
        if _VHOST_CLOSE.match(line):
            current.end = index
            hosts.append(current)
            current = None
            continue
        name = _SERVER_NAME.match(line)
        if name and current.server_name is None:
            current.server_name = name.group(1).strip('"')
        root = _DOCROOT.match(line)
        if root and current.document_root is None:
            current.document_root = root.group(2).strip().strip('"')
            current.document_root_line = index
    return hosts


def _local_host(hosts: Sequence[VirtualHost]) -> VirtualHost | None:
    """The host that answers ``http://localhost/`` — and, being first, every request by bare address."""
    on_80 = [host for host in hosts if 80 in host.ports]
    for host in on_80:
        if (host.server_name or "").lower().split(":")[0] == "localhost":
            return host
    return on_80[0] if on_80 else None


def set_document_root(text: str, document_root: str) -> tuple[str, dict[str, object]]:
    """Point WAMP's ``localhost`` host at the application; remember what it pointed at before."""
    target = _quote_path(document_root)
    newline = "\r\n" if "\r\n" in text else "\n"
    lines = text.replace("\r\n", "\n").split("\n")
    host = _local_host(find_virtual_hosts(text))
    if host is None or host.document_root_line is None:
        raise ApacheConfError(
            "W httpd-vhosts.conf nie ma hosta wirtualnego na porcie 80 z linią DocumentRoot — "
            "kreator nie wie, którą linię zmienić"
        )
    at = host.document_root_line
    indent = _DOCROOT.match(lines[at]).group(1)  # type: ignore[union-attr]
    current = host.document_root or ""
    managed = at > 0 and lines[at - 1].lstrip().startswith(DOCROOT_MARKER)
    new_line = f'{indent}DocumentRoot "{target}"'
    info: dict[str, object] = {
        "server_name": host.server_name,
        "previous": current,
        "managed": managed,
        "changed": lines[at] != new_line,
    }
    if forward_slashes(current).lower() == target.lower() and not managed:
        # Somebody already pointed the host here by hand. It is left alone and not
        # marked as ours, so uninstalling will not "restore" a value we never saw.
        info.update(changed=False, adopted=True)
        return text, info
    if managed:
        lines[at] = new_line
    else:
        lines[at:at + 1] = [
            *(indent + note for note in _DOCROOT_NOTES),
            f"{indent}{DOCROOT_MARKER} {lines[at].strip()}",
            new_line,
        ]
    return newline.join(lines), info


def restore_document_root(text: str) -> tuple[str, bool]:
    """Undo ``set_document_root``. Returns the text and whether anything was restored."""
    newline = "\r\n" if "\r\n" in text else "\n"
    lines = text.replace("\r\n", "\n").split("\n")
    restored = False
    index = 0
    while index < len(lines):
        stripped = lines[index].lstrip()
        if stripped.startswith(DOCROOT_MARKER) and index + 1 < len(lines) and _DOCROOT.match(lines[index + 1]):
            indent = lines[index][: len(lines[index]) - len(stripped)]
            previous = stripped[len(DOCROOT_MARKER):].strip()
            start = index
            while start > 0 and lines[start - 1].strip() in _DOCROOT_NOTES:
                start -= 1
            lines[start:index + 2] = [indent + previous]
            restored = True
            index = start + 1
            continue
        index += 1
    return newline.join(lines), restored


def comment_out_hosts(text: str, port: int = 443) -> tuple[str, list[str]]:
    """Switch off existing virtual hosts on ``port`` (kept in the file, marked, reversible)."""
    newline = "\r\n" if "\r\n" in text else "\n"
    lines = text.replace("\r\n", "\n").split("\n")
    names: list[str] = []
    for host in reversed(find_virtual_hosts(text)):
        if port not in host.ports:
            continue
        names.append(host.server_name or " ".join(host.addresses))
        for index in range(host.start, host.end + 1):
            lines[index] = VHOST_OFF_MARKER + lines[index]
    return newline.join(lines), list(reversed(names))


def restore_commented_hosts(text: str) -> tuple[str, bool]:
    newline = "\r\n" if "\r\n" in text else "\n"
    lines = text.replace("\r\n", "\n").split("\n")
    restored = False
    for index, line in enumerate(lines):
        if line.startswith(VHOST_OFF_MARKER):
            lines[index] = line[len(VHOST_OFF_MARKER):]
            restored = True
    return newline.join(lines), restored


# -- httpd.conf ----------------------------------------------------------------------------

_LOAD = re.compile(r"^(\s*)(#\s*)?LoadModule\s+(\S+)\s+(\S.*?)\s*$", re.IGNORECASE)
_LISTEN = re.compile(r"^\s*Listen\s+(\S+)", re.IGNORECASE)


def enable_modules(text: str, modules: Sequence[str]) -> tuple[str, dict[str, list[str]]]:
    """Uncomment the ``LoadModule`` lines of the named modules; report what could not be found."""
    newline = "\r\n" if "\r\n" in text else "\n"
    lines = text.replace("\r\n", "\n").split("\n")
    state: dict[str, tuple[int, bool]] = {}
    for index, line in enumerate(lines):
        match = _LOAD.match(line)
        if not match:
            continue
        name, commented = match.group(3), bool(match.group(2))
        # An active line wins over a commented duplicate of the same module.
        if name not in state or (state[name][1] and not commented):
            state[name] = (index, commented)
    report: dict[str, list[str]] = {"enabled": [], "already": [], "missing": []}
    for module in modules:
        if module not in state:
            report["missing"].append(module)
            continue
        index, commented = state[module]
        if not commented:
            report["already"].append(module)
            continue
        match = _LOAD.match(lines[index])
        lines[index] = f"{match.group(1)}LoadModule {match.group(3)} {match.group(4)}"  # type: ignore[union-attr]
        report["enabled"].append(module)
    return newline.join(lines), report


def listens_on(texts: Sequence[str], port: int) -> bool:
    """Whether any of the given configuration texts already has a ``Listen`` for ``port``."""
    for text in texts:
        for line in text.replace("\r\n", "\n").split("\n"):
            match = _LISTEN.match(line)
            if not match:
                continue
            value = match.group(1)
            candidate = value.rpartition(":")[2] if ":" in value else value
            if candidate.isdigit() and int(candidate) == port:
                return True
    return False


def managed_root(text: str) -> tuple[str | None, bool]:
    """The project tree an alias file points at, and whether the wizard wrote that file."""
    match = re.search(r'^\s*Define\s+TRYHACKX_MEDIA_ROOT\s+"?([^"\r\n]+?)"?\s*$', text, re.MULTILINE)
    return (match.group(1) if match else None, MANAGED_MARKER in text)
