#!/usr/bin/env bash
# TryHackX Media Server - instalator i konfigurator dla Debiana 13.
#
#   sudo bash zainstaluj-debian.sh                       instalacja z pytaniami; gdy serwer juz jest - zmiana ustawien
#   sudo bash zainstaluj-debian.sh --lang en             the same in English
#        bash zainstaluj-debian.sh --dry-run             tryb probny: cala sciezka, ale kazda zmiana jest tylko opisana
#   sudo bash zainstaluj-debian.sh --answers plik.toml   bez pytan: odpowiedzi z pliku (przyklady: installer/debian/examples)
#   sudo bash zainstaluj-debian.sh --zmien [CO]          foldery | dostep | admin | aktualizacja | migracje | vps
#   sudo bash zainstaluj-debian.sh --odnow               wymiana certyfikatu serwera domowego bez przerwy (tryb przez VPS)
#   sudo bash zainstaluj-debian.sh --odinstaluj          usuniecie tego, co instalator zalozyl (mediow nie dotyka nigdy)
#   sudo bash zainstaluj-debian.sh --status              co jest zainstalowane
#
# Dodatkowo: --plain (pytania bez okien whiptail), --log PLIK, -h/--help.
# English names of the options: --reconfigure, --rotate, --uninstall.
#
# Dwie wersje instalacji (i dwa male ksztalty) - opis w docs/INSTALL-DEBIAN.md:
#   S  samodzielny serwer publiczny (wlasna domena, Let's Encrypt)
#   P  prywatny serwer domowy za publicznym VPS-em (adres domowy zostaje ukryty)
#   D  tylko siec domowa (HTTP)          C  tylko ten komputer
#
# Skrypt pyta, uruchamia polecenia systemu i raportuje; kazda decyzje - pakiety,
# pliki Apache, reguly zapory, SQL - podejmuje przetestowany pomocnik w Pythonie
# (installer/setup_helper). Plik celowo bez polskich znakow: teksty sa w
# installer/debian/lang/*.sh.
set -euo pipefail

# `su` without the dash keeps the user's PATH, which on Debian has no /usr/sbin: a2enmod, ufw and
# sshd would be "not found" half way through (audit P2-3). Added at the end, so nothing found first moves.
for THX_SBIN in /usr/local/sbin /usr/sbin /sbin; do
    case ":$PATH:" in *":$THX_SBIN:"*) ;; *) PATH="$PATH:$THX_SBIN" ;; esac
done
export PATH
unset THX_SBIN

THX_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
if command -v cygpath >/dev/null 2>&1; then
    # Git Bash on Windows (where the dry run can be tried): a form Python understands too.
    THX_ROOT="$(cygpath -m -- "$THX_ROOT")"
fi
THX_INSTALLER="$THX_ROOT/installer"
SYS="${TRYHACKX_SYSROOT:-}"

MODE="install"
TOPIC=""
DRY_RUN=0
UNATTENDED=0
FORCE_PLAIN=0
ANSWERS_FILE=""
LANG_CODE=""
LANG_GIVEN=0
LOG_FILE=""
FLOW="install"
UI_MODE="plain"
PYTHON=""
DB_CLIENT=""
WORK_DIR=""
REQUEST=""
QUIET_EXIT=0
STEP_INDEX=0
STEP_COUNT=0
WARNINGS=()
declare -A MSG=() A=() E=() P=() R=() ST=()

usage() {
    # The comment block at the top of this file.
    awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "${BASH_SOURCE[0]}"
}

option_value() {
    if [[ $# -lt 2 || -z "${2:-}" ]]; then
        printf 'Opcja %s wymaga wartosci / option %s needs a value\n' "$1" "$1" >&2
        exit 2
    fi
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --lang|--jezyk) option_value "$@"; LANG_CODE="$2"; LANG_GIVEN=1; shift 2 ;;
        --dry-run|--na-probe) DRY_RUN=1; shift ;;
        --answers|--odpowiedzi) option_value "$@"; ANSWERS_FILE="$2"; UNATTENDED=1; shift 2 ;;
        --zmien|--reconfigure)
            MODE="change"
            shift
            if [[ $# -gt 0 && "$1" != -* ]]; then TOPIC="$1"; shift; fi ;;
        --odnow|--rotate) MODE="rotate"; shift ;;
        --odinstaluj|--uninstall) MODE="uninstall"; shift ;;
        --status) MODE="status"; shift ;;
        --plain|--bez-okien) FORCE_PLAIN=1; shift ;;
        --log) option_value "$@"; LOG_FILE="$2"; shift 2 ;;
        -h|--help) usage; exit 0 ;;
        *)
            usage >&2
            printf '\nNieznana opcja / unknown option: %s\n' "$1" >&2
            exit 2 ;;
    esac
done

case "$TOPIC" in
    "") ;;
    foldery|folders) TOPIC="folders" ;;
    dostep|access) TOPIC="access" ;;
    admin) TOPIC="admin" ;;
    aktualizacja|update) TOPIC="update" ;;
    migracje|migrate) TOPIC="migrate" ;;
    vps) TOPIC="vps" ;;
    *)
        printf 'Nie wiem, co zmienic / unknown topic: %s (foldery, dostep, admin, aktualizacja, migracje, vps)\n' "$TOPIC" >&2
        exit 2 ;;
esac
case "$LANG_CODE" in
    ""|pl|en) ;;
    *)
        printf 'Jezyk / language: pl, en\n' >&2
        exit 2 ;;
esac

for library in common ui detect steps wizard flows; do
    if [[ ! -r "$THX_INSTALLER/debian/lib/$library.sh" ]]; then
        printf 'Nie znaleziono %s. Rozpakuj cala paczke i uruchom skrypt z jej katalogu.\n' "installer/debian/lib/$library.sh" >&2
        printf '%s was not found. Unpack the whole package and run the script from its folder.\n' "installer/debian/lib/$library.sh" >&2
        exit 1
    fi
    # shellcheck source=/dev/null
    source "$THX_INSTALLER/debian/lib/$library.sh"
done

INSTALL_PY="${TRYHACKX_INSTALL_PY:-$THX_ROOT/scripts/install.py}"
RELEASE_SCRIPT="${TRYHACKX_RELEASE_SCRIPT:-$THX_ROOT/scripts/release-debian.sh}"

load_language() {
    # shellcheck source=/dev/null
    source "$THX_INSTALLER/debian/lang/${LANG_CODE:-pl}.sh"
}

ensure_utf8() {
    # The sentences are UTF-8; a machine installed with the "C" locale would draw them as garbage.
    local charmap
    charmap="$(locale charmap 2>/dev/null || true)"
    if [[ "$charmap" != "UTF-8" ]]; then
        export LC_ALL=C.UTF-8 LANG=C.UTF-8
    fi
    return 0
}

find_python() {
    # Every decision of this installer is made by its Python helper, so Python comes first.
    PYTHON="${TRYHACKX_PYTHON:-}"
    if [[ -z "$PYTHON" ]]; then
        if have python3; then PYTHON="python3"; elif have python; then PYTHON="python"; fi
    fi
    if [[ -n "$PYTHON" ]]; then return 0; fi
    if [[ "$DRY_RUN" -eq 1 || "${EUID:-$(id -u)}" -ne 0 ]]; then
        die_t error.noPython
    fi
    say bootstrap.python
    run env DEBIAN_FRONTEND=noninteractive apt-get update || die_t error.apt.update
    run env DEBIAN_FRONTEND=noninteractive apt-get install -y python3 || die_t error.apt.install
    PYTHON="python3"
    return 0
}

dispatch() {
    # dispatch FLOW - one of the named flows.
    case "$1" in
        install) flow_install ;;
        folders) flow_folders ;;
        access) flow_access ;;
        admin) flow_admin ;;
        update) flow_update ;;
        migrate) flow_migrate ;;
        vps) flow_vps ;;
        rotate) flow_rotate ;;
        uninstall) flow_uninstall ;;
        *) die_t error.flow "$1" ;;
    esac
}

main() {
    local flow
    ensure_utf8
    if [[ -z "$LANG_CODE" ]]; then LANG_CODE="pl"; fi
    load_language
    trap on_exit EXIT
    start_work
    # --status only reads: no log left in /var/log for it (seen on a real Debian 13), and no lock -
    # it may be asked while an installation runs.
    if [[ "$MODE" != "status" ]]; then start_log; fi
    find_python

    if [[ "$UNATTENDED" -eq 1 ]]; then
        [[ -r "$ANSWERS_FILE" ]] || die_t error.answers.missing "$ANSWERS_FILE"
        load_answers_file
    fi
    ui_init

    emit "TryHackX Media Server - $(t banner.title "$(sed -n 's/^version = "\(.*\)".*/\1/p' "$THX_ROOT/pyproject.toml" 2>/dev/null | head -n 1)")"
    if [[ "$DRY_RUN" -eq 1 ]]; then say banner.dry; fi
    if [[ -n "$LOG_FILE" ]]; then say banner.log "$LOG_FILE"; fi

    if [[ "$MODE" != "status" ]]; then take_lock; fi
    detect_machine
    load_state
    # A dry run needs no root - but without it an installation that is here cannot be seen.
    if [[ "${E[unreadable]:-0}" -eq 1 && "$MODE" != "status" ]]; then warn status.needRoot "$CONFIG_DIR"; fi

    case "$MODE" in
        status)
            show_status ;;
        uninstall)
            dispatch uninstall ;;
        rotate)
            dispatch rotate ;;
        change)
            if [[ "${E[existing]}" -ne 1 ]]; then stop_t error.notInstalled "$CONFIG"; fi
            flow="$TOPIC"
            if [[ -z "$flow" && "$UNATTENDED" -eq 1 ]]; then flow="${A[flow]:-}"; fi
            if [[ "$flow" == "install" ]]; then stop_t error.alreadyInstalled "$CONFIG"; fi
            if [[ -n "$flow" ]]; then dispatch "$flow"; else flow_maintain; fi ;;
        install)
            if [[ "$UNATTENDED" -eq 1 ]]; then
                dispatch "${A[flow]:-install}"
            elif [[ "${E[existing]}" -eq 1 ]] && ! installation_unfinished; then
                flow_maintain
            else
                dispatch install
            fi ;;
    esac
    return 0
}

main
