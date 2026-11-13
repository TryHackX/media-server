"""The Debian installer (``zainstaluj-debian.sh``) as far as a test can reach it without a Debian.

Four kinds of check, from the cheapest up:

* **bytes and texts** — every script parses, stays ASCII where it must, ends its
  lines with LF; every sentence exists in both languages with the same places
  for values, and the code asks for no sentence that is not there;
* **decisions** (``installer/setup_helper``) — the answers-file parser, the plan
  of each shape, the Apache sites, the firewall rules, the SQL, the migration
  configuration, the state file, the VPS bundle with its script. Pure functions;
* **the certificate rule** — with a real OpenSSL: the certificate the installer
  asks for is a server certificate, and two of them under one name can be
  trusted at once (which is what a rotation without downtime stands on);
* **the scripts themselves**, against a stand-in machine (``debian_harness``):
  every shape as a dry run that must change nothing, then real runs whose
  commands, order and files are read back — install, change, undo on failure,
  resume, rotate, uninstall — and ``vps-setup.sh`` doing the same on its side.

What none of this can show — that Debian's own programs agree — is listed for
the owner in ``docs/TESTING.md``.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tomllib
from pathlib import Path

import pytest
from debian_harness import ENTRY, MUTATING, STUBS, Machine, find_bash
from test_apache_examples import BROAD_OPEN, NARROW_DENY, _internal_routes

from installer.setup_helper import answers, apacheconf, debian, flat, vpsbundle
from installer.setup_helper import cli as helper_cli
from scripts import install

PROJECT_ROOT = Path(__file__).resolve().parents[1]
INSTALLER = PROJECT_ROOT / "installer"
LIBRARIES = sorted((INSTALLER / "debian" / "lib").glob("*.sh"))
LANGUAGES = {name: INSTALLER / "debian" / "lang" / f"{name}.sh" for name in ("pl", "en")}
EXAMPLES = INSTALLER / "debian" / "examples"
VPS_TEMPLATES = INSTALLER / "templates" / "vps"
APACHE_EXAMPLES = PROJECT_ROOT / "deploy" / "apache"
SETUP_TEMPLATE = VPS_TEMPLATES / "vps-setup.sh.tmpl"
SHELL_CODE = [ENTRY, *LIBRARIES, SETUP_TEMPLATE, STUBS / "system-command.sh", STUBS / "release-stub.sh"]

NEXT_EXAMPLE = (APACHE_EXAMPLES / "media-next.conf.example").read_text(encoding="utf-8")
TRANSFER_EXAMPLE = (APACHE_EXAMPLES / "media-transfer.conf.example").read_text(encoding="utf-8")


def _directives(text: str) -> list[str]:
    return [line.strip() for line in text.splitlines() if line.strip() and not line.strip().startswith("#")]


# -- bytes ------------------------------------------------------------------------------------


def test_there_is_something_to_check() -> None:
    assert {path.name for path in LIBRARIES} == {"common.sh", "detect.sh", "flows.sh", "steps.sh", "ui.sh", "wizard.sh"}
    assert ENTRY.is_file() and SETUP_TEMPLATE.is_file() and all(path.is_file() for path in LANGUAGES.values())


@pytest.mark.parametrize("path", [*SHELL_CODE, *LANGUAGES.values()], ids=lambda p: p.name)
def test_shell_files_parse_and_end_their_lines_the_unix_way(path: Path) -> None:
    raw = path.read_bytes()
    assert b"\r" not in raw, f"{path.name}: CR w pliku powłoki — bash na Debianie przeczyta go jako część polecenia"
    assert not raw.startswith(b"\xef\xbb\xbf"), f"{path.name}: BOM przed #! psuje pierwszą linię"
    assert raw.endswith(b"\n")
    raw.decode("utf-8")
    subprocess.run([find_bash(), "-n", path.as_posix()], check=True, capture_output=True)


@pytest.mark.parametrize("path", SHELL_CODE, ids=lambda p: p.name)
def test_shell_code_is_ascii_and_translated_text_lives_in_the_language_files(path: Path) -> None:
    # The scripts run before any locale is known to be sane; a Polish letter in a
    # message printed too early would arrive as two wrong characters.
    foreign = sorted({ch for ch in path.read_text(encoding="utf-8") if ord(ch) > 127})
    assert not foreign, f"{path.name}: znaki spoza ASCII {foreign!r} — teksty należą do installer/debian/lang/*.sh"


def test_the_entry_point_follows_the_house_rules_for_scripts() -> None:
    lines = ENTRY.read_text(encoding="utf-8").splitlines()
    assert lines[0] == "#!/usr/bin/env bash" and "set -euo pipefail" in lines
    text = "\n".join(lines)
    for option in ("--dry-run", "--answers", "--zmien", "--odnow", "--odinstaluj", "--status", "--lang", "--plain"):
        assert option in text, option
    # Nothing may quietly depend on where the script was started from.
    assert 'THX_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"' in text


def test_the_scripts_never_ask_the_world_for_this_machines_address() -> None:
    """No call home: the public address is typed by the owner, not fetched from somebody's service."""
    for path in [ENTRY, *LIBRARIES, SETUP_TEMPLATE]:
        text = path.read_text(encoding="utf-8")
        assert not re.search(r"ifconfig\.|icanhazip|ipify|checkip|myip", text, re.IGNORECASE), path.name
        # The only addresses spelt out are loopback, private ones and the documentation ranges.
        for address in re.findall(r"\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b", text):
            assert address == "127.0.0.1" or address.startswith(("203.0.113.", "198.51.100.", "192.0.2.", "192.168.")), (
                path.name, address)


# -- texts ------------------------------------------------------------------------------------

_ENTRY_LINE = re.compile(r"""^\s*\[([A-Za-z0-9_.]+)\]=(?:'((?:[^'])*)'|"((?:[^"\\$`]|\\n)*)")\s*$""")


def _strings(language: str) -> dict[str, str]:
    entries: dict[str, str] = {}
    inside = False
    for number, line in enumerate(LANGUAGES[language].read_text(encoding="utf-8").splitlines(), start=1):
        stripped = line.strip()
        if stripped == "MSG=(":
            inside = True
            continue
        if stripped == ")":
            inside = False
            continue
        if not inside or not stripped or stripped.startswith("#"):
            continue
        match = _ENTRY_LINE.match(line)
        assert match, f"{language}.sh:{number}: linia nie jest wpisem [klucz]='tekst' (albo tekst w \"…\" zawiera $ ` lub \\)"
        key = match.group(1)
        assert key not in entries, f"{language}.sh:{number}: klucz {key} występuje dwa razy"
        entries[key] = match.group(2) if match.group(2) is not None else match.group(3)
    return entries


def _asked_keys() -> set[str]:
    """Every message key the shell code asks for: literal ones, and the families put together at run time."""
    call = re.compile(
        r"(?<![A-Za-z0-9_.-])(?:t|text_of|say|ok|achieved|note|warn|fail|die_t|stop_t|step|apache_refuse|has_text)"
        r"\s+\"?([a-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+)\"?"
    )
    row = re.compile(r"preflight_row\s+(?:ok|warn|error)\s+([a-z][A-Za-z0-9_.]+)")
    indirect = re.compile(r"(?:ask_acme|rotate_on_vps\s+--[a-z-]+)\s+([a-z][A-Za-z0-9_.]+)")
    asked: set[str] = set()
    for path in [ENTRY, *LIBRARIES]:
        for line in path.read_text(encoding="utf-8").splitlines():
            if line.lstrip().startswith("#"):
                continue
            for pattern in (call, row, indirect):
                asked.update(pattern.findall(line))
    for mode in apacheconf.MODES:
        asked.add(f"mode.{mode}")
    for kind in ("music", "movies", "mixed"):
        asked.add(f"kind.{kind}")
    for kind in ("local", "lan", "public", "lan_secure"):
        asked.add(f"address.{kind}")
    for flow in answers.FLOWS:
        asked.add(f"finish.{flow}")
    asked.update(f"problem.{code}" for code in _problem_codes())
    return asked


def _problem_codes() -> set[str]:
    """Every problem the helper can report, read from its source."""
    codes: set[str] = set()
    for module in ("answers.py", "debian.py", "cli.py"):
        source = (INSTALLER / "setup_helper" / module).read_text(encoding="utf-8")
        codes.update(re.findall(r'"((?:answers|folder|plan)\.[a-z_]+)"', source))
    codes.update(f"folder.{reason}" for reason in debian.FORBIDDEN_FOLDERS)
    return codes


def test_every_text_exists_in_both_languages_with_the_same_places() -> None:
    polish, english = _strings("pl"), _strings("en")
    assert sorted(set(polish) - set(english)) == [], "brak tłumaczeń angielskich"
    assert sorted(set(english) - set(polish)) == [], "klucze bez polskiego tekstu"
    for key, text in polish.items():
        for language, candidate in (("pl", text), ("en", english[key])):
            # bash's printf knows no numbered places, and a stray % would eat the next word.
            assert not re.search(r"%(?!s|%)", candidate), f"{language}:{key}: znak % poza %s i %%"
        assert text.count("%s") == english[key].count("%s"), f"{key}: inna liczba wartości w obu językach"


def test_every_text_the_code_asks_for_is_there_and_none_is_left_over() -> None:
    polish = _strings("pl")
    asked = _asked_keys()
    assert sorted(asked - set(polish)) == [], "kod prosi o teksty, których nie ma"
    assert sorted(set(polish) - asked) == [], "teksty, o które nikt nie prosi"


def test_every_problem_the_helper_reports_can_be_said_in_both_languages() -> None:
    codes = _problem_codes()
    assert {"answers.unknown_key", "folder.home", "plan.https_conflict", "answers.vps_invalid"} <= codes
    for language in ("pl", "en"):
        strings = _strings(language)
        assert sorted(code for code in codes if f"problem.{code}" not in strings) == [], language


# -- the line protocol between the script and the helper ----------------------------------------


def test_a_structure_survives_the_trip_through_lines() -> None:
    lines = flat.encode({"ok": True, "plan": {"sites": ["a", "b"], "none": [], "port": 8765, "empty": None, "no": False}})
    assert lines == ["ok=1", "plan.sites.count=2", "plan.sites.0=a", "plan.sites.1=b", "plan.none.count=0",
                     "plan.port=8765", "plan.empty=", "plan.no=0"]
    assert flat.decode(lines) == {"ok": "1", "plan": {"sites": ["a", "b"], "none": [], "port": "8765", "empty": "", "no": "0"}}
    # Values are taken literally up to the end of the line: quotes, equals signs, spaces.
    assert flat.decode(['folders.0.path=/srv/Filmy "stare" = 2'])["folders"] == [{"path": '/srv/Filmy "stare" = 2'}]


@pytest.mark.parametrize(
    ("lines", "message"),
    [
        (["no equals sign"], "brak znaku"),
        (["a.0=x", "a.2=y"], "dziurę"),
        (["a.0=x", "a.name=y"], "jednocześnie listą i obiektem"),
        (["a=1", "a.b=2"], "ma już wartość"),
        (["a=1", "a=2"], "dwa razy"),
        (["a.count=3"], "żadnej pozycji"),
        (["a b=1"], "niepoprawna nazwa"),
    ],
)
def test_lines_that_are_not_a_structure_are_refused(lines: list[str], message: str) -> None:
    with pytest.raises(flat.FlatError, match=message):
        flat.decode(lines)


def test_a_value_with_a_line_break_cannot_be_smuggled_into_the_protocol() -> None:
    with pytest.raises(flat.FlatError, match="końca linii"):
        flat.encode({"error": "first\nok=1"})


def test_the_helper_speaks_lines_to_the_shell_with_bare_line_feeds() -> None:
    request = "\n".join([
        "interactive=0", "answers.flow=install", "answers.access.mode=lan", "answers.folders.count=1",
        "answers.folders.0.path=/srv/media/filmy", "answers.folders.0.kind=movies", "answers.admin.username=jan",
        "answers.admin.password_file=/root/haslo", "env.lan_cidrs.count=1", "env.lan_cidrs.0=192.168.1.20/24",
        "env.has_build=1", "env.default_site_enabled=1", "",
    ])
    result = subprocess.run(
        [sys.executable, "-I", "-X", "utf8", str(INSTALLER / "helper.py"), "--shell", "debian-plan"],
        input=request.encode("utf-8"), capture_output=True, timeout=60, check=False,
    )
    assert result.returncode == 0, result.stderr.decode("utf-8", "replace")
    assert b"\r" not in result.stdout, "CR na końcu linii trafiłby do wartości czytanych przez bash"
    answer = flat.decode(result.stdout.decode("utf-8").splitlines())
    assert answer["ok"] == "1" and answer["problems"] == []
    assert answer["plan"]["letter"] == "D" and answer["plan"]["disable_sites"] == ["000-default"]
    assert answer["plan"]["firewall"]["rules"] == ["allow from 192.168.1.0/24 comment tryhackx-media-reach"]
    assert answer["answers"]["folders"] == [{"path": "/srv/media/filmy", "kind": "movies", "id": ""}]


# -- the answers file -------------------------------------------------------------------------


def _normalise(raw: dict, **options: object) -> tuple[dict, list[str]]:
    result, problems = answers.normalise(raw, forbidden_folders=debian.FORBIDDEN_FOLDERS, **options)  # type: ignore[arg-type]
    return result, [entry["code"] for entry in problems]


@pytest.mark.parametrize(
    ("name", "mode", "letter"),
    [
        ("answers-standalone.toml", "direct", "S"),
        ("answers-private-vps.toml", "vps", "P"),
        ("answers-lan.toml", "lan", "D"),
        ("answers-localhost.toml", "local", "C"),
    ],
)
def test_the_example_files_are_valid_and_carry_no_password(name: str, mode: str, letter: str) -> None:
    raw = answers.load(EXAMPLES / name)
    result, problems = _normalise(raw, password_in_environment=True)
    assert problems == [], name
    assert result["access"]["mode"] == mode and debian.LETTERS[mode] == letter
    assert result["folders"] and result["admin"]["username"] == "jan"
    text = (EXAMPLES / name).read_text(encoding="utf-8")
    assert not re.search(r"^\s*password\s*=", text, re.MULTILINE)
    # Without a password from a file or the environment the same file is not enough to install.
    assert _normalise(raw)[1] == ["answers.admin_password_source"]


def test_the_examples_use_documentation_addresses_only() -> None:
    for path in sorted(EXAMPLES.glob("*.toml")):
        text = path.read_text(encoding="utf-8")
        for address in re.findall(r"\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b", text):
            assert address.startswith(("203.0.113.", "198.51.100.", "192.0.2.", "192.168.")), (path.name, address)
        for host in re.findall(r"[a-z0-9-]+\.[a-z0-9.-]+\.(?:org|com|net|pl)\b", text):
            assert host.endswith("example.org") or host == "letsencrypt.org", (path.name, host)


def test_answers_arrive_typed_or_as_text_and_mean_the_same() -> None:
    typed, _ = _normalise({
        "flow": "install",
        "access": {"mode": "P", "host_name": "Media.Example.ORG.", "vps_addresses": ["203.0.113.10", "2001:db8::10"],
                   "home_address": "198.51.100.7", "allow_lan": True, "acme_agree_tos": True},
        "folders": [{"path": "/srv/media/filmy/", "kind": "Movies"}],
        "admin": {"username": "jan", "password_file": "/root/haslo"},
        "firewall": {"lan_subnets": ["192.168.1.20/24"], "extra_ports": ["8080/TCP"]},
        "vps": {"ssh_port": 2222},
    })
    # The same answers as the shell sends them: every value text, lists as items or as one line.
    as_text, problems = _normalise({
        "flow": "install",
        "access": {"mode": "vps", "host_name": "media.example.org", "vps_addresses": "203.0.113.10, 2001:db8::10",
                   "home_address": "198.51.100.7", "allow_lan": "1", "acme_agree_tos": "tak"},
        "folders": [{"path": "/srv/media/filmy", "kind": "movies", "id": ""}],
        "admin": {"username": "jan", "password_file": "/root/haslo"},
        "firewall": {"lan_subnets": "192.168.1.0/24", "extra_ports": ["8080/tcp"]},
        "vps": {"ssh_port": "2222"},
    })
    assert problems == [] and typed == as_text
    assert typed["access"]["host_name"] == "media.example.org"
    assert typed["access"]["vps_addresses"] == ["203.0.113.10", "2001:db8::10"]
    assert typed["folders"] == [{"path": "/srv/media/filmy", "kind": "movies", "id": ""}]
    assert typed["firewall"]["lan_subnets"] == ["192.168.1.0/24"] and typed["vps"]["ssh_port"] == 2222
    # What a shape has no use for is not carried along.
    assert typed["access"]["certificate"] == "origin" and typed["options"]["fail2ban"] is False


@pytest.mark.parametrize(
    ("change", "code"),
    [
        ({"acess": {}}, "answers.unknown_key"),
        ({"access": {"mode": "vps", "host_name": "media.example.org", "vps_adresses": ["203.0.113.10"]}}, "answers.unknown_key"),
        ({"flow": "reinstall"}, "answers.flow"),
        ({"access": {"mode": "everywhere"}}, "answers.mode"),
        ({"access": {"mode": "direct", "acme_agree_tos": True}}, "answers.host_required"),
        ({"access": {"mode": "direct", "host_name": "media", "acme_agree_tos": True}}, "answers.host_invalid"),
        ({"access": {"mode": "direct", "host_name": "media.example.org"}}, "answers.acme_tos"),
        ({"access": {"mode": "direct", "host_name": "media.example.org", "certificate": "files"}}, "answers.certificate_files"),
        ({"access": {"mode": "direct", "host_name": "media.example.org", "certificate": "magic"}}, "answers.certificate"),
        ({"access": {"mode": "vps", "host_name": "media.example.org", "home_address": "198.51.100.7"}}, "answers.vps_required"),
        ({"access": {"mode": "vps", "host_name": "media.example.org", "vps_addresses": ["vps.example.org"],
                     "home_address": "198.51.100.7"}}, "answers.vps_invalid"),
        ({"access": {"mode": "vps", "host_name": "media.example.org", "vps_addresses": ["203.0.113.10"]}}, "answers.home_required"),
        ({"access": {"mode": "vps", "host_name": "media.example.org", "vps_addresses": ["203.0.113.10"],
                     "home_address": "203.0.113.10"}}, "answers.home_is_vps"),
        ({"access": {"mode": "vps", "host_name": "media.example.org", "vps_addresses": ["203.0.113.10"],
                     "home_address": "127.0.0.1"}}, "answers.home_invalid"),
        ({"access": {"mode": "local", "acme_email": "not an address"}}, "answers.acme_email"),
        ({"folders": []}, "answers.folders_required"),
        ({"folders": [{"path": "srv/media", "kind": "music"}]}, "folder.relative"),
        ({"folders": [{"path": "/home/jan/muzyka", "kind": "music"}]}, "folder.home"),
        ({"folders": [{"path": "/root/filmy", "kind": "movies"}]}, "folder.home"),
        ({"folders": [{"path": "/tmp/filmy", "kind": "movies"}]}, "folder.tmp"),
        ({"folders": [{"path": "/var/lib/tryhackx-media-server/x", "kind": "movies"}]}, "folder.own"),
        ({"folders": [{"path": "/etc", "kind": "mixed"}]}, "folder.system"),
        ({"folders": [{"path": "/", "kind": "mixed"}]}, "folder.system"),
        ({"folders": [{"path": "/srv/a", "kind": "music"}, {"path": "/srv/a/b", "kind": "movies"}]}, "folder.nested"),
        ({"folders": [{"path": "/srv/a", "kind": "music"}, {"path": "/srv/a/", "kind": "movies"}]}, "folder.duplicate"),
        ({"folders": [{"path": "/srv/a", "kind": "audio"}]}, "answers.folder_kind"),
        ({"folders": [{"path": "/srv/a", "kind": "music", "id": "1st"}]}, "answers.folder_id"),
        ({"folders": [{"path": "/srv/a", "kind": "music", "id": "x"}, {"path": "/srv/b", "kind": "music", "id": "x"}]},
         "answers.folder_id_twice"),
        ({"admin": {"username": "j", "password_file": "/root/haslo"}}, "answers.admin_username"),
        ({"admin": {"username": "jan", "password_file": "/root/haslo", "email": "jan@"}}, "answers.admin_email"),
        ({"admin": {"username": "jan", "password": "hunter2hunter2"}}, "answers.admin_password_literal"),
        ({"admin": {"username": "jan"}}, "answers.admin_password_source"),
        ({"admin": {"username": "jan", "password_file": "haslo.txt"}}, "answers.admin_password_file"),
        ({"database": {"name": "media-server"}}, "answers.db_name"),
        ({"database": {"user": "x" * 29}}, "answers.db_user"),
        ({"firewall": {"lan_subnets": ["192.168.1.0/33"]}}, "answers.subnet"),
        ({"firewall": {"lan_subnets": ["0.0.0.0/0"]}}, "answers.subnet"),
        ({"firewall": {"extra_ports": ["http"]}}, "answers.extra_port"),
        ({"firewall": {"manage": "perhaps"}}, "answers.type"),
        ({"vps": {"run": "telnet"}}, "answers.vps_run"),
        ({"vps": {"ssh_port": 70000}}, "answers.number"),
        ({"vps": {"ssh_host_fingerprint": "MD5:aa:bb"}}, "answers.ssh_fingerprint"),
        ({"access": {"mode": "vps", "host_name": "media.example.org", "vps_addresses": ["203.0.113.10"],
                     "home_address": "198.51.100.7"}, "vps": {"run": "ssh"}}, "answers.ssh_needs_key"),
    ],
)
def test_an_answers_file_that_cannot_work_says_why(change: dict, code: str) -> None:
    raw: dict = {
        "flow": "install",
        "access": {"mode": "local"},
        "folders": [{"path": "/srv/media/filmy", "kind": "movies"}],
        "admin": {"username": "jan", "password_file": "/root/haslo"},
    }
    raw.update(change)
    _result, problems = _normalise(raw)
    assert code in problems, problems


def test_every_problem_is_reported_not_only_the_first() -> None:
    _result, problems = _normalise({
        "access": {"mode": "direct", "host_name": "nope"},
        "folders": [{"path": "/home/x", "kind": "what"}],
        "admin": {"username": "!", "password": "x"},
        "typo": 1,
    })
    assert {"answers.host_invalid", "answers.acme_tos", "folder.home", "answers.folder_kind", "answers.admin_username",
            "answers.admin_password_literal", "answers.unknown_key"} <= set(problems)


def test_a_person_at_the_keyboard_settles_two_things_on_the_spot() -> None:
    raw = {"access": {"mode": "direct", "host_name": "media.example.org"},
           "folders": [{"path": "/srv/a", "kind": "music"}], "admin": {"username": "jan"}}
    assert set(_normalise(raw)[1]) == {"answers.acme_tos", "answers.admin_password_source"}
    assert _normalise(raw, interactive=True)[1] == []


def test_a_change_of_folders_needs_no_access_and_no_administrator() -> None:
    result, problems = _normalise({"flow": "folders", "folders": [{"path": "/srv/a", "kind": "music"}]})
    assert problems == [] and result["flow"] == "folders"
    assert _normalise({"flow": "uninstall", "uninstall": {"drop_database": True, "confirm_database": "media_server"}})[1] == []


def test_an_answers_file_is_toml_or_json_and_a_broken_one_is_refused(tmp_path: Path) -> None:
    as_toml = tmp_path / "a.toml"
    as_toml.write_text('flow = "folders"\n[[folders]]\npath = "/srv/a"\nkind = "music"\n', encoding="utf-8")
    as_json = tmp_path / "a.json"
    as_json.write_text('﻿{"flow": "folders", "folders": [{"path": "/srv/a", "kind": "music"}]}', encoding="utf-8")
    assert answers.load(as_toml) == answers.load(as_json)
    broken = tmp_path / "broken.toml"
    broken.write_text("flow = \n", encoding="utf-8")
    with pytest.raises(answers.AnswersError, match="TOML"):
        answers.load(broken)
    with pytest.raises(answers.AnswersError, match="odczytać"):
        answers.load(tmp_path / "missing.toml")
    refused = helper_cli.run("debian-answers", {"path": str(broken)})
    assert refused["ok"] is False and "TOML" in refused["error"]


# -- the layout: one set of paths, spelt in four places -----------------------------------------


def _shell_assignments(path: Path) -> dict[str, str]:
    """``NAME="value"`` lines of a script, with ``$OTHER`` references resolved."""
    found: dict[str, str] = {}
    for name, value in re.findall(r'^([A-Z0-9_]+)="([^"]*)"$', path.read_text(encoding="utf-8"), re.MULTILINE):
        found[name] = re.sub(r"\$([A-Z_]+)", lambda match: found.get(match.group(1), match.group(0)), value)
    return found


def test_the_installer_the_helper_the_release_script_and_the_units_agree_on_the_layout() -> None:
    shell = _shell_assignments(INSTALLER / "debian" / "lib" / "common.sh")
    release = _shell_assignments(PROJECT_ROOT / "scripts" / "release-debian.sh")
    pairs = {
        "PREFIX": debian.PREFIX, "CURRENT": debian.CURRENT, "CONFIG_DIR": debian.CONFIG_DIR, "CONFIG": debian.CONFIG,
        "MIGRATE_CONFIG": debian.MIGRATE_CONFIG, "STATE_FILE": debian.STATE_FILE, "ORIGIN_CERT": debian.ORIGIN_CERT,
        "ORIGIN_KEY": debian.ORIGIN_KEY, "SELF_CERT": debian.SELF_CERT, "SELF_KEY": debian.SELF_KEY,
        "BUNDLE_DIR": debian.BUNDLE_DIR, "STATE_DIR": debian.STATE_DIR, "LOG_DIR": debian.LOG_DIR,
        "BACKUP_ROOT": debian.BACKUP_ROOT, "ACME_WEBROOT": debian.ACME_WEBROOT, "SITES_AVAILABLE": debian.SITES_AVAILABLE, "HTTP_SITE": debian.HTTP_SITE,
        "HTTPS_SITE": debian.HTTPS_SITE, "SYSTEMD_DIR": debian.SYSTEMD_DIR, "SERVICE": debian.SERVICE,
        "FAIL2BAN_FILTER": debian.FAIL2BAN_FILTER, "FAIL2BAN_JAIL": debian.FAIL2BAN_JAIL, "RENEW_HOOK": debian.RENEW_HOOK,
        "SERVICE_USER": debian.SERVICE_USER, "MARKER_TEXT": debian.MARKER_TEXT,
    }
    for name, expected in pairs.items():
        assert shell[name] == expected, name
    for name in ("PREFIX", "CONFIG", "STATE_DIR", "LOG_DIR", "SERVICE", "SERVICE_USER"):
        assert release[name] == shell[name], name
    units = sorted(path.name for path in (PROJECT_ROOT / "deploy" / "systemd").iterdir())
    assert sorted(debian.UNITS) == units, "instalator musi instalować (i usuwać) dokładnie te jednostki, które są w deploy/systemd"
    declared = re.search(r"^UNITS=\(([^)]*)\)", (INSTALLER / "debian" / "lib" / "common.sh").read_text(encoding="utf-8"), re.MULTILINE | re.DOTALL)
    assert declared is not None and sorted(declared.group(1).split()) == units
    # The jail reads the error log of the host the installer generates.
    jail = (PROJECT_ROOT / "deploy" / "fail2ban" / "jail.d" / "tryhackx-media.conf.example").read_text(encoding="utf-8")
    assert f"logpath  = /var/log/apache2/{debian.HTTP_SITE}-error.log" in jail
    # The VPS side and the home side call their sites the same.
    assert vpsbundle.SITE_NAME == debian.HTTP_SITE and vpsbundle.SCRIPT_MARKER == debian.MARKER_TEXT
    assert debian.MARKER_LINE.startswith(apacheconf.MANAGED_MARKER)


# -- packages and modules ---------------------------------------------------------------------


def test_packages_are_what_the_code_needs_and_what_the_shape_adds() -> None:
    base = set(debian.BASE_PACKAGES)
    assert {"python3-venv", "libapache2-mod-php", "php-cli", "php-mysql", "php-mbstring", "php-curl", "php-xml",
            "mariadb-server", "ffmpeg", "curl", "openssl"} <= base
    assert set(debian.packages("local")) == base, "tylko ten komputer: żadnej zapory, żadnego certbota"
    assert set(debian.packages("lan")) - base == {"ufw"}
    assert set(debian.packages("lan", manage_firewall=False)) == base
    assert set(debian.packages("direct", certificate="letsencrypt", fail2ban=True)) - base == {"certbot", "ufw", "fail2ban"}
    assert "certbot" not in debian.packages("direct", certificate="selfsigned")
    assert set(debian.packages("vps", fail2ban=True)) - base == {"ufw", "openssh-client"}, "za VPS-em ban w domu banowałby wszystkich"
    assert {"nodejs", "npm"} <= set(debian.packages("local", build_frontend=True))
    # Node is never installed "just in case": an end user's package carries the built frontend.
    assert not {"nodejs", "npm"} & set(debian.packages("direct", certificate="letsencrypt"))


def test_the_php_extensions_named_to_the_user_are_the_ones_the_bridge_uses() -> None:
    php = "\n".join(path.read_text(encoding="utf-8", errors="replace") for path in (PROJECT_ROOT / "integrations" / "php").rglob("*.php"))
    used = {
        "pdo_mysql": "new PDO" in php, "mbstring": "mb_strlen(" in php, "curl": "curl_init(" in php,
        "simplexml": "simplexml_load_string(" in php, "openssl": "openssl_encrypt(" in php,
    }
    assert all(used.values()), used
    assert set(debian.PHP_EXTENSIONS) == set(used)
    checked = (INSTALLER / "debian" / "lib" / "steps.sh").read_text(encoding="utf-8")
    assert '["pdo_mysql","mbstring","curl","simplexml","openssl"]' in checked


def test_apache_modules_follow_the_shape() -> None:
    assert "ssl" not in debian.apache_modules("lan") and "ssl" not in debian.apache_modules("local")
    for mode in ("direct", "vps"):
        assert {"proxy", "proxy_http", "headers", "ssl", "alias", "env"} <= set(debian.apache_modules(mode))
    with pytest.raises(apacheconf.ApacheConfError, match="Nieznany tryb"):
        debian.apache_modules("everyone")


# -- Apache sites -----------------------------------------------------------------------------

CERTS = {"certificate_file": debian.ORIGIN_CERT, "certificate_key_file": debian.ORIGIN_KEY}
SHAPES: list[dict] = [
    {"mode": "local"},
    {"mode": "lan"},
    {"mode": "direct", "host_name": "media.example.org", **CERTS},
    {"mode": "vps", "host_name": "media.example.org", "vps_addresses": ("203.0.113.10", "2001:db8::10"), **CERTS},
    {"mode": "vps", "host_name": "media.example.org", "vps_addresses": ("203.0.113.10",), "allow_lan": True, **CERTS},
]


def _sites(**options: object) -> dict[str, str]:
    return debian.render_sites(NEXT_EXAMPLE, TRANSFER_EXAMPLE, debian.SiteConf(**options))  # type: ignore[arg-type]


def _application(sites: dict[str, str]) -> str:
    """The one file of a shape that serves the application."""
    carrying = [text for text in sites.values() if "media-next-api" in text]
    assert len(carrying) == 1
    return carrying[0]


@pytest.mark.parametrize("options", SHAPES, ids=lambda o: o["mode"] + ("+lan" if o.get("allow_lan") else ""))
def test_every_generated_site_keeps_the_examples_guarantees(options: dict) -> None:
    sites = _sites(service_port=8766, generated="2026-11-12 23:00", **options)
    for name, text in sites.items():
        assert text.splitlines()[0] == debian.MARKER_LINE, name
        assert text.endswith("</VirtualHost>\n") and "\r" not in text
        assert text.count("<VirtualHost ") == text.count("</VirtualHost>") == 1
    text = _application(sites)
    lines = text.splitlines()
    directives = _directives(text)
    assert directives.count(f'Define TRYHACKX_MEDIA_ROOT "{debian.CURRENT}"') == 1
    assert directives.count(f'Define TRYHACKX_BRIDGE_CONFIG "{debian.CONFIG}"') == 1
    assert 'DocumentRoot "${TRYHACKX_MEDIA_ROOT}/public/assets/build"' in directives
    # The service port is the configured one in both proxy lines, and nowhere the default.
    assert text.count("http://127.0.0.1:8766/") == 2 and ":8765" not in text
    assert any("timeout=3600" in line and "nocanon" in line for line in directives if line.startswith("ProxyPass "))
    # The order that decides whether the internal routes are closed (tests/test_apache_examples.py).
    deny = next(i for i, line in enumerate(lines) if NARROW_DENY.search(line))
    opened = next(i for i, line in enumerate(lines) if BROAD_OPEN.search(line))
    assert deny > opened
    for route in ["health", *_internal_routes()]:
        assert route in lines[deny]
    assert 'Header always set Cache-Control "no-store" "expr=-z %{resp:Cache-Control}"' in directives
    # Every directive of both examples is in the generated host — only the access rules differ.
    for example in (NEXT_EXAMPLE, TRANSFER_EXAMPLE):
        for directive in _directives(example):
            if directive.startswith("Require ") or "127.0.0.1:8765" in directive:
                continue
            assert directive in directives, directive
    assert "${APACHE_LOG_DIR}/tryhackx-media-error.log" in text, "fail2ban czyta właśnie ten plik"


def test_localhost_only_opens_nothing_to_anybody_else() -> None:
    sites = _sites(mode="local")
    assert list(sites) == [debian.HTTP_SITE]
    directives = _directives(sites[debian.HTTP_SITE])
    assert "<VirtualHost *:80>" in directives and "Require all granted" not in directives
    assert directives.count("Require local") == 3 and not any(line.startswith(("Require ip", "SSL")) for line in directives)
    assert 'SetEnv TRYHACKX_BRIDGE_ALLOW_HTTP_LOCAL "1"' in directives


def test_the_home_network_shape_admits_private_addresses_over_plain_http() -> None:
    directives = _directives(_sites(mode="lan")[debian.HTTP_SITE])
    assert directives.count("Require ip " + " ".join(apacheconf.PRIVATE_RANGES)) == 3
    assert "Require all granted" not in directives and "SSLEngine on" not in directives
    assert 'SetEnv TRYHACKX_BRIDGE_ALLOW_HTTP_LOCAL "1"' in directives


def test_behind_a_vps_only_the_vps_is_admitted_and_the_public_name_appears_nowhere() -> None:
    sites = _sites(mode="vps", host_name="media.example.org", vps_addresses=("203.0.113.10", "2001:db8::10"), **CERTS)
    assert list(sites) == [debian.HTTPS_SITE], "dom nie potrzebuje portu 80 w ogóle"
    text = sites[debian.HTTPS_SITE]
    directives = _directives(text)
    assert "Require all granted" not in directives
    assert directives.count("Require ip 203.0.113.10 2001:db8::10") == 3
    assert not any("192.168.0.0/16" in line for line in directives)
    assert f"ServerName {apacheconf.ORIGIN_SERVER_NAME}" in directives
    assert f'SSLCertificateFile "{debian.ORIGIN_CERT}"' in directives and f'SSLCertificateKeyFile "{debian.ORIGIN_KEY}"' in directives
    # A scanner that reaches the home address must not learn whose server it is.
    assert "media.example.org" not in text
    assert not any("Strict-Transport-Security" in line for line in directives), "HSTS należy do VPS-a"
    assert "TRYHACKX_BRIDGE_ALLOW_HTTP_LOCAL" not in text

    with_lan = _directives(_sites(mode="vps", vps_addresses=("203.0.113.10",), allow_lan=True, **CERTS)[debian.HTTPS_SITE])
    assert with_lan.count("Require ip " + " ".join(apacheconf.PRIVATE_RANGES)) == 3


def test_a_standalone_server_redirects_plain_http_answers_the_challenge_and_sends_hsts() -> None:
    sites = _sites(mode="direct", host_name="Media.Example.ORG.", certificate_file="/etc/letsencrypt/live/media.example.org/fullchain.pem",
                   certificate_key_file="/etc/letsencrypt/live/media.example.org/privkey.pem")
    assert sorted(sites) == [debian.HTTP_SITE, debian.HTTPS_SITE]
    http, https = _directives(sites[debian.HTTP_SITE]), _directives(sites[debian.HTTPS_SITE])
    assert "ServerName media.example.org" in http and "ServerName media.example.org" in https
    assert https.count("Require all granted") == 3
    assert 'Header always set Strict-Transport-Security "max-age=31536000"' in https
    # Port 80 carries no application: the bridge refuses a sign-in over plain HTTP.
    assert not any(line.startswith(("ProxyPass", "DocumentRoot", "Define")) for line in http)
    assert "media-next-api" not in sites[debian.HTTP_SITE]
    # It is, directive for directive, what the VPS gets for its own port 80 — the challenge
    # must stay reachable or the certificate cannot be renewed.
    values = {"DOMAIN": "media.example.org", "SITE": debian.HTTP_SITE, "GENERATED": "x", "GENERATOR": "x"}
    vps_http = _directives(vpsbundle.render((VPS_TEMPLATES / "site-http.conf.tmpl").read_text(encoding="utf-8"), values, "t"))
    assert http == vps_http


@pytest.mark.parametrize(
    ("options", "message"),
    [
        ({"mode": "vps", **CERTS}, "adresu VPS"),
        ({"mode": "vps", "vps_addresses": ("vps.example.org",), **CERTS}, "nie jest adresem IP"),
        ({"mode": "direct", "host_name": "media", **CERTS}, "nazwą hosta"),
        ({"mode": "direct", "host_name": "media.example.org"}, "certyfikatu"),
        ({"mode": "direct", "host_name": "media.example.org", "certificate_file": 'a"b', "certificate_key_file": "/k"}, "Ścieżki nie da się"),
        ({"mode": "local", "service_port": 70000}, "Port usługi"),
        ({"mode": "everyone"}, "Nieznany tryb"),
    ],
)
def test_a_site_that_cannot_be_right_is_not_generated(options: dict, message: str) -> None:
    with pytest.raises(apacheconf.ApacheConfError, match=message):
        _sites(**options)


def test_a_changed_example_is_noticed_rather_than_half_translated() -> None:
    conf = debian.SiteConf(mode="direct", host_name="media.example.org", **CERTS)
    extra = NEXT_EXAMPLE + '\n<Location "/new-route">\n    Require all granted\n</Location>\n'
    with pytest.raises(apacheconf.ApacheConfError, match="oczekiwano 2"):
        debian.render_sites(extra, TRANSFER_EXAMPLE, conf)
    with pytest.raises(apacheconf.ApacheConfError, match="otwartą regułę"):
        debian.render_sites(NEXT_EXAMPLE, TRANSFER_EXAMPLE.replace("    # Require all granted", "    Require all granted"), conf)
    with pytest.raises(apacheconf.ApacheConfError, match="trasy transferu"):
        debian.render_sites(NEXT_EXAMPLE, TRANSFER_EXAMPLE.replace("127.0.0.1:8765", "localhost:8765"), conf)
    reordered = TRANSFER_EXAMPLE.replace("<Location /media-transfer/>", "<Location /media-transfer-moved/>")
    with pytest.raises(apacheconf.ApacheConfError, match="zamykający"):
        debian.render_sites(NEXT_EXAMPLE, reordered, conf)
    with pytest.raises(apacheconf.ApacheConfError, match="aliasu mostu"):
        debian.render_sites(NEXT_EXAMPLE.replace('Alias "/media-next-api"', 'Alias "/api"'), TRANSFER_EXAMPLE, conf)


def test_the_sites_reach_the_disk_through_the_helper_with_unix_line_ends(tmp_path: Path) -> None:
    answer = helper_cli.run("debian-sites", {
        "examples_dir": str(APACHE_EXAMPLES), "output_dir": str(tmp_path / "sites"),
        "conf": {"mode": "direct", "host_name": "media.example.org", "service_port": "8766",
                 "certificate_file": debian.SELF_CERT, "certificate_key_file": debian.SELF_KEY, "allow_lan": "0"},
    })
    assert answer["ok"] and answer["sites"] == [debian.HTTP_SITE, debian.HTTPS_SITE]
    assert answer["access"] == ["Require all granted"]
    for name in answer["sites"]:
        data = (tmp_path / "sites" / f"{name}.conf").read_bytes()
        assert data.startswith(debian.MARKER_LINE.encode()) and b"\r" not in data
    refused = helper_cli.run("debian-sites", {"examples_dir": str(APACHE_EXAMPLES), "conf": {"mode": "vps"}})
    assert refused["ok"] is False and "adresu VPS" in refused["error"]


# -- the firewall -----------------------------------------------------------------------------


def _rules(**options: object) -> list[str]:
    return [" ".join(rule) for rule in debian.firewall_rules(**options)]  # type: ignore[arg-type]


def test_the_firewall_of_a_public_server_opens_three_things() -> None:
    assert _rules(mode="direct") == [
        "allow 22/tcp comment tryhackx-media-reach", "allow 80/tcp comment tryhackx-media", "allow 443/tcp comment tryhackx-media",
    ]
    # SSH on another port must stay reachable, or switching the firewall on ends the session it runs in.
    assert _rules(mode="direct", ssh_ports=(2222,))[0] == "allow 2222/tcp comment tryhackx-media-reach"
    assert "allow 8080/tcp comment tryhackx-media" in _rules(mode="direct", extra_ports=("8080/tcp",))
    # A firewall that was already on is somebody's decision: only the application's ports are added.
    assert _rules(mode="direct", ufw_active=True) == [
        "allow 80/tcp comment tryhackx-media", "allow 443/tcp comment tryhackx-media",
    ]


def test_behind_a_vps_port_443_is_for_the_vps_and_the_home_network_stays_as_it_was() -> None:
    rules = _rules(mode="vps", vps_addresses=("203.0.113.10", "2001:db8::10"), lan_subnets=("192.168.1.0/24",))
    assert rules == [
        "allow from 192.168.1.0/24 comment tryhackx-media-reach",
        "allow proto tcp from 203.0.113.10 to any port 443 comment tryhackx-media",
        "allow proto tcp from 2001:db8::10 to any port 443 comment tryhackx-media",
    ]
    assert not any(rule.startswith(("allow 443/tcp", "allow 80/tcp", "allow 22/tcp")) for rule in rules)
    # The home network not trusted wholesale: SSH from it, 443 from it only when asked for.
    narrow = _rules(mode="vps", vps_addresses=("203.0.113.10",), lan_subnets=("192.168.1.0/24",), trust_lan=False)
    assert narrow == [
        "allow proto tcp from 192.168.1.0/24 to any port 22 comment tryhackx-media-reach",
        "allow proto tcp from 203.0.113.10 to any port 443 comment tryhackx-media",
    ]
    with_lan = _rules(mode="vps", vps_addresses=("203.0.113.10",), lan_subnets=("192.168.1.0/24",), trust_lan=False, allow_lan=True)
    assert "allow proto tcp from 192.168.1.0/24 to any port 443 comment tryhackx-media" in with_lan
    # Somebody else's firewall: nothing but the application's own rule.
    assert _rules(mode="vps", vps_addresses=("203.0.113.10",), lan_subnets=("192.168.1.0/24",), ufw_active=True) == [
        "allow proto tcp from 203.0.113.10 to any port 443 comment tryhackx-media",
    ]
    with pytest.raises(apacheconf.ApacheConfError, match="adresu VPS"):
        _rules(mode="vps", lan_subnets=("192.168.1.0/24",))


def test_switching_the_firewall_on_never_locks_the_administrator_out() -> None:
    # The session comes from outside the home network (a VPN, another site).
    outside = _rules(mode="lan", lan_subnets=("192.168.1.0/24",), ssh_client="203.0.113.77", ssh_ports=(2222,))
    assert "allow proto tcp from 203.0.113.77 to any port 2222 comment tryhackx-media-reach" in outside
    inside = _rules(mode="lan", lan_subnets=("192.168.1.0/24",), ssh_client="192.168.1.5")
    assert inside == ["allow from 192.168.1.0/24 comment tryhackx-media-reach"]
    # Nothing is known about the network at all: SSH stays open rather than the machine becoming unreachable.
    assert "allow 22/tcp comment tryhackx-media-reach" in _rules(mode="vps", vps_addresses=("203.0.113.10",))
    assert _rules(mode="local") == []
    assert _rules(mode="lan", lan_subnets=("192.168.1.0/24",), ufw_active=True) == [
        "allow proto tcp from 192.168.1.0/24 to any port 80 comment tryhackx-media",
    ]


def test_what_the_terminal_names_is_used_only_when_it_is_an_address() -> None:
    # `who am i` also says "(:0)", "(tmux(1234).%0)" or "(mosh [4321])"; ufw would refuse those and
    # stop the installation at its firewall step (audit P2-1). Unusable: no rule for it, SSH stays open.
    for terminal in (":0", "tmux(1234).%0", "mosh [4321]", "host.example.org"):
        rules = _rules(mode="vps", vps_addresses=("203.0.113.10",), ssh_client=terminal)
        assert not any(terminal in rule for rule in rules) and "allow 22/tcp comment tryhackx-media-reach" in rules
    assert debian.usable_address("fe80::1%eth0") == "fe80::1" and debian.usable_address("[2001:db8::7]") == "2001:db8::7"
    # The plan says what the firewall will let in instead of guessing quietly.
    assert "plan.ssh_client_unknown" in _plan({"mode": "lan"}, {"ssh_client": "tmux(1234).%0"})[2]
    assert "plan.ssh_client_only" in _plan({"mode": "lan"}, {"ssh_client": "203.0.113.77"})[2]
    assert not {"plan.ssh_client_unknown", "plan.ssh_client_only"} & set(_plan({"mode": "lan"})[2])


def test_a_site_read_before_ours_on_port_80_is_named_in_the_home_shapes() -> None:
    # Apache reads sites-enabled in name order: "blog" answers http://<address>/ before "tryhackx-media" (audit P3-19).
    assert "plan.http_site_first" in _plan({"mode": "lan"}, {"http_sites": ["blog"]})[2]
    assert "plan.http_site_first" not in _plan({"mode": "lan"}, {"http_sites": ["zz-other"]})[2]
    assert "plan.http_site_first" not in _plan({"mode": "vps", "host_name": "media.example.org",
                                                "vps_addresses": ["203.0.113.10"], "home_address": "198.51.100.7"},
                                               {"http_sites": ["blog"]})[2]


def test_an_uninstall_that_leaves_ufw_on_knows_which_rules_keep_the_machine_reachable() -> None:
    # Marked apart: the access rules stay with a firewall that stays on (audit P0-1).
    rules = _rules(mode="direct")
    assert [rule for rule in rules if rule.endswith(f"comment {debian.FIREWALL_REACH_COMMENT}")] == [
        "allow 22/tcp comment tryhackx-media-reach"]
    assert all(rule.endswith(("comment tryhackx-media", "comment tryhackx-media-reach")) for rule in rules)


def test_the_home_network_is_read_from_the_machines_own_addresses() -> None:
    assert debian.lan_networks(["192.168.1.20/24", "fd00:1::5/64", "fe80::1/64", "203.0.113.5/24", "127.0.0.1/8", "junk"]) == [
        "192.168.1.0/24", "fd00:1::/64",
    ]


# -- the certificate ----------------------------------------------------------------------------


def test_the_certificate_request_describes_a_server_never_an_authority() -> None:
    origin = debian.certificate_config("origin")
    lines = origin.splitlines()
    for expected in ("CN = origin", "basicConstraints = critical, CA:FALSE",
                     "extendedKeyUsage = serverAuth", "subjectKeyIdentifier = hash", "authorityKeyIdentifier = keyid:always"):
        assert expected in lines, expected
    # Deliberately absent, as in the Windows wizard: an old OpenSSL on the VPS would not take a
    # self-issued certificate with a keyUsage lacking keyCertSign as its own trust anchor.
    assert not [line for line in lines if line.startswith("keyUsage")]
    assert "subjectAltName" not in origin, "certyfikat domu nie nazywa nikogo"
    assert "prompt = no" in lines and "CA:TRUE" not in origin
    # The key identifier has to be computed before the authority identifier can copy it.
    assert lines.index("subjectKeyIdentifier = hash") < lines.index("authorityKeyIdentifier = keyid:always")
    public = debian.certificate_config("media.example.org", "Media.Example.org")
    assert "CN = media.example.org" in public and "subjectAltName = DNS:media.example.org" in public
    with pytest.raises(apacheconf.ApacheConfError):
        debian.certificate_config("origin\nCN = evil")


def _openssl(machine: Machine, *arguments: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [machine.bash, "-c", 'exec openssl "$@"', "_", *arguments], capture_output=True, text=True, check=False,
        env={**machine.environment()}, cwd=machine.base,
    )


def _make_certificate(machine: Machine, name: str, config: str) -> Path:
    folder = machine.base / "certificates"
    folder.mkdir(exist_ok=True)
    (folder / f"{name}.cnf").write_text(config, encoding="ascii", newline="\n")
    made = _openssl(
        machine, "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-sha256",
        "-days", "3650", "-config", (folder / f"{name}.cnf").as_posix(), "-keyout", (folder / f"{name}.key").as_posix(),
        "-out", (folder / f"{name}.crt").as_posix(),
    )
    if made.returncode != 0:
        pytest.skip(f"openssl nie jest dostępny albo odmówił: {made.stderr.strip()[:200]}")
    return folder / f"{name}.crt"


def test_openssl_makes_a_server_certificate_from_that_request_and_two_can_be_trusted_at_once(tmp_path: Path) -> None:
    """What a rotation without downtime stands on.

    During a rotation the VPS trusts the old and the new home certificate at once,
    and both are called ``CN=origin``. OpenSSL finds a trust anchor by name first:
    without an authority key identifier one of two same-named certificates is
    rejected (which one depends on their order in the file — measured), with it
    both verify in either order.
    """
    machine = Machine(tmp_path)
    first = _make_certificate(machine, "first", debian.certificate_config("origin"))
    second = _make_certificate(machine, "second", debian.certificate_config("origin"))
    printed = _openssl(machine, "x509", "-in", first.as_posix(), "-noout", "-text").stdout
    assert "CA:FALSE" in printed and "CA:TRUE" not in printed
    assert "X509v3 Key Usage" not in printed and "Certificate Sign" not in printed
    assert "TLS Web Server Authentication" in printed
    assert "Authority Key Identifier" in printed and "Subject: CN=origin" in printed.replace(" = ", "=")
    assert "prime256v1" in printed or "P-256" in printed

    # A pinned self-signed server certificate is its own trust anchor — and nobody else's.
    assert _openssl(machine, "verify", "-CAfile", first.as_posix(), first.as_posix()).returncode == 0
    assert _openssl(machine, "verify", "-CAfile", first.as_posix(), second.as_posix()).returncode != 0
    for order in ((first, second), (second, first)):
        both = tmp_path / "both.crt"
        both.write_text("".join(path.read_text(encoding="ascii") for path in order), encoding="ascii", newline="\n")
        for certificate in order:
            checked = _openssl(machine, "verify", "-CAfile", both.as_posix(), certificate.as_posix())
            assert checked.returncode == 0, checked.stderr
    # The fingerprint the guide prints is the one OpenSSL prints.
    shown = _openssl(machine, "x509", "-in", first.as_posix(), "-noout", "-fingerprint", "-sha256").stdout.strip()
    assert shown.split("=", 1)[1].upper() == vpsbundle.certificate_fingerprint(first.read_text(encoding="ascii"))


# -- the database -----------------------------------------------------------------------------


def test_the_database_gets_one_account_for_data_and_one_for_the_schema() -> None:
    sql = debian.database_sql(name="media_server", user="media_server", password="app-secret-value",
                              ddl_user="media_server_ddl", ddl_password="ddl-secret-value")
    statements = [line for line in sql.splitlines() if line]
    assert statements[0] == "CREATE DATABASE IF NOT EXISTS `media_server` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
    for origin in ("localhost", "127.0.0.1"):
        assert f"GRANT SELECT, INSERT, UPDATE, DELETE ON `media_server`.* TO 'media_server'@'{origin}';" in statements
        assert f"GRANT ALL PRIVILEGES ON `media_server`.* TO 'media_server_ddl'@'{origin}';" in statements
        assert f"CREATE USER IF NOT EXISTS 'media_server'@'{origin}' IDENTIFIED BY 'app-secret-value';" in statements
    # The application's account can never change the schema, and nothing is granted beyond this one database.
    app_grants = [line for line in statements if line.startswith("GRANT") and "'media_server'@" in line]
    assert all("ALL PRIVILEGES" not in line and "*.*" not in line for line in app_grants) and len(app_grants) == 2
    assert "*.*" not in sql and "WITH GRANT OPTION" not in sql
    # A second run is harmless, and re-states the passwords the configuration holds.
    assert sql.count("IF NOT EXISTS") == 5 and sql.count("ALTER USER") == 4


def test_names_and_passwords_cannot_break_out_of_the_statements() -> None:
    quoted = debian.database_sql(name="m", user="u", password="it's a \\ pass", ddl_user="u_ddl", ddl_password="x" * 20)
    assert "IDENTIFIED BY 'it''s a \\\\ pass';" in quoted
    for bad in ({"name": "media;drop"}, {"user": "me`"}, {"ddl_user": "a b"}):
        options = {"name": "m", "user": "u", "password": "p" * 20, "ddl_user": "u_ddl", "ddl_password": "q" * 20, **bad}
        with pytest.raises(ValueError, match="Nazwy"):
            debian.database_sql(**options)
    with pytest.raises(ValueError, match="bez hasła"):
        debian.database_sql(name="m", user="u", password="", ddl_user="u_ddl", ddl_password="x")
    dropped = debian.drop_sql(name="media_server", user="media_server", ddl_user="media_server_ddl")
    assert dropped.splitlines()[0] == "DROP DATABASE IF EXISTS `media_server`;" and dropped.count("DROP USER IF EXISTS") == 4


def _generated_config(tmp_path: Path, **overrides: object) -> str:
    """A configuration exactly as ``scripts/install.py`` writes it."""
    import argparse

    args = argparse.Namespace(port=8765, db_host="127.0.0.1", db_port=3306, db_name="media_server",
                              db_user="media_server", ffmpeg_path="ffmpeg", base_url=None, proxy_trusted=None)
    for key, value in overrides.items():
        setattr(args, key, value)
    return install._build_config(args, {"muzyka": tmp_path / "muzyka"}, "application-secret-value",
                                 tmp_path / "runtime" / "thumbnails", tmp_path / "runtime" / "subtitles")


def test_the_migration_configuration_is_the_services_own_with_one_account_swapped(tmp_path: Path) -> None:
    config = _generated_config(tmp_path, base_url="https://media.example.org/") + '\n[mail]\nhost = "smtp.example.org"\n'
    text, fresh = debian.migrate_config_text(config, previous_text=None, new_password=lambda: "schema-secret-value")
    assert fresh is True and text.startswith(debian.MARKER_LINE + "\n")
    before, after = tomllib.loads(config), tomllib.loads(text)
    assert after["database"] == {**before["database"], "user": "media_server_ddl", "password": "schema-secret-value"}
    assert {k: v for k, v in after.items() if k != "database"} == {k: v for k, v in before.items() if k != "database"}
    # A second run keeps the password: the database server is not touched for nothing.
    again, fresh_again = debian.migrate_config_text(config, previous_text=text, new_password=lambda: "another")
    assert fresh_again is False and again == text
    # A change of the service's configuration travels into the copy; the schema account stays.
    moved = tomledit_roots(config)
    updated, _ = debian.migrate_config_text(moved, previous_text=text, new_password=lambda: "another")
    assert tomllib.loads(updated)["roots"] == tomllib.loads(moved)["roots"]
    assert tomllib.loads(updated)["database"]["password"] == "schema-secret-value"
    # A copy made for another account is not trusted with its old password.
    renamed = config.replace('user = "media_server"', 'user = "other"')
    _text, fresh_renamed = debian.migrate_config_text(renamed, previous_text=text, new_password=lambda: "third-secret-value")
    assert fresh_renamed is True


def tomledit_roots(config: str) -> str:
    from installer.setup_helper import tomledit

    return tomledit.replace_roots(config, [("filmy", "/srv/media/filmy")])


def test_no_password_passes_through_the_shell_on_its_way_to_the_database(tmp_path: Path) -> None:
    config = tmp_path / "config.local.toml"
    config.write_text(_generated_config(tmp_path), encoding="utf-8")
    migrate = tmp_path / "config.migrate.toml"
    made = helper_cli.run("debian-migrate-config", {"config": str(config), "output": str(migrate)})
    assert made["ok"] and made["changed"] and made["fresh_password"] is True
    answer = helper_cli.run("debian-sql", {"config": str(config), "migrate_config": str(migrate),
                                           "output": str(tmp_path / "accounts.sql"), "action": "create"})
    # The answer the shell reads names the accounts and nothing else.
    assert answer == {"ok": True, "written": str(tmp_path / "accounts.sql"), "database": "media_server",
                      "user": "media_server", "ddl_user": "media_server_ddl"}
    sql = (tmp_path / "accounts.sql").read_text(encoding="utf-8")
    assert "application-secret-value" in sql and tomllib.loads(migrate.read_text(encoding="utf-8"))["database"]["password"] in sql
    encoded = "\n".join(flat.encode({**made, **answer}))
    assert "secret" not in encoded and "password=" not in encoded.replace("fresh_password=", "")
    # A migration file that belongs to another configuration is not used.
    migrate.write_text(migrate.read_text(encoding="utf-8").replace("media_server_ddl", "somebody"), encoding="utf-8")
    refused = helper_cli.run("debian-sql", {"config": str(config), "migrate_config": str(migrate),
                                            "output": str(tmp_path / "x.sql"), "action": "create"})
    assert refused["ok"] is False and "nie pasuje" in refused["error"]
    dropped = helper_cli.run("debian-sql", {"config": str(config), "output": str(tmp_path / "drop.sql"), "action": "drop"})
    assert dropped["ok"] and "DROP DATABASE IF EXISTS `media_server`;" in (tmp_path / "drop.sql").read_text(encoding="utf-8")


# -- folders ----------------------------------------------------------------------------------


def test_a_media_folder_is_checked_the_way_the_service_will_meet_it() -> None:
    there = {"/srv/media/filmy", "/srv/media/filmy/2024", "/mnt/dysk/Muzyka"}

    def exists(path: str) -> bool:
        return path in there

    assert debian.folder_problems("/srv/media/filmy/", exists=exists) == ("/srv/media/filmy", [])
    assert debian.folder_problems("/srv/media/brak", exists=exists)[1][0]["code"] == "folder.missing"
    assert debian.folder_problems("/home/jan/Muzyka", exists=lambda _p: True)[1][0] == {
        "code": "folder.home", "args": ["/home/jan/Muzyka", "/home"]}
    nested = debian.folder_problems("/srv/media/filmy/2024", ["/srv/media/filmy"], exists=exists)[1]
    assert nested == [{"code": "folder.nested", "args": ["/srv/media/filmy/2024", "/srv/media/filmy"]}]
    assert debian.guess_kind("/mnt/dysk/Muzyka") == "music" and debian.guess_kind("/srv/Filmy i seriale") == "movies"
    assert debian.guess_kind("/srv/media/archiwum") == "mixed"


def test_nothing_an_uninstall_may_delete_can_be_given_as_a_media_folder() -> None:
    """"Media are never touched" has to hold by construction: the uninstall removes whole
    directories, so none of them may ever have been accepted as a place for media."""
    flows = (INSTALLER / "debian" / "lib" / "flows.sh").read_text(encoding="utf-8")
    allowed = re.search(r"remove_tree\(\) \{.*?case \"\$path\" in\n\s*([^\n]*?)\) ;;", flows, re.DOTALL)
    assert allowed is not None, "remove_tree ma listę katalogów wypisaną z nazwy"
    names = re.findall(r"\$([A-Z_]+)", allowed.group(1))
    assert sorted(names) == ["ACME_WEBROOT", "BACKUP_ROOT", "CONFIG_DIR", "LOG_DIR", "PREFIX", "STATE_DIR"]
    # Every `remove_tree X` in the script names one of them - never a path that was typed or computed.
    called = set(re.findall(r"^\s*remove_tree \"\$([A-Z_]+)\"$", flows, re.MULTILINE))
    assert called and called <= set(names)
    assert len(re.findall(r"^\s*remove_tree ", flows, re.MULTILINE)) == len(re.findall(r"^\s*remove_tree \"\$[A-Z_]+\"$", flows, re.MULTILINE))
    for name in names:
        directory = getattr(debian, name)
        for path in (directory, f"{directory}/filmy"):
            _clean, problems = debian.folder_problems(path, exists=lambda _p: True)
            assert problems and problems[0]["code"] in {"folder.own", "folder.system"}, path


def test_a_folder_keeps_its_identifier_and_linux_tells_upper_from_lower_case() -> None:
    answer = helper_cli.run("assign-ids", {
        "case_sensitive": "1",
        "folders": [{"path": "/srv/media/Filmy", "kind": "movies", "id": ""}, {"path": "/srv/media/filmy", "kind": "movies", "id": ""},
                    {"path": "/srv/Zażółć gęślą", "kind": "music", "id": ""}],
        "existing": [{"id": "kino", "path": "/srv/media/filmy"}],
    })
    assert [root["id"] for root in answer["roots"]] == ["filmy", "kino", "zazolc_gesla"]


def test_kinds_come_from_the_catalogue_when_it_answers_and_from_the_name_when_not(tmp_path: Path) -> None:
    report = tmp_path / "roots.json"
    report.write_text(json.dumps({"status": "ok", "roots": [{"id": "a", "kind": "mixed"}, {"id": "b", "kind": None}]}), encoding="utf-8")
    request = {"roots": [{"id": "a", "path": "/srv/Muzyka"}, {"id": "b", "path": "/srv/Filmy"}]}
    known = helper_cli.run("debian-kinds", {**request, "json_file": str(report)})["roots"]
    assert known == [{"id": "a", "kind": "mixed", "known": True}, {"id": "b", "kind": "movies", "known": False}]
    report.write_text("not json", encoding="utf-8")
    guessed = helper_cli.run("debian-kinds", {**request, "json_file": str(report)})["roots"]
    assert [root["kind"] for root in guessed] == ["music", "movies"]


def test_a_library_removed_earlier_keeps_its_identifier_out_of_reach(tmp_path: Path) -> None:
    # "filmy" left the configuration a run ago; the catalogue still lists it (switched off).
    report = tmp_path / "roots.json"
    report.write_text(json.dumps({"status": "ok", "roots": [{"id": "muzyka", "kind": "music"},
                                                            {"id": "filmy", "kind": "movies"}]}), encoding="utf-8")
    kinds = helper_cli.run("debian-kinds", {"roots": [{"id": "muzyka", "path": "/srv/media/muzyka"}],
                                            "json_file": str(report)})
    assert kinds["catalog_ids"] == ["filmy", "muzyka"]
    # What the shell sends to assign-ids, through the flat protocol: the catalogue's identifiers as `reserved`.
    request = flat.decode([
        "case_sensitive=1", "folders.count=1", "folders.0.path=/srv/nowe/Filmy", "folders.0.kind=movies", "folders.0.id=",
        "existing.count=1", "existing.0.id=muzyka", "existing.0.path=/srv/media/muzyka",
        "reserved.count=2", "reserved.0=filmy", "reserved.1=muzyka",
    ])
    assigned = helper_cli.run("assign-ids", request)["roots"]
    assert [root["id"] for root in assigned] == ["filmy2"]


# -- the plan ---------------------------------------------------------------------------------

MACHINE = {"lan_cidrs": ["192.168.1.20/24"], "lan_address": "192.168.1.20", "ssh_ports": ["22"], "ssh_client": "192.168.1.5",
           "ufw_active": "0", "has_build": "1", "default_site_enabled": "1", "https_sites": [], "listeners": ["445/tcp"]}


def _plan(access: dict, environment: dict | None = None, **sections: dict) -> tuple[dict, list[str], list[str]]:
    raw = {"flow": "install", "access": access, "folders": [{"path": "/srv/media/filmy", "kind": "movies"}],
           "admin": {"username": "jan", "password_file": "/root/haslo"}, **sections}
    answer = helper_cli.run("debian-plan", {"answers": raw, "env": {**MACHINE, **(environment or {})}})
    assert answer["ok"], answer
    return answer["plan"], [entry["code"] for entry in answer["problems"]], [entry["code"] for entry in answer["warnings"]]


def test_the_plan_of_a_standalone_server() -> None:
    plan, problems, warnings = _plan({"mode": "direct", "host_name": "media.example.org", "acme_agree_tos": True})
    assert problems == [] and plan["letter"] == "S"
    assert plan["sites"] == [debian.HTTP_SITE, debian.HTTPS_SITE] and plan["retired_sites"] == [] and plan["disable_sites"] == []
    assert plan["config"] == {"base_url": "https://media.example.org/", "proxy_trusted": "", "require_https": True}
    assert plan["certificate"] == {"kind": "letsencrypt", "file": "/etc/letsencrypt/live/media.example.org/fullchain.pem",
                                   "key": "/etc/letsencrypt/live/media.example.org/privkey.pem"}
    assert plan["firewall"]["enable"] is True and plan["fail2ban"] is True and "certbot" in plan["packages"]
    assert plan["addresses"] == [{"kind": "public", "url": "https://media.example.org/"}]
    # Another service of this machine would be cut off by the firewall: said before, not found out after.
    assert warnings == ["plan.listener_closed"]
    temporary, _p, _w = _plan({"mode": "direct", "host_name": "media.example.org", "certificate": "selfsigned"})
    assert temporary["certificate"]["file"] == debian.SELF_CERT and "certbot" not in temporary["packages"]


def test_the_plan_of_a_home_server_behind_a_vps() -> None:
    access = {"mode": "vps", "host_name": "media.example.org", "vps_addresses": ["203.0.113.10"], "home_address": "198.51.100.7"}
    plan, problems, warnings = _plan(access)
    # The machine's Samba (445/tcp) stays reachable from the home network only once ufw is on.
    assert problems == [] and warnings == ["plan.listener_lan_only"] and plan["letter"] == "P"
    assert plan["sites"] == [debian.HTTPS_SITE] and plan["retired_sites"] == [debian.HTTP_SITE]
    assert plan["config"] == {"base_url": "https://media.example.org/", "proxy_trusted": "203.0.113.10", "require_https": True}
    assert plan["certificate"] == {"kind": "origin", "file": debian.ORIGIN_CERT, "key": debian.ORIGIN_KEY}
    assert plan["fail2ban"] is False and plan["migrate_user"] == "media_server_ddl"
    assert plan["firewall"]["rules"] == ["allow from 192.168.1.0/24 comment tryhackx-media-reach",
                                         "allow proto tcp from 203.0.113.10 to any port 443 comment tryhackx-media"]
    # Another host on 443 would answer in our place (ours carries a neutral name): refused unless told to switch it off.
    _plan2, conflict, _w = _plan(access, {"https_sites": ["default-ssl"]})
    assert conflict == ["plan.https_conflict"]
    resolved, none, _w = _plan({**access, "disable_existing_https": True}, {"https_sites": ["default-ssl"]})
    assert none == [] and resolved["disable_sites"] == ["default-ssl"]
    with_lan, _p, _w = _plan({**access, "allow_lan": True})
    assert {"kind": "lan_secure", "url": "https://192.168.1.20/"} in with_lan["addresses"]


def test_the_plan_of_the_two_small_shapes() -> None:
    lan, problems, _w = _plan({"mode": "lan"})
    assert problems == [] and lan["sites"] == [debian.HTTP_SITE] and lan["retired_sites"] == [debian.HTTPS_SITE]
    assert lan["config"] == {"base_url": "", "proxy_trusted": "", "require_https": False}
    # Debian's default site is read first and would answer every request made by address.
    assert lan["disable_sites"] == ["000-default"] and lan["certificate"]["kind"] == "none"
    assert lan["addresses"][0] == {"kind": "lan", "url": "http://192.168.1.20/"}
    assert _plan({"mode": "lan"}, {"lan_cidrs": []})[1] == ["plan.lan_unknown"]
    assert _plan({"mode": "lan"}, {"lan_cidrs": []}, firewall={"lan_subnets": ["10.0.0.0/24"]})[1] == []

    local, problems, _w = _plan({"mode": "local"})
    assert problems == [] and local["firewall"] == {"manage": False, "enable": False, "rules": [], "subnets": ["192.168.1.0/24"]}
    assert local["config"]["require_https"] is True and "ufw" not in local["packages"]
    assert local["addresses"] == [{"kind": "local", "url": "http://localhost/"}]


# -- what a running Debian 13 server showed (13.11.2026: dry runs and read-only checks on one) ----

VPS_ACCESS = {"mode": "vps", "host_name": "media.example.org", "vps_addresses": ["203.0.113.10"], "home_address": "198.51.100.7"}


def test_a_firewall_somebody_else_runs_is_left_to_them() -> None:
    # nftables with its own tables for the services of that server: ufw on top would be a second
    # "drop the rest" that every packet must pass, and the tracker, the mail and the games would stop.
    for access, key in (
        ({"mode": "direct", "host_name": "media.example.org", "acme_agree_tos": True}, "plan.firewall_foreign_direct"),
        ({"mode": "lan"}, "plan.firewall_foreign_lan"),
        (VPS_ACCESS, "plan.firewall_foreign_vps"),
    ):
        plan, problems, warnings = _plan(access, {"foreign_firewall": "nftables"})
        assert problems == [] and key in warnings, warnings
        assert plan["firewall"]["manage"] is False and plan["firewall"]["enable"] is False and plan["firewall"]["rules"] == []
        assert "ufw" not in plan["packages"] and not [code for code in warnings if code.startswith("plan.listener")]
    # A ufw that is already on is somebody's ufw, the case the plan knew before.
    plan, _p, warnings = _plan({"mode": "lan"}, {"foreign_firewall": "nftables", "ufw_active": "1"})
    assert "plan.firewall_foreign_lan" not in warnings and plan["firewall"]["manage"] is True


def test_switching_ufw_on_names_what_it_closes_in_every_shape() -> None:
    listeners = {"listeners": ["6969/tcp", "6969/udp", "68/udp", "546/udp", "27015/udp"]}
    _plan_s, _p, direct = _plan({"mode": "direct", "host_name": "media.example.org", "acme_agree_tos": True}, listeners,
                                firewall={"extra_ports": ["27015/udp"]})
    assert direct == ["plan.listener_closed", "plan.listener_closed"], "6969 twice; DHCP clients and extra_ports are not closed"
    _plan_d, _p, lan = _plan({"mode": "lan"}, listeners)
    assert lan.count("plan.listener_lan_only") == 3 and "plan.listener_closed" not in lan
    _plan_p, _p, vps = _plan(VPS_ACCESS, {**listeners, "lan_cidrs": []})
    assert vps.count("plan.listener_closed") == 3, "no home network known: closed for everybody but the VPS"
    _plan_on, _p, already = _plan({"mode": "lan"}, {**listeners, "ufw_active": "1", "ufw_enabled_by_installer": "1"})
    assert not [code for code in already if code.startswith("plan.listener")], "ufw is on already: nothing new closes"


def test_without_a_terminal_whoever_is_connected_over_ssh_keeps_ssh() -> None:
    # `ssh host 'sudo bash zainstaluj-debian.sh …'`: sudo drops SSH_CONNECTION and `who am i` has no
    # terminal to name - seen on a real server. The addresses connected now stand in for the client.
    peers = {"ssh_client": "", "ssh_peers": ["203.0.113.50", "192.168.1.7", "::ffff:203.0.113.50"]}
    plan, _p, warnings = _plan({"mode": "lan"}, peers)
    assert "allow proto tcp from 203.0.113.50 to any port 22 comment tryhackx-media-reach" in plan["firewall"]["rules"]
    assert not [rule for rule in plan["firewall"]["rules"] if "192.168.1.7" in rule], "the home network is allowed already"
    assert "plan.ssh_peers" in warnings
    # A console with nobody connected: nothing to keep, nothing to say.
    console, _p, quiet = _plan({"mode": "lan"}, {"ssh_client": "", "ssh_peers": []})
    assert "plan.ssh_peers" not in quiet and console["firewall"]["rules"] == ["allow from 192.168.1.0/24 comment tryhackx-media-reach"]
    assert debian.firewall_rules(mode="lan", lan_subnets=["192.168.1.0/24"], ssh_client="203.0.113.77",
                                 ssh_peers=["198.51.100.1"]) == [
        ["allow", "from", "192.168.1.0/24", "comment", debian.FIREWALL_REACH_COMMENT],
        ["allow", "proto", "tcp", "from", "203.0.113.77", "to", "any", "port", "22", "comment", debian.FIREWALL_REACH_COMMENT],
    ], "a client the session names wins over the list of everybody connected"


def test_an_apache_that_hands_php_to_php_fpm_keeps_doing_so() -> None:
    # Debian's libapache2-mod-php switches Apache to prefork: every other site of the server would change.
    fpm = debian.packages("direct", certificate="letsencrypt", php_fpm="8.5")
    assert "libapache2-mod-php" not in fpm and not [name for name in fpm if name.startswith("php-")]
    assert {"php8.5-cli", "php8.5-mysql", "php8.5-mbstring", "php8.5-curl", "php8.5-xml"} <= set(fpm)
    assert "libapache2-mod-php" in debian.packages("direct", certificate="letsencrypt")
    assert {"proxy_fcgi", "setenvif"} <= set(debian.apache_modules("lan", php_fpm="8.5"))
    assert "proxy_fcgi" not in debian.apache_modules("lan")
    assert debian.php_fpm_version("8.5") == "8.5" and debian.php_fpm_version("8.5; reboot") == "" and debian.php_fpm_version("") == ""
    plan, _p, _w = _plan({"mode": "lan"}, {"php_fpm": "8.4"})
    assert plan["php_fpm"] == "8.4" and "php8.4-mysql" in plan["packages"] and "proxy_fcgi" in plan["modules"]


def test_the_plan_knows_whose_firewall_it_is_and_whether_there_is_a_frontend() -> None:
    access = {"mode": "vps", "host_name": "media.example.org", "vps_addresses": ["203.0.113.10"], "home_address": "198.51.100.7"}
    foreign, _p, _w = _plan(access, {"ufw_active": "1"})
    assert foreign["firewall"]["enable"] is False
    assert foreign["firewall"]["rules"] == ["allow proto tcp from 203.0.113.10 to any port 443 comment tryhackx-media"]
    # The firewall this installer switched on: the rules that keep the machine reachable are still ours to write.
    ours, _p, _w = _plan(access, {"ufw_active": "1", "ufw_enabled_by_installer": "1"})
    assert ours["firewall"]["enable"] is False and "allow from 192.168.1.0/24 comment tryhackx-media-reach" in ours["firewall"]["rules"]
    untouched, _p, _w = _plan(access, firewall={"manage": False})
    assert untouched["firewall"]["manage"] is False and untouched["firewall"]["rules"] == [] and "ufw" not in untouched["packages"]

    assert _plan({"mode": "local"}, {"has_build": "0"})[1] == ["plan.no_build"]
    building, problems, _w = _plan({"mode": "local"}, {"has_build": "0"}, options={"build_frontend": True})
    assert problems == [] and building["build_frontend"] is True and {"nodejs", "npm"} <= set(building["packages"])
    # A package that carries the build never pulls Node in, whatever the option says.
    packaged, _p, _w = _plan({"mode": "local"}, options={"build_frontend": True})
    assert packaged["build_frontend"] is False and "npm" not in packaged["packages"]


def test_a_clone_is_built_every_time_even_when_a_build_lies_in_it() -> None:
    # A build left in a clone (by an earlier run, or by hand) is the interface of an older pull.
    clone = {"has_build": "1", "has_sources": "1"}
    building, problems, warnings = _plan({"mode": "local"}, clone, options={"build_frontend": True})
    assert problems == [] and building["build_frontend"] is True and {"nodejs", "npm"} <= set(building["packages"])
    assert "plan.stale_build" not in warnings
    # An answers file that does not ask for the build: installed as it is, and said so.
    kept, problems, warnings = _plan({"mode": "local"}, clone)
    assert problems == [] and kept["build_frontend"] is False and "plan.stale_build" in warnings
    # Node and npm already there - NodeSource's nodejs carries npm and conflicts with Debian's package.
    with_node, _p, _w = _plan({"mode": "local"}, {**clone, "has_node": "1"}, options={"build_frontend": True})
    assert with_node["build_frontend"] is True and not {"nodejs", "npm"} & set(with_node["packages"])


def test_an_installation_made_by_hand_is_read_not_guessed_at() -> None:
    assert debian.infer_access({"base_url": "https://media.example.org/", "proxy_trusted": "203.0.113.10, 2001:db8::10"}) == {
        "mode": "vps", "host_name": "media.example.org", "vps_addresses": ["203.0.113.10", "2001:db8::10"], "inferred": True}
    assert debian.infer_access({"base_url": "https://media.example.org/"})["mode"] == "direct"
    assert debian.infer_access({"require_https": False})["mode"] == "lan"
    assert debian.infer_access({})["mode"] == "local"


# -- system files and the record of them ----------------------------------------------------------


def test_every_system_file_is_marked_and_a_script_keeps_its_first_line() -> None:
    unit = debian.marked("[Unit]\r\nDescription=x\r\n")
    assert unit == f"{debian.MARKER_LINE}\n[Unit]\nDescription=x\n" and debian.is_marked(unit)
    assert debian.marked(unit) == unit, "znacznik nie dokłada się drugi raz"
    assert debian.RENEW_HOOK_TEXT.splitlines()[:2] == ["#!/bin/sh", debian.MARKER_LINE]
    assert debian.marked("#!/bin/sh\necho x").splitlines() == ["#!/bin/sh", debian.MARKER_LINE, "echo x"]
    assert not debian.is_marked("# napisane ręcznie\n")


@pytest.mark.parametrize("name", [*debian.UNITS, "filter", "jail"])
def test_the_projects_own_files_are_installed_as_they_are_plus_the_marker(tmp_path: Path, name: str) -> None:
    source = {
        "filter": PROJECT_ROOT / "deploy/fail2ban/filter.d/tryhackx-media-auth.conf.example",
        "jail": PROJECT_ROOT / "deploy/fail2ban/jail.d/tryhackx-media.conf.example",
    }.get(name, PROJECT_ROOT / "deploy" / "systemd" / name)
    answer = helper_cli.run("debian-mark", {"source": str(source), "output": str(tmp_path / "out" / name)})
    assert answer["ok"]
    written = (tmp_path / "out" / name).read_bytes()
    assert b"\r" not in written, "jednostka z CR LF: systemd wziąłby CR za część wartości"
    lines = written.decode("utf-8").splitlines()
    assert lines[0] == debian.MARKER_LINE
    assert lines[1:] == source.read_text(encoding="utf-8").splitlines()


def test_the_helper_tells_our_files_from_somebody_elses(tmp_path: Path) -> None:
    ours, foreign = tmp_path / "ours.conf", tmp_path / "foreign.conf"
    ours.write_text(debian.marked("x\n"), encoding="utf-8")
    foreign.write_text("<VirtualHost *:80>\n</VirtualHost>\n", encoding="utf-8")
    answer = helper_cli.run("debian-marked", {"paths": [str(ours), str(foreign), str(tmp_path / "gone.conf")]})
    assert answer["ours"] == [str(ours)] and answer["foreign"] == [str(foreign)] and answer["missing"] == [str(tmp_path / "gone.conf")]


def test_the_record_of_an_installation_grows_and_never_holds_a_secret(tmp_path: Path) -> None:
    state_file = tmp_path / "installer.json"
    first = helper_cli.run("debian-state", {"state_file": str(state_file), "now": "2026-11-12T23:00:00", "update": {
        "install_completed": "0", "service_port": "8765", "files": ["/etc/a.conf"], "modules_enabled": ["ssl"],
        "access": {"mode": "vps", "allow_lan": "0", "vps_addresses": ["203.0.113.10"]},
        "firewall": {"managed": "1", "enabled_by_installer": "1", "rules": ["allow 80/tcp comment tryhackx-media"]},
    }})
    assert first["ok"]
    second = helper_cli.run("debian-state", {"state_file": str(state_file), "now": "2026-11-13T08:00:00", "update": {
        "install_completed": "1", "files": ["/etc/a.conf", "/etc/b.conf"], "modules_enabled": [],
        "access": {"mode": "direct"}, "firewall": {"rules": []},
    }})
    state = json.loads(state_file.read_text(encoding="utf-8"))
    assert state == second["state"]
    assert state["managed_by"] == debian.MARKER_TEXT and state["platform"] == "debian" and state["version"] == 1
    assert state["installed_at"] == "2026-11-12T23:00:00" and state["updated_at"] == "2026-11-13T08:00:00"
    # Yes/no and numbers are kept as what they are, although the shell sends text.
    assert state["install_completed"] is True and state["service_port"] == 8765
    assert state["firewall"] == {"managed": True, "enabled_by_installer": True, "rules": []}
    assert state["access"] == {"mode": "direct", "allow_lan": False, "vps_addresses": ["203.0.113.10"]}
    # What an earlier run wrote or switched on is still ours after a later one.
    assert state["files"] == ["/etc/a.conf", "/etc/b.conf"] and state["modules_enabled"] == ["ssl"]
    refused = helper_cli.run("debian-state", {"state_file": str(state_file), "update": {"database": {"password": "x"}}})
    assert refused["ok"] is False and "password" in refused["error"]
    read = helper_cli.run("debian-state-read", {"state_file": str(state_file)})
    assert read["found"] is True and read["state"]["access"]["mode"] == "direct"
    # A file that is not ours is not a state.
    state_file.write_text('{"version": 1}', encoding="utf-8")
    assert helper_cli.run("debian-state-read", {"state_file": str(state_file)})["found"] is False


# -- the bundle for the VPS -------------------------------------------------------------------


@pytest.fixture(scope="module")
def origin_certificate() -> str:
    import datetime

    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.x509.oid import NameOID

    key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "origin")])
    start = datetime.datetime(2026, 1, 1, tzinfo=datetime.UTC)
    certificate = (
        x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key())
        .serial_number(x509.random_serial_number()).not_valid_before(start)
        .not_valid_after(start + datetime.timedelta(days=3650)).sign(key, hashes.SHA256())
    )
    return certificate.public_bytes(serialization.Encoding.PEM).decode("ascii")


def _bundle(certificate: str, platform: str = "debian", **overrides: object) -> dict[str, str]:
    options: dict[str, object] = {
        "host_name": "media.example.org", "home_address": "198.51.100.7", "vps_addresses": ["203.0.113.10"],
        "lan_address": "192.168.1.20", "bundle_dir": debian.BUNDLE_DIR, "certificate_pem": certificate,
        "certificate_not_after": "2036-11-10", "generated": "2026-11-12", "platform": platform,
        "acme_email": "admin@example.org", "acme_agree": True,
    }
    options.update(overrides)
    return vpsbundle.render_bundle(VPS_TEMPLATES, vpsbundle.build_values(**options), certificate)  # type: ignore[arg-type]


def test_both_home_systems_get_the_same_bundle_with_the_script(origin_certificate: str) -> None:
    debian_files, windows_files = _bundle(origin_certificate), _bundle(origin_certificate, platform="windows")
    # The same files on both systems, the script included (audit P3-22: a Windows home gets its checks and rollback too).
    assert sorted(debian_files) == sorted(windows_files) and "vps-setup.sh" in windows_files
    # What the VPS is told to do is the same on both systems: the pin, the timeouts, the page.
    assert debian_files["maintenance.html"] == windows_files["maintenance.html"]
    assert debian_files["origin.crt"] == windows_files["origin.crt"]
    for site in ("tryhackx-media.conf", "tryhackx-media-ssl.conf"):
        assert _directives(debian_files[site]) == _directives(windows_files[site]), site
    for name, text in debian_files.items():
        assert not re.search(r"\{\{[A-Z0-9_]+\}\}", text), name
    for guide in ("INSTRUKCJA-VPS.md", "VPS-GUIDE.md"):
        text = debian_files[guide]
        for foreign in ("Zainstaluj.cmd", "PowerShell", "powershell", "WampServer", "Windows", "config\\origin"):
            assert foreign not in text, (guide, foreign)
        for expected in ("vps-setup.sh", "zainstaluj-debian.sh --zmien dostep", "--odnow", "/etc/tryhackx-media-server/origin/",
                         f"scp -r {debian.BUNDLE_DIR} root@203.0.113.10:/root/tryhackx-bundle", "ufw",
                         "a2enmod proxy proxy_http ssl headers", vpsbundle.certificate_fingerprint(origin_certificate)):
            assert expected in text, (guide, expected)
        assert "zainstaluj-debian" not in windows_files[guide] and "bash /root/tryhackx-bundle/vps-setup.sh" in windows_files[guide]
    # The script itself says nothing about the home system: the same words, only the guide's texts differ.
    assert "zainstaluj-debian" not in windows_files["vps-setup.sh"] and "Zainstaluj.cmd" not in windows_files["vps-setup.sh"]


def test_the_script_carries_the_bundles_own_files_and_nothing_it_could_say_differently(origin_certificate: str) -> None:
    files = _bundle(origin_certificate)
    script = files["vps-setup.sh"]
    assert script.startswith("#!/usr/bin/env bash\n# " + vpsbundle.SCRIPT_MARKER + "\n")
    assert "\nset -euo pipefail\n" in script and "\r" not in script
    embedded = vpsbundle.embedded_payloads(script)
    assert embedded == {name: files[name] for name in ("tryhackx-media.conf", "tryhackx-media-ssl.conf", "maintenance.html", "origin.crt")}
    for line in ("DOMAIN='media.example.org'", "HOME_TARGET='198.51.100.7'", "ACME_EMAIL='admin@example.org'", "ACME_AGREE='1'",
                 f"EXPECTED_FINGERPRINT='{vpsbundle.certificate_fingerprint(origin_certificate)}'", "LANGUAGE='pl'"):
        assert line in script.splitlines(), line
    # The proxy's promises are the templates', and the templates' are tested in test_setup_helper.py.
    site = _directives(embedded["tryhackx-media-ssl.conf"])
    assert "SSLProxyVerify require" in site and "SSLProxyCACertificateFile /etc/apache2/tryhackx-media/origin.crt" in site
    assert not any(line.startswith("ProxyErrorOverride") for line in site)
    assert "PRIVATE KEY" not in script
    assert _bundle(origin_certificate, language="en")["vps-setup.sh"].count("LANGUAGE='en'") == 1


def test_the_script_asks_before_it_agrees_to_anything_on_the_owners_behalf(origin_certificate: str) -> None:
    script = _bundle(origin_certificate, acme_agree=False, acme_email="")["vps-setup.sh"]
    assert "ACME_AGREE='0'" in script and "ACME_EMAIL=''" in script
    body = script.split("obtain_certificate() {", 1)[1].split("\n}\n", 1)[0]
    # --agree-tos is passed only inside the branch that checks the owner's recorded consent.
    assert body.index('if [[ "$ACME_AGREE" == "1" ]]; then') < body.index("--agree-tos")
    assert "--register-unsafely-without-email" in body


@pytest.mark.parametrize(
    ("overrides", "message"),
    [
        ({"acme_email": "admin@example.org'; rm -rf /"}, "adres e-mail"),
        ({"platform": "amiga"}, "platforma"),
        ({"language": "de"}, "język"),
        ({"generated": "2026\n11"}, "Niedozwolone znaki"),
        ({"home_address": "203.0.113.10"}, "dwie różne maszyny"),
    ],
)
def test_a_bundle_whose_script_could_not_be_trusted_is_refused(origin_certificate: str, overrides: dict, message: str) -> None:
    with pytest.raises(vpsbundle.BundleError, match=message):
        _bundle(origin_certificate, **overrides)


def test_the_guide_does_not_claim_a_firewall_nobody_set(origin_certificate: str) -> None:
    managed = _bundle(origin_certificate)["INSTRUKCJA-VPS.md"]
    assert "Zaporę (`ufw`) instalator już ustawił" in managed
    unmanaged = _bundle(origin_certificate, firewall_managed=False)
    assert "**nie wpuszcza tylko VPS-a**" in unmanaged["INSTRUKCJA-VPS.md"] and "już ustawił" not in unmanaged["INSTRUKCJA-VPS.md"]
    assert "does **not** admit the VPS only" in unmanaged["VPS-GUIDE.md"]
    # With a dynamic name nothing has to be redone when the home address changes.
    assert "--zmien dostep` z nowym adresem" in managed
    assert "z nowym adresem" not in _bundle(origin_certificate, home_address="dom.example.org")["INSTRUKCJA-VPS.md"]


def test_the_bundle_reaches_the_disk_through_the_helper_for_either_platform(tmp_path: Path, origin_certificate: str) -> None:
    certificate = tmp_path / "origin-cert.pem"
    certificate.write_text(origin_certificate, encoding="ascii")
    request = {"template_dir": str(VPS_TEMPLATES), "output_dir": str(tmp_path / "bundle"), "bundle_dir": debian.BUNDLE_DIR,
               "host_name": "media.example.org", "home_address": "198.51.100.7", "vps_addresses": ["203.0.113.10"],
               "certificate": str(certificate), "platform": "debian", "language": "en", "acme_agree": "1", "firewall_managed": "1"}
    answer = helper_cli.run("vps-bundle", request)
    assert answer["ok"] and "vps-setup.sh" in answer["files"] and len(answer["written"]) == 7
    script = (tmp_path / "bundle" / "vps-setup.sh").read_bytes()
    assert b"\r" not in script and b"LANGUAGE='en'" in script
    assert debian.BUNDLE_DIR in (tmp_path / "bundle" / "VPS-GUIDE.md").read_text(encoding="utf-8")
    # Left out, the platform is the Windows wizard's - with the same script since 13.11.2026.
    windows = helper_cli.run("vps-bundle", {key: value for key, value in request.items() if key not in {"platform", "language"}}
                             | {"output_dir": str(tmp_path / "windows")})
    assert windows["ok"] and "vps-setup.sh" in windows["files"] and len(windows["written"]) == 7
    assert b"\r" not in (tmp_path / "windows" / "vps-setup.sh").read_bytes()


# -- vps-setup.sh against a stand-in VPS ------------------------------------------------------


def _setup_script(machine: Machine, certificate_pem: str, **overrides: object) -> Path:
    files = _bundle(certificate_pem, **overrides)
    vpsbundle.write_bundle(machine.base / "bundle", files)
    return machine.base / "bundle" / "vps-setup.sh"


def _real_certificate(machine: Machine, name: str = "origin") -> str:
    return _make_certificate(machine, name, debian.certificate_config("origin")).read_text(encoding="ascii")


def test_the_vps_script_parses_and_explains_itself(tmp_path: Path, origin_certificate: str) -> None:
    machine = Machine(tmp_path)
    script = _setup_script(machine, origin_certificate)
    subprocess.run([machine.bash, "-n", script.as_posix()], check=True, capture_output=True)
    shown = machine.script(script, "--help")
    assert shown.returncode == 0 and "--odnow-start" in shown.stdout and "--dry-run" in shown.stdout
    assert vpsbundle.SCRIPT_MARKER not in shown.stdout
    assert machine.script(script, "--no-such-option").returncode == 2
    assert machine.commands == [], "pomoc niczego nie uruchamia"


def test_a_dry_run_on_the_vps_changes_nothing(tmp_path: Path) -> None:
    machine = Machine(tmp_path)
    script = _setup_script(machine, _real_certificate(machine))
    before = machine.digest()
    result = machine.script(script, "--dry-run")
    assert result.returncode == 0, result.stdout + result.stderr
    assert machine.digest() == before
    for expected in ("(dry-run) env DEBIAN_FRONTEND=noninteractive apt-get install -y apache2 certbot",
                     "(dry-run) a2enmod -q proxy_http", "(dry-run) a2ensite -q tryhackx-media-ssl", "(dry-run) apache2ctl configtest",
                     "(dry-run) certbot certonly --webroot -w", "--non-interactive --agree-tos -m admin@example.org"):
        assert expected in result.stdout, expected
    assert not [line for line in machine.commands if line.startswith(MUTATING)]


def test_the_vps_script_installs_checks_and_can_be_run_again(tmp_path: Path) -> None:
    machine = Machine(tmp_path)
    script = _setup_script(machine, _real_certificate(machine))
    result = machine.script(script)
    assert result.returncode == 0, result.stdout + result.stderr
    assert "Gotowe." in result.stdout and "odcisk zgodny" in result.stdout
    for site in ("tryhackx-media", "tryhackx-media-ssl"):
        text = machine.read(f"/etc/apache2/sites-available/{site}.conf")
        assert text.splitlines()[0] == f"# {vpsbundle.SCRIPT_MARKER}"
        assert machine.path(f"/etc/apache2/sites-enabled/{site}.conf").exists()
    assert machine.read("/etc/apache2/tryhackx-media/origin.crt") == (machine.base / "bundle" / "origin.crt").read_text(encoding="ascii")
    assert "Serwer jest chwilowo niedostępny" in machine.read("/var/www/tryhackx-media/maintenance.html")
    assert machine.read("/etc/letsencrypt/renewal-hooks/deploy/tryhackx-media-reload.sh").splitlines()[-1] == "systemctl reload apache2"
    # Port 80 answers the challenge before certbot is asked, and the 443 host is enabled only afterwards.
    order = [machine.position(part) for part in ("apt-get install", "a2enmod -q proxy", "a2ensite -q tryhackx-media", "certbot certonly",
                                                 "a2ensite -q tryhackx-media-ssl")]
    assert order == sorted(order)
    assert machine.position("apache2ctl configtest") < machine.position("certbot certonly")
    assert any(line.startswith("curl ") and "--resolve media.example.org:443:127.0.0.1" in line for line in machine.commands)

    # A second run on a VPS that is already set up: nothing is switched on twice, and
    # Apache is reloaded (connections stay), not restarted.
    machine.forget_commands()
    again = machine.script(script, env={"THX_STUB_MODULES": "proxy proxy_http ssl headers"})
    assert again.returncode == 0, again.stdout + again.stderr
    assert not [line for line in machine.commands if line.startswith("a2enmod")]
    assert "systemctl reload apache2" in machine.commands and "systemctl restart apache2" not in machine.commands
    assert machine.read("/etc/apache2/sites-available/tryhackx-media-ssl.conf").count(vpsbundle.SCRIPT_MARKER) == 1


def test_a_silent_home_is_reported_and_the_vps_stays_configured(tmp_path: Path) -> None:
    machine = Machine(tmp_path)
    script = _setup_script(machine, _real_certificate(machine))
    result = machine.script(script, env={"THX_STUB_HTTP": "503"})
    assert result.returncode == 3, result.stdout + result.stderr
    assert "nie odpowiada" in result.stdout and "przekierowanie portu 443" in result.stdout
    assert machine.path("/etc/apache2/sites-enabled/tryhackx-media-ssl.conf").exists(), "dom można naprawić bez wracania na VPS"
    # The same in English, for somebody who asked for it.
    english = machine.script(script, "--lang", "en", env={"THX_STUB_HTTP": "403"})
    assert english.returncode == 3 and "The home server refuses (403)" in english.stdout


def test_a_refused_configuration_is_undone_on_the_vps(tmp_path: Path) -> None:
    machine = Machine(tmp_path)
    script = _setup_script(machine, _real_certificate(machine))
    before = machine.digest()
    result = machine.script(script, env={"THX_STUB_CONFIGTEST": "1"})
    assert result.returncode == 1
    assert "Cofanie zmian" in result.stdout + result.stderr
    after = {name: digest for name, digest in machine.digest().items() if not name.startswith("var/backups/")}
    assert after == before, "po nieudanej próbie VPS wygląda jak przed nią"
    # A site that worked and stopped working after an update goes back as well.
    assert machine.script(script).returncode == 0
    working = machine.read("/etc/apache2/sites-available/tryhackx-media-ssl.conf")
    moved = _setup_script(machine, (machine.base / "bundle" / "origin.crt").read_text(encoding="ascii"), home_address="198.51.100.99")
    answers_of_the_site = machine.base / "http-queue.txt"
    answers_of_the_site.write_text("200\n503\n", encoding="ascii", newline="\n")
    broken = machine.script(moved, env={"THX_STUB_HTTP_QUEUE": answers_of_the_site.as_posix()})
    assert broken.returncode == 1, broken.stdout + broken.stderr
    assert "Przed zmiana strona dzialala, po zmianie odpowiada 503" in broken.stdout + broken.stderr
    assert machine.read("/etc/apache2/sites-available/tryhackx-media-ssl.conf") == working
    assert "198.51.100.99" not in working


def test_the_home_certificate_is_rotated_on_the_vps_in_two_steps(tmp_path: Path) -> None:
    machine = Machine(tmp_path)
    old, new = _real_certificate(machine, "old"), _real_certificate(machine, "new")
    assert machine.script(_setup_script(machine, old)).returncode == 0
    pin = "/etc/apache2/tryhackx-media/origin.crt"
    assert machine.read(pin).count("BEGIN CERTIFICATE") == 1

    script = _setup_script(machine, new)
    machine.forget_commands()
    started = machine.script(script, "--odnow-start")
    assert started.returncode == 0, started.stdout + started.stderr
    both = machine.read(pin)
    assert both.count("BEGIN CERTIFICATE") == 2 and old.strip() in both and new.strip() in both
    assert machine.position("apache2ctl configtest") < machine.position("systemctl reload apache2")
    # Asked twice, it does not pile the certificate up.
    assert machine.script(script, "--odnow-start").returncode == 0 and machine.read(pin) == both

    finished = machine.script(script, "--odnow-koniec")
    assert finished.returncode == 0, finished.stdout + finished.stderr
    assert machine.read(pin) == new.strip() + "\n"
    # Finishing too early - home still presents the other certificate, so the site stops
    # answering - is undone: the VPS goes back to trusting both.
    back = _setup_script(machine, old)
    assert machine.script(back, "--odnow-start").returncode == 0
    two = machine.read(pin)
    assert two.count("BEGIN CERTIFICATE") == 2
    answers_of_the_site = machine.base / "http-queue.txt"
    answers_of_the_site.write_text("200\n503\n", encoding="ascii", newline="\n")
    failed = machine.script(back, "--odnow-koniec", env={"THX_STUB_HTTP_QUEUE": answers_of_the_site.as_posix()})
    assert failed.returncode == 1 and machine.read(pin) == two


def test_two_certificates_that_cannot_be_trusted_together_change_nothing(tmp_path: Path) -> None:
    """Certificates without an authority key identifier (made elsewhere): OpenSSL finds only one of the two."""
    machine = Machine(tmp_path)
    plain = debian.certificate_config("origin").replace("authorityKeyIdentifier = keyid:always\n", "")
    old = _make_certificate(machine, "old", plain).read_text(encoding="ascii")
    new = _make_certificate(machine, "new", plain).read_text(encoding="ascii")
    assert machine.script(_setup_script(machine, old)).returncode == 0
    pin = "/etc/apache2/tryhackx-media/origin.crt"
    before = machine.read(pin)
    refused = machine.script(_setup_script(machine, new), "--odnow-start")
    assert refused.returncode == 1 and "niczego nie zmieniono" in refused.stdout + refused.stderr
    assert machine.read(pin) == before


def test_the_vps_script_removes_only_what_it_wrote(tmp_path: Path) -> None:
    machine = Machine(tmp_path)
    script = _setup_script(machine, _real_certificate(machine))
    assert machine.script(script).returncode == 0
    by_hand = machine.path("/etc/apache2/sites-available/tryhackx-media.conf")
    by_hand.write_text("<VirtualHost *:80>\n    ServerName media.example.org\n</VirtualHost>\n", encoding="utf-8")
    removed = machine.script(script, "--usun")
    assert removed.returncode == 0, removed.stdout + removed.stderr
    assert by_hand.exists() and "nie ma znacznika" in removed.stdout
    assert not machine.path("/etc/apache2/sites-available/tryhackx-media-ssl.conf").exists()
    assert not machine.path("/etc/apache2/tryhackx-media/origin.crt").exists()
    assert not machine.path("/etc/letsencrypt/renewal-hooks/deploy/tryhackx-media-reload.sh").exists()
    assert "certbot delete --cert-name media.example.org" in removed.stdout


# -- the installer against a stand-in machine -------------------------------------------------

PASSWORD = "stand-in-administrator-password"
ANSWERS = {
    "S": EXAMPLES / "answers-standalone.toml",
    "P": EXAMPLES / "answers-private-vps.toml",
    "D": EXAMPLES / "answers-lan.toml",
    "C": EXAMPLES / "answers-localhost.toml",
}


def _install(
    machine: Machine, shape: str, *arguments: str, env: dict[str, str] | None = None, password: bool = True
) -> subprocess.CompletedProcess[str]:
    given = {"TRYHACKX_ADMIN_PASSWORD": PASSWORD} if password else {}
    return machine.install(*arguments, "--answers", ANSWERS[shape].as_posix(), env={**given, **(env or {})})


def _answers(machine: Machine, name: str, text: str) -> str:
    path = machine.base / name
    path.write_text(text, encoding="utf-8", newline="\n")
    return path.as_posix()


def test_an_uninstall_names_what_it_leaves_behind(tmp_path: Path) -> None:
    # The database kept by default, with both its accounts, and a certificate certbot keeps trying
    # to renew: said before the confirmation, with a command that can be typed as given (audit P3-7).
    machine = Machine(tmp_path)
    assert _install(machine, "S").returncode == 0
    running = {"THX_STUB_ACTIVE": "apache2 mariadb tryhackx-media-transfer", "THX_STUB_UFW": "active"}
    removed = machine.install("--odinstaluj", "--answers", _answers(machine, "uninstall.toml", 'flow = "uninstall"\n'), env=running)
    assert removed.returncode == 0, _said(removed)
    summary = removed.stdout[: removed.stdout.index("Co zostanie usunięte") + 2000]
    assert "Zostaje baza „media_server” razem z kontami media_server i media_server_ddl" in summary
    assert "sudo certbot delete --cert-name media.example.org" in summary and "tę-samą-nazwę" not in removed.stdout
    assert not [line for line in machine.commands if "DROP DATABASE" in line or "DROP USER" in line]


NFT_OWN_RULES = ("table inet thx_fw {\n\tchain input {\n\t\ttype filter hook input priority filter; policy drop;\n"
                 "\t\tct state established,related accept\n\t\tudp dport 6969 accept\n\t}\n}")
NFT_STOCK = ("table inet filter {\n\tchain input {\n\t\ttype filter hook input priority filter;\n\t}\n"
             "\tchain forward {\n\t\ttype filter hook forward priority filter;\n\t}\n"
             "\tchain output {\n\t\ttype filter hook output priority filter;\n\t}\n}")
NFT_FAIL2BAN = ("table inet f2b-table {\n\tset addr-set-sshd {\n\t\ttype ipv4_addr\n\t\telements = { 198.51.100.9 }\n\t}\n"
                "\tchain f2b-chain {\n\t\ttype filter hook input priority filter - 1; policy accept;\n"
                "\t\ttcp dport 22 ip saddr @addr-set-sshd reject\n\t}\n}")


@pytest.mark.parametrize(("machine_env", "other"), [
    ({"THX_STUB_NFT_RULESET": NFT_OWN_RULES}, "nftables"),
    ({"THX_STUB_ACTIVE": "apache2 mariadb firewalld"}, "firewalld"),
    ({"THX_STUB_NFT_RULESET": NFT_STOCK}, ""),
    ({"THX_STUB_NFT_RULESET": NFT_FAIL2BAN}, ""),
], ids=["own-nftables", "firewalld", "debian-stock-nftables", "fail2ban-only"])
def test_a_machine_with_a_firewall_of_its_own_gets_no_ufw(tmp_path: Path, machine_env: dict, other: str) -> None:
    # Seen on a running Debian 13 server: its own nftables tables, and a plan that would have installed
    # ufw and switched it on over them. Debian's stock nftables.conf and fail2ban's table filter nothing.
    machine = Machine(tmp_path)
    result = _install(machine, "S", "--dry-run", password=False, env=machine_env)
    assert result.returncode == 0, _said(result)
    packages_line = next(line for line in result.stdout.splitlines() if "Pakiety Debiana" in line)
    assert ("ufw" in packages_line.split()) is not bool(other)
    assert ("(dry-run) ufw --force enable" in result.stdout) is not bool(other)
    assert (f"ten komputer ma już własną zaporę ({other})" in result.stdout) is bool(other)


def test_an_apache_with_php_fpm_gets_no_php_module(tmp_path: Path) -> None:
    # The server ran its sites through php8.5-fpm; libapache2-mod-php would have switched it to prefork
    # and a2enmod would have tried to load a PHP module next to FPM.
    machine = Machine(tmp_path)
    conf = machine.path("/etc/apache2/conf-enabled/php8.4-fpm.conf")
    conf.parent.mkdir(parents=True, exist_ok=True)
    conf.write_text('<FilesMatch ".+\\.ph(?:ar|p|tml)$">\n</FilesMatch>\n', encoding="utf-8", newline="\n")
    result = _install(machine, "C", env={"THX_STUB_NO_PHP_MODULE": "1"})
    assert result.returncode == 0, _said(result)
    assert "PHP: przez działające PHP-FPM 8.4" in result.stdout
    install = next(line for line in machine.commands if line.startswith("apt-get install"))
    assert "libapache2-mod-php" not in install and "php8.4-mysql" in install and "php-mysql" not in install
    assert "systemctl reload php8.4-fpm" in machine.commands
    assert "a2enmod -q proxy_fcgi" in machine.commands
    assert not [line for line in machine.commands if line.startswith("a2enmod") and " php" in line]
    # Without PHP-FPM the same machine gets its PHP module back, as before.
    other = Machine(tmp_path / "mod-php")
    assert _install(other, "C", env={"THX_STUB_NO_PHP_MODULE": "1"}).returncode == 0
    assert "a2enmod -q php8.4" in other.commands and "systemctl reload php8.4-fpm" not in other.commands


def test_without_a_terminal_ssh_stays_open_for_whoever_is_connected(tmp_path: Path) -> None:
    machine = Machine(tmp_path)
    result = _install(machine, "D", "--dry-run", password=False,
                      env={"THX_STUB_NO_TTY": "1", "THX_STUB_SSH_PEERS": "203.0.113.50:51234 [::ffff:192.168.1.7]:40000"})
    assert result.returncode == 0, _said(result)
    assert "(dry-run) ufw allow proto tcp from 203.0.113.50 to any port 22 comment tryhackx-media-reach" in result.stdout
    assert "from 192.168.1.7 " not in result.stdout, "the home network is let in already"
    assert "SSH spoza sieci domowej zostanie otwarte dla adresów połączonych teraz: 203.0.113.50" in result.stdout


def test_a_fail2ban_that_runs_already_is_reloaded_not_restarted(tmp_path: Path) -> None:
    machine = Machine(tmp_path)
    result = _install(machine, "S", env={"THX_STUB_ACTIVE": "apache2 mariadb fail2ban"})
    assert result.returncode == 0, _said(result)
    assert "systemctl reload fail2ban" in machine.commands and "systemctl restart fail2ban" not in machine.commands


def test_root_leaves_no_bytecode_in_the_unpacked_package() -> None:
    # Seen on a real Debian 13: the helper started by root wrote __pycache__ into the unpacked
    # package - a dry run included - and the folder could not be removed afterwards without sudo.
    common = (INSTALLER / "debian" / "lib" / "common.sh").read_text(encoding="utf-8")
    steps = (INSTALLER / "debian" / "lib" / "steps.sh").read_text(encoding="utf-8")
    assert '"$PYTHON" -I -B -X utf8 "$THX_INSTALLER/helper.py"' in common, "-I ignores PYTHONDONTWRITEBYTECODE"
    assert 'arguments=(-B "$INSTALL_PY" --config-only' in steps


def test_an_uninstall_where_nothing_was_installed_asks_nothing(tmp_path: Path) -> None:
    machine = Machine(tmp_path)
    result = machine.install("--odinstaluj")
    assert result.returncode == 0, _said(result)
    assert "nie ma czego odinstalować" in result.stdout
    assert machine.mutations() == []


def test_the_vps_script_installs_only_what_is_missing(tmp_path: Path) -> None:
    # On a VPS serving other sites, `apt-get install apache2` would upgrade Apache mid-script.
    machine = Machine(tmp_path)
    script = _setup_script(machine, _real_certificate(machine))
    present = machine.script(script, "--dry-run", env={"THX_STUB_INSTALLED": "apache2 certbot curl openssl ca-certificates"})
    assert present.returncode == 0, _said(present)
    assert "apt-get" not in present.stdout and "Wszystkie sa juz zainstalowane" in present.stdout
    partial = machine.script(script, "--dry-run", env={"THX_STUB_INSTALLED": "apache2 curl openssl ca-certificates"})
    assert "(dry-run) env DEBIAN_FRONTEND=noninteractive apt-get install -y certbot\n" in partial.stdout


def test_a_firewall_already_open_on_443_is_not_described_as_letting_in_the_vps_only(tmp_path: Path) -> None:
    # ufw was on before, with "Apache Full" letting anybody reach 443: the guide must say so (audit P3-3).
    machine = Machine(tmp_path)
    result = _install(machine, "P", env={"THX_STUB_UFW": "active", "THX_STUB_UFW_RULES": "Apache Full                ALLOW       Anywhere"})
    assert result.returncode == 0, _said(result)
    guide = machine.read(f"{debian.BUNDLE_DIR}/INSTRUKCJA-VPS.md")
    assert "**nie wpuszcza tylko VPS-a**" in guide and "Zaporę (`ufw`) instalator już ustawił" not in guide


def test_a_service_answering_over_udp_is_named_before_the_firewall_closes_it(tmp_path: Path) -> None:
    # A WireGuard on 51820/udp: ufw switched on by the installer closes it too (audit P3-2).
    machine = Machine(tmp_path)
    result = _install(machine, "S", "--dry-run", password=False, env={"THX_STUB_UDP_LISTENERS": "51820"})
    assert result.returncode == 0, _said(result)
    assert "port 51820/udp przestanie być osiągalny" in result.stdout


@pytest.mark.parametrize("shape", ["S", "P", "D", "C"])
def test_a_dry_run_shows_every_change_and_makes_none(tmp_path: Path, shape: str) -> None:
    machine = Machine(tmp_path)
    before = machine.digest()
    # The example file as it is shipped, and no password anywhere: a dry run creates no account.
    result = _install(machine, shape, "--dry-run", password=False)
    transcript = result.stdout
    assert result.returncode == 0, transcript + result.stderr
    assert machine.digest() == before, "tryb próbny nie może zapisać ani jednego pliku"
    assert machine.mutations() == [], "tryb próbny nie może uruchomić ani jednego polecenia zmieniającego system"
    assert "TRYB PRÓBNY" in transcript and "Tryb próbny zakończony: niczego nie zmieniono." in transcript
    assert PASSWORD not in transcript
    for expected in (
        "(dry-run) env DEBIAN_FRONTEND=noninteractive apt-get install -y python3 python3-venv apache2 libapache2-mod-php",
        "(dry-run) MEDIA_SERVER_DB_PASSWORD=******** ", "--config-only --non-interactive",
        "(dry-run) mariadb --protocol=socket   <<< CREATE DATABASE media_server; konta media_server (dane) i media_server_ddl",
        "--migrate --migrate-config", "--no-service --no-health",
        "(dry-run) zapis /etc/systemd/system/tryhackx-media-transfer.service (tryb 0644, właściciel root:root)",
        "      | ExecStart=/opt/tryhackx-media-server/current/.venv/bin/python -m media_server serve",
        "(dry-run) systemctl enable --now tryhackx-media-maintenance.timer tryhackx-media-digest.timer",
        "roots sync --disable-unconfigured --kind", "account-create --username jan --role super_admin --password-stdin",
        "(dry-run) apache2ctl configtest", "(dry-run) systemctl start --no-block tryhackx-media-maintenance.service",
        "(dry-run) zapis /etc/tryhackx-media-server/installer.json",
    ):
        assert expected in transcript, expected
    per_shape = {
        "S": ["Sposób dostępu: S - ", "certbot certonly --webroot -w /var/www/tryhackx-media -d media.example.org",
              "--non-interactive --agree-tos -m admin@example.org", "(dry-run) a2ensite -q tryhackx-media-ssl",
              "(dry-run) ufw allow 22/tcp comment tryhackx-media-reach", "(dry-run) ufw allow 443/tcp comment tryhackx-media",
              "(dry-run) ufw --force enable", "/etc/fail2ban/jail.d/tryhackx-media.conf", "--base-url https://media.example.org/",
              "      |     Header always set Strict-Transport-Security \"max-age=31536000\""],
        "P": ["Sposób dostępu: P - ", "--proxy-trusted 203.0.113.10", "(dry-run) openssl req -x509 -newkey ec",
              "      | CN = origin", "      | basicConstraints = critical, CA:FALSE",
              "(dry-run) ufw allow proto tcp from 203.0.113.10 to any port 443 comment tryhackx-media",
              "(dry-run) ufw allow from 192.168.1.0/24 comment tryhackx-media-reach", "      |     ServerName origin.invalid",
              "      |         Require ip 203.0.113.10", "vps-setup.sh, INSTRUKCJA-VPS.md",
              "scp /etc/tryhackx-media-server/vps-bundle/vps-setup.sh root@203.0.113.10:",
              "przekieruj port TCP 443 z zewnątrz na 192.168.1.20", "ma wskazywać na VPS (203.0.113.10)"],
        "D": ["Sposób dostępu: D - ", "require_https=0", "(dry-run) a2dissite -q 000-default",
              "(dry-run) ufw allow from 192.168.1.0/24 comment tryhackx-media-reach", "W sieci domowej: http://192.168.1.20/"],
        "C": ["Sposób dostępu: C - ", "Zapora: bez zmian", "      |         Require local", "Na tym komputerze: http://localhost/"],
    }[shape]
    for expected in per_shape:
        assert expected in transcript, expected
    if shape in "DC":
        assert "certbot" not in transcript and "openssl req" not in transcript
    if shape == "C":
        assert "(dry-run) ufw" not in transcript
    if shape == "P":
        assert "media.example.org" not in transcript.split("zapis /etc/apache2/sites-available/tryhackx-media-ssl.conf", 1)[1].split("a2ensite", 1)[0]
    # The log of a dry run is kept outside the machine it did not touch.
    assert list(machine.tmp.glob("tryhackx-media-setup-*.log"))


@pytest.fixture(scope="module")
def lifecycle(tmp_path_factory: pytest.TempPathFactory) -> dict:
    """One stand-in machine through its whole life: install (P), change folders, a change that fails, rotate, uninstall."""
    machine = Machine(tmp_path_factory.mktemp("lifecycle"))
    story: dict = {"machine": machine}
    media_before = (machine.root / "srv/media/muzyka/utwor.flac").read_bytes()
    story["media"] = media_before

    story["install"] = _install(machine, "P")
    story["install_commands"] = machine.commands
    story["state_after_install"] = json.loads(machine.read(debian.STATE_FILE)) if machine.path(debian.STATE_FILE).exists() else {}
    story["config_after_install"] = machine.read(debian.CONFIG) if machine.path(debian.CONFIG).exists() else ""
    story["site_after_install"] = machine.read(f"{debian.SITES_AVAILABLE}/{debian.HTTPS_SITE}.conf")
    quiet = machine.path("/etc/apache2/conf-available/tryhackx-media-quiet.conf")
    story["quiet_after_install"] = quiet.read_text(encoding="utf-8") if quiet.exists() else ""
    story["log_after_install"] = "".join(path.read_text(encoding="utf-8") for path in machine.path("/var/log").glob("tryhackx-media-setup-*.log"))
    running = {"THX_STUB_ACTIVE": "apache2 mariadb tryhackx-media-transfer", "THX_STUB_UFW": "active", "TRYHACKX_ADMIN_PASSWORD": PASSWORD}

    machine.forget_commands()
    folders = _answers(machine, "folders.toml", 'flow = "folders"\n\n[[folders]]\npath = "/srv/media/muzyka"\nkind = "music"\n\n'
                       '[[folders]]\npath = "/srv/media/seriale"\nkind = "movies"\n')
    story["folders"] = machine.install("--zmien", "foldery", "--answers", folders, env=running)
    story["folders_commands"] = machine.commands
    story["config_after_folders"] = machine.read(debian.CONFIG)

    machine.forget_commands()
    access = _answers(machine, "access.toml", 'flow = "access"\n\n[access]\nmode = "direct"\nhost_name = "media.example.org"\n'
                      'certificate = "selfsigned"\n')
    story["config_before_access"] = machine.read(debian.CONFIG)
    story["broken_access"] = machine.install("--zmien", "dostep", "--answers", access, env={**running, "THX_STUB_CONFIGTEST": "1"})
    story["broken_access_commands"] = machine.commands
    story["config_after_broken_access"] = machine.read(debian.CONFIG)
    story["site_after_broken_access"] = machine.read(f"{debian.SITES_AVAILABLE}/{debian.HTTPS_SITE}.conf")
    story["sites_after_broken_access"] = sorted(path.name for path in machine.path("/etc/apache2/sites-enabled").iterdir())
    story["state_after_broken_access"] = json.loads(machine.read(debian.STATE_FILE))

    machine.forget_commands()
    (machine.root / "root/.ssh").mkdir(parents=True)
    (machine.root / "root/.ssh/id_ed25519").write_text("stand-in\n", encoding="ascii")
    rotate = _answers(machine, "rotate.toml", 'flow = "rotate"\n\n[vps]\nrun = "ssh"\nssh_identity_file = "/root/.ssh/id_ed25519"\n'
                      'ssh_host_fingerprint = "SHA256:StandInFingerprintOfTheVpsForTestsOnly00000"\n')
    story["certificate_before_rotation"] = machine.read(debian.ORIGIN_CERT)
    # First an attempt the VPS refuses (stage 1): the bundle must not stay built around the new certificate.
    story["failed_rotate"] = machine.install("--odnow", "--answers", rotate, env={**running, "THX_STUB_SSH": "1"})
    story["bundle_script_after_failed_rotate"] = machine.read(f"{debian.BUNDLE_DIR}/vps-setup.sh")
    story["certificate_after_failed_rotate"] = machine.read(debian.ORIGIN_CERT)
    machine.forget_commands()
    story["rotate"] = machine.install("--odnow", "--answers", rotate, env=running)
    story["rotate_commands"] = machine.commands
    story["certificate_after_rotation"] = machine.read(debian.ORIGIN_CERT)
    story["bundle_certificate"] = machine.read(f"{debian.BUNDLE_DIR}/origin.crt")
    story["origin_files"] = sorted(path.name for path in machine.path(debian.CONFIG_DIR + "/origin").iterdir())

    # An update from the same package: the database is copied before anything migrates, and the
    # generated files are compared with what the new version would write (audit P2-6, P2-7).
    machine.forget_commands()
    update = _answers(machine, "update.toml", 'flow = "update"\n')
    story["update"] = machine.install("--zmien", "aktualizacja", "--answers", update, env=running)
    story["update_commands"] = machine.commands
    story["backups_after_update"] = sorted(path.name for path in machine.path("/var/backups/tryhackx-media-server/database").glob("*.sql.gz"))

    machine.forget_commands()
    logs_before = sorted(path.name for path in machine.path("/var/log").glob("tryhackx-media-setup-*.log"))
    story["status"] = machine.install("--status", env=running)
    story["status_logs"] = (logs_before, sorted(path.name for path in machine.path("/var/log").glob("tryhackx-media-setup-*.log")))

    machine.forget_commands()
    refused = _answers(machine, "uninstall-refused.toml", 'flow = "uninstall"\n\n[uninstall]\ndrop_database = true\nconfirm_database = "media"\n')
    story["uninstall_refused"] = machine.install("--odinstaluj", "--answers", refused, env=running)
    story["uninstall_refused_commands"] = machine.commands
    machine.forget_commands()
    uninstall = _answers(machine, "uninstall.toml", 'flow = "uninstall"\n\n[uninstall]\ndrop_database = true\n'
                         'confirm_database = "media_server"\nremove_data = true\n')
    story["uninstall"] = machine.install("--odinstaluj", "--answers", uninstall, env=running)
    story["uninstall_commands"] = machine.commands
    story["left"] = sorted(machine.digest())

    # Installing again over what the uninstall kept (the configuration and the keys), with the
    # administrator's account still in the database: picked up, not refused (audit P2-8, P3-20).
    machine.forget_commands()
    story["reinstall"] = _install(machine, "P", env={"THX_STUB_DB_USERS": "1"})
    story["reinstall_commands"] = machine.commands
    return story


def _said(result: subprocess.CompletedProcess[str]) -> str:
    return result.stdout + result.stderr


def test_the_private_shape_installs_in_the_order_that_works(lifecycle: dict) -> None:
    machine: Machine = lifecycle["machine"]
    result = lifecycle["install"]
    assert result.returncode == 0, _said(result)
    assert "Gotowe. Serwer jest zainstalowany." in result.stdout and "[x]" not in result.stdout
    commands: list[str] = lifecycle["install_commands"]

    def at(fragment: str, start: int = 0) -> int:
        for index, line in enumerate(commands):
            if index >= start and fragment in line:
                return index
        raise AssertionError(f"brak polecenia: {fragment}\n" + "\n".join(commands))

    # The planning may read the catalogue's identifiers before anything is installed (a kept
    # database, audit P3-10): the database step is the first query after the packages.
    order = [
        at("apt-get install -y"), at("systemctl enable --now mariadb"), at("a2enmod -q proxy_http"),
        at("mariadb --protocol=socket --batch --skip-column-names -e", at("a2enmod -q proxy_http")),
        at("release-debian.sh"), at("systemctl daemon-reload"), at("systemctl restart tryhackx-media-transfer.service"),
        at("roots sync --disable-unconfigured --kind muzyka=music --kind filmy=movies"), at("account-create --username jan"),
        at("ufw allow proto tcp from 203.0.113.10 to any port 443"), at("ufw --force enable"), at("a2ensite -q tryhackx-media-ssl"),
        at("apache2ctl configtest"), at("systemctl restart apache2"), at("systemctl enable --now tryhackx-media-maintenance.timer"),
        at("systemctl start --no-block tryhackx-media-maintenance.service"),
    ]
    assert order == sorted(order), "kroki w innej kolejności, niż wymaga tego instalacja"
    # The accounts exist before the release applies the migrations with one of them.
    statements = [index for index, line in enumerate(commands) if line == "mariadb --protocol=socket --batch --skip-column-names"]
    assert len(statements) == 1 and statements[0] < at("release-debian.sh")
    release = commands[at("release-debian.sh")]
    assert "--migrate --migrate-config" in release and "--no-service --no-health" in release and "--build-frontend" not in release
    # Behind a VPS nothing is asked of Let's Encrypt at home, and port 80 is not opened.
    assert not [line for line in commands if line.startswith(("certbot", "ssh ", "scp ")) or "80/tcp" in line]
    assert at("ufw allow from 192.168.1.0/24") < at("ufw --force enable"), "najpierw reguły, potem włączenie zapory"
    assert machine.base  # the machine is kept for the tests below


def test_the_installation_leaves_marked_files_a_private_configuration_and_a_record(lifecycle: dict) -> None:
    state = lifecycle["state_after_install"]
    assert state["install_completed"] is True and state["managed_by"] == debian.MARKER_TEXT and state["admin"] == "jan"
    assert state["access"]["mode"] == "vps" and state["access"]["vps_addresses"] == ["203.0.113.10"]
    assert state["access"]["certificate_file"] == debian.ORIGIN_CERT and state["bundle_dir"] == debian.BUNDLE_DIR
    assert state["database"] == {"name": "media_server", "user": "media_server", "ddl_user": "media_server_ddl", "created_by_installer": True}
    assert state["firewall"] == {"managed": True, "enabled_by_installer": True, "rules": [
        "allow from 192.168.1.0/24 comment tryhackx-media-reach", "allow proto tcp from 203.0.113.10 to any port 443 comment tryhackx-media"]}
    assert state["apache"] == {"sites": [debian.HTTPS_SITE], "disabled_sites": []}
    assert {f"{debian.SYSTEMD_DIR}/{unit}" for unit in debian.UNITS} <= set(state["files"])
    assert f"{debian.SITES_AVAILABLE}/{debian.HTTPS_SITE}.conf" in state["files"] and {"ssl", "proxy_http", "headers"} <= set(state["modules_enabled"])
    assert "password" not in json.dumps(state).lower() and "secret" not in json.dumps(state).lower()

    config = tomllib.loads(lifecycle["config_after_install"])
    assert config["app"] == {"base_url": "https://media.example.org/"} and config["proxy"] == {"trusted": "203.0.113.10"}
    assert config["roots"] == {"muzyka": {"path": "/srv/media/muzyka"}, "filmy": {"path": "/srv/media/filmy"}}
    assert config["database"]["user"] == "media_server" and len(config["database"]["password"]) >= 40

    site = lifecycle["site_after_install"]
    assert site.splitlines()[0] == debian.MARKER_LINE and "media.example.org" not in site
    assert "Require ip 203.0.113.10" in site and f'SSLCertificateFile "{debian.ORIGIN_CERT}"' in site


def test_no_secret_reaches_the_screen_the_log_or_a_command_line(lifecycle: dict) -> None:
    config = tomllib.loads(lifecycle["config_after_install"])
    secrets_ = [PASSWORD, config["database"]["password"], config["security"]["transfer_key"]]
    haystacks = {"transcript": _said(lifecycle["install"]), "log": lifecycle["log_after_install"],
                 "commands": "\n".join(lifecycle["install_commands"])}
    for name, text in haystacks.items():
        for secret in secrets_:
            assert secret not in text, name
    assert "MEDIA_SERVER_DB_PASSWORD=********" in haystacks["transcript"]
    assert "(hasło administratora - przez standardowe wejście)" in haystacks["transcript"]
    assert lifecycle["log_after_install"], "zapis przebiegu trafia do /var/log"


def test_the_home_certificate_is_a_server_certificate_and_the_owner_is_told_what_to_do_with_it(lifecycle: dict) -> None:
    machine: Machine = lifecycle["machine"]
    result = lifecycle["install"]
    # The two commands for the VPS, with the real values in them.
    assert "scp /etc/tryhackx-media-server/vps-bundle/vps-setup.sh root@203.0.113.10:" in result.stdout
    assert "ssh -t root@203.0.113.10 'bash vps-setup.sh --lang pl'" in result.stdout
    assert "ma wskazywać na VPS (203.0.113.10)" in result.stdout and "na 192.168.1.20, port 443" in result.stdout
    fingerprint = result.stdout.split("Odcisk certyfikatu serwera domowego (SHA-256): ", 1)[1].splitlines()[0]
    assert fingerprint == vpsbundle.certificate_fingerprint(lifecycle["certificate_before_rotation"])
    # The certificate the installer really made (OpenSSL ran for real): a server's, naming nobody.
    made = machine.base / "made-by-the-installer.pem"
    made.write_text(lifecycle["certificate_before_rotation"], encoding="ascii", newline="\n")
    printed = _openssl(machine, "x509", "-in", made.as_posix(), "-noout", "-text").stdout
    assert "CA:FALSE" in printed and "TLS Web Server Authentication" in printed and "Authority Key Identifier" in printed
    assert "Subject: CN=origin" in printed.replace(" = ", "=") and "media.example.org" not in printed
    # The bundle holds addresses: it is made root's own.
    assert any(line.startswith("chown -R root:root ") and line.endswith("/vps-bundle") for line in lifecycle["install_commands"])


def test_folders_change_in_the_configuration_only_and_the_catalogue_is_told(lifecycle: dict) -> None:
    result = lifecycle["folders"]
    assert result.returncode == 0, _said(result)
    assert "[roots.filmy] usunięte" in result.stdout and "[roots.seriale] dodane: /srv/media/seriale" in result.stdout
    before, after = tomllib.loads(lifecycle["config_after_install"]), tomllib.loads(lifecycle["config_after_folders"])
    assert after["roots"] == {"muzyka": {"path": "/srv/media/muzyka"}, "seriale": {"path": "/srv/media/seriale"}}
    assert {k: v for k, v in after.items() if k != "roots"} == {k: v for k, v in before.items() if k != "roots"}
    commands = lifecycle["folders_commands"]
    restart = next(i for i, line in enumerate(commands) if line == "systemctl restart tryhackx-media-transfer.service")
    sync = next(i for i, line in enumerate(commands) if "roots sync --disable-unconfigured --kind muzyka=music --kind seriale=movies" in line)
    assert restart < sync, "usługa musi znać nowe foldery, zanim katalog je zarejestruje"
    assert any(line == "systemctl start --no-block tryhackx-media-maintenance.service" for line in commands)
    # Nothing about Apache, the firewall or packages is touched by a change of folders.
    assert not [line for line in commands if line.startswith(("apt-get", "a2", "ufw allow", "ufw delete", "certbot"))]


def test_a_change_of_access_that_apache_refuses_is_undone_everywhere(lifecycle: dict) -> None:
    result = lifecycle["broken_access"]
    assert result.returncode == 1
    said = _said(result)
    assert "Apache odrzucił nową konfigurację" in said and "Przywracam poprzednią konfigurację dostępu" in said
    assert lifecycle["config_after_broken_access"] == lifecycle["config_before_access"], "konfiguracja wróciła co do bajtu"
    assert lifecycle["site_after_broken_access"] == lifecycle["site_after_install"], "plik Apache wrócił co do bajtu"
    assert lifecycle["sites_after_broken_access"] == ["000-default.conf", f"{debian.HTTPS_SITE}.conf"]
    assert lifecycle["state_after_broken_access"]["access"]["mode"] == "vps", "zapis stanu nie twierdzi, że zmiana weszła"
    commands = lifecycle["broken_access_commands"]
    opened = next(i for i, line in enumerate(commands) if line == "ufw allow 443/tcp comment tryhackx-media")
    closed = next(i for i, line in enumerate(commands) if line == "ufw delete allow 443/tcp comment tryhackx-media")
    restored = next(i for i, line in enumerate(commands) if line == "ufw allow proto tcp from 203.0.113.10 to any port 443 comment tryhackx-media"
                    and i > opened)
    assert opened < closed < restored, "zapora wraca do reguł poprzedniego kształtu"
    assert not [line for line in commands if line.startswith(("systemctl reload apache2", "systemctl restart apache2"))], \
        "Apache nie jest przeładowywany z odrzuconą konfiguracją"


def test_the_home_certificate_is_rotated_in_four_steps_without_a_gap(lifecycle: dict) -> None:
    result = lifecycle["rotate"]
    assert result.returncode == 0, _said(result)
    commands = lifecycle["rotate_commands"]
    remote = [line for line in commands if line.startswith("ssh ") and "tryhackx-vps-setup.sh" in line]
    assert len(remote) == 2 and remote[0].endswith("--odnow-start") and remote[1].endswith("--odnow-koniec")
    for line in remote:
        # Only the confirmed key of the VPS is trusted, and nobody is there to type a password.
        assert "StrictHostKeyChecking=yes" in line and "UserKnownHostsFile=" in line and "BatchMode=yes" in line and " -t " not in f" {line} "
    start = commands.index(remote[0])
    switch = next(i for i, line in enumerate(commands) if line == "systemctl reload apache2")
    check = next(i for i, line in enumerate(commands) if line.startswith("curl") and "--resolve media.example.org:443:203.0.113.10" in line)
    finish = commands.index(remote[1])
    assert start < switch < check < finish, "ufaj obu → przełącz dom → sprawdź przez VPS → ufaj tylko nowemu"
    assert commands.index("apache2ctl configtest") < switch
    assert lifecycle["certificate_after_rotation"] != lifecycle["certificate_before_rotation"]
    assert lifecycle["bundle_certificate"].strip() == lifecycle["certificate_after_rotation"].strip()
    assert lifecycle["origin_files"] == ["origin-cert.pem", "origin-key.pem"], "po udanej wymianie nie zostają kopie kluczy"
    assert "VPS ufa już wyłącznie nowemu certyfikatowi" in result.stdout


def test_a_rotation_the_vps_refuses_leaves_the_bundle_with_the_certificate_in_use(lifecycle: dict) -> None:
    failed = lifecycle["failed_rotate"]
    assert failed.returncode == 1 and "paczka dla VPS-a wraca do starego certyfikatu" in _said(failed)
    # The home server still serves the old certificate, and the bundle pins exactly that one again (audit P2-5).
    assert lifecycle["certificate_after_failed_rotate"] == lifecycle["certificate_before_rotation"]
    expected = vpsbundle.certificate_fingerprint(lifecycle["certificate_after_failed_rotate"])
    assert f"EXPECTED_FINGERPRINT='{expected}'" in lifecycle["bundle_script_after_failed_rotate"]


def test_an_update_copies_the_database_first_and_brings_the_generated_files_along(lifecycle: dict) -> None:
    result = lifecycle["update"]
    assert result.returncode == 0, _said(result)
    out = result.stdout
    # The copy comes before the release, which is what migrates.
    assert out.index("Kopia bazy przed migracjami") < out.index("Wydanie programu")
    assert [name for name in lifecycle["backups_after_update"] if name.startswith("media_server-")], lifecycle["backups_after_update"]
    # The same package: the sites and the VPS bundle come out the same, and nothing is reloaded for them.
    assert "Strony Apache bez zmian" in out and "To, co działa na VPS-ie, się nie zmieniło" in out
    assert "systemctl reload apache2" not in lifecycle["update_commands"]


def test_an_update_whose_database_copy_fails_stops_before_the_release(tmp_path: Path) -> None:
    # mariadb-dump fails, gzip does not: without pipefail that was an empty "backup" and a migration
    # with nothing to go back to. Half a copy is removed, not kept (audit P2-7).
    machine = Machine(tmp_path)
    assert _install(machine, "C").returncode == 0
    machine.forget_commands()
    running = {"THX_STUB_ACTIVE": "apache2 mariadb tryhackx-media-transfer", "TRYHACKX_ADMIN_PASSWORD": PASSWORD,
               "THX_STUB_DUMP_FAILS": "1"}
    result = machine.install("--zmien", "aktualizacja", "--answers", _answers(machine, "update.toml", 'flow = "update"\n'), env=running)
    assert result.returncode != 0
    said = _said(result)
    assert "Kopia bazy media_server się nie udała - migracje nie zostały uruchomione" in said
    assert "Wydanie programu" not in said
    assert not [line for line in machine.commands if "release-debian.sh" in line]
    assert not list(machine.path("/var/backups/tryhackx-media-server/database").glob("*.sql.gz"))


def _without_node() -> dict[str, str]:
    """A PATH without the folders that hold node or npm: a machine where Node.js is not installed."""
    names = ("node", "node.exe", "npm", "npm.cmd")
    folders = [folder for folder in os.environ.get("PATH", "").split(os.pathsep)
               if folder and not any((Path(folder) / name).exists() for name in names)]
    return {"PATH": os.pathsep.join(folders)}


@pytest.mark.parametrize("layout", ["clone", "built-clone"])
def test_an_update_from_a_clone_builds_the_interface_in_the_new_release(tmp_path: Path, layout: str) -> None:
    # `git pull` in the clone, then --zmien -> aktualizacja: the release is built from what was pulled,
    # also when a build from an earlier run lies in the clone. Node.js and npm come from Debian first.
    machine = Machine(tmp_path)
    assert _install(machine, "C").returncode == 0
    machine.forget_commands()
    running = {"THX_STUB_ACTIVE": "apache2 mariadb tryhackx-media-transfer", "TRYHACKX_ADMIN_PASSWORD": PASSWORD,
               "TRYHACKX_SOURCE_LAYOUT": layout, **_without_node()}
    result = machine.install("--zmien", "aktualizacja", "--answers", _answers(machine, "update.toml", 'flow = "update"\n'), env=running)
    assert result.returncode == 0, _said(result)
    out = result.stdout
    assert out.index("Kopia bazy przed migracjami") < out.index("Node.js i npm do zbudowania interfejsu") < out.index("Wydanie programu")
    commands = machine.commands
    install = next(index for index, line in enumerate(commands) if line.startswith("apt-get install"))
    release = next(index for index, line in enumerate(commands) if line.startswith("release-debian.sh"))
    assert commands[install] == "apt-get install -y nodejs npm" and install < release
    assert "--build-frontend" in commands[release]


def test_an_update_from_a_clone_builds_with_the_node_that_is_there(tmp_path: Path) -> None:
    # NodeSource's nodejs carries its own npm and conflicts with Debian's package: nothing is installed beside it.
    machine = Machine(tmp_path)
    stub = (STUBS / "system-command.sh").read_bytes().replace(b"\r\n", b"\n")
    for name in ("node", "npm"):
        (machine.bin / name).write_bytes(stub)
        (machine.bin / name).chmod(0o755)
    assert _install(machine, "C").returncode == 0
    machine.forget_commands()
    running = {"THX_STUB_ACTIVE": "apache2 mariadb tryhackx-media-transfer", "TRYHACKX_ADMIN_PASSWORD": PASSWORD,
               "TRYHACKX_SOURCE_LAYOUT": "clone"}
    result = machine.install("--zmien", "aktualizacja", "--answers", _answers(machine, "update.toml", 'flow = "update"\n'), env=running)
    assert result.returncode == 0, _said(result)
    assert "Node.js i npm do zbudowania interfejsu" in result.stdout
    assert not [line for line in machine.commands if line.startswith("apt-get")]
    assert "--build-frontend" in next(line for line in machine.commands if line.startswith("release-debian.sh"))


def test_an_update_from_a_package_builds_nothing_and_installs_no_node(tmp_path: Path) -> None:
    machine = Machine(tmp_path)
    assert _install(machine, "C").returncode == 0
    machine.forget_commands()
    running = {"THX_STUB_ACTIVE": "apache2 mariadb tryhackx-media-transfer", "TRYHACKX_ADMIN_PASSWORD": PASSWORD}
    result = machine.install("--zmien", "aktualizacja", "--answers", _answers(machine, "update.toml", 'flow = "update"\n'), env=running)
    assert result.returncode == 0, _said(result)
    assert "Node.js i npm do zbudowania interfejsu" not in result.stdout
    assert not [line for line in machine.commands if line.startswith("apt-get")]
    assert "--build-frontend" not in next(line for line in machine.commands if line.startswith("release-debian.sh"))


def test_behind_a_vps_apache_stops_naming_its_version_and_the_uninstall_takes_that_back(lifecycle: dict) -> None:
    # Debian's security.conf says "ServerTokens OS" and signs error pages; P is a public shape (audit P3-4).
    quiet = lifecycle["quiet_after_install"]
    assert "TRYHACKX-MEDIA-SERVER-MANAGED" in quiet and "ServerTokens Prod" in quiet and "ServerSignature Off" in quiet
    assert "Header always unset X-Powered-By" in quiet
    assert "a2enconf -q tryhackx-media-quiet" in lifecycle["install_commands"]
    assert "a2disconf -q tryhackx-media-quiet" in lifecycle["uninstall_commands"]
    assert "etc/apache2/conf-available/tryhackx-media-quiet.conf" not in lifecycle["left"]


def test_what_an_uninstall_kept_is_used_by_the_next_installation(lifecycle: dict) -> None:
    result = lifecycle["reinstall"]
    assert result.returncode == 0, _said(result)
    assert "Konfiguracja i klucze z poprzedniej instalacji zostały zachowane" in result.stdout
    assert "Konto jan już jest w bazie - zostaje ze swoim dotychczasowym hasłem" in result.stdout
    assert not [line for line in lifecycle["reinstall_commands"] if "account-create" in line]


def test_status_says_what_is_installed_and_asks_nothing(lifecycle: dict) -> None:
    result = lifecycle["status"]
    assert result.returncode == 0, _said(result)
    before, after = lifecycle["status_logs"]
    assert before and after == before, "a status only reads: no log of its own in /var/log (seen on a real Debian 13)"
    for expected in ("Stan instalacji", "prywatny serwer domowy za publicznym VPS-em", "Domena: media.example.org",
                     "tryhackx-media-transfer: działa (port 8765)", "muzyka: /srv/media/muzyka  [Muzyka]", "seriale: /srv/media/seriale  [Filmy]"):
        assert expected in result.stdout, expected


def test_the_database_is_dropped_only_when_its_name_is_typed(lifecycle: dict) -> None:
    refused = lifecycle["uninstall_refused"]
    assert refused.returncode == 1 and "wymaga potwierdzenia jej nazwą (media_server)" in _said(refused)
    changed = [line for line in lifecycle["uninstall_refused_commands"] if line.startswith(MUTATING) and "roots list" not in line]
    assert changed == [], "odmowa przed pierwszą zmianą"


def test_uninstall_removes_what_the_installer_made_and_never_the_media(lifecycle: dict) -> None:
    machine: Machine = lifecycle["machine"]
    result = lifecycle["uninstall"]
    assert result.returncode == 0, _said(result)
    assert "pliki z mediami zostały nietknięte" in result.stdout
    commands = lifecycle["uninstall_commands"]
    assert "systemctl disable --now tryhackx-media-maintenance.timer tryhackx-media-digest.timer" in commands
    assert "a2dissite -q tryhackx-media-ssl" in commands and "systemctl reload apache2" in commands
    assert "ufw delete allow proto tcp from 203.0.113.10 to any port 443 comment tryhackx-media" in commands
    assert "ufw disable" not in commands, "zapora zostaje włączona, dopóki ktoś nie zdecyduje inaczej"
    # ufw stays on, so the rule that lets the home network in (SSH, shares) stays with it: deleting it
    # left a server nobody could reach after logging out (audit P0-1).
    assert not [line for line in commands if line.startswith("ufw delete") and "tryhackx-media-reach" in line]
    assert "zostaje reguła dostępu: allow from 192.168.1.0/24 comment tryhackx-media-reach" in result.stdout
    assert "mariadb --protocol=socket --batch --skip-column-names" in commands
    assert not [line for line in commands if line.startswith("apt-get")], "pakiety zostają"
    left: list[str] = lifecycle["left"]
    gone = ("etc/systemd/system/tryhackx-media", "etc/apache2/sites-available/tryhackx-media", "etc/apache2/sites-enabled/tryhackx-media",
            "opt/tryhackx-media-server", "var/backups/tryhackx-media-server", "etc/tryhackx-media-server/installer.json")
    assert not [name for name in left if name.startswith(gone)], left
    # Not asked for: the configuration and the keys stay, so a new installation can pick them up.
    assert "etc/tryhackx-media-server/config.local.toml" in left and "etc/tryhackx-media-server/origin/origin-key.pem" in left
    assert "etc/apache2/sites-enabled/000-default.conf" in left
    assert (machine.root / "srv/media/muzyka/utwor.flac").read_bytes() == lifecycle["media"]


def test_a_standalone_server_gets_its_certificate_before_its_https_host(tmp_path: Path) -> None:
    machine = Machine(tmp_path)
    result = _install(machine, "S")
    assert result.returncode == 0, _said(result)
    order = [machine.position(part) for part in (
        "ufw allow 80/tcp", "ufw --force enable", "a2ensite -q tryhackx-media", "apache2ctl configtest",
        "certbot certonly --webroot -w /var/www/tryhackx-media -d media.example.org", "a2ensite -q tryhackx-media-ssl",
        "systemctl restart fail2ban")]
    assert order == sorted(order), "port 80 otwarty i obsłużony → certbot → host 443 → fail2ban"
    certbot = machine.commands[machine.position("certbot certonly")]
    for part in ("--non-interactive", "--agree-tos", "-m admin@example.org", "--keep-until-expiring"):
        assert part in certbot, part
    for path in (debian.FAIL2BAN_FILTER, debian.FAIL2BAN_JAIL, debian.RENEW_HOOK, f"{debian.SITES_AVAILABLE}/{debian.HTTP_SITE}.conf",
                 f"{debian.SITES_AVAILABLE}/{debian.HTTPS_SITE}.conf"):
        assert debian.MARKER_TEXT in machine.read(path), path
    assert machine.path("/var/www/tryhackx-media/.well-known/acme-challenge").is_dir()
    site = machine.read(f"{debian.SITES_AVAILABLE}/{debian.HTTPS_SITE}.conf")
    assert 'SSLCertificateFile "/etc/letsencrypt/live/media.example.org/fullchain.pem"' in site and "Require all granted" in site
    state = json.loads(machine.read(debian.STATE_FILE))
    assert state["access"]["certificate"] == "letsencrypt" and state["fail2ban"] == {"installed": True}
    assert state["firewall"]["rules"] == ["allow 22/tcp comment tryhackx-media-reach", "allow 80/tcp comment tryhackx-media",
                                          "allow 443/tcp comment tryhackx-media"]
    assert "proxy" not in tomllib.loads(machine.read(debian.CONFIG))


def test_without_a_certificate_nothing_is_left_half_enabled(tmp_path: Path) -> None:
    """Unattended, Let's Encrypt refuses (DNS not ready): no temporary certificate is made behind the owner's back."""
    machine = Machine(tmp_path)
    result = _install(machine, "S", env={"THX_STUB_CERTBOT": "1"})
    assert result.returncode == 1 and "Let's Encrypt nie wydał certyfikatu dla media.example.org" in _said(result)
    assert sorted(path.name for path in machine.path("/etc/apache2/sites-enabled").iterdir()) == ["000-default.conf"]
    assert not machine.path(f"{debian.SITES_AVAILABLE}/{debian.HTTPS_SITE}.conf").exists()
    assert not machine.path(debian.SELF_CERT).exists()
    # The run is remembered as unfinished, and the next one — with DNS in place — completes it.
    stopped = json.loads(machine.read(debian.STATE_FILE))
    assert stopped["install_completed"] is False
    # The firewall step came before Let's Encrypt: its switch-on and its rules are on record already,
    # so a resume or an uninstall still knows them (audit P2-4).
    assert stopped["firewall"]["enabled_by_installer"] is True
    assert "allow 22/tcp comment tryhackx-media-reach" in stopped["firewall"]["rules"]
    machine.forget_commands()
    again = _install(machine, "S")
    assert again.returncode == 0, _said(again)
    assert "Znaleziono niedokończoną instalację" in again.stdout and "Konfiguracja już istnieje i nie zostanie nadpisana" in again.stdout
    assert "Konto jan zostało utworzone w poprzednim podejściu" in again.stdout
    assert not [line for line in machine.commands if "account-create" in line], "konto z pierwszego podejścia nie jest zakładane drugi raz"
    assert json.loads(machine.read(debian.STATE_FILE))["install_completed"] is True
    # And once it is complete, installing again is refused instead of repeated.
    third = _install(machine, "S")
    assert third.returncode == 1 and "Serwer jest już zainstalowany" in _said(third)


def test_an_answers_file_with_a_password_or_a_typo_stops_before_anything_is_looked_at(tmp_path: Path) -> None:
    machine = Machine(tmp_path)
    bad = _answers(machine, "bad.toml", 'flow = "install"\n\n[access]\nmode = "lan"\nhost = "x"\n\n[[folders]]\npath = "/home/jan/muzyka"\n'
                   'kind = "music"\n\n[admin]\nusername = "jan"\npassword = "hunter2hunter2"\n')
    result = machine.install("--answers", bad)
    assert result.returncode == 2
    for expected in ("zawiera błędy", "nieznany klucz „access.host”", "leży w /home", "hasła nie podaje się w pliku odpowiedzi"):
        assert expected in result.stdout, expected
    assert "hunter2hunter2" not in _said(result)
    assert machine.commands == []
    # The file may name the language of the run; --lang on the command line wins over it.
    english = _answers(machine, "english.toml", 'flow = "install"\nlanguage = "en"\n\n[access]\nmode = "lan"\nhost = "x"\n')
    result = machine.install("--answers", english)
    assert result.returncode == 2 and "has errors" in result.stdout and 'unknown key "access.host"' in result.stdout
    result = machine.install("--answers", english, "--lang", "pl")
    assert result.returncode == 2 and "zawiera błędy" in result.stdout and "nieznany klucz „access.host”" in result.stdout
    missing = machine.install("--answers", (machine.base / "no-such.toml").as_posix())
    assert missing.returncode == 1 and "Nie można odczytać pliku odpowiedzi" in _said(missing)


def test_a_machine_that_cannot_take_the_installation_is_told_so_first(tmp_path: Path) -> None:
    other = Machine(tmp_path / "fedora", os_release='PRETTY_NAME="Fedora Linux 43"\nID=fedora\nVERSION_ID=43\n')
    refused = _install(other, "C")
    assert refused.returncode == 2 and "to nie jest Debian" in refused.stdout and other.mutations() == []

    older = Machine(tmp_path / "bookworm", os_release='PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"\nID=debian\nVERSION_ID="12"\n')
    asked = _install(older, "C")
    assert asked.returncode == 1 and "options.allow_unsupported_os = true" in _said(asked) and older.mutations() == []

    busy = Machine(tmp_path / "busy")
    taken = _install(busy, "S", env={"THX_STUB_PORT80": "nginx"})
    assert taken.returncode == 2 and "port 80 jest zajęty przez program „nginx”" in taken.stdout and busy.mutations() == []

    nothing = Machine(tmp_path / "nothing")
    status = nothing.install("--status")
    assert status.returncode == 0 and "nie ma instalacji" in status.stdout
    assert nothing.install("--zmien", "kolory").returncode == 2


def test_a_person_is_led_through_the_questions_and_wrong_answers_are_explained(tmp_path: Path) -> None:
    """The plain-prompt wizard (no whiptail): the answers arrive on standard input, as typed."""
    machine = Machine(tmp_path)
    typed = [
        "2",                        # access: P
        "media",                    # not a domain
        "media.example.org",
        "vps.example.org",          # a name where an address is needed
        "203.0.113.10",
        "203.0.113.10",             # home = VPS
        "198.51.100.7",
        "n",                        # no direct access from the home network
        "",                         # no e-mail for Let's Encrypt
        "t",                        # terms accepted
        "2",                        # the VPS by hand
        "1", "/home/jan/muzyka",    # add a folder: refused
        "/srv/media/muzyka", "",    # ...accepted, kind guessed from the name
        "1", "/srv/media/filmy", "2",
        "",                         # done (the default once there is a folder)
        "j",                        # too short a name
        "jan", "",
        "krotkie",                  # too short a password
        PASSWORD, "inne-haslo-administratora",
        PASSWORD, PASSWORD,
        "",                         # firewall: yes
        "",                         # start
    ]
    before = machine.digest()
    result = machine.install("--dry-run", env={"TRYHACKX_UI": "plain"}, stdin="\n".join(typed) + "\n")
    said = _said(result)
    assert result.returncode == 0, said
    for expected in ("== Sposób dostępu", "nie jest poprawną nazwą hosta", "nie jest adresem IP", "to muszą być dwie różne maszyny",
                     "leży w /home", "Co zawiera /srv/media/muzyka?", "  * 1) Muzyka", "3-32 znaki", "co najmniej 12 znaków",
                     "Hasła nie są takie same", "Co zostanie zrobione", "Sposób dostępu: P - ",
                     "Folder: /srv/media/muzyka  [Muzyka]  identyfikator: muzyka", "Folder: /srv/media/filmy  [Filmy]  identyfikator: filmy",
                     "Konto administratora: jan", "Tryb próbny zakończony"):
        assert expected in said, expected
    assert PASSWORD not in said and "krotkie" not in said
    assert machine.digest() == before and machine.mutations() == []
    # Backing out at the first question changes nothing and is not an error message.
    cancelled = machine.install("--dry-run", env={"TRYHACKX_UI": "plain"}, stdin="")
    assert cancelled.returncode == 1 and "Przerwano. Niczego nie zmieniono." in _said(cancelled)


def test_the_same_questions_are_asked_through_whiptail_when_it_is_there(tmp_path: Path) -> None:
    machine = Machine(tmp_path, with_whiptail=True)
    replies = machine.base / "replies.txt"
    replies.write_text("\n".join([
        "direct", "media.example.org", "letsencrypt", "admin@example.org", "<yes>", "<yes>",
        "add", "/srv/media/muzyka", "music", "done", "jan", "", PASSWORD, PASSWORD, "<yes>", "<yes>",
    ]) + "\n", encoding="utf-8", newline="\n")
    # A firewall somebody already switched on (and a ufw that answers in the system's language).
    result = machine.install("--dry-run", "--lang", "en", env={
        "TRYHACKX_UI": "whiptail", "THX_STUB_WHIPTAIL": replies.as_posix(), "THX_STUB_UFW": "active"})
    assert result.returncode == 0, _said(result)
    assert replies.read_text(encoding="utf-8") == "", "każda odpowiedź została zużyta przez swoje okno"
    dialogs = [line for line in machine.commands if line.startswith("whiptail ")]
    kinds = [next(option for option in ("--msgbox", "--menu", "--inputbox", "--passwordbox", "--yesno") if option in line) for line in dialogs]
    assert kinds == ["--msgbox", "--menu", "--inputbox", "--menu", "--inputbox", "--yesno", "--yesno", "--menu", "--inputbox", "--menu",
                     "--menu", "--inputbox", "--inputbox", "--passwordbox", "--passwordbox", "--yesno", "--yesno"]
    assert PASSWORD not in "\n".join(dialogs), "hasło nie jest argumentem żadnego okna"
    assert "certbot certonly --webroot -w /var/www/tryhackx-media -d media.example.org" in result.stdout
    assert machine.mutations() == []
    # Asked for in English, everything a person reads is English: the windows and the transcript.
    assert "--title How the server is reached" in dialogs[1] and "--yes-button Yes --no-button No" in dialogs[5]
    for expected in ("DRY RUN: nothing will be changed", "Checking this computer", "--- [1/", "Packages",
                     "(dry-run) write /etc/systemd/system/tryhackx-media-transfer.service", "Dry run finished: nothing was changed.",
                     "Next: the DNS A record for media.example.org"):
        assert expected in result.stdout, expected
    assert "Tryb próbny" not in result.stdout and "Sprawdzenie komputera" not in result.stdout
    # The firewall that was already on gets the server's two ports and nothing else: it is not
    # switched on again and no "keep SSH reachable" rule is added to somebody else's rules.
    assert "(dry-run) ufw allow 80/tcp comment tryhackx-media" in result.stdout
    assert "(dry-run) ufw allow 443/tcp comment tryhackx-media" in result.stdout
    assert "ufw --force enable" not in result.stdout and "ufw allow 22/tcp" not in result.stdout
