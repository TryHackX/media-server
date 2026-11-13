"""Requests and answers as plain ``key=value`` lines, for a caller that cannot speak JSON.

The Debian installer is a shell script. Bash has no JSON, and building it by
gluing strings together is how a folder called ``Filmy "stare"`` ends an
installation — so towards the shell the helper speaks the one format bash reads
natively: one ``path=value`` per line, the path naming the place in a nested
structure.

    access.mode=vps
    access.vps_addresses.count=1
    access.vps_addresses.0=203.0.113.10
    folders.count=2
    folders.0.path=/srv/media/Filmy "stare"
    folders.0.kind=movies

* a path is split on dots; a part made of digits is a position in a list;
* ``….count`` beside numbered parts is the list's length (what a shell loop needs)
  and is dropped again when the lines are read back;
* values are text, taken literally up to the end of the line: nothing is quoted,
  nothing is escaped. A value therefore cannot contain a line break — which is
  checked rather than hoped for. Anything longer than a line (a configuration
  file, SQL) is written to a file and its *path* travels here.

Booleans leave as ``1``/``0`` and ``None`` as an empty value. Coming back in,
everything is text; the code that knows what a field means converts it.

Standard library only.
"""
from __future__ import annotations

import re
from collections.abc import Iterable
from typing import Any

_KEY_PART = re.compile(r"[A-Za-z0-9_-]+")


class FlatError(ValueError):
    """The lines are not a structure, or the structure cannot be written as lines."""


def _check_text(path: str, value: str) -> str:
    if "\n" in value or "\r" in value or "\x00" in value:
        raise FlatError(f"Wartość pola „{path}” zawiera znak końca linii")
    return value


def encode(value: Any, prefix: str = "") -> list[str]:
    """``value`` (dictionaries, lists, text, numbers, booleans, ``None``) as ``path=value`` lines."""
    if isinstance(value, dict):
        lines: list[str] = []
        for key, item in value.items():
            name = str(key)
            if _KEY_PART.fullmatch(name) is None:
                raise FlatError(f"Nazwy pola „{name}” nie da się zapisać w jednej linii")
            if name.isdigit() or name == "count":
                raise FlatError(f"Nazwa pola „{name}” jest zarezerwowana dla list")
            lines.extend(encode(item, f"{prefix}.{name}" if prefix else name))
        return lines
    if isinstance(value, (list, tuple)):
        if not prefix:
            raise FlatError("Lista nie może być całą odpowiedzią")
        lines = [f"{prefix}.count={len(value)}"]
        for index, item in enumerate(value):
            lines.extend(encode(item, f"{prefix}.{index}"))
        return lines
    if not prefix:
        raise FlatError("Odpowiedź musi być obiektem")
    if value is None:
        return [f"{prefix}="]
    if isinstance(value, bool):
        return [f"{prefix}={'1' if value else '0'}"]
    if isinstance(value, (int, float)):
        return [f"{prefix}={value}"]
    if isinstance(value, str):
        return [f"{prefix}={_check_text(prefix, value)}"]
    raise FlatError(f"Pola „{prefix}” typu {type(value).__name__} nie da się zapisać w jednej linii")


def _listify(node: Any, path: str) -> Any:
    if not isinstance(node, dict):
        return node
    numbered = [key for key in node if key.isdigit()]
    if not numbered:
        if set(node) == {"count"} and isinstance(node["count"], str) and node["count"].isdigit():
            # `x.count=0` on its own is how the shell says "an empty list".
            if int(node["count"]) == 0:
                return []
            raise FlatError(f"Lista „{path}” ma licznik {node['count']}, a żadnej pozycji")
        return {key: _listify(item, f"{path}.{key}" if path else key) for key, item in node.items()}
    extra = sorted(set(node) - set(numbered) - {"count"})
    if extra:
        raise FlatError(f"Pole „{path}” jest jednocześnie listą i obiektem ({', '.join(extra)})")
    indices = sorted(int(key) for key in numbered)
    if indices != list(range(len(indices))) or len(set(numbered)) != len({int(key) for key in numbered}):
        raise FlatError(f"Lista „{path}” ma dziurę w numeracji")
    declared = node.get("count")
    if declared is not None and (not isinstance(declared, str) or not declared.isdigit() or int(declared) != len(indices)):
        raise FlatError(f"Lista „{path}” ma {len(indices)} pozycji, a jej licznik mówi {declared}")
    return [_listify(node[str(index)], f"{path}.{index}") for index in indices]


def decode(lines: Iterable[str]) -> dict[str, Any]:
    """The structure a sequence of ``path=value`` lines describes. Every leaf is text."""
    tree: dict[str, Any] = {}
    for number, raw in enumerate(lines, start=1):
        line = raw.rstrip("\r\n")
        if not line.strip():
            continue
        path, separator, value = line.partition("=")
        if not separator:
            raise FlatError(f"Linia {number}: brak znaku „=”")
        parts = path.strip().split(".")
        if not all(_KEY_PART.fullmatch(part) for part in parts):
            raise FlatError(f"Linia {number}: niepoprawna nazwa pola „{path.strip()}”")
        node = tree
        for depth, part in enumerate(parts[:-1]):
            child = node.setdefault(part, {})
            if not isinstance(child, dict):
                raise FlatError(f"Linia {number}: „{'.'.join(parts[:depth + 1])}” ma już wartość, nie może mieć pól")
            node = child
        leaf = parts[-1]
        if isinstance(node.get(leaf), dict):
            raise FlatError(f"Linia {number}: „{path.strip()}” ma już pola, nie może mieć wartości")
        if leaf in node:
            raise FlatError(f"Linia {number}: pole „{path.strip()}” występuje dwa razy")
        node[leaf] = value
    result = _listify(tree, "")
    if not isinstance(result, dict):
        raise FlatError("Żądanie musi być obiektem")
    return result
