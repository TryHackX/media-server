# shellcheck shell=bash
# TryHackX Media Server - instalator dla Debiana: co to za maszyna.
#
# Everything here only looks. The facts land in E (an associative array, keys as
# the Python helper reads them under "env."), and preflight turns them into the
# list a person sees before anything is asked: system, rights, disk, network,
# ports. A dry run runs all of it for real - that is what makes its plan honest.
#
# Kept pure ASCII: translated text lives in installer/debian/lang/*.sh.

detect_system() {
    local key value
    E[os_id]=""
    E[os_like]=""
    E[os_version]=""
    E[os_codename]=""
    E[os_name]=""
    if [[ -r "$SYS/etc/os-release" ]]; then
        while IFS='=' read -r key value || [[ -n "$key" ]]; do
            value="${value%$'\r'}"
            value="${value%\"}"
            value="${value#\"}"
            case "$key" in
                ID) E[os_id]="$value" ;;
                ID_LIKE) E[os_like]="$value" ;;
                VERSION_ID) E[os_version]="$value" ;;
                VERSION_CODENAME) E[os_codename]="$value" ;;
                PRETTY_NAME) E[os_name]="$value" ;;
            esac
        done < "$SYS/etc/os-release"
    fi
    E[is_root]=0
    # TRYHACKX_ASSUME_ROOT exists for the test harness, which runs every step against
    # stand-ins inside a scratch directory and has no root to be.
    if [[ "${EUID:-$(id -u)}" -eq 0 || ( -n "$SYS" && "${TRYHACKX_ASSUME_ROOT:-0}" == "1" ) ]]; then E[is_root]=1; fi
    E[systemd]=0
    if [[ -d "$SYS/run/systemd/system" ]]; then E[systemd]=1; fi
    E[python_version]="$(probe "$PYTHON" -c 'import sys; print("%d.%d" % sys.version_info[:2])')"
    E[python_version]="${E[python_version]%$'\r'}"
    E[version]="$(sed -n 's/^version = "\(.*\)".*/\1/p' "$THX_ROOT/pyproject.toml" 2>/dev/null | head -n 1)"
    E[has_build]=0
    if [[ -f "$THX_ROOT/public/assets/build/index.html" ]]; then E[has_build]=1; fi
    # A clone of the repository has the interface's sources and is built from them every time:
    # a build somebody left in it is the interface of an older pull. A release package carries
    # the build and no sources.
    E[has_sources]=0
    if [[ -f "$THX_ROOT/frontend/package-lock.json" ]]; then E[has_sources]=1; fi
    # The tests run this installer out of the repository itself - a clone, built or not depending
    # on the machine - and say which kind of tree it stands for.
    case "${TRYHACKX_SOURCE_LAYOUT:-}" in
        package) E[has_build]=1; E[has_sources]=0 ;;
        clone) E[has_build]=0; E[has_sources]=1 ;;
        built-clone) E[has_build]=1; E[has_sources]=1 ;;
    esac
    E[has_node]=0
    if have npm && have node; then E[has_node]=1; fi
    # The packs a clone of the private repository put in frontend/vendor: they go into an interface
    # built here. Dot folders (a clone's .git) are no packs - the build does not read them.
    E[vendor_packs]=""
    if [[ -d "$THX_ROOT/frontend/vendor" ]]; then
        local pack packs=()
        for pack in "$THX_ROOT"/frontend/vendor/*/; do
            [[ -d "$pack" ]] || continue
            pack="${pack%/}"
            packs+=("${pack##*/}")
        done
        if [[ ${#packs[@]} -gt 0 ]]; then
            E[vendor_packs]="$(printf '%s, ' "${packs[@]}")"
            E[vendor_packs]="${E[vendor_packs]%, }"
        fi
    fi
    return 0
}

free_megabytes() {
    # Free space where PATH lives (or will live): its nearest existing parent decides.
    local path="$SYS$1"
    while [[ ! -d "$path" && "$path" != "/" && "$path" == */* ]]; do
        path="${path%/*}"
        if [[ -z "$path" ]]; then path="/"; fi
    done
    probe df -Pm "$path" | awk 'NR == 2 { print $4 }'
}

detect_disk() {
    E[disk_opt_mb]="$(free_megabytes "$PREFIX")"
    E[disk_var_mb]="$(free_megabytes "$STATE_DIR")"
    return 0
}

detect_network() {
    local line address index=0 source
    while IFS= read -r line; do
        # 2: eth0    inet 192.168.1.20/24 brd 192.168.1.255 scope global dynamic eth0
        address="$(awk '{ for (i = 1; i < NF; i++) if ($i == "inet" || $i == "inet6") { print $(i + 1); exit } }' <<< "$line")"
        if [[ -n "$address" ]]; then
            E[lan_cidrs.$index]="$address"
            index=$((index + 1))
        fi
    done < <(probe ip -o addr show scope global)
    E[lan_cidrs.count]="$index"
    # The address this machine uses towards the world; no packet is sent to find it.
    source="$(probe ip -4 route get 203.0.113.1 | awk '{ for (i = 1; i < NF; i++) if ($i == "src") { print $(i + 1); exit } }')"
    if [[ -z "$source" && "$index" -gt 0 ]]; then
        source="${E[lan_cidrs.0]%%/*}"
    fi
    E[lan_address]="$source"
    E[network_ok]=0
    if [[ -n "$(probe getent hosts deb.debian.org)" ]]; then E[network_ok]=1; fi
    return 0
}

detect_ssh() {
    local port index=0 client=""
    while IFS= read -r port; do
        if [[ "$port" =~ ^[0-9]+$ ]]; then
            E[ssh_ports.$index]="$port"
            index=$((index + 1))
        fi
    done < <(probe sshd -T | awk '$1 == "port" && !seen[$2]++ { print $2 }')
    if [[ -n "${SSH_CONNECTION:-}" ]]; then
        # client-address client-port server-address server-port
        read -r client _ _ port <<< "$SSH_CONNECTION"
        if [[ "$index" -eq 0 && "$port" =~ ^[0-9]+$ ]]; then
            E[ssh_ports.0]="$port"
            index=1
        fi
    else
        # sudo drops SSH_CONNECTION; the terminal still knows where it was opened from.
        client="$(probe who am i | sed -n 's/.*(\([^)]*\)).*/\1/p' | head -n 1)"
    fi
    if [[ "$index" -eq 0 ]]; then
        E[ssh_ports.0]=22
        index=1
    fi
    E[ssh_ports.count]="$index"
    E[ssh_client]="$client"
    detect_ssh_peers
    return 0
}

detect_ssh_peers() {
    # Who is connected over SSH right now. Without a terminal under sudo (`ssh host 'sudo bash ...'`)
    # the session names no client at all - seen on a real Debian 13 - and the firewall must not shut
    # out the person running this: their address is among these.
    local receive send local_address peer port number host index=0 seen=" "
    # With a state filter ss leaves the state column out: Recv-Q Send-Q Local:Port Peer:Port.
    while read -r receive send local_address peer _; do
        : "$receive" "$send"
        number="${local_address##*:}"
        for port in $(list_items E ssh_ports); do
            [[ "$port" == "$number" ]] || continue
            host="${peer%:*}"
            host="${host#\[}"
            host="${host%\]}"
            host="${host#::ffff:}"
            if [[ -n "$host" && "$seen" != *" $host "* ]]; then
                seen="$seen$host "
                E[ssh_peers.$index]="$host"
                index=$((index + 1))
            fi
        done
    done < <(probe ss -H -tn state established)
    E[ssh_peers.count]="$index"
    return 0
}

port_owner() {
    # The program listening on TCP port $1: empty when the port is free, "?" when taken by something unnamed.
    local output pattern='users:\(\("([^"]+)"'
    output="$(probe ss -H -tlnp "sport = :$1")"
    if [[ -z "$output" ]]; then return 0; fi
    if [[ "$output" =~ $pattern ]]; then
        printf '%s' "${BASH_REMATCH[1]}"
    else
        printf '?'
    fi
}

detect_ports() {
    local port state receive send address rest index=0 seen=" " host number protocol
    E[port80_owner]="$(port_owner 80)"
    E[port443_owner]="$(port_owner 443)"
    # What else answers the network on this machine: switching a firewall on closes it. UDP too:
    # a WireGuard or a DNS server went unmentioned before ufw closed it (audit P3-2).
    for protocol in tcp udp; do
        while read -r state receive send address rest; do
            : "$state" "$receive" "$send" "$rest"
            number="${address##*:}"
            host="${address%:*}"
            [[ "$number" =~ ^[0-9]+$ ]] || continue
            case "$host" in
                127.*|"[::1]"|::1|"[::ffff:127."*) continue ;;
            esac
            if [[ "$protocol" == "udp" ]]; then
                # A DHCP client (dhclient on port 68 on a real Debian 13): ufw lets its replies in.
                case "$number" in
                    68|546) continue ;;
                esac
            fi
            if [[ "$protocol" == "tcp" ]]; then
                case "$number" in
                    80|443) continue ;;
                esac
                for port in $(list_items E ssh_ports); do
                    if [[ "$port" == "$number" ]]; then continue 2; fi
                done
            fi
            if [[ "$seen" != *" $number/$protocol "* ]]; then
                seen="$seen$number/$protocol "
                E[listeners.$index]="$number/$protocol"
                index=$((index + 1))
            fi
        done < <(if [[ "$protocol" == "tcp" ]]; then probe ss -H -tln; else probe ss -H -uln; fi)
    done
    E[listeners.count]="$index"
    return 0
}

free_service_port() {
    # The port of the transfer service: the usual one, or the next that nobody holds.
    local port
    for port in 8765 8766 8767 8768 8769 8770 8771 8772; do
        if [[ -z "$(port_owner "$port")" ]]; then
            printf '%s' "$port"
            return 0
        fi
    done
    printf '8765'
}

detect_firewall() {
    local status
    E[ufw_installed]=0
    E[ufw_active]=0
    E[ufw_open_443]=0
    if have ufw; then
        E[ufw_installed]=1
        # ufw is translated ("Stan: aktywny" on a Polish system); the question is put in the C
        # locale, or a firewall that is already on would be taken for one that is off - and widened.
        status="$(LC_ALL=C probe ufw status)"
        if grep -q '^Status: active' <<< "$status"; then E[ufw_active]=1; fi
        # A rule somebody else made that lets anybody reach 443 ("Apache Full", "443/tcp ALLOW
        # Anywhere"): the guide then must not say the VPS is the only one let in (audit P3-3).
        if grep -Eiq '^(443(/tcp)?|Apache Full|Apache Secure|WWW Full|WWW Secure)( \(v6\))?[[:space:]]+ALLOW( IN)?[[:space:]]+Anywhere' <<< "$status"; then
            E[ufw_open_443]=1
        fi
    fi
    E[foreign_firewall]=""
    if [[ "${E[ufw_active]}" -ne 1 ]]; then E[foreign_firewall]="$(other_firewall)"; fi
    E[fail2ban_active]=0
    if systemctl is-active --quiet fail2ban >/dev/null 2>&1; then E[fail2ban_active]=1; fi
    return 0
}

other_firewall() {
    # A firewall that already filters this machine while ufw is off: firewalld, or an nftables
    # rule set somebody wrote (seen on a real Debian 13 server: its own tables for the services it
    # runs). ufw on top of it would be a second "drop the rest" every packet must pass. Not counted:
    # fail2ban's table (it only bans) and Debian's stock nftables.conf - chains with no rule and no
    # drop policy filter nothing. Without root the rule set cannot be read, so an active nftables
    # service counts (only a dry run gets that far without root).
    local ruleset
    if systemctl is-active --quiet firewalld >/dev/null 2>&1; then
        printf 'firewalld'
        return 0
    fi
    have nft || return 0
    if [[ "${E[is_root]:-0}" != "1" ]]; then
        if systemctl is-active --quiet nftables >/dev/null 2>&1; then printf 'nftables'; fi
        return 0
    fi
    ruleset="$(nft list ruleset 2>/dev/null)" || ruleset=""
    if awk '
        /^table / { table = $3; next }
        table == "f2b-table" { next }
        /^\tchain / { chain = 1; next }
        /^\t}/ { chain = 0; next }
        chain && /policy drop/ { found = 1 }
        chain && /^\t\t/ && !/^\t\ttype / { found = 1 }
        END { exit found ? 0 : 1 }' <<< "$ruleset"; then
        printf 'nftables'
    fi
    return 0
}

detect_apache() {
    local file name index=0
    E[apache_installed]=0
    if have apache2ctl; then E[apache_installed]=1; fi
    E[default_site_enabled]=0
    if [[ -e "$SYS$SITES_ENABLED/000-default.conf" || -L "$SYS$SITES_ENABLED/000-default.conf" ]]; then
        E[default_site_enabled]=1
    fi
    # Other sites that answer on 443: behind a VPS ours must be the one Apache reads first. And on
    # 80: in D and C a site read before ours answers every request made by address (audit P3-19).
    local plain=0
    for file in "$SYS$SITES_ENABLED"/*.conf; do
        [[ -e "$file" ]] || continue
        name="$(basename -- "$file" .conf)"
        if [[ "$name" == "$HTTP_SITE" || "$name" == "$HTTPS_SITE" ]]; then continue; fi
        if grep -Eiq '^[[:space:]]*<VirtualHost[^>]*:443[[:space:]>]' "$file" 2>/dev/null; then
            E[https_sites.$index]="$name"
            index=$((index + 1))
        fi
        if [[ "$name" != "000-default" ]] && grep -Eiq '^[[:space:]]*<VirtualHost[^>]*:80[[:space:]>]' "$file" 2>/dev/null; then
            E[http_sites.$plain]="$name"
            plain=$((plain + 1))
        fi
    done
    E[https_sites.count]="$index"
    E[http_sites.count]="$plain"
    # An Apache that hands PHP to PHP-FPM (conf-enabled/php8.5-fpm.conf, no PHP module loaded) keeps
    # doing so: the bridge runs there too, and libapache2-mod-php would switch the server to prefork.
    E[php_fpm]=""
    if ! compgen -G "$SYS/etc/apache2/mods-enabled/php*.load" > /dev/null; then
        for file in "$SYS/etc/apache2/conf-enabled"/php*-fpm.conf; do
            [[ -e "$file" ]] || continue
            name="$(basename -- "$file" .conf)"
            name="${name#php}"
            name="${name%-fpm}"
            if [[ "$name" =~ ^[0-9]\.[0-9]{1,2}$ ]]; then E[php_fpm]="$name"; fi
        done
    fi
    return 0
}

detect_installation() {
    E[existing]=0
    E[has_release]=0
    E[has_state]=0
    E[service_active]=0
    if [[ -f "$SYS$CONFIG" ]]; then E[existing]=1; fi
    # The directory is root's and the service group's (0750): any other account sees that it is
    # there and nothing inside it. "Nothing is installed" would then be a wrong answer.
    E[unreadable]=0
    if [[ "${E[is_root]}" -ne 1 && -d "$SYS$CONFIG_DIR" && ! -r "$SYS$CONFIG_DIR" ]]; then E[unreadable]=1; fi
    if [[ -e "$SYS$CURRENT" || -L "$SYS$CURRENT" ]]; then E[has_release]=1; fi
    if [[ -f "$SYS$STATE_FILE" ]]; then E[has_state]=1; fi
    if [[ "$(probe systemctl is-active "$SERVICE")" == "active" ]]; then E[service_active]=1; fi
    DB_CLIENT=""
    if have mariadb; then DB_CLIENT="mariadb"; elif have mysql; then DB_CLIENT="mysql"; fi
    return 0
}

detect_machine() {
    detect_system
    detect_disk
    detect_network
    detect_ssh
    detect_ports
    detect_firewall
    detect_apache
    detect_installation
    return 0
}

# ---------------------------------------------------------------- the list a person sees

PREFLIGHT_ERRORS=0
PREFLIGHT_NEEDS_CONSENT=0

preflight_row() {
    # preflight_row ok|warn|error KEY [ARG...]
    local level="$1"
    shift
    case "$level" in
        ok) ok "$@" ;;
        warn) warn "$@" ;;
        error)
            fail "$@"
            PREFLIGHT_ERRORS=$((PREFLIGHT_ERRORS + 1)) ;;
    esac
    return 0
}

preflight() {
    # The checks that do not depend on any answer. Returns 1 when the installation cannot go on.
    local system="${E[os_name]:-${E[os_id]:-?}}" major minor
    PREFLIGHT_ERRORS=0
    PREFLIGHT_NEEDS_CONSENT=0
    emit ""
    say preflight.title

    if [[ "${E[os_id]}" == "debian" && "${E[os_version]}" == "13" ]]; then
        preflight_row ok preflight.os.ok "$system"
    elif [[ "${E[os_id]}" == "debian" || "${E[os_id]}" == "ubuntu" || " ${E[os_like]} " == *" debian "* ]]; then
        preflight_row warn preflight.os.other "$system"
        PREFLIGHT_NEEDS_CONSENT=1
    else
        preflight_row error preflight.os.unsupported "$system"
    fi

    if [[ "${E[is_root]}" -eq 1 ]]; then
        preflight_row ok preflight.root.ok
    elif [[ "$DRY_RUN" -eq 1 ]]; then
        preflight_row warn preflight.root.dry
    else
        preflight_row error preflight.root.missing
    fi

    if [[ "${E[systemd]}" -eq 1 ]]; then
        preflight_row ok preflight.systemd.ok
    else
        preflight_row error preflight.systemd.missing
    fi

    major="${E[python_version]%%.*}"
    minor="${E[python_version]#*.}"
    if [[ "$major" =~ ^[0-9]+$ && "$minor" =~ ^[0-9]+$ ]] && ((major > 3 || (major == 3 && minor >= 11))); then
        preflight_row ok preflight.python.ok "${E[python_version]}"
    else
        preflight_row error preflight.python.old "${E[python_version]:-?}"
    fi

    if [[ "${E[disk_opt_mb]}" =~ ^[0-9]+$ ]]; then
        if [[ "${E[disk_opt_mb]}" -lt 1500 ]]; then
            preflight_row error preflight.disk.low "$PREFIX" "${E[disk_opt_mb]}" 1500
        else
            preflight_row ok preflight.disk.ok "$PREFIX" "${E[disk_opt_mb]}"
        fi
    fi
    if [[ "${E[disk_var_mb]}" =~ ^[0-9]+$ && "${E[disk_var_mb]}" -lt 2000 ]]; then
        preflight_row warn preflight.disk.cache "$STATE_DIR" "${E[disk_var_mb]}"
    fi

    if [[ "${E[network_ok]}" -eq 1 ]]; then
        preflight_row ok preflight.network.ok
    else
        preflight_row warn preflight.network.missing
    fi

    if [[ "${E[has_build]}" -eq 1 ]]; then
        preflight_row ok preflight.build.ok
    else
        preflight_row warn preflight.build.missing
    fi

    if [[ -n "${E[lan_address]}" ]]; then
        preflight_row ok preflight.address "${E[lan_address]}"
    fi
    if [[ "$PREFLIGHT_ERRORS" -gt 0 ]]; then return 1; fi
    return 0
}

port_problems() {
    # The ports the chosen shape needs must be free or Apache's own. Prints one sentence per conflict.
    local mode="$1" port owner needed=()
    case "$mode" in
        # P serves on 443 only, but Debian's Apache listens on 80 too (ports.conf, the default
        # site): with 80 held by another program it does not start at all (audit P3-19).
        direct|vps) needed=(80 443) ;;
        lan|local) needed=(80) ;;
    esac
    for port in "${needed[@]}"; do
        if [[ "$port" == "80" ]]; then owner="${E[port80_owner]:-}"; else owner="${E[port443_owner]:-}"; fi
        if [[ -n "$owner" && "$owner" != "apache2" && "$owner" != "?" ]]; then
            t problem.port.taken "$port" "$owner"
            printf '\n'
        fi
    done
    return 0
}
