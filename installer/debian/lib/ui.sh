# shellcheck shell=bash
# TryHackX Media Server - instalator dla Debiana: rozmowa z czlowiekiem.
#
# Five questions are all the wizard ever asks: a notice, yes/no, a line of text,
# a password, one of several. Each exists twice - as a whiptail dialog and as a
# plain prompt for a terminal without it (a serial console, a minimal image) -
# and the pages in wizard.sh do not know which one they got.
#
# Every function returns 0 when answered and 1 when the person backed out
# (Cancel, Esc, end of input); the answer itself is left in UI_VALUE.
#
# Kept pure ASCII: translated text lives in installer/debian/lang/*.sh.

UI_VALUE=""
UI_WIDTH=78

ui_init() {
    # Decide how to talk: TRYHACKX_UI (whiptail|plain) or --plain force it; otherwise
    # whiptail when it is installed and both ends are a terminal.
    local wanted="${TRYHACKX_UI:-}"
    if [[ "$UNATTENDED" -eq 1 ]]; then
        UI_MODE="none"
        return 0
    fi
    if [[ "$FORCE_PLAIN" -eq 1 ]]; then wanted="plain"; fi
    if [[ -z "$wanted" ]]; then
        if [[ -t 0 && -t 1 ]] && have whiptail; then wanted="whiptail"; else wanted="plain"; fi
    fi
    if [[ "$wanted" == "whiptail" ]] && ! have whiptail; then wanted="plain"; fi
    UI_MODE="$wanted"
    UI_NO_PERSON=0
    if [[ "$UI_MODE" == "plain" && ! -t 0 && -z "${TRYHACKX_UI:-}" ]]; then
        # Nobody is there to answer. That is only a problem once something is asked
        # (--status asks nothing), so it is said at the first question.
        UI_NO_PERSON=1
    fi
    return 0
}

ui_need_person() {
    if [[ "${UI_NO_PERSON:-0}" -eq 1 ]]; then die_t error.noTerminal; fi
    return 0
}

ui_height() {
    # Enough rows for the text, within what a small terminal shows.
    local text="$1" extra="${2:-7}" lines width=$((UI_WIDTH - 6)) line count=0
    while IFS= read -r line || [[ -n "$line" ]]; do
        count=$((count + 1 + ${#line} / width))
    done <<< "$text"
    lines=$((count + extra))
    if [[ "$lines" -lt 9 ]]; then lines=9; fi
    if [[ "$lines" -gt 22 ]]; then lines=22; fi
    printf '%s' "$lines"
}

ui_plain_header() {
    emit ""
    emit "== $1"
    if [[ -n "$2" ]]; then emit "$2"; fi
}

ui_msg() {
    # ui_msg TITLE TEXT
    local title="$1" text="$2"
    case "$UI_MODE" in
        whiptail)
            whiptail --title "$title" --scrolltext --msgbox "$text" "$(ui_height "$text")" "$UI_WIDTH" || true ;;
        *)
            ui_plain_header "$title" "$text" ;;
    esac
    return 0
}

ui_yesno() {
    # ui_yesno TITLE TEXT [yes|no] - 0 for yes, 1 for no. The default is what Enter gives.
    local title="$1" text="$2" default="${3:-yes}" reply
    case "$UI_MODE" in
        whiptail)
            if [[ "$default" == "no" ]]; then
                whiptail --title "$title" --scrolltext --defaultno --yes-button "$(t ui.yes)" --no-button "$(t ui.no)" \
                    --yesno "$text" "$(ui_height "$text")" "$UI_WIDTH"
            else
                whiptail --title "$title" --scrolltext --yes-button "$(t ui.yes)" --no-button "$(t ui.no)" \
                    --yesno "$text" "$(ui_height "$text")" "$UI_WIDTH"
            fi
            return $? ;;
        none)
            if [[ "$default" == "yes" ]]; then return 0; fi
            return 1 ;;
    esac
    ui_need_person
    ui_plain_header "$title" "$text"
    while true; do
        if [[ "$default" == "yes" ]]; then printf '%s ' "$(t ui.prompt.yesDefault)"; else printf '%s ' "$(t ui.prompt.noDefault)"; fi
        IFS= read -r reply || return 1
        case "${reply,,}" in
            "")
                if [[ "$default" == "yes" ]]; then return 0; fi
                return 1 ;;
            t|tak|y|yes) return 0 ;;
            n|nie|no) return 1 ;;
        esac
    done
}

ui_input() {
    # ui_input TITLE TEXT [DEFAULT] - a line of text in UI_VALUE.
    local title="$1" text="$2" default="${3:-}" reply
    UI_VALUE=""
    case "$UI_MODE" in
        whiptail)
            reply="$(whiptail --title "$title" --inputbox "$text" "$(ui_height "$text" 8)" "$UI_WIDTH" "$default" 3>&1 1>&2 2>&3)" || return 1
            UI_VALUE="$reply"
            return 0 ;;
        none)
            UI_VALUE="$default"
            return 0 ;;
    esac
    ui_need_person
    ui_plain_header "$title" "$text"
    if [[ -n "$default" ]]; then printf '[%s] > ' "$default"; else printf '> '; fi
    IFS= read -r reply || return 1
    UI_VALUE="${reply:-$default}"
    return 0
}

ui_password() {
    # ui_password TITLE TEXT - typed without echo, left in UI_VALUE.
    local title="$1" text="$2" reply
    UI_VALUE=""
    case "$UI_MODE" in
        whiptail)
            reply="$(whiptail --title "$title" --passwordbox "$text" "$(ui_height "$text" 8)" "$UI_WIDTH" 3>&1 1>&2 2>&3)" || return 1
            UI_VALUE="$reply"
            return 0 ;;
        none)
            return 1 ;;
    esac
    ui_need_person
    ui_plain_header "$title" "$text"
    printf '> '
    IFS= read -r -s reply || return 1
    printf '\n'
    UI_VALUE="$reply"
    return 0
}

ui_menu() {
    # ui_menu TITLE TEXT DEFAULT TAG ITEM [TAG ITEM...] - the chosen TAG in UI_VALUE.
    local title="$1" text="$2" default="$3" reply index count
    shift 3
    UI_VALUE=""
    count=$(($# / 2))
    case "$UI_MODE" in
        whiptail)
            reply="$(whiptail --title "$title" --default-item "$default" --ok-button "$(t ui.ok)" --cancel-button "$(t ui.back)" \
                --menu "$text" "$(ui_height "$text" $((count + 8)))" "$UI_WIDTH" "$count" "$@" 3>&1 1>&2 2>&3)" || return 1
            UI_VALUE="$reply"
            return 0 ;;
        none)
            UI_VALUE="$default"
            return 0 ;;
    esac
    ui_need_person
    ui_plain_header "$title" "$text"
    local tags=() position=1 mark
    while [[ $# -ge 2 ]]; do
        tags+=("$1")
        mark=" "
        if [[ "$1" == "$default" ]]; then mark="*"; fi
        emit "  $mark $position) $2"
        position=$((position + 1))
        shift 2
    done
    while true; do
        printf '%s ' "$(t ui.prompt.choice "$count")"
        IFS= read -r reply || return 1
        if [[ -z "$reply" && -n "$default" ]]; then
            UI_VALUE="$default"
            return 0
        fi
        if [[ "$reply" =~ ^[0-9]+$ ]] && ((reply >= 1 && reply <= count)); then
            index=$((reply - 1))
            UI_VALUE="${tags[$index]}"
            return 0
        fi
        for index in "${!tags[@]}"; do
            if [[ "${tags[$index]}" == "$reply" ]]; then
                UI_VALUE="$reply"
                return 0
            fi
        done
    done
}
