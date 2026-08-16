#!/usr/bin/env python3
"""Local quality gate — the same checks CI runs, in one command.

    python scripts/check.py            # lint, tests, PHP lint, frontend type-check/build/tests, secrets
    python scripts/check.py --audit    # additionally audit Python and npm dependencies (network)
    python scripts/check.py --only ruff,pytest

Every step is reported and the process exits non-zero if any step fails. The
frontend build goes to a throw-away directory, so running the gate never touches the
deployed ``public/assets/build``. Steps whose tool is missing (php, npm) are reported
as skipped, not failed, unless ``--strict`` is given.
"""
from __future__ import annotations

import argparse
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import tomllib
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
FRONTEND = PROJECT_ROOT / "frontend"
LOCAL_CONFIG = PROJECT_ROOT / "config" / "config.local.toml"
LOCAL_PHP_CONFIG = PROJECT_ROOT / "integrations" / "php" / "stage" / "config.local.php"

# Files that may legitimately be missing from git's view (fresh checkout without a
# private config) but must never be committed if present.
PRIVATE_FILES = (LOCAL_CONFIG, LOCAL_PHP_CONFIG)

TEXT_SUFFIXES = {
    ".py", ".php", ".ts", ".js", ".mjs", ".cjs", ".json", ".toml", ".yml", ".yaml", ".md", ".sql",
    ".css", ".html", ".txt", ".lock", ".sh", ".ps1", ".bat", ".conf", ".example", ".service", ".ini",
    ".env", ".htaccess", ".editorconfig", ".gitattributes", ".gitignore",
}
SECRET_PATTERNS = (
    ("klucz prywatny PEM", re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH |PGP |DSA )?PRIVATE KEY-----")),
    ("AWS access key", re.compile(r"\bAKIA[0-9A-Z]{16}\b")),
    ("GitHub token", re.compile(r"\bgh[pousr]_[A-Za-z0-9]{36,}\b")),
    ("Slack token", re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{10,}\b")),
    ("Google API key", re.compile(r"\bAIza[0-9A-Za-z_-]{35}\b")),
)


class StepSkipped(Exception):
    """Raised by a step when its tool is unavailable."""


@dataclass
class Step:
    name: str
    run: Callable[[], None]
    audit: bool = False


@dataclass
class Outcome:
    name: str
    status: str
    seconds: float
    detail: str = ""


def _venv_python() -> Path:
    candidate = PROJECT_ROOT / ".venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    return candidate if candidate.is_file() else Path(sys.executable)


def _which(*names: str) -> str | None:
    return next((path for name in names if (path := shutil.which(name))), None)


def _run(command: list[str], *, cwd: Path = PROJECT_ROOT, env: dict[str, str] | None = None) -> None:
    print("$", " ".join(command), flush=True)
    merged = {**os.environ, "PYTHONIOENCODING": "utf-8", **(env or {})}
    subprocess.run(command, cwd=cwd, check=True, env=merged)


def step_ruff(python: Path) -> None:
    _run([str(python), "-m", "ruff", "check", "."])


def step_pytest(python: Path) -> None:
    _run([str(python), "-m", "pytest", "-q"])


def step_pip_check(python: Path) -> None:
    _run([str(python), "-m", "pip", "check"])


def step_php_lint() -> None:
    php = _which("php")
    if php is None:
        raise StepSkipped("php nie jest dostępne w PATH")
    files = sorted((PROJECT_ROOT / "integrations" / "php").rglob("*.php"))
    if not files:
        raise RuntimeError("Nie znaleziono plików PHP do sprawdzenia")
    for file in files:
        result = subprocess.run([php, "-l", str(file)], capture_output=True, text=True, encoding="utf-8")
        if result.returncode != 0:
            print(result.stdout, result.stderr, sep="", end="")
            raise RuntimeError(f"php -l: {file.relative_to(PROJECT_ROOT)}")
    print(f"php -l: {len(files)} plików bez błędów składni")


def _npm() -> str:
    npm = _which("npm.cmd", "npm")
    if npm is None:
        raise StepSkipped("npm nie jest dostępne w PATH")
    if not (FRONTEND / "node_modules").is_dir():
        raise StepSkipped("brak frontend/node_modules — uruchom najpierw npm ci")
    return npm


def step_frontend_types() -> None:
    npm = _npm()
    _run([npm, "exec", "--", "tsc", "--noEmit"], cwd=FRONTEND)


def step_frontend_build() -> None:
    npm = _npm()
    with tempfile.TemporaryDirectory(prefix="media-web-build-") as tmp:
        # Build into a scratch directory: the gate verifies the build, it never
        # replaces the deployed public/assets/build (that is scripts/install.py's job).
        _run([npm, "exec", "--", "vite", "build", "--outDir", tmp, "--emptyOutDir"], cwd=FRONTEND)


def step_frontend_tests() -> None:
    npm = _npm()
    _run([npm, "run", "test:ui"], cwd=FRONTEND)


def _git_visible_files() -> list[Path] | None:
    git = _which("git")
    if git is None or not (PROJECT_ROOT / ".git").exists():
        return None
    result = subprocess.run(
        [git, "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
        cwd=PROJECT_ROOT,
        capture_output=True,
        check=True,
    )
    return [PROJECT_ROOT / part.decode("utf-8") for part in result.stdout.split(b"\0") if part]


def _fallback_files() -> list[Path]:
    ignored = {".venv", ".git", "node_modules", "runtime", "backups", "logs", "__pycache__", ".pytest_cache", ".ruff_cache"}
    ignored_paths = {PROJECT_ROOT / "public" / "assets" / "build", *PRIVATE_FILES}
    files: list[Path] = []
    for path in PROJECT_ROOT.rglob("*"):
        if not path.is_file():
            continue
        relative_parts = path.relative_to(PROJECT_ROOT).parts
        if ignored.intersection(relative_parts) or any(path == p or p in path.parents for p in ignored_paths):
            continue
        files.append(path)
    return files


def _private_values() -> list[tuple[str, str]]:
    """Secrets from the private config whose literal value must not appear anywhere else."""
    if not LOCAL_CONFIG.is_file():
        return []
    try:
        config = tomllib.loads(LOCAL_CONFIG.read_text(encoding="utf-8"))
    except (tomllib.TOMLDecodeError, UnicodeDecodeError):
        return []
    values: list[tuple[str, str]] = []
    for section, key in (("security", "transfer_key"), ("database", "password"), ("mail", "password")):
        value = config.get(section, {}).get(key)
        if isinstance(value, str) and len(value) >= 8 and value not in {"CHANGE_ME", "GENERATE_WITH_INSTALLER"}:
            values.append((f"{section}.{key}", value))
    return values


def step_secrets() -> None:
    files = _git_visible_files()
    source = "git (pliki nieignorowane)"
    if files is None:
        files = _fallback_files()
        source = "przegląd katalogu (poza git)"
    for private in PRIVATE_FILES:
        if private in files:
            raise RuntimeError(f"Prywatny plik jest widoczny dla git — dopisz do .gitignore: {private.relative_to(PROJECT_ROOT)}")
    private_values = _private_values()
    findings: list[str] = []
    scanned = 0
    for file in files:
        if file.suffix.lower() not in TEXT_SUFFIXES and file.name not in TEXT_SUFFIXES:
            continue
        try:
            text = file.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        scanned += 1
        relative = file.relative_to(PROJECT_ROOT)
        for label, pattern in SECRET_PATTERNS:
            if pattern.search(text):
                findings.append(f"{relative}: {label}")
        for label, value in private_values:
            if value in text:
                findings.append(f"{relative}: zawiera wartość {label} z config.local.toml")
    if findings:
        raise RuntimeError("Możliwe sekrety w repozytorium:\n  " + "\n  ".join(findings))
    print(f"skan sekretów: {scanned} plików tekstowych ({source}), {len(private_values)} prywatnych wartości porównanych")


def step_pip_audit(python: Path) -> None:
    lock = PROJECT_ROOT / "requirements-dev.lock"
    if not lock.is_file():
        raise RuntimeError("Brak requirements-dev.lock")
    if _which("pip-audit"):
        command = ["pip-audit"]
    elif _which("uvx"):
        command = ["uvx", "pip-audit"]
    else:
        raise StepSkipped("brak pip-audit i uvx — zainstaluj uv albo pip-audit")
    _run(command + ["--require-hashes", "--progress-spinner", "off", "-r", str(lock)])


def step_npm_audit() -> None:
    npm = _npm()
    _run([npm, "audit", "--audit-level=low"], cwd=FRONTEND)


def build_steps(python: Path) -> list[Step]:
    return [
        Step("ruff", lambda: step_ruff(python)),
        Step("pytest", lambda: step_pytest(python)),
        Step("pip-check", lambda: step_pip_check(python)),
        Step("php-lint", step_php_lint),
        Step("frontend-types", step_frontend_types),
        Step("frontend-build", step_frontend_build),
        Step("frontend-tests", step_frontend_tests),
        Step("secrets", step_secrets),
        Step("pip-audit", lambda: step_pip_audit(python), audit=True),
        Step("npm-audit", step_npm_audit, audit=True),
    ]


def main(argv: list[str] | None = None) -> int:
    for stream in (sys.stdout, sys.stderr):
        # Polish diagnostics must not crash on a legacy console code page.
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is not None:
            reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--audit", action="store_true", help="Uruchom również audyty zależności (wymagają sieci)")
    parser.add_argument("--only", help="Lista kroków rozdzielona przecinkami, np. ruff,pytest")
    parser.add_argument("--strict", action="store_true", help="Traktuj pominięte kroki jako błąd (CI)")
    parser.add_argument("--list", action="store_true", help="Wypisz dostępne kroki i zakończ")
    args = parser.parse_args(argv)

    python = _venv_python()
    steps = build_steps(python)
    if args.list:
        for step in steps:
            print(f"{step.name}{'  (--audit)' if step.audit else ''}")
        return 0

    selected = steps
    if args.only:
        wanted = [name.strip() for name in args.only.split(",") if name.strip()]
        unknown = sorted(set(wanted) - {step.name for step in steps})
        if unknown:
            print("Nieznane kroki: " + ", ".join(unknown), file=sys.stderr)
            return 2
        selected = [step for step in steps if step.name in wanted]
    elif not args.audit:
        selected = [step for step in steps if not step.audit]

    outcomes: list[Outcome] = []
    for step in selected:
        print(f"\n=== {step.name} ===", flush=True)
        started = time.perf_counter()
        try:
            step.run()
        except StepSkipped as skipped:
            outcomes.append(Outcome(step.name, "FAIL" if args.strict else "SKIP", time.perf_counter() - started, str(skipped)))
        except (subprocess.CalledProcessError, RuntimeError, OSError) as failure:
            detail = str(failure) if not isinstance(failure, subprocess.CalledProcessError) else f"kod wyjścia {failure.returncode}"
            outcomes.append(Outcome(step.name, "FAIL", time.perf_counter() - started, detail))
        else:
            outcomes.append(Outcome(step.name, "OK", time.perf_counter() - started))

    print("\n=== podsumowanie ===")
    width = max(len(outcome.name) for outcome in outcomes)
    for outcome in outcomes:
        suffix = f"  {outcome.detail}" if outcome.detail else ""
        print(f"[{outcome.status:4}] {outcome.name:<{width}}  {outcome.seconds:6.1f}s{suffix}")
    failed = [outcome for outcome in outcomes if outcome.status == "FAIL"]
    if failed:
        print(f"\nNiepowodzenie: {len(failed)} z {len(outcomes)} kroków", file=sys.stderr)
        return 1
    print(f"\nWszystkie kroki zaliczone ({len(outcomes)}).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
