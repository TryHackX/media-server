"""The installers' back room: one request on stdin, one answer on stdout.

The Windows wizard is PowerShell and the Debian installer is a shell script: both
are good at services and firewall rules and poor at being tested. Everything that
is *text* — the private TOML, the Apache files, the VPS bundle, folder
identifiers, the Debian installer's whole plan — is therefore done here, where
``pytest`` covers it, and the installers only ask.

    python -I -X utf8 installer\\helper.py <command>            < request.json
    python3 -I -X utf8 installer/helper.py --shell <command>    < request.lines

The second form is for the shell script: request and answer are ``key=value``
lines instead of JSON (``flat.py``), because bash has no JSON and must never
assemble one by hand.

``-I`` on purpose: the helper runs elevated, and an isolated interpreter does not
pick up modules from the current directory or from environment variables.

Answers are ``{"ok": true, …}`` or ``{"ok": false, "error": "…"}``. A refusal the
user can act on (a bad address, a file that cannot be edited safely) is an answer,
not a crash; only a bug ends with a traceback and a non-zero exit code. Nothing
printed here ever contains a password or a key.
"""
from __future__ import annotations

import importlib.util
import json
import os
import sys
from collections.abc import Callable
from datetime import datetime
from pathlib import Path
from typing import Any

from . import answers, apacheconf, debian, flat, naming, tomledit, vpsbundle

Handler = Callable[[dict[str, Any]], dict[str, Any]]


class RequestError(ValueError):
    """The request itself is wrong (a missing field) — a bug in the caller, reported plainly."""


def _need(request: dict[str, Any], key: str, kind: type | tuple[type, ...] = str) -> Any:
    value = request.get(key)
    if not isinstance(value, kind) or (isinstance(value, str) and value == ""):
        raise RequestError(f"Brak pola „{key}” w żądaniu")
    return value


def _flag(value: object) -> bool:
    """A yes/no field. The shell sends ``1``/``0`` as text, and ``bool("0")`` is not what it means."""
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "tak"}
    return bool(value)


def _is_false(value: object) -> bool:
    return value is False or (isinstance(value, str) and value.strip().lower() in {"0", "false", "no", "nie"})


def _read(path: str) -> str:
    with open(path, encoding="utf-8-sig", newline="") as handle:
        return handle.read()


def _read_server_file(path: str) -> str:
    """WAMP's own configuration files, byte for byte.

    Nobody promises their encoding (the stock files carry comments in whatever
    code page their author used), so they are read as Latin-1 — every byte maps to
    one character and back — and written the same way. What this helper inserts
    into them is ASCII.
    """
    with open(path, encoding="latin-1", newline="") as handle:
        return handle.read()


def _write_server_file(request: dict[str, Any], text: str) -> str | None:
    """Write the edited text to ``output`` (never over the original — that is the wizard's move)."""
    output = request.get("output")
    if not output:
        return None
    try:
        data = text.encode("latin-1")
    except UnicodeEncodeError as exc:
        raise apacheconf.ApacheConfError(
            "Ścieżka instalacji zawiera znaki spoza ASCII — Apache z WAMP-a nie przeczyta jej pewnie"
        ) from exc
    Path(output).parent.mkdir(parents=True, exist_ok=True)
    Path(output).write_bytes(data)
    return str(output)


def _private_writer(project_root: str) -> Callable[[Path, str], None]:
    """``scripts/install.py`` already knows how to create a file nobody else can read."""
    script = Path(project_root) / "scripts" / "install.py"
    spec = importlib.util.spec_from_file_location("tryhackx_install", script)
    if spec is None or spec.loader is None:
        raise RequestError(f"Nie znaleziono {script}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module._write_private_config


def config_summary(request: dict[str, Any]) -> dict[str, Any]:
    return {"summary": tomledit.summary(_read(_need(request, "config")))}


def config_roots(request: dict[str, Any]) -> dict[str, Any]:
    roots = [(str(root["id"]), str(root["path"])) for root in _need(request, "roots", list)]
    dry_run = _flag(request.get("dry_run"))
    return tomledit.apply_edit(
        Path(_need(request, "config")),
        lambda text: tomledit.replace_roots(text, roots),
        write_private=(lambda _p, _t: None) if dry_run else _private_writer(_need(request, "project_root")),
        dry_run=dry_run,
    )


def config_access(request: dict[str, Any]) -> dict[str, Any]:
    base_url = request.get("base_url") or None
    trusted = request.get("proxy_trusted") or None
    if trusted is not None:
        trusted = ", ".join(apacheconf.normalise_addresses(str(trusted).replace(",", " ").split()))
    if base_url is not None and not str(base_url).startswith(("https://", "http://", "/")):
        raise tomledit.TomlEditError("base_url musi być pełnym adresem albo ścieżką zaczynającą się od /")
    # `true` is the default and is not written: only the deliberate exception is.
    require_https = False if _is_false(request.get("require_https")) else None
    dry_run = _flag(request.get("dry_run"))

    def edit(text: str) -> str:
        text = tomledit.set_values(text, "app", {"base_url": base_url})
        text = tomledit.set_values(text, "proxy", {"trusted": trusted})
        return tomledit.set_values(text, "session", {"require_https": require_https})

    return tomledit.apply_edit(
        Path(_need(request, "config")),
        edit,
        write_private=(lambda _p, _t: None) if dry_run else _private_writer(_need(request, "project_root")),
        dry_run=dry_run,
    )


def assign_ids(request: dict[str, Any]) -> dict[str, Any]:
    return {
        "roots": naming.assign_root_ids(
            _need(request, "folders", list),
            request.get("existing") or [],
            case_sensitive=_flag(request.get("case_sensitive")),
            # Every identifier the catalogue knows (`media-server roots list`), switched-off ones too.
            reserved_ids=[str(value) for value in (request.get("reserved") or [])],
        )
    }


def _conf(request: dict[str, Any]) -> apacheconf.WampConf:
    raw = _need(request, "conf", dict)
    return apacheconf.WampConf(
        root=_need(raw, "root"),
        service_port=int(raw.get("service_port", 8765)),
        mode=_need(raw, "mode"),
        host_name=raw.get("host_name") or None,
        vps_addresses=tuple(raw.get("vps_addresses") or ()),
        allow_lan=bool(raw.get("allow_lan")),
        certificate_file=raw.get("certificate_file") or None,
        certificate_key_file=raw.get("certificate_key_file") or None,
        add_listen_443=bool(raw.get("add_listen_443")),
        generated=str(raw.get("generated") or ""),
    )


def apache_render(request: dict[str, Any]) -> dict[str, Any]:
    conf = _conf(request)
    text = apacheconf.render_wamp_conf(_read(_need(request, "template")), conf)
    written = None
    if request.get("output"):
        target = Path(request["output"])
        target.parent.mkdir(parents=True, exist_ok=True)
        # UTF-8 without a byte-order mark: Apache reads a BOM as the start of a directive.
        with open(target, "w", encoding="utf-8", newline="\r\n") as handle:
            handle.write(text)
        written = str(target)
    return {
        "written": written,
        "lines": len(text.splitlines()),
        "access": apacheconf.access_lines(conf.mode, conf.vps_addresses, conf.allow_lan),
        "modules": list(apacheconf.required_modules(conf.mode)),
        "text": text if request.get("return_text") else None,
    }


def apache_vhosts_set(request: dict[str, Any]) -> dict[str, Any]:
    text = _read_server_file(_need(request, "path"))
    disabled: list[str] = []
    if request.get("disable_port"):
        text, disabled = apacheconf.comment_out_hosts(text, int(request["disable_port"]))
    document_root = _need(request, "document_root")
    # The file is written back byte for byte as Latin-1, so "ó" would arrive as the single byte
    # F3 - invalid UTF-8, which Apache reads as a different path. What is inserted must be ASCII (audit P3-9).
    if not str(document_root).isascii():
        raise apacheconf.ApacheConfError(
            "Ścieżka instalacji zawiera znaki spoza ASCII — Apache z WAMP-a nie przeczyta jej pewnie"
        )
    text, info = apacheconf.set_document_root(text, document_root)
    changed = bool(info.get("changed")) or bool(disabled)
    return {
        "info": info,
        "disabled_hosts": disabled,
        "changed": changed,
        "written": _write_server_file(request, text) if changed else None,
    }


def apache_vhosts_restore(request: dict[str, Any]) -> dict[str, Any]:
    text, restored_root = apacheconf.restore_document_root(_read_server_file(_need(request, "path")))
    text, restored_hosts = apacheconf.restore_commented_hosts(text)
    changed = restored_root or restored_hosts
    return {
        "restored_document_root": restored_root,
        "restored_hosts": restored_hosts,
        "changed": changed,
        "written": _write_server_file(request, text) if changed else None,
    }


def apache_modules(request: dict[str, Any]) -> dict[str, Any]:
    text, report = apacheconf.enable_modules(
        _read_server_file(_need(request, "path")), _need(request, "modules", list)
    )
    changed = bool(report["enabled"])
    return {**report, "changed": changed, "written": _write_server_file(request, text) if changed else None}


def apache_inspect(request: dict[str, Any]) -> dict[str, Any]:
    httpd = _read_server_file(_need(request, "httpd_conf"))
    vhosts_path = request.get("vhosts_conf")
    vhosts = _read_server_file(vhosts_path) if vhosts_path and Path(vhosts_path).is_file() else ""
    ours = str(request.get("our_alias") or "").casefold()
    aliases = []
    other_texts = [httpd, vhosts]
    alias_dir = request.get("alias_dir")
    if alias_dir and Path(alias_dir).is_dir():
        for file in sorted(Path(alias_dir).iterdir()):
            # Only what WampServer's httpd.conf includes ("alias/*.conf"): a .bak beside it is
            # never loaded and must not become "the wizard's file" (audit P3-10).
            if not file.is_file() or file.suffix.lower() != ".conf":
                continue
            try:
                text = _read_server_file(str(file))
            except OSError:
                continue
            root, managed = apacheconf.managed_root(text)
            if root is not None:
                aliases.append({"file": str(file), "root": root, "managed": managed})
            if str(file).casefold() != ours and root is None:
                other_texts.append(text)
    hosts = [
        {
            "addresses": list(host.addresses),
            "ports": list(host.ports),
            "server_name": host.server_name,
            "document_root": host.document_root,
        }
        for host in apacheconf.find_virtual_hosts(vhosts)
    ]
    return {
        # A `Listen 443` anywhere outside our own file: ours must not add a second one.
        "listen_443": apacheconf.listens_on(other_texts, 443),
        "virtual_hosts": hosts,
        "document_root_managed": apacheconf.DOCROOT_MARKER in vhosts,
        "aliases": aliases,
    }


def vps_bundle(request: dict[str, Any]) -> dict[str, Any]:
    certificate_pem = _read(_need(request, "certificate"))
    output = Path(_need(request, "output_dir"))
    values = vpsbundle.build_values(
        host_name=_need(request, "host_name"),
        home_address=_need(request, "home_address"),
        vps_addresses=_need(request, "vps_addresses", list),
        lan_address=str(request.get("lan_address") or ""),
        # Where the guide says the folder is - the same place, unless the caller writes it elsewhere.
        bundle_dir=str(request.get("bundle_dir") or output),
        certificate_pem=certificate_pem,
        certificate_not_after=str(request.get("certificate_not_after") or ""),
        generated=str(request.get("generated") or ""),
        # The home machine's platform changes a few sentences of the guide and, on
        # Debian, adds vps-setup.sh. Left out, the bundle is the Windows wizard's.
        platform=str(request.get("platform") or "windows"),
        language=str(request.get("language") or "pl"),
        acme_email=str(request.get("acme_email") or ""),
        acme_agree=_flag(request.get("acme_agree")),
        firewall_managed=not _is_false(request.get("firewall_managed")),
    )
    files = vpsbundle.render_bundle(Path(_need(request, "template_dir")), values, certificate_pem)
    written = [] if _flag(request.get("dry_run")) else vpsbundle.write_bundle(output, files)
    return {"files": sorted(files), "written": written, "fingerprint": values["CERT_SHA256"]}


def validate_access(request: dict[str, Any]) -> dict[str, Any]:
    """The same checks the generators apply, run early so the page can say what is wrong."""
    result: dict[str, Any] = {}
    if request.get("host_name"):
        result["host_name"] = apacheconf.normalise_host_name(str(request["host_name"]))
    if request.get("vps_addresses") is not None:
        result["vps_addresses"] = apacheconf.normalise_addresses(list(request["vps_addresses"]))
    if request.get("home_address"):
        target, kind = vpsbundle.home_target(str(request["home_address"]))
        result["home_target"], result["home_kind"] = target, kind
    return result


# -- the Debian installer ----------------------------------------------------------------------
#
# Called by zainstaluj-debian.sh with --shell. Nothing here runs a system command:
# the script does that; these functions decide and write text.


def _password_settled(request: dict[str, Any]) -> bool:
    """Whether the administrator's password has a source other than the answers themselves.

    The environment variable is one; a dry run is another — it creates no account,
    so it must not demand a password it would never use.
    """
    return bool(os.environ.get("TRYHACKX_ADMIN_PASSWORD")) or _flag(request.get("password_optional"))


def debian_answers(request: dict[str, Any]) -> dict[str, Any]:
    """An answers file as checked, complete answers."""
    raw = answers.load(_need(request, "path"))
    normal, problems = answers.normalise(
        raw, forbidden_folders=debian.FORBIDDEN_FOLDERS, password_in_environment=_password_settled(request)
    )
    return {"answers": normal, "problems": problems}


def debian_plan(request: dict[str, Any]) -> dict[str, Any]:
    """The answers checked once more, and what they mean on this machine."""
    normal, problems = answers.normalise(
        request.get("answers") or {},
        forbidden_folders=debian.FORBIDDEN_FOLDERS,
        interactive=_flag(request.get("interactive")),
        password_in_environment=_password_settled(request),
    )
    if _flag(request.get("check_folders")):
        sysroot = str(request.get("sysroot") or "")
        for folder in normal["folders"]:
            if folder["path"].startswith("/") and not os.path.isdir(sysroot + folder["path"]):
                problems.append(answers.problem("folder.missing", folder["path"]))
    plan = debian.plan(normal, request.get("env") or {})
    return {
        "answers": normal,
        "plan": {key: value for key, value in plan.items() if key not in {"problems", "warnings"}},
        "problems": [*problems, *plan["problems"]],
        "warnings": plan["warnings"],
    }


def debian_folder(request: dict[str, Any]) -> dict[str, Any]:
    # `sysroot` is empty on a real machine; the tests point it at a directory that stands for "/".
    sysroot = str(request.get("sysroot") or "")
    clean, problems = debian.folder_problems(
        _need(request, "path"),
        [str(item) for item in request.get("others") or []],
        exists=lambda path: os.path.isdir(sysroot + path),
    )
    return {"path": clean, "problems": problems, "kind": debian.guess_kind(clean)}


def debian_kinds(request: dict[str, Any]) -> dict[str, Any]:
    """What each configured folder holds: as the catalogue recorded it, else a guess from its name."""
    recorded: dict[str, str] = {}
    catalog: set[str] = set()
    if request.get("json_file"):
        try:
            report = json.loads(_read(str(request["json_file"])))
            for entry in report.get("roots", []):
                if entry.get("id"):
                    # Switched-off roots too: their identifiers stay taken (audit P3-2).
                    catalog.add(str(entry["id"]))
                if entry.get("kind") in naming.KINDS:
                    recorded[str(entry["id"])] = str(entry["kind"])
        except (OSError, ValueError, AttributeError, TypeError, KeyError):
            recorded, catalog = {}, set()
    roots = []
    for root in request.get("roots") or []:
        identifier, path = str(root.get("id", "")), str(root.get("path", ""))
        known = identifier in recorded
        roots.append({
            "id": identifier,
            "kind": recorded[identifier] if known else debian.guess_kind(path, identifier),
            "known": known,
        })
    # Every identifier the catalogue knows: a new folder must not inherit a removed library's rows.
    return {"roots": roots, "catalog_ids": sorted(catalog)}


def debian_sites(request: dict[str, Any]) -> dict[str, Any]:
    raw = _need(request, "conf", dict)
    conf = debian.SiteConf(
        mode=_need(raw, "mode"),
        host_name=raw.get("host_name") or None,
        vps_addresses=tuple(raw.get("vps_addresses") or ()),
        allow_lan=_flag(raw.get("allow_lan")),
        service_port=int(raw.get("service_port") or 8765),
        certificate_file=raw.get("certificate_file") or None,
        certificate_key_file=raw.get("certificate_key_file") or None,
        generated=str(raw.get("generated") or ""),
    )
    examples = Path(_need(request, "examples_dir"))
    sites = debian.render_sites(
        (examples / "media-next.conf.example").read_text(encoding="utf-8"),
        (examples / "media-transfer.conf.example").read_text(encoding="utf-8"),
        conf,
    )
    written: dict[str, str] = {}
    if request.get("output_dir"):
        output = Path(request["output_dir"])
        output.mkdir(parents=True, exist_ok=True)
        for name, text in sites.items():
            target = output / f"{name}.conf"
            with open(target, "w", encoding="utf-8", newline="\n") as handle:
                handle.write(text)
            written[name] = str(target)
    return {
        "sites": sorted(sites),
        "written": written,
        "access": apacheconf.access_lines(conf.mode, conf.vps_addresses, conf.allow_lan),
    }


def debian_certificate_config(request: dict[str, Any]) -> dict[str, Any]:
    text = debian.certificate_config(_need(request, "common_name"), request.get("alt_name") or None)
    target = Path(_need(request, "output"))
    debian.write_private(target, text)
    return {"written": str(target)}


def debian_migrate_config(request: dict[str, Any]) -> dict[str, Any]:
    """Keep the migration configuration in step with the service's own."""
    config = Path(_need(request, "config"))
    target = Path(_need(request, "output"))
    previous = _read(str(target)) if target.is_file() else None
    text, fresh = debian.migrate_config_text(
        _read(str(config)), previous_text=previous, new_password=debian.new_password
    )
    changed = previous != text
    if changed and not _flag(request.get("dry_run")):
        debian.write_private(target, text)
    return {"written": str(target), "changed": changed, "fresh_password": fresh}


def debian_sql(request: dict[str, Any]) -> dict[str, Any]:
    """The statements that create (or drop) the database and its accounts, into a file only root reads.

    Names and passwords are read from the two configuration files themselves, so
    no password ever passes through the shell.
    """
    database = debian._database_of(_read(_need(request, "config")), "Konfiguracja")
    name, user = str(database.get("name", "")), str(database.get("user", ""))
    ddl_user = debian.migrate_user(user)
    action = str(request.get("action") or "create")
    if action == "drop":
        sql = debian.drop_sql(name=name, user=user, ddl_user=ddl_user)
    else:
        migration = debian._database_of(_read(_need(request, "migrate_config")), "Konfiguracja migracji")
        if migration.get("user") != ddl_user or migration.get("name") != name:
            raise tomledit.TomlEditError("Konfiguracja migracji nie pasuje do konfiguracji usługi — odtwórz ją instalatorem")
        sql = debian.database_sql(
            name=name, user=user, password=str(database.get("password", "")),
            ddl_user=ddl_user, ddl_password=str(migration.get("password", "")),
        )
    target = Path(_need(request, "output"))
    debian.write_private(target, sql)
    return {"written": str(target), "database": name, "user": user, "ddl_user": ddl_user}


def debian_mark(request: dict[str, Any]) -> dict[str, Any]:
    """A copy of a file from the project (a unit, a filter) the way the installer installs it: LF and marked."""
    text = debian.marked(_read(_need(request, "source")))
    target = Path(_need(request, "output"))
    target.parent.mkdir(parents=True, exist_ok=True)
    with open(target, "w", encoding="utf-8", newline="\n") as handle:
        handle.write(text)
    return {"written": str(target)}


def debian_renew_hook(request: dict[str, Any]) -> dict[str, Any]:
    target = Path(_need(request, "output"))
    target.parent.mkdir(parents=True, exist_ok=True)
    with open(target, "w", encoding="utf-8", newline="\n") as handle:
        handle.write(debian.RENEW_HOOK_TEXT)
    return {"written": str(target)}


def debian_marked(request: dict[str, Any]) -> dict[str, Any]:
    """Which of the given files are the installer's own (carry its marker), which are not, which are gone."""
    report: dict[str, list[str]] = {"ours": [], "foreign": [], "missing": []}
    for item in request.get("paths") or []:
        path = Path(str(item))
        if not path.is_file():
            report["missing"].append(str(path))
            continue
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            report["foreign"].append(str(path))
            continue
        report["ours" if debian.is_marked(text) else "foreign"].append(str(path))
    return report


_STATE_FLAGS = frozenset({
    "managed", "enabled_by_installer", "allow_lan", "created_by_installer", "installed", "inferred",
    "acme_agree_tos", "install_completed",
})
_STATE_NUMBERS = frozenset({"service_port", "ssh_port"})


def _typed_state(value: Any, key: str = "") -> Any:
    """State arrives from the shell as text; the file keeps yes/no and numbers as what they are."""
    if isinstance(value, dict):
        return {name: _typed_state(item, name) for name, item in value.items()}
    if isinstance(value, list):
        return [_typed_state(item) for item in value]
    if isinstance(value, str) and key in _STATE_FLAGS:
        return _flag(value)
    if isinstance(value, str) and key in _STATE_NUMBERS and value.isdigit():
        return int(value)
    return value


def debian_state(request: dict[str, Any]) -> dict[str, Any]:
    target = Path(_need(request, "state_file"))
    update = _typed_state(request.get("update") or {})
    now = str(request.get("now") or datetime.now().strftime("%Y-%m-%dT%H:%M:%S"))
    state = debian.merge_state(debian.read_state(target), update, now=now)
    if not _flag(request.get("dry_run")):
        debian.write_private(target, json.dumps(state, ensure_ascii=False, indent=2) + "\n", 0o640)
    return {"written": str(target), "state": state}


def debian_state_read(request: dict[str, Any]) -> dict[str, Any]:
    state = debian.read_state(_need(request, "state_file"))
    return {"found": state is not None, "state": state or {}}


def debian_installed(request: dict[str, Any]) -> dict[str, Any]:
    """An installation that is already there: what its configuration says, without its secrets."""
    summary = tomledit.summary(_read(_need(request, "config")))
    return {"summary": summary, "access": debian.infer_access(summary)}


def debian_password(request: dict[str, Any]) -> dict[str, Any]:
    return {"password": debian.new_password()}


COMMANDS: dict[str, Handler] = {
    "config-summary": config_summary,
    "config-roots": config_roots,
    "config-access": config_access,
    "assign-ids": assign_ids,
    "apache-render": apache_render,
    "apache-vhosts-set": apache_vhosts_set,
    "apache-vhosts-restore": apache_vhosts_restore,
    "apache-modules": apache_modules,
    "apache-inspect": apache_inspect,
    "vps-bundle": vps_bundle,
    "validate-access": validate_access,
    "debian-answers": debian_answers,
    "debian-plan": debian_plan,
    "debian-folder": debian_folder,
    "debian-kinds": debian_kinds,
    "debian-sites": debian_sites,
    "debian-certificate-config": debian_certificate_config,
    "debian-migrate-config": debian_migrate_config,
    "debian-sql": debian_sql,
    "debian-mark": debian_mark,
    "debian-renew-hook": debian_renew_hook,
    "debian-marked": debian_marked,
    "debian-state": debian_state,
    "debian-state-read": debian_state_read,
    "debian-installed": debian_installed,
    "debian-password": debian_password,
}

_REFUSALS = (
    RequestError,
    tomledit.TomlEditError,
    apacheconf.ApacheConfError,
    vpsbundle.BundleError,
    OSError,
    UnicodeDecodeError,
    KeyError,
    ValueError,
)


def run(command: str, request: dict[str, Any]) -> dict[str, Any]:
    handler = COMMANDS.get(command)
    if handler is None:
        return {"ok": False, "error": f"Nieznane polecenie: {command}"}
    try:
        return {"ok": True, **handler(request)}
    except _REFUSALS as refusal:
        message = str(refusal) if not isinstance(refusal, KeyError) else f"Brak pola {refusal} w żądaniu"
        return {"ok": False, "error": message}


def _answer_lines(answer: dict[str, Any]) -> list[str]:
    try:
        return flat.encode(answer)
    except flat.FlatError as exc:
        return flat.encode({"ok": False, "error": str(exc)})


def _main_shell(command: str) -> int:
    """The same commands for a caller without JSON: ``key=value`` lines in, ``key=value`` lines out."""
    raw = sys.stdin.buffer.read().decode("utf-8-sig", errors="replace")
    try:
        request = flat.decode(raw.splitlines())
    except flat.FlatError as exc:
        answer: dict[str, Any] = {"ok": False, "error": f"Żądanie jest nieczytelne: {exc}"}
    else:
        answer = run(command, request)
    if isinstance(answer.get("error"), str):
        answer["error"] = " ".join(answer["error"].split())
    # Bytes, with bare line feeds: a text stream on Windows would end every line with CR LF,
    # and the shell would read that CR as part of the value.
    sys.stdout.flush()
    sys.stdout.buffer.write(("\n".join(_answer_lines(answer)) + "\n").encode("utf-8"))
    sys.stdout.buffer.flush()
    return 0


def main(argv: list[str] | None = None) -> int:
    arguments = sys.argv[1:] if argv is None else argv
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is not None:
            reconfigure(encoding="utf-8", errors="replace")
    if len(arguments) == 2 and arguments[0] == "--shell":
        return _main_shell(arguments[1])
    if len(arguments) != 1:
        print("Użycie: helper.py [--shell] <polecenie>  (żądanie na standardowym wejściu)", file=sys.stderr)
        print("Polecenia: " + ", ".join(sorted(COMMANDS)), file=sys.stderr)
        return 2
    raw = sys.stdin.buffer.read().decode("utf-8-sig")
    try:
        request = json.loads(raw) if raw.strip() else {}
    except json.JSONDecodeError as exc:
        print(json.dumps({"ok": False, "error": f"Żądanie nie jest poprawnym JSON: {exc}"}, ensure_ascii=False))
        return 0
    if not isinstance(request, dict):
        print(json.dumps({"ok": False, "error": "Żądanie musi być obiektem JSON"}, ensure_ascii=False))
        return 0
    print(json.dumps(run(arguments[0], request), ensure_ascii=False))
    return 0
