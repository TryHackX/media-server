#!/usr/bin/env bash
# Stand-in for scripts/release-debian.sh in the installer's tests.
#
# The real script has its own tests (tests/test_release_debian.py), which need
# symlinks and POSIX tools. Here only its place in the installer's sequence
# matters: it writes down how it was called and leaves behind what the next
# steps look for - an active release with an interpreter in it.
set -euo pipefail

if [[ -n "${THX_STUB_LOG:-}" ]]; then
    printf 'release-debian.sh' >> "$THX_STUB_LOG"
    for argument in "$@"; do printf ' %s' "$argument" >> "$THX_STUB_LOG"; done
    printf '\n' >> "$THX_STUB_LOG"
fi
if [[ "${THX_STUB_RELEASE_FAILS:-0}" != "0" ]]; then
    printf 'Wydanie odrzucone (atrapa)\n' >&2
    exit 1
fi

root="${TRYHACKX_SYSROOT:?the stand-in needs a directory that stands for /}"
current="$root/opt/tryhackx-media-server/current"
mkdir -p "$current/.venv/bin"
# The interpreter of the release: the same stand-in the system commands use.
cp "$(dirname -- "${BASH_SOURCE[0]}")/system-command.sh" "$current/.venv/bin/python"
chmod 0755 "$current/.venv/bin/python"
printf 'Gotowe: current (atrapa)\n'
