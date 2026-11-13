# shellcheck shell=bash
# TryHackX Media Server - instalator dla Debiana: pytania.
#
# The pages of the interactive run. Each one fills a part of A (the answers) and
# checks what was typed before moving on, with the same code that checks an
# answers file (the helper) - so the wizard cannot collect an installation that
# --answers would refuse. A page returns 1 when the person backs out.
#
# Kept pure ASCII: translated text lives in installer/debian/lang/*.sh.

answers_defaults() {
    # Every answer the helper knows, with the value it would assume itself.
    A=()
    A[flow]="install"
    A[language]="$LANG_CODE"
    A[access.mode]="local"
    A[access.host_name]=""
    A[access.certificate]="letsencrypt"
    A[access.certificate_file]=""
    A[access.key_file]=""
    A[access.acme_email]=""
    A[access.acme_agree_tos]=0
    A[access.vps_addresses.count]=0
    A[access.home_address]=""
    A[access.allow_lan]=0
    A[access.disable_existing_https]=0
    A[access.regenerate_certificate]=0
    A[database.name]="media_server"
    A[database.user]="media_server"
    A[folders.count]=0
    A[admin.username]=""
    A[admin.email]=""
    A[admin.password_file]=""
    A[admin.role]="super_admin"
    A[firewall.manage]=1
    A[firewall.trust_lan]=1
    A[firewall.lan_subnets.count]=0
    A[firewall.extra_ports.count]=0
    A[options.fail2ban]=0
    A[options.start_scan]=1
    A[options.build_frontend]=0
    A[options.allow_unsupported_os]=0
    A[options.service_port]=0
    A[vps.run]="manual"
    A[vps.ssh_host]=""
    A[vps.ssh_user]="root"
    A[vps.ssh_port]=22
    A[vps.ssh_identity_file]=""
    A[vps.ssh_host_fingerprint]=""
    A[uninstall.drop_database]=0
    A[uninstall.confirm_database]=""
    A[uninstall.remove_data]=0
    A[uninstall.remove_config]=0
    A[uninstall.disable_firewall]=0
    return 0
}

set_list() {
    # set_list ARRAY PREFIX ITEM... - store a list the way the helper reads it.
    local -n _array="$1"
    local prefix="$2" index=0 key
    shift 2
    for key in "${!_array[@]}"; do
        if [[ "$key" == "$prefix."* ]]; then unset "_array[$key]"; fi
    done
    for key in "$@"; do
        _array[$prefix.$index]="$key"
        index=$((index + 1))
    done
    _array[$prefix.count]="$index"
    return 0
}

# ---------------------------------------------------------------- how the server is reached

validate_access() {
    # The helper's own checks on a name, the VPS addresses and the home address.
    # On success the tidied values replace what was typed; on refusal R[error] says why.
    local host="$1" home="$2" address index=0
    shift 2
    req_new
    if [[ -n "$host" ]]; then req host_name "$host"; fi
    if [[ -n "$home" ]]; then req home_address "$home"; fi
    if [[ $# -gt 0 ]]; then
        for address in "$@"; do
            req "vps_addresses.$index" "$address"
            index=$((index + 1))
        done
        req vps_addresses.count "$index"
    fi
    helper validate-access
}

ask_host_name() {
    while true; do
        ui_input "$(t access.host.title)" "$(t access.host.text)" "${A[access.host_name]}" || return 1
        if [[ -z "$UI_VALUE" ]]; then continue; fi
        if validate_access "$UI_VALUE" ""; then
            A[access.host_name]="${R[host_name]}"
            return 0
        fi
        ui_msg "$(t label.error)" "${R[error]}"
    done
}

ask_acme() {
    # ask_acme TEXT-KEY - the e-mail for Let's Encrypt and the acceptance of its terms.
    ui_input "$(t acme.email.title)" "$(t acme.email.text)" "${A[access.acme_email]}" || return 1
    A[access.acme_email]="$UI_VALUE"
    if ui_yesno "$(t acme.tos.title)" "$(t "$1")" yes; then
        A[access.acme_agree_tos]=1
    else
        A[access.acme_agree_tos]=0
    fi
    return 0
}

ask_direct() {
    local choice
    ask_host_name || return 1
    while true; do
        ui_menu "$(t cert.title)" "$(t cert.text "${A[access.host_name]}")" "${A[access.certificate]}" \
            letsencrypt "$(t cert.choice.letsencrypt)" \
            selfsigned "$(t cert.choice.selfsigned)" \
            files "$(t cert.choice.files)" || return 1
        choice="$UI_VALUE"
        case "$choice" in
            letsencrypt)
                ask_acme acme.tos.text || return 1
                # Without the acceptance certbot cannot be run for the person: another way it is.
                if [[ "${A[access.acme_agree_tos]}" != "1" ]]; then continue; fi ;;
            files)
                ui_input "$(t cert.file.title)" "$(t cert.file.text)" "${A[access.certificate_file]}" || return 1
                A[access.certificate_file]="$UI_VALUE"
                ui_input "$(t cert.key.title)" "$(t cert.key.text)" "${A[access.key_file]}" || return 1
                A[access.key_file]="$UI_VALUE"
                if [[ ! -s "$SYS${A[access.certificate_file]}" || ! -s "$SYS${A[access.key_file]}" ]]; then
                    ui_msg "$(t label.error)" "$(t error.cert.files "${A[access.certificate_file]}" "${A[access.key_file]}")"
                    continue
                fi ;;
        esac
        A[access.certificate]="$choice"
        break
    done
    if ui_yesno "$(t fail2ban.title)" "$(t fail2ban.text)" yes; then A[options.fail2ban]=1; else A[options.fail2ban]=0; fi
    return 0
}

ask_vps() {
    local typed parts=() current
    ask_host_name || return 1
    while true; do
        current="$(list_items A access.vps_addresses | tr '\n' ' ')"
        ui_input "$(t vps.address.title)" "$(t vps.address.text)" "${current% }" || return 1
        typed="${UI_VALUE//,/ }"
        read -r -a parts <<< "$typed"
        if [[ "${#parts[@]}" -eq 0 ]]; then continue; fi
        if validate_access "" "" "${parts[@]}"; then
            parts=()
            while IFS= read -r typed; do parts+=("$typed"); done < <(list_items R vps_addresses)
            set_list A access.vps_addresses "${parts[@]}"
            break
        fi
        ui_msg "$(t label.error)" "${R[error]}"
    done
    while true; do
        ui_input "$(t vps.home.title)" "$(t vps.home.text)" "${A[access.home_address]}" || return 1
        if [[ -z "$UI_VALUE" ]]; then continue; fi
        if validate_access "" "$UI_VALUE"; then
            typed="${R[home_target]}"
            typed="${typed#[}"
            typed="${typed%]}"
            if [[ "${R[home_kind]}" != "name" && " $(list_items A access.vps_addresses | tr '\n' ' ')" == *" $typed "* ]]; then
                ui_msg "$(t label.error)" "$(t problem.answers.home_is_vps)"
                continue
            fi
            A[access.home_address]="$typed"
            break
        fi
        ui_msg "$(t label.error)" "${R[error]}"
    done
    if ui_yesno "$(t vps.lan.title)" "$(t vps.lan.text)" no; then A[access.allow_lan]=1; else A[access.allow_lan]=0; fi
    ask_acme acme.tos.vps || return 1
    ui_menu "$(t vps.run.title)" "$(t vps.run.text)" "${A[vps.run]}" \
        ssh "$(t vps.run.ssh)" manual "$(t vps.run.manual)" || return 1
    A[vps.run]="$UI_VALUE"
    if [[ "${A[vps.run]}" == "ssh" ]]; then
        ask_vps_login || return 1
    fi
    return 0
}

ask_vps_login() {
    # The SSH account and port of the VPS, checked as they are typed: a typo used to come back
    # only after every other question, and the whole wizard had to be done again (audit P3-11).
    while true; do
        ui_input "$(t vps.user.title)" "$(t vps.user.text)" "${A[vps.ssh_user]}" || return 1
        if [[ "${UI_VALUE:-root}" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]]; then A[vps.ssh_user]="${UI_VALUE:-root}"; break; fi
        ui_msg "$(t label.warning)" "$(t problem.answers.ssh_user "$UI_VALUE")"
    done
    while true; do
        ui_input "$(t vps.port.title)" "$(t vps.port.text)" "${A[vps.ssh_port]}" || return 1
        if [[ "${UI_VALUE:-22}" =~ ^[0-9]{1,5}$ ]] && (( 10#${UI_VALUE:-22} >= 1 && 10#${UI_VALUE:-22} <= 65535 )); then
            A[vps.ssh_port]="$((10#${UI_VALUE:-22}))"
            break
        fi
        ui_msg "$(t label.warning)" "$(t problem.vps.port "$UI_VALUE")"
    done
    return 0
}

wizard_access() {
    while true; do
        ui_menu "$(t access.title)" "$(t access.text)" "${A[access.mode]}" \
            direct "$(t access.choice.direct)" \
            vps "$(t access.choice.vps)" \
            lan "$(t access.choice.lan)" \
            local "$(t access.choice.local)" || return 1
        A[access.mode]="$UI_VALUE"
        case "$UI_VALUE" in
            direct) ask_direct || continue ;;
            vps) ask_vps || continue ;;
            lan)
                if ! ui_yesno "$(t access.lan.title)" "$(t access.lan.text)" yes; then continue; fi ;;
        esac
        return 0
    done
}

# ---------------------------------------------------------------- media folders

folders_text() {
    local count="${A[folders.count]:-0}" position
    if [[ "$count" -eq 0 ]]; then
        t folders.none
        return 0
    fi
    for ((position = 0; position < count; position++)); do
        printf '%s. %s  [%s]\n' "$((position + 1))" "${A[folders.$position.path]}" "$(t "kind.${A[folders.$position.kind]}")"
    done
    return 0
}

folder_remove() {
    local index="$1" count="${A[folders.count]:-0}" position next field
    for ((position = index; position < count - 1; position++)); do
        next=$((position + 1))
        for field in path kind id; do
            A[folders.$position.$field]="${A[folders.$next.$field]:-}"
        done
    done
    for field in path kind id; do
        unset "A[folders.$((count - 1)).$field]"
    done
    A[folders.count]=$((count - 1))
    return 0
}

ask_kind() {
    # ask_kind PATH DEFAULT - what the folder holds, in UI_VALUE.
    ui_menu "$(t folders.kind.title)" "$(t folders.kind.text "$1")" "$2" \
        music "$(t kind.music)" movies "$(t kind.movies)" mixed "$(t kind.mixed)"
}

check_folder() {
    # check_folder PATH SKIP-INDEX - the helper's verdict on one folder; R holds path, kind and problems.
    local path="$1" skip="${2:--1}" count="${A[folders.count]:-0}" position index=0
    req_new
    req path "$path"
    req sysroot "$SYS"
    for ((position = 0; position < count; position++)); do
        if [[ "$position" -ne "$skip" ]]; then
            req "others.$index" "${A[folders.$position.path]}"
            index=$((index + 1))
        fi
    done
    req others.count "$index"
    ask_helper debian-folder
}

folder_readable() {
    # Whether the account the service runs as can enter and read the folder. Only a real
    # run as root can tell; anything else assumes yes.
    local path="$1"
    if [[ "${E[is_root]:-0}" != "1" || -n "$SYS" ]] || ! have runuser; then return 0; fi
    runuser -u "$SERVICE_USER" -- test -r "$path" -a -x "$path" 2>/dev/null
}

folder_add() {
    local path kind position count problems text
    while true; do
        ui_input "$(t folders.add.title)" "$(t folders.add.text)" "" || return 1
        if [[ -z "$UI_VALUE" ]]; then return 1; fi
        check_folder "$UI_VALUE"
        count="${R[problems.count]:-0}"
        if [[ "$count" -gt 0 ]]; then
            text=""
            for ((position = 0; position < count; position++)); do
                problems="$(problem_text R "problems.$position")"
                text="$text$problems"$'\n'
            done
            ui_msg "$(t label.error)" "$text"
            continue
        fi
        path="${R[path]}"
        kind="${R[kind]:-mixed}"
        if ! folder_readable "$path"; then
            ui_msg "$(t label.warning)" "$(t folders.unreadable "$path" "$SERVICE_USER")"
        fi
        ask_kind "$path" "$kind" || return 1
        position="${A[folders.count]:-0}"
        A[folders.$position.path]="$path"
        A[folders.$position.kind]="$UI_VALUE"
        A[folders.$position.id]=""
        A[folders.count]=$((position + 1))
        return 0
    done
}

wizard_folders() {
    local count choice items position
    while true; do
        count="${A[folders.count]:-0}"
        items=(add "$(t folders.menu.add)")
        if [[ "$count" -gt 0 ]]; then
            items+=(kind "$(t folders.menu.kind)" remove "$(t folders.menu.remove)" done "$(t folders.menu.done)")
        fi
        choice="add"
        if [[ "$count" -gt 0 ]]; then choice="done"; fi
        ui_menu "$(t folders.title)" "$(t folders.text)"$'\n\n'"$(folders_text)" "$choice" "${items[@]}" || return 1
        case "$UI_VALUE" in
            add) folder_add || true ;;
            kind|remove)
                choice="$UI_VALUE"
                ui_input "$(t folders.pick.title)" "$(t folders.pick.text)"$'\n\n'"$(folders_text)" "1" || continue
                if [[ ! "$UI_VALUE" =~ ^[0-9]+$ ]] || ((UI_VALUE < 1 || UI_VALUE > count)); then continue; fi
                position=$((UI_VALUE - 1))
                if [[ "$choice" == "remove" ]]; then
                    folder_remove "$position"
                elif ask_kind "${A[folders.$position.path]}" "${A[folders.$position.kind]}"; then
                    A[folders.$position.kind]="$UI_VALUE"
                fi ;;
            done)
                if [[ "$count" -gt 0 ]]; then return 0; fi ;;
        esac
    done
}

# ---------------------------------------------------------------- the first account

password_bytes() {
    printf '%s' "$1" | wc -c | tr -d ' '
}

ask_admin_password() {
    local first
    while true; do
        ui_password "$(t admin.password.title)" "$(t admin.password.text)" || return 1
        first="$UI_VALUE"
        if [[ "$(password_bytes "$first")" -lt 12 ]]; then
            ui_msg "$(t label.error)" "$(t admin.error.short)"
            continue
        fi
        ui_password "$(t admin.password.title)" "$(t admin.password.repeat)" || return 1
        if [[ "$UI_VALUE" != "$first" ]]; then
            ui_msg "$(t label.error)" "$(t admin.error.mismatch)"
            continue
        fi
        ADMIN_PASSWORD="$first"
        add_secret "$ADMIN_PASSWORD"
        return 0
    done
}

wizard_admin() {
    local pattern='^[A-Za-z0-9._-]{3,32}$' mail='^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$'
    while true; do
        ui_input "$(t admin.name.title)" "$(t admin.name.text)" "${A[admin.username]}" || return 1
        if [[ "$UI_VALUE" =~ $pattern ]]; then
            A[admin.username]="$UI_VALUE"
            break
        fi
        ui_msg "$(t label.error)" "$(t problem.answers.admin_username "$UI_VALUE")"
    done
    while true; do
        ui_input "$(t admin.email.title)" "$(t admin.email.text)" "${A[admin.email]}" || return 1
        if [[ -z "$UI_VALUE" || "$UI_VALUE" =~ $mail ]]; then
            A[admin.email]="$UI_VALUE"
            break
        fi
        ui_msg "$(t label.error)" "$(t problem.answers.admin_email "$UI_VALUE")"
    done
    ask_admin_password
}

# ---------------------------------------------------------------- the firewall and the rest

wizard_firewall() {
    local text
    if [[ "${A[access.mode]}" == "local" ]]; then return 0; fi
    if [[ "${E[ufw_active]:-0}" != "1" && -n "${E[foreign_firewall]:-}" ]]; then
        # Somebody else's firewall filters this machine: nothing to ask, the plan says which ports to open in it.
        A[firewall.manage]=1
        return 0
    fi
    if [[ "${E[ufw_active]:-0}" == "1" ]]; then
        text="$(t firewall.text.active)"
    elif [[ "${A[access.mode]}" == "direct" ]]; then
        text="$(t firewall.text.public "$(list_items E ssh_ports | tr '\n' ' ')")"
        if [[ "${E[listeners.count]:-0}" -gt 0 ]]; then
            text="$text"$'\n\n'"$(t firewall.text.listeners "$(list_items E listeners | tr '\n' ' ')")"
        fi
    else
        text="$(t firewall.text.home)"
    fi
    if ui_yesno "$(t firewall.title)" "$text" yes; then A[firewall.manage]=1; else A[firewall.manage]=0; fi
    return 0
}

wizard_install() {
    ui_need_person
    ui_msg "$(t welcome.title)" "$(t welcome.text "${E[version]:-}")"
    wizard_access || return 1
    wizard_folders || return 1
    wizard_admin || return 1
    wizard_firewall || return 1
    if [[ "${E[has_sources]:-0}" == "1" || "${E[has_build]:-0}" != "1" ]]; then
        if ui_yesno "$(t build.title)" "$(t build.text "$(frontend_packs_text)")" no; then A[options.build_frontend]=1; else return 1; fi
    fi
    return 0
}

frontend_packs_text() {
    # What an interface built here takes from frontend/vendor, in one sentence.
    if [[ -n "${E[vendor_packs]:-}" ]]; then t build.packs "${E[vendor_packs]}"; else t build.public; fi
}

# ---------------------------------------------------------------- an installation that is already there

wizard_maintain_menu() {
    # What to do with the installation that was found; the chosen flow in UI_VALUE.
    local items=(
        folders "$(t maintain.folders)"
        access "$(t maintain.access)"
        admin "$(t maintain.admin)"
        update "$(t maintain.update)"
        migrate "$(t maintain.migrate)"
    )
    if [[ "${A[access.mode]}" == "vps" ]]; then
        items+=(vps "$(t maintain.vps)" rotate "$(t maintain.rotate)")
    fi
    items+=(uninstall "$(t maintain.uninstall)" quit "$(t maintain.quit)")
    ui_menu "$(t maintain.title)" "$(t maintain.text "$(status_text)")" quit "${items[@]}"
}

wizard_uninstall() {
    local name="${A[database.name]}"
    if ! ui_yesno "$(t uninstall.title)" "$(t uninstall.text)" no; then return 1; fi
    if ui_yesno "$(t uninstall.data.title)" "$(t uninstall.data.text "$STATE_DIR" "$LOG_DIR" "$BACKUP_ROOT")" no; then
        A[uninstall.remove_data]=1
    fi
    if ui_yesno "$(t uninstall.config.title)" "$(t uninstall.config.text "$CONFIG_DIR")" no; then
        A[uninstall.remove_config]=1
    fi
    if ui_yesno "$(t uninstall.database.title)" "$(t uninstall.database.text "$name")" no; then
        ui_input "$(t uninstall.database.title)" "$(t uninstall.database.confirm "$name")" "" || return 1
        if [[ "$UI_VALUE" == "$name" ]]; then
            A[uninstall.drop_database]=1
            A[uninstall.confirm_database]="$UI_VALUE"
        else
            ui_msg "$(t label.warning)" "$(t uninstall.database.kept)"
        fi
    fi
    if [[ "${ST[firewall.enabled_by_installer]:-0}" == "1" ]]; then
        # The default is the state before the installation: this installer switched ufw on (audit P0-1).
        if ui_yesno "$(t uninstall.firewall.title)" "$(t uninstall.firewall.text)" yes; then
            A[uninstall.disable_firewall]=1
        else
            A[uninstall.disable_firewall]=0
        fi
    fi
    return 0
}
