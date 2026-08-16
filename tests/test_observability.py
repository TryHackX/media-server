from __future__ import annotations

import json
import logging
from pathlib import Path

from fastapi.testclient import TestClient

from media_server.app import create_app
from media_server.config import AppConfig
from media_server.observability import JsonFormatter, RuntimeMetrics, configure_logging, sanitize_route


def test_token_routes_are_sanitized() -> None:
    assert sanitize_route("/v1/files/secret-token") == "/v1/files/{token}"
    assert sanitize_route("/v1/archives/secret-token") == "/v1/archives/{token}"
    assert sanitize_route("/v1/stereo/secret-token") == "/v1/stereo/{token}"
    assert sanitize_route("/v1/subtitles/secret-token") == "/v1/subtitles/{token}"
    assert sanitize_route("/v1/stereo-info/secret-token") == "/v1/stereo-info/{token}"
    assert sanitize_route("/health/live") == "/health/live"


def test_json_formatter_is_machine_readable() -> None:
    record = logging.LogRecord("media", logging.INFO, __file__, 1, "request complete", (), None)
    record.route = "/v1/files/{token}"
    record.status = 206
    payload = json.loads(JsonFormatter().format(record))
    assert payload["message"] == "request complete"
    assert payload["route"] == "/v1/files/{token}"
    assert payload["status"] == 206


def test_runtime_metrics_classifies_requests_and_transfers() -> None:
    metrics = RuntimeMetrics()
    metrics.record_request(200)
    metrics.record_request(404)
    metrics.record_request(503)
    metrics.start_transfer()
    metrics.finish_transfer("cancelled", 1024)
    snapshot = metrics.snapshot(max_concurrent_transfers=8)
    assert snapshot["requests_total"] == 3
    assert snapshot["responses_4xx"] == 1
    assert snapshot["responses_5xx"] == 1
    assert snapshot["transfers_cancelled"] == 1
    assert snapshot["transfers_active"] == 0
    assert snapshot["bytes_streamed"] == 1024


def test_health_status_exposes_only_operational_counters(app_config: AppConfig) -> None:
    with TestClient(create_app(app_config)) as client:
        client.get("/health/live")
        response = client.get("/health/status")
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    payload = response.json()
    assert payload["requests_total"] >= 1
    assert payload["max_concurrent_transfers"] == app_config.transfer.max_concurrent_transfers
    assert "transfer_key" not in response.text
    assert "password" not in response.text


def test_json_log_rotates_at_configured_size(tmp_path: Path) -> None:
    log_path = configure_logging(tmp_path, max_bytes=256, backup_count=2)
    logger = logging.getLogger("media_server.rotation_test")
    for index in range(20):
        logger.info("rotation probe %s %s", index, "x" * 80, extra={"event": "rotation_probe"})

    root = logging.getLogger()
    for handler in list(root.handlers):
        handler.flush()
        handler.close()
        root.removeHandler(handler)

    assert log_path.is_file()
    assert (tmp_path / "media-server.jsonl.1").is_file()
    assert len(list(tmp_path.glob("media-server.jsonl*"))) <= 3
    for path in tmp_path.glob("media-server.jsonl*"):
        for line in path.read_text(encoding="utf-8").splitlines():
            assert json.loads(line)["event"] == "rotation_probe"
