#!/usr/bin/env bash
# Wydanie i aktualizacja na Debianie: jeden katalog na wersję, symlink `current`
# przełączany dopiero po udanej instalacji, restarcie i smoke teście.
#
#   sudo scripts/release-debian.sh --build-frontend --migrate
#   sudo scripts/release-debian.sh --rollback
#   scripts/release-debian.sh --list
#
# Układ (domyślny):
#   /opt/tryhackx-media-server/releases/RRRRMMDD-GGMMSS   jedno wydanie = jedno drzewo
#   /opt/tryhackx-media-server/current  -> releases/…     to czyta usługa i Apache
#   /opt/tryhackx-media-server/previous -> releases/…     cel --rollback
#   /var/lib/tryhackx-media-server                        cache, dowiązany jako runtime/
#   /var/log/tryhackx-media-server                        logi, dowiązane jako logs/
#   /etc/tryhackx-media-server/config.local.toml          prywatna konfiguracja
#
# Katalog wersji jest dla usługi tylko do odczytu, dlatego wszystko, co ma przeżyć
# aktualizację, leży poza nim i wchodzi do drzewa dowiązaniami. Bez tego każde
# wydanie zaczynałoby z pustym cache miniatur: `media_server.config.PROJECT_ROOT`
# rozwiązuje dowiązania, więc widzi katalog wersji, a nie `current`.
set -euo pipefail

PREFIX="/opt/tryhackx-media-server"
CONFIG="/etc/tryhackx-media-server/config.local.toml"
MIGRATE_CONFIG=""
STATE_DIR="/var/lib/tryhackx-media-server"
LOG_DIR="/var/log/tryhackx-media-server"
SERVICE="tryhackx-media-transfer"
SERVICE_USER="www-data"
SERVICE_GROUP="www-data"
SOURCE=""
KEEP=3
HEALTH_URL=""
HEALTH_TIMEOUT=60
BUILD_FRONTEND=0
DO_MIGRATE=0
USE_SERVICE=1
USE_HEALTH=1
USE_VENV=1
DRY_RUN=0
MODE="deploy"
SWITCH_TO=""

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

die() { printf 'Błąd: %s\n' "$*" >&2; exit 1; }
note() { printf '%s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }

run() {
    if [[ "$DRY_RUN" -eq 1 ]]; then
        printf '  (dry-run) %s\n' "$*"
        return 0
    fi
    "$@"
}

is_root() { [[ "${EUID:-$(id -u)}" -eq 0 ]]; }

usage() {
    cat <<'USAGE'
Użycie: release-debian.sh [OPCJE]

  --source KATALOG     drzewo do wydania (domyślnie katalog tego repozytorium)
  --prefix KATALOG     katalog wydań (domyślnie /opt/tryhackx-media-server)
  --config PLIK        prywatna konfiguracja usługi
  --state-dir KATALOG  trwały stan: cache i statystyki (dowiązany jako runtime/)
  --log-dir KATALOG    logi (dowiązane jako logs/)
  --service NAZWA      jednostka systemd do restartu
  --user / --group     konto usługi (domyślnie www-data)
  --build-frontend     wykonaj npm ci i produkcyjny build w nowym wydaniu
  --migrate            zastosuj migracje przed przełączeniem
  --migrate-config F   konfiguracja z kontem uprawnionym do DDL (domyślnie --config)
  --keep N             ile wydań ma zostać na dysku (domyślnie 3, minimum 2 —
                       current i previous liczą się do tej liczby)
  --health-url URL     adres smoke testu (domyślnie z portu w konfiguracji)
  --timeout SEKUNDY    ile czekać na health/ready po restarcie (domyślnie 60)
  --no-service         nie dotykaj systemd (pierwsza instalacja, zanim jest jednostka)
  --no-health          pomiń smoke test
  --no-venv            pomiń instalator; wydanie musi już zawierać własne .venv
                       (drzewo przygotowane gdzie indziej). Skrypt to sprawdza.
  --switch WYDANIE     przełącz `current` na wskazane wydanie z releases/
  --rollback           przełącz `current` na wydanie wskazywane przez `previous`
  --list               wypisz wydania i zakończ
  --dry-run            wypisz kroki, nie zmieniaj niczego
  -h, --help           ta pomoc
USAGE
}

require_value() {
    [[ $# -ge 2 && -n "${2:-}" ]] || die "Opcja $1 wymaga wartości"
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --source) require_value "$@"; SOURCE="$2"; shift 2 ;;
        --prefix) require_value "$@"; PREFIX="$2"; shift 2 ;;
        --config) require_value "$@"; CONFIG="$2"; shift 2 ;;
        --migrate-config) require_value "$@"; MIGRATE_CONFIG="$2"; shift 2 ;;
        --state-dir) require_value "$@"; STATE_DIR="$2"; shift 2 ;;
        --log-dir) require_value "$@"; LOG_DIR="$2"; shift 2 ;;
        --service) require_value "$@"; SERVICE="$2"; shift 2 ;;
        --user) require_value "$@"; SERVICE_USER="$2"; shift 2 ;;
        --group) require_value "$@"; SERVICE_GROUP="$2"; shift 2 ;;
        --keep) require_value "$@"; KEEP="$2"; shift 2 ;;
        --health-url) require_value "$@"; HEALTH_URL="$2"; shift 2 ;;
        --timeout) require_value "$@"; HEALTH_TIMEOUT="$2"; shift 2 ;;
        --switch) require_value "$@"; MODE="switch"; SWITCH_TO="$2"; shift 2 ;;
        --build-frontend) BUILD_FRONTEND=1; shift ;;
        --migrate) DO_MIGRATE=1; shift ;;
        --no-service) USE_SERVICE=0; shift ;;
        --no-health) USE_HEALTH=0; shift ;;
        --no-venv) USE_VENV=0; shift ;;
        --rollback) MODE="rollback"; shift ;;
        --list) MODE="list"; shift ;;
        --dry-run) DRY_RUN=1; shift ;;
        -h|--help) usage; exit 0 ;;
        *) usage >&2; die "Nieznana opcja: $1" ;;
    esac
done

[[ "$KEEP" =~ ^[0-9]+$ ]] || die "--keep musi być liczbą"
[[ "$HEALTH_TIMEOUT" =~ ^[0-9]+$ ]] || die "--timeout musi być liczbą sekund"
# Dziesiętnie, jawnie: w [[ ]] i (( )) wiodące zero znaczy ósemkowo, więc
# `--keep 08` wywaliłoby się na „value too great for base", a `--timeout 060`
# po cichu znaczyłoby 48 sekund.
KEEP=$((10#$KEEP))
HEALTH_TIMEOUT=$((10#$HEALTH_TIMEOUT))
# Przycinanie nigdy nie może zjeść wydania, do którego wraca --rollback.
[[ "$KEEP" -ge 2 ]] || die "--keep musi wynosić co najmniej 2 (current i previous)"

# Nie restartujemy usługi, więc nie ma czego odpytywać: port trzyma nadal stary
# proces i odpowiedziałby natychmiast, dając zielony smoke test wydaniu, które
# nigdy nie ruszyło. Jeśli operator restartuje sam, mówi to wprost, podając
# --health-url — i wtedy sprawdzamy.
if [[ "$USE_SERVICE" -ne 1 && -z "$HEALTH_URL" ]]; then
    USE_HEALTH=0
fi
[[ -n "$MIGRATE_CONFIG" ]] || MIGRATE_CONFIG="$CONFIG"
[[ -n "$SOURCE" ]] || SOURCE="$(cd -- "$SCRIPT_DIR/.." && pwd)"

absolute() {
    # Cele dowiązań muszą być bezwzględne, inaczej `current` wskazuje w zależności
    # od tego, skąd ktoś uruchomił skrypt.
    case "$1" in
        /*) printf '%s\n' "$1" ;;
        *) printf '%s/%s\n' "$PWD" "$1" ;;
    esac
}

PREFIX="$(absolute "$PREFIX")"
STATE_DIR="$(absolute "$STATE_DIR")"
LOG_DIR="$(absolute "$LOG_DIR")"

RELEASES="$PREFIX/releases"
CURRENT_LINK="$PREFIX/current"
PREVIOUS_LINK="$PREFIX/previous"
# Nazwy wydań tworzy wyłącznie ten skrypt i tylko taki kształt wolno usunąć.
RELEASE_NAME_RE='^[0-9]{8}-[0-9]{6}(-[0-9]{2,})?$'

link_target() {
    # Surowy cel dowiązania (nie realpath): interesuje nas katalog wydania,
    # a nie to, dokąd prowadzą dowiązania w jego środku.
    if [[ -L "$1" ]]; then
        readlink "$1"
    fi
}

link_name() {
    # Sama nazwa wydania. Porównania „czy to jest current" muszą iść po nazwie,
    # nie po całej ścieżce: `--switch ./releases/X` albo ukośnik na końcu
    # --prefix zapisują w dowiązaniu inny zapis tej samej ścieżki, a wtedy
    # porównanie znak po znaku nie trafia — i chroniony katalog wpada pod
    # `rm -rf`. Wszystkie wydania leżą w jednym katalogu, więc nazwa wystarczy.
    local target
    target="$(link_target "$1")"
    if [[ -n "$target" ]]; then
        basename -- "$target"
    fi
    return 0
}

make_dir() {
    # -o/-g wymagają roota; bez niego katalog i tak powstaje z właściwym trybem,
    # co wystarcza do instalacji uruchamianej na własnym koncie.
    local mode="$1" path="$2"
    if is_root; then
        run install -d -m "$mode" -o "$SERVICE_USER" -g "$SERVICE_GROUP" "$path"
    else
        run install -d -m "$mode" "$path"
    fi
}

list_releases() {
    local current previous path name mark
    current="$(link_name "$CURRENT_LINK")"
    previous="$(link_name "$PREVIOUS_LINK")"
    if [[ ! -d "$RELEASES" ]]; then
        note "Brak wydań w $RELEASES"
        return 0
    fi
    for path in "$RELEASES"/*; do
        [[ -d "$path" ]] || continue
        name="$(basename -- "$path")"
        mark=""
        if [[ "$name" == "$current" ]]; then
            mark="  <- current"
        fi
        if [[ "$name" == "$previous" ]]; then
            mark="$mark  <- previous"
        fi
        printf '%s%s\n' "$name" "$mark"
    done
    return 0
}

atomic_link() {
    # rename(2) na dowiązaniu jest niepodzielny: czytelnik widzi albo stare
    # wydanie, albo nowe, nigdy braku pliku.
    local target="$1" link="$2" temporary
    # rename(2) odmawia podmiany katalogu na dowiązanie, a `mv` zostawiłby wtedy
    # po sobie plik tymczasowy i mylący komunikat.
    if [[ -d "$link" && ! -L "$link" ]]; then
        die "$link jest katalogiem, a ma być dowiązaniem — usuń go albo przenieś, zanim uruchomisz wydanie"
    fi
    temporary="$(dirname -- "$link")/.$(basename -- "$link").$$"
    # Ta sama nazwa wraca przy powrocie do poprzedniego wydania w tym samym
    # przebiegu, a `ln` odmówiłby nadpisania resztki po przerwanej próbie.
    run rm -f -- "$temporary" || return 1
    run ln -s -- "$target" "$temporary" || return 1
    run mv -Tf -- "$temporary" "$link" || return 1
}

service_action() {
    local action="$1"
    if [[ "$USE_SERVICE" -ne 1 ]]; then
        note "  pominięto systemctl $action $SERVICE (--no-service)"
        return 0
    fi
    run systemctl "$action" "$SERVICE"
}

resolve_health_url() {
    local python="$1" port=""
    if [[ "$USE_HEALTH" -ne 1 || -n "$HEALTH_URL" ]]; then
        return 0
    fi
    # Port bierze się z tej samej konfiguracji, którą przeczyta usługa. Środowisko
    # wydania jest tu zwykle gotowe; przy --dry-run albo --no-venv jeszcze go nie
    # ma, więc czyta ten sam plik interpreter z PATH — to tylko tomllib.
    if [[ ! -x "$python" ]]; then
        python="$(command -v python3 || true)"
    fi
    if [[ -n "$python" && -x "$python" ]]; then
        port="$("$python" - "$CONFIG" <<'PY' 2>/dev/null || true
import sys, tomllib
from pathlib import Path

try:
    raw = tomllib.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    port = int(raw.get("server", {}).get("port", 8765))
except Exception:
    port = 8765
print(port if 1 <= port <= 65535 else 8765)
PY
)"
    fi
    [[ "$port" =~ ^[0-9]+$ ]] || port=8765
    HEALTH_URL="http://127.0.0.1:$port/health/ready"
    return 0
}

wait_for_health() {
    if [[ "$USE_HEALTH" -ne 1 ]]; then
        if [[ "$USE_SERVICE" -ne 1 ]]; then
            note "  smoke test pominięty: bez restartu usługi odpowiedziałby stary proces"
        else
            note "  pominięto smoke test (--no-health)"
        fi
        return 0
    fi
    if [[ "$DRY_RUN" -eq 1 ]]; then
        printf '  (dry-run) czekanie na %s\n' "$HEALTH_URL"
        return 0
    fi
    # Zegar, nie licznik obrotów: jeden obrót to `curl --max-time 5` plus sekunda
    # snu, więc liczenie obrotów rozciągałoby --timeout 60 nawet do sześciu minut.
    # Ostatnia próba dostaje tylko tyle czasu, ile zostało do terminu, żeby samo
    # `--max-time` nie przekroczyło go po raz kolejny.
    local started deadline attempt
    started=$SECONDS
    deadline=$((started + HEALTH_TIMEOUT))
    while true; do
        attempt=$((deadline - SECONDS))
        if [[ "$attempt" -gt 5 || "$attempt" -lt 1 ]]; then
            attempt=5
        fi
        if curl --fail --silent --max-time "$attempt" "$HEALTH_URL" >/dev/null 2>&1; then
            note "  $HEALTH_URL odpowiada po $((SECONDS - started))s"
            return 0
        fi
        [[ "$SECONDS" -lt "$deadline" ]] || return 1
        sleep 1
    done
}

activate() {
    # Przełącz `current`, zrestartuj usługę i poczekaj na health/ready.
    # Zwraca niezerowo, gdy wydanie nie odpowiada — decyzję o powrocie podejmuje
    # wywołujący, bo tylko on wie, dokąd wracać.
    local target="$1"
    atomic_link "$target" "$CURRENT_LINK" || return 1
    service_action restart || return 1
    wait_for_health || return 1
    return 0
}

prune_releases() {
    local current previous path name kept=0
    [[ -d "$RELEASES" ]] || return 0
    current="$(link_name "$CURRENT_LINK")"
    previous="$(link_name "$PREVIOUS_LINK")"
    # --keep to liczba wydań, które mają zostać na dysku. current i previous
    # liczą się do niej i nigdy nie idą pod nóż, więc przy domyślnym 3 zostają
    # one dwa oraz jedno wydanie zapasowe.
    #
    # Chronione trzeba policzyć z góry, a nie po drodze: `previous` bywa starsze
    # niż wydanie odrzucone przez smoke test, a wtedy przy liczeniu w kolejności
    # od najnowszego miejsce zapasowe dostawał odrzucony katalog, zanim licznik
    # w ogóle doszedł do `previous` — i na dysku zostawało o jedno za dużo.
    if [[ -n "$current" && -d "$RELEASES/$current" ]]; then
        kept=$((kept + 1))
    fi
    if [[ -n "$previous" && -d "$RELEASES/$previous" && "$previous" != "$current" ]]; then
        kept=$((kept + 1))
    fi
    while IFS= read -r path; do
        [[ -n "$path" ]] || continue
        name="$(basename -- "$path")"
        if [[ "$name" == "$current" || "$name" == "$previous" ]]; then
            continue
        fi
        if [[ ! "$name" =~ $RELEASE_NAME_RE ]]; then
            note "  pominięto obcy katalog: $name"
            continue
        fi
        if [[ "$kept" -lt "$KEEP" ]]; then
            kept=$((kept + 1))
            continue
        fi
        note "  usuwanie starego wydania: $name"
        run rm -rf -- "$path"
    done < <(find "$RELEASES" -mindepth 1 -maxdepth 1 -type d | sort -r)
    return 0
}

if [[ "$MODE" == "list" ]]; then
    list_releases
    exit 0
fi

if [[ "$USE_SERVICE" -eq 1 && "$DRY_RUN" -eq 0 ]] && ! is_root; then
    die "Restart usługi wymaga roota — uruchom przez sudo albo dodaj --no-service"
fi

if [[ "$MODE" == "rollback" || "$MODE" == "switch" ]]; then
    # Zawsze ten sam zapis ścieżki: `$RELEASES/nazwa`. Dowiązanie zapisane
    # inaczej (np. z `./` po środku) przechodzi wszystkie testy, a potem nie
    # zgadza się przy sprzątaniu — i katalog, do którego wraca --rollback,
    # trafia pod `rm -rf`.
    if [[ "$MODE" == "rollback" ]]; then
        name="$(link_name "$PREVIOUS_LINK")"
        [[ -n "$name" ]] || die "Brak dowiązania $PREVIOUS_LINK — nie ma dokąd wracać"
    else
        name="$(basename -- "$SWITCH_TO")"
    fi
    target="$RELEASES/$name"
    [[ -d "$target" ]] || die "Wydanie nie istnieje: $target"
    if [[ "$USE_HEALTH" -eq 1 && "$DRY_RUN" -eq 0 ]]; then
        command -v curl >/dev/null 2>&1 || die "Do smoke testu potrzebny jest curl (albo --no-health)"
    fi
    previous_name="$(link_name "$CURRENT_LINK")"
    previous=""
    if [[ -n "$previous_name" ]]; then
        previous="$RELEASES/$previous_name"
    fi
    [[ "$target" != "$previous" ]] || die "To wydanie jest już aktywne: $target"

    step "Przełączenie na $(basename -- "$target")"
    resolve_health_url "$target/.venv/bin/python"
    if [[ -n "$previous" ]]; then
        atomic_link "$previous" "$PREVIOUS_LINK"
    fi
    if ! activate "$target"; then
        die "Wydanie $(basename -- "$target") nie odpowiada; \`current\` wskazuje na nie — sprawdź journalctl -u $SERVICE"
    fi
    note "Gotowe: current -> $(basename -- "$target")"
    exit 0
fi

# ---------------------------------------------------------------- nowe wydanie
[[ -f "$SOURCE/pyproject.toml" && -d "$SOURCE/src/media_server" ]] \
    || die "To nie wygląda na drzewo projektu: $SOURCE"
[[ -f "$CONFIG" ]] || die "Brak prywatnej konfiguracji: $CONFIG (utwórz ją instalatorem, docs/INSTALL-DEBIAN.md)"
command -v python3 >/dev/null 2>&1 || die "Brak python3"
command -v tar >/dev/null 2>&1 || die "Brak tar"
# Brakujące narzędzie smoke testu ma zatrzymać wydanie tutaj, a nie w środku
# `activate`, kiedy `current` wskazuje już na nowe wydanie, a `die` przerywa
# skrypt, zanim zdąży się cofnąć.
if [[ "$USE_HEALTH" -eq 1 && "$DRY_RUN" -eq 0 ]]; then
    command -v curl >/dev/null 2>&1 || die "Do smoke testu potrzebny jest curl (albo --no-health)"
fi

# Nazwa wydania musi rosnąć leksykalnie razem z czasem: na tym porządku stoi
# sprzątanie („od najnowszego") i to on decyduje, co jest zapasem. Branie
# pierwszej wolnej nazwy tego nie daje — po usunięciu katalogu bez przyrostka
# następne wydanie w tej samej sekundzie odziedziczyłoby nazwę sortującą się
# jako najstarsza. Dlatego przyrostek idzie od najwyższego istniejącego, a nie
# od pierwszej dziury, i jest wyrównany zerami, żeby -10 nie wypadło przed -2.
stamp="$(date -u +%Y%m%d-%H%M%S)"
release="$RELEASES/$stamp"
highest=0
if [[ -d "$RELEASES" ]]; then
    while IFS= read -r sibling; do
        [[ -n "$sibling" ]] || continue
        candidate="${sibling##*-}"
        if [[ "$candidate" =~ ^[0-9]+$ ]] && ((10#$candidate > highest)); then
            highest=$((10#$candidate))
        fi
    done < <(find "$RELEASES" -mindepth 1 -maxdepth 1 -name "${stamp}-*" 2>/dev/null)
fi
if [[ -e "$release" || "$highest" -gt 0 ]]; then
    release="$RELEASES/$stamp-$(printf '%02d' "$((highest + 1))")"
fi

step "Nowe wydanie: $release"
note "  źródło: $SOURCE"
run install -d -m 0755 "$RELEASES"
make_dir 0750 "$STATE_DIR"
make_dir 0750 "$LOG_DIR"
run install -d -m 0750 "$release"

step "Kopiowanie drzewa"
# Bez .git, bez środowisk i bez prywatnych plików: wydanie ma być tym, co
# uruchamiamy, a nie kopią stanowiska pracy. Stan wchodzi dowiązaniami niżej.
if [[ "$DRY_RUN" -eq 1 ]]; then
    printf '  (dry-run) tar %s -> %s\n' "$SOURCE" "$release"
else
    tar -c -C "$SOURCE" \
        --exclude=./.git \
        --exclude=./.venv \
        --exclude=./runtime \
        --exclude=./logs \
        --exclude=./backups \
        --exclude=./frontend/node_modules \
        --exclude=./config/config.local.toml \
        --exclude=./integrations/php/stage/config.local.php \
        --exclude='*.pyc' \
        --exclude=__pycache__ \
        --exclude=.pytest_cache \
        --exclude=.ruff_cache \
        . | tar -x --no-overwrite-dir -C "$release"
        # --no-overwrite-dir: archiwum niesie wpis `./` z prawami katalogu
        # źródłowego, więc bez tego rozpakowanie nadpisałoby tryb i właściciela
        # katalogu wydania, założonego chwilę wcześniej jako 0750.
fi

if [[ "$USE_VENV" -eq 1 ]]; then
    step "Środowisko Pythona z requirements.lock"
    install_args=(--config "$CONFIG")
    if [[ "$BUILD_FRONTEND" -eq 1 ]]; then
        install_args+=(--build-frontend)
    fi
    run python3 "$release/scripts/install.py" "${install_args[@]}"
elif [[ "$BUILD_FRONTEND" -eq 1 ]]; then
    die "--build-frontend wymaga instalatora; nie łącz go z --no-venv"
fi

# Wydanie bez interpretera nie ma prawa zostać `current`, jeśli usługa ma je
# uruchomić: jednostka wskazuje wprost `current/.venv/bin/python`, więc restart
# odbiłby się o brakujący plik, a smoke test powiedziałby tylko tyle, że
# „wydanie nie odpowiada" — i trzeba by zgadywać, dlaczego. Kopia drzewa celowo
# pomija `.venv` (siedzą w nim ścieżki bezwzględne poprzedniego katalogu), więc
# --no-venv ma sens wyłącznie wtedy, gdy środowisko wstawi tam ktoś inny.
if [[ "$DRY_RUN" -eq 0 && ! -x "$release/.venv/bin/python" ]]; then
    if [[ "$USE_SERVICE" -eq 1 ]]; then
        die "Wydanie nie ma $release/.venv/bin/python, a jednostka $SERVICE właśnie tego pliku szuka — nie przełączam na nie \`current\`"
    fi
    note "  UWAGA: wydanie nie ma .venv/bin/python; z --no-service nikt go teraz nie uruchomi,"
    note "         ale jednostka systemd na takim wydaniu nie wstanie"
fi

step "Prawa dostępu"
# Kod czyta usługa i PHP (to samo konto), ale nic w wydaniu nie jest dla nich
# zapisywalne — zapis idzie wyłącznie do dowiązanego stanu.
run chmod -R u=rwX,g=rX,o= "$release"
if is_root; then
    run chown -R "root:$SERVICE_GROUP" "$release"
    if command -v sudo >/dev/null 2>&1 && [[ "$DRY_RUN" -eq 0 ]] \
       && ! sudo -n -u "$SERVICE_USER" test -r "$CONFIG" 2>/dev/null; then
        note "  UWAGA: $SERVICE_USER może nie mieć prawa odczytu $CONFIG"
        note "         (oczekiwane: chown root:$SERVICE_GROUP i chmod 0640)"
    fi
fi

step "Dowiązania do trwałego stanu"
note "  $release/runtime -> $STATE_DIR"
note "  $release/logs    -> $LOG_DIR"
run ln -sfn -- "$STATE_DIR" "$release/runtime"
run ln -sfn -- "$LOG_DIR" "$release/logs"

if [[ "$DO_MIGRATE" -eq 1 ]]; then
    step "Migracje"
    note "  konfiguracja: $MIGRATE_CONFIG"
    run "$release/.venv/bin/python" -m media_server --config "$MIGRATE_CONFIG" migrate
fi

previous_name="$(link_name "$CURRENT_LINK")"
previous=""
if [[ -n "$previous_name" ]]; then
    previous="$RELEASES/$previous_name"
fi
resolve_health_url "$release/.venv/bin/python"

step "Przełączenie i smoke test"
if [[ -n "$HEALTH_URL" ]]; then
    note "  health: $HEALTH_URL"
fi
if activate "$release"; then
    if [[ -n "$previous" ]]; then
        atomic_link "$previous" "$PREVIOUS_LINK"
    fi
else
    if [[ -n "$previous" ]]; then
        note "Nowe wydanie nie odpowiada — powrót do $(basename -- "$previous")"
        atomic_link "$previous" "$CURRENT_LINK" || true
        service_action restart || true
        wait_for_health || note "UWAGA: poprzednie wydanie też nie odpowiada"
    else
        note "Nowe wydanie nie odpowiada, a nie ma poprzedniego, do którego można wrócić"
    fi
    die "Wydanie $(basename -- "$release") odrzucone; katalog zostaje do wglądu"
fi

step "Sprzątanie starych wydań (--keep $KEEP)"
prune_releases

step "Gotowe"
note "  current  -> $(link_target "$CURRENT_LINK")"
note "  previous -> $(link_target "$PREVIOUS_LINK")"
if [[ "$USE_SERVICE" -ne 1 ]]; then
    note "  UWAGA: usługa nie była restartowana (--no-service), więc ruch nadal"
    note "         obsługuje poprzednie wydanie — zrestartuj ją sam:"
    note "         systemctl restart $SERVICE"
fi
