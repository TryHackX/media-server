"""Change a few values in ``config.local.toml`` and leave everything else exactly as it was.

The private configuration holds the transfer key, the database password and
whatever the owner added by hand since the day it was generated: a mail server, a
session name, a comment explaining a choice. A wizard that rewrites the file from
what *it* knows would quietly drop all of that, so nothing here regenerates
anything. The file is edited line by line, and before a single byte is written
the result is parsed and compared with the original: every table and every key
the request did not name must still be there with the same value, or the edit is
refused and the file stays untouched.

A line editor is enough because the bridge's own TOML reader accepts only the
plain subset (tables, one ``key = value`` per line; no arrays, inline tables or
multi-line strings) — a configuration that the server can read at all is one
this module can edit safely, and the comparison catches the rest.

Standard library only: the wizard calls this with the system Python, before the
project's own environment exists.
"""
from __future__ import annotations

import copy
import json
import re
import tomllib
from collections.abc import Callable, Mapping, Sequence
from datetime import datetime
from pathlib import Path
from typing import Any

_HEADER = re.compile(r"^\s*\[\s*([A-Za-z0-9_.\-]+)\s*\]\s*(?:#.*)?$")
_ARRAY_HEADER = re.compile(r"^\s*\[\[")
_KEY = re.compile(r"^\s*([A-Za-z0-9_\-]+)\s*=")
_ROOT_ID = re.compile(r"^[a-z][a-z0-9_-]{0,31}$")

# What gets written above a table this module creates, so a person opening the
# file later sees why the section is there. Existing tables keep their own comments.
_TABLE_COMMENTS: dict[str, tuple[str, ...]] = {
    "app": (
        "# Publiczny adres aplikacji — stąd biorą się linki aktywacyjne, gościnne",
        "# i przegląd nowości. Ustawione przez kreator (Zainstaluj.cmd).",
    ),
    "proxy": (
        "# Adresy proxy (VPS), którym wolno powiedzieć, kto jest klientem.",
        "# Ustawione przez kreator (Zainstaluj.cmd).",
    ),
    "session": (
        "# Ustawienia sesji. `require_https = false` wolno mieć WYŁĄCZNIE w sieci",
        "# prywatnej bez TLS (kształt D w docs/PUBLIC-EXPOSURE.md): hasło i ciasteczko",
        "# lecą wtedy tekstem. Ustawione przez kreator (Zainstaluj.cmd).",
    ),
}


class TomlEditError(ValueError):
    """The edit was refused; the file has not been changed."""


def toml_literal(value: object) -> str:
    """A TOML value the bridge's strict reader also accepts: a basic string, a boolean or an integer."""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, str):
        if any(ord(ch) < 0x20 for ch in value):
            raise TomlEditError("Wartość zawiera znak sterujący")
        return json.dumps(value, ensure_ascii=False)
    raise TomlEditError(f"Nieobsługiwany typ wartości: {type(value).__name__}")


def _parse(text: str, what: str) -> dict[str, Any]:
    try:
        return tomllib.loads(text)
    except tomllib.TOMLDecodeError as exc:
        raise TomlEditError(f"{what} nie jest poprawnym TOML: {exc}") from exc


def _split(text: str) -> tuple[list[str], str]:
    newline = "\r\n" if "\r\n" in text else "\n"
    return text.replace("\r\n", "\n").split("\n"), newline


def _join(lines: list[str], newline: str) -> str:
    while lines and lines[-1].strip() == "":
        lines.pop()
    return newline.join(lines) + newline


def _guard_plain_subset(lines: Sequence[str]) -> None:
    for number, line in enumerate(lines, start=1):
        if _ARRAY_HEADER.match(line):
            raise TomlEditError(f"Linia {number}: tablice tabel ([[...]]) nie są obsługiwane")
        if '"""' in line or "'''" in line:
            raise TomlEditError(f"Linia {number}: wieloliniowe ciągi nie są obsługiwane")


def _headers(lines: Sequence[str]) -> list[tuple[int, str]]:
    return [(index, match.group(1)) for index, line in enumerate(lines) if (match := _HEADER.match(line))]


def _body_end(lines: Sequence[str], start: int, next_header: int) -> int:
    """One past the last ``key = value`` line of the table that starts at ``start``.

    Blank lines and comments between that line and the next header are not the
    table's: by every convention in this file they introduce what follows.
    """
    end = start + 1
    for index in range(start + 1, next_header):
        if _KEY.match(lines[index]):
            end = index + 1
    return end


def _table_range(lines: Sequence[str], name: str) -> tuple[int, int] | None:
    headers = _headers(lines)
    for position, (index, header) in enumerate(headers):
        if header == name:
            next_header = headers[position + 1][0] if position + 1 < len(headers) else len(lines)
            return index, _body_end(lines, index, next_header)
    return None


def _insertion_point_for_new_table(lines: Sequence[str]) -> int:
    """Before the first media root (they close the file, as the generator writes them), else at the end."""
    for index, header in _headers(lines):
        if header == "roots" or header.startswith("roots."):
            # Step back over the comment block that introduces the roots.
            while index > 0 and lines[index - 1].lstrip().startswith("#"):
                index -= 1
            return index
    return len(lines)


def set_values(text: str, table: str, values: Mapping[str, object | None]) -> str:
    """Set (or, with ``None``, remove) keys of one table, creating or dropping the table as needed."""
    if not re.fullmatch(r"[a-z][a-z0-9_]*", table):
        raise TomlEditError(f"Niepoprawna nazwa tabeli: {table!r}")
    for key in values:
        if not re.fullmatch(r"[a-z][a-z0-9_]*", key):
            raise TomlEditError(f"Niepoprawna nazwa klucza: {key!r}")
    before = _parse(text, "Konfiguracja")
    lines, newline = _split(text)
    _guard_plain_subset(lines)

    found = _table_range(lines, table)
    wanted = {key: value for key, value in values.items() if value is not None}
    if found is None:
        if wanted:
            block = [*_TABLE_COMMENTS.get(table, ()), f"[{table}]"]
            block += [f"{key} = {toml_literal(value)}" for key, value in wanted.items()]
            at = _insertion_point_for_new_table(lines)
            # Trailing blank lines before the insertion point collapse into one separator.
            head = lines[:at]
            while head and head[-1].strip() == "":
                head.pop()
            tail = lines[at:]
            lines = [*head, "", *block, *([""] if tail else []), *tail]
    else:
        start, end = found
        body = lines[start + 1:end]
        for key, value in values.items():
            position = next(
                (i for i, line in enumerate(body) if (m := _KEY.match(line)) and m.group(1) == key), None
            )
            if value is None:
                if position is not None:
                    del body[position]
            elif position is None:
                body.append(f"{key} = {toml_literal(value)}")
            else:
                indent = body[position][: len(body[position]) - len(body[position].lstrip())]
                body[position] = f"{indent}{key} = {toml_literal(value)}"
        if any(_KEY.match(line) for line in body):
            lines[start + 1:end] = body
        else:
            # Nothing left in the table: an empty header would only raise questions.
            # The comment block directly above it described the table and goes with it.
            while start > 0 and lines[start - 1].lstrip().startswith("#"):
                start -= 1
            del lines[start:end]
            while start < len(lines) and start > 0 and lines[start].strip() == "" and lines[start - 1].strip() == "":
                del lines[start]

    result = _join(lines, newline)
    expected = copy.deepcopy(before)
    section = expected.setdefault(table, {})
    if not isinstance(section, dict):
        raise TomlEditError(f"[{table}] nie jest tabelą")
    for key, value in values.items():
        if value is None:
            section.pop(key, None)
        else:
            section[key] = value
    if not section:
        expected.pop(table, None)
    _verify(result, expected)
    return result


def replace_roots(text: str, roots: Sequence[tuple[str, str]]) -> str:
    """Replace every ``[roots.*]`` table with the given ``(identifier, absolute path)`` pairs."""
    if not roots:
        raise TomlEditError("Należy skonfigurować co najmniej jedno źródło mediów")
    seen: set[str] = set()
    for root_id, path in roots:
        if not _ROOT_ID.fullmatch(root_id):
            raise TomlEditError(f"Niepoprawny identyfikator źródła: {root_id!r}")
        if root_id in seen:
            raise TomlEditError(f"Identyfikator źródła występuje dwa razy: {root_id}")
        seen.add(root_id)
        if not path or not _is_absolute(path):
            raise TomlEditError(f"Ścieżka źródła {root_id} musi być bezwzględna")
    before = _parse(text, "Konfiguracja")
    lines, newline = _split(text)
    _guard_plain_subset(lines)

    headers = _headers(lines)
    if any(header == "roots" for _index, header in headers):
        raise TomlEditError("Tabela [roots] zapisana wprost nie jest obsługiwana — użyj [roots.<id>]")
    doomed: list[tuple[int, int]] = []
    for position, (index, header) in enumerate(headers):
        if header.startswith("roots."):
            next_header = headers[position + 1][0] if position + 1 < len(headers) else len(lines)
            doomed.append((index, _body_end(lines, index, next_header)))
    for start, end in reversed(doomed):
        del lines[start:end]
    # Removing tables leaves their separators behind; keep single blank lines only.
    compact: list[str] = []
    for line in lines:
        if line.strip() == "" and compact and compact[-1].strip() == "":
            continue
        compact.append(line)
    while compact and compact[-1].strip() == "":
        compact.pop()
    for root_id, path in roots:
        compact += ["", f"[roots.{root_id}]", f"path = {toml_literal(path)}"]

    result = _join(compact, newline)
    expected = copy.deepcopy(before)
    expected["roots"] = {root_id: {"path": path} for root_id, path in roots}
    _verify(result, expected)
    return result


def _is_absolute(path: str) -> bool:
    # Windows drive or UNC path, or a POSIX absolute path (the helper is also tested on Linux).
    return bool(re.match(r"^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+|/)", path))


def _verify(result: str, expected: dict[str, Any]) -> None:
    actual = _parse(result, "Wynik edycji")
    if actual != expected:
        # Never say which values differ: one of them may be a password.
        changed = sorted(
            name for name in set(actual) | set(expected) if actual.get(name) != expected.get(name)
        )
        raise TomlEditError(
            "Edycja zmieniłaby coś poza tym, o co poproszono (tabele: " + ", ".join(changed) + ") — przerwano"
        )


def summary(text: str) -> dict[str, Any]:
    """What a wizard may show about a configuration: everything except its secrets."""
    data = _parse(text, "Konfiguracja")

    def table(name: str) -> dict[str, Any]:
        value = data.get(name, {})
        return value if isinstance(value, dict) else {}

    roots = table("roots")
    database = table("database")
    return {
        "server_port": table("server").get("port", 8765),
        "database": {
            "host": database.get("host", "127.0.0.1"),
            "port": database.get("port", 3306),
            "name": database.get("name", "media_server"),
            "user": database.get("user", "media_server"),
        },
        "ffmpeg_path": table("stereo").get("ffmpeg_path"),
        "base_url": table("app").get("base_url"),
        "proxy_trusted": table("proxy").get("trusted"),
        "require_https": table("session").get("require_https"),
        "mail_configured": bool(table("mail").get("host")),
        "roots": [
            {"id": root_id, "path": value.get("path") if isinstance(value, dict) else None}
            for root_id, value in roots.items()
        ],
    }


def describe_change(before: str, after: str) -> list[str]:
    """Which tables an edit touches — for the summary page and the dry-run log. Never values."""
    old, new = _parse(before, "Konfiguracja"), _parse(after, "Wynik edycji")
    lines: list[str] = []
    for name in sorted(set(old) | set(new)):
        if old.get(name) == new.get(name):
            continue
        if name == "roots":
            was, now = old.get("roots", {}), new.get("roots", {})
            for root_id in sorted(set(was) | set(now)):
                if root_id not in now:
                    lines.append(f"[roots.{root_id}] usunięte")
                elif root_id not in was:
                    lines.append(f"[roots.{root_id}] dodane: {now[root_id].get('path')}")
                elif was[root_id] != now[root_id]:
                    lines.append(f"[roots.{root_id}] zmienione: {now[root_id].get('path')}")
            continue
        was_keys = old.get(name, {}) if isinstance(old.get(name), dict) else {}
        now_keys = new.get(name, {}) if isinstance(new.get(name), dict) else {}
        for key in sorted(set(was_keys) | set(now_keys)):
            if was_keys.get(key) == now_keys.get(key):
                continue
            if key not in now_keys:
                lines.append(f"[{name}] {key} usunięte")
            else:
                # Only the three tables this module is asked to edit hold nothing secret.
                shown = toml_literal(now_keys[key]) if name in {"app", "proxy", "session"} else "…"
                lines.append(f"[{name}] {key} = {shown}")
    return lines


def apply_edit(
    config_path: Path,
    edit: Callable[[str], str],
    *,
    write_private: Callable[[Path, str], None],
    dry_run: bool = False,
    now: datetime | None = None,
) -> dict[str, Any]:
    """Run ``edit`` over the file; keep a private copy of the old content before writing the new."""
    try:
        with open(config_path, encoding="utf-8", newline="") as handle:
            before = handle.read()
    except OSError as exc:
        raise TomlEditError(f"Nie można odczytać konfiguracji: {exc}") from exc
    after = edit(before)
    changes = describe_change(before, after)
    # Text that differs but means the same (the same folders, their tables merely moved) is not
    # a change: no copy, no rewrite, "changed: false" - it used to rewrite the live file silently (audit P3-1).
    report: dict[str, Any] = {
        "changed": after != before and bool(changes),
        "changes": changes,
        "backup": None,
        "dry_run": dry_run,
    }
    if not report["changed"] or dry_run:
        return report
    stamp = (now or datetime.now()).strftime("%Y%m%d-%H%M%S")
    # `*.local.toml` is git-ignored, and the copy is created as private as the
    # original: it holds the same password and the same key.
    backup = config_path.with_name(f"config.backup-{stamp}.local.toml")
    counter = 1
    while backup.exists():
        counter += 1
        backup = config_path.with_name(f"config.backup-{stamp}-{counter}.local.toml")
    write_private(backup, before)
    # Rewritten in place, not replaced: the file keeps the permissions it was created with.
    with open(config_path, "w", encoding="utf-8", newline="") as handle:
        handle.write(after)
    report["backup"] = str(backup)
    return report
