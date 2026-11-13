"""The Windows wizard (``Zainstaluj.cmd`` → ``installer/Setup.ps1``) as far as a test can reach it.

Three kinds of check, from the cheapest up:

* **bytes** — Windows PowerShell 5.1 reads a script without a byte-order mark in the
  system code page, so one Polish letter in a file saved "as UTF-8" arrives as two
  wrong ones and the wizard greets its user with garbage. That is checked on every
  platform, because it is a property of the file;
* **texts** — every sentence exists in both languages and takes the same arguments;
* **behaviour** (Windows only) — the scripts parse, and the wizard's own self-test
  runs every plan as a dry run against an imitation of WampServer and reads the
  transcript: the right commands, no secrets, nothing written.
"""
from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[1]
INSTALLER = PROJECT_ROOT / "installer"
BOM = b"\xef\xbb\xbf"

POWERSHELL_FILES = sorted(INSTALLER.rglob("*.ps1")) + sorted(INSTALLER.rglob("*.psd1"))
# Scheduled-task scripts this change touched; their own header asks for pure ASCII.
ASCII_SCRIPTS = [
    PROJECT_ROOT / "scripts" / "register-maintenance-task-windows.ps1",
    PROJECT_ROOT / "scripts" / "run-maintenance-windows.ps1",
]


def _powershell() -> str:
    if os.name != "nt":
        pytest.skip("Windows PowerShell 5.1 jest tylko na Windows")
    found = shutil.which("powershell.exe")
    if found is None:
        pytest.skip("brak powershell.exe")
    return found


def _run(arguments: list[str], timeout: int = 300) -> subprocess.CompletedProcess[bytes]:
    # Without PSModulePath, as Zainstaluj.cmd starts it: inherited from PowerShell 7 (the default shell
    # of CI's Windows runners) it lists 7's modules first, and Windows PowerShell 5.1 then picks 7's
    # Microsoft.PowerShell.Utility, which it cannot load - Get-FileHash and its kind are "not recognized".
    environment = {name: value for name, value in os.environ.items() if name.upper() != "PSMODULEPATH"}
    return subprocess.run(
        [_powershell(), "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", *arguments],
        capture_output=True, timeout=timeout, check=False, cwd=PROJECT_ROOT, env=environment,
    )


def _text(result: subprocess.CompletedProcess[bytes]) -> str:
    return (result.stdout + b"\n" + result.stderr).decode("utf-8", errors="replace")


# -- bytes ----------------------------------------------------------------------------------


def test_there_is_something_to_check() -> None:
    names = {path.name for path in POWERSHELL_FILES}
    assert {"Setup.ps1", "Common.ps1", "Steps.ps1", "Ui.ps1", "pl.psd1", "en.psd1"} <= names


@pytest.mark.parametrize("path", POWERSHELL_FILES, ids=lambda p: p.relative_to(PROJECT_ROOT).as_posix())
def test_wizard_scripts_carry_a_byte_order_mark(path: Path) -> None:
    raw = path.read_bytes()
    assert raw.startswith(BOM), f"{path.name}: bez BOM PowerShell 5.1 czyta plik w stronie kodowej systemu"
    raw[3:].decode("utf-8")  # and what follows really is UTF-8
    assert BOM not in raw[3:], f"{path.name}: drugi BOM w środku pliku"


@pytest.mark.parametrize("path", [p for p in POWERSHELL_FILES if p.suffix == ".ps1"], ids=lambda p: p.name)
def test_wizard_code_is_ascii_and_all_translated_text_lives_in_the_language_files(path: Path) -> None:
    body = path.read_bytes()[3:].decode("utf-8")
    foreign = sorted({ch for ch in body if ord(ch) > 127})
    assert not foreign, f"{path.name}: znaki spoza ASCII {foreign!r} — teksty należą do installer/lang/*.psd1"
    # A control character in a script is a typo that survived (a tab where "\t" was meant).
    stray = sorted({hex(ord(ch)) for ch in body if ord(ch) < 32 and ch not in "\r\n"})
    assert not stray, f"{path.name}: znaki sterujące {stray}"


@pytest.mark.parametrize("path", [p for p in POWERSHELL_FILES if p.suffix == ".ps1"], ids=lambda p: p.name)
def test_wizard_scripts_have_windows_line_endings(path: Path) -> None:
    # `.gitattributes` gives every *.ps1 CRLF on checkout; a bare LF here means the file was
    # written around git and will show up as changed on the next checkout.
    raw = path.read_bytes()
    assert b"\r\n" in raw and b"\n" not in raw.replace(b"\r\n", b""), f"{path.name}: mieszane albo uniksowe końce linii"


@pytest.mark.parametrize("path", ASCII_SCRIPTS, ids=lambda p: p.name)
def test_the_scheduled_task_scripts_stay_ascii(path: Path) -> None:
    raw = path.read_bytes()
    assert not raw.startswith(BOM) and raw.isascii(), f"{path.name}: ten plik ma zostać czystym ASCII (patrz jego nagłówek)"


def test_the_entry_point_is_plain_ascii_and_never_touches_the_execution_policy_for_good() -> None:
    raw = (PROJECT_ROOT / "Zainstaluj.cmd").read_bytes()
    assert raw.isascii(), "cmd.exe czyta plik w stronie kodowej konsoli — polskie znaki by się rozsypały"
    text = raw.decode("ascii")
    assert "-ExecutionPolicy Bypass" in text and "-STA" in text and 'installer\\Setup.ps1' in text
    assert "Set-ExecutionPolicy" not in text
    # No labels and no goto: a batch file with those needs CRLF to be read reliably, this one does not.
    assert not re.search(r"(?im)^\s*(goto\b|:[a-z])", text)


def test_the_native_helpers_are_ascii() -> None:
    for name in ("Native.cs", "Controls.cs"):
        raw = (INSTALLER / "lib" / name).read_bytes()
        assert raw.isascii(), f"{name}: kompilator z .NET Framework czyta źródło bez deklaracji kodowania"


# -- texts ----------------------------------------------------------------------------------

_ENTRY = re.compile(r"^\s*'([^']+)'\s*=\s*'((?:[^']|'')*)'\s*$")


def _strings(language: str) -> dict[str, str]:
    text = (INSTALLER / "lang" / f"{language}.psd1").read_bytes()[3:].decode("utf-8")
    entries: dict[str, str] = {}
    for number, line in enumerate(text.splitlines(), start=1):
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or stripped in {"@{", "}"}:
            continue
        match = _ENTRY.match(line)
        assert match, f"{language}.psd1:{number}: linia nie jest wpisem 'klucz' = 'tekst'"
        assert match.group(1) not in entries, f"{language}.psd1:{number}: klucz {match.group(1)} występuje dwa razy"
        entries[match.group(1)] = match.group(2).replace("''", "'")
    return entries


def test_every_text_exists_in_both_languages_with_the_same_arguments() -> None:
    polish, english = _strings("pl"), _strings("en")
    assert sorted(set(polish) - set(english)) == [], "brak tłumaczeń angielskich"
    assert sorted(set(english) - set(polish)) == [], "klucze bez polskiego tekstu"
    for key, text in polish.items():
        wanted = sorted(set(re.findall(r"\{(\d+)\}", text)))
        got = sorted(set(re.findall(r"\{(\d+)\}", english[key])))
        assert wanted == got, f"{key}: inne argumenty w obu językach ({wanted} / {got})"
        for candidate in (text, english[key]):
            # [string]::Format would throw on a brace that is not an argument.
            assert not re.search(r"\{(?!\d+\})|(?<!\{\d)(?<!\{\d\d)\}", candidate), f"{key}: nawias klamrowy poza argumentem"


def test_every_text_the_code_asks_for_is_there() -> None:
    polish = _strings("pl")
    sources = {path: path.read_bytes()[3:].decode("utf-8") for path in POWERSHELL_FILES if path.suffix == ".ps1"}
    asked: set[str] = set()
    for source in sources.values():
        asked.update(re.findall(r"\bT '([A-Za-z0-9_.-]+)'", source))
    # Keys put together at run time: pages, plan steps, access modes, folder kinds, flows.
    steps = sources[INSTALLER / "lib" / "Steps.ps1"]
    pages = sources[INSTALLER / "lib" / "PagesInstall.ps1"]
    for step in set(re.findall(r"New-SetupStep '([a-z-]+)'", steps)):
        asked.add(f"step.{step}")
    for page in set(re.findall(r"\(& \$page '([a-z]+)'", pages)):
        asked.update({f"page.{page}.step", f"page.{page}.title", f"page.{page}.subtitle"})
    for mode in ("local", "lan", "direct", "vps"):
        asked.update({f"access.mode.{mode}.name", f"access.mode.{mode}.text"})
    for kind in ("music", "movies", "mixed"):
        asked.add(f"media.kind.{kind}")
    for flow in ("install", "folders", "access", "admin", "update", "repair", "uninstall"):
        asked.update({f"summary.go.{flow}", f"finish.headline.{flow}"})
    for check in ("page", "bridge", "internal"):
        asked.update({f"log.verify.{check}", f"log.verify.{check}.failed"})
    for state in ("Running", "Ready", "Queued", "Disabled", "Unknown"):
        asked.add(f"task.{state}")
    asked.update({"media.note", "media.note.maintain", "admin.note", "admin.note.maintain", "database.info", "database.infoAdmin",
                  "access.error.certificate", "access.error.key"})
    missing = sorted(asked - set(polish))
    assert not missing, f"kod prosi o teksty, których nie ma: {missing}"
    unused = sorted(set(polish) - asked)
    assert not unused, f"teksty, o które nikt nie prosi: {unused}"


def test_the_window_that_winget_opens_is_told_in_ascii() -> None:
    # This one sentence is echoed by cmd.exe, in the console code page.
    for language in ("pl", "en"):
        sentence = _strings(language)["requirements.winget.done"]
        assert sentence.isascii() and not re.search(r'[&|<>()"^%]', sentence), language


# -- the scheduled-task scripts -------------------------------------------------------------


def test_the_maintenance_task_can_be_told_where_php_is() -> None:
    """WampServer does not put PHP on PATH, so a task registered the old way logged
    "php is not on PATH" every night and the weekly digest never left."""
    register = ASCII_SCRIPTS[0].read_text(encoding="ascii")
    runner = ASCII_SCRIPTS[1].read_text(encoding="ascii")
    assert "[string] $PhpPath = ''" in register and "' -PhpPath \"' + $PhpPath + '\"'" in register
    assert "[int] $MetadataLimit = 500" in register and "' -MetadataLimit ' + $MetadataLimit" in register
    assert "[string] $PhpPath = ''" in runner
    # Without the option the runner behaves exactly as before: PHP from PATH, or a visible skip.
    assert "Get-Command php -ErrorAction SilentlyContinue" in runner and "digest - SKIPPED" in runner


# -- behaviour (Windows) --------------------------------------------------------------------


def test_every_script_parses_without_a_single_error() -> None:
    script = (
        "$failed = 0; "
        "$files = @(Get-ChildItem -Path installer -Recurse -File | Where-Object { $_.Extension -in '.ps1', '.psd1' }) + "
        "@(Get-ChildItem -Path scripts -File -Filter *.ps1); "
        "foreach ($file in $files) { $tokens = $null; $errors = $null; "
        "[void] [System.Management.Automation.Language.Parser]::ParseFile($file.FullName, [ref] $tokens, [ref] $errors); "
        "foreach ($e in $errors) { $failed++; Write-Output ('{0}:{1}: {2}' -f $file.Name, $e.Extent.StartLineNumber, $e.Message) } }; "
        "Write-Output ('files: ' + $files.Count); exit $failed"
    )
    result = _run(["-Command", script])
    assert result.returncode == 0, _text(result)
    assert re.search(r"files: (\d+)", _text(result)) and int(re.search(r"files: (\d+)", _text(result)).group(1)) >= 15


def test_the_wizard_passes_its_own_self_test(tmp_path: Path) -> None:
    """Every plan as a dry run against an imitation of WampServer: see installer/tests/SelfTest.ps1."""
    result = _run(["-File", str(INSTALLER / "tests" / "SelfTest.ps1"), "-Python", sys.executable, "-Work", str(tmp_path / "work")], timeout=600)
    output = _text(result)
    assert result.returncode == 0, output
    summary = re.search(r"checks: (\d+), failed: (\d+)", output)
    assert summary is not None, output
    assert int(summary.group(1)) >= 150 and summary.group(2) == "0"


def test_an_answer_file_is_never_a_way_to_install() -> None:
    """Unattended runs exist to show a plan. Without -DryRun the wizard refuses before it asks for rights."""
    result = _run(["-File", str(INSTALLER / "Setup.ps1"), "-AnswerFile", "nie-ma.json"], timeout=120)
    assert result.returncode == 2, _text(result)
    assert "-DryRun" in _text(result)


@pytest.mark.skipif(bool(os.environ.get("CI")), reason="potrzebna sesja z pulpitem")
def test_the_preview_draws_a_page_without_touching_anything(tmp_path: Path) -> None:
    result = _run(["-STA", "-File", str(INSTALLER / "Setup.ps1"), "-Preview", "-ScreenshotDir", str(tmp_path), "-Only", "01-welcome,08-summary", "-Language", "en"], timeout=300)
    assert result.returncode == 0, _text(result)
    for name in ("01-welcome.png", "08-summary.png"):
        picture = tmp_path / name
        assert picture.is_file() and picture.read_bytes().startswith(b"\x89PNG") and picture.stat().st_size > 10_000, name
    assert sorted(path.name for path in tmp_path.iterdir()) == ["01-welcome.png", "08-summary.png"]
