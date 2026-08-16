"""The scheduled run: what it does, in what order, and what it refuses to guess."""
from __future__ import annotations

import dataclasses
from pathlib import Path
from typing import Any

import pytest

from media_server import maintenance
from media_server.catalog import CatalogError
from media_server.config import AppConfig
from media_server.title_worker import TitleWorkerError


@pytest.fixture
def two_roots(app_config: AppConfig, tmp_path: Path) -> AppConfig:
    movies = tmp_path / "movies"
    movies.mkdir()
    return dataclasses.replace(app_config, roots={**app_config.roots, "movies": movies})


@pytest.fixture
def calls(monkeypatch: pytest.MonkeyPatch) -> dict[str, list[dict[str, Any]]]:
    """Every worker replaced by a recorder; nothing here touches a database."""
    recorded: dict[str, list[dict[str, Any]]] = {"scan": [], "metadata": [], "titles": []}

    def scan(**kwargs: Any) -> dict[str, Any]:
        recorded["scan"].append(kwargs)
        return {"status": "completed"}

    def metadata(**kwargs: Any) -> dict[str, Any]:
        recorded["metadata"].append(kwargs)
        return {"status": "completed", "claimed": 0}

    def titles(**kwargs: Any) -> dict[str, Any]:
        recorded["titles"].append(kwargs)
        return {"status": "completed", "matched": 1}

    monkeypatch.setattr(maintenance, "scan_catalog", scan)
    monkeypatch.setattr(maintenance, "run_metadata_worker", metadata)
    monkeypatch.setattr(maintenance, "run_title_lookups", titles)
    monkeypatch.setattr(maintenance, "ffprobe_for", lambda path: "ffprobe")
    monkeypatch.setattr(maintenance, "_root_kinds", lambda config: {"music": "music", "movies": "movies"})
    return recorded


def _steps(report: dict[str, Any], name: str) -> list[dict[str, Any]]:
    return [entry for entry in report["steps"] if entry["step"] == name]


def test_scan_takes_the_kind_from_the_catalogue_and_never_confirms_a_mass_removal(
    two_roots: AppConfig, calls: dict[str, list[dict[str, Any]]]
) -> None:
    report = maintenance.run_maintenance(config=two_roots, steps=("scan",), scan_batch_size=250)

    assert report["status"] == "ok"
    assert [call["root_slug"] for call in calls["scan"]] == ["movies", "music"]
    assert [call["root_kind"] for call in calls["scan"]] == ["movies", "music"]
    for call in calls["scan"]:
        assert call["apply"] is True
        assert call["metadata_enabled"] is True
        assert call["batch_size"] == 250
        # An unmounted drive looks exactly like an emptied library.
        assert call["allow_mass_missing"] is False


def test_a_root_nobody_has_scanned_is_skipped_rather_than_guessed(
    two_roots: AppConfig, calls: dict[str, list[dict[str, Any]]], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(maintenance, "_root_kinds", lambda config: {"music": "music"})

    report = maintenance.run_maintenance(config=two_roots, steps=("scan",))

    assert [call["root_slug"] for call in calls["scan"]] == ["music"]
    skipped = [entry for entry in _steps(report, "scan") if entry["status"] == "skipped"]
    assert [entry["root"] for entry in skipped] == ["movies"]
    assert "pierwszy skan" in skipped[0]["reason"]
    # A skip is not a failure: nothing broke, a decision is simply missing.
    assert report["status"] == "ok"


def test_film_lookups_only_visit_roots_that_hold_films(
    two_roots: AppConfig, calls: dict[str, list[dict[str, Any]]]
) -> None:
    report = maintenance.run_maintenance(config=two_roots, steps=("titles",), titles_limit=7)

    assert [call["root_slug"] for call in calls["titles"]] == ["movies"]
    assert calls["titles"][0]["limit"] == 7
    assert calls["titles"][0]["cache_path"].name == "filmweb-cache"
    assert len(_steps(report, "titles")) == 1


def test_mixed_roots_count_as_film_roots(
    two_roots: AppConfig, calls: dict[str, list[dict[str, Any]]], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(maintenance, "_root_kinds", lambda config: {"music": "music", "movies": "mixed"})

    maintenance.run_maintenance(config=two_roots, steps=("titles",))

    assert [call["root_slug"] for call in calls["titles"]] == ["movies"]


def test_a_failing_step_does_not_cancel_the_rest(
    two_roots: AppConfig, calls: dict[str, list[dict[str, Any]]], monkeypatch: pytest.MonkeyPatch
) -> None:
    def refuse(**kwargs: Any) -> dict[str, Any]:
        raise TitleWorkerError("Filmweb nie odpowiada")

    monkeypatch.setattr(maintenance, "run_title_lookups", refuse)

    report = maintenance.run_maintenance(config=two_roots)

    assert len(calls["scan"]) == 2
    assert len(calls["metadata"]) == 1
    assert report["status"] == "partial"
    assert report["failed"] == 1
    failure = _steps(report, "titles")[0]
    assert failure["status"] == "failed"
    assert "Filmweb" in failure["error"]


def test_one_broken_root_does_not_stop_the_other(
    two_roots: AppConfig, calls: dict[str, list[dict[str, Any]]], monkeypatch: pytest.MonkeyPatch
) -> None:
    def scan(**kwargs: Any) -> dict[str, Any]:
        if kwargs["root_slug"] == "movies":
            raise CatalogError("Zbyt wiele plików zniknęło")
        calls["scan"].append(kwargs)
        return {"status": "completed"}

    monkeypatch.setattr(maintenance, "scan_catalog", scan)

    report = maintenance.run_maintenance(config=two_roots, steps=("scan",))

    assert [call["root_slug"] for call in calls["scan"]] == ["music"]
    statuses = {entry["root"]: entry["status"] for entry in _steps(report, "scan")}
    assert statuses == {"movies": "failed", "music": "ok"}
    assert report["status"] == "partial"


def test_an_unreachable_catalogue_still_lets_the_metadata_queue_run(
    two_roots: AppConfig, calls: dict[str, list[dict[str, Any]]], monkeypatch: pytest.MonkeyPatch
) -> None:
    def unreachable(config: AppConfig) -> dict[str, str]:
        raise OSError("baza nie odpowiada")

    monkeypatch.setattr(maintenance, "_root_kinds", unreachable)

    report = maintenance.run_maintenance(config=two_roots)

    assert calls["scan"] == []
    assert calls["titles"] == []
    assert len(calls["metadata"]) == 1
    assert _steps(report, "roots")[0]["status"] == "failed"
    # Every root is reported as skipped, so the run never looks like it scanned.
    assert {entry["status"] for entry in _steps(report, "scan")} == {"skipped"}
    assert report["status"] == "partial"


def test_only_the_requested_steps_run(two_roots: AppConfig, calls: dict[str, list[dict[str, Any]]]) -> None:
    maintenance.run_maintenance(config=two_roots, steps=("metadata",))

    assert calls["scan"] == [] and calls["titles"] == []
    assert len(calls["metadata"]) == 1
    assert calls["metadata"][0]["limit"] == 500


def test_the_command_line_reports_a_partial_run_as_a_failure(
    two_roots: AppConfig, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    from media_server import cli

    monkeypatch.setattr(cli, "load_config", lambda selected: two_roots)
    monkeypatch.setattr(cli, "run_maintenance", lambda **kwargs: {"status": "partial", "failed": 1, "steps": []})
    assert cli.main(["maintenance"]) == 1

    monkeypatch.setattr(cli, "run_maintenance", lambda **kwargs: {"status": "ok", "failed": 0, "steps": []})
    assert cli.main(["maintenance"]) == 0
    assert '"status": "ok"' in capsys.readouterr().out


def test_the_command_line_rejects_an_unknown_step(
    two_roots: AppConfig, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    from media_server import cli

    monkeypatch.setattr(cli, "load_config", lambda selected: two_roots)

    assert cli.main(["maintenance", "--only", "scan,okladki"]) == 1
    assert "okladki" in capsys.readouterr().err


@pytest.mark.parametrize(
    "option",
    ["--titles-limit=0", "--scan-batch=1", "--metadata-limit=0", "--titles-min-interval=120",
     "--metadata-timeout-seconds=0"],
)
def test_out_of_range_limits_are_refused_before_any_work_starts(
    option: str, two_roots: AppConfig, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """The workers carry their own ranges and reject a bad value only once they
    are reached — that is, after the scan and the metadata queue already ran.
    Found on a clean install: `--titles-limit 0` failed the run at the last step."""
    from media_server import cli

    started: list[str] = []
    monkeypatch.setattr(cli, "load_config", lambda selected: two_roots)
    monkeypatch.setattr(cli, "run_maintenance", lambda **kwargs: started.append("ran") or {"status": "ok"})

    assert cli.main(["maintenance", option]) == 1
    assert started == [], "przebieg ruszył mimo złej wartości"
    assert option.split("=")[0] in capsys.readouterr().err
