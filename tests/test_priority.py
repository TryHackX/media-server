from __future__ import annotations

import subprocess
import sys

import pytest

from media_server import priority

windows_only = pytest.mark.skipif(sys.platform != "win32", reason="I/O priority is read and set on Windows only")


@windows_only
def test_a_process_started_at_low_io_priority_is_lifted_to_normal() -> None:
    """What a scheduled task does to the service, and what a probe is given back."""
    child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
    try:
        assert priority.set_io_priority(child.pid, 1)
        assert priority.io_priority_level(child.pid) == 1
        assert priority.read_at_normal_priority(child.pid)
        assert priority.io_priority_level(child.pid) == priority.NORMAL
        # Already at normal: left alone, and still a success.
        assert priority.read_at_normal_priority(child.pid)
    finally:
        child.kill()
        child.wait()
    assert priority.io_priority() in {"very low", "low", "normal", "high"}


@windows_only
def test_a_process_that_is_gone_is_not_an_error() -> None:
    child = subprocess.Popen([sys.executable, "-c", "pass"])
    child.wait()
    # The pid may be reused, but a finished process cannot be lifted, and nothing raises.
    assert priority.read_at_normal_priority(child.pid) in {True, False}


def test_elsewhere_nothing_is_known_or_changed(monkeypatch) -> None:
    monkeypatch.setattr(priority.sys, "platform", "linux")
    assert priority.io_priority() is None
    assert priority.io_priority_level(1) is None
    assert priority.read_at_normal_priority(1) is False
    assert priority.set_io_priority(1, priority.NORMAL) is False
