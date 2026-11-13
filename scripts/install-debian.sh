#!/usr/bin/env bash
# Instalacja robocza na Debianie: środowisko Pythona i prywatna konfiguracja
# w katalogu repozytorium, na własnym koncie. Nic systemowego.
#
# Środowisko produkcyjne (/opt, systemd, symlink `current`) zakłada i aktualizuje
# scripts/release-debian.sh — opisane w docs/INSTALL-DEBIAN.md.
set -euo pipefail

if [[ "${EUID}" -eq 0 ]]; then
  echo "Uruchom ten skrypt jako zwykły użytkownik; kroki systemowe są opisane w docs/INSTALL-DEBIAN.md." >&2
  exit 1
fi

PROJECT_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"
python3 scripts/install.py "$@"

echo "Część aplikacyjna gotowa. Nie zmieniono Apache ani systemd."
echo "Wydanie produkcyjne: sudo scripts/release-debian.sh --build-frontend --migrate"
