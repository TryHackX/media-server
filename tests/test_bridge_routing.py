"""The bridge's routing, over HTTP against MySQL (tests/bridge_harness.py).

What is checked here is what only the entry script decides: which actions answer
before sign-in, which need a session, a CSRF token or an administrator, and the
status code each refusal is given.
"""
from __future__ import annotations

import hashlib
import re
from datetime import datetime

from bridge_harness import TEST_PASSWORD

MUSIC = ["Abba/Arrival/01 - Dancing Queen.mp3", "Abba/Arrival/02 - Money.mp3", "Loose.mp3"]


def test_a_request_without_a_session_is_401_and_sets_no_cookie(bridge_http) -> None:
    client = bridge_http.client()
    for action in ("session", "browse", "home", "admin", "continue"):
        response = client.get(action)
        assert response.status == 401, action
        assert response.json == {"error": "authentication_required"}
    # No session was started for somebody who brought none (S-09).
    assert client.cookie("TRYHACKXTESTSESSID") is None


def test_sign_in_browse_and_sign_out(bridge_http, bridge_db, bridge_library) -> None:
    bridge_library.scan("music", "music", MUSIC)
    bridge_db.user("listener")
    client = bridge_http.client()

    state = client.get("auth_state")
    assert state.status == 200 and state.json["authenticated"] is False
    assert client.cookie("TRYHACKXTESTSESSID") is not None

    wrong = client.post("login", {"username": "listener", "password": "not the password"})
    assert wrong.status == 401

    signed = client.post("login", {"username": "listener", "password": TEST_PASSWORD})
    assert signed.status == 200 and signed.json["success"] is True
    assert signed.json["user"] == {"username": "listener", "role": "user"}

    session = client.get("session")
    assert session.status == 200 and session.json["user"]["username"] == "listener"
    assert session.json["permissions"]["can_access_music"] is True

    listing = client.get("browse", kind="music")
    assert listing.status == 200
    library = listing.json["library"]
    assert [folder["name"] for folder in library["directories"]] == ["Abba"]
    assert [item["title"] for item in library["items"]] == ["Loose"]

    assert client.post("logout").status == 200
    assert client.get("session").status == 401


def test_a_write_needs_the_csrf_token_and_post(bridge_http, bridge_db, bridge_library) -> None:
    bridge_library.scan("music", "music", MUSIC)
    bridge_db.user("listener")
    client = bridge_http.client()
    assert client.sign_in("listener").status == 200
    item = bridge_db.item_id("Loose.mp3")

    token = client.csrf
    client.csrf = "wrong"
    refused = client.post("rating", {"media_item_id": item, "favorite": True})
    assert refused.status == 403
    client.csrf = token
    assert client.request("GET", "rating").status == 405
    accepted = client.post("rating", {"media_item_id": item, "favorite": True})
    assert accepted.status == 200 and accepted.json["rating"]["user_favorite"] is True


def test_admin_actions_are_refused_to_an_ordinary_account(bridge_http, bridge_db) -> None:
    bridge_db.user("listener")
    bridge_db.user("operator", role="admin")
    client = bridge_http.client()
    assert client.sign_in("listener").status == 200
    assert client.get("admin").status == 403
    assert client.get("admin_activity").status == 403
    for action, payload in (
        ("admin_settings", {}),
        ("admin_user_create", {"username": "x", "password": "y"}),
        ("admin_group_save", {"name": "g"}),
        ("admin_stepup_release", {"subject": "u:1"}),
        ("admin_scan", {"root": "music", "kind": "music"}),
        ("digest_send", {}),
    ):
        assert client.post(action, payload).status == 403, action

    operator = bridge_http.client()
    assert operator.sign_in("operator").status == 200
    overview = operator.get("admin")
    assert overview.status == 200
    assert {user["username"] for user in overview.json["admin"]["users"]} == {"listener", "operator"}


def test_an_unknown_action_is_404_and_a_malformed_body_422(bridge_http, bridge_db) -> None:
    bridge_db.user("listener")
    client = bridge_http.client()
    assert client.sign_in("listener").status == 200
    assert client.post("no_such_action").status == 404
    assert client.get("browse", kind="pictures").status == 422
    assert client.post("rating", ["not", "an", "object"]).status == 422


def test_only_pictures_may_be_kept_by_the_browser(bridge_http, bridge_db, bridge_library) -> None:
    """JSON is never stored; a cover is kept for an hour, the redirect to a thumbnail while its grant lasts."""
    bridge_library.scan("music", "music", MUSIC)
    user = bridge_db.user("listener")
    item = bridge_db.item_id("Loose.mp3")
    covered = bridge_db.item_id("Abba/Arrival/02 - Money.mp3")
    picture = b"\x89PNG\r\n\x1a\n-not-a-real-picture"
    bridge_db.insert("media_artwork_overrides", media_item_id=covered, mime_type="image/png",
                     image_data=picture, content_hash=hashlib.sha256(picture).digest(), updated_by=user)
    client = bridge_http.client()
    assert client.sign_in("listener").status == 200

    listing = client.get("browse", kind="music")
    assert listing.header_values("Cache-Control") == ["no-store, max-age=0"]
    assert listing.header_values("Pragma") == ["no-cache"]
    assert listing.header_values("Expires") == []

    cover = client.get("preview", media_item_id=covered)
    assert cover.status == 200 and cover.body.startswith(b"\x89PNG")
    assert cover.header_values("Content-Type") == ["image/png"]
    assert cover.header_values("Cache-Control") == ["private, max-age=3600, must-revalidate"]
    assert cover.header_values("Pragma") == [] and cover.header_values("Expires") == []

    redirect = client.get("preview", media_item_id=item)
    assert redirect.status == 302
    assert redirect.header_values("Location")[0].startswith("/media-transfer/v1/thumbnails/v1.")
    assert redirect.header_values("Cache-Control") == ["private, max-age=780"]
    assert redirect.header_values("Pragma") == []


def test_the_indexing_tab_has_a_small_answer_of_its_own(bridge_http, bridge_db, bridge_library) -> None:
    """The tab asked for every account and every setting every four seconds to redraw four counters (ADM-06)."""
    bridge_library.scan("music", "music", MUSIC)
    bridge_db.user("listener")
    bridge_db.user("operator", role="admin")
    listener = bridge_http.client()
    assert listener.sign_in("listener").status == 200
    assert listener.get("admin_indexing_status").status == 403

    operator = bridge_http.client()
    assert operator.sign_in("operator").status == 200
    status = operator.get("admin_indexing_status")
    assert status.status == 200 and list(status.json) == ["indexing"]
    indexing = status.json["indexing"]
    assert list(indexing) == ["catalog", "scans", "metadata", "metadata_failures"]
    assert [(source["slug"], int(source["items"]), int(source["audio"])) for source in indexing["catalog"]] == [
        ("music", 3, 3),
    ]
    assert [(scan["slug"], scan["status"], scan["discovered_count"]) for scan in indexing["scans"]] == [
        ("music", "completed", 3),
    ]
    assert indexing["metadata"] == {"queued": 0, "running": 0, "failed": 0, "done": 0}
    # The same four keys, in the same shapes, as in the whole overview it stands in for.
    overview = operator.get("admin").json["admin"]
    assert {key: overview[key] for key in indexing} == indexing
    assert {"users", "settings", "groups", "stepup"} <= set(overview)


def test_every_timestamp_is_also_said_with_its_offset(bridge_http, bridge_db, bridge_library) -> None:
    """`2026-11-11 19:59:38` is local time — the server's — and a browser took it for its own (ACC-09)."""
    bridge_library.scan("music", "music", MUSIC)
    bridge_db.user("listener")
    bridge_db.user("operator", role="admin")
    operator = bridge_http.client()
    assert operator.sign_in("operator").status == 200

    sessions = operator.get("sessions").json["sessions"]
    assert len(sessions) == 1
    for field in ("created_at", "last_seen_at"):
        stored, said = sessions[0][field], sessions[0][field + "_iso"]
        # The old field is what it was; the new one is the same instant, in UTC, with the offset written.
        assert re.fullmatch(r"\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(\.\d+)?", stored)
        assert re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\+00:00", said)
        instant = int(bridge_db.value("SELECT FLOOR(UNIX_TIMESTAMP(%s))", (stored,)))
        assert int(datetime.fromisoformat(said).timestamp()) == instant

    overview = operator.get("admin").json["admin"]
    for user in overview["users"]:
        # Nothing stays nothing, under the new name too.
        assert user["disabled_at"] is None and user["disabled_at_iso"] is None
        assert user["created_at_iso"].endswith("+00:00") and user["email_verified_at_iso"].endswith("+00:00")
    assert all(scan["started_at_iso"].endswith("+00:00") and scan["finished_at_iso"] for scan in overview["scans"])

    # An answer without timestamps is left alone.
    listing = operator.get("browse", kind="music").json
    assert "_iso" not in str(listing)


def test_iso_siblings_at_every_depth_and_only_for_database_timestamps(bridge_php) -> None:
    result = bridge_php.run(r"""
    $db->exec("SET time_zone = '+02:00'");
    out(BridgeTime::withIso($db, [
        'created_at' => '2026-07-01 12:00:00.250000',
        'covered_until' => '2026-01-15 08:30:00',
        'revoked_at' => null,
        'note_at' => 'not a time',
        'until_at' => 1794427178,
        'exported_at' => '2026-11-11T10:00:00+00:00',
        'expires_at' => '2026-07-01 12:00:00',
        'expires_at_iso' => 'already said',
        'title' => '2026-07-01 12:00:00',
        'rows' => [['last_played_at' => '2026-07-01 12:00:00.250000', 'deep' => ['updated_at' => '2026-12-31 23:59:59']]],
    ]));
    """)
    assert result == {
        "created_at": "2026-07-01 12:00:00.250000",
        "covered_until": "2026-01-15 08:30:00",
        "revoked_at": None,
        "note_at": "not a time",
        "until_at": 1794427178,
        "exported_at": "2026-11-11T10:00:00+00:00",
        "expires_at": "2026-07-01 12:00:00",
        "expires_at_iso": "already said",
        "title": "2026-07-01 12:00:00",
        "rows": [{
            "last_played_at": "2026-07-01 12:00:00.250000",
            "deep": {"updated_at": "2026-12-31 23:59:59", "updated_at_iso": "2026-12-31T21:59:59+00:00"},
            "last_played_at_iso": "2026-07-01T10:00:00+00:00",
        }],
        "created_at_iso": "2026-07-01T10:00:00+00:00",
        "covered_until_iso": "2026-01-15T06:30:00+00:00",
        "revoked_at_iso": None,
    }
    assert bridge_php.run("out(['none' => BridgeTime::iso(null), 'text' => BridgeTime::iso('x'), "
                          "'zero' => BridgeTime::iso(0), 'fraction' => BridgeTime::iso('1794427178.999999')]);") == {
        "none": None, "text": None, "zero": "1970-01-01T00:00:00+00:00", "fraction": "2026-11-11T19:59:38+00:00",
    }
