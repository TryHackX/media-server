# shellcheck shell=bash
# TryHackX Media Server - instalator dla Debiana: przebiegi.
#
# A flow is: look at the machine, collect the answers (from the pages or from a
# file), let the helper turn them into a plan, show every change that plan means,
# and only then run its steps. Install, the five ways of changing an existing
# installation, the rotation of the home certificate and the uninstall are all
# that same sequence with different steps.
#
# Kept pure ASCII: translated text lives in installer/debian/lang/*.sh.

declare -A PROBLEMS=()
declare -A PLAN_WARNINGS=()
declare -A EXISTING_ROOTS=()
# Every root identifier the catalogue knows, switched-off ones too (load_kinds fills it):
# a new folder must never take the identifier of a library removed in an earlier run.
CATALOG_IDS=()
EXTRA_PROBLEMS=()
ADMIN_PASSWORD=""
MIGRATE_PASSWORD_FRESH=0

# ---------------------------------------------------------------- what is already there

load_state() {
    ST=()
    if [[ -f "$SYS$STATE_FILE" ]]; then
        req_new
        req state_file "$SYS$STATE_FILE"
        if helper debian-state-read && [[ "${R[found]:-0}" == "1" ]]; then
            take state ST
        fi
    fi
    return 0
}

copy_list() {
    # copy_list SOURCE-ARRAY SOURCE-PREFIX TARGET-ARRAY TARGET-PREFIX
    local -n _from="$1" _to="$3"
    local count position
    count="${_from[$2.count]:-0}"
    for ((position = 0; position < count; position++)); do
        _to[$4.$position]="${_from[$2.$position]}"
    done
    _to[$4.count]="$count"
    return 0
}

load_installation() {
    # Fill the answers from the installation that is there. Reads only.
    local count position
    [[ -f "$SYS$CONFIG" ]] || stop_t error.notInstalled "$CONFIG"
    req_new
    req config "$SYS$CONFIG"
    ask_helper debian-installed
    answers_defaults
    A[options.service_port]="${R[summary.server_port]:-8765}"
    A[database.name]="${R[summary.database.name]:-media_server}"
    A[database.user]="${R[summary.database.user]:-media_server}"
    count="${R[summary.roots.count]:-0}"
    EXISTING_ROOTS=()
    EXISTING_ROOTS[count]="$count"
    A[folders.count]="$count"
    for ((position = 0; position < count; position++)); do
        EXISTING_ROOTS[$position.id]="${R[summary.roots.$position.id]}"
        EXISTING_ROOTS[$position.path]="${R[summary.roots.$position.path]}"
        A[folders.$position.id]="${R[summary.roots.$position.id]}"
        A[folders.$position.path]="${R[summary.roots.$position.path]}"
        A[folders.$position.kind]="mixed"
    done
    if [[ -n "${ST[access.mode]:-}" ]]; then
        # What the installer set last time.
        A[access.mode]="${ST[access.mode]}"
        A[access.host_name]="${ST[access.host_name]:-}"
        A[access.home_address]="${ST[access.home_address]:-}"
        A[access.allow_lan]="${ST[access.allow_lan]:-0}"
        A[access.certificate]="${ST[access.certificate]:-letsencrypt}"
        A[access.acme_email]="${ST[access.acme_email]:-}"
        A[access.acme_agree_tos]="${ST[access.acme_agree_tos]:-0}"
        if [[ "${A[access.certificate]}" == "files" ]]; then
            A[access.certificate_file]="${ST[access.certificate_file]:-}"
            A[access.key_file]="${ST[access.key_file]:-}"
        fi
        copy_list ST access.vps_addresses A access.vps_addresses
        A[firewall.manage]="${ST[firewall.managed]:-1}"
        A[options.fail2ban]="${ST[fail2ban.installed]:-0}"
    else
        # Set up by hand: what its configuration implies. Nothing is claimed until a change is made.
        A[access.mode]="${R[access.mode]:-local}"
        A[access.host_name]="${R[access.host_name]:-}"
        copy_list R access.vps_addresses A access.vps_addresses
    fi
    load_kinds
    return 0
}

load_kinds() {
    # What each folder holds: from the catalogue when it answers, else a guess from the name
    # (which the person confirms on the folders page).
    local count="${A[folders.count]:-0}" position
    req_new
    if [[ -x "$SYS$VENV_PYTHON" || -z "$SYS" ]] && have runuser; then
        (cd "$SYS/" 2>/dev/null || cd /; runuser -u "$SERVICE_USER" -- "$VENV_PYTHON" -m media_server --config "$CONFIG" roots list) \
            > "$WORK_DIR/roots.json" 2>/dev/null || true
        if [[ -s "$WORK_DIR/roots.json" ]]; then req json_file "$WORK_DIR/roots.json"; fi
    fi
    req roots.count "$count"
    for ((position = 0; position < count; position++)); do
        req "roots.$position.id" "${A[folders.$position.id]}"
        req "roots.$position.path" "${A[folders.$position.path]}"
    done
    ask_helper debian-kinds
    for ((position = 0; position < count; position++)); do
        A[folders.$position.kind]="${R[roots.$position.kind]:-mixed}"
    done
    CATALOG_IDS=()
    local known="${R[catalog_ids.count]:-0}"
    for ((position = 0; position < known; position++)); do
        CATALOG_IDS+=("${R[catalog_ids.$position]}")
    done
    rm -f "$WORK_DIR/roots.json"
    return 0
}

# ---------------------------------------------------------------- answers and plan

password_settled() {
    # 1 when no password source has to be named: a dry run, or the password is read already -
    # from the environment too, which load_admin_password empties at once (audit P3-8).
    if [[ "$DRY_RUN" -eq 1 || -n "${ADMIN_PASSWORD:-}" ]]; then printf '1'; else printf '0'; fi
}

load_answers_file() {
    local position count
    req_new
    req path "$(native_path "$ANSWERS_FILE")"
    req password_optional "$(password_settled)"
    ask_helper debian-answers
    take answers A
    take problems PROBLEMS
    # The file may name the language of the run; --lang on the command line wins.
    if [[ "$LANG_GIVEN" -eq 0 && "${A[language]:-}" =~ ^(pl|en)$ && "${A[language]}" != "$LANG_CODE" ]]; then
        LANG_CODE="${A[language]}"
        load_language
    fi
    count="${PROBLEMS[count]:-0}"
    if [[ "$count" -gt 0 ]]; then
        say answers.invalid "$ANSWERS_FILE"
        for ((position = 0; position < count; position++)); do
            fail label.plain "$(problem_text PROBLEMS "$position")"
        done
        QUIET_EXIT=1
        exit 2
    fi
    return 0
}

load_admin_password() {
    # Unattended: from a file only root reads, or from the environment. Never from the answers file.
    local file="${A[admin.password_file]:-}" mode
    ADMIN_PASSWORD=""
    if [[ -n "$file" ]]; then
        if [[ ! -r "$SYS$file" ]]; then
            EXTRA_PROBLEMS+=("$(t problem.password.unreadable "$file")")
            return 0
        fi
        mode="$(probe stat -c '%a' "$SYS$file")"
        if [[ -z "$SYS" && "$mode" =~ ^[0-7]+$ ]] && (((8#$mode & 8#077) != 0)); then
            EXTRA_PROBLEMS+=("$(t problem.password.open "$file" "$mode")")
            return 0
        fi
        IFS= read -r ADMIN_PASSWORD < "$SYS$file" || true
        ADMIN_PASSWORD="${ADMIN_PASSWORD%$'\r'}"
    elif [[ -n "${TRYHACKX_ADMIN_PASSWORD:-}" ]]; then
        ADMIN_PASSWORD="$TRYHACKX_ADMIN_PASSWORD"
        # Out of the environment at once: every program started from here on - runuser as
        # www-data included - would inherit it (audit P3-8).
        unset TRYHACKX_ADMIN_PASSWORD
    elif [[ "$DRY_RUN" -eq 1 ]]; then
        # A dry run creates no account: it does not need the password it would not use.
        return 0
    fi
    if [[ "$(password_bytes "$ADMIN_PASSWORD")" -lt 12 ]]; then
        EXTRA_PROBLEMS+=("$(t admin.error.short)")
        ADMIN_PASSWORD=""
        return 0
    fi
    add_secret "$ADMIN_PASSWORD"
    return 0
}

choose_service_port() {
    if [[ "${A[options.service_port]:-0}" =~ ^[0-9]+$ && "${A[options.service_port]:-0}" -ge 1024 ]]; then return 0; fi
    A[options.service_port]="$(free_service_port)"
    return 0
}

make_plan() {
    # The helper checks the answers once more and says what they mean on this machine.
    local interactive=1 line
    if [[ "$UNATTENDED" -eq 1 ]]; then interactive=0; fi
    A[flow]="$FLOW"
    A[language]="$LANG_CODE"
    E[ufw_enabled_by_installer]="${ST[firewall.enabled_by_installer]:-0}"
    choose_service_port
    req_new
    req interactive "$interactive"
    req password_optional "$(password_settled)"
    req check_folders 1
    req sysroot "$SYS"
    req_table answers A
    req_table env E
    ask_helper debian-plan
    take answers A
    take plan P
    take problems PROBLEMS
    take warnings PLAN_WARNINGS
    while IFS= read -r line; do
        if [[ -n "$line" ]]; then EXTRA_PROBLEMS+=("$line"); fi
    done < <(port_problems "${A[access.mode]}")
    return 0
}

report_problems() {
    # Everything that stands in the way, at once. Returns 1 when there is anything.
    local count="${PROBLEMS[count]:-0}" position text="" line
    for ((position = 0; position < count; position++)); do
        text="$text- $(problem_text PROBLEMS "$position")"$'\n'
    done
    for line in "${EXTRA_PROBLEMS[@]:-}"; do
        if [[ -n "$line" ]]; then text="$text- $line"$'\n'; fi
    done
    if [[ -z "$text" ]]; then return 0; fi
    emit ""
    say problems.title
    while IFS= read -r line; do
        if [[ -n "$line" ]]; then emit "  [x]  ${line#- }"; fi
    done <<< "$text"
    if [[ "$UI_MODE" == "whiptail" ]]; then ui_msg "$(t problems.title)" "$text"; fi
    return 1
}

report_warnings() {
    local count="${PLAN_WARNINGS[count]:-0}" position
    for ((position = 0; position < count; position++)); do
        warn label.plain "$(problem_text PLAN_WARNINGS "$position")"
    done
    return 0
}

# ---------------------------------------------------------------- what will happen, before it does

summary_lines() {
    # Every change the flow will make, one sentence per line.
    local mode="${A[access.mode]}" count position item
    case "$FLOW" in
        install|access)
            t summary.mode "${P[letter]:-?}" "$(t "mode.$mode")"
            printf '\n'
            while IFS= read -r item; do
                if [[ -n "$item" ]]; then t summary.address "$item"; printf '\n'; fi
            done < <(addresses_list)
            t summary.packages "$(list_items P packages | tr '\n' ' ')"
            printf '\n'
            if [[ -n "${P[php_fpm]:-}" ]]; then t summary.phpFpm "${P[php_fpm]}"; printf '\n'; fi
            t summary.modules "$(list_items P modules | tr '\n' ' ')"
            printf '\n' ;;
    esac
    if [[ "$FLOW" == "install" ]]; then
        t summary.database "${A[database.name]}" "${A[database.user]}" "${P[migrate_user]:-}"
        printf '\n'
        t summary.config "$CONFIG" "$MIGRATE_CONFIG"
        printf '\n'
        t summary.release "$PREFIX"
        printf '\n'
        t summary.units "${UNITS[*]}"
        printf '\n'
        t summary.admin "${A[admin.username]}"
        printf '\n'
    fi
    if [[ "$FLOW" == "install" || "$FLOW" == "folders" ]]; then
        count="${A[folders.count]:-0}"
        for ((position = 0; position < count; position++)); do
            t summary.folder "${A[folders.$position.path]}" "$(t "kind.${A[folders.$position.kind]}")" "${A[folders.$position.id]:-?}"
            printf '\n'
        done
        if [[ "$FLOW" == "folders" ]]; then t summary.folders.note; printf '\n'; fi
    fi
    case "$FLOW" in
        install|access)
            t summary.access "${P[config.base_url]:-/}" "${P[config.proxy_trusted]:--}" "$(yes_no "${P[config.require_https]:-1}")"
            printf '\n'
            case "${P[certificate.kind]:-none}" in
                origin) t summary.cert.origin "${P[certificate.file]}"; printf '\n' ;;
                letsencrypt) t summary.cert.le "${A[access.host_name]}"; printf '\n' ;;
                selfsigned) t summary.cert.self "${P[certificate.file]}"; printf '\n' ;;
                files) t summary.cert.files "${P[certificate.file]}"; printf '\n' ;;
            esac
            for item in $(list_items P sites); do
                t summary.site "$SITES_AVAILABLE/$item.conf"
                printf '\n'
            done
            for item in $(list_items P disable_sites); do
                t summary.site.off "$item"
                printf '\n'
            done
            if [[ "${P[firewall.manage]:-0}" == "1" ]]; then
                while IFS= read -r item; do
                    if [[ -n "$item" ]]; then t summary.firewall.rule "$item"; printf '\n'; fi
                done < <(list_items P firewall.rules)
                if [[ "${P[firewall.enable]:-0}" == "1" ]]; then t summary.firewall.enable; printf '\n'; fi
            elif [[ "$mode" != "local" && "${E[ufw_active]:-0}" != "1" && -n "${E[foreign_firewall]:-}" ]]; then
                t summary.firewall.foreign "${E[foreign_firewall]}"
                printf '\n'
            elif [[ "$mode" != "local" ]]; then
                t summary.firewall.untouched
                printf '\n'
            fi
            if [[ "${P[fail2ban]:-0}" == "1" ]]; then t summary.fail2ban; printf '\n'; fi
            if [[ "$mode" == "vps" ]]; then t summary.bundle "$BUNDLE_DIR"; printf '\n'; fi ;;
    esac
    t summary.state "$STATE_FILE"
    printf '\n'
    return 0
}

yes_no() {
    if [[ "$1" == "1" ]]; then t label.yes; else t label.no; fi
}

addresses_list() {
    local count="${P[addresses.count]:-0}" position
    for ((position = 0; position < count; position++)); do
        printf '%s: %s\n' "$(t "address.${P[addresses.$position.kind]}")" "${P[addresses.$position.url]}"
    done
    return 0
}

confirm_summary() {
    # Show the plan; a person has to say yes, an unattended run has said it by giving the file.
    local text line question
    text="$(summary_lines)"
    question="$(t summary.confirm)"
    if [[ "$DRY_RUN" -eq 1 ]]; then question="$(t summary.confirm.dry)"; fi
    if [[ "$UI_MODE" == "whiptail" ]]; then
        # The dialog shows the list; the log keeps it.
        record ""
        record "$(t summary.title)"
        while IFS= read -r line; do
            if [[ -n "$line" ]]; then record "  * $line"; fi
        done <<< "$text"
        report_warnings
        if ui_yesno "$(t summary.title)" "$text"$'\n\n'"$question" yes; then return 0; fi
        return 1
    fi
    emit ""
    say summary.title
    while IFS= read -r line; do
        if [[ -n "$line" ]]; then emit "  * $line"; fi
    done <<< "$text"
    report_warnings
    if [[ "$UNATTENDED" -eq 1 ]]; then return 0; fi
    if ui_yesno "$(t summary.title)" "$question" yes; then return 0; fi
    return 1
}

begin_steps() {
    STEP_COUNT="$1"
    STEP_INDEX=0
}

do_steps() {
    local name
    for name in "$@"; do
        "$name"
    done
    return 0
}

run_steps() {
    begin_steps $#
    do_steps "$@"
}

require_consent_for_system() {
    if [[ "$PREFLIGHT_NEEDS_CONSENT" -ne 1 ]]; then return 0; fi
    if [[ "$UNATTENDED" -eq 1 ]]; then
        if [[ "${A[options.allow_unsupported_os]:-0}" == "1" ]]; then return 0; fi
        die_t error.os.consent
    fi
    ui_yesno "$(t preflight.os.title)" "$(t preflight.os.question "${E[os_name]:-?}")" no || die_t error.cancelled
    return 0
}

abort_unchanged() {
    emit ""
    say run.cancelled
    QUIET_EXIT=1
    exit 1
}

stop_for_problems() {
    emit ""
    say problems.stopped
    QUIET_EXIT=1
    exit 2
}

# ---------------------------------------------------------------- the end of a run

finish() {
    local mode="${A[access.mode]:-local}" item
    emit ""
    if [[ "$DRY_RUN" -eq 1 ]]; then
        say finish.dry
    else
        say "finish.$FLOW"
    fi
    case "$FLOW" in
        install|access)
            while IFS= read -r item; do
                if [[ -n "$item" ]]; then emit "  $item"; fi
            done < <(addresses_list)
            emit ""
            case "$mode" in
                direct)
                    say next.direct.dns "${A[access.host_name]}"
                    say next.direct.ports
                    if [[ "${A[access.certificate]}" == "selfsigned" ]]; then say next.direct.selfsigned; fi ;;
                vps)
                    say next.vps.dns "${A[access.host_name]}" "${A[access.vps_addresses.0]:-VPS}"
                    say next.vps.router "${E[lan_address]:-?}"
                    say next.vps.guide "$BUNDLE_DIR/$(t vps.guide.file)"
                    if [[ -n "$CERTIFICATE_FINGERPRINT" ]]; then say next.vps.fingerprint "$CERTIFICATE_FINGERPRINT"; fi ;;
                lan)
                    say next.lan ;;
            esac ;;
    esac
    if [[ "$FLOW" == "install" ]]; then
        say next.scan
        say next.change
    fi
    if [[ "${#WARNINGS[@]}" -gt 0 ]]; then
        emit ""
        say finish.warnings "${#WARNINGS[@]}"
        for item in "${WARNINGS[@]}"; do emit "  [!]  $item"; done
    fi
    if [[ -n "${LOG_FILE:-}" ]]; then
        emit ""
        say finish.log "$LOG_FILE"
    fi
    return 0
}

# ---------------------------------------------------------------- install

installation_unfinished() {
    # A configuration is there, but the run that made it never reached its end - or an uninstall
    # kept the configuration and the keys and took the rest: no record, no release. Both are
    # finished with what is kept; refusing them left only deleting the kept keys by hand (audit P2-8).
    [[ "${E[existing]}" -eq 1 ]] || return 1
    [[ "${ST[install_completed]:-}" == "0" ]] && return 0
    [[ "${E[has_state]:-0}" -eq 0 && "${E[has_release]:-0}" -eq 0 ]]
}

flow_install() {
    local steps
    FLOW="install"
    if [[ "${E[existing]}" -eq 1 ]] && ! installation_unfinished; then stop_t error.alreadyInstalled "$CONFIG"; fi
    preflight || { emit ""; say preflight.failed; QUIET_EXIT=1; exit 2; }
    if installation_unfinished; then
        emit ""
        if [[ "${E[has_state]:-0}" -eq 1 ]]; then say install.resume; else say install.reuse "$CONFIG"; fi
    fi
    if [[ "$UNATTENDED" -eq 1 ]]; then
        load_admin_password
    else
        answers_defaults
        require_consent_for_system
        wizard_install || abort_unchanged
    fi
    if installation_unfinished; then
        # The database of the first attempt is the database of this one: its name and its
        # account are in the configuration that attempt wrote, whatever is typed now.
        req_new
        req config "$SYS$CONFIG"
        ask_helper debian-installed
        A[database.name]="${R[summary.database.name]:-${A[database.name]}}"
        A[database.user]="${R[summary.database.user]:-${A[database.user]}}"
        A[options.service_port]="${R[summary.server_port]:-0}"
    fi
    make_plan
    if [[ "$UNATTENDED" -eq 1 ]]; then require_consent_for_system; fi
    report_problems || stop_for_problems
    assign_root_ids
    confirm_summary || abort_unchanged

    steps=(step_packages step_modules step_config step_database step_release step_units step_roots step_admin)
    if [[ "${P[certificate.kind]:-none}" != "none" ]]; then steps+=(step_certificate); fi
    steps+=(step_firewall step_apache)
    if [[ "${P[fail2ban]:-0}" == "1" ]]; then steps+=(step_fail2ban); fi
    steps+=(step_timers)
    if [[ "${A[access.mode]}" == "vps" ]]; then steps+=(step_bundle); fi
    steps+=(step_state step_verify)
    if [[ "${A[access.mode]}" == "vps" ]]; then steps+=(step_vps); fi
    run_steps "${steps[@]}"
    finish
}

# ---------------------------------------------------------------- changing what is there

begin_maintenance() {
    # Common start of every flow that changes an existing installation.
    preflight || { emit ""; say preflight.failed; QUIET_EXIT=1; exit 2; }
    return 0
}

merge_file_answers() {
    # Unattended: the sections the file gives replace what the installation says.
    # $1... - the top-level sections this flow takes from the file.
    local section key
    declare -A file_answers=()
    req_new
    req path "$(native_path "$ANSWERS_FILE")"
    req password_optional "$(password_settled)"
    ask_helper debian-answers
    take answers file_answers
    for section in "$@"; do
        for key in "${!A[@]}"; do
            if [[ "$key" == "$section."* ]]; then unset "A[$key]"; fi
        done
        for key in "${!file_answers[@]}"; do
            if [[ "$key" == "$section."* ]]; then A[$key]="${file_answers[$key]}"; fi
        done
    done
    return 0
}

flow_folders() {
    local steps
    FLOW="folders"
    begin_maintenance
    load_installation
    if [[ "$UNATTENDED" -eq 1 ]]; then
        merge_file_answers folders options
    else
        wizard_folders || abort_unchanged
    fi
    make_plan
    report_problems || stop_for_problems
    assign_root_ids
    confirm_summary || abort_unchanged
    steps=(step_config_roots restart_service step_roots)
    if [[ "${A[options.start_scan]:-1}" == "1" ]]; then steps+=(start_scan); fi
    steps+=(step_state step_verify)
    run_steps "${steps[@]}"
    finish
}

flow_access() {
    local steps after
    FLOW="access"
    begin_maintenance
    load_installation
    if [[ "$UNATTENDED" -eq 1 ]]; then
        merge_file_answers access firewall options vps
    else
        wizard_access || abort_unchanged
        wizard_firewall || abort_unchanged
    fi
    make_plan
    report_problems || stop_for_problems
    confirm_summary || abort_unchanged
    steps=(step_packages step_modules step_config_access)
    if [[ "${P[certificate.kind]:-none}" != "none" ]]; then steps+=(step_certificate); fi
    steps+=(step_firewall step_apache)
    # Until Apache has accepted the new shape, a failure puts the configuration and the
    # firewall back beside the Apache files - half of a new shape is worse than the old one.
    after=()
    if [[ "${P[fail2ban]:-0}" == "1" ]]; then after+=(step_fail2ban); else after+=(step_fail2ban_off); fi
    if [[ "${A[access.mode]}" == "vps" ]]; then after+=(step_bundle); fi
    after+=(step_state step_verify)
    if [[ "${A[access.mode]}" == "vps" ]]; then after+=(step_vps); fi
    begin_steps $((${#steps[@]} + ${#after[@]}))
    FAILURE_HOOK="access_rollback"
    do_steps "${steps[@]}"
    FAILURE_HOOK=""
    do_steps "${after[@]}"
    finish
}

step_fail2ban_off() {
    if [[ -e "$SYS$FAIL2BAN_JAIL" || -e "$SYS$FAIL2BAN_FILTER" ]]; then
        step step.fail2banOff
        remove_fail2ban
    else
        STEP_COUNT=$((STEP_COUNT - 1))
    fi
    return 0
}

flow_admin() {
    FLOW="admin"
    begin_maintenance
    load_installation
    if [[ "$UNATTENDED" -eq 1 ]]; then
        merge_file_answers admin
        load_admin_password
    else
        wizard_admin || abort_unchanged
    fi
    make_plan
    report_problems || stop_for_problems
    run_steps step_admin
    finish
}

units_differ() {
    # Whether the units of this tree differ from the installed ones.
    local unit
    for unit in "${UNITS[@]}"; do
        req_new
        req source "$THX_ROOT/deploy/systemd/$unit"
        req output "$WORK_DIR/units/$unit"
        ask_helper debian-mark
        if ! cmp -s "$WORK_DIR/units/$unit" "$SYS$SYSTEMD_DIR/$unit"; then return 0; fi
    done
    return 1
}

step_units_refresh() {
    if units_differ; then
        step_units
        run systemctl enable --now "${TIMERS[@]}" || true
    else
        step step.units
        ok log.units.same
    fi
    return 0
}

flow_update() {
    FLOW="update"
    begin_maintenance
    load_installation
    # From a clone the interface is built in the new release, every time (after `git pull` a build
    # left in the clone would be the old one); a release package brings it built.
    if [[ "${E[has_sources]:-0}" -ne 1 && "${E[has_build]}" -ne 1 ]]; then die_t problem.plan.no_build; fi
    if [[ "$UNATTENDED" -eq 0 ]]; then
        local text
        text="$(t update.text "$THX_ROOT" "${E[version]:-?}")"
        if [[ "${E[has_sources]:-0}" -eq 1 ]]; then text="$(t update.build "$(frontend_packs_text)")"$'\n\n'"$text"; fi
        ui_yesno "$(t update.title)" "$text" yes || abort_unchanged
    fi
    P=()
    local steps=(step_migrate_config step_database_backup)
    if [[ "${E[has_sources]:-0}" -eq 1 ]]; then
        P[build_frontend]=1
        steps+=(step_build_tools)
    fi
    steps+=(step_release step_units_refresh step_system_files_refresh step_bundle_refresh step_state step_verify)
    run_steps "${steps[@]}"
    finish
}

step_migrate_config() {
    step step.migrateConfig
    refresh_migrate_config
    ensure_migration_account
}

flow_migrate() {
    FLOW="migrate"
    begin_maintenance
    load_installation
    P=()
    run_steps step_migrate_config step_database_backup run_migrations
    finish
}

flow_vps() {
    FLOW="vps"
    begin_maintenance
    load_installation
    if [[ "${A[access.mode]}" != "vps" ]]; then die_t error.notVps; fi
    # A hand-made installation has no record of the home address: said plainly instead of an
    # internal message from the bundle generator (audit P3-20).
    if [[ -z "${A[access.home_address]:-}" ]]; then stop_t error.vps.noHomeAddress; fi
    if [[ "$UNATTENDED" -eq 1 ]]; then
        merge_file_answers vps
    else
        ask_vps_run || abort_unchanged
    fi
    make_plan
    report_problems || stop_for_problems
    run_steps step_bundle step_vps
    finish
}

ask_vps_run() {
    ui_menu "$(t vps.run.title)" "$(t vps.run.text)" ssh ssh "$(t vps.run.ssh)" manual "$(t vps.run.manual)" || return 1
    A[vps.run]="$UI_VALUE"
    if [[ "${A[vps.run]}" == "ssh" ]]; then
        ask_vps_login || return 1
    fi
    return 0
}

# ---------------------------------------------------------------- the home certificate, without downtime

NEXT_CERT="$ORIGIN_DIR/origin-cert.next.pem"
NEXT_KEY="$ORIGIN_DIR/origin-key.next.pem"
PREVIOUS_CERT="$ORIGIN_DIR/origin-cert.previous.pem"
PREVIOUS_KEY="$ORIGIN_DIR/origin-key.previous.pem"

rotate_on_vps() {
    # rotate_on_vps OPTION QUESTION-KEY - one stage on the VPS, over SSH or by the person's hand.
    local option="$1" question="$2"
    if [[ "${A[vps.run]}" == "ssh" ]]; then
        vps_send || return 1
        vps_execute "$option" || return 1
        return 0
    fi
    vps_manual "$option"
    if [[ "$DRY_RUN" -eq 1 ]]; then return 0; fi
    ui_yesno "$(t rotate.title)" "$(t "$question")" no
}

rotate_restore_home() {
    # Back to the certificate the VPS has trusted all along.
    if [[ "$DRY_RUN" -eq 1 ]]; then return 0; fi
    if [[ -s "$SYS$PREVIOUS_CERT" && -s "$SYS$PREVIOUS_KEY" ]]; then
        cp -p "$SYS$PREVIOUS_CERT" "$SYS$ORIGIN_CERT"
        cp -p "$SYS$PREVIOUS_KEY" "$SYS$ORIGIN_KEY"
        apache_back_up || warn log.apache.down
        warn rotate.restored
    fi
    return 0
}

public_status() {
    # The site as the world sees it - through the VPS, whatever the home network's own DNS says.
    local host="${A[access.host_name]}" address="${A[access.vps_addresses.0]}" attempt code="000"
    for attempt in 1 2 3 4 5 6; do
        code="$(http_status --resolve "$host:443:$address" "https://$host/")"
        if [[ "$code" == "200" ]]; then break; fi
        if [[ "$attempt" -lt 6 ]]; then sleep 5; fi
    done
    printf '%s' "$code"
}

step_rotate_new() {
    step step.rotate.new
    make_certificate origin "" "$NEXT_CERT" "$NEXT_KEY"
    write_bundle "$NEXT_CERT"
}

step_rotate_trust_both() {
    step step.rotate.both
    if [[ "${A[vps.run]}" == "ssh" ]]; then
        vps_prepare
        vps_confirm_host_key
    fi
    rotate_on_vps --odnow-start rotate.confirm.start || die_t error.rotate.start
}

step_rotate_switch() {
    local code
    step step.rotate.switch
    if [[ "$DRY_RUN" -eq 1 ]]; then
        emit "    (dry-run) mv $NEXT_CERT $ORIGIN_CERT ; mv $NEXT_KEY $ORIGIN_KEY"
        emit "    (dry-run) apache2ctl configtest"
        emit "    (dry-run) systemctl reload apache2"
        emit "    (dry-run) curl --resolve ${A[access.host_name]}:443:${A[access.vps_addresses.0]:-VPS} https://${A[access.host_name]}/"
        return 0
    fi
    cp -p "$SYS$ORIGIN_CERT" "$SYS$PREVIOUS_CERT"
    cp -p "$SYS$ORIGIN_KEY" "$SYS$PREVIOUS_KEY"
    chmod 0600 "$SYS$PREVIOUS_KEY"
    emit "    \$ mv $NEXT_CERT $ORIGIN_CERT ; mv $NEXT_KEY $ORIGIN_KEY"
    cp -p "$SYS$NEXT_CERT" "$SYS$ORIGIN_CERT"
    cp -p "$SYS$NEXT_KEY" "$SYS$ORIGIN_KEY"
    chmod 0600 "$SYS$ORIGIN_KEY"
    if ! apache_test; then
        rotate_restore_home
        die_t error.apache.syntax
    fi
    if ! run systemctl reload apache2; then
        rotate_restore_home
        die_t error.apache.reload
    fi
    code="$(public_status)"
    if [[ "$code" != "200" ]]; then
        rotate_restore_home
        die_t error.rotate.public "${A[access.host_name]}" "$code"
    fi
    ok rotate.switched "${A[access.host_name]}"
    return 0
}

step_rotate_trust_new() {
    step step.rotate.finish
    if rotate_on_vps --odnow-koniec rotate.confirm.finish; then
        if [[ "$DRY_RUN" -eq 0 ]]; then
            rm -f "$SYS$PREVIOUS_CERT" "$SYS$PREVIOUS_KEY" "$SYS$NEXT_CERT" "$SYS$NEXT_KEY"
        fi
        ok rotate.done
    else
        # The site works: the VPS still trusts both. Only the tidying-up is left.
        warn rotate.unfinished
    fi
    return 0
}

flow_rotate() {
    FLOW="rotate"
    begin_maintenance
    load_installation
    if [[ "${A[access.mode]}" != "vps" ]]; then die_t error.notVps; fi
    if [[ "$DRY_RUN" -eq 0 && ! -s "$SYS$ORIGIN_CERT" ]]; then die_t error.rotate.noCertificate "$ORIGIN_CERT"; fi
    if [[ "$UNATTENDED" -eq 1 ]]; then
        merge_file_answers vps
        if [[ "${A[vps.run]:-manual}" != "ssh" ]]; then die_t error.rotate.unattended; fi
    else
        ui_yesno "$(t rotate.title)" "$(t rotate.text)" yes || abort_unchanged
        ask_vps_run || abort_unchanged
    fi
    make_plan
    report_problems || stop_for_problems
    FAILURE_HOOK="rotate_rollback_bundle"
    run_steps step_rotate_new step_rotate_trust_both step_rotate_switch step_rotate_trust_new
    FAILURE_HOOK=""
    finish
}

rotate_rollback_bundle() {
    # A rotation that did not finish: the VPS bundle goes back to the certificate the home server
    # serves now. Left built around the new one, a later vps-setup.sh (after a new home address, a
    # rebuilt VPS) would pin a certificate nobody uses and the site would stay down (audit P2-5).
    if [[ "$DRY_RUN" -eq 1 || ! -s "$SYS$ORIGIN_CERT" ]]; then return 0; fi
    write_bundle "$ORIGIN_CERT" || true
    note log.rotate.bundleBack "$BUNDLE_DIR"
}

# ---------------------------------------------------------------- uninstall

remove_tree() {
    # Only the directories this installation owns, by name - never a path that was typed or computed.
    local path="$1"
    case "$path" in
        "$PREFIX"|"$STATE_DIR"|"$LOG_DIR"|"$CONFIG_DIR"|"$ACME_WEBROOT"|"$BACKUP_ROOT") ;;
        *) die "remove_tree: $path" ;;
    esac
    if [[ ! -e "$SYS$path" ]]; then return 0; fi
    run rm -rf -- "$SYS$path"
}

step_remove_units() {
    local unit
    step step.remove.units
    run systemctl disable --now "${TIMERS[@]}" || true
    run systemctl disable --now tryhackx-media-maintenance.service tryhackx-media-digest.service "$SERVICE.service" || true
    for unit in "${UNITS[@]}"; do
        remove_file "$SYSTEMD_DIR/$unit"
    done
    run systemctl daemon-reload || true
    return 0
}

step_remove_apache() {
    local site
    step step.remove.apache
    if ! have apache2ctl && [[ "$DRY_RUN" -eq 0 ]]; then
        ok log.apache.absent
        return 0
    fi
    for site in "$HTTPS_SITE" "$HTTP_SITE"; do
        if site_is_enabled "$site"; then run a2dissite -q "$site" || true; fi
        remove_file "$SITES_AVAILABLE/$site.conf"
    done
    # Sites of the system this installer switched off come back.
    for site in $(list_items ST apache.disabled_sites); do
        if [[ -f "$SYS$SITES_AVAILABLE/$site.conf" ]]; then run a2ensite -q "$site" || true; fi
    done
    remove_file "$RENEW_HOOK"
    if is_ours "$QUIET_CONF"; then
        run a2disconf -q "$QUIET_CONF_NAME" || true
        remove_file "$QUIET_CONF"
    fi
    if apache_test; then
        apache_reload || warn error.apache.reload
    else
        warn error.apache.syntax
    fi
    return 0
}

step_remove_firewall() {
    step step.remove.firewall
    if ! have ufw && [[ "$DRY_RUN" -eq 0 ]]; then
        ok log.firewall.absent
        return 0
    fi
    if [[ "${ST[firewall.enabled_by_installer]:-0}" == "1" && "${A[uninstall.disable_firewall]:-0}" == "1" ]]; then
        # Back to the state before the installation: the firewall goes off, and every rule of ours with it.
        remove_firewall_rules
        run ufw disable || true
    elif [[ "${ST[firewall.enabled_by_installer]:-0}" == "1" ]]; then
        # ufw stays on: SSH and the home network keep the rules that let them in.
        remove_firewall_rules keep-reach
        warn log.firewall.stays
    else
        remove_firewall_rules
    fi
    remove_fail2ban
    return 0
}

step_remove_database() {
    local status
    step step.remove.database
    if [[ "${A[uninstall.confirm_database]:-}" != "${A[database.name]}" ]]; then
        die_t error.uninstall.confirm "${A[database.name]}"
    fi
    if [[ "$DRY_RUN" -eq 1 ]]; then
        emit "    (dry-run) ${DB_CLIENT:-mariadb} --protocol=socket   <<< DROP DATABASE ${A[database.name]}; DROP USER ${A[database.user]}, ${A[database.user]}_ddl"
        return 0
    fi
    [[ -n "$DB_CLIENT" ]] || die_t error.db.noClient
    req_new
    req config "$SYS$CONFIG"
    req output "$WORK_DIR/drop.sql"
    req action drop
    ask_helper debian-sql
    emit "    \$ $DB_CLIENT --protocol=socket   <<< DROP DATABASE ${R[database]}; DROP USER ${R[user]}, ${R[ddl_user]}"
    set +e
    db_root < "$WORK_DIR/drop.sql" 2>&1 | log_stream
    status=${PIPESTATUS[0]}
    set -e
    rm -f "$WORK_DIR/drop.sql"
    [[ "$status" -eq 0 ]] || die_t error.db.drop
    return 0
}

step_remove_files() {
    step step.remove.files
    remove_tree "$PREFIX"
    remove_tree "$ACME_WEBROOT"
    if [[ "${A[uninstall.remove_data]:-0}" == "1" ]]; then
        remove_tree "$STATE_DIR"
        remove_tree "$LOG_DIR"
        remove_tree "$BACKUP_ROOT"
        # The installer's own logs of earlier runs; this run's stays as the record of the uninstall (audit P3-7).
        local old
        for old in "$SYS"/var/log/tryhackx-media-setup-*.log; do
            [[ -f "$old" && "$old" != "$LOG_FILE" ]] || continue
            run rm -f -- "$old"
        done
    fi
    if [[ "${A[uninstall.remove_config]:-0}" == "1" ]]; then
        remove_tree "$CONFIG_DIR"
    elif [[ -f "$SYS$STATE_FILE" ]]; then
        # The configuration and the keys stay; the record of an installation that is gone does not.
        run rm -f -- "$SYS$STATE_FILE"
    fi
    return 0
}

installation_traces() {
    # Anything an earlier run left, even one that stopped before writing the configuration.
    local unit site
    [[ -e "$SYS$CONFIG_DIR" || -e "$SYS$PREFIX" || -e "$SYS$STATE_DIR" ]] && return 0
    for unit in "${UNITS[@]}"; do
        [[ -e "$SYS$SYSTEMD_DIR/$unit" ]] && return 0
    done
    for site in "$SITES_AVAILABLE/$HTTP_SITE.conf" "$SITES_AVAILABLE/$HTTPS_SITE.conf" "$QUIET_CONF" "$FAIL2BAN_JAIL" "$FAIL2BAN_FILTER"; do
        is_ours "$site" && return 0
    done
    return 1
}

uninstall_summary() {
    t uninstall.summary.units "${UNITS[*]}"
    printf '\n'
    t uninstall.summary.apache "$SITES_AVAILABLE/$HTTP_SITE.conf, $SITES_AVAILABLE/$HTTPS_SITE.conf"
    printf '\n'
    if [[ "${ST[firewall.rules.count]:-0}" -gt 0 ]]; then t uninstall.summary.firewall "${ST[firewall.rules.count]}"; printf '\n'; fi
    if [[ "${ST[firewall.enabled_by_installer]:-0}" == "1" ]]; then
        # What happens to the firewall itself, said in so many words (audit P0-1).
        if [[ "${A[uninstall.disable_firewall]:-0}" == "1" ]]; then t uninstall.summary.firewallOff; else t uninstall.summary.firewallStays; fi
        printf '\n'
    fi
    t uninstall.summary.release "$PREFIX"
    printf '\n'
    if [[ "${A[uninstall.remove_data]:-0}" == "1" ]]; then t uninstall.summary.data "$STATE_DIR" "$LOG_DIR" "$BACKUP_ROOT"; printf '\n'; fi
    if [[ "${A[uninstall.remove_config]:-0}" == "1" ]]; then t uninstall.summary.config "$CONFIG_DIR"; printf '\n'; fi
    if [[ "${A[uninstall.drop_database]:-0}" == "1" ]]; then
        t uninstall.summary.database "${A[database.name]}"
    else
        t uninstall.summary.databaseKept "${A[database.name]}" "${A[database.user]}" "${A[database.user]}_ddl"
    fi
    printf '\n'
    t uninstall.summary.kept
    printf '\n'
    # What lives outside this machine, or outside what an uninstall may touch, said so it is not
    # forgotten there (audit P3-7).
    if [[ "${A[access.mode]:-}" == "vps" ]]; then t uninstall.summary.vps; printf '\n'; fi
    if [[ "${A[access.mode]:-}" == "direct" && "${A[access.certificate]:-}" == "letsencrypt" && -n "${A[access.host_name]:-}" ]]; then
        t uninstall.summary.letsencrypt "${A[access.host_name]}" "${A[access.host_name]}"
        printf '\n'
    fi
    return 0
}

flow_uninstall() {
    local steps text line
    FLOW="uninstall"
    preflight || { emit ""; say preflight.failed; QUIET_EXIT=1; exit 2; }
    if [[ "${E[existing]}" -eq 1 ]]; then
        load_installation
    elif ! installation_traces; then
        # Nothing of ours on this machine: no questions about things that are not there.
        emit ""
        say uninstall.nothing
        exit 0
    else
        answers_defaults
    fi
    if [[ "$UNATTENDED" -eq 1 ]]; then
        merge_file_answers uninstall
    else
        wizard_uninstall || abort_unchanged
    fi
    if [[ "${A[uninstall.drop_database]:-0}" == "1" && "${A[uninstall.confirm_database]:-}" != "${A[database.name]}" ]]; then
        die_t error.uninstall.confirm "${A[database.name]}"
    fi
    text="$(uninstall_summary)"
    emit ""
    say uninstall.summary.title
    while IFS= read -r line; do
        if [[ -n "$line" ]]; then emit "  * $line"; fi
    done <<< "$text"
    if [[ "$UNATTENDED" -eq 0 ]]; then
        ui_yesno "$(t uninstall.summary.title)" "$text"$'\n\n'"$(t uninstall.confirm)" no || abort_unchanged
    fi
    steps=(step_remove_units step_remove_apache step_remove_firewall)
    if [[ "${A[uninstall.drop_database]:-0}" == "1" ]]; then steps+=(step_remove_database); fi
    steps+=(step_remove_files)
    run_steps "${steps[@]}"
    emit ""
    if [[ "$DRY_RUN" -eq 1 ]]; then say finish.dry; else say finish.uninstall; fi
    if [[ "${ST[packages_installed.count]:-0}" -gt 0 ]]; then
        say uninstall.packages "$(list_items ST packages_installed | tr '\n' ' ')"
    fi
    if [[ "${ST[access.certificate]:-}" == "letsencrypt" && -n "${ST[access.host_name]:-}" ]]; then
        say uninstall.letsencrypt "${ST[access.host_name]}"
    fi
    return 0
}

# ---------------------------------------------------------------- status

status_text() {
    local mode="${A[access.mode]:-local}" active
    if [[ "${E[service_active]:-0}" == "1" ]]; then active="$(t status.active)"; else active="$(t status.inactive)"; fi
    printf '%s\n' "$(t status.mode "$(t "mode.$mode")")"
    if [[ -n "${A[access.host_name]:-}" ]]; then printf '%s\n' "$(t status.host "${A[access.host_name]}")"; fi
    printf '%s\n' "$(t status.service "$SERVICE" "$active" "${A[options.service_port]:-8765}")"
    printf '%s\n' "$(t status.folders "${A[folders.count]:-0}")"
    return 0
}

show_status() {
    local line position count
    if [[ "${E[unreadable]:-0}" -eq 1 ]]; then stop_t status.needRoot "$CONFIG_DIR"; fi
    if [[ "${E[existing]}" -ne 1 ]]; then
        say status.none "$CONFIG"
        return 0
    fi
    load_installation
    say status.title
    while IFS= read -r line; do
        if [[ -n "$line" ]]; then emit "  $line"; fi
    done < <(status_text)
    count="${A[folders.count]:-0}"
    for ((position = 0; position < count; position++)); do
        emit "    ${A[folders.$position.id]}: ${A[folders.$position.path]}  [$(t "kind.${A[folders.$position.kind]}")]"
    done
    if [[ "${E[has_state]}" -ne 1 ]]; then note status.byHand; fi
    return 0
}

flow_maintain() {
    # An installation is here and no flow was named: ask what to do with it.
    ui_need_person
    load_installation
    while true; do
        wizard_maintain_menu || return 0
        case "$UI_VALUE" in
            folders) flow_folders; return 0 ;;
            access) flow_access; return 0 ;;
            admin) flow_admin; return 0 ;;
            update) flow_update; return 0 ;;
            migrate) flow_migrate; return 0 ;;
            vps) flow_vps; return 0 ;;
            rotate) flow_rotate; return 0 ;;
            uninstall) flow_uninstall; return 0 ;;
            *) return 0 ;;
        esac
    done
}
