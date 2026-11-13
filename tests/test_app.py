from __future__ import annotations

import base64
import io
import threading
import time
import zipfile
from dataclasses import replace
from pathlib import Path

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

import media_server.app as app_module
from media_server.app import _internal_api_key, create_app
from media_server.config import AppConfig
from media_server.security import GrantItem, TransferGrant, seal_grant


def _file_token(config: AppConfig, path: str, name: str = "sample.bin") -> str:
    return seal_grant(
        key=config.security.transfer_key,
        kind="file",
        items=[GrantItem(root="music", path=path)],
        download_name=name,
        disposition="inline",
        ttl_seconds=300,
        now=int(time.time()),
    )


def test_file_full_head_range_resume_and_416(app_config: AppConfig, media_root: Path) -> None:
    target = media_root / "sample.bin"
    target.write_bytes(b"0123456789")
    token = _file_token(app_config, "sample.bin")

    with TestClient(create_app(app_config)) as client:
        full = client.get(f"/v1/files/{token}")
        assert full.status_code == 200
        assert full.content == b"0123456789"
        assert full.headers["accept-ranges"] == "bytes"
        assert full.headers["x-content-type-options"] == "nosniff"
        assert "inline" in full.headers["content-disposition"]

        head = client.head(f"/v1/files/{token}")
        assert head.status_code == 200
        assert head.content == b""
        assert head.headers["content-length"] == "10"

        partial = client.get(f"/v1/files/{token}", headers={"Range": "bytes=2-5"})
        assert partial.status_code == 206
        assert partial.content == b"2345"
        assert partial.headers["content-range"] == "bytes 2-5/10"

        changed = client.get(
            f"/v1/files/{token}",
            headers={"Range": "bytes=2-5", "If-Range": '"stale"'},
        )
        assert changed.status_code == 200
        assert changed.content == b"0123456789"

        invalid = client.get(f"/v1/files/{token}", headers={"Range": "bytes=99-"})
        assert invalid.status_code == 416
        assert invalid.headers["content-range"] == "bytes */10"

        cached = client.get(f"/v1/files/{token}", headers={"If-None-Match": full.headers["etag"]})
        assert cached.status_code == 304


def test_archive_get_and_post(app_config: AppConfig, media_root: Path) -> None:
    (media_root / "one.txt").write_text("one", encoding="utf-8")
    (media_root / "two.txt").write_text("two", encoding="utf-8")
    token = seal_grant(
        key=app_config.security.transfer_key,
        kind="archive",
        items=[
            GrantItem(root="music", path="one.txt", archive_name="folder/one.txt"),
            GrantItem(root="music", path="two.txt", archive_name="folder/two.txt"),
        ],
        download_name="zestaw.zip",
        ttl_seconds=300,
        now=int(time.time()),
    )

    with TestClient(create_app(app_config)) as client:
        for response in (
            client.get(f"/v1/archives/{token}"),
            client.post("/v1/archives", data={"token": token}),
        ):
            assert response.status_code == 200
            assert response.headers["x-archive-entries"] == "2"
            with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
                assert archive.read("folder/one.txt") == b"one"
                assert archive.read("folder/two.txt") == b"two"


def test_tampering_and_path_escape_are_not_disclosed(app_config: AppConfig) -> None:
    token = _file_token(app_config, "../secret.txt")
    with TestClient(create_app(app_config)) as client:
        missing = client.get(f"/v1/files/{token}")
        assert missing.status_code == 404
        assert "secret" not in missing.text

        replacement = "A" if token[-1] != "A" else "B"
        rejected = client.get(f"/v1/files/{token[:-1] + replacement}")
        assert rejected.status_code == 403
def test_catalog_scan_requires_internal_key_and_runs_in_background(
    app_config: AppConfig,
    monkeypatch,
) -> None:
    completed = threading.Event()
    calls: list[dict[str, object]] = []

    def fake_scan_catalog(**kwargs):
        calls.append(kwargs)
        completed.set()
        return {"status": "completed"}

    monkeypatch.setattr(app_module, "scan_catalog", fake_scan_catalog)
    internal_key = _internal_api_key(app_config)
    # The internal key must be derived from, not equal to, the raw transfer key.
    raw_key = base64.urlsafe_b64encode(app_config.security.transfer_key).rstrip(b"=").decode("ascii")
    with TestClient(create_app(app_config)) as client:
        denied = client.post("/v1/catalog-scan", json={"root": "music", "kind": "music"})
        with_raw_key = client.post(
            "/v1/catalog-scan",
            headers={"X-Media-Internal-Key": raw_key},
            json={"root": "music", "kind": "music"},
        )
        started = client.post(
            "/v1/catalog-scan",
            headers={"X-Media-Internal-Key": internal_key},
            json={"root": "music", "kind": "music"},
        )
        invalid = client.post(
            "/v1/catalog-scan",
            headers={"X-Media-Internal-Key": internal_key},
            json={"root": "missing", "kind": "music"},
        )
        assert completed.wait(timeout=1)

    assert denied.status_code == 403
    assert with_raw_key.status_code == 403
    assert started.status_code == 202
    assert started.json() == {"status": "started", "root": "music"}
    assert invalid.status_code == 422
    assert calls[0]["root_slug"] == "music"
    assert calls[0]["apply"] is True
    assert calls[0]["batch_size"] == 500
    assert calls[0]["metadata_enabled"] is True


def test_catalog_scan_accepts_tuning_and_rejects_bad_values(app_config: AppConfig, monkeypatch) -> None:
    calls: list[dict[str, object]] = []
    completed = threading.Event()

    def fake_scan_catalog(**kwargs):
        calls.append(kwargs)
        completed.set()
        return {"status": "completed"}

    monkeypatch.setattr(app_module, "scan_catalog", fake_scan_catalog)
    headers = {"X-Media-Internal-Key": _internal_api_key(app_config)}
    with TestClient(create_app(app_config)) as client:
        bad_batch = client.post(
            "/v1/catalog-scan", headers=headers, json={"root": "music", "kind": "music", "batch_size": 5}
        )
        bad_flag = client.post(
            "/v1/catalog-scan", headers=headers, json={"root": "music", "kind": "music", "metadata": "yes"}
        )
        tuned = client.post(
            "/v1/catalog-scan",
            headers=headers,
            json={"root": "music", "kind": "music", "batch_size": 1000, "metadata": False},
        )
        assert completed.wait(timeout=1)

    assert bad_batch.status_code == 422
    assert bad_flag.status_code == 422
    assert tuned.status_code == 202
    assert calls[0]["batch_size"] == 1000
    assert calls[0]["metadata_enabled"] is False


def test_concurrent_download_cap_is_enforced_per_subject(app_config: AppConfig, media_root: Path) -> None:
    (media_root / "big.bin").write_bytes(b"x" * 64)
    (media_root / "song.flac").write_bytes(b"y" * 16)
    download = seal_grant(
        key=app_config.security.transfer_key,
        kind="file",
        items=[GrantItem(root="music", path="big.bin")],
        download_name="big.bin",
        disposition="attachment",
        subject="42",
        max_downloads=2,
        now=int(time.time()),
    )
    playback = seal_grant(
        key=app_config.security.transfer_key,
        kind="file",
        items=[GrantItem(root="music", path="song.flac")],
        download_name="song.flac",
        disposition="inline",
        subject="42",
        max_downloads=2,
        now=int(time.time()),
    )
    archive = seal_grant(
        key=app_config.security.transfer_key,
        kind="archive",
        items=[GrantItem(root="music", path="big.bin"), GrantItem(root="music", path="song.flac")],
        download_name="pair.zip",
        subject="42",
        max_downloads=2,
        now=int(time.time()),
    )
    other_subject = seal_grant(
        key=app_config.security.transfer_key,
        kind="file",
        items=[GrantItem(root="music", path="big.bin")],
        download_name="big.bin",
        disposition="attachment",
        subject="43",
        max_downloads=1,
        now=int(time.time()),
    )

    app = create_app(app_config)
    registry = app.state.subject_downloads
    with TestClient(app) as client:
        # Two transfers of this account are already in flight (simulated), so a
        # third file or archive is refused, playback still works, and other
        # accounts are unaffected.
        assert registry.try_acquire("42", 2) and registry.try_acquire("42", 2)
        assert client.get(f"/v1/files/{download}").status_code == 429
        assert client.post("/v1/archives", data={"token": archive}).status_code == 429
        assert client.head(f"/v1/files/{download}").status_code == 200
        assert client.get(f"/v1/files/{playback}").status_code == 200
        assert client.get(f"/v1/files/{other_subject}").status_code == 200

        # One in-flight transfer finishes: the slot is free again and is released
        # once the response body has been streamed.
        registry.release("42")
        assert client.get(f"/v1/files/{download}").status_code == 200
        assert registry.active("42") == 1
        assert client.post("/v1/archives", data={"token": archive}).status_code == 200
        assert registry.active("42") == 1
        registry.release("42")
        assert registry.active("42") == 0




def test_disconnected_source_is_not_ready_and_does_not_disclose_path(
    app_config: AppConfig,
    tmp_path: Path,
) -> None:
    disconnected = tmp_path / "not-mounted"
    offline_config = replace(app_config, roots={"music": disconnected})
    token = _file_token(offline_config, "sample.bin")

    with TestClient(create_app(offline_config)) as client:
        assert client.get("/health/live").status_code == 200
        ready = client.get("/health/ready")
        assert ready.status_code == 503
        assert ready.json() == {"status": "not_ready", "unavailable_roots": ["music"]}

        transfer = client.get(f"/v1/files/{token}")
        assert transfer.status_code == 404
        assert str(disconnected) not in transfer.text


@pytest.mark.parametrize(
    "route",
    ["/v1/catalog-scan", "/v1/metadata-worker", "/v1/title-worker", "/v1/stats", "/v1/subtitle-cache"],
)
def test_internal_key_outside_ascii_is_refused_not_crashed(app_config: AppConfig, route: str) -> None:
    # hmac.compare_digest refuses two str values unless both are pure ASCII, so a
    # header like this one used to raise TypeError and answer 500.
    with TestClient(create_app(app_config)) as client:
        response = client.post(route, headers={"X-Media-Internal-Key": "klucz-żółw".encode("utf-8")}, json={})
    assert response.status_code == 403


def test_an_unknown_range_unit_is_ignored_and_an_if_range_date_must_match_exactly(
    app_config: AppConfig, media_root: Path
) -> None:
    target = media_root / "sample.bin"
    target.write_bytes(b"0123456789")
    token = _file_token(app_config, "sample.bin")
    with TestClient(create_app(app_config)) as client:
        unknown = client.get(f"/v1/files/{token}", headers={"Range": "items=2-5"})
        assert unknown.status_code == 200 and unknown.content == b"0123456789"

        last_modified = client.head(f"/v1/files/{token}").headers["last-modified"]
        exact = client.get(f"/v1/files/{token}", headers={"Range": "bytes=2-5", "If-Range": last_modified})
        assert exact.status_code == 206 and exact.content == b"2345"
        # Any later date used to count as a match.
        later = client.get(
            f"/v1/files/{token}",
            headers={"Range": "bytes=2-5", "If-Range": "Fri, 31 Dec 2100 23:59:59 GMT"},
        )
        assert later.status_code == 200 and later.content == b"0123456789"


def test_the_files_a_grant_names_are_checked_off_the_event_loop(
    app_config: AppConfig, media_root: Path, monkeypatch
) -> None:
    """On an SMB or NFS share every resolve and stat is a round trip; an archive is hundreds."""
    import asyncio

    (media_root / "one.txt").write_text("one", encoding="utf-8")
    (media_root / "two.txt").write_text("two", encoding="utf-8")
    on_loop: list[bool] = []

    def watched(real):
        def resolve(grant, roots):
            try:
                asyncio.get_running_loop()
                on_loop.append(True)
            except RuntimeError:
                on_loop.append(False)
            return real(grant, roots)

        return resolve

    # A file's grant and an archive's are resolved by two functions (the archive
    # goes on without a file that is gone); neither may run on the loop.
    monkeypatch.setattr(app_module, "resolve_grant", watched(app_module.resolve_grant))
    monkeypatch.setattr(app_module, "resolve_available", watched(app_module.resolve_available))
    archive = seal_grant(
        key=app_config.security.transfer_key,
        kind="archive",
        items=[GrantItem(root="music", path="one.txt"), GrantItem(root="music", path="two.txt")],
        download_name="pair.zip",
        ttl_seconds=300,
        now=int(time.time()),
    )
    with TestClient(create_app(app_config)) as client:
        assert client.get(f"/v1/archives/{archive}").status_code == 200
        assert client.get(f"/v1/files/{_file_token(app_config, 'one.txt')}").status_code == 200
    assert on_loop == [False, False]


def test_a_root_that_stops_answering_does_not_hold_up_readiness(
    app_config: AppConfig, tmp_path: Path, monkeypatch
) -> None:
    """A hung mount used to block the event loop — every transfer — inside /health/ready."""
    import threading

    stuck = tmp_path / "stuck-share"
    config = replace(app_config, roots={"music": app_config.roots["music"], "share": stuck})
    release = threading.Event()
    asked: list[str] = []
    real = app_module._root_ready

    def ready(path):
        asked.append(path.name)
        if path == stuck:
            release.wait(timeout=10)
            return True
        return real(path)

    monkeypatch.setattr(app_module, "_root_ready", ready)
    monkeypatch.setattr(app_module, "_READY_TIMEOUT_SECONDS", 0.2)
    try:
        with TestClient(create_app(config)) as client:
            started = time.monotonic()
            first = client.get("/health/ready")
            second = client.get("/health/ready")
            elapsed = time.monotonic() - started
            assert first.status_code == 503 and first.json()["unavailable_roots"] == ["share"]
            assert second.json()["unavailable_roots"] == ["share"]
            assert elapsed < 3
            # The share was asked once: the second check found the first still waiting.
            assert asked.count("stuck-share") == 1
            assert client.get("/health/live").status_code == 200
            # Let the stranded thread go before the loop shuts its executor down.
            release.set()
    finally:
        release.set()


def test_viewers_and_the_background_pass_wait_on_different_subtitle_slots(
    app_config: AppConfig, media_root: Path, monkeypatch
) -> None:
    """One semaphore served both, so an hours-long warm-up made viewers' subtitles wait."""
    import asyncio
    import threading

    from media_server.config import StereoConfig

    movie = media_root / "movie.mkv"
    movie.write_bytes(b"video-source")
    config = replace(app_config, stereo=StereoConfig(ffmpeg_path="ffmpeg", subtitle_cache_path=media_root / "cache"))
    token = seal_grant(
        key=config.security.transfer_key,
        kind="file",
        items=[GrantItem(root="music", path="movie.mkv")],
        download_name="movie.mkv",
        disposition="inline",
        ttl_seconds=300,
        purpose="compat",
    )
    job_started = threading.Event()
    job_release = threading.Event()
    seen: dict[str, object] = {}

    async def warm(_config, status, semaphore, **_kwargs):
        seen["job"] = semaphore
        async with semaphore:
            job_started.set()
            while not job_release.is_set():
                await asyncio.sleep(0.01)
        status.update(state="completed", finished=True)

    async def info(_source, _config):
        return {"duration_seconds": 1.0, "video_codec": "h264", "subtitle_tracks": [
            {"index": 0, "codec": "subrip", "supported": True, "source": "embedded"}]}

    async def subtitles(_source, _config, _track, _start, semaphore, _sidecar, frame_rate=None):
        seen["viewer"] = semaphore
        async with semaphore:
            return b"WEBVTT\n\n00:00.000 --> 00:01.000\nHej\n"

    monkeypatch.setattr(app_module, "warm_subtitle_cache", warm)
    monkeypatch.setattr(app_module, "probe_media_info", info)
    monkeypatch.setattr(app_module, "extract_subtitle_webvtt", subtitles)
    application = create_app(config)
    headers = {"X-Media-Internal-Key": _internal_api_key(config)}
    try:
        with TestClient(application) as client:
            assert client.post("/v1/subtitle-cache", headers=headers, json={"operation": "start"}).status_code == 202
            assert job_started.wait(timeout=5)
            # The background pass holds its slot; the viewer is answered anyway.
            response = client.get(f"/v1/subtitles/{token}?subtitle_track=0")
            assert response.status_code == 200 and response.content.startswith(b"WEBVTT")
            job_release.set()
    finally:
        job_release.set()
    assert seen["job"] is application.state.subtitle_job_semaphore
    assert seen["viewer"] is application.state.subtitle_semaphore
    assert seen["job"] is not seen["viewer"]


def test_an_archive_goes_on_without_a_file_that_is_gone(app_config: AppConfig, media_root: Path) -> None:
    """One catalogued file deleted since the last scan used to turn the whole download into a 404 (T-02)."""
    (media_root / "one.txt").write_text("one", encoding="utf-8")
    (media_root / "two.txt").write_text("two", encoding="utf-8")
    (media_root / "now-a-folder.txt").mkdir()

    def archive(*paths: str) -> str:
        return seal_grant(
            key=app_config.security.transfer_key,
            kind="archive",
            items=[GrantItem(root="music", path=path, archive_name=f"album/{path}") for path in paths],
            download_name="album.zip",
            ttl_seconds=300,
            now=int(time.time()),
        )

    with TestClient(create_app(app_config)) as client:
        partial = client.get(f"/v1/archives/{archive('one.txt', 'deleted.txt', 'two.txt', 'now-a-folder.txt')}")
        assert partial.status_code == 200
        assert partial.headers["x-archive-entries"] == "2" and partial.headers["x-archive-missing"] == "2"
        with zipfile.ZipFile(io.BytesIO(partial.content)) as packed:
            assert packed.namelist() == ["album/one.txt", "album/two.txt", "_BRAKUJACE-PLIKI.txt"]
            assert packed.read("album/two.txt") == b"two"
            note = packed.read("_BRAKUJACE-PLIKI.txt").decode("utf-8")
        # The person who opens the archive is told what it should have held, by the names they know.
        assert "Brakujące pliki: 2" in note and "- album/deleted.txt" in note and "- album/now-a-folder.txt" in note
        assert str(media_root) not in note

        head = client.head(f"/v1/archives/{archive('one.txt', 'deleted.txt')}")
        assert head.status_code == 200 and head.headers["x-archive-missing"] == "1"

        whole = client.get(f"/v1/archives/{archive('one.txt', 'two.txt')}")
        assert "x-archive-missing" not in whole.headers
        with zipfile.ZipFile(io.BytesIO(whole.content)) as packed:
            assert packed.namelist() == ["album/one.txt", "album/two.txt"]

        # Nothing left to send is still "not there"; and a path that leaves its root is not "gone".
        assert client.get(f"/v1/archives/{archive('deleted.txt', 'also-deleted.txt')}").status_code == 404
        assert client.get(f"/v1/archives/{archive('one.txt', '../outside.txt')}").status_code in {403, 404}
        # A single file that is gone is what it always was.
        assert client.get(f"/v1/files/{_file_token(app_config, 'deleted.txt')}").status_code == 404


def test_one_account_cannot_play_on_every_slot(app_config: AppConfig, media_root: Path) -> None:
    """A playback grant is good for any number of connections, and nothing counted them (T-01)."""
    from media_server import app as transfer

    assert [transfer._inline_ceiling(slots) for slots in (1, 2, 4, 8, 32)] == [2, 2, 2, 6, 30]
    (media_root / "song.txt").write_text("song", encoding="utf-8")

    def grant(subject: str | None, disposition: str = "inline") -> TransferGrant:
        token = seal_grant(
            key=app_config.security.transfer_key, kind="file", items=[GrantItem(root="music", path="song.txt")],
            download_name="song.txt", disposition=disposition, ttl_seconds=300, subject=subject,
            purpose="play" if disposition == "inline" else "download", now=int(time.time()),
        )
        return transfer._open_token(token, app_config)

    playing = transfer._SubjectDownloadRegistry()
    held = [transfer._inline_slot(playing, grant("42"), 2) for _ in range(2)]
    assert all(callable(release) for release in held) and playing.active("42") == 2
    with pytest.raises(HTTPException) as refused:
        transfer._inline_slot(playing, grant("42"), 2)
    assert refused.value.status_code == 429 and refused.value.headers == {"Retry-After": "5"}
    # Another account is not held up by the first, a download is counted elsewhere, and a
    # grant without a subject (a diagnostic token) is not counted at all.
    assert callable(transfer._inline_slot(playing, grant("43"), 2))
    assert transfer._inline_slot(playing, grant("42", "attachment"), 2) is None
    assert transfer._inline_slot(playing, grant(None), 2) is None
    held[0]()
    assert playing.active("42") == 1 and callable(transfer._inline_slot(playing, grant("42"), 2))

    # Over HTTP: the place is given back when the file has been sent.
    application = create_app(app_config)
    token = seal_grant(
        key=app_config.security.transfer_key, kind="file", items=[GrantItem(root="music", path="song.txt")],
        download_name="song.txt", disposition="inline", ttl_seconds=300, subject="42", purpose="play",
        now=int(time.time()),
    )
    with TestClient(application) as client:
        for _ in range(8):
            assert client.get(f"/v1/files/{token}").status_code == 200
        assert application.state.subject_inline.active("42") == 0


def test_thumbnails_do_not_queue_behind_films(app_config: AppConfig, media_root: Path) -> None:
    """Eight films being played took every slot, and a page of covers came back as "busy" (T-01)."""
    (media_root / "cover.jpg").write_bytes(b"jpeg")
    application = create_app(app_config)
    token = seal_grant(
        key=app_config.security.transfer_key, kind="file", items=[GrantItem(root="music", path="cover.jpg")],
        download_name="cover.jpg", disposition="inline", ttl_seconds=300, purpose="thumb", now=int(time.time()),
    )
    assert application.state.thumbnail_transfer_semaphore is not application.state.transfer_semaphore

    async def take_every_transfer_slot() -> None:
        for _ in range(app_config.transfer.max_concurrent_transfers):
            await application.state.transfer_semaphore.acquire()

    with TestClient(application) as client:
        client.portal.call(take_every_transfer_slot)
        picture = client.get(f"/v1/thumbnails/{token}")
        assert picture.status_code == 200 and picture.content == b"jpeg"
        assert picture.headers["content-type"] == "image/jpeg"


@pytest.mark.parametrize(
    ("header", "status", "body"),
    [
        ("bytes=2-" + "9" * 5000, 206, b"23456789"),      # an end past any file: to the end of this one
        ("bytes=" + "9" * 5000 + "-", 416, b""),          # a start past any file
        ("bytes=-" + "9" * 5000, 206, b"0123456789"),     # "the last N bytes", N beyond the file: all of it
        ("bytes=0-" + "9" * 19, 206, b"0123456789"),
    ],
)
def test_a_range_too_long_to_be_a_number_is_still_answered(
    app_config: AppConfig, media_root: Path, header: str, status: int, body: bytes
) -> None:
    """More than 4300 digits made Python refuse the number, and the refusal left as a 500 (T-05)."""
    (media_root / "ten.txt").write_text("0123456789", encoding="utf-8")
    with TestClient(create_app(app_config)) as client:
        response = client.get(f"/v1/files/{_file_token(app_config, 'ten.txt')}", headers={"Range": header})
    assert response.status_code == status
    if status == 206:
        assert response.content == body
    else:
        assert response.headers["content-range"] == "bytes */10"


def test_a_worker_that_dies_is_named_in_the_log(app_config: AppConfig, monkeypatch, caplog) -> None:
    """The metadata run's failure was never read; the title worker's was logged as the metadata worker's (T-06)."""
    from media_server import app as transfer

    def broken(**_: object) -> None:
        raise RuntimeError("the queue is on fire")

    monkeypatch.setattr(transfer, "run_metadata_worker", broken)
    monkeypatch.setattr(transfer, "run_title_lookups", broken)
    key = {"x-media-internal-key": transfer._internal_api_key(app_config)}
    with caplog.at_level("ERROR", logger="media_server.transfer"), TestClient(create_app(app_config)) as client:
        assert client.post("/v1/metadata-worker", json={}, headers=key).status_code == 202
        assert client.post("/v1/title-worker", json={"root": "music"}, headers=key).status_code == 202
        for _ in range(100):
            if len([record for record in caplog.records if record.levelname == "ERROR"]) >= 2:
                break
            time.sleep(0.02)
    events = {getattr(record, "event", None): record for record in caplog.records if record.levelname == "ERROR"}
    assert set(events) == {"metadata_worker_failed", "title_worker_failed"}
    assert events["title_worker_failed"].getMessage() == "title worker failed"
    assert events["metadata_worker_failed"].error == "the queue is on fire"


def test_a_picture_track_with_nothing_in_it_is_read_once(app_config: AppConfig, media_root: Path, monkeypatch) -> None:
    """The player asks every four seconds; an empty or failed track answered 202 and read the film each time (T-03)."""
    from media_server import app as transfer
    from media_server.config import StereoConfig
    from media_server.stereo import StereoTranscodeError
    from media_server.subtitle_pictures import EmptySubtitleTrack

    (media_root / "movie.mkv").write_bytes(b"video-source")
    tracks = [{"index": 0, "codec": "hdmv_pgs_subtitle", "image": True}, {"index": 1, "codec": "dvd_subtitle", "image": True}]
    renders: list[int] = []

    async def fake_info(*_args, **_kwargs) -> dict[str, object]:
        return {"duration_seconds": 60.0, "video_width": 1920, "video_height": 1080, "subtitle_tracks": tracks}

    async def fake_render(_item, _config, track: int, *_rest) -> dict[str, object]:
        renders.append(track)
        if track == 0:
            raise EmptySubtitleTrack("Subtitle track produced no pictures to show")
        raise StereoTranscodeError("Subtitle rendering failed")

    monkeypatch.setattr(transfer, "probe_media_info", fake_info)
    monkeypatch.setattr(transfer, "render_subtitle_pictures", fake_render)
    monkeypatch.setattr(transfer, "find_picture_track", lambda *_args: (None, None))
    config = replace(app_config, stereo=StereoConfig(ffmpeg_path="ffmpeg"))
    token = seal_grant(
        key=config.security.transfer_key, kind="file", items=[GrantItem(root="music", path="movie.mkv")],
        download_name="movie.mkv", disposition="inline", ttl_seconds=900, purpose="compat", now=int(time.time()),
    )

    def ask(client: TestClient, track: int):
        return client.get(f"/v1/subtitle-pictures/{token}?subtitle_track={track}")

    def settled(client: TestClient, track: int):
        for _ in range(100):
            response = ask(client, track)
            if response.status_code != 202:
                return response
            time.sleep(0.02)
        raise AssertionError("the render never finished")

    with TestClient(create_app(config)) as client:
        first = ask(client, 0)
        assert first.status_code == 202 and first.json()["status"] == "rendering"
        empty = settled(client, 0)
        assert empty.status_code == 422 and empty.headers["cache-control"] == "no-store"
        assert empty.json() == {"status": "empty", "subtitle_track": 0, "detail": "Subtitle track holds no pictures"}
        failed = settled(client, 1)
        assert failed.status_code == 422 and failed.json()["status"] == "failed"
        # Asked again and again: answered from the record, the film is not read again.
        for _ in range(5):
            assert ask(client, 0).status_code == 422 and ask(client, 1).status_code == 422
        assert renders == [0, 1]

        # A failure is tried again once it is old enough; an empty track stays empty.
        patience = transfer._PICTURE_RETRY_SECONDS
        monkeypatch.setattr(transfer, "_PICTURE_RETRY_SECONDS", 0)
        assert ask(client, 1).status_code == 202
        assert ask(client, 0).status_code == 422
        monkeypatch.setattr(transfer, "_PICTURE_RETRY_SECONDS", patience)
        assert settled(client, 1).json()["status"] == "failed"
        assert renders == [0, 1, 1]
