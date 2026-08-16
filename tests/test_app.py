from __future__ import annotations

import base64
import io
import threading
import time
import zipfile
from dataclasses import replace
from pathlib import Path

from fastapi.testclient import TestClient

import media_server.app as app_module
from media_server.app import _internal_api_key, create_app
from media_server.config import AppConfig
from media_server.security import GrantItem, seal_grant


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
