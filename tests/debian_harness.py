"""A stand-in Debian machine for the installer's tests.

There is no Debian on the machine this installer was written on — no WSL, no
virtual machine — so it cannot be run for real there. What can be done instead,
on Windows (Git Bash) and on Linux alike:

* a directory that stands for ``/`` (``TRYHACKX_SYSROOT``): the installer puts
  every file it writes under it;
* a directory of stand-ins at the front of ``PATH``
  (``tests/debian_stubs/system-command.sh`` copied under each command's name):
  ``apt-get``, ``systemctl``, ``a2ensite``, ``ufw``, ``mariadb``, ``certbot``…
  answer as a fresh Debian 13 would and write down how they were called;
* ``scripts/install.py`` and ``scripts/release-debian.sh`` replaced by stand-ins
  that leave behind what the next steps look for.

So every line of the shell code runs — the real path, not only ``--dry-run`` —
and a test reads three things: the transcript, the list of commands, and the
files under the stand-in root. What this cannot show is whether Debian itself
agrees (packages, Apache's parser, systemd, ufw): that list is in
``docs/TESTING.md``.
"""
from __future__ import annotations

import hashlib
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[1]
STUBS = PROJECT_ROOT / "tests" / "debian_stubs"
ENTRY = PROJECT_ROOT / "zainstaluj-debian.sh"

# Every system command the installer or vps-setup.sh runs gets a stand-in. Missing one
# would mean the real program of the test machine is run — on a developer's laptop
# that could be a real `ssh` or a real `curl`.
COMMANDS = (
    "apt-get", "dpkg-query", "systemctl", "a2query", "a2enmod", "a2ensite", "a2dissite", "apache2ctl", "ufw",
    "mariadb", "certbot", "runuser", "curl", "ss", "ip", "df", "getent", "sshd", "who", "php", "ssh-keyscan",
    "ssh-keygen", "ssh", "scp", "chown", "chgrp", "fail2ban-client", "sleep", "hostname", "mariadb-dump",
    "a2enconf", "a2disconf", "nft",
)
# Calls that change a machine. A dry run must make none of them.
MUTATING = (
    "apt-get", "a2enmod", "a2ensite", "a2dissite", "a2enconf", "a2disconf", "certbot", "runuser -u www-data -- /opt", "chown", "ssh ", "scp ",
    "ufw allow", "ufw delete", "ufw --force", "ufw disable", "systemctl enable", "systemctl restart",
    "systemctl start", "systemctl reload", "systemctl daemon-reload", "systemctl disable", "release-debian.sh",
)

DEBIAN_13 = (
    'PRETTY_NAME="Debian GNU/Linux 13 (trixie)"\nNAME="Debian GNU/Linux"\nVERSION_ID="13"\n'
    "VERSION_CODENAME=trixie\nID=debian\n"
)


def find_bash() -> str:
    """Git Bash on Windows, bash elsewhere — never the WSL launcher in System32."""
    candidates = []
    found = shutil.which("bash")
    if found:
        candidates.append(Path(found))
    if os.name == "nt":
        git = shutil.which("git")
        if git:
            for parent in Path(git).resolve().parents:
                candidates.append(parent / "bin" / "bash.exe")
        candidates.append(Path(os.environ.get("ProgramFiles", r"C:\Program Files")) / "Git" / "bin" / "bash.exe")
    for candidate in candidates:
        if candidate.is_file() and "system32" not in str(candidate).lower():
            return str(candidate)
    pytest.skip("bash nie jest dostępne (na Windows potrzebny jest Git Bash)")


def shell_path(bash: str, path: Path) -> str:
    """A path as bash's own PATH wants it (``/c/Users/…`` under Git Bash)."""
    if os.name != "nt":
        return str(path)
    result = subprocess.run([bash, "-c", 'cygpath -u "$1"', "_", str(path)], capture_output=True, text=True, check=True)
    return result.stdout.strip()


class Machine:
    """One stand-in machine: a root directory, stand-in commands and a record of what was run."""

    def __init__(self, base: Path, *, with_whiptail: bool = False, os_release: str = DEBIAN_13) -> None:
        self.bash = find_bash()
        self.base = base
        self.root = base / "root"
        self.bin = base / "bin"
        self.tmp = base / "tmp"
        self.log = base / "commands.log"
        for folder in (
            self.bin, self.tmp, self.root / "etc/apache2/sites-enabled", self.root / "etc/apache2/sites-available",
            self.root / "run/systemd/system", self.root / "var/log", self.root / "srv/media/muzyka",
            self.root / "srv/media/filmy", self.root / "srv/media/seriale", self.root / "home/jan/muzyka",
        ):
            folder.mkdir(parents=True, exist_ok=True)
        (self.root / "etc/os-release").write_text(os_release, encoding="utf-8", newline="\n")
        for state in ("sites-enabled", "sites-available"):
            (self.root / "etc/apache2" / state / "000-default.conf").write_text("# Debian default site\n", encoding="utf-8")
        # A media file that must still be there, byte for byte, whatever the installer does.
        (self.root / "srv/media/muzyka/utwor.flac").write_bytes(b"fLaC not really")
        names = [*COMMANDS, *(["whiptail"] if with_whiptail else [])]
        stub = (STUBS / "system-command.sh").read_bytes().replace(b"\r\n", b"\n")
        for name in names:
            target = self.bin / name
            target.write_bytes(stub)
            target.chmod(0o755)
        self.log.write_text("", encoding="utf-8")

    def environment(self, extra: dict[str, str] | None = None) -> dict[str, str]:
        env = dict(os.environ)
        for name in [key for key in env if key.startswith(("THX_STUB_", "TRYHACKX_"))]:
            del env[name]
        env.update(
            {
                "THX_BIN": shell_path(self.bash, self.bin),
                "TRYHACKX_SYSROOT": self.root.as_posix(),
                "TRYHACKX_VPS_ROOT": self.root.as_posix(),
                "TRYHACKX_ASSUME_ROOT": "1",
                "TRYHACKX_PYTHON": Path(sys.executable).as_posix(),
                "TRYHACKX_INSTALL_PY": (STUBS / "install_stub.py").as_posix(),
                "TRYHACKX_RELEASE_SCRIPT": (STUBS / "release-stub.sh").as_posix(),
                # The installer runs out of this repository - a clone, built or not depending on
                # the machine (CI's checkout never is). It stands for a release package unless a
                # test says otherwise ("clone", "built-clone").
                "TRYHACKX_SOURCE_LAYOUT": "package",
                "THX_STUB_LOG": self.log.as_posix(),
                "TMPDIR": self.tmp.as_posix(),
                "LC_ALL": "C.UTF-8",
                "PYTHONIOENCODING": "utf-8",
            }
        )
        for name in ("SSH_CONNECTION", "MSYS_NO_PATHCONV", "MSYS2_ARG_CONV_EXCL"):
            env.pop(name, None)
        env.update(extra or {})
        return env

    def script(
        self, script: Path, *arguments: str, env: dict[str, str] | None = None, stdin: str = "", timeout: int = 300
    ) -> subprocess.CompletedProcess[str]:
        """Run a shell script with the stand-ins in front of everything else on PATH."""
        # PATH is set inside bash: Git Bash puts its own directories in front of whatever it inherits.
        launcher = 'export PATH="$THX_BIN:$PATH"; exec bash "$@"'
        command = [self.bash, "-c", launcher, "_", script.as_posix(), *arguments]
        # Bytes in, bytes out: in text mode Python on Windows would end every typed line
        # with CR LF, and what a person types into a terminal ends with LF.
        result = subprocess.run(
            command, input=stdin.encode("utf-8"), capture_output=True,
            env=self.environment(env), timeout=timeout, check=False, cwd=self.base,
        )
        return subprocess.CompletedProcess(
            command, result.returncode,
            result.stdout.decode("utf-8", errors="replace").replace("\r\n", "\n"),
            result.stderr.decode("utf-8", errors="replace").replace("\r\n", "\n"),
        )

    def install(self, *arguments: str, env: dict[str, str] | None = None, stdin: str = "") -> subprocess.CompletedProcess[str]:
        """Run ``zainstaluj-debian.sh``."""
        # Git Bash rewrites arguments that look like POSIX paths when it starts a Windows
        # program (here: Python); `--root muzyka=/srv/media/muzyka` must arrive as written.
        # The installer hands such programs paths in a form they understand by itself
        # (native_path). vps-setup.sh, which only ever runs on the VPS, does not - so for
        # it the rewriting stays on.
        literal = {"MSYS_NO_PATHCONV": "1", "MSYS2_ARG_CONV_EXCL": "*"}
        return self.script(ENTRY, *arguments, env={**literal, **(env or {})}, stdin=stdin)

    @property
    def commands(self) -> list[str]:
        return [line for line in self.log.read_text(encoding="utf-8").splitlines() if line]

    def forget_commands(self) -> None:
        self.log.write_text("", encoding="utf-8")

    def mutations(self) -> list[str]:
        """The recorded calls that would have changed a real machine."""
        return [line for line in self.commands if line.startswith(MUTATING) or " -e " not in line and line.startswith("mariadb")]

    def path(self, absolute: str) -> Path:
        """Where ``/etc/…`` of the stand-in machine really is."""
        return self.root / absolute.lstrip("/")

    def read(self, absolute: str) -> str:
        return self.path(absolute).read_text(encoding="utf-8")

    def digest(self) -> dict[str, str]:
        """Every file under the root with its SHA-256: equal digests mean nothing was written."""
        result = {}
        for file in sorted(self.root.rglob("*")):
            if file.is_file():
                result[file.relative_to(self.root).as_posix()] = hashlib.sha256(file.read_bytes()).hexdigest()
        return result

    def position(self, fragment: str) -> int:
        """Index of the first recorded command containing ``fragment`` (the test fails when there is none)."""
        for index, line in enumerate(self.commands):
            if fragment in line:
                return index
        raise AssertionError(f"polecenie zawierające {fragment!r} nie zostało wykonane:\n" + "\n".join(self.commands))
