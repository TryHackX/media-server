"""What every command does before it is allowed to print anything."""
from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

import pytest

from media_server import cli


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
