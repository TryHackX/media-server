#!/usr/bin/env bash
# One stand-in for every system command the Debian installer runs.
#
# There is no Debian on the machine this installer was written on, so its tests
# (tests/test_debian_installer.py) run it against these: the harness copies this
# file under each command's name into a directory at the front of PATH, and the
# stand-in behaves as that command would on a fresh Debian 13 - enough for the
# installer to take every branch - while writing down how it was called.
#
#   THX_STUB_LOG        every call is appended here: "name arg arg ..."
#   TRYHACKX_SYSROOT    the directory that stands for "/" (a2ensite and friends act inside it)
#   THX_STUB_*          switches for one scenario (see the cases below)
#
# Nothing here touches the real machine: no package is installed, no service is
# asked, no network is used.
set -u

name="$(basename -- "$0")"
root="${TRYHACKX_SYSROOT:-}"

if [[ -n "${THX_STUB_LOG:-}" ]]; then
    printf '%s' "$name" >> "$THX_STUB_LOG"
    for argument in "$@"; do printf ' %s' "$argument" >> "$THX_STUB_LOG"; done
    printf '\n' >> "$THX_STUB_LOG"
fi

listed() {
    # listed WORD LIST - whether WORD is one of the space-separated words of LIST.
    [[ " $2 " == *" $1 "* ]]
}

last_argument() {
    local value=""
    for value in "$@"; do :; done
    printf '%s' "$value"
}

case "$name" in
    apt-get|a2enmod|chown|chgrp|fail2ban-client|sleep|scp|python)
        exit 0 ;;

    dpkg-query)
        if listed "$(last_argument "$@")" "${THX_STUB_INSTALLED:-}"; then
            printf 'install ok installed'
            exit 0
        fi
        exit 1 ;;

    systemctl)
        if [[ "${1:-}" == "is-active" ]]; then
            shift
            unit="$(last_argument "$@")"
            if listed "${unit%.service}" "${THX_STUB_ACTIVE:-apache2 mariadb}"; then
                printf 'active\n'
                exit 0
            fi
            printf 'inactive\n'
            exit 3
        fi
        exit 0 ;;

    a2query)
        if [[ "$*" == *"-m"* && $# -ge 2 && "$(last_argument "$@")" != "-m" ]]; then
            listed "$(last_argument "$@")" "${THX_STUB_MODULES:-alias authz_core authz_host dir env mime}"
            exit $?
        fi
        # An Apache without the PHP module (PHP-FPM, or somebody switched it off) lists none.
        if [[ "${THX_STUB_NO_PHP_MODULE:-0}" != "1" ]]; then printf 'php8.4 (enabled by maintainer script)\n'; fi
        exit 0 ;;

    a2ensite|a2dissite)
        site="$(last_argument "$@")"
        if [[ -n "$root" ]]; then
            mkdir -p "$root/etc/apache2/sites-enabled"
            if [[ "$name" == "a2ensite" ]]; then
                : > "$root/etc/apache2/sites-enabled/$site.conf"
            else
                rm -f "$root/etc/apache2/sites-enabled/$site.conf"
            fi
        fi
        exit 0 ;;

    a2enconf|a2disconf)
        conf="$(last_argument "$@")"
        if [[ -n "$root" ]]; then
            mkdir -p "$root/etc/apache2/conf-enabled"
            if [[ "$name" == "a2enconf" ]]; then
                : > "$root/etc/apache2/conf-enabled/$conf.conf"
            else
                rm -f "$root/etc/apache2/conf-enabled/$conf.conf"
            fi
        fi
        exit 0 ;;

    apache2ctl)
        if [[ "${THX_STUB_CONFIGTEST:-0}" != "0" ]]; then
            printf 'AH00526: Syntax error on line 12 of /etc/apache2/sites-enabled/tryhackx-media-ssl.conf:\n' >&2
            printf 'SSLCertificateFile: file does not exist or is empty\n' >&2
            exit 1
        fi
        printf 'Syntax OK\n' >&2
        exit 0 ;;

    ufw)
        if [[ "${1:-}" == "status" ]]; then
            # The real ufw is translated: only in the C locale is its answer the English one.
            if [[ "${LC_ALL:-}" == "C" ]]; then
                printf 'Status: %s\n' "${THX_STUB_UFW:-inactive}"
                if [[ -n "${THX_STUB_UFW_RULES:-}" ]]; then printf '\nTo                         Action      From\n%s\n' "$THX_STUB_UFW_RULES"; fi
            elif [[ "${THX_STUB_UFW:-inactive}" == "active" ]]; then
                printf 'Stan: aktywny\n'
            else
                printf 'Stan: nieaktywny\n'
            fi
        fi
        exit 0 ;;

    nft)
        # The rule set, as `nft list ruleset` prints it (tabs and all); nothing when none is loaded.
        if [[ "$*" == "list ruleset" && -n "${THX_STUB_NFT_RULESET:-}" ]]; then
            printf '%s\n' "$THX_STUB_NFT_RULESET"
        fi
        exit 0 ;;

    mariadb-dump)
        # A copy of the database before migrations: some SQL on standard output, or a failure on request.
        printf -- '-- stand-in dump of %s\n' "${!#}"
        exit "${THX_STUB_DUMP_FAILS:-0}" ;;

    mariadb|mysql)
        query=""
        while [[ $# -gt 0 ]]; do
            if [[ "$1" == "-e" ]]; then query="${2:-}"; fi
            shift
        done
        if [[ -z "$query" ]]; then
            # Statements on standard input: read them all, as the client would.
            cat > /dev/null
            exit "${THX_STUB_DB_FAILS:-0}"
        fi
        case "$query" in
            *schemata*) printf '%s\n' "${THX_STUB_DB_EXISTS:-0}" ;;
            *tables*) printf '%s\n' "${THX_STUB_DB_TABLES:-0}" ;;
            *".users WHERE username"*) printf '%s\n' "${THX_STUB_DB_USERS:-0}" ;;
        esac
        exit 0 ;;

    certbot)
        exit "${THX_STUB_CERTBOT:-0}" ;;

    runuser)
        # runuser -u USER -- COMMAND...: the command is not run; what would read standard input reads it.
        if [[ "$*" == *"--password-stdin"* ]]; then cat > /dev/null; fi
        if [[ "$*" == *"roots list"* ]]; then exit 1; fi
        exit "${THX_STUB_RUNUSER:-0}" ;;

    curl)
        url="$(last_argument "$@")"
        code="${THX_STUB_HTTP:-200}"
        case "$url" in
            *"/media-transfer/health/ready") code="${THX_STUB_HTTP_INTERNAL:-403}" ;;
        esac
        if [[ "$*" == *"http_code"* ]]; then
            # THX_STUB_HTTP_QUEUE: a file of status codes, one used up by each request -
            # for "it worked before the change and does not after it".
            queue="${THX_STUB_HTTP_QUEUE:-}"
            if [[ -n "$queue" && -s "$queue" ]]; then
                IFS= read -r code < "$queue"
                tail -n +2 "$queue" > "$queue.rest"
                mv "$queue.rest" "$queue"
            fi
            printf '%s' "$code"
            exit 0
        fi
        if [[ "$url" == *"/health/ready" && "${THX_STUB_HEALTH:-0}" != "0" ]]; then exit 22; fi
        printf 'ready\n'
        exit 0 ;;

    ss)
        if [[ "$*" == *"sport = :80"* ]]; then
            if [[ -n "${THX_STUB_PORT80:-}" ]]; then
                printf 'LISTEN 0 511 *:80 *:* users:(("%s",pid=812,fd=4))\n' "$THX_STUB_PORT80"
            fi
        elif [[ "$*" == *"sport = :443"* ]]; then
            if [[ -n "${THX_STUB_PORT443:-}" ]]; then
                printf 'LISTEN 0 511 *:443 *:* users:(("%s",pid=812,fd=6))\n' "$THX_STUB_PORT443"
            fi
        elif [[ "$*" == *"sport = :"* ]]; then
            :
        elif [[ "$*" == *"-uln"* ]]; then
            for port in ${THX_STUB_UDP_LISTENERS:-}; do
                printf 'UNCONN 0 0 0.0.0.0:%s 0.0.0.0:*\n' "$port"
            done
        elif [[ "$*" == *"state established"* ]]; then
            # Who is connected now: "address:port" pairs, as ss prints them without the state column.
            for peer in ${THX_STUB_SSH_PEERS:-}; do
                printf '0 0 192.168.1.20:22 %s\n' "$peer"
            done
        else
            printf 'LISTEN 0 128 0.0.0.0:22 0.0.0.0:*\n'
            printf 'LISTEN 0 80 127.0.0.1:3306 0.0.0.0:*\n'
            for port in ${THX_STUB_LISTENERS:-}; do
                printf 'LISTEN 0 50 0.0.0.0:%s 0.0.0.0:*\n' "$port"
            done
        fi
        exit 0 ;;

    ip)
        if [[ "$*" == *"route get"* ]]; then
            printf '203.0.113.1 via 192.168.1.1 dev eth0 src 192.168.1.20 uid 0\n'
        else
            printf '2: eth0    inet 192.168.1.20/24 brd 192.168.1.255 scope global dynamic eth0\\       valid_lft 86000sec preferred_lft 86000sec\n'
        fi
        exit 0 ;;

    df)
        printf 'Filesystem 1048576-blocks Used Available Capacity Mounted on\n'
        printf '/dev/sda1 100000 20000 %s 21%% /\n' "${THX_STUB_FREE_MB:-80000}"
        exit 0 ;;

    getent)
        if [[ "${THX_STUB_OFFLINE:-0}" != "0" ]]; then exit 2; fi
        printf '203.0.113.80 %s\n' "$(last_argument "$@")"
        exit 0 ;;

    hostname)
        printf '%s \n' "${THX_STUB_ADDRESSES:-203.0.113.80}"
        exit 0 ;;

    sshd)
        printf 'port %s\n' "${THX_STUB_SSH_PORT:-22}"
        exit 0 ;;

    who)
        # No terminal (`ssh host 'sudo bash ...'`): `who am i` has nothing to say.
        if [[ "${THX_STUB_NO_TTY:-0}" == "1" ]]; then exit 0; fi
        printf 'jan      pts/0        2026-11-12 22:10 (%s)\n' "${THX_STUB_SSH_CLIENT:-192.168.1.5}"
        exit 0 ;;

    php)
        if [[ "$*" == *"PHP_MAJOR_VERSION"* ]]; then printf '8.4'; fi
        if [[ "$*" == *"extension_loaded"* ]]; then printf '%s' "${THX_STUB_PHP_MISSING:-}"; fi
        exit 0 ;;

    ssh-keyscan)
        if [[ "${THX_STUB_VPS_DOWN:-0}" != "0" ]]; then exit 1; fi
        printf '%s ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIStandInKeyOfTheVpsForTestsOnly0000000000000\n' "$(last_argument "$@")"
        exit 0 ;;

    ssh-keygen)
        if [[ "${1:-}" == "-F" ]]; then exit 1; fi
        printf '256 SHA256:StandInFingerprintOfTheVpsForTestsOnly00000 %s (ED25519)\n' "host"
        exit 0 ;;

    ssh)
        exit "${THX_STUB_SSH:-0}" ;;

    whiptail)
        # Answers come from a file, one per dialog: a line of text, or <yes> / <no> / <cancel>.
        if [[ "$*" == *"--msgbox"* ]]; then exit 0; fi
        answers="${THX_STUB_WHIPTAIL:-}"
        if [[ -z "$answers" || ! -s "$answers" ]]; then exit 1; fi
        IFS= read -r reply < "$answers"
        tail -n +2 "$answers" > "$answers.rest"
        mv "$answers.rest" "$answers"
        case "$reply" in
            "<yes>") exit 0 ;;
            "<no>"|"<cancel>") exit 1 ;;
        esac
        printf '%s' "$reply" >&2
        exit 0 ;;
esac

printf 'system-command.sh: no stand-in for "%s"\n' "$name" >&2
exit 127
