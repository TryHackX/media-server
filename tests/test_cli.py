"""What every command does before it is allowed to print anything."""
from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

import pytest

from media_server import cli
from media_server.config import AppConfig


class _LegacyConsole:
    """A stream like the one Windows hands a fresh process: a code page that
    cannot carry Polish, and — on stdout — no tolerance for what it cannot."""

    encoding = "cp1252"

    def __init__(self) -> None:
        self.reconfigured: list[dict[str, Any]] = []

    def reconfigure(self, **kwargs: Any) -> None:
        self.reconfigured.append(kwargs)

    def write(self, text: str) -> int:
        return len(text)

    def flush(self) -> None:
        return None


def test_the_streams_are_prepared_before_any_command_can_print(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Reports leave as JSON with ensure_ascii=False, so a single Polish file
    name is enough to end a command with UnicodeEncodeError on a console still
    using the system code page. The fix has to run before the first print, not
    inside whichever command happens to produce one."""
    out, err = _LegacyConsole(), _LegacyConsole()
    monkeypatch.setattr(sys, "stdout", out)
    monkeypatch.setattr(sys, "stderr", err)

    # A missing configuration is the shortest path that still reaches a print.
    assert cli.main(["--config", str(tmp_path / "brak.toml"), "check"]) == 1

    expected = {"encoding": "utf-8", "errors": "replace"}
    assert out.reconfigured == [expected]
    assert err.reconfigured == [expected]


def _build(tree: Path, app_base: str) -> None:
    page = tree / "public" / "assets" / "build"
    page.mkdir(parents=True, exist_ok=True)
    (page / "index.html").write_text(
        f'<!doctype html><meta name="media-app-base" content="{app_base}">',
        encoding="utf-8",
    )


@pytest.mark.parametrize(
    ("built", "configured", "agree"),
    [
        # The default on both sides: the frontend builds at the root and the
        # bridge, with no [app] section at all, sends links there too.
        ("/", None, True),
        ("/", 'https://example.test/', True),
        ("/media-next/", 'https://example.test/media-next/', True),
        # The failure this exists for: links in e-mail land beside the
        # application, and nothing else about the installation looks wrong.
        ("/", 'https://example.test/media-next/', False),
        ("/media-next/", None, False),
    ],
)
def test_the_frontend_and_the_links_in_mail_must_agree_on_where_the_application_is(
    tmp_path: Path, app_config: AppConfig, monkeypatch: pytest.MonkeyPatch,
    built: str, configured: str | None, agree: bool
) -> None:
    tree = tmp_path / "tree"
    _build(tree, built)
    monkeypatch.setattr(cli, "PROJECT_ROOT", tree)
    app_config.source_path.write_text(
        "" if configured is None else f'[app]\nbase_url = "{configured}"\n',
        encoding="utf-8",
    )

    report = cli._app_base_report(app_config)

    assert report["built"] == built
    assert report["agree"] is agree


def test_without_a_build_there_is_nothing_to_compare(
    tmp_path: Path, app_config: AppConfig, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A release can ship prebuilt assets, and a fresh checkout has none at all;
    neither is a misconfiguration, so neither may produce a warning."""
    monkeypatch.setattr(cli, "PROJECT_ROOT", tmp_path / "empty")
    app_config.source_path.write_text("", encoding="utf-8")

    assert cli._app_base_report(app_config)["agree"] is None
