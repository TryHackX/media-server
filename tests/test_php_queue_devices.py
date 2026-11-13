"""Which devices the queue panel offers (CatalogActions::visibleQueueDevices).

The list under "Na innych urządzeniach" used to show every queue a browser had
saved in the last 30 days, so a phone signed out yesterday was still offered
for "Przejmij" while "Aktywne sesje" listed only this computer. Rows now carry
the session that saved them, and the rule here decides what the panel shows.
"""
from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

PHP_INTEGRATION = Path(__file__).resolve().parents[1] / "integrations" / "php"


def _visible(rows: list[dict], device_id: str = "this-device") -> list[dict]:
    php = shutil.which("php")
    if php is None:
        pytest.skip("PHP nie jest dostępne w PATH")
    requires = "".join(
        f"require_once {json.dumps(str(PHP_INTEGRATION / name))};"
        for name in (
            "BridgeException.php",
            "LegacyIdentity.php",
            "Mailer.php",
            "PermissionGroups.php",
            "AccountGateway.php",
            "CatalogActions.php",
        )
    )
    body = (
        "use TryHackX\\Media\\Integration\\CatalogActions as C;"
        f"$rows = json_decode({json.dumps(json.dumps(rows))}, true);"
        f"echo json_encode(C::visibleQueueDevices($rows, {json.dumps(device_id)}));"
    )
    result = subprocess.run([php, "-r", requires + body], capture_output=True, text=True, check=True)
    return json.loads(result.stdout)


def _row(device: str, label: str, state: str, recent: int = 1) -> dict:
    return {"device_id": device, "device_label": label, "session_state": state, "is_recent": recent}


def _shown(rows: list[dict]) -> list[tuple[str, bool]]:
    return [(row["device_id"], row["is_live"]) for row in rows]


def test_a_signed_out_device_is_not_offered() -> None:
    shown = _visible([
        _row("phone", "Android · Chrome", "closed"),
        _row("laptop", "Windows · Firefox", "open"),
    ])
    assert _shown(shown) == [("laptop", True)]


def test_an_open_session_is_live_and_an_expired_one_is_only_recent() -> None:
    shown = _visible([
        _row("laptop", "Windows · Firefox", "open"),
        _row("phone", "Android · Chrome", "idle"),
        _row("tablet", "iOS · Safari", "unknown"),
    ])
    assert _shown(shown) == [("laptop", True), ("phone", False), ("tablet", False)]


def test_a_device_idle_for_more_than_a_week_is_gone() -> None:
    shown = _visible([
        _row("phone", "Android · Chrome", "idle", recent=0),
        _row("tv", "Linux · Chrome", "open", recent=0),
    ])
    assert _shown(shown) == [("tv", True)], "a live device stays however old its queue is"


def test_one_browser_under_two_ids_is_listed_once() -> None:
    # Site data cleared on the phone: a new device id, the same name, twice "Android · Chrome".
    shown = _visible([
        _row("phone-new", "Android · Chrome", "idle"),
        _row("phone-old", "Android · Chrome", "unknown"),
    ])
    assert _shown(shown) == [("phone-new", False)]


def test_a_live_device_wins_over_a_newer_idle_row_of_its_name() -> None:
    shown = _visible([
        _row("phone-old", "Android · Chrome", "idle"),
        _row("phone", "Android · Chrome", "open"),
    ])
    assert _shown(shown) == [("phone", True)]


def test_the_asking_device_is_kept_and_its_name_hides_nothing() -> None:
    # Another computer of the same make, or this browser before its data was cleared:
    # either way a queue that can still be resumed here.
    shown = _visible([
        _row("laptop", "Windows · Chrome", "idle"),
        _row("this-device", "Windows · Chrome", "closed"),
    ])
    assert _shown(shown) == [("laptop", False), ("this-device", True)]


def test_devices_without_a_name_are_not_merged() -> None:
    shown = _visible([
        _row("a", "", "idle"),
        _row("b", "", "idle"),
    ])
    assert _shown(shown) == [("a", False), ("b", False)]
