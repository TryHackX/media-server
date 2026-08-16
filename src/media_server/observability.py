from __future__ import annotations

import json
import logging
import os
import time
from dataclasses import dataclass, field
from datetime import UTC, datetime
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Any

_EXTRA_FIELDS = (
    "event",
    "method",
    "route",
    "status",
    "duration_ms",
    "transfer_kind",
    "outcome",
    "bytes_streamed",
)


# Every token-bearing route: the trailing path segment is a capability token
# (a bearer credential) and must never reach the logs verbatim. Longest prefixes
# first so /v1/stereo-keyframe/ is matched before /v1/stereo/.
_TOKEN_ROUTE_PREFIXES = (
    "/v1/files/",
    "/v1/archives/",
    "/v1/thumbnails/",
    "/v1/subtitles/",
    "/v1/stereo-info/",
    "/v1/stereo-keyframe/",
    "/v1/stereo/",
)


def sanitize_route(path: str) -> str:
    for prefix in _TOKEN_ROUTE_PREFIXES:
        if path.startswith(prefix):
            return prefix + "{token}"
    return path


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "timestamp": datetime.now(UTC).isoformat(timespec="milliseconds"),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
        }
        for field_name in _EXTRA_FIELDS:
            value = getattr(record, field_name, None)
            if value is not None:
                payload[field_name] = value
        if record.exc_info:
            payload["exception"] = self.formatException(record.exc_info)
        return json.dumps(payload, ensure_ascii=False, separators=(",", ":"))


def default_log_dir(config_path: Path) -> Path:
    configured = os.environ.get("MEDIA_SERVER_LOG_DIR")
    if configured:
        selected = Path(configured).expanduser()
        if not selected.is_absolute():
            raise ValueError("MEDIA_SERVER_LOG_DIR must be an absolute path")
        return selected.resolve()
    return (config_path.parent.parent / "logs").resolve()


def configure_logging(
    log_dir: Path,
    *,
    max_bytes: int = 10 * 1024 * 1024,
    backup_count: int = 5,
) -> Path:
    log_dir.mkdir(parents=True, exist_ok=True)
    log_path = log_dir / "media-server.jsonl"
    formatter = JsonFormatter()

    stream = logging.StreamHandler()
    stream.setFormatter(formatter)
    rotating = RotatingFileHandler(
        log_path,
        maxBytes=max_bytes,
        backupCount=backup_count,
        encoding="utf-8",
    )
    rotating.setFormatter(formatter)

    root = logging.getLogger()
    root.handlers.clear()
    root.setLevel(logging.INFO)
    root.addHandler(stream)
    root.addHandler(rotating)
    for logger_name in ("uvicorn", "uvicorn.error", "uvicorn.access"):
        logger = logging.getLogger(logger_name)
        logger.handlers.clear()
        logger.propagate = True
    return log_path


@dataclass(slots=True)
class RuntimeMetrics:
    started_at_utc: str = field(default_factory=lambda: datetime.now(UTC).isoformat(timespec="seconds"))
    started_monotonic: float = field(default_factory=time.monotonic)
    requests_total: int = 0
    responses_4xx: int = 0
    responses_5xx: int = 0
    transfers_started: int = 0
    transfers_completed: int = 0
    transfers_cancelled: int = 0
    transfers_failed: int = 0
    transfers_active: int = 0
    bytes_streamed: int = 0

    def record_request(self, status: int) -> None:
        self.requests_total += 1
        if 400 <= status < 500:
            self.responses_4xx += 1
        elif status >= 500:
            self.responses_5xx += 1

    def start_transfer(self) -> None:
        self.transfers_started += 1
        self.transfers_active += 1

    def finish_transfer(self, outcome: str, bytes_streamed: int) -> None:
        self.transfers_active = max(0, self.transfers_active - 1)
        self.bytes_streamed += max(0, bytes_streamed)
        if outcome == "completed":
            self.transfers_completed += 1
        elif outcome == "cancelled":
            self.transfers_cancelled += 1
        else:
            self.transfers_failed += 1

    def snapshot(self, *, max_concurrent_transfers: int) -> dict[str, int | float | str]:
        return {
            "started_at_utc": self.started_at_utc,
            "uptime_seconds": round(time.monotonic() - self.started_monotonic, 3),
            "requests_total": self.requests_total,
            "responses_4xx": self.responses_4xx,
            "responses_5xx": self.responses_5xx,
            "transfers_started": self.transfers_started,
            "transfers_completed": self.transfers_completed,
            "transfers_cancelled": self.transfers_cancelled,
            "transfers_failed": self.transfers_failed,
            "transfers_active": self.transfers_active,
            "max_concurrent_transfers": max_concurrent_transfers,
            "bytes_streamed": self.bytes_streamed,
        }
