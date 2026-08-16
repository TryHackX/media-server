"""The Debian deployment: one directory per version behind a ``current`` symlink,
plus the units and timers that run beside it.

Two kinds of check live here. The static ones run everywhere and guard the seam
that has no other reader: the systemd units, the release script and the install
document each spell the same paths, and nothing but agreement makes them true —
together with plain hygiene on every deployment script, in both shells. The
functional ones actually deploy, switch and roll back inside ``tmp_path``; they
need symlinks and POSIX tools, so on Windows they are skipped rather than faked
— a copy pretending to be a symlink would test the wrong thing.
"""
from __future__ import annotations

import os
import re
import shutil
import subprocess
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[1]
RELEASE_SCRIPT = PROJECT_ROOT / "scripts" / "release-debian.sh"
SYSTEMD = PROJECT_ROOT / "deploy" / "systemd"
UNIT_FILE = SYSTEMD / "tryhackx-media-transfer.service"
INSTALL_DOC = PROJECT_ROOT / "docs" / "INSTALL-DEBIAN.md"

SHELL_SCRIPTS = sorted((PROJECT_ROOT / "scripts").glob("*.sh"))
POWERSHELL_SCRIPTS = sorted((PROJECT_ROOT / "scripts").glob("*.ps1"))
UNITS = sorted(SYSTEMD.glob("*.service"))
TIMERS = sorted(SYSTEMD.glob("*.timer"))


def _bash() -> str:
    bash = shutil.which("bash")
    if bash is None:
        pytest.skip("bash nie jest dostępne")
    return bash


def _powershell() -> str:
    shell = shutil.which("pwsh") or shutil.which("powershell")
    if shell is None:
        pytest.skip("ani pwsh, ani powershell nie są dostępne")
    return shell


def _script_defaults() -> dict[str, str]:
    """The defaults the script assigns at the top, e.g. PREFIX=/opt/…"""
    source = RELEASE_SCRIPT.read_text(encoding="utf-8")
    return {
        name: value
        for name, value in re.findall(r'^([A-Z_]+)="([^"]*)"$', source, flags=re.MULTILINE)
    }


def _unit_directives(path: Path = UNIT_FILE) -> dict[str, list[str]]:
    """systemd allows a key to repeat (Environment=), so values are lists."""
    directives: dict[str, list[str]] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith(("#", ";", "[")):
            continue
        key, separator, value = line.partition("=")
        if separator:
            directives.setdefault(key.strip(), []).append(value.strip())
    return directives


# --------------------------------------------------------------------- static


@pytest.mark.parametrize("script", SHELL_SCRIPTS, ids=lambda path: path.name)
def test_shell_scripts_parse_and_fail_loudly(script: Path) -> None:
    subprocess.run([_bash(), "-n", str(script)], check=True, capture_output=True)
    header = script.read_text(encoding="utf-8").splitlines()
    assert header[0] == "#!/usr/bin/env bash"
    assert "set -euo pipefail" in header


@pytest.mark.parametrize("script", POWERSHELL_SCRIPTS, ids=lambda path: path.name)
def test_powershell_scripts_parse(script: Path) -> None:
    # These run unattended from Task Scheduler, where a syntax error is a task
    # that silently never worked. Parsing is the one check available off-Windows.
    probe = (
        "$e = $null; "
        f"[void][System.Management.Automation.Language.Parser]::ParseFile('{script}', [ref]$null, [ref]$e); "
        "if ($e -and $e.Count) { $e | ForEach-Object { $_.ToString() }; exit 1 }"
    )
    subprocess.run(
        [_powershell(), "-NoProfile", "-NonInteractive", "-Command", probe],
        check=True,
        capture_output=True,
    )


def test_release_script_and_unit_agree_on_the_layout() -> None:
    defaults = _script_defaults()
    unit = _unit_directives()
    prefix = defaults["PREFIX"]

    # The unit runs the interpreter of whichever release `current` points at.
    assert unit["ExecStart"] == [f"{prefix}/current/.venv/bin/python -m media_server serve"]
    assert unit["WorkingDirectory"] == [f"{prefix}/current"]

    environment = dict(entry.split("=", 1) for entry in unit["Environment"])
    assert environment["MEDIA_SERVER_CONFIG"] == defaults["CONFIG"]
    assert environment["MEDIA_SERVER_LOG_DIR"] == defaults["LOG_DIR"]
    assert unit["User"] == [defaults["SERVICE_USER"]]
    assert unit["Group"] == [defaults["SERVICE_GROUP"]]
    assert UNIT_FILE.name == f"{defaults['SERVICE']}.service"


def test_unit_grants_write_access_exactly_where_the_release_links_state() -> None:
    defaults = _script_defaults()
    unit = _unit_directives()

    # StateDirectory/LogsDirectory are relative to /var/lib and /var/log, and
    # systemd adds both to ReadWritePaths — which is the only reason writing
    # through the release's runtime/ and logs/ symlinks works under
    # ProtectSystem=strict.
    assert defaults["STATE_DIR"] == f"/var/lib/{unit['StateDirectory'][0]}"
    assert defaults["LOG_DIR"] == f"/var/log/{unit['LogsDirectory'][0]}"
    assert unit["ProtectSystem"] == ["strict"]
    for hardening in ("NoNewPrivileges", "ProtectHome", "PrivateTmp", "RestrictSUIDSGID"):
        assert unit[hardening] == ["true"], hardening


def test_install_document_describes_the_shipped_commands() -> None:
    defaults = _script_defaults()
    document = INSTALL_DOC.read_text(encoding="utf-8")

    assert "scripts/release-debian.sh" in document
    assert "--rollback" in document
    for path in (defaults["PREFIX"], defaults["CONFIG"], defaults["STATE_DIR"], defaults["LOG_DIR"]):
        assert path in document, path


@pytest.mark.parametrize("unit", UNITS, ids=lambda path: path.name)
def test_every_unit_runs_out_of_the_active_release(unit: Path) -> None:
    prefix = _script_defaults()["PREFIX"]
    directives = _unit_directives(unit)

    # `current` and nothing else: a unit pinned to a version directory would
    # keep running the release the operator just rolled back from.
    assert directives["WorkingDirectory"] == [f"{prefix}/current"]
    for command in directives["ExecStart"]:
        assert f"{prefix}/current/" in command, command
    assert directives["User"] == ["www-data"]
    assert directives["ProtectSystem"] == ["strict"]


@pytest.mark.parametrize("timer", TIMERS, ids=lambda path: path.name)
def test_every_timer_survives_a_machine_that_was_switched_off(timer: Path) -> None:
    directives = _unit_directives(timer)

    # A home server is off at night more often than a rack is, so a missed run
    # has to be caught up rather than skipped.
    assert directives["Persistent"] == ["true"]
    unit = directives["Unit"][0]
    assert (SYSTEMD / unit).is_file(), unit
    assert directives["WantedBy"] == ["timers.target"]


def test_the_scheduled_run_is_not_killed_by_the_oneshot_default() -> None:
    # Type=oneshot gives up after 90 s by default; one catalogue scan here takes
    # minutes, so without this the nightly run would be killed halfway, forever.
    directives = _unit_directives(SYSTEMD / "tryhackx-media-maintenance.service")
    assert directives["Type"] == ["oneshot"]
    assert directives["TimeoutStartSec"] == ["6h"]
    assert "maintenance" in directives["ExecStart"][0]


def test_the_digest_has_its_own_unit_so_one_failure_cannot_hide_the_other() -> None:
    maintenance = _unit_directives(SYSTEMD / "tryhackx-media-maintenance.service")
    digest = _unit_directives(SYSTEMD / "tryhackx-media-digest.service")

    assert len(maintenance["ExecStart"]) == 1
    assert "digest.php" in digest["ExecStart"][0]
    assert "digest.php" not in maintenance["ExecStart"][0]
    # The digest writes the mail spool through the release's logs/ symlink.
    assert digest["LogsDirectory"] == ["tryhackx-media-server"]


@pytest.mark.parametrize(
    ("value", "expected"),
    [("08", 0), ("010", 0), ("2", 0), ("1", 1), ("0", 1), ("abc", 1)],
    ids=["octal-looking-8", "octal-looking-10", "two", "one", "zero", "not-a-number"],
)
def test_keep_is_read_as_a_decimal_number(value: str, expected: int) -> None:
    # `[[ ]]` evaluates its operands arithmetically, where a leading zero means
    # base 8: --keep 08 used to abort with "value too great for base" and the
    # wrong diagnosis, and --timeout 060 silently meant 48 seconds.
    result = subprocess.run(
        [_bash(), str(RELEASE_SCRIPT), "--keep", value, "--list"],
        capture_output=True,
        text=True,
    )
    assert result.returncode == expected, result.stderr
    if expected:
        # Only ASCII is compared: this test also runs on Windows, where the
        # script's UTF-8 diagnostics come back through the console code page.
        assert "--keep" in result.stderr


def test_release_script_refuses_to_prune_below_a_rollback() -> None:
    source = RELEASE_SCRIPT.read_text(encoding="utf-8")
    # --keep 1 would delete the release --rollback returns to.
    assert '"$KEEP" -ge 2' in source
    # Only names this script generates may ever be removed.
    assert "RELEASE_NAME_RE='^[0-9]{8}-[0-9]{6}(-[0-9]{2,})?$'" in source


# ----------------------------------------------------------------- functional

posix_only = pytest.mark.skipif(
    os.name == "nt",
    reason="wydanie stoi na dowiązaniach i narzędziach POSIX; Windows bez uprawnień administratora ich nie tworzy",
)


@pytest.fixture
def fake_source(tmp_path: Path) -> Path:
    """A tree shaped like the project, small enough to copy in milliseconds."""
    source = tmp_path / "checkout"
    (source / "src" / "media_server").mkdir(parents=True)
    (source / "scripts").mkdir()
    (source / "config").mkdir()
    (source / "frontend" / "node_modules").mkdir(parents=True)
    (source / ".git").mkdir()
    (source / ".venv").mkdir()
    (source / "runtime" / "thumbnails").mkdir(parents=True)
    (source / "logs").mkdir()
    (source / "src" / "media_server" / "__pycache__").mkdir()

    (source / "pyproject.toml").write_text("[project]\nname = 'x'\n", encoding="utf-8")
    (source / "src" / "media_server" / "app.py").write_text("# app\n", encoding="utf-8")
    (source / "config" / "config.example.toml").write_text("[server]\n", encoding="utf-8")
    (source / "config" / "config.local.toml").write_text("secret = 1\n", encoding="utf-8")
    (source / ".git" / "config").write_text("[core]\n", encoding="utf-8")
    (source / ".venv" / "pyvenv.cfg").write_text("home = /usr\n", encoding="utf-8")
    (source / "frontend" / "node_modules" / "left-pad.js").write_text("//\n", encoding="utf-8")
    (source / "runtime" / "thumbnails" / "a.jpg").write_bytes(b"\xff")
    (source / "logs" / "old.jsonl").write_text("{}\n", encoding="utf-8")
    (source / "src" / "media_server" / "__pycache__" / "app.pyc").write_bytes(b"\x00")
    return source


@pytest.fixture
def deploy(tmp_path: Path, fake_source: Path):
    prefix = tmp_path / "opt"
    config = tmp_path / "etc" / "config.local.toml"
    config.parent.mkdir(parents=True)
    config.write_text('[server]\nport = 8765\n', encoding="utf-8")

    def run(*extra: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [
                _bash(), str(RELEASE_SCRIPT),
                "--source", str(fake_source),
                "--prefix", str(prefix),
                "--config", str(config),
                "--state-dir", str(tmp_path / "var" / "lib"),
                "--log-dir", str(tmp_path / "var" / "log"),
                "--no-service", "--no-venv",
                *extra,
            ],
            capture_output=True,
            text=True,
        )

    run.prefix = prefix  # type: ignore[attr-defined]
    run.state_dir = tmp_path / "var" / "lib"  # type: ignore[attr-defined]
    run.log_dir = tmp_path / "var" / "log"  # type: ignore[attr-defined]
    return run


@posix_only
def test_release_copies_the_code_and_leaves_the_private_files_behind(deploy) -> None:
    result = deploy("--no-health")
    assert result.returncode == 0, result.stderr

    current = deploy.prefix / "current"
    assert current.is_symlink()
    release = Path(os.readlink(current))
    assert release.parent == deploy.prefix / "releases"

    assert (release / "pyproject.toml").is_file()
    assert (release / "src" / "media_server" / "app.py").is_file()
    assert (release / "config" / "config.example.toml").is_file()
    for excluded in (
        ".git", ".venv", "config/config.local.toml",
        "frontend/node_modules", "src/media_server/__pycache__",
    ):
        assert not (release / excluded).exists(), excluded


@posix_only
def test_state_and_logs_live_outside_the_release(deploy) -> None:
    assert deploy("--no-health").returncode == 0
    release = Path(os.readlink(deploy.prefix / "current"))

    assert (release / "runtime").is_symlink()
    assert (release / "logs").is_symlink()
    # A cache written through the release must survive it, so the write has to
    # land in the shared directory, not in the version that gets pruned.
    (release / "runtime" / "thumbnails").mkdir(parents=True, exist_ok=True)
    (release / "runtime" / "thumbnails" / "written.bin").write_bytes(b"1")
    assert (deploy.state_dir / "thumbnails" / "written.bin").is_file()
    assert (release / "runtime").resolve() == deploy.state_dir.resolve()
    assert (release / "logs").resolve() == deploy.log_dir.resolve()


@posix_only
def test_a_release_without_an_interpreter_says_so_instead_of_going_quiet(deploy) -> None:
    # The copy step drops .venv on purpose, so --no-venv leaves a tree the unit's
    # ExecStart cannot run. Caught here, it is one sentence; caught by the smoke
    # test it is only "the release does not answer".
    result = deploy("--no-health")

    assert result.returncode == 0, result.stderr
    assert ".venv/bin/python" in result.stdout
    assert "systemd" in result.stdout


@posix_only
def test_second_release_records_the_first_as_previous(deploy) -> None:
    assert deploy("--no-health").returncode == 0
    first = Path(os.readlink(deploy.prefix / "current"))
    assert deploy("--no-health").returncode == 0
    second = Path(os.readlink(deploy.prefix / "current"))

    assert second != first
    assert Path(os.readlink(deploy.prefix / "previous")) == first


@posix_only
def test_rollback_returns_to_the_previous_release(deploy) -> None:
    assert deploy("--no-health").returncode == 0
    first = Path(os.readlink(deploy.prefix / "current"))
    assert deploy("--no-health").returncode == 0
    second = Path(os.readlink(deploy.prefix / "current"))

    result = deploy("--no-health", "--rollback")
    assert result.returncode == 0, result.stderr
    assert Path(os.readlink(deploy.prefix / "current")) == first
    # Rolling back again returns forward: `previous` follows the switch, so the
    # operator is never stuck with one usable direction.
    assert Path(os.readlink(deploy.prefix / "previous")) == second


@posix_only
def test_pruning_keeps_exactly_the_requested_number_of_releases(deploy) -> None:
    for _ in range(4):
        assert deploy("--no-health", "--keep", "3").returncode == 0
    releases = sorted(p.name for p in (deploy.prefix / "releases").iterdir())

    # --keep counts every release left on disk; current and previous are two of
    # them, so the default of 3 leaves those two and one spare.
    assert len(releases) == 3, releases
    assert Path(os.readlink(deploy.prefix / "current")).name == releases[-1]
    assert Path(os.readlink(deploy.prefix / "previous")).name == releases[-2]

    # The minimum still cannot prune away what --rollback returns to.
    assert deploy("--no-health", "--keep", "2").returncode == 0
    kept = sorted(p.name for p in (deploy.prefix / "releases").iterdir())
    assert kept == [
        Path(os.readlink(deploy.prefix / "previous")).name,
        Path(os.readlink(deploy.prefix / "current")).name,
    ]


@posix_only
def test_without_a_restart_nothing_claims_the_release_was_verified(deploy) -> None:
    """`--no-service` restarts nothing, so the port is still held by the previous
    release's process — it would answer /health/ready instantly and hand a green
    smoke test to a release that never started. Checking has to be off unless the
    operator restarts by hand and says so with an explicit --health-url."""
    result = deploy()

    assert result.returncode == 0, result.stderr
    assert "smoke test pominięty" in result.stdout
    assert "odpowiada po" not in result.stdout
    # And the summary has to say the traffic is still on the old release.
    assert "nie była restartowana" in result.stdout
    assert "systemctl restart" in result.stdout


@posix_only
def test_switching_by_path_still_writes_a_canonical_symlink(deploy) -> None:
    """A symlink spelled `…/opt/./releases/X` passes every check and then fails
    the byte-compare that protects it from pruning. Whatever the operator types,
    the link has to come out as `<releases>/<name>`."""
    assert deploy("--no-health").returncode == 0
    first = Path(os.readlink(deploy.prefix / "current"))
    assert deploy("--no-health").returncode == 0

    assert deploy("--no-health", "--switch", f"./releases/{first.name}").returncode == 0
    assert Path(os.readlink(deploy.prefix / "current")) == deploy.prefix / "releases" / first.name
    assert Path(os.readlink(deploy.prefix / "previous")).parent == deploy.prefix / "releases"

    # And whatever --rollback points at after the next prune must still be there:
    # a link written in another spelling used to slip past the byte-compare that
    # protects it and be removed.
    assert deploy("--no-health", "--keep", "2").returncode == 0
    previous = Path(os.readlink(deploy.prefix / "previous"))
    assert previous.is_dir(), f"cel rollbacku skasowany: {previous}"
    assert len(list((deploy.prefix / "releases").iterdir())) == 2


@posix_only
def test_a_directory_where_the_symlink_belongs_is_named_not_guessed(deploy) -> None:
    assert deploy("--no-health").returncode == 0
    (deploy.prefix / "current").unlink()
    (deploy.prefix / "current").mkdir()

    result = deploy("--no-health")

    assert result.returncode != 0
    assert "jest katalogiem" in result.stderr
    # No half-written temporary link left behind.
    assert not list(deploy.prefix.glob(".current.*"))


@posix_only
def test_a_pruned_name_is_never_handed_to_a_later_release(deploy) -> None:
    """Also found on the real box. Releases inside one second get a numeric
    suffix, and the newest release must always sort last — pruning, `previous`
    and the spare all read that order. Taking the first free name broke it: once
    the unsuffixed directory was pruned, the next release in the same second
    inherited a name that sorts oldest."""
    for _ in range(5):
        assert deploy("--no-health", "--keep", "2").returncode == 0
        names = sorted(p.name for p in (deploy.prefix / "releases").iterdir())
        current = Path(os.readlink(deploy.prefix / "current")).name
        assert names[-1] == current, names


@posix_only
def test_a_rejected_release_does_not_steal_the_spare_slot(deploy) -> None:
    """Found on a real Debian box, not here: `previous` can be older than a
    release the smoke test rejected. Counting the protected releases while
    walking newest-first gave the spare slot to the rejected directory before
    the walk ever reached `previous`, and one release too many stayed."""
    if shutil.which("curl") is None:
        pytest.skip("odrzucenie wydania wymaga curl")
    assert deploy("--no-health").returncode == 0
    assert deploy("--no-health").returncode == 0
    # A rejected release: newer than `previous`, and never activated.
    assert deploy("--health-url", "http://127.0.0.1:9/health/ready", "--timeout", "0").returncode != 0
    assert deploy("--no-health", "--keep", "2").returncode == 0

    releases = sorted(p.name for p in (deploy.prefix / "releases").iterdir())
    assert releases == [
        Path(os.readlink(deploy.prefix / "previous")).name,
        Path(os.readlink(deploy.prefix / "current")).name,
    ], releases


@posix_only
def test_a_release_that_never_answers_is_rolled_back_automatically(deploy) -> None:
    if shutil.which("curl") is None:
        pytest.skip("smoke test wymaga curl")
    assert deploy("--no-health").returncode == 0
    healthy = Path(os.readlink(deploy.prefix / "current"))

    # Port 9 (discard) is closed here, so the new release cannot answer.
    result = deploy("--health-url", "http://127.0.0.1:9/health/ready", "--timeout", "0")

    assert result.returncode != 0
    assert "odrzucone" in result.stdout + result.stderr
    assert Path(os.readlink(deploy.prefix / "current")) == healthy
    # The rejected tree is kept for inspection, but it never became `previous`.
    assert not (deploy.prefix / "previous").exists()
    assert len(list((deploy.prefix / "releases").iterdir())) == 2


@posix_only
def test_list_marks_the_active_release(deploy) -> None:
    assert deploy("--no-health").returncode == 0
    assert deploy("--no-health").returncode == 0
    listing = deploy("--list").stdout.splitlines()

    assert len(listing) == 2
    assert listing[0].endswith("<- previous")
    assert listing[1].endswith("<- current")
