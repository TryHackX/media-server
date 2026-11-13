# shellcheck shell=bash
# TryHackX Media Server - instalator dla Debiana: wspolne narzedzia.
#
# Sourced by zainstaluj-debian.sh. Messages, the log, running commands (or, in a
# dry run, describing them), putting files into the system, and the bridge to the
# Python helper where every decision is made (installer/setup_helper).
#
# Two conventions hold everywhere in installer/debian/lib:
#
#   * a path variable holds the path as it is on a Debian machine (/etc/...). Every
#     access to the disk goes through "$SYS$path": SYS is empty on a real machine
#     and names a scratch directory in the tests (TRYHACKX_SYSROOT), where nothing
#     is root's and nothing is real;
#   * nothing mutates the machine except through run / run_tty / install_file /
#     remove_file, so --dry-run is the same code path with the last step replaced
#     by a line of text.
#
# Kept pure ASCII: translated text lives in installer/debian/lang/*.sh.

MARKER_TEXT="TRYHACKX-MEDIA-SERVER-MANAGED v1"

# The layout - the same paths scripts/release-debian.sh and deploy/systemd/* spell
# (tests/test_debian_installer.py compares them with installer/setup_helper/debian.py).
PREFIX="/opt/tryhackx-media-server"
CURRENT="$PREFIX/current"
VENV_PYTHON="$CURRENT/.venv/bin/python"
CONFIG_DIR="/etc/tryhackx-media-server"
CONFIG="$CONFIG_DIR/config.local.toml"
MIGRATE_CONFIG="$CONFIG_DIR/config.migrate.toml"
STATE_FILE="$CONFIG_DIR/installer.json"
KNOWN_HOSTS="$CONFIG_DIR/vps_known_hosts"
ORIGIN_DIR="$CONFIG_DIR/origin"
ORIGIN_CERT="$ORIGIN_DIR/origin-cert.pem"
ORIGIN_KEY="$ORIGIN_DIR/origin-key.pem"
TLS_DIR="$CONFIG_DIR/tls"
SELF_CERT="$TLS_DIR/selfsigned-cert.pem"
SELF_KEY="$TLS_DIR/selfsigned-key.pem"
BUNDLE_DIR="$CONFIG_DIR/vps-bundle"
STATE_DIR="/var/lib/tryhackx-media-server"
LOG_DIR="/var/log/tryhackx-media-server"
# Copies of every system file the installer replaced or removed, by date.
BACKUP_ROOT="/var/backups/tryhackx-media-server"
ACME_WEBROOT="/var/www/tryhackx-media"
SITES_AVAILABLE="/etc/apache2/sites-available"
# Public shapes: Apache stops naming its version (Debian's security.conf says "ServerTokens OS").
QUIET_CONF_NAME="tryhackx-media-quiet"
QUIET_CONF="/etc/apache2/conf-available/$QUIET_CONF_NAME.conf"
SITES_ENABLED="/etc/apache2/sites-enabled"
HTTP_SITE="tryhackx-media"
HTTPS_SITE="tryhackx-media-ssl"
SYSTEMD_DIR="/etc/systemd/system"
SERVICE="tryhackx-media-transfer"
UNITS=(tryhackx-media-transfer.service tryhackx-media-maintenance.service tryhackx-media-maintenance.timer
    tryhackx-media-digest.service tryhackx-media-digest.timer)
TIMERS=(tryhackx-media-maintenance.timer tryhackx-media-digest.timer)
FAIL2BAN_FILTER="/etc/fail2ban/filter.d/tryhackx-media-auth.conf"
FAIL2BAN_JAIL="/etc/fail2ban/jail.d/tryhackx-media.conf"
RENEW_HOOK="/etc/letsencrypt/renewal-hooks/deploy/tryhackx-media-reload.sh"
SERVICE_USER="www-data"
SERVICE_GROUP="www-data"

SECRETS=()
STAMP="$(date +%Y%m%d-%H%M%S)"

# ---------------------------------------------------------------- messages

TEXT=""

text_of() {
    # text_of KEY [ARG...] - the sentence for KEY in the chosen language, with its %s
    # filled in, left in TEXT. (No subshell: this is called for every line that is said.)
    local key="$1" template without places
    shift
    template="${MSG[$key]-}"
    if [[ -z "$template" ]]; then
        TEXT="$key${*:+ $*}"
        return 0
    fi
    # printf repeats its whole format for every argument it has no place for, so a
    # sentence is given exactly as many values as it has places - never more.
    without="${template//%s/}"
    places=$(((${#template} - ${#without}) / 2))
    # shellcheck disable=SC2059  # the format is one of our own sentences, never something typed
    printf -v TEXT -- "$template" "${@:1:places}"
}

t() {
    # The same, printed - for use inside $( ).
    text_of "$@"
    printf '%s' "$TEXT"
}

has_text() {
    [[ -n "${MSG[$1]-}" ]]
}

add_secret() {
    if [[ -n "$1" ]]; then SECRETS+=("$1"); fi
    return 0
}

MASKED=""

mask_into() {
    # The text with anything secret starred out, left in MASKED.
    local secret
    MASKED="$1"
    for secret in "${SECRETS[@]:-}"; do
        if [[ -n "$secret" ]]; then MASKED="${MASKED//"$secret"/********}"; fi
    done
    return 0
}

emit() {
    # One line to the screen and to the log, with anything secret starred out.
    mask_into "$*"
    printf '%s\n' "$MASKED"
    if [[ -n "${LOG_FILE:-}" ]]; then
        printf '%s\n' "$MASKED" >> "$LOG_FILE" 2>/dev/null || true
    fi
    return 0
}

record() {
    # A line for the log alone - for what a dialog is already showing on the screen.
    mask_into "$*"
    if [[ -n "${LOG_FILE:-}" ]]; then
        printf '%s\n' "$MASKED" >> "$LOG_FILE" 2>/dev/null || true
    fi
    return 0
}

say() {
    text_of "$@"
    emit "$TEXT"
}

ok() {
    text_of "$@"
    emit "  [ok] $TEXT"
}

note() {
    text_of "$@"
    emit "  $TEXT"
}

achieved() {
    # Like ok, for a sentence that says something was done: a dry run did nothing.
    if [[ "$DRY_RUN" -eq 0 ]]; then ok "$@"; fi
    return 0
}

warn() {
    text_of "$@"
    emit "  [!]  $TEXT"
    WARNINGS+=("$TEXT")
}

fail() {
    text_of "$@"
    emit "  [x]  $TEXT"
}

die() {
    local message="$*"
    text_of label.error
    emit ""
    emit "$TEXT: $message"
    exit 1
}

die_t() {
    text_of "$@"
    die "$TEXT"
}

stop_t() {
    # A refusal rather than a failure: nothing was started, so there is nothing to "run again".
    QUIET_EXIT=1
    text_of "$@"
    die "$TEXT"
}

step() {
    STEP_INDEX=$((STEP_INDEX + 1))
    text_of "$@"
    emit ""
    if [[ "${STEP_COUNT:-0}" -gt 0 ]]; then
        emit "--- [$STEP_INDEX/$STEP_COUNT] $TEXT"
    else
        emit "--- $TEXT"
    fi
}

# ---------------------------------------------------------------- running commands

quote_command() {
    local text
    printf -v text '%q ' "$@"
    printf '%s' "${text% }"
}

log_stream() {
    local line
    while IFS= read -r line || [[ -n "$line" ]]; do
        emit "      ${line%$'\r'}"
    done
    return 0
}

run() {
    # run COMMAND [ARG...] - a command that changes the machine: logged and run, or
    # in a dry run only described. Its output goes to the screen and to the log.
    local shown status
    shown="$(quote_command "$@")"
    if [[ "$DRY_RUN" -eq 1 ]]; then
        emit "    (dry-run) $shown"
        return 0
    fi
    emit "    \$ $shown"
    set +e
    "$@" 2>&1 | log_stream
    status=${PIPESTATUS[0]}
    set -e
    return "$status"
}

run_tty() {
    # Like run, for a command that talks to the person (ssh asking for a password).
    local shown
    shown="$(quote_command "$@")"
    if [[ "$DRY_RUN" -eq 1 ]]; then
        emit "    (dry-run) $shown"
        return 0
    fi
    emit "    \$ $shown"
    "$@"
}

run_described() {
    # run_described TEXT COMMAND [ARG...] - like run, but the log shows TEXT instead of
    # the command line (used where the real line would be noise, never to hide a change).
    local shown="$1" status
    shift
    if [[ "$DRY_RUN" -eq 1 ]]; then
        emit "    (dry-run) $shown"
        return 0
    fi
    emit "    \$ $shown"
    set +e
    "$@" 2>&1 | log_stream
    status=${PIPESTATUS[0]}
    set -e
    return "$status"
}

probe() {
    # A command that only looks: runs in a dry run too, says nothing, never ends the script.
    "$@" 2>/dev/null || true
}

have() {
    command -v "$1" >/dev/null 2>&1
}

native_path() {
    # The Python helper is handed paths in its requests. On Debian a path is a path;
    # under Git Bash on Windows (where the dry run can be tried) /tmp/x means
    # something only to the shell, so it is rewritten into a form both understand.
    if have cygpath; then
        cygpath -m -- "$1"
    else
        printf '%s\n' "$1"
    fi
}

# ---------------------------------------------------------------- the helper

req_new() {
    : > "$REQUEST"
}

req() {
    # req KEY VALUE - one line of the request being put together. A value is one line: a line
    # break from something a command printed would otherwise start a line the helper refuses.
    local value="${2//$'\r'/ }"
    printf '%s=%s\n' "$1" "${value//$'\n'/ }" >> "$REQUEST"
}

req_table() {
    # req_table PREFIX ARRAY - every entry of an associative array, under PREFIX.
    local -n _table="$2"
    local key value
    for key in "${!_table[@]}"; do
        value="${_table[$key]//$'\r'/ }"
        printf '%s.%s=%s\n' "$1" "$key" "${value//$'\n'/ }" >> "$REQUEST"
    done
    return 0
}

helper() {
    # helper COMMAND - send the request, read the answer into R. Returns 1 on a
    # refusal, with the reason in R[error].
    local command="$1" line
    R=()
    while IFS= read -r line || [[ -n "$line" ]]; do
        line="${line%$'\r'}"
        if [[ "$line" == *=* ]]; then
            R["${line%%=*}"]="${line#*=}"
        fi
    # -B: no __pycache__ written as root into the unpacked package - a dry run included (seen on a
    # real Debian 13); -I ignores PYTHONDONTWRITEBYTECODE, so it is said on the command line.
    done < <("$PYTHON" -I -B -X utf8 "$THX_INSTALLER/helper.py" --shell "$command" < "$REQUEST" 2>> "${LOG_FILE:-/dev/null}")
    if [[ "${R[ok]:-0}" != "1" ]]; then
        if [[ -z "${R[error]:-}" ]]; then R[error]="$(t error.helper "$command")"; fi
        return 1
    fi
    return 0
}

ask_helper() {
    # helper, for a request that must not be refused.
    helper "$1" || die "${R[error]}"
}

take() {
    # take PREFIX ARRAY - the part of the last answer under PREFIX becomes the content of ARRAY.
    local -n _target="$2"
    local key
    _target=()
    for key in "${!R[@]}"; do
        if [[ "$key" == "$1."* ]]; then
            _target["${key#"$1".}"]="${R[$key]}"
        fi
    done
    return 0
}

problem_text() {
    # problem_text ARRAY INDEX - one problem reported by the helper, in the user's language.
    local -n _source="$1"
    local index="$2" code count position arguments=()
    code="${_source[$index.code]:-}"
    count="${_source[$index.args.count]:-0}"
    for ((position = 0; position < count; position++)); do
        arguments+=("${_source[$index.args.$position]:-}")
    done
    if has_text "problem.$code"; then
        t "problem.$code" "${arguments[@]}"
    else
        printf '%s%s' "$code" "${arguments[*]:+: ${arguments[*]}}"
    fi
}

list_items() {
    # list_items ARRAY PREFIX - the items of a list held as PREFIX.count / PREFIX.N, one per line.
    local -n _list="$1"
    local prefix="$2" count position
    count="${_list[$prefix.count]:-0}"
    for ((position = 0; position < count; position++)); do
        printf '%s\n' "${_list[$prefix.$position]:-}"
    done
    return 0
}

# ---------------------------------------------------------------- files

backup_file() {
    # A copy of a system file we are about to replace or remove; kept, never restored silently.
    local path="$1" target
    [[ "$DRY_RUN" -eq 0 && -f "$SYS$path" ]] || return 0
    target="$SYS$BACKUP_ROOT/$STAMP${path}"
    # The first copy of a run is the original: a file written twice in one run (the port-80 site
    # with Let's Encrypt) would otherwise leave this run's own first version as "the backup" (audit P3-6).
    [[ -e "$target" ]] && return 0
    mkdir -p "$(dirname -- "$target")"
    cp -p "$SYS$path" "$target"
    chmod -R go-rwx "$SYS$BACKUP_ROOT/$STAMP" 2>/dev/null || true
    return 0
}

show_file() {
    # The content a dry run would write - with anything secret starred out.
    local line
    while IFS= read -r line || [[ -n "$line" ]]; do
        emit "      | ${line%$'\r'}"
    done < "$1"
    return 0
}

install_file() {
    # install_file STAGED TARGET MODE [OWNER:GROUP] - put a prepared file into the system.
    local staged="$1" target="$2" mode="$3" owner="${4:-root:root}"
    if [[ "$DRY_RUN" -eq 1 ]]; then
        emit "    (dry-run) $(t log.file.write "$target" "$mode" "$owner")"
        show_file "$staged"
        return 0
    fi
    backup_file "$target"
    emit "    \$ $(t log.file.write "$target" "$mode" "$owner")"
    mkdir -p "$(dirname -- "$SYS$target")"
    install -m "$mode" "$staged" "$SYS$target"
    chown "$owner" "$SYS$target"
    NEW_FILES+=("$target")
    return 0
}

remove_file() {
    # Remove a system file of ours (with a copy kept). Somebody else's file is left alone.
    local target="$1"
    [[ -e "$SYS$target" || -L "$SYS$target" ]] || return 0
    if [[ -f "$SYS$target" ]] && ! grep -qF "$MARKER_TEXT" "$SYS$target" 2>/dev/null; then
        warn log.file.foreign "$target"
        return 0
    fi
    if [[ "$DRY_RUN" -eq 1 ]]; then
        emit "    (dry-run) rm $target"
        return 0
    fi
    backup_file "$target"
    emit "    \$ rm $target"
    rm -f "$SYS$target"
    return 0
}

make_dir() {
    # make_dir PATH MODE OWNER:GROUP
    local path="$1" mode="$2" owner="$3"
    if [[ "$DRY_RUN" -eq 1 ]]; then
        emit "    (dry-run) install -d -m $mode -o ${owner%%:*} -g ${owner##*:} $path"
        return 0
    fi
    emit "    \$ install -d -m $mode -o ${owner%%:*} -g ${owner##*:} $path"
    mkdir -p "$SYS$path"
    chmod "$mode" "$SYS$path"
    chown "$owner" "$SYS$path"
    return 0
}

is_ours() {
    # Whether a system file carries the installer's marker.
    [[ -f "$SYS$1" ]] && grep -qF "$MARKER_TEXT" "$SYS$1" 2>/dev/null
}

# ---------------------------------------------------------------- start and end

start_log() {
    if [[ -z "${LOG_FILE:-}" ]]; then
        if [[ "$DRY_RUN" -eq 0 && -d "$SYS/var/log" && -w "$SYS/var/log" ]]; then
            LOG_FILE="$SYS/var/log/tryhackx-media-setup-$STAMP.log"
        else
            LOG_FILE="${TMPDIR:-/tmp}/tryhackx-media-setup-$STAMP.log"
        fi
    fi
    # Appended to, never emptied: `--log FILE` may name a file somebody keeps (audit P3-13).
    if [[ -e "$LOG_FILE" ]]; then
        printf '\n==== %s\n' "$STAMP" >> "$LOG_FILE" 2>/dev/null || LOG_FILE=""
    else
        (umask 077; : > "$LOG_FILE") 2>/dev/null || LOG_FILE=""
    fi
    if [[ -n "$LOG_FILE" ]]; then chmod 0600 "$LOG_FILE" 2>/dev/null || true; fi
    return 0
}

take_lock() {
    # One run at a time: two at once would write the same files and state from both sides (audit P3-13).
    local lock="$SYS/run/lock/tryhackx-media-setup.lock"
    if [[ "$DRY_RUN" -eq 1 ]] || ! have flock || [[ ! -d "$(dirname -- "$lock")" ]]; then return 0; fi
    exec 9> "$lock"
    flock -n 9 || stop_t error.running
}

start_work() {
    WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/tryhackx-setup.XXXXXX")"
    chmod 0700 "$WORK_DIR"
    WORK_DIR="$(native_path "$WORK_DIR")"
    REQUEST="$WORK_DIR/request"
    : > "$REQUEST"
    return 0
}

on_exit() {
    local code=$? hook="${FAILURE_HOOK:-}"
    trap - EXIT
    if [[ "$code" -ne 0 && -n "$hook" ]]; then
        # A flow that changes several things at once says how to put them back.
        FAILURE_HOOK=""
        "$hook" || true
    fi
    if [[ -n "${WORK_DIR:-}" && -d "$WORK_DIR" ]]; then
        rm -rf "$WORK_DIR"
    fi
    if [[ "$code" -ne 0 && "${QUIET_EXIT:-0}" -eq 0 && -n "${LOG_FILE:-}" ]]; then
        printf '\n%s\n' "$(t exit.failed "$LOG_FILE")" >&2
    fi
    exit "$code"
}
