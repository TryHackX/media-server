"""What the Debian installer decides, as functions over text and data.

``zainstaluj-debian.sh`` is a shell script: good at running ``apt``, ``systemctl``
and ``ufw``, and — on the machine it was written on — impossible to run for real.
So every *decision* lives here, where it is tested: which packages a shape needs,
what the Apache sites say, which firewall rules stand between the internet and
the home network, the SQL that creates the accounts, what the state file
remembers. The script asks, runs what it is told and reports.

The four shapes are the ones of ``docs/PUBLIC-EXPOSURE.md`` under the names the
shared Apache generator already uses (``apacheconf.MODES``):

=========  ======  ==========================================================
``direct``   S     this machine is the public server: own domain, own TLS
``vps``      P     a home server; a public VPS in front of it (shape A)
``lan``      D     the home network only, plain HTTP
``local``    C     this computer only
=========  ======  ==========================================================

The Apache sites are generated from the project's own examples
(``deploy/apache/media-next.conf.example`` and ``media-transfer.conf.example``):
only the access rules and the service port are changed, so a route closed in the
example is closed in every generated file — and an example that changed in a way
this module does not understand is refused instead of half-translated.

Standard library only.
"""
from __future__ import annotations

import ipaddress
import json
import os
import re
import secrets
import tomllib
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from . import tomledit
from .answers import Problem, check_folder_path, nesting_problems, problem
from .apacheconf import (
    MODES,
    ORIGIN_SERVER_NAME,
    ApacheConfError,
    access_lines,
    normalise_addresses,
    normalise_host_name,
    required_modules,
)
from .vpsbundle import SCRIPT_MARKER, SITE_NAME

# -- the layout: the same paths scripts/release-debian.sh and deploy/systemd/* spell ------------

MARKER_TEXT = SCRIPT_MARKER
MARKER_LINE = "# " + MARKER_TEXT

PREFIX = "/opt/tryhackx-media-server"
CURRENT = f"{PREFIX}/current"
CONFIG_DIR = "/etc/tryhackx-media-server"
CONFIG = f"{CONFIG_DIR}/config.local.toml"
MIGRATE_CONFIG = f"{CONFIG_DIR}/config.migrate.toml"
STATE_FILE = f"{CONFIG_DIR}/installer.json"
ORIGIN_CERT = f"{CONFIG_DIR}/origin/origin-cert.pem"
ORIGIN_KEY = f"{CONFIG_DIR}/origin/origin-key.pem"
SELF_CERT = f"{CONFIG_DIR}/tls/selfsigned-cert.pem"
SELF_KEY = f"{CONFIG_DIR}/tls/selfsigned-key.pem"
BUNDLE_DIR = f"{CONFIG_DIR}/vps-bundle"
STATE_DIR = "/var/lib/tryhackx-media-server"
LOG_DIR = "/var/log/tryhackx-media-server"
BACKUP_ROOT = "/var/backups/tryhackx-media-server"
ACME_WEBROOT = "/var/www/tryhackx-media"
SITES_AVAILABLE = "/etc/apache2/sites-available"
HTTP_SITE = SITE_NAME
HTTPS_SITE = f"{SITE_NAME}-ssl"
SYSTEMD_DIR = "/etc/systemd/system"
SERVICE = "tryhackx-media-transfer"
UNITS = (
    "tryhackx-media-transfer.service",
    "tryhackx-media-maintenance.service",
    "tryhackx-media-maintenance.timer",
    "tryhackx-media-digest.service",
    "tryhackx-media-digest.timer",
)
TIMERS = ("tryhackx-media-maintenance.timer", "tryhackx-media-digest.timer")
FAIL2BAN_FILTER = "/etc/fail2ban/filter.d/tryhackx-media-auth.conf"
FAIL2BAN_JAIL = "/etc/fail2ban/jail.d/tryhackx-media.conf"
RENEW_HOOK = "/etc/letsencrypt/renewal-hooks/deploy/tryhackx-media-reload.sh"
SERVICE_USER = "www-data"
FIREWALL_COMMENT = "tryhackx-media"
# The rules that keep the machine reachable (SSH, the home network) once this installer has switched
# ufw on. Marked apart: an uninstall that leaves ufw on must leave them too (audit P0-1).
FIREWALL_REACH_COMMENT = "tryhackx-media-reach"
# A DHCP client listens on these, and ufw's own before.rules let the server's replies in: switching
# the firewall on closes nothing there (seen on a real Debian 13: dhclient on port 68).
DHCP_CLIENT_PORTS = frozenset({"68/udp", "546/udp"})

LETTERS = {"direct": "S", "vps": "P", "lan": "D", "local": "C"}

# Where a media folder cannot live, and why (the reason becomes ``folder.<reason>``).
# The units run with ProtectHome=true and PrivateTmp=true: the service does not
# *see* these places, and the symptom is a server that starts and reports 503.
FORBIDDEN_FOLDERS: dict[str, tuple[str, ...]] = {
    "home": ("/home", "/root", "/run/user"),
    "tmp": ("/tmp", "/var/tmp"),
    # Everything an uninstall may delete as a whole: media can never lie inside any of it.
    "own": (PREFIX, CONFIG_DIR, STATE_DIR, LOG_DIR, BACKUP_ROOT, ACME_WEBROOT),
    "system": ("/proc", "/sys", "/dev", "/run", "/etc", "/boot", "/bin", "/sbin", "/lib", "/lib64", "/usr",
               "/var/lib", "/var/log", "/var/cache", "/var/www"),
}

# -- packages and modules ----------------------------------------------------------------------

# What the code needs, read from the code:
#   python3, python3-venv       scripts/install.py builds a private environment (pyproject: >= 3.11)
#   apache2, libapache2-mod-php the bridge is one PHP file served by Apache
#   php-cli                     /usr/bin/php: the digest unit and `account-create` (password_hash)
#   php-mysql                   PDO (pdo_mysql) — every query of the bridge
#   php-mbstring                mb_* in every catalogue and sign-in path
#   php-curl                    curl_* in calls to the transfer service and to CAPTCHA providers
#   php-xml                     simplexml_load_string in the XSPF playlist import
#   mariadb-server, -client     the one database; the client is how root creates it
#   ffmpeg                      thumbnails, durations, subtitles, the compatibility stream
#   curl                        the smoke test of scripts/release-debian.sh and of the installer
#   openssl                     the home server's certificate
# (openssl, iconv, ctype, json, session and hash are part of PHP's own packages on Debian.)
BASE_PACKAGES = (
    "python3", "python3-venv", "apache2", "libapache2-mod-php", "php-cli", "php-mysql", "php-mbstring",
    "php-curl", "php-xml", "mariadb-server", "mariadb-client", "ffmpeg", "curl", "openssl", "ca-certificates",
)
PHP_EXTENSIONS = ("pdo_mysql", "mbstring", "curl", "simplexml", "openssl")
_PHP_VERSION = re.compile(r"[0-9]\.[0-9]{1,2}")


def php_fpm_version(value: object) -> str:
    """The PHP version an Apache already serves through PHP-FPM ("8.4"), or ''."""
    text = str(value or "").strip()
    return text if _PHP_VERSION.fullmatch(text) else ""


def packages(
    mode: str,
    *,
    certificate: str = "",
    fail2ban: bool = False,
    manage_firewall: bool = True,
    build_frontend: bool = False,
    php_fpm: str = "",
) -> list[str]:
    """The apt packages one installation needs — nothing "just in case".

    An Apache that already hands PHP to PHP-FPM keeps doing so: Debian's
    ``libapache2-mod-php`` switches Apache to the prefork MPM when it is installed,
    which would change every other site of that server. The bridge then runs in
    the same PHP-FPM, so its extensions are the ones of that PHP version.
    """
    _need_mode(mode)
    wanted = list(BASE_PACKAGES)
    version = php_fpm_version(php_fpm)
    if version:
        wanted = [
            f"php{version}-{name.removeprefix('php-')}" if name.startswith("php-") else name
            for name in wanted
            if name != "libapache2-mod-php"
        ]
    if mode == "direct" and certificate == "letsencrypt":
        wanted.append("certbot")
    if manage_firewall and mode != "local":
        wanted.append("ufw")
    if fail2ban and mode == "direct":
        wanted.append("fail2ban")
    if mode == "vps":
        # scp and ssh, for carrying the bundle to the VPS.
        wanted.append("openssh-client")
    if build_frontend:
        wanted += ["nodejs", "npm"]
    return wanted


def apache_modules(mode: str, *, php_fpm: str = "") -> list[str]:
    """Names for ``a2enmod``: the directives of the examples, plus TLS for the two shapes that end it here.

    Behind PHP-FPM, Debian's ``phpX.Y-fpm.conf`` hands ``.php`` to FPM only inside
    ``<IfModule proxy_fcgi_module>``: without that module the bridge's source would be
    served as a file instead of being run.
    """
    _need_mode(mode)
    names = [name.removesuffix("_module") for name in required_modules(mode)]
    if php_fpm_version(php_fpm):
        names += [name for name in ("proxy_fcgi", "setenvif") if name not in names]
    return names


def _need_mode(mode: str) -> None:
    if mode not in MODES:
        raise ApacheConfError(f"Nieznany tryb dostępu: {mode}")


def migrate_user(user: str) -> str:
    """The account that may change the schema. The application's own account never can."""
    return f"{user}_ddl"


# -- Apache ------------------------------------------------------------------------------------


@dataclass(frozen=True)
class SiteConf:
    """Everything the generated sites depend on."""

    mode: str
    host_name: str | None = None
    vps_addresses: tuple[str, ...] = ()
    allow_lan: bool = False
    service_port: int = 8765
    certificate_file: str | None = None
    certificate_key_file: str | None = None
    generated: str = ""
    media_root: str = CURRENT
    bridge_config: str = CONFIG


_DESCRIBED = {
    "local": "C — tylko ten komputer (localhost, HTTP)",
    "lan": "D — sieć domowa, HTTP bez szyfrowania",
    "direct": "S — samodzielny serwer publiczny (własna domena, HTTPS)",
    "vps": "P — serwer domowy za publicznym VPS-em; HTTPS tylko dla adresów VPS",
}


def _path(value: str) -> str:
    if not value.startswith("/") or any(ch in value for ch in '"\n\r') or "${" in value:
        raise ApacheConfError(f"Ścieżki nie da się zapisać w konfiguracji Apache: {value!r}")
    return value


def _directive_lines(example: str) -> list[str]:
    """An example without its commentary: directives only, blank lines kept single."""
    lines: list[str] = []
    for raw in example.replace("\r\n", "\n").split("\n"):
        line = raw.rstrip()
        if line.lstrip().startswith("#"):
            continue
        if not line.strip():
            if lines and lines[-1] != "":
                lines.append("")
            continue
        lines.append(line)
    while lines and lines[-1] == "":
        lines.pop()
    return lines


def _with_access(lines: Sequence[str], marker: str, access: Sequence[str], expected: int, what: str) -> list[str]:
    """Replace every ``marker`` rule (there must be exactly ``expected``) with the rules of the shape."""
    result: list[str] = []
    found = 0
    for line in lines:
        if line.strip() == marker:
            found += 1
            indent = line[: len(line) - len(line.lstrip())]
            result.extend(indent + entry for entry in access)
        else:
            result.append(line)
    if found != expected:
        raise ApacheConfError(f"Przykład {what} ma {found} reguł „{marker}”, oczekiwano {expected}")
    return result


def application_lines(next_example: str, transfer_example: str, conf: SiteConf) -> list[str]:
    """The body of the host that serves the application: both examples, with this shape's access rules."""
    if not 1 <= conf.service_port <= 65535:
        raise ApacheConfError("Port usługi musi mieścić się w zakresie 1..65535")
    access = access_lines(conf.mode, conf.vps_addresses, conf.allow_lan)

    # Two places open the application in the first example: the built frontend and
    # the bridge script. A third would be a route this module does not know how to close.
    bridge = _with_access(_directive_lines(next_example), "Require all granted", access, 2, "media-next.conf")
    if not any(line.startswith('Alias "/media-next-api" ') for line in bridge):
        raise ApacheConfError("Przykład media-next.conf nie zawiera aliasu mostu (/media-next-api)")
    if not any(line.startswith("SetEnv TRYHACKX_BRIDGE_CONFIG ") for line in bridge):
        raise ApacheConfError("Przykład media-next.conf nie przekazuje mostowi ścieżki konfiguracji")

    # The transfer example ships closed (`Require local`) with the open variant in a
    # comment; the comment is gone by now, and the one live rule becomes the shape's.
    transfer = _directive_lines(transfer_example)
    if any(line.strip() == "Require all granted" for line in transfer):
        raise ApacheConfError("Przykład media-transfer.conf ma już otwartą regułę — instalator nie wie, którą zamknąć")
    transfer = _with_access(transfer, "Require local", access, 1, "media-transfer.conf")
    upstream = "http://127.0.0.1:8765/"
    text = "\n".join(transfer)
    if text.count(upstream) != 2:
        raise ApacheConfError("Przykład media-transfer.conf nie ma dwóch linii trasy transferu na porcie 8765")
    transfer = text.replace(upstream, f"http://127.0.0.1:{conf.service_port}/").split("\n")
    opened = next((i for i, line in enumerate(transfer) if line.startswith("<Location /media-transfer/>")), None)
    closed = next((i for i, line in enumerate(transfer) if line.startswith('<LocationMatch "^/media-transfer/(health|')), None)
    if opened is None or closed is None or closed < opened:
        # Location sections merge in file order and a later Require replaces an earlier
        # one: the block that closes health and the job routes must come last.
        raise ApacheConfError("Przykład media-transfer.conf: blok zamykający trasy wewnętrzne musi stać po otwierającym")
    return [*bridge, "", *transfer]


def _header(conf: SiteConf, what: str) -> list[str]:
    lines = [
        MARKER_LINE,
        f"# TryHackX Media Server — {what}.",
        "# Plik wygenerowany przez instalator (zainstaluj-debian.sh). Nie edytuj go ręcznie:",
        "# każda zmiana sposobu dostępu zapisuje go od nowa (sudo bash zainstaluj-debian.sh --zmien dostep).",
        f"# Tryb dostępu: {_DESCRIBED[conf.mode]}. Opis: docs/INSTALL-DEBIAN.md.",
    ]
    if conf.generated:
        lines.append(f"# Wygenerowano: {conf.generated}")
    return lines


def _logs() -> list[str]:
    return [
        f"    ErrorLog ${{APACHE_LOG_DIR}}/{SITE_NAME}-error.log",
        f"    CustomLog ${{APACHE_LOG_DIR}}/{SITE_NAME}-access.log combined",
    ]


def _defines(conf: SiteConf) -> list[str]:
    return [
        "# Jedyne miejsce ze ścieżkami w tym pliku. `current` jest dowiązaniem przełączanym przez",
        "# scripts/release-debian.sh, więc aktualizacja aplikacji nie dotyka Apache.",
        f'Define TRYHACKX_MEDIA_ROOT "{_path(conf.media_root)}"',
        f'Define TRYHACKX_BRIDGE_CONFIG "{_path(conf.bridge_config)}"',
    ]


def _indented(lines: Sequence[str]) -> list[str]:
    return [("    " + line) if line else "" for line in lines]


def render_sites(next_example: str, transfer_example: str, conf: SiteConf) -> dict[str, str]:
    """The Apache sites of one installation: ``{site name: text}`` — one or two files, by shape."""
    _need_mode(conf.mode)
    body = _indented(application_lines(next_example, transfer_example, conf))
    document_root = '    DocumentRoot "${TRYHACKX_MEDIA_ROOT}/public/assets/build"'
    sites: dict[str, str] = {}

    if conf.mode in {"local", "lan"}:
        lines = [
            *_header(conf, "aplikacja na porcie 80"),
            "",
            *_defines(conf),
            "",
            "<VirtualHost *:80>",
            "    ServerName localhost",
            document_root,
            "",
            "    # Zwykłe HTTP z tego komputera jest dozwolone zawsze; z sieci domowej tylko",
            "    # przy `[session] require_https = false` w prywatnej konfiguracji (kształt D).",
            '    SetEnv TRYHACKX_BRIDGE_ALLOW_HTTP_LOCAL "1"',
            "",
            *body,
            "",
            *_logs(),
            "</VirtualHost>",
        ]
        sites[HTTP_SITE] = "\n".join(lines) + "\n"
        return sites

    if not conf.certificate_file or not conf.certificate_key_file:
        raise ApacheConfError("Tryb z HTTPS wymaga pliku certyfikatu i pliku klucza")
    certificate = _path(conf.certificate_file)
    key = _path(conf.certificate_key_file)
    tls = [
        "    SSLEngine on",
        "    SSLProtocol all -SSLv3 -TLSv1 -TLSv1.1",
        f'    SSLCertificateFile "{certificate}"',
        f'    SSLCertificateKeyFile "{key}"',
    ]

    if conf.mode == "direct":
        host = normalise_host_name(conf.host_name or "")
        challenge = f"{ACME_WEBROOT}/.well-known/acme-challenge/"
        http = [
            *_header(conf, "port 80: wyzwanie Let's Encrypt i przekierowanie na HTTPS"),
            "",
            "# Aplikacji tu nie ma celowo: most odrzuca logowanie po zwykłym HTTP, więc podana",
            "# na porcie 80 wyglądałaby na działającą i odbijała każde kliknięcie.",
            "<VirtualHost *:80>",
            f"    ServerName {host}",
            "",
            "    # Odnowienie certyfikatu (certbot --webroot) musi dojść po HTTP — wszystko inne idzie na HTTPS.",
            f"    Alias /.well-known/acme-challenge/ {challenge}",
            f"    <Directory {challenge}>",
            "        Options None",
            "        AllowOverride None",
            "        Require all granted",
            "    </Directory>",
            "",
            f'    RedirectMatch permanent "^/(?!\\.well-known/acme-challenge/)(.*)$" "https://{host}/$1"',
            "",
            *_logs(),
            "</VirtualHost>",
        ]
        https = [
            *_header(conf, "port 443: aplikacja"),
            "",
            *_defines(conf),
            "",
            "<VirtualHost *:443>",
            f"    ServerName {host}",
            document_root,
            "",
            *tls,
            "",
            "    # HSTS należy do hosta kończącego TLS.",
            '    Header always set Strict-Transport-Security "max-age=31536000"',
            "",
            *body,
            "",
            *_logs(),
            "</VirtualHost>",
        ]
        sites[HTTP_SITE] = "\n".join(http) + "\n"
        sites[HTTPS_SITE] = "\n".join(https) + "\n"
        return sites

    # Behind the VPS. The public name appears nowhere in this file on purpose.
    https = [
        *_header(conf, "port 443: aplikacja, osiągalna wyłącznie dla VPS"),
        "",
        *_defines(conf),
        "",
        "# Jedyny gość tego hosta to VPS: sprawdza ten certyfikat co do bajtu (plik origin.crt",
        "# w paczce dla VPS), a zapora wpuszcza na port 443 tylko jego adres. Nazwa i certyfikat",
        "# celowo NIE zawierają publicznej domeny — kto trafi na ten adres skanerem, nie dowie się,",
        "# czyj to serwer. HSTS i Let's Encrypt są po stronie VPS.",
        "<VirtualHost *:443>",
        f"    ServerName {ORIGIN_SERVER_NAME}",
        document_root,
        "",
        *tls,
        "",
        *body,
        "",
        *_logs(),
        "</VirtualHost>",
    ]
    sites[HTTPS_SITE] = "\n".join(https) + "\n"
    return sites


def certificate_config(common_name: str, alt_name: str | None = None) -> str:
    """The OpenSSL request file for a self-signed certificate of this installer.

    A *server* certificate, not an authority: ``req -x509`` with the system's
    ``openssl.cnf`` adds its ``v3_ca`` extensions (``CA:TRUE``), and Firefox refuses
    a CA certificate presented by a server with no way to proceed. The authority
    key identifier is there for the day the certificate is replaced: during a
    rotation the VPS trusts the old and the new certificate at once, both are
    called ``CN=origin``, and the identifier is what lets OpenSSL tell them apart
    (measured: without it one of the two is rejected, and which one depends on
    their order in the file).
    """
    if not re.fullmatch(r"[A-Za-z0-9.-]{1,64}", common_name):
        raise ApacheConfError(f"Nazwy „{common_name}” nie da się wpisać do certyfikatu")
    lines = [
        "[req]",
        "distinguished_name = dn",
        "prompt = no",
        "x509_extensions = server",
        "[dn]",
        f"CN = {common_name}",
        "[server]",
        "basicConstraints = critical, CA:FALSE",
        # No keyUsage, as in the Windows wizard (Step-Certificate): OpenSSL before 1.1.1h - an
        # older Ubuntu on the VPS - does not accept a self-issued certificate whose keyUsage
        # lacks keyCertSign as its own trust anchor, and the pin on the VPS is exactly that.
        "extendedKeyUsage = serverAuth",
        "subjectKeyIdentifier = hash",
        "authorityKeyIdentifier = keyid:always",
    ]
    if alt_name:
        lines.append(f"subjectAltName = DNS:{normalise_host_name(alt_name)}")
    return "\n".join(lines) + "\n"


# -- the firewall ------------------------------------------------------------------------------


# What "a home network" is: the private address space, as named - not whatever a library
# calls "not global" (that also covers documentation ranges and carrier-grade NAT).
_HOME_SPACE = tuple(ipaddress.ip_network(net) for net in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "fc00::/7"))


def lan_networks(cidrs: Sequence[str]) -> list[str]:
    """The networks a list of interface addresses (``192.168.1.20/24``) belongs to — private ones only.

    A machine with a public address on its interface (a VPS) has no home network,
    and its provider's subnet must never be mistaken for one.
    """
    result: list[str] = []
    for value in cidrs:
        try:
            interface = ipaddress.ip_interface(value.strip())
        except ValueError:
            continue
        network = interface.network
        if network.prefixlen == 0:
            continue
        if not any(interface.ip.version == space.version and interface.ip in space for space in _HOME_SPACE):
            continue
        text = str(network)
        if text not in result:
            result.append(text)
    return result


def _inside(address: str, networks: Sequence[str]) -> bool:
    try:
        parsed = ipaddress.ip_address(address)
    except ValueError:
        return False
    return any(parsed.version == net.version and parsed in net for net in map(ipaddress.ip_network, networks))


def firewall_rules(
    *,
    mode: str,
    vps_addresses: Sequence[str] = (),
    allow_lan: bool = False,
    lan_subnets: Sequence[str] = (),
    ssh_ports: Sequence[int] = (22,),
    ssh_client: str = "",
    ufw_active: bool = False,
    trust_lan: bool = True,
    extra_ports: Sequence[str] = (),
    ssh_peers: Sequence[str] = (),
) -> list[list[str]]:
    """The ``ufw`` rules of one shape, each as the arguments of one ``ufw`` call.

    Two different jobs, kept apart on purpose:

    * the **application's** rules — the ports of the shape, as narrow as the shape allows;
    * the rules that keep the machine **reachable** when this installer is the one
      switching the firewall on (``ufw_active`` false). ``ufw enable`` turns
      "everything is open" into "everything is closed", including the SSH session
      the installer may be running in and the file shares a home server usually
      has. A public server keeps SSH; a home server keeps its home network.
      A firewall that was already on is somebody's decision and is not widened.
    """
    _need_mode(mode)
    if mode == "local":
        return []
    subnets = list(dict.fromkeys(lan_subnets))
    ports = sorted({int(port) for port in ssh_ports if 1 <= int(port) <= 65535}) or [22]
    # Only an address the firewall can take: `who am i` also says "(:0)", "(tmux(1234).%0)" or a
    # host name, and ufw refusing one stopped the installation at its firewall step (audit P2-1).
    ssh_client = usable_address(ssh_client)
    # Run without a terminal under sudo (`ssh host 'sudo bash …'`), the session names no client at
    # all; what is connected over SSH right now stands in for it, so nobody connected is shut out.
    clients = [ssh_client] if ssh_client else list(dict.fromkeys(filter(None, map(usable_address, ssh_peers))))
    reach: list[list[str]] = []
    rules: list[list[str]] = []
    trusted_lan = False

    if not ufw_active:
        if mode == "direct":
            reach += [["allow", f"{port}/tcp"] for port in ports]
        else:
            if trust_lan and subnets:
                reach += [["allow", "from", subnet] for subnet in subnets]
                trusted_lan = True
            else:
                reach += [
                    ["allow", "proto", "tcp", "from", subnet, "to", "any", "port", str(port)]
                    for subnet in subnets for port in ports
                ]
            outside = [client for client in clients if not _inside(client, subnets)]
            if outside:
                # The session this is running in comes from outside the home network.
                reach += [
                    ["allow", "proto", "tcp", "from", client, "to", "any", "port", str(port)]
                    for client in outside for port in ports
                ]
            elif not subnets and not clients:
                # Nothing is known about where the administrator comes from: never lock them out.
                reach += [["allow", f"{port}/tcp"] for port in ports]

    if mode == "direct":
        rules += [["allow", "80/tcp"], ["allow", "443/tcp"]]
    elif mode == "vps":
        addresses = normalise_addresses(vps_addresses)
        if not addresses:
            raise ApacheConfError("Tryb przez VPS wymaga co najmniej jednego adresu VPS")
        rules += [["allow", "proto", "tcp", "from", address, "to", "any", "port", "443"] for address in addresses]
        if allow_lan and not trusted_lan:
            rules += [["allow", "proto", "tcp", "from", subnet, "to", "any", "port", "443"] for subnet in subnets]
    elif mode == "lan" and not trusted_lan:
        rules += [["allow", "proto", "tcp", "from", subnet, "to", "any", "port", "80"] for subnet in subnets]

    for entry in extra_ports:
        port, _slash, protocol = entry.partition("/")
        if mode == "direct":
            rules.append(["allow", f"{port}/{protocol}"])
        elif not trusted_lan:
            rules += [["allow", "proto", protocol, "from", subnet, "to", "any", "port", port] for subnet in subnets]

    kept: list[list[str]] = []
    unique: list[list[str]] = []
    for rule in reach:
        if rule not in kept:
            kept.append(rule)
    for rule in rules:
        if rule not in unique and rule not in kept:
            unique.append(rule)
    return ([[*rule, "comment", FIREWALL_REACH_COMMENT] for rule in kept]
            + [[*rule, "comment", FIREWALL_COMMENT] for rule in unique])


def usable_address(value: str) -> str:
    """``value`` when the firewall can take it as a source address (IPv4 or IPv6, zone id dropped), else ''."""
    candidate = str(value or "").strip().strip("[]")
    candidate = candidate.split("%", 1)[0]
    try:
        parsed = ipaddress.ip_address(candidate)
    except ValueError:
        return ""
    # An IPv4 client on a dual-stack socket shows up as ::ffff:a.b.c.d; ufw's rule is for a.b.c.d.
    if isinstance(parsed, ipaddress.IPv6Address) and parsed.ipv4_mapped is not None:
        return str(parsed.ipv4_mapped)
    return str(parsed)


# -- the database ------------------------------------------------------------------------------

_SQL_NAME = re.compile(r"[A-Za-z0-9_]{1,64}")


def _sql_text(value: str) -> str:
    if any(ord(ch) < 0x20 for ch in value):
        raise ValueError("Hasło bazy zawiera znak sterujący")
    return "'" + value.replace("\\", "\\\\").replace("'", "''") + "'"


def _sql_names(*names: str) -> None:
    for name in names:
        if _SQL_NAME.fullmatch(name) is None:
            raise ValueError(f"Nazwy „{name}” nie da się użyć w bazie (litery, cyfry i podkreślenie)")


def database_sql(*, name: str, user: str, password: str, ddl_user: str, ddl_password: str) -> str:
    """Create the one database and its two accounts; safe to run again.

    Two accounts on purpose. The application's holds data rights only, so a hole
    in the bridge cannot drop a table; the schema is changed by a second account
    whose password lives in a file only root reads. Each exists for ``localhost``
    and for ``127.0.0.1``: which of the two a TCP connection from this machine
    matches depends on whether the server resolves names.
    """
    _sql_names(name, user, ddl_user)
    if not password or not ddl_password:
        raise ValueError("Konto bazy bez hasła nie zostanie utworzone")
    lines = [f"CREATE DATABASE IF NOT EXISTS `{name}` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"]
    for account, secret, rights in (
        (user, password, "SELECT, INSERT, UPDATE, DELETE"),
        (ddl_user, ddl_password, "ALL PRIVILEGES"),
    ):
        for origin in ("localhost", "127.0.0.1"):
            lines += [
                f"CREATE USER IF NOT EXISTS '{account}'@'{origin}' IDENTIFIED BY {_sql_text(secret)};",
                f"ALTER USER '{account}'@'{origin}' IDENTIFIED BY {_sql_text(secret)};",
                f"GRANT {rights} ON `{name}`.* TO '{account}'@'{origin}';",
            ]
    lines.append("FLUSH PRIVILEGES;")
    return "\n".join(lines) + "\n"


def drop_sql(*, name: str, user: str, ddl_user: str) -> str:
    _sql_names(name, user, ddl_user)
    lines = [f"DROP DATABASE IF EXISTS `{name}`;"]
    for account in (user, ddl_user):
        for origin in ("localhost", "127.0.0.1"):
            lines.append(f"DROP USER IF EXISTS '{account}'@'{origin}';")
    lines.append("FLUSH PRIVILEGES;")
    return "\n".join(lines) + "\n"


def _database_of(config_text: str, what: str) -> dict[str, Any]:
    try:
        data = tomllib.loads(config_text)
    except tomllib.TOMLDecodeError as exc:
        raise tomledit.TomlEditError(f"{what} nie jest poprawnym TOML: {exc}") from exc
    database = data.get("database")
    if not isinstance(database, dict):
        raise tomledit.TomlEditError(f"{what} nie ma sekcji [database]")
    return database


MIGRATE_NOTE = (
    MARKER_LINE,
    "# Kopia config.local.toml z kontem uprawnionym do zmiany struktury bazy (DDL).",
    "# Czyta ją wyłącznie root przy migracjach (scripts/release-debian.sh --migrate-config).",
    "# Instalator odtwarza ten plik przy każdej zmianie konfiguracji — nie edytuj go ręcznie.",
)


def migrate_config_text(
    config_text: str, *, previous_text: str | None, new_password: Callable[[], str]
) -> tuple[str, bool]:
    """The configuration migrations run with: the service's own, with the schema account instead of the app's.

    Returns the text and whether the password is new (then the account must be
    given it). An existing file keeps its password, so re-running the installer
    does not touch the database server for nothing.
    """
    database = _database_of(config_text, "Konfiguracja")
    user = migrate_user(str(database.get("user", "media_server")))
    password = ""
    if previous_text is not None:
        try:
            previous = _database_of(previous_text, "Konfiguracja migracji")
        except tomledit.TomlEditError:
            previous = {}
        if previous.get("user") == user and isinstance(previous.get("password"), str):
            password = previous["password"]
    fresh = not password
    if fresh:
        password = new_password()
    # Everything else is the service's configuration to the letter: the same key, the same
    # folders, the same port — `set_values` refuses an edit that would change anything more.
    edited = tomledit.set_values(config_text, "database", {"user": user, "password": password})
    return "\n".join(MIGRATE_NOTE) + "\n" + edited, fresh


def new_password() -> str:
    """43 characters of ``[A-Za-z0-9_-]``: nothing a shell, SQL or TOML would need escaped."""
    return secrets.token_urlsafe(32)


# -- media folders -----------------------------------------------------------------------------


def guess_kind(path: str, identifier: str = "") -> str:
    """A first guess from a folder's name; the person confirms it."""
    name = (path.rstrip("/").rsplit("/", 1)[-1] + " " + identifier).lower()
    if re.search(r"muzy|music|audio|mp3|flac|album", name):
        return "music"
    if re.search(r"film|movie|video|wideo|serial|series|kino", name):
        return "movies"
    return "mixed"


def folder_problems(
    path: str, others: Sequence[str] = (), *, exists: Callable[[str], bool] = os.path.isdir
) -> tuple[str, list[Problem]]:
    """One media folder, checked the way the service will meet it."""
    clean, problems = check_folder_path(path, FORBIDDEN_FOLDERS)
    if problems:
        return clean, problems
    if not exists(clean):
        return clean, [problem("folder.missing", clean)]
    return clean, nesting_problems([*others, clean])


# -- an installation that is already there --------------------------------------------------------


def infer_access(summary: Mapping[str, Any]) -> dict[str, Any]:
    """For an installation set up by hand: what its configuration says about how it is reached."""
    access: dict[str, Any] = {"mode": "local", "host_name": "", "vps_addresses": [], "inferred": True}
    base = str(summary.get("base_url") or "")
    match = re.match(r"^https?://([^/:]+)", base)
    if match:
        access["host_name"] = match.group(1)
    trusted = str(summary.get("proxy_trusted") or "")
    if trusted:
        access["mode"] = "vps"
        access["vps_addresses"] = [entry for entry in re.split(r"[\s,]+", trusted) if entry]
    elif summary.get("require_https") is False:
        access["mode"] = "lan"
    elif base.startswith("https://"):
        access["mode"] = "direct"
    return access


def access_values(mode: str, host_name: str, vps_addresses: Sequence[str]) -> dict[str, Any]:
    """What a shape means for the private configuration (the three keys the bridge reads)."""
    _need_mode(mode)
    if mode == "vps":
        return {"base_url": f"https://{host_name}/", "proxy_trusted": ", ".join(vps_addresses), "require_https": True}
    if mode == "direct":
        return {"base_url": f"https://{host_name}/", "proxy_trusted": "", "require_https": True}
    if mode == "lan":
        return {"base_url": "", "proxy_trusted": "", "require_https": False}
    return {"base_url": "", "proxy_trusted": "", "require_https": True}


# -- the plan ----------------------------------------------------------------------------------


def plan(answers: Mapping[str, Any], environment: Mapping[str, Any]) -> dict[str, Any]:
    """Everything the installer will do for these answers on this machine, as data.

    ``environment`` is what the script saw: the machine's addresses, where the SSH
    session comes from, whether a firewall is on, which other sites answer on 443.
    Nothing here touches the machine.
    """
    access = answers["access"]
    mode = access["mode"]
    firewall = answers["firewall"]
    options = answers["options"]
    problems: list[Problem] = []
    warnings: list[Problem] = []

    subnets = list(firewall["lan_subnets"]) or lan_networks(_text_list(environment.get("lan_cidrs")))
    ufw_active = _flag(environment.get("ufw_active"))
    # A firewall this installer switched on is not "somebody's decision": the rules that
    # keep the machine reachable are still ours to write when the shape changes.
    foreign_firewall = ufw_active and not _flag(environment.get("ufw_enabled_by_installer"))
    manage = bool(firewall["manage"]) and mode != "local"
    # Another firewall already filters this machine (an nftables rule set of its own, firewalld).
    # ufw on top of it would add a second "drop everything else" that every packet has to pass
    # as well: services that firewall lets in would stop answering. It stays the owner's: the
    # plan says which ports to open in it, and ufw is neither installed nor switched on.
    other_firewall = "" if ufw_active else str(environment.get("foreign_firewall") or "").strip()
    if manage and other_firewall:
        manage = False
        if mode == "vps":
            warnings.append(problem("plan.firewall_foreign_vps", other_firewall, ", ".join(access["vps_addresses"])))
        elif mode == "lan":
            warnings.append(problem("plan.firewall_foreign_lan", other_firewall))
        else:
            warnings.append(problem("plan.firewall_foreign_direct", other_firewall))
    rules: list[list[str]] = []
    if manage:
        if mode in {"lan", "vps"} and not subnets and (mode == "lan" or access["allow_lan"]):
            problems.append(problem("plan.lan_unknown"))
        ssh_ports = [int(port) for port in _text_list(environment.get("ssh_ports")) if str(port).isdigit()]
        ssh_peers = _text_list(environment.get("ssh_peers"))
        # Without a VPS address there is no rule to write yet; the answers are refused for that elsewhere.
        if mode != "vps" or access["vps_addresses"]:
            rules = firewall_rules(
                mode=mode,
                vps_addresses=access["vps_addresses"],
                allow_lan=bool(access["allow_lan"]),
                lan_subnets=subnets,
                ssh_ports=ssh_ports or [22],
                ssh_client=str(environment.get("ssh_client") or ""),
                ufw_active=foreign_firewall,
                trust_lan=bool(firewall["trust_lan"]),
                extra_ports=firewall["extra_ports"],
                ssh_peers=ssh_peers,
            )
        if not ufw_active:
            # Switching the firewall on closes whatever else answers the network. Behind a VPS
            # and on a home network, a trusted home network still reaches all of it.
            lan_only = mode in {"lan", "vps"} and bool(subnets) and bool(firewall["trust_lan"])
            extra = set(firewall["extra_ports"])
            for listener in _text_list(environment.get("listeners")):
                if listener in extra or listener in DHCP_CLIENT_PORTS:
                    continue
                warnings.append(problem("plan.listener_lan_only" if lan_only else "plan.listener_closed", listener))
        if not foreign_firewall and mode in {"lan", "vps"} and subnets:
            client = str(environment.get("ssh_client") or "").strip()
            peers = [address for address in dict.fromkeys(map(usable_address, ssh_peers)) if address]
            if client and not usable_address(client):
                # `who am i` named no address (a local console, tmux, mosh): whether this session
                # comes from outside the home network is unknown, so say what the firewall will allow.
                warnings.append(problem("plan.ssh_client_unknown", client, ", ".join(subnets)))
            elif usable_address(client) and not _inside(usable_address(client), subnets):
                warnings.append(problem("plan.ssh_client_only", usable_address(client)))
            elif not client and [peer for peer in peers if not _inside(peer, subnets)]:
                outside = [peer for peer in peers if not _inside(peer, subnets)]
                warnings.append(problem("plan.ssh_peers", ", ".join(outside)))

    other_https = _text_list(environment.get("https_sites"))
    disable_sites: list[str] = []
    if mode == "vps" and other_https:
        # The home host answers under a neutral name, so a request for the public name
        # lands on whichever 443 host Apache read first — which must be ours.
        if access["disable_existing_https"]:
            disable_sites += other_https
        else:
            problems.append(problem("plan.https_conflict", ", ".join(other_https)))
    if mode in {"lan", "local"} and _flag(environment.get("default_site_enabled")):
        # Debian's default site is read first and would answer every request made by address.
        disable_sites.append("000-default")
    if mode in {"lan", "local"}:
        # Somebody's own site on port 80, read before ours (Apache reads sites-enabled in name
        # order): it answers http://<address>/ instead of the application. Not ours to switch
        # off - said, with the way out (audit P3-19).
        for name in _text_list(environment.get("http_sites")):
            if name < HTTP_SITE:
                warnings.append(problem("plan.http_site_first", name))

    has_build = _flag(environment.get("has_build"))
    has_sources = _flag(environment.get("has_sources"))
    # A clone is built from its sources every time: a build left in it is the interface of an
    # older pull. A release package carries the build and no sources, and never pulls Node in.
    build_frontend = bool(options["build_frontend"]) and (has_sources or not has_build)
    if not has_build and not build_frontend:
        problems.append(problem("plan.no_build"))
    elif has_sources and not build_frontend:
        warnings.append(problem("plan.stale_build"))

    certificate = {"kind": access["certificate"], "file": "", "key": ""}
    if mode == "vps":
        certificate.update(file=ORIGIN_CERT, key=ORIGIN_KEY)
    elif mode == "direct":
        host = access["host_name"]
        if access["certificate"] == "letsencrypt":
            certificate.update(
                file=f"/etc/letsencrypt/live/{host}/fullchain.pem", key=f"/etc/letsencrypt/live/{host}/privkey.pem"
            )
        elif access["certificate"] == "selfsigned":
            certificate.update(file=SELF_CERT, key=SELF_KEY)
        else:
            certificate.update(file=access["certificate_file"], key=access["key_file"])

    lan_address = str(environment.get("lan_address") or "")
    addresses: list[dict[str, str]] = []
    if mode == "local":
        addresses.append({"kind": "local", "url": "http://localhost/"})
    elif mode == "lan":
        addresses.append({"kind": "lan", "url": f"http://{lan_address or 'ADRES-W-SIECI-DOMOWEJ'}/"})
        addresses.append({"kind": "local", "url": "http://localhost/"})
    else:
        addresses.append({"kind": "public", "url": f"https://{access['host_name']}/"})
        if mode == "vps" and access["allow_lan"] and lan_address:
            addresses.append({"kind": "lan_secure", "url": f"https://{lan_address}/"})

    sites = [HTTP_SITE, HTTPS_SITE] if mode == "direct" else [HTTPS_SITE] if mode == "vps" else [HTTP_SITE]
    php_fpm = php_fpm_version(environment.get("php_fpm"))
    return {
        "mode": mode,
        "letter": LETTERS[mode],
        "packages": packages(
            mode,
            certificate=access["certificate"],
            fail2ban=bool(options["fail2ban"]),
            manage_firewall=manage,
            # Node and npm already there (Debian's, or NodeSource's, whose nodejs carries npm and
            # conflicts with Debian's npm package): built with those, nothing installed beside them.
            build_frontend=build_frontend and not _flag(environment.get("has_node")),
            php_fpm=php_fpm,
        ),
        "php_fpm": php_fpm,
        "modules": apache_modules(mode, php_fpm=php_fpm),
        "config": access_values(mode, access["host_name"], access["vps_addresses"]),
        "sites": sites,
        "retired_sites": [site for site in (HTTP_SITE, HTTPS_SITE) if site not in sites],
        "disable_sites": disable_sites,
        "certificate": certificate,
        "firewall": {
            "manage": manage,
            "enable": manage and not ufw_active,
            "rules": [" ".join(rule) for rule in rules],
            "subnets": subnets,
        },
        "fail2ban": bool(options["fail2ban"]) and mode == "direct",
        "build_frontend": build_frontend,
        "addresses": addresses,
        "migrate_user": migrate_user(answers["database"]["user"]),
        "problems": problems,
        "warnings": warnings,
    }


def _flag(value: object) -> bool:
    if isinstance(value, bool):
        return value
    return str(value or "").strip().lower() in {"1", "true", "yes", "tak"}


def _text_list(value: object) -> list[str]:
    if value is None or value == "":
        return []
    if isinstance(value, str):
        return [part for part in re.split(r"[\s,]+", value.strip()) if part]
    if isinstance(value, Sequence):
        return [str(item) for item in value if str(item)]
    return []


# -- files the installer puts into the system ------------------------------------------------------


def marked(text: str) -> str:
    """A system file as this installer writes it: LF, and the marker where a reader of the format allows it."""
    body = text.replace("\r\n", "\n").replace("\r", "\n")
    if not body.endswith("\n"):
        body += "\n"
    if MARKER_TEXT in body:
        return body
    if body.startswith("#!"):
        first, _newline, rest = body.partition("\n")
        return f"{first}\n{MARKER_LINE}\n{rest}"
    return f"{MARKER_LINE}\n{body}"


def is_marked(text: str) -> bool:
    return MARKER_TEXT in text


RENEW_HOOK_TEXT = (
    "#!/bin/sh\n"
    f"{MARKER_LINE}\n"
    "# Po każdym odnowieniu certyfikatu Let's Encrypt Apache musi wczytać go od nowa.\n"
    "systemctl reload apache2\n"
)


# -- the state file ----------------------------------------------------------------------------

STATE_VERSION = 1
# Lists that grow: what an earlier run switched or wrote is still ours after a later one.
_ACCUMULATED = ("files", "modules_enabled", "packages_installed")


def merge_state(previous: Mapping[str, Any] | None, update: Mapping[str, Any], *, now: str) -> dict[str, Any]:
    """What the installer wrote or switched, so that a later run — or an uninstall — can find it. No secrets."""
    state: dict[str, Any] = dict(previous or {})
    for key, value in update.items():
        if key in _ACCUMULATED:
            merged = [*state.get(key, []), *value]
            state[key] = list(dict.fromkeys(str(item) for item in merged if item))
        elif isinstance(value, Mapping) and isinstance(state.get(key), Mapping):
            state[key] = {**state[key], **value}
        else:
            state[key] = value
    state["managed_by"] = MARKER_TEXT
    state["version"] = STATE_VERSION
    state["platform"] = "debian"
    state.setdefault("installed_at", now)
    state["updated_at"] = now
    for forbidden in ("password", "transfer_key", "secret"):
        if _mentions(state, forbidden):
            raise ValueError(f"Stan instalacji nie może zawierać pola „{forbidden}”")
    return state


def _mentions(value: object, word: str) -> bool:
    if isinstance(value, Mapping):
        return any(word in str(key).lower() or _mentions(item, word) for key, item in value.items())
    if isinstance(value, (list, tuple)):
        return any(_mentions(item, word) for item in value)
    return False


def read_state(path: str | Path) -> dict[str, Any] | None:
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict) or data.get("managed_by") != MARKER_TEXT:
        return None
    return data


def write_private(path: Path, text: str, mode: int = 0o600) -> None:
    """Write ``text`` so that the file never exists with wider permissions than ``mode`` — not even for a moment."""
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, mode)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(text)
        if os.name != "nt":
            os.chmod(temporary, mode)
        os.replace(temporary, path)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise
