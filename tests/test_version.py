"""One release, one number.

The version is written down in three independent places — ``pyproject.toml`` for
packaging, ``media_server.__version__`` for anything that asks the code, and the
frontend's ``package.json`` — and nothing reads two of them at once, so nothing
notices when they disagree. They already have: ``v0.1.1`` was tagged and released
with ``pyproject`` saying ``0.1.1`` while the other two still said ``0.1.0``, and
the running service reported the older number for the whole life of that release.

The failure is quiet by construction. Nobody diffs a version against a tag; it
surfaces months later in a bug report that names a version which never contained
the code being described. Hence a test rather than a habit: releasing is the one
moment these have to agree, and it is exactly the moment there is most else to
remember.
"""
from __future__ import annotations

import json
import re
import tomllib
from pathlib import Path

import media_server

PROJECT_ROOT = Path(__file__).resolve().parents[1]
PYPROJECT = PROJECT_ROOT / "pyproject.toml"
FRONTEND_PACKAGE = PROJECT_ROOT / "frontend" / "package.json"
FRONTEND_LOCK = PROJECT_ROOT / "frontend" / "package-lock.json"
APP_MODULE = PROJECT_ROOT / "src" / "media_server" / "app.py"


def _packaged_version() -> str:
    return tomllib.loads(PYPROJECT.read_text(encoding="utf-8"))["project"]["version"]


def _frontend_version() -> str:
    return json.loads(FRONTEND_PACKAGE.read_text(encoding="utf-8"))["version"]


def test_python_package_and_module_agree() -> None:
    assert media_server.__version__ == _packaged_version()


def test_frontend_agrees_with_the_python_package() -> None:
    # The frontend package is private and never published, so npm itself never
    # checks this. It still ships in the same release and names it.
    assert _frontend_version() == _packaged_version()


def test_the_lockfile_records_the_same_package_version() -> None:
    """A bumped ``package.json`` with a stale lock is how ``npm ci`` starts failing.

    The lock names the root package twice, and nothing local reads either one —
    the build works fine from a stale lock. It breaks in CI, which is the one
    place this project has already learned not to trust itself about.
    """
    lock = json.loads(FRONTEND_LOCK.read_text(encoding="utf-8"))
    assert lock["version"] == _frontend_version()
    assert lock["packages"][""]["version"] == _frontend_version()


def test_the_application_does_not_declare_a_version_of_its_own() -> None:
    """``FastAPI(version=...)`` used to carry a fourth copy, and it went stale.

    It is derived from ``__version__`` now; this keeps a literal from creeping
    back, because a copy here is invisible — the OpenAPI schema is not served.
    """
    literal = re.search(r'version\s*=\s*"\d+\.\d+', APP_MODULE.read_text(encoding="utf-8"))
    assert literal is None, f"app.py znowu ma wpisaną wersję na sztywno: {literal.group(0)}"
