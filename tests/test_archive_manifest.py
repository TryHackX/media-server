"""Large archives: the file list waits in ``archive_manifests``, the token only names it.

A token carrying every path stopped fitting under its 64 KiB cap at about 270
files, and the bridge answered 500 after counting the download. Past a small
inline list the bridge now stores the list (migration 042) and seals its key,
the SHA-256 of the stored bytes and the number of entries. These tests pin both
halves: the PHP side seals what Python reads, and Python serves a stored list
only when it is exactly the sealed one.
"""
from __future__ import annotations

import base64
import hashlib
import io
import json
import os
import shutil
import subprocess
import time
import zipfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from media_server.app import create_app
from media_server.config import AppConfig
from media_server.security import (
    GrantItem,
    ManifestRef,
    TokenError,
    manifest_items,
    open_grant,
    seal_grant,
)

PHP_INTEGRATION = Path(__file__).resolve().parents[1] / "integrations" / "php"
MANIFEST_ID = "ab" * 32


def _stored_list(entries: list[dict[str, str]]) -> bytes:
    # What the bridge stores: json_encode with unescaped slashes and unicode.
    return json.dumps(entries, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def _manifest_token(config: AppConfig, data: bytes, count: int, *, ttl: int = 300) -> str:
    return seal_grant(
        key=config.security.transfer_key,
        kind="archive",
        items=[],
        download_name="duze.zip",
        ttl_seconds=ttl,
        manifest=ManifestRef(id=MANIFEST_ID, sha256=hashlib.sha256(data).hexdigest(), count=count),
        now=int(time.time()),
    )


def _app_with(config: AppConfig, store: dict[str, bytes]):
    app = create_app(config)
    app.state.archive_manifest_loader = store.get
    return app


def test_stored_list_is_served_through_get_and_post(app_config: AppConfig, media_root: Path) -> None:
    (media_root / "one.txt").write_text("one", encoding="utf-8")
    (media_root / "two.txt").write_text("two", encoding="utf-8")
    data = _stored_list([
        {"root": "music", "path": "one.txt", "archive_name": "music/one.txt"},
        {"root": "music", "path": "two.txt", "archive_name": "music/two.txt"},
    ])
    token = _manifest_token(app_config, data, 2)
    assert len(token) < 1024, "the token names the list instead of carrying it"

    with TestClient(_app_with(app_config, {MANIFEST_ID: data})) as client:
        for response in (
            client.post("/v1/archives", data={"token": token}),
            client.get(f"/v1/archives/{token}"),
        ):
            assert response.status_code == 200
            assert response.headers["x-archive-entries"] == "2"
            with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
                assert archive.read("music/one.txt") == b"one"
                assert archive.read("music/two.txt") == b"two"


@pytest.mark.parametrize(
    ("stored", "count"),
    [
        # A different list under the same key: the digest no longer matches.
        (b'[{"root":"music","path":"two.txt"}]', 1),
        # The sealed list, but the token claims another length.
        (None, 3),
    ],
)
def test_a_list_that_is_not_the_sealed_one_is_refused(
    app_config: AppConfig, media_root: Path, stored: bytes | None, count: int
) -> None:
    (media_root / "one.txt").write_text("one", encoding="utf-8")
    (media_root / "two.txt").write_text("two", encoding="utf-8")
    sealed = _stored_list([{"root": "music", "path": "one.txt"}, {"root": "music", "path": "two.txt"}])
    token = _manifest_token(app_config, sealed, count)
    with TestClient(_app_with(app_config, {MANIFEST_ID: stored if stored is not None else sealed})) as client:
        assert client.post("/v1/archives", data={"token": token}).status_code == 403


def test_an_expired_or_unknown_list_is_refused(app_config: AppConfig, media_root: Path) -> None:
    (media_root / "one.txt").write_text("one", encoding="utf-8")
    data = _stored_list([{"root": "music", "path": "one.txt"}])
    token = _manifest_token(app_config, data, 1)
    # The loader answers None once the row has expired or never existed.
    with TestClient(_app_with(app_config, {})) as client:
        assert client.post("/v1/archives", data={"token": token}).status_code == 403


def test_a_database_failure_is_a_503_not_a_500(app_config: AppConfig) -> None:
    data = _stored_list([{"root": "music", "path": "one.txt"}])
    token = _manifest_token(app_config, data, 1)

    def broken(_manifest_id: str) -> bytes | None:
        raise OSError("database down")

    app = create_app(app_config)
    app.state.archive_manifest_loader = broken
    with TestClient(app) as client:
        assert client.post("/v1/archives", data={"token": token}).status_code == 503


def test_stored_paths_obey_the_same_rules_as_inline_ones(app_config: AppConfig) -> None:
    ref_for = lambda data, count: ManifestRef(id=MANIFEST_ID, sha256=hashlib.sha256(data).hexdigest(), count=count)  # noqa: E731
    bad = _stored_list([{"root": "music", "path": "a\nb.txt"}])
    with pytest.raises(TokenError):
        manifest_items(bad, ref_for(bad, 1), max_archive_entries=100)
    too_many = _stored_list([{"root": "music", "path": f"{i}.txt"} for i in range(101)])
    with pytest.raises(TokenError):
        manifest_items(too_many, ref_for(too_many, 101), max_archive_entries=100)
    good = _stored_list([{"root": "music", "path": "a.txt", "archive_name": "music/a.txt"}])
    assert manifest_items(good, ref_for(good, 1), max_archive_entries=100) == (
        GrantItem(root="music", path="a.txt", archive_name="music/a.txt"),
    )


def test_a_token_cannot_carry_both_a_list_and_items(transfer_key: bytes) -> None:
    with pytest.raises(ValueError):
        seal_grant(
            key=transfer_key,
            kind="archive",
            items=[GrantItem(root="music", path="a.txt")],
            download_name="x.zip",
            manifest=ManifestRef(id=MANIFEST_ID, sha256="cd" * 32, count=1),
        )
    with pytest.raises(ValueError):
        seal_grant(
            key=transfer_key,
            kind="file",
            items=[],
            download_name="x.bin",
            manifest=ManifestRef(id=MANIFEST_ID, sha256="cd" * 32, count=1),
        )


def _php(code: str, key: bytes) -> str:
    php = shutil.which("php")
    if php is None:
        pytest.skip("PHP nie jest dostępne w PATH")
    environment = os.environ.copy()
    environment["MEDIA_BRIDGE"] = str(PHP_INTEGRATION / "TransferToken.php")
    environment["MEDIA_KEY"] = base64.urlsafe_b64encode(key).rstrip(b"=").decode("ascii")
    return subprocess.run(
        [php, "-r", "require getenv('MEDIA_BRIDGE');" + code],
        capture_output=True, text=True, env=environment, check=True, encoding="utf-8",
    ).stdout


def test_php_seals_a_manifest_python_opens_and_verifies(transfer_key: bytes) -> None:
    # A thousand entries with long Polish paths: about 330 KiB of list, which no
    # 64 KiB token could carry. The bridge hashes exactly what it stores.
    output = _php(
        "use TryHackX\\Media\\Integration\\TransferToken as T;"
        "$items=[];for($i=0;$i<1000;$i++){$p='Zespół ' . $i . '/Płyta pełna dźwięków (' . $i . ')/'"
        ". str_pad((string)$i, 3, '0', STR_PAD_LEFT) . ' - utwór o bardzo długiej nazwie żeby lista była duża.flac';"
        "$items[]=['root'=>'music','path'=>$p,'archive_name'=>'music/' . $p];}"
        "$list=json_encode($items, JSON_THROW_ON_ERROR|JSON_UNESCAPED_SLASHES|JSON_UNESCAPED_UNICODE);"
        "$id=str_repeat('ab',32);"
        "echo T::archiveManifest(getenv('MEDIA_KEY'),$id,hash('sha256',$list),count($items),'duze.zip',300,'7',2),"
        " PHP_EOL, base64_encode($list), PHP_EOL;"
        # The inline token refuses the same list, which is the failure this replaces.
        "try { T::archive(getenv('MEDIA_KEY'),$items,'duze.zip'); echo 'inline-fits'; }"
        " catch (InvalidArgumentException) { echo 'inline-too-large'; }",
        transfer_key,
    )
    token, encoded, inline = output.split()
    stored = base64.b64decode(encoded)
    assert len(stored) > 65536
    assert inline == "inline-too-large"
    assert len(token) < 1024
    grant = open_grant(
        token,
        key=transfer_key,
        max_ttl_seconds=900,
        clock_skew_seconds=5,
        max_token_bytes=65536,
        max_archive_entries=1000,
        now=int(time.time()),
    )
    assert grant.kind == "archive" and grant.uses == {"download"}
    assert grant.items == () and grant.manifest is not None
    assert grant.subject == "7" and grant.max_downloads == 2
    items = manifest_items(stored, grant.manifest, max_archive_entries=1000)
    assert len(items) == 1000
    assert items[0].path.startswith("Zespół 0/Płyta")
    assert items[999].archive_name == "music/" + items[999].path


def test_php_refuses_a_malformed_manifest_reference(transfer_key: bytes) -> None:
    output = _php(
        "use TryHackX\\Media\\Integration\\TransferToken as T;"
        "foreach ([['xyz',str_repeat('a',64),1],[str_repeat('a',64),str_repeat('a',64),0]] as [$i,$h,$c]) {"
        " try { T::archiveManifest(getenv('MEDIA_KEY'),$i,$h,$c); echo 'issued', PHP_EOL; }"
        " catch (InvalidArgumentException) { echo 'refused', PHP_EOL; } }"
        "echo T::sealableItem(['root'=>'music','path'=>\"a\\nb.flac\"]) ? 'sealable' : 'unsealable', PHP_EOL;"
        "echo T::sealableItem(['root'=>'music','path'=>'a.flac','archive_name'=>'music/a.flac']) ? 'sealable' : 'unsealable';",
        transfer_key,
    )
    assert output.split() == ["refused", "refused", "unsealable", "sealable"]
