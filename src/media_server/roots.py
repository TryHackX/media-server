"""Media roots without a scan: saying what a folder holds, once, and nothing else.

A root's kind (music, movies, mixed) used to be written by its first scan and by
nothing else, so the only way to tell the catalogue "this folder is films" was to
catalogue it — minutes for a small library, hours for a large one on a slow disk.
That is fine in a shell and wrong in an installer: a wizard cannot sit on its last
page until fifty thousand files have been read.

``sync_roots`` writes the same ``media_roots`` row the scanner would, and stops.
From then on the scheduled maintenance run knows the kind (it skips a root whose
kind nobody recorded, see ``maintenance.py``) and does the cataloguing in the
background, in bounded batches, exactly as it does every night afterwards.

The other half is a folder taken *out* of the configuration. Its files stay in
the catalogue — nothing here deletes — but they can no longer be played, because
the transfer service only serves configured roots. The bridge already hides every
item whose root is not enabled, so such a root is switched off rather than left
as a library full of entries that fail on click. Putting the folder back under
the same identifier switches it on again, with everything it had.
"""
from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from .catalog import _ROOT_KINDS, CatalogError, _register_root, _validate_schema
from .config import AppConfig
from .database import connect_rows


def _recorded(connection: Any) -> dict[str, dict[str, Any]]:
    with connection.cursor() as cursor:
        cursor.execute("SELECT slug, media_kind, filesystem_path, is_enabled FROM media_roots ORDER BY slug")
        return {str(row["slug"]): row for row in cursor.fetchall()}


def list_roots(config: AppConfig) -> dict[str, Any]:
    """Every root the configuration names and every root the catalogue remembers."""
    with connect_rows(config.database) as connection:
        _validate_schema(connection, config.database.name)
        recorded = _recorded(connection)
    roots: list[dict[str, Any]] = []
    for slug in sorted(set(config.roots) | set(recorded)):
        row = recorded.get(slug)
        path = config.roots.get(slug)
        roots.append(
            {
                "id": slug,
                "configured": path is not None,
                "path": str(path) if path is not None else None,
                "exists": bool(path is not None and path.is_dir()),
                "kind": str(row["media_kind"]) if row else None,
                "enabled": bool(row["is_enabled"]) if row else None,
                "recorded_path": str(row["filesystem_path"]) if row else None,
            }
        )
    return {"status": "ok", "roots": roots}


def sync_roots(
    config: AppConfig,
    kinds: Mapping[str, str],
    *,
    disable_unconfigured: bool = False,
) -> dict[str, Any]:
    """Record the kind of the named roots and, when asked, switch off the ones no longer configured.

    Everything is checked before the first write, so a typo in the third root
    does not leave the first two registered and the caller guessing which.
    """
    unknown = sorted(set(kinds) - set(config.roots))
    if unknown:
        raise CatalogError("Źródła nie ma w konfiguracji: " + ", ".join(unknown))
    invalid = sorted(f"{slug}={kind}" for slug, kind in kinds.items() if kind not in _ROOT_KINDS)
    if invalid:
        raise CatalogError("Nieznany rodzaj źródła (music, movies albo mixed): " + ", ".join(invalid))
    missing = sorted(slug for slug in kinds if not config.roots[slug].is_dir())
    if missing:
        raise CatalogError("Katalog źródła nie istnieje: " + ", ".join(missing))

    registered: list[dict[str, Any]] = []
    disabled: list[str] = []
    with connect_rows(config.database) as connection:
        _validate_schema(connection, config.database.name)
        before = _recorded(connection)
        for slug in sorted(kinds):
            previous = before.get(slug)
            _register_root(connection, slug, config.roots[slug].resolve(strict=True), kinds[slug])
            registered.append(
                {
                    "id": slug,
                    "kind": kinds[slug],
                    "previous_kind": str(previous["media_kind"]) if previous else None,
                    "created": previous is None,
                }
            )
        if disable_unconfigured:
            for slug, row in before.items():
                if slug in config.roots or not row["is_enabled"]:
                    continue
                with connection.cursor() as cursor:
                    cursor.execute("UPDATE media_roots SET is_enabled = 0 WHERE slug = %s", (slug,))
                disabled.append(slug)
        after = _recorded(connection)
    # Configured, but nobody has said what it holds: the scheduled run will skip it.
    unregistered = sorted(slug for slug in config.roots if slug not in after)
    return {"status": "ok", "registered": registered, "disabled": disabled, "unregistered": unregistered}
