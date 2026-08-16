#!/usr/bin/env python3
"""Regenerate the hash-verified dependency locks.

The locks are resolved *universally* (all platforms, every Python from the
``requires-python`` floor upwards) so a single pair of files serves Windows/WAMP and
Debian.  Both files also pin the build backend declared in ``[build-system]`` so the
installer can run ``pip install --no-build-isolation -e .`` entirely from verified
artifacts.  Requires ``uv`` on PATH (https://docs.astral.sh/uv/).

    python scripts/lock-deps.py            # keep current pins, add/remove as needed
    python scripts/lock-deps.py --upgrade  # move every pin to the newest allowed version
"""
from __future__ import annotations

import argparse
import re
import shutil
import subprocess
import sys
import tomllib
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
PYPROJECT = PROJECT_ROOT / "pyproject.toml"
# Derived from [build-system].requires on every run; committed only so the lock
# annotations reference a stable path instead of a temporary file.
BUILD_REQUIREMENTS = PROJECT_ROOT / "requirements-build.txt"
LOCKS = (
    ("requirements.lock", ()),
    ("requirements-dev.lock", ("--extra", "dev")),
)


def _python_floor(requires_python: str) -> str:
    match = re.search(r">=\s*(\d+\.\d+)", requires_python)
    if not match:
        raise RuntimeError(f"Nie można odczytać minimalnej wersji Pythona z requires-python={requires_python!r}")
    return match.group(1)


def _compile_commands(uv: str, python_floor: str, upgrade: bool) -> list[list[str]]:
    base = [
        uv,
        "pip",
        "compile",
        "--universal",
        "--generate-hashes",
        "--python-version",
        python_floor,
        "--custom-compile-command",
        "python scripts/lock-deps.py",
        "--quiet",
    ]
    if upgrade:
        base.append("--upgrade")
    # Relative inputs keep the "# via -r …" annotations stable across machines.
    return [
        base + list(extra) + [PYPROJECT.name, BUILD_REQUIREMENTS.name, "-o", name]
        for name, extra in LOCKS
    ]


def main(argv: list[str] | None = None) -> int:
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is not None:
            reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--upgrade", action="store_true", help="Podnieś wszystkie piny do najnowszych dozwolonych")
    args = parser.parse_args(argv)

    uv = shutil.which("uv")
    if uv is None:
        print("Nie znaleziono uv na PATH; zainstaluj: https://docs.astral.sh/uv/", file=sys.stderr)
        return 1

    pyproject = tomllib.loads(PYPROJECT.read_text(encoding="utf-8"))
    python_floor = _python_floor(pyproject["project"]["requires-python"])
    build_requires = pyproject.get("build-system", {}).get("requires", [])
    if not build_requires:
        print("pyproject.toml nie deklaruje [build-system].requires", file=sys.stderr)
        return 1

    BUILD_REQUIREMENTS.write_text(
        "# Generowane przez scripts/lock-deps.py z [build-system].requires w pyproject.toml.\n"
        "# Nie edytuj ręcznie; plik istnieje, aby adnotacje w requirements*.lock miały stałą ścieżkę.\n"
        + "\n".join(build_requires)
        + "\n",
        encoding="utf-8",
    )
    for command in _compile_commands(uv, python_floor, args.upgrade):
        print("Generowanie", command[-1])
        subprocess.run(command, cwd=PROJECT_ROOT, check=True)
    print("Locki zaktualizowane. Sprawdź diff i przetestuj: python scripts/install.py --dev")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
