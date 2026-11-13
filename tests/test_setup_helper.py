"""The wizard's text work (``installer/setup_helper``): the private TOML, Apache files, the VPS bundle.

The Windows wizard is a window over these functions. What it promises on its
summary page — "your other settings stay", "this file can be undone", "the VPS
accepts only your certificate" — is promised here, so it is tested here.
"""
from __future__ import annotations

import argparse
import datetime
import json
import subprocess
import sys
import tomllib
from pathlib import Path

import pytest
from test_apache_examples import BROAD_OPEN, NARROW_DENY, _internal_routes

from installer.setup_helper import apacheconf, naming, tomledit, vpsbundle
from installer.setup_helper import cli as helper_cli
from media_server.config import load_config
from scripts import install

PROJECT_ROOT = Path(__file__).resolve().parents[1]
WAMP_EXAMPLE = PROJECT_ROOT / "deploy" / "apache" / "media-next-stage-wamp.conf.example"
VPS_TEMPLATES = PROJECT_ROOT / "installer" / "templates" / "vps"


# -- the private configuration ---------------------------------------------------------------


def _generated_config(tmp_path: Path, **overrides: object) -> str:
    """A configuration exactly as ``scripts/install.py`` writes it."""
    (tmp_path / "music").mkdir(exist_ok=True)
    (tmp_path / "films").mkdir(exist_ok=True)
    args = argparse.Namespace(
        port=8765, db_host="127.0.0.1", db_port=3306, db_name="media_server", db_user="media_server",
        ffmpeg_path="ffmpeg", base_url=None, proxy_trusted=None,
    )
    for key, value in overrides.items():
        setattr(args, key, value)
    return install._build_config(
        args, {"music": tmp_path / "music", "films": tmp_path / "films"}, "database-secret-value",
        tmp_path / "runtime" / "thumbnails", tmp_path / "runtime" / "subtitles",
    )


HAND_EDITED_TAIL = """
# Poczta — dopisane ręcznie przez właściciela.
[mail]
host = "smtp.example.org"
port = 587
password = "mail-secret-value"   # nie ruszać

[session]
name = "MOJASESJA"
"""


def test_public_values_are_added_without_touching_anything_else(tmp_path: Path) -> None:
    before = _generated_config(tmp_path)
    after = tomledit.set_values(before, "app", {"base_url": "https://media.example.org/"})
    after = tomledit.set_values(after, "proxy", {"trusted": "203.0.113.10"})

    old, new = tomllib.loads(before), tomllib.loads(after)
    assert new["app"] == {"base_url": "https://media.example.org/"}
    assert new["proxy"] == {"trusted": "203.0.113.10"}
    assert {k: v for k, v in new.items() if k not in {"app", "proxy"}} == old
    # New tables go in front of the media roots, which close the file as the generator wrote them.
    assert after.index("[app]") < after.index("[roots.") and after.index("[proxy]") < after.index("[roots.")
    # Every line of the original is still there, in order.
    remaining = iter(after.splitlines())
    assert all(any(line == candidate for candidate in remaining) for line in before.splitlines() if line.strip())


def test_a_value_is_replaced_in_place_and_a_removed_table_takes_its_comment_along(tmp_path: Path) -> None:
    text = _generated_config(tmp_path, base_url="https://old.example.org/", proxy_trusted="203.0.113.10")
    assert "# Adresy proxy" in text

    changed = tomledit.set_values(text, "app", {"base_url": "https://new.example.org/"})
    assert changed.count("[app]") == 1 and 'base_url = "https://new.example.org/"' in changed
    assert "old.example.org" not in changed

    gone = tomledit.set_values(changed, "proxy", {"trusted": None})
    assert "[proxy]" not in gone and "# Adresy proxy" not in gone
    assert "proxy" not in tomllib.loads(gone)
    assert "\n\n\n" not in gone
    # Removing what is not there is not an error and changes nothing.
    assert tomledit.set_values(gone, "proxy", {"trusted": None}) == gone


def test_the_http_exception_is_one_key_and_keeps_the_owners_session_name(tmp_path: Path) -> None:
    text = _generated_config(tmp_path) + HAND_EDITED_TAIL
    relaxed = tomledit.set_values(text, "session", {"require_https": False})
    assert tomllib.loads(relaxed)["session"] == {"name": "MOJASESJA", "require_https": False}
    restored = tomledit.set_values(relaxed, "session", {"require_https": None})
    assert tomllib.loads(restored)["session"] == {"name": "MOJASESJA"}
    assert "# nie ruszać" in restored and "# Poczta — dopisane ręcznie" in restored


def test_media_folders_are_replaced_and_hand_written_sections_survive(tmp_path: Path) -> None:
    before = _generated_config(tmp_path) + HAND_EDITED_TAIL
    after = tomledit.replace_roots(before, [("muzyka", r"E:\Muzyka"), ("filmy_video", r"E:\Filmy Video")])

    old, new = tomllib.loads(before), tomllib.loads(after)
    assert new["roots"] == {"muzyka": {"path": r"E:\Muzyka"}, "filmy_video": {"path": r"E:\Filmy Video"}}
    assert {k: v for k, v in new.items() if k != "roots"} == {k: v for k, v in old.items() if k != "roots"}
    assert "# Poczta — dopisane ręcznie przez właściciela." in after
    assert "[roots.music]" not in after and "[roots.films]" not in after
    # The server's own loader agrees (its roots must exist, so use real folders).
    real = tomledit.replace_roots(before, [("muzyka", str(tmp_path / "music"))])
    target = tmp_path / "config.local.toml"
    target.write_text(real, encoding="utf-8")
    assert list(load_config(target).roots) == ["muzyka"]


@pytest.mark.parametrize(
    ("roots", "message"),
    [
        ([], "co najmniej jedno"),
        ([("Music", "E:\\M")], "identyfikator"),
        ([("music", "E:\\M"), ("music", "E:\\N")], "dwa razy"),
        ([("music", "Muzyka")], "bezwzględna"),
    ],
)
def test_impossible_folder_lists_are_refused(tmp_path: Path, roots: list[tuple[str, str]], message: str) -> None:
    with pytest.raises(tomledit.TomlEditError, match=message):
        tomledit.replace_roots(_generated_config(tmp_path), roots)


def test_an_edit_that_would_change_something_else_is_refused(tmp_path: Path) -> None:
    # A root written as a dotted key outside any [roots.*] table: a line editor
    # cannot remove it, and the comparison notices instead of leaving two truths.
    odd = 'roots.old.path = "E:/Stare"\n' + _generated_config(tmp_path)
    with pytest.raises(tomledit.TomlEditError):
        tomledit.replace_roots(odd, [("music", "E:\\Muzyka")])
    with pytest.raises(tomledit.TomlEditError, match="wieloliniowe"):
        tomledit.set_values('[mail]\nnote = """a\nb"""\n', "app", {"base_url": "/"})
    with pytest.raises(tomledit.TomlEditError, match="nie jest poprawnym TOML"):
        tomledit.set_values("[app\n", "app", {"base_url": "/"})


def test_the_file_is_backed_up_privately_and_rewritten_in_place(tmp_path: Path) -> None:
    config = tmp_path / "config.local.toml"
    original = _generated_config(tmp_path).replace("\n", "\r\n")
    config.write_bytes(original.encode("utf-8"))
    private: list[Path] = []

    def write_private(path: Path, text: str) -> None:
        private.append(path)
        path.write_text(text, encoding="utf-8", newline="")

    preview = tomledit.apply_edit(
        config, lambda text: tomledit.set_values(text, "app", {"base_url": "https://media.example.org/"}),
        write_private=write_private, dry_run=True,
    )
    assert preview["changed"] is True and preview["backup"] is None
    assert preview["changes"] == ['[app] base_url = "https://media.example.org/"']
    assert config.read_bytes() == original.encode("utf-8") and private == []

    report = tomledit.apply_edit(
        config, lambda text: tomledit.set_values(text, "app", {"base_url": "https://media.example.org/"}),
        write_private=write_private, now=datetime.datetime(2026, 11, 12, 10, 30, 0),
    )
    backup = tmp_path / "config.backup-20261112-103000.local.toml"
    assert report["backup"] == str(backup) and private == [backup]
    assert backup.read_bytes() == original.encode("utf-8")
    written = config.read_bytes()
    # The file keeps its line endings, and nothing in the report is a secret.
    assert b"\r\n" in written and b"\n" not in written.replace(b"\r\n", b"")
    assert "database-secret-value" not in json.dumps(report)

    again = tomledit.apply_edit(
        config, lambda text: tomledit.set_values(text, "app", {"base_url": "https://media.example.org/"}),
        write_private=write_private,
    )
    assert again["changed"] is False and again["backup"] is None and private == [backup]

    # Text that differs but means the same - the same folders, their tables merely moved - is left
    # alone: no copy and no rewrite of the live file (audit P3-1).
    before_noop = config.read_bytes()
    same = tomledit.apply_edit(config, lambda text: text + "\r\n# moved\r\n", write_private=write_private)
    assert same["changed"] is False and same["changes"] == [] and same["backup"] is None
    assert config.read_bytes() == before_noop and private == [backup]


def test_what_the_wizard_may_show_contains_no_secret(tmp_path: Path) -> None:
    shown = tomledit.summary(_generated_config(tmp_path, base_url="https://media.example.org/") + HAND_EDITED_TAIL)
    dumped = json.dumps(shown)
    assert "database-secret-value" not in dumped and "mail-secret-value" not in dumped
    assert "transfer_key" not in dumped and "password" not in dumped
    assert shown["database"] == {"host": "127.0.0.1", "port": 3306, "name": "media_server", "user": "media_server"}
    assert shown["base_url"] == "https://media.example.org/" and shown["mail_configured"] is True
    assert [root["id"] for root in shown["roots"]] == ["films", "music"]


# -- the alias file --------------------------------------------------------------------------


def _render(**overrides: object) -> str:
    conf = apacheconf.WampConf(**{"root": r"C:\TryHackX\MediaServer", **overrides})  # type: ignore[arg-type]
    return apacheconf.render_wamp_conf(WAMP_EXAMPLE.read_text(encoding="utf-8"), conf)


def _directives(text: str) -> list[str]:
    return [line.strip() for line in text.splitlines() if line.strip() and not line.strip().startswith("#")]


CERTS = {"certificate_file": r"C:\TryHackX\MediaServer\config\origin\origin-cert.pem",
         "certificate_key_file": r"C:\TryHackX\MediaServer\config\origin\origin-key.pem"}
ALL_MODES = [
    {"mode": "local"},
    {"mode": "lan"},
    {"mode": "direct", "host_name": "media.example.org", **CERTS, "add_listen_443": True},
    {"mode": "vps", "vps_addresses": ("203.0.113.10", "2001:db8::10"), **CERTS, "add_listen_443": True},
    {"mode": "vps", "vps_addresses": ("203.0.113.10",), "allow_lan": True, **CERTS},
]


@pytest.mark.parametrize("options", ALL_MODES, ids=lambda o: o["mode"] + ("+lan" if o.get("allow_lan") else ""))
def test_every_generated_file_keeps_the_examples_guarantees(options: dict[str, object]) -> None:
    text = _render(service_port=8766, **options)
    lines = text.splitlines()

    assert lines[0].startswith(apacheconf.MANAGED_MARKER)
    assert _directives(text).count('Define TRYHACKX_MEDIA_ROOT "C:/TryHackX/MediaServer"') == 1
    assert "C:/wamp64/media-server" not in text
    # The service port is the configured one in both proxy lines, and nowhere the default.
    assert text.count("http://127.0.0.1:8766/") == 2 and ":8765" not in text
    # The order that decides whether the internal routes are closed (tests/test_apache_examples.py).
    deny = next(i for i, line in enumerate(lines) if NARROW_DENY.search(line))
    broad = next(i for i, line in enumerate(lines) if BROAD_OPEN.search(line))
    assert deny > broad
    for route in ["health", *_internal_routes()]:
        assert route in lines[deny]
    assert 'Header always set Cache-Control "no-store" "expr=-z %{resp:Cache-Control}"' in _directives(text)
    # Loopback HTTP stays possible in every shape: that is how the owner opens http://localhost/.
    assert 'SetEnv TRYHACKX_BRIDGE_ALLOW_HTTP_LOCAL "1"' in _directives(text)


def test_localhost_only_opens_nothing_to_anybody_else() -> None:
    directives = _directives(_render(mode="local"))
    assert "Require all granted" not in directives
    assert directives.count("Require local") == 4
    assert not any(line.startswith(("Require ip", "<VirtualHost", "Listen", "SSL")) for line in directives)


def test_the_home_network_shape_admits_private_addresses_only() -> None:
    directives = _directives(_render(mode="lan"))
    assert "Require all granted" not in directives
    assert directives.count("Require ip " + " ".join(apacheconf.PRIVATE_RANGES)) == 4
    assert not any(line.startswith(("<VirtualHost", "Listen")) for line in directives)


def test_behind_a_vps_only_the_vps_is_admitted_and_the_public_name_appears_nowhere() -> None:
    text = _render(mode="vps", vps_addresses=("203.0.113.10", "2001:db8::10"), host_name="media.example.org",
                   **CERTS, add_listen_443=True)
    directives = _directives(text)
    assert "Require all granted" not in directives
    assert directives.count("Require ip 203.0.113.10 2001:db8::10") == 4
    assert not any("192.168.0.0/16" in line for line in directives)
    assert directives.count("Listen 443") == 1
    assert f"ServerName {apacheconf.ORIGIN_SERVER_NAME}" in directives
    assert 'SSLCertificateFile "C:/TryHackX/MediaServer/config/origin/origin-cert.pem"' in directives
    # A scanner that reaches the home address must not learn whose server it is.
    assert "media.example.org" not in text
    assert not any("Strict-Transport-Security" in line for line in directives)

    with_lan = _directives(_render(mode="vps", vps_addresses=("203.0.113.10",), allow_lan=True, **CERTS))
    assert "Listen 443" not in with_lan
    assert with_lan.count("Require ip " + " ".join(apacheconf.PRIVATE_RANGES)) == 4


def test_a_directly_exposed_host_redirects_plain_http_and_sends_hsts() -> None:
    directives = _directives(_render(mode="direct", host_name="Media.Example.ORG.", **CERTS, add_listen_443=True))
    assert directives.count("Require all granted") == 4
    assert directives.count("ServerName media.example.org") == 2
    assert 'RedirectMatch permanent "^/(.*)$" "https://media.example.org/$1"' in directives
    assert 'Header always set Strict-Transport-Security "max-age=31536000"' in directives


@pytest.mark.parametrize(
    ("options", "message"),
    [
        ({"mode": "vps", **CERTS}, "adresu VPS"),
        ({"mode": "vps", "vps_addresses": ("vps.example.org",), **CERTS}, "nie jest adresem IP"),
        ({"mode": "direct", "host_name": "media", **CERTS}, "nazwą hosta"),
        ({"mode": "direct", "host_name": "media.example.org"}, "certyfikatu"),
        ({"mode": "local", "root": 'C:\\a"b'}, "Ścieżki nie da się"),
        ({"mode": "local", "service_port": 70000}, "Port usługi"),
        ({"mode": "everyone"}, "Nieznany tryb"),
    ],
)
def test_a_file_that_cannot_be_right_is_not_generated(options: dict[str, object], message: str) -> None:
    with pytest.raises(apacheconf.ApacheConfError, match=message):
        _render(**options)


def test_a_changed_example_is_noticed_rather_than_half_translated() -> None:
    template = WAMP_EXAMPLE.read_text(encoding="utf-8")
    conf = apacheconf.WampConf(root="C:/x")
    with pytest.raises(apacheconf.ApacheConfError, match="Define"):
        apacheconf.render_wamp_conf(template.replace("Define TRYHACKX_MEDIA_ROOT", "Define OTHER"), conf)
    extra = template + '\n<Location "/new-route">\n    Require all granted\n</Location>\n'
    with pytest.raises(apacheconf.ApacheConfError, match="oczekiwano 4"):
        apacheconf.render_wamp_conf(extra, conf)
    with pytest.raises(apacheconf.ApacheConfError, match="trasy transferu"):
        apacheconf.render_wamp_conf(template.replace("127.0.0.1:8765", "localhost:8765"), conf)


def test_modules_follow_the_shape() -> None:
    assert "ssl_module" not in apacheconf.required_modules("local")
    assert {"ssl_module", "socache_shmcb_module", "proxy_http_module", "headers_module"} <= set(
        apacheconf.required_modules("vps")
    )


# -- WAMP's own files ------------------------------------------------------------------------

STOCK_VHOSTS = """# Virtual Hosts
#
<VirtualHost _default_:80>
  ServerName localhost
  ServerAlias localhost
  DocumentRoot "${INSTALL_DIR}/www"
  <Directory "${INSTALL_DIR}/www/">
    Options +Indexes +Includes +FollowSymLinks +MultiViews
    AllowOverride All
    Require local
  </Directory>
</VirtualHost>

<VirtualHost *:80>
  ServerName shop.localhost
  DocumentRoot "c:/wamp64/www/shop"
</VirtualHost>
""".replace("\n", "\r\n")

SECURE_HOST = """
<VirtualHost _default_:443>
    ServerName old.example.org
    DocumentRoot "C:/somewhere"
    SSLEngine on
</VirtualHost>
""".replace("\n", "\r\n")


def test_the_local_host_is_pointed_at_the_application_and_can_be_pointed_back() -> None:
    changed, info = apacheconf.set_document_root(STOCK_VHOSTS, r"C:\TryHackX\MediaServer\public\assets\build")

    assert info == {"server_name": "localhost", "previous": "${INSTALL_DIR}/www", "managed": False, "changed": True}
    hosts = apacheconf.find_virtual_hosts(changed)
    assert hosts[0].document_root == "C:/TryHackX/MediaServer/public/assets/build"
    assert hosts[1].document_root == "c:/wamp64/www/shop"
    assert apacheconf.DOCROOT_MARKER + ' DocumentRoot "${INSTALL_DIR}/www"' in changed
    assert "\r\n" in changed and "\n" not in changed.replace("\r\n", "")
    # What goes into WAMP's file is ASCII: its encoding is not ours to know.
    assert changed.isascii()

    # Moving the installation updates the line and still remembers the ORIGINAL value.
    moved, info = apacheconf.set_document_root(changed, "D:/Media/public/assets/build")
    assert info["managed"] is True and info["changed"] is True
    assert moved.count(apacheconf.DOCROOT_MARKER) == 1
    assert apacheconf.find_virtual_hosts(moved)[0].document_root == "D:/Media/public/assets/build"

    restored, did = apacheconf.restore_document_root(moved)
    assert did is True and restored == STOCK_VHOSTS
    assert apacheconf.restore_document_root(STOCK_VHOSTS) == (STOCK_VHOSTS, False)


def test_a_host_somebody_already_pointed_here_by_hand_is_left_alone() -> None:
    by_hand = STOCK_VHOSTS.replace('"${INSTALL_DIR}/www"\r\n  <Directory', '"C:/wamp64/media-server/public/assets/build"\r\n  <Directory')
    text, info = apacheconf.set_document_root(by_hand, r"c:\wamp64\media-server\public\assets\build")
    assert text == by_hand and info["changed"] is False and info["adopted"] is True


def test_without_a_host_on_port_80_nothing_is_guessed() -> None:
    with pytest.raises(apacheconf.ApacheConfError, match="porcie 80"):
        apacheconf.set_document_root(SECURE_HOST, "C:/x")
    # A commented-out host is not a host.
    commented = "\r\n".join("#" + line for line in STOCK_VHOSTS.split("\r\n"))
    with pytest.raises(apacheconf.ApacheConfError):
        apacheconf.set_document_root(commented, "C:/x")


def test_an_existing_https_host_is_switched_off_reversibly() -> None:
    text = STOCK_VHOSTS + SECURE_HOST
    off, names = apacheconf.comment_out_hosts(text, 443)
    assert names == ["old.example.org"]
    assert [host.ports for host in apacheconf.find_virtual_hosts(off)] == [(80,), (80,)]
    back, did = apacheconf.restore_commented_hosts(off)
    assert did is True and back == text
    assert apacheconf.comment_out_hosts(STOCK_VHOSTS, 443) == (STOCK_VHOSTS, [])


HTTPD_CONF = """ServerRoot "${SRVROOT}"
Listen 0.0.0.0:80
Listen [::0]:80
LoadModule alias_module modules/mod_alias.so
#LoadModule headers_module modules/mod_headers.so
  # LoadModule proxy_module modules/mod_proxy.so
#LoadModule ssl_module modules/mod_ssl.so
LoadModule ssl_module modules/mod_ssl.so
#LoadModule php_module "${INSTALL_DIR}/bin/php/php8.2.0/php8apache2_4.dll"
"""


def test_modules_are_switched_on_by_uncommenting_their_own_line() -> None:
    text, report = apacheconf.enable_modules(
        HTTPD_CONF, ["alias_module", "headers_module", "proxy_module", "ssl_module", "proxy_http_module"]
    )
    assert report == {
        "enabled": ["headers_module", "proxy_module"],
        "already": ["alias_module", "ssl_module"],
        "missing": ["proxy_http_module"],
    }
    assert "\nLoadModule headers_module modules/mod_headers.so\n" in text
    assert "\n  LoadModule proxy_module modules/mod_proxy.so\n" in text
    # Nothing else moved: the commented duplicate and the other lines are as they were.
    assert text.count("#LoadModule ssl_module") == 1 and "#LoadModule php_module" in text
    assert len(text.splitlines()) == len(HTTPD_CONF.splitlines())


def test_a_listener_is_found_in_any_of_its_spellings() -> None:
    assert apacheconf.listens_on([HTTPD_CONF], 80) is True
    assert apacheconf.listens_on([HTTPD_CONF], 443) is False
    assert apacheconf.listens_on([HTTPD_CONF, "  Listen 443 https\n"], 443) is True
    assert apacheconf.listens_on(["Listen 203.0.113.10:443\n"], 443) is True
    assert apacheconf.listens_on(["#Listen 443\n"], 443) is False


def test_an_alias_file_says_whose_it_is() -> None:
    assert apacheconf.managed_root(WAMP_EXAMPLE.read_text(encoding="utf-8")) == ("C:/wamp64/media-server", False)
    assert apacheconf.managed_root(_render(mode="local")) == ("C:/TryHackX/MediaServer", True)
    assert apacheconf.managed_root('Alias /adminer "c:/wamp64/apps/adminer/"') == (None, False)


# -- the VPS bundle --------------------------------------------------------------------------


@pytest.fixture(scope="module")
def origin_certificate() -> str:
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.x509.oid import NameOID

    key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "TryHackX Media Origin")])
    start = datetime.datetime(2026, 1, 1, tzinfo=datetime.UTC)
    certificate = (
        x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key())
        .serial_number(x509.random_serial_number()).not_valid_before(start)
        .not_valid_after(start + datetime.timedelta(days=3650))
        .sign(key, hashes.SHA256())
    )
    return certificate.public_bytes(serialization.Encoding.PEM).decode("ascii")


def _bundle(origin_certificate: str, **overrides: object) -> dict[str, str]:
    options: dict[str, object] = {
        "host_name": "media.example.org", "home_address": "198.51.100.7", "vps_addresses": ["203.0.113.10"],
        "lan_address": "192.168.1.20", "bundle_dir": r"C:\TryHackX\MediaServer\runtime\vps-bundle",
        "certificate_pem": origin_certificate, "certificate_not_after": "2036-11-10", "generated": "2026-11-12",
    }
    options.update(overrides)
    values = vpsbundle.build_values(**options)  # type: ignore[arg-type]
    return vpsbundle.render_bundle(VPS_TEMPLATES, values, origin_certificate)


def test_the_bundle_is_complete_and_has_no_blank_to_fill_in(origin_certificate: str) -> None:
    files = _bundle(origin_certificate)
    assert sorted(files) == ["INSTRUKCJA-VPS.md", "VPS-GUIDE.md", "maintenance.html", "origin.crt",
                             "tryhackx-media-ssl.conf", "tryhackx-media.conf", "vps-setup.sh"]
    for name, text in files.items():
        assert "{{" not in text and "}}" not in text, name
    for guide in ("INSTRUKCJA-VPS.md", "VPS-GUIDE.md"):
        text = files[guide]
        for expected in ("media.example.org", "203.0.113.10", "192.168.1.20", "198.51.100.7", "2036-11-10",
                         "a2enmod proxy proxy_http ssl headers", "certbot certonly --webroot",
                         "a2ensite tryhackx-media-ssl", "apache2ctl configtest",
                         "| `A` | `media.example.org` | `203.0.113.10` |"):
            assert expected in text, (guide, expected)
        assert vpsbundle.certificate_fingerprint(origin_certificate) in text


def test_the_proxy_verifies_the_home_server_and_writes_the_headers_itself(origin_certificate: str) -> None:
    site = _directives(_bundle(origin_certificate)["tryhackx-media-ssl.conf"])

    assert "SSLProxyVerify require" in site and "SSLProxyVerify none" not in site
    assert "SSLProxyCACertificateFile /etc/apache2/tryhackx-media/origin.crt" in site
    assert "ProxyPreserveHost On" in site and "ProxyAddHeaders Off" in site
    assert 'RequestHeader set X-Forwarded-For "expr=%{REMOTE_ADDR}"' in site
    assert 'RequestHeader set X-Forwarded-Proto "https"' in site
    assert not any(line.startswith("RequestHeader") and " append " in line for line in site)
    # Replacing the application's own error answers would break the interface.
    assert not any(line.startswith("ProxyErrorOverride") for line in site)
    assert {"ErrorDocument 502 /maintenance.html", "ErrorDocument 503 /maintenance.html",
            "ErrorDocument 504 /maintenance.html", "ProxyPass /maintenance.html !"} <= set(site)

    passes = [line for line in site if line.startswith("ProxyPass ")]
    transfer = next(i for i, line in enumerate(passes) if line.startswith("ProxyPass /media-transfer/ "))
    catch_all = next(i for i, line in enumerate(passes) if line.startswith("ProxyPass / "))
    assert transfer < catch_all, "the long timeout must be matched before the catch-all"
    assert "timeout=3600" in passes[transfer] and "nocanon" in passes[transfer]
    assert passes[transfer].split()[2] == "https://198.51.100.7/media-transfer/"
    assert passes[catch_all].split()[2] == "https://198.51.100.7/"
    assert "ProxyPassReverse / https://198.51.100.7/" in site


def test_port_80_redirects_everything_but_the_certificate_challenge(origin_certificate: str) -> None:
    site = _directives(_bundle(origin_certificate)["tryhackx-media.conf"])
    assert "ServerName media.example.org" in site
    assert ('RedirectMatch permanent "^/(?!\\.well-known/acme-challenge/)(.*)$" "https://media.example.org/$1"'
            in site)
    assert not any(line.startswith("ProxyPass") for line in site)


def test_only_the_certificate_travels_never_a_key(origin_certificate: str) -> None:
    key_block = "-----BEGIN " + "PRIVATE KEY-----\nAAAA\n-----END " + "PRIVATE KEY-----\n"
    files = _bundle(origin_certificate, certificate_pem=key_block + origin_certificate)
    # render_bundle is handed the same text the wizard read from disk.
    values = vpsbundle.build_values(
        host_name="media.example.org", home_address="198.51.100.7", vps_addresses=["203.0.113.10"],
        lan_address="", bundle_dir="C:/b", certificate_pem=key_block + origin_certificate,
        certificate_not_after="", generated="",
    )
    files = vpsbundle.render_bundle(VPS_TEMPLATES, values, key_block + origin_certificate)
    assert files["origin.crt"] == origin_certificate.strip() + "\n"
    assert "PRIVATE KEY" not in "".join(files.values())


def test_the_fingerprint_is_the_one_openssl_prints(origin_certificate: str) -> None:
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes

    expected = x509.load_pem_x509_certificate(origin_certificate.encode()).fingerprint(hashes.SHA256()).hex().upper()
    printed = vpsbundle.certificate_fingerprint(origin_certificate)
    assert printed.replace(":", "") == expected and printed.count(":") == 31


@pytest.mark.parametrize(
    ("address", "target", "kind"),
    [
        ("198.51.100.7", "198.51.100.7", "ipv4"),
        (" 2001:db8::7 ", "[2001:db8::7]", "ipv6"),
        ("[2001:db8::7]", "[2001:db8::7]", "ipv6"),
        ("Dom.Example.ORG", "dom.example.org", "name"),
    ],
)
def test_the_home_address_is_written_the_way_a_url_needs_it(address: str, target: str, kind: str) -> None:
    assert vpsbundle.home_target(address) == (target, kind)


def test_a_dynamic_name_changes_the_advice_not_the_files(origin_certificate: str) -> None:
    files = _bundle(origin_certificate, home_address="dom.example.org", vps_addresses=["203.0.113.10", "2001:db8::10"])
    assert "ProxyPass / https://dom.example.org/ " in files["tryhackx-media-ssl.conf"]
    assert "systemctl reload apache2" in files["INSTRUKCJA-VPS.md"] and "dynamic DNS" in files["VPS-GUIDE.md"]
    assert "| `AAAA` | `media.example.org` | `2001:db8::10` |" in files["VPS-GUIDE.md"]


@pytest.mark.parametrize(
    ("overrides", "message"),
    [
        ({"home_address": "203.0.113.10"}, "dwie różne maszyny"),
        ({"home_address": "127.0.0.1"}, "nie jest adresem, pod którym"),
        ({"home_address": "not a host"}, "nie jest adresem IP ani nazwą"),
        ({"vps_addresses": []}, "co najmniej jeden adres VPS"),
        ({"vps_addresses": ["vps.example.org"]}, "nie jest adresem IP"),
        ({"certificate_pem": "nothing"}, "nie zawiera certyfikatu"),
        ({"lan_address": "{{DOMAIN}}"}, "Niedozwolone znaki"),
    ],
)
def test_a_bundle_that_could_not_work_is_refused(origin_certificate: str, overrides: dict[str, object], message: str) -> None:
    with pytest.raises((vpsbundle.BundleError, apacheconf.ApacheConfError), match=message):
        _bundle(origin_certificate, **overrides)


def test_the_bundle_is_written_for_linux(tmp_path: Path, origin_certificate: str) -> None:
    written = vpsbundle.write_bundle(tmp_path / "bundle", _bundle(origin_certificate))
    assert len(written) == 7
    for path in written:
        assert b"\r" not in Path(path).read_bytes(), path


# -- folder identifiers ----------------------------------------------------------------------


@pytest.mark.parametrize(
    ("path", "kind", "expected"),
    [
        (r"E:\Muzyka", "music", "muzyka"),
        (r"E:\Filmy Video", "movies", "filmy_video"),
        (r"D:\Zażółć gęślą jaźń", "mixed", "zazolc_gesla_jazn"),
        ("E:\\", "music", "music"),
        (r"D:\2024 Filmy", "movies", "movies_2024_filmy"),
        (r"D:\映画", "movies", "movies"),
        (r"\\nas\share\Media-Library (new)", "mixed", "media_library_new"),
        # Cut to fit the identifier's length, never ending in a separator.
        ("D:\\" + "bardzo długa nazwa katalogu z muzyką klasyczną", "music", "bardzo_dluga_nazwa_katalogu"),
    ],
)
def test_a_folder_gets_a_readable_legal_identifier(path: str, kind: str, expected: str) -> None:
    chosen = naming.root_id_for(path, kind, set())
    assert chosen == expected and naming.ROOT_ID.fullmatch(chosen)


def test_identifiers_are_unique_and_an_existing_library_keeps_its_own() -> None:
    existing = [{"id": "music", "path": "E:/Muzyka"}, {"id": "movies", "path": r"E:\Filmy Video"}]
    assigned = naming.assign_root_ids(
        [
            {"path": r"e:\muzyka" + "\\", "kind": "music"},          # the same folder, written differently
            {"path": r"F:\Filmy Video", "kind": "movies", "id": "movies"},  # moved with "change path": keeps its id
            {"path": r"G:\Muzyka", "kind": "music"},                 # a second folder with the same name
            {"path": r"H:\Movies", "kind": "movies"},
        ],
        existing,
    )
    assert [entry["id"] for entry in assigned] == ["music", "movies", "muzyka", "movies2"]


def test_a_new_folder_never_inherits_the_catalogue_of_a_removed_one() -> None:
    existing = [{"id": "muzyka", "path": r"E:\Muzyka"}]
    assigned = naming.assign_root_ids([{"path": r"F:\Muzyka", "kind": "music"}], existing)
    assert assigned == [{"id": "muzyka2", "path": r"F:\Muzyka", "kind": "music"}]
    with pytest.raises(ValueError, match="rodzaj"):
        naming.assign_root_ids([{"path": "E:\\x", "kind": "audio"}])


def test_a_library_removed_in_an_earlier_run_keeps_its_identifier_out_of_reach() -> None:
    # "filmy" left the configuration a run ago; the catalogue still has its rows (switched off).
    assigned = naming.assign_root_ids([{"path": r"F:\Nowe\Filmy", "kind": "movies"}], [], reserved_ids=["filmy"])
    assert assigned == [{"id": "filmy2", "path": r"F:\Nowe\Filmy", "kind": "movies"}]
    answer = helper_cli.assign_ids({"folders": [{"path": r"F:\Nowe\Filmy", "kind": "movies"}], "existing": [], "reserved": ["filmy"]})
    assert [entry["id"] for entry in answer["roots"]] == ["filmy2"]


# -- the helper as the wizard calls it ---------------------------------------------------------


def test_requests_are_answered_not_crashed_on(tmp_path: Path) -> None:
    assert helper_cli.run("no-such-command", {}) == {"ok": False, "error": "Nieznane polecenie: no-such-command"}
    missing = helper_cli.run("config-summary", {})
    assert missing["ok"] is False and "config" in missing["error"]
    refused = helper_cli.run("validate-access", {"host_name": "media", "vps_addresses": []})
    assert refused["ok"] is False and "nazwą hosta" in refused["error"]
    fine = helper_cli.run("validate-access", {"host_name": "Media.Example.org", "vps_addresses": ["203.0.113.10"],
                                              "home_address": "198.51.100.7"})
    assert fine == {"ok": True, "host_name": "media.example.org", "vps_addresses": ["203.0.113.10"],
                    "home_target": "198.51.100.7", "home_kind": "ipv4"}


def test_the_access_settings_reach_the_private_file_with_a_private_backup(tmp_path: Path) -> None:
    config = tmp_path / "config.local.toml"
    config.write_text(_generated_config(tmp_path) + HAND_EDITED_TAIL, encoding="utf-8")
    request = {"config": str(config), "project_root": str(PROJECT_ROOT), "base_url": "https://media.example.org/",
               "proxy_trusted": "203.0.113.10 , 2001:db8::10", "require_https": True}

    preview = helper_cli.run("config-access", {**request, "dry_run": True})
    assert preview["ok"] and preview["changed"] and preview["backup"] is None
    assert "[roots" not in "".join(preview["changes"])

    done = helper_cli.run("config-access", request)
    assert done["ok"] and Path(done["backup"]).is_file()
    data = tomllib.loads(config.read_text(encoding="utf-8"))
    assert data["app"] == {"base_url": "https://media.example.org/"}
    assert data["proxy"] == {"trusted": "203.0.113.10, 2001:db8::10"}
    assert data["session"] == {"name": "MOJASESJA"} and data["mail"]["host"] == "smtp.example.org"
    assert "secret" not in json.dumps(done)

    # Back to a home network without TLS: the two public values go, the exception comes.
    lan = helper_cli.run("config-access", {**request, "base_url": None, "proxy_trusted": None, "require_https": False})
    data = tomllib.loads(config.read_text(encoding="utf-8"))
    assert lan["ok"] and "app" not in data and "proxy" not in data
    assert data["session"] == {"name": "MOJASESJA", "require_https": False}

    bad = helper_cli.run("config-access", {**request, "proxy_trusted": "vps.example.org"})
    assert bad["ok"] is False and "nie jest adresem IP" in bad["error"]


def test_wamps_files_are_edited_byte_for_byte(tmp_path: Path) -> None:
    # A comment in a legacy code page: not UTF-8, and none of our business.
    original = b"# G\xe9n\xe9r\xe9 par Wampserver\r\n" + STOCK_VHOSTS.encode("ascii")
    source = tmp_path / "httpd-vhosts.conf"
    source.write_bytes(original)
    output = tmp_path / "out" / "httpd-vhosts.conf"

    answer = helper_cli.run("apache-vhosts-set", {
        "path": str(source), "document_root": r"C:\TryHackX\MediaServer\public\assets\build", "output": str(output),
    })
    assert answer["ok"] and answer["changed"] and answer["written"] == str(output)
    assert source.read_bytes() == original, "the original is the wizard's to replace, not the helper's"
    edited = output.read_bytes()
    assert edited.startswith(b"# G\xe9n\xe9r\xe9 par Wampserver\r\n")
    assert b'DocumentRoot "C:/TryHackX/MediaServer/public/assets/build"' in edited

    back = tmp_path / "back.conf"
    undone = helper_cli.run("apache-vhosts-restore", {"path": str(output), "output": str(back)})
    assert undone["ok"] and undone["restored_document_root"] and back.read_bytes() == original

    refused = helper_cli.run("apache-vhosts-set", {
        "path": str(source), "document_root": "C:\\Użytkownicy\\media\\build", "output": str(output),
    })
    assert refused["ok"] is False and "ASCII" in refused["error"]


def test_the_server_is_inspected_without_being_changed(tmp_path: Path) -> None:
    httpd = tmp_path / "httpd.conf"
    httpd.write_text(HTTPD_CONF, encoding="ascii")
    vhosts = tmp_path / "httpd-vhosts.conf"
    vhosts.write_bytes((STOCK_VHOSTS + SECURE_HOST).encode("ascii"))
    alias = tmp_path / "alias"
    alias.mkdir()
    (alias / "adminer.conf").write_text('Alias /adminer "c:/wamp64/apps/adminer/"\n', encoding="ascii")
    (alias / "media-next-stage.conf").write_text(WAMP_EXAMPLE.read_text(encoding="utf-8"), encoding="utf-8")
    ours = alias / "tryhackx-media-server.conf"
    ours.write_text(_render(mode="vps", vps_addresses=("203.0.113.10",), **CERTS, add_listen_443=True), encoding="utf-8")

    seen = helper_cli.run("apache-inspect", {"httpd_conf": str(httpd), "vhosts_conf": str(vhosts),
                                              "alias_dir": str(alias), "our_alias": str(ours)})
    assert seen["ok"] and seen["listen_443"] is False, "our own Listen must not count as somebody else's"
    assert [host["ports"] for host in seen["virtual_hosts"]] == [[80], [80], [443]]
    assert seen["virtual_hosts"][2]["server_name"] == "old.example.org"
    assert {(Path(a["file"]).name, a["managed"]) for a in seen["aliases"]} == {
        ("media-next-stage.conf", False), ("tryhackx-media-server.conf", True)}


def test_the_generated_alias_file_has_no_byte_order_mark(tmp_path: Path) -> None:
    output = tmp_path / "alias" / "tryhackx-media-server.conf"
    answer = helper_cli.run("apache-render", {
        "template": str(WAMP_EXAMPLE), "output": str(output),
        "conf": {"root": r"C:\TryHackX\MediaServer", "mode": "lan", "service_port": 8765},
    })
    assert answer["ok"] and answer["text"] is None and answer["access"][0] == "Require local"
    data = output.read_bytes()
    # Apache reads a BOM as the beginning of a directive and refuses to start.
    assert data.startswith(apacheconf.MANAGED_MARKER.encode("ascii"))
    assert b"\r\n" in data and b"\n" not in data.replace(b"\r\n", b"")


def test_the_helper_runs_isolated_the_way_the_wizard_starts_it() -> None:
    request = {"folders": [{"path": r"E:\Muzyka", "kind": "music"}, {"path": r"E:\Filmy Żółte", "kind": "movies"}]}
    result = subprocess.run(
        [sys.executable, "-I", "-X", "utf8", str(PROJECT_ROOT / "installer" / "helper.py"), "assign-ids"],
        input=json.dumps(request).encode("utf-8"), capture_output=True, timeout=60, check=False,
    )
    assert result.returncode == 0, result.stderr.decode("utf-8", "replace")
    answer = json.loads(result.stdout.decode("utf-8"))
    assert answer == {"ok": True, "roots": [
        {"id": "muzyka", "path": r"E:\Muzyka", "kind": "music"},
        {"id": "filmy_zolte", "path": r"E:\Filmy Żółte", "kind": "movies"},
    ]}
