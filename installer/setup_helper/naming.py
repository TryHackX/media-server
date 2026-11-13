"""Identifiers for media folders: readable, stable and legal.

A root's identifier is how the catalogue knows a library for ever — every file is
stored under it — and its title-cased form is the name people see in the panel
and as the top folder of a ZIP download. The wizard therefore derives it from the
folder's own name (``E:\\Filmy Video`` → ``filmy_video``, shown as "Filmy Video")
rather than numbering folders, and never changes one that already exists: a path
that keeps its identifier keeps its catalogue.

Standard library only.
"""
from __future__ import annotations

import re
import unicodedata
from collections.abc import Iterable, Sequence
from pathlib import PureWindowsPath

ROOT_ID = re.compile(r"^[a-z][a-z0-9_-]{0,31}$")
KINDS = ("music", "movies", "mixed")
# Letters NFKD does not decompose into a base letter and an accent.
_UNDECOMPOSED = str.maketrans({"ł": "l", "Ł": "L", "ø": "o", "Ø": "O", "đ": "d", "Đ": "D", "ß": "ss", "æ": "ae", "Æ": "AE"})


def _ascii_slug(text: str) -> str:
    decomposed = unicodedata.normalize("NFKD", text.translate(_UNDECOMPOSED))
    plain = decomposed.encode("ascii", "ignore").decode("ascii").lower()
    return re.sub(r"[^a-z0-9]+", "_", plain).strip("_")


def _same_path(left: str, right: str, case_sensitive: bool = False) -> bool:
    def norm(value: str) -> str:
        plain = value.replace("/", "\\").rstrip("\\")
        return plain if case_sensitive else plain.casefold()

    return norm(left) == norm(right)


def root_id_for(path: str, kind: str, taken: Iterable[str]) -> str:
    """An identifier for ``path`` that is not in ``taken``."""
    if kind not in KINDS:
        raise ValueError(f"Nieznany rodzaj źródła: {kind}")
    used = set(taken)
    slug = _ascii_slug(PureWindowsPath(path).name)
    if not slug:
        # A drive root, or a name written entirely in a script with no Latin form.
        slug = kind
    elif not slug[0].isalpha():
        slug = f"{kind}_{slug}"
    slug = slug[:28].rstrip("_-") or kind
    candidate, number = slug, 1
    while candidate in used:
        number += 1
        candidate = f"{slug}{number}"
    return candidate


def assign_root_ids(
    folders: Sequence[dict[str, str]],
    existing: Sequence[dict[str, str]] = (),
    *,
    case_sensitive: bool = False,
    reserved_ids: Iterable[str] = (),
) -> list[dict[str, str]]:
    """Give every folder an identifier, reusing the one a path already has.

    ``folders`` are ``{"path", "kind"}`` (an ``"id"`` already present is kept when
    valid); ``existing`` are the roots of the current configuration. Paths are
    compared the way Windows compares them unless ``case_sensitive`` is set — on
    Linux ``/srv/Media`` and ``/srv/media`` are two folders. ``reserved_ids`` are
    every identifier the catalogue knows, switched-off roots included: a library
    removed in an earlier run keeps its rows, and a new folder must not inherit them.
    """
    result: list[dict[str, str]] = []
    taken: set[str] = set()
    pending: list[int] = []
    for index, folder in enumerate(folders):
        path, kind = folder["path"], folder["kind"]
        if kind not in KINDS:
            raise ValueError(f"Nieznany rodzaj źródła: {kind}")
        chosen = folder.get("id") or ""
        if not chosen:
            chosen = next(
                (old["id"] for old in existing if _same_path(old["path"], path, case_sensitive)), ""
            )
        if chosen and (ROOT_ID.fullmatch(chosen) is None or chosen in taken):
            chosen = ""
        if chosen:
            taken.add(chosen)
        else:
            pending.append(index)
        result.append({"id": chosen, "path": path, "kind": kind})
    # New folders must not take the identifier of a root that was removed - just now or in an
    # earlier run: its catalogue entries would silently become this folder's (audit P3-2).
    reserved = taken | {old["id"] for old in existing} | {str(value) for value in reserved_ids if value}
    for index in pending:
        chosen = root_id_for(result[index]["path"], result[index]["kind"], reserved)
        reserved.add(chosen)
        result[index]["id"] = chosen
    return result
