# shellcheck shell=bash
# TryHackX Media Server - instalator dla Debiana: kroki.
#
# One function per step. A step reads the answers (A), what the machine looked
# like (E), the plan the helper worked out (P) and what an earlier run recorded
# (ST); it changes the machine only through run / install_file / remove_file, so
# a dry run walks the same lines and writes nothing.
#
# Every step can be run again: nothing here assumes it is the first attempt.
#
# Kept pure ASCII: translated text lives in installer/debian/lang/*.sh.

# What this run did, for the state file.
NEW_FILES=()
MODULES_ENABLED_NOW=()
PACKAGES_INSTALLED_NOW=()
SITES_DISABLED_NOW=()
APACHE_NEEDS_RESTART=0
FIREWALL_ENABLED_NOW=0
DATABASE_CREATED_NOW=0
ADMIN_CREATED_NOW=""
BUNDLE_WRITTEN=0
CERTIFICATE_FINGERPRINT=""

FIREWALL_CHANGED=0
FAILURE_HOOK=""

service_port() {
    printf '%s' "${A[options.service_port]:-8765}"
}

state_put() {
    # state_put KEY VALUE [KEY VALUE...] - note something in the state file right away,
    # so that a run which fails later still knows (and an uninstall can still find) it.
    if [[ "$DRY_RUN" -eq 1 ]]; then return 0; fi
    req_new
    req state_file "$SYS$STATE_FILE"
    while [[ $# -ge 2 ]]; do
        req "update.$1" "$2"
        shift 2
    done
    ask_helper debian-state
    chown root:root "$SYS$STATE_FILE"
    chmod 0600 "$SYS$STATE_FILE"
    return 0
}

as_service() {
    # A command of the application, run as the account the service runs as, from a
    # directory that account can stand in.
    (
        cd "$SYS/" 2>/dev/null || cd /
        run runuser -u "$SERVICE_USER" -- "$@"
    )
}

db_root() {
    # The database client as the system's root, over the local socket: on Debian that is
    # how MariaDB's root signs in, and no password is involved anywhere.
    "$DB_CLIENT" --protocol=socket --batch --skip-column-names "$@"
}

step_database_backup() {
    # Before anything migrates: the whole database, dumped by root over the socket (no password)
    # into $BACKUP_ROOT/database, 0600, the newest five kept. A migration that goes wrong is then a
    # restore, not a loss - MariaDB's schema changes cannot be undone (audit P2-7).
    local name="${A[database.name]:-}" folder="$BACKUP_ROOT/database" file tool="mariadb-dump" status
    step step.dbBackup
    [[ "$name" =~ ^[A-Za-z0-9_]{1,64}$ ]] || die_t error.dbBackup "$name"
    if ! have mariadb-dump && have mysqldump; then tool="mysqldump"; fi
    file="$folder/$name-$(date +%Y%m%d-%H%M%S).sql.gz"
    if [[ "$DRY_RUN" -eq 1 ]]; then
        emit "    (dry-run) $tool --protocol=socket --single-transaction --quick --hex-blob --default-character-set=utf8mb4 $name | gzip > $file"
        return 0
    fi
    make_dir "$folder" 0700 root:root
    emit "    \$ $tool --protocol=socket --single-transaction --quick --hex-blob --default-character-set=utf8mb4 $name | gzip > $file"
    set +e
    (umask 077; "$tool" --protocol=socket --single-transaction --quick --hex-blob --default-character-set=utf8mb4 "$name" | gzip -c > "$SYS$file")
    status=$?
    set -e
    if [[ "$status" -ne 0 ]]; then
        # Half a dump looks like a backup and is not one.
        rm -f "$SYS$file"
        die_t error.dbBackup "$name"
    fi
    chmod 0600 "$SYS$file"
    find "$SYS$folder" -maxdepth 1 -name "$name-*.sql.gz" -type f -printf '%T@ %p\n' 2>/dev/null \
        | sort -rn | tail -n +6 | cut -d' ' -f2- | while IFS= read -r old; do rm -f -- "$old"; done
    ok log.dbBackup "$file"
}

db_count() {
    # db_count SQL - a single number, or empty when the server did not answer.
    local value
    value="$(db_root -e "$1" 2>/dev/null | head -n 1)" || true
    value="${value%$'\r'}"
    if [[ "$value" =~ ^[0-9]+$ ]]; then printf '%s' "$value"; fi
    return 0
}

# ---------------------------------------------------------------- packages

step_packages() {
    local package missing=() status
    step step.packages
    for package in $(list_items P packages); do
        # shellcheck disable=SC2016  # ${Status} is dpkg-query's own placeholder, not a shell variable
        status="$(probe dpkg-query -W -f='${Status}' "$package")"
        if [[ "$status" != *"install ok installed"* ]]; then missing+=("$package"); fi
    done
    if [[ "${#missing[@]}" -eq 0 ]]; then
        ok log.packages.present
    else
        note log.packages.missing "${missing[*]}"
        run env DEBIAN_FRONTEND=noninteractive apt-get update || die_t error.apt.update
        run env DEBIAN_FRONTEND=noninteractive apt-get install -y "${missing[@]}" || die_t error.apt.install
        PACKAGES_INSTALLED_NOW+=("${missing[@]}")
        if [[ -n "${P[php_fpm]:-}" && " ${missing[*]} " == *" php${P[php_fpm]}-"* ]]; then
            # PHP-FPM reads its extensions when it starts: the bridge's new ones only after a reload.
            run systemctl reload "php${P[php_fpm]}-fpm" || warn log.php.fpmReload "php${P[php_fpm]}-fpm"
        fi
    fi
    run systemctl enable --now mariadb || die_t error.service.start mariadb
    run systemctl enable --now apache2 || die_t error.service.start apache2
    if [[ "$DRY_RUN" -eq 1 ]]; then return 0; fi
    DB_CLIENT=""
    if have mariadb; then DB_CLIENT="mariadb"; elif have mysql; then DB_CLIENT="mysql"; fi
    [[ -n "$DB_CLIENT" ]] || die_t error.db.noClient
    check_php
}

step_build_tools() {
    # An update from a clone builds the interface in the new release: Node.js and npm from Debian,
    # unless both are there already (NodeSource's nodejs carries its own npm and conflicts with Debian's).
    local package missing=() status
    step step.buildTools
    if [[ "${E[has_node]:-0}" -eq 1 ]]; then
        ok log.packages.present
        return 0
    fi
    for package in nodejs npm; do
        # shellcheck disable=SC2016  # ${Status} is dpkg-query's own placeholder, not a shell variable
        status="$(probe dpkg-query -W -f='${Status}' "$package")"
        if [[ "$status" != *"install ok installed"* ]]; then missing+=("$package"); fi
    done
    if [[ "${#missing[@]}" -eq 0 ]]; then
        ok log.packages.present
        return 0
    fi
    note log.packages.missing "${missing[*]}"
    run env DEBIAN_FRONTEND=noninteractive apt-get update || die_t error.apt.update
    run env DEBIAN_FRONTEND=noninteractive apt-get install -y "${missing[@]}" || die_t error.apt.install
    PACKAGES_INSTALLED_NOW+=("${missing[@]}")
    return 0
}

check_php() {
    # The bridge needs these five; `php -l` passes without them and the first request does not.
    local report missing binary="php"
    # Behind PHP-FPM the bridge runs in that PHP version, whichever one /usr/bin/php points at.
    if [[ -n "${P[php_fpm]:-}" ]] && have "php${P[php_fpm]}"; then binary="php${P[php_fpm]}"; fi
    # shellcheck disable=SC2016  # the dollar signs belong to PHP
    report="$(probe "$binary" -r 'foreach (["pdo_mysql","mbstring","curl","simplexml","openssl"] as $e) { if (!extension_loaded($e)) { echo $e, " "; } }')"
    missing="${report%$'\r'}"
    if [[ -n "${missing// /}" ]]; then
        die_t error.php.extensions "$missing"
    fi
    ok log.php.extensions
    return 0
}

step_modules() {
    local module version
    step step.modules
    for module in $(list_items P modules); do
        if a2query -q -m "$module" >/dev/null 2>&1; then
            continue
        fi
        run a2enmod -q "$module" || die_t error.apache.module "$module"
        MODULES_ENABLED_NOW+=("$module")
        APACHE_NEEDS_RESTART=1
    done
    # libapache2-mod-php enables its own module when installed; a machine where somebody
    # switched it off would serve the bridge's source instead of running it. An Apache that
    # hands PHP to PHP-FPM has no PHP module on purpose (its proxy_fcgi is in the plan's modules).
    if [[ "$DRY_RUN" -eq 0 && -z "${P[php_fpm]:-}" ]] && ! probe a2query -m | grep -q '^php'; then
        version="$(probe php -r 'echo PHP_MAJOR_VERSION, ".", PHP_MINOR_VERSION;')"
        version="${version%$'\r'}"
        if [[ -n "$version" ]]; then
            run a2enmod -q "php$version" || die_t error.apache.module "php$version"
            MODULES_ENABLED_NOW+=("php$version")
            APACHE_NEEDS_RESTART=1
        fi
    fi
    if [[ "${#MODULES_ENABLED_NOW[@]}" -eq 0 ]]; then ok log.modules.present; fi
    return 0
}

# ---------------------------------------------------------------- configuration

assign_root_ids() {
    # Readable identifiers for new folders; a folder that is already known keeps its own.
    local count position
    req_new
    req case_sensitive 1
    count="${A[folders.count]:-0}"
    req folders.count "$count"
    for ((position = 0; position < count; position++)); do
        req "folders.$position.path" "${A[folders.$position.path]}"
        req "folders.$position.kind" "${A[folders.$position.kind]}"
        req "folders.$position.id" "${A[folders.$position.id]:-}"
    done
    count="${EXISTING_ROOTS[count]:-0}"
    req existing.count "$count"
    for ((position = 0; position < count; position++)); do
        req "existing.$position.id" "${EXISTING_ROOTS[$position.id]}"
        req "existing.$position.path" "${EXISTING_ROOTS[$position.path]}"
    done
    # Identifiers of libraries removed in earlier runs stay in the catalogue (switched off). When the
    # service could not list them (load_kinds), or this is an installation over a kept database, root
    # asks the database itself - the protection must not switch off without a word (audit P3-10).
    if [[ ${#CATALOG_IDS[@]} -eq 0 && "$DRY_RUN" -eq 0 && -n "${DB_CLIENT:-}" && "${A[database.name]:-}" =~ ^[A-Za-z0-9_]{1,64}$ ]] \
        && [[ "$(db_count "SELECT COUNT(*) FROM information_schema.schemata WHERE schema_name = '${A[database.name]}'")" == "1" ]]; then
        local listed slug
        if listed="$(db_root -e "SELECT slug FROM \`${A[database.name]}\`.media_roots" 2>/dev/null)"; then
            while IFS= read -r slug; do
                slug="${slug%$'\r'}"
                if [[ "$slug" =~ ^[A-Za-z0-9_-]{1,32}$ ]]; then CATALOG_IDS+=("$slug"); fi
            done <<< "$listed"
        else
            warn log.roots.catalogUnknown
        fi
    fi
    req reserved.count "${#CATALOG_IDS[@]}"
    for ((position = 0; position < ${#CATALOG_IDS[@]}; position++)); do
        req "reserved.$position" "${CATALOG_IDS[$position]}"
    done
    ask_helper assign-ids
    count="${R[roots.count]:-0}"
    for ((position = 0; position < count; position++)); do
        A[folders.$position.id]="${R[roots.$position.id]}"
    done
    return 0
}

step_config() {
    local arguments position count password status
    step step.config
    make_dir "$CONFIG_DIR" 0750 "root:$SERVICE_GROUP"
    if [[ -f "$SYS$CONFIG" ]]; then
        # An earlier attempt got this far. Its file holds the database password the
        # accounts were (or will be) made with, so it stays; the folders are brought
        # in line with the answers given now.
        ok log.config.kept "$CONFIG"
        apply_roots_config
    else
        # -B: no __pycache__ left by root in the unpacked package (seen on a real Debian 13: the user
        # could not delete the folder afterwards without sudo).
        arguments=(-B "$INSTALL_PY" --config-only --non-interactive --config "$SYS$CONFIG" --port "$(service_port)"
            --db-name "${A[database.name]}" --db-user "${A[database.user]}" --ffmpeg-path ffmpeg)
        count="${A[folders.count]:-0}"
        for ((position = 0; position < count; position++)); do
            arguments+=(--root "${A[folders.$position.id]}=${A[folders.$position.path]}")
        done
        if [[ -n "${P[config.base_url]:-}" ]]; then arguments+=(--base-url "${P[config.base_url]}"); fi
        if [[ -n "${P[config.proxy_trusted]:-}" ]]; then arguments+=(--proxy-trusted "${P[config.proxy_trusted]}"); fi
        if [[ "$DRY_RUN" -eq 1 ]]; then
            emit "    (dry-run) MEDIA_SERVER_DB_PASSWORD=******** $(quote_command "$PYTHON" "${arguments[@]}")"
        else
            # The password of the application's database account: made here, handed to
            # install.py in its environment (never on a command line), written by it into
            # the private configuration - and kept nowhere else.
            req_new
            ask_helper debian-password
            password="${R[password]}"
            add_secret "$password"
            emit "    \$ MEDIA_SERVER_DB_PASSWORD=******** $(quote_command "$PYTHON" "${arguments[@]}")"
            local runtime_was=0
            if [[ -e "$THX_ROOT/runtime" ]]; then runtime_was=1; fi
            set +e
            MEDIA_SERVER_DB_PASSWORD="$password" PYTHONIOENCODING=utf-8 "$PYTHON" "${arguments[@]}" 2>&1 | log_stream
            status=${PIPESTATUS[0]}
            set -e
            password=""
            # install.py makes its default cache folders next to itself - here, in the unpacked
            # package, owned by root, which the person then cannot delete. The service keeps its
            # caches in its own release; the empty folders made just now go (audit P3-15).
            if [[ "$runtime_was" -eq 0 && -d "$THX_ROOT/runtime" ]]; then
                rmdir "$THX_ROOT/runtime/thumbnails" "$THX_ROOT/runtime/subtitles" "$THX_ROOT/runtime" 2>/dev/null || true
            fi
            [[ "$status" -eq 0 && -f "$SYS$CONFIG" ]] || die_t error.config.create "$CONFIG"
        fi
    fi
    # install.py writes the file for root alone; the service and the bridge run as www-data.
    run chown "root:$SERVICE_GROUP" "$SYS$CONFIG" || die_t error.config.owner "$CONFIG"
    run chmod 0640 "$SYS$CONFIG" || die_t error.config.owner "$CONFIG"
    # From here on a failed run is an unfinished installation, and says so to the next run.
    state_put install_completed 0
    apply_access_config
    refresh_migrate_config
}

apply_access_config() {
    # The three keys the bridge reads about how it is reached. Everything else in the
    # file - including what its owner added by hand - stays exactly as it was.
    if [[ ! -f "$SYS$CONFIG" ]]; then
        emit "    (dry-run) config.local.toml: [app] base_url=${P[config.base_url]:-/} [proxy] trusted=${P[config.proxy_trusted]:--} [session] require_https=${P[config.require_https]:-1}"
        return 0
    fi
    req_new
    req config "$SYS$CONFIG"
    req project_root "$THX_ROOT"
    req base_url "${P[config.base_url]:-}"
    req proxy_trusted "${P[config.proxy_trusted]:-}"
    req require_https "${P[config.require_https]:-1}"
    req dry_run "$DRY_RUN"
    ask_helper config-access
    report_config_change
}

report_config_change() {
    local change
    if [[ "${R[changed]:-0}" != "1" ]]; then
        ok log.config.unchanged
        return 0
    fi
    while IFS= read -r change; do
        if [[ "$DRY_RUN" -eq 1 ]]; then emit "    (dry-run) config.local.toml: $change"; else emit "    config.local.toml: $change"; fi
    done < <(list_items R changes)
    if [[ -n "${R[backup]:-}" ]]; then note log.config.backup "${R[backup]}"; fi
    return 0
}

refresh_migrate_config() {
    # The same configuration with the account that may change the schema, for root alone.
    if [[ ! -f "$SYS$CONFIG" ]]; then
        emit "    (dry-run) $(t log.file.write "$MIGRATE_CONFIG" 0600 root:root)"
        return 0
    fi
    req_new
    req config "$SYS$CONFIG"
    req output "$SYS$MIGRATE_CONFIG"
    req dry_run "$DRY_RUN"
    ask_helper debian-migrate-config
    MIGRATE_PASSWORD_FRESH="${R[fresh_password]:-0}"
    if [[ "${R[changed]:-0}" == "1" ]]; then
        if [[ "$DRY_RUN" -eq 1 ]]; then
            emit "    (dry-run) $(t log.file.write "$MIGRATE_CONFIG" 0600 root:root)"
        else
            emit "    \$ $(t log.file.write "$MIGRATE_CONFIG" 0600 root:root)"
            chown root:root "$SYS$MIGRATE_CONFIG"
            NEW_FILES+=("$MIGRATE_CONFIG")
        fi
    fi
    return 0
}

step_config_roots() {
    step step.configRoots
    apply_roots_config
    refresh_migrate_config
    ensure_migration_account
}

apply_roots_config() {
    # The [roots.*] tables become exactly the folders of the answers; nothing else in the file moves.
    local position count
    req_new
    req config "$SYS$CONFIG"
    req project_root "$THX_ROOT"
    req dry_run "$DRY_RUN"
    count="${A[folders.count]:-0}"
    req roots.count "$count"
    for ((position = 0; position < count; position++)); do
        req "roots.$position.id" "${A[folders.$position.id]}"
        req "roots.$position.path" "${A[folders.$position.path]}"
    done
    ask_helper config-roots
    report_config_change
}

step_config_access() {
    step step.configAccess
    if [[ "$DRY_RUN" -eq 0 && -f "$SYS$CONFIG" ]]; then
        # Kept until the new shape stands: see access_rollback.
        cp -p "$SYS$CONFIG" "$WORK_DIR/config-before.toml"
    fi
    apply_access_config
    refresh_migrate_config
    ensure_migration_account
}

# ---------------------------------------------------------------- database

step_database() {
    step step.database
    refresh_database_accounts "${A[database.name]}"
    MIGRATE_PASSWORD_FRESH=0
}

ensure_migration_account() {
    # An installation set up by hand has no schema account yet: the first time the
    # installer writes the migration configuration, the account has to be made to match.
    if [[ "${MIGRATE_PASSWORD_FRESH:-0}" == "1" && -f "$SYS$MIGRATE_CONFIG" ]]; then
        refresh_database_accounts "${A[database.name]}"
        MIGRATE_PASSWORD_FRESH=0
    fi
    return 0
}

refresh_database_accounts() {
    local name="$1" existed tables status pattern='^[A-Za-z0-9_]{1,64}$'
    # The name goes into two statements as it stands; an installation made by hand may
    # have called its database anything.
    [[ "$name" =~ $pattern ]] || die_t problem.answers.db_name "$name"
    if [[ "$DRY_RUN" -eq 1 ]]; then
        emit "    (dry-run) ${DB_CLIENT:-mariadb} --protocol=socket   <<< $(t log.db.statements "$name" "${A[database.user]}" "${P[migrate_user]:-}")"
        return 0
    fi
    existed="$(db_count "SELECT COUNT(*) FROM information_schema.schemata WHERE schema_name = '$name'")"
    [[ -n "$existed" ]] || die_t error.db.socket
    tables="$(db_count "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = '$name'")"
    if [[ "$existed" == "0" ]]; then
        DATABASE_CREATED_NOW=1
        state_put database.name "$name" database.user "${A[database.user]}" database.created_by_installer 1
    elif [[ "${tables:-0}" != "0" ]]; then
        note log.db.existing "$name" "$tables"
    fi
    req_new
    req config "$SYS$CONFIG"
    req migrate_config "$SYS$MIGRATE_CONFIG"
    req output "$WORK_DIR/accounts.sql"
    req action create
    ask_helper debian-sql
    emit "    \$ $DB_CLIENT --protocol=socket   <<< $(t log.db.statements "${R[database]}" "${R[user]}" "${R[ddl_user]}")"
    set +e
    db_root < "$WORK_DIR/accounts.sql" 2>&1 | log_stream
    status=${PIPESTATUS[0]}
    set -e
    rm -f "$WORK_DIR/accounts.sql"
    [[ "$status" -eq 0 ]] || die_t error.db.create
    ok log.db.ready "$name"
    return 0
}

run_migrations() {
    # Migrations on the active release, as the schema account. Used after an update of the
    # files that did not go through a new release.
    step step.migrate
    run "$SYS$VENV_PYTHON" -m media_server --config "$SYS$MIGRATE_CONFIG" migrate || die_t error.migrate
}

# ---------------------------------------------------------------- the release

step_release() {
    local arguments=(--source "$THX_ROOT" --migrate --migrate-config "$SYS$MIGRATE_CONFIG")
    step step.release
    if [[ -n "$SYS" ]]; then
        arguments+=(--prefix "$SYS$PREFIX" --config "$SYS$CONFIG" --state-dir "$SYS$STATE_DIR" --log-dir "$SYS$LOG_DIR")
    fi
    if [[ "${P[build_frontend]:-0}" == "1" ]]; then arguments+=(--build-frontend); fi
    if [[ ! -f "$SYS$SYSTEMD_DIR/$SERVICE.service" ]]; then
        # No unit yet, so nothing to restart and nothing to ask whether it is healthy.
        arguments+=(--no-service --no-health)
    fi
    run bash "$RELEASE_SCRIPT" "${arguments[@]}" || die_t error.release
}

step_units() {
    local unit
    step step.units
    for unit in "${UNITS[@]}"; do
        req_new
        req source "$THX_ROOT/deploy/systemd/$unit"
        req output "$WORK_DIR/units/$unit"
        ask_helper debian-mark
        install_file "$WORK_DIR/units/$unit" "$SYSTEMD_DIR/$unit" 0644
    done
    run systemctl daemon-reload || die_t error.systemd
    run systemctl enable "$SERVICE.service" || die_t error.systemd
    run systemctl restart "$SERVICE.service" || die_t error.service.start "$SERVICE"
    wait_for_service || die_t error.service.health "$(service_port)" "$SERVICE"
}

restart_service() {
    step step.restart
    run systemctl restart "$SERVICE.service" || die_t error.service.start "$SERVICE"
    wait_for_service || die_t error.service.health "$(service_port)" "$SERVICE"
}

wait_for_service() {
    # health/ready answers only when the configured folders are really readable for the
    # service - which is what a folder under /home fails at, with a unit that looks "active".
    local url deadline body
    url="http://127.0.0.1:$(service_port)/health/ready"
    if [[ "$DRY_RUN" -eq 1 ]]; then
        emit "    (dry-run) curl --fail $url"
        return 0
    fi
    deadline=$((SECONDS + 60))
    while true; do
        if curl --fail --silent --max-time 5 "$url" >/dev/null 2>&1; then
            ok log.service.ready "$url"
            return 0
        fi
        if [[ "$SECONDS" -ge "$deadline" ]]; then break; fi
        sleep 1
    done
    body="$(curl --silent --max-time 5 "$url" 2>/dev/null)" || true
    if [[ -n "$body" ]]; then emit "      $body"; fi
    return 1
}

# ---------------------------------------------------------------- folders and the first account

step_roots() {
    local arguments position count
    step step.roots
    arguments=("$VENV_PYTHON" -m media_server --config "$CONFIG" roots sync --disable-unconfigured)
    count="${A[folders.count]:-0}"
    for ((position = 0; position < count; position++)); do
        arguments+=(--kind "${A[folders.$position.id]}=${A[folders.$position.kind]}")
    done
    as_service "${arguments[@]}" || die_t error.roots
}

step_admin() {
    local username="${A[admin.username]}" arguments status
    step step.admin
    if [[ -n "$username" && "${ST[admin]:-}" == "$username" && "$FLOW" == "install" ]]; then
        ok log.admin.exists "$username"
        return 0
    fi
    # An installation over a kept database (after an uninstall that kept it), or an account made by a
    # run that stopped before recording it: the account is there, and stays with its own password -
    # a second account-create only stopped every resume at "name taken" (audit P2-8, P3-20).
    if [[ "$DRY_RUN" -eq 0 && "$FLOW" == "install" && "$username" =~ ^[A-Za-z0-9._-]{3,32}$
          && "${A[database.name]:-}" =~ ^[A-Za-z0-9_]{1,64}$ ]]; then
        local taken
        taken="$(db_count "SELECT COUNT(*) FROM \`${A[database.name]}\`.users WHERE username = '$username'")"
        if [[ "${taken:-0}" -gt 0 ]]; then
            warn log.admin.kept "$username"
            state_put admin "$username"
            return 0
        fi
    fi
    arguments=(runuser -u "$SERVICE_USER" -- "$VENV_PYTHON" -m media_server --config "$CONFIG" account-create
        --username "$username" --role "${A[admin.role]:-super_admin}" --password-stdin)
    if [[ -n "${A[admin.email]:-}" ]]; then arguments+=(--email "${A[admin.email]}"); fi
    if [[ "$DRY_RUN" -eq 1 ]]; then
        emit "    (dry-run) $(quote_command "${arguments[@]}")   <<< $(t log.stdin.adminPassword)"
        return 0
    fi
    emit "    \$ $(quote_command "${arguments[@]}")   <<< $(t log.stdin.adminPassword)"
    set +e
    printf '%s\n' "$ADMIN_PASSWORD" | (cd "$SYS/" 2>/dev/null || cd /; "${arguments[@]}") 2>&1 | log_stream
    status=${PIPESTATUS[1]}
    set -e
    [[ "$status" -eq 0 ]] || die_t error.admin "$username"
    ADMIN_CREATED_NOW="$username"
    state_put admin "$username"
    ok log.admin.created "$username"
}

# ---------------------------------------------------------------- certificates

make_certificate() {
    # make_certificate COMMON_NAME ALT_NAME CERTIFICATE KEY - a self-signed *server* certificate
    # (EC P-256, ten years) from a request file of our own; see debian.certificate_config.
    local name="$1" alternative="$2" certificate="$3" key="$4"
    make_dir "$(dirname -- "$certificate")" 0700 root:root
    backup_file "$certificate"
    backup_file "$key"
    req_new
    req common_name "$name"
    req alt_name "$alternative"
    req output "$WORK_DIR/certificate.cnf"
    ask_helper debian-certificate-config
    if [[ "$DRY_RUN" -eq 1 ]]; then show_file "$WORK_DIR/certificate.cnf"; fi
    (
        umask 077
        run openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -sha256 -days 3650 \
            -config "$WORK_DIR/certificate.cnf" -keyout "$SYS$key" -out "$SYS$certificate"
    ) || die_t error.cert.create
    run chmod 0600 "$SYS$key" || true
    run chmod 0644 "$SYS$certificate" || true
    rm -f "$WORK_DIR/certificate.cnf"
    return 0
}

step_certificate() {
    local kind="${P[certificate.kind]:-none}" certificate="${P[certificate.file]:-}" key="${P[certificate.key]:-}"
    step step.certificate
    case "$kind" in
        origin)
            if [[ -s "$SYS$certificate" && -s "$SYS$key" && "${A[access.regenerate_certificate]:-0}" != "1" ]]; then
                ok log.cert.kept "$certificate"
            else
                # The name says nothing about the site or the program on purpose: this is what a
                # scanner sees if it ever reaches the home address.
                make_certificate origin "" "$certificate" "$key"
                achieved log.cert.origin "$certificate"
            fi ;;
        selfsigned)
            if [[ -s "$SYS$certificate" && -s "$SYS$key" && "${A[access.regenerate_certificate]:-0}" != "1" ]] \
                && certificate_names "$certificate" "${A[access.host_name]}"; then
                ok log.cert.kept "$certificate"
            else
                make_certificate "${A[access.host_name]}" "${A[access.host_name]}" "$certificate" "$key"
                warn log.cert.selfsigned "${A[access.host_name]}"
            fi ;;
        files)
            if [[ "$DRY_RUN" -eq 0 ]]; then
                [[ -s "$SYS$certificate" && -s "$SYS$key" ]] || die_t error.cert.files "$certificate" "$key"
                openssl x509 -in "$SYS$certificate" -noout -checkend 0 >/dev/null 2>&1 || die_t error.cert.expired "$certificate"
                # A key Apache cannot use stops it at the reload, with every other site on it (audit P2-9):
                # one with a passphrase, or one that is not the certificate's.
                openssl pkey -in "$SYS$key" -passin pass: -noout >/dev/null 2>&1 || die_t error.cert.keyLocked "$key"
                [[ "$(openssl x509 -in "$SYS$certificate" -noout -pubkey 2>/dev/null)" == "$(openssl pkey -in "$SYS$key" -passin pass: -pubout 2>/dev/null)" ]] \
                    || die_t error.cert.keyMismatch "$key" "$certificate"
            fi
            ok log.cert.own "$certificate" ;;
        letsencrypt)
            note log.cert.leLater ;;
    esac
    return 0
}

certificate_names() {
    # certificate_names CERTIFICATE HOST - whether the certificate was made for this name
    # (a temporary certificate kept from before the domain was changed was not).
    probe openssl x509 -in "$SYS$1" -noout -checkhost "$2" | grep -q 'does match'
}

obtain_letsencrypt() {
    # Let's Encrypt over port 80 (http-01), answered by our own port-80 host.
    local host="${A[access.host_name]}" arguments
    arguments=(certonly --webroot -w "$ACME_WEBROOT" -d "$host" --keep-until-expiring --non-interactive --agree-tos)
    if [[ -n "${A[access.acme_email]:-}" ]]; then
        arguments+=(-m "${A[access.acme_email]}" --no-eff-email)
    else
        arguments+=(--register-unsafely-without-email)
    fi
    run certbot "${arguments[@]}"
}

install_renew_hook() {
    req_new
    req output "$WORK_DIR/renew-hook.sh"
    ask_helper debian-renew-hook
    install_file "$WORK_DIR/renew-hook.sh" "$RENEW_HOOK" 0755
}

# ---------------------------------------------------------------- Apache

site_is_enabled() {
    [[ -e "$SYS$SITES_ENABLED/$1.conf" || -L "$SYS$SITES_ENABLED/$1.conf" ]]
}

render_sites() {
    # The sites of this shape, written by the helper into the work directory.
    local position count
    req_new
    req examples_dir "$THX_ROOT/deploy/apache"
    req output_dir "$WORK_DIR/sites"
    req conf.mode "${A[access.mode]}"
    req conf.host_name "${A[access.host_name]:-}"
    req conf.allow_lan "${A[access.allow_lan]:-0}"
    req conf.service_port "$(service_port)"
    req conf.certificate_file "${P[certificate.file]:-}"
    req conf.certificate_key_file "${P[certificate.key]:-}"
    req conf.generated "$(date '+%Y-%m-%d %H:%M')"
    count="${A[access.vps_addresses.count]:-0}"
    req conf.vps_addresses.count "$count"
    for ((position = 0; position < count; position++)); do
        req "conf.vps_addresses.$position" "${A[access.vps_addresses.$position]}"
    done
    ask_helper debian-sites
}

APACHE_WAS_ENABLED=()
APACHE_SNAPSHOT=0

apache_snapshot() {
    local site
    APACHE_WAS_ENABLED=()
    SITES_DISABLED_NOW=()
    APACHE_SNAPSHOT=1
    mkdir -p "$WORK_DIR/apache-before"
    for site in "$HTTP_SITE" "$HTTPS_SITE"; do
        if site_is_enabled "$site"; then APACHE_WAS_ENABLED+=("$site"); fi
        if [[ -f "$SYS$SITES_AVAILABLE/$site.conf" ]]; then
            cp -p "$SYS$SITES_AVAILABLE/$site.conf" "$WORK_DIR/apache-before/$site.conf"
        fi
    done
    return 0
}

apache_rollback() {
    # Apache is still running what it started with. Put our files back before anything reloads it.
    local site was
    if [[ "$DRY_RUN" -eq 1 || "$APACHE_SNAPSHOT" -eq 0 ]]; then return 0; fi
    emit "  [!]  $(t log.apache.rollback)"
    for site in "$HTTP_SITE" "$HTTPS_SITE"; do
        if [[ -f "$WORK_DIR/apache-before/$site.conf" ]]; then
            cp -p "$WORK_DIR/apache-before/$site.conf" "$SYS$SITES_AVAILABLE/$site.conf" || true
        else
            rm -f "$SYS$SITES_AVAILABLE/$site.conf" || true
        fi
        was=0
        if [[ " ${APACHE_WAS_ENABLED[*]:-} " == *" $site "* ]]; then was=1; fi
        if [[ "$was" -eq 1 ]]; then
            a2ensite -q "$site" >/dev/null 2>&1 || true
        else
            a2dissite -q "$site" >/dev/null 2>&1 || true
        fi
    done
    for site in "${SITES_DISABLED_NOW[@]:-}"; do
        if [[ -n "$site" ]]; then a2ensite -q "$site" >/dev/null 2>&1 || true; fi
    done
    SITES_DISABLED_NOW=()
    apache_back_up || warn log.apache.down
    return 0
}

apache_back_up() {
    # After the files went back: Apache running them, whatever the failed attempt left it in. A
    # reload of a stopped Apache does nothing, and everything else it serves stayed down (audit P2-9).
    apache2ctl configtest >/dev/null 2>&1 || return 1
    systemctl reload apache2 >/dev/null 2>&1 || systemctl restart apache2 >/dev/null 2>&1 || true
    sleep 2
    if [[ "$(probe systemctl is-active apache2)" != "active" ]]; then
        systemctl restart apache2 >/dev/null 2>&1 || true
        sleep 2
    fi
    [[ "$(probe systemctl is-active apache2)" == "active" ]]
}

apache_test() {
    local output
    if [[ "$DRY_RUN" -eq 1 ]]; then
        emit "    (dry-run) apache2ctl configtest"
        return 0
    fi
    emit "    \$ apache2ctl configtest"
    if output="$(apache2ctl configtest 2>&1)"; then
        return 0
    fi
    log_stream <<< "$output"
    return 1
}

apache_reload() {
    # A module switched on in this run needs a restart; otherwise a reload keeps open
    # connections (somebody's film) alive.
    if [[ "$DRY_RUN" -eq 1 ]]; then
        emit "    (dry-run) systemctl reload apache2"
        return 0
    fi
    if [[ "$(probe systemctl is-active apache2)" != "active" ]]; then
        run systemctl start apache2 || return 1
    elif [[ "$APACHE_NEEDS_RESTART" -eq 1 ]]; then
        run systemctl restart apache2 || return 1
    else
        run systemctl reload apache2 || return 1
    fi
    APACHE_NEEDS_RESTART=0
    # A graceful reload answers 0 and only then reads the certificate: with a key that does not
    # fit, the parent process dies a moment later. Still running after a pause, or a failure (audit P2-9).
    sleep 2
    [[ "$(probe systemctl is-active apache2)" == "active" ]] || return 1
    return 0
}

apache_refuse() {
    apache_rollback
    die_t "$@"
}

letsencrypt_first() {
    # The 443 host cannot start before its certificate exists, and the certificate cannot
    # be issued before port 80 answers the challenge. So: port 80 alone first.
    local host="${A[access.host_name]}" live
    live="/etc/letsencrypt/live/$host/fullchain.pem"
    install_renew_hook
    if [[ -s "$SYS$live" ]]; then
        ok log.cert.leKept "$host"
        return 0
    fi
    install_file "$WORK_DIR/sites/$HTTP_SITE.conf" "$SITES_AVAILABLE/$HTTP_SITE.conf" 0644
    run a2ensite -q "$HTTP_SITE" || apache_refuse error.apache.enable "$HTTP_SITE"
    apache_test || apache_refuse error.apache.syntax
    apache_reload || apache_refuse error.apache.reload
    if obtain_letsencrypt; then
        achieved log.cert.le "$host"
        return 0
    fi
    warn log.cert.leFailed "$host"
    if [[ "$UNATTENDED" -eq 1 ]] || ! ui_yesno "$(t cert.fallback.title)" "$(t cert.fallback.text "$host")" yes; then
        apache_refuse error.cert.le "$host"
    fi
    # A temporary certificate signed by this machine: the site works (with a browser warning)
    # until `--zmien dostep` is run again with the DNS record and port 80 in place.
    A[access.certificate]="selfsigned"
    P[certificate.kind]="selfsigned"
    P[certificate.file]="$SELF_CERT"
    P[certificate.key]="$SELF_KEY"
    make_certificate "$host" "$host" "$SELF_CERT" "$SELF_KEY"
    render_sites
    return 0
}

step_apache() {
    local site mode="${A[access.mode]}" previous keep
    step step.apache
    render_sites
    apache_snapshot
    if [[ "$mode" == "direct" ]]; then
        make_dir "$ACME_WEBROOT" 0755 root:root
        make_dir "$ACME_WEBROOT/.well-known" 0755 root:root
        make_dir "$ACME_WEBROOT/.well-known/acme-challenge" 0755 root:root
        if [[ "${P[certificate.kind]:-}" == "letsencrypt" ]]; then letsencrypt_first; fi
    fi
    for site in $(list_items P sites); do
        install_file "$WORK_DIR/sites/$site.conf" "$SITES_AVAILABLE/$site.conf" 0644
        run a2ensite -q "$site" || apache_refuse error.apache.enable "$site"
    done
    # The site of a shape that was here before.
    for site in $(list_items P retired_sites); do
        if site_is_enabled "$site"; then run a2dissite -q "$site" || true; fi
        remove_file "$SITES_AVAILABLE/$site.conf"
    done
    # Sites of the system that would answer in our place.
    for site in $(list_items P disable_sites); do
        if site_is_enabled "$site"; then
            run a2dissite -q "$site" || apache_refuse error.apache.disable "$site"
            SITES_DISABLED_NOW+=("$site")
        fi
    done
    # ...and the ones an earlier shape of ours switched off and this one has no quarrel with.
    for previous in $(list_items ST apache.disabled_sites); do
        keep=0
        for site in $(list_items P disable_sites); do
            if [[ "$site" == "$previous" ]]; then keep=1; fi
        done
        if [[ "$keep" -eq 0 && -f "$SYS$SITES_AVAILABLE/$previous.conf" ]]; then
            run a2ensite -q "$previous" || true
        fi
    done
    apache_quiet "$mode"
    apache_test || apache_refuse error.apache.syntax
    apache_reload || apache_refuse error.apache.reload
    achieved log.apache.ready
    return 0
}

apache_quiet() {
    # Public shapes (S, P): Apache and PHP stop naming themselves. Debian's security.conf sends
    # "Apache/2.4.x (Debian)" in every answer and signs its error pages, and PHP adds X-Powered-By.
    # A conf of our own, read after security.conf; gone again in D, C and at uninstall (audit P3-4).
    if [[ "$1" == "direct" || "$1" == "vps" ]]; then
        printf '%s\n' "# Apache i PHP nie podaja swoich wersji - kazda odpowiedz i strona bledu." \
            "ServerTokens Prod" "ServerSignature Off" "<IfModule mod_headers.c>" \
            "    Header always unset X-Powered-By" "    Header unset X-Powered-By" "</IfModule>" > "$WORK_DIR/quiet.source"
        req_new
        req source "$WORK_DIR/quiet.source"
        req output "$WORK_DIR/quiet.conf"
        ask_helper debian-mark
        install_file "$WORK_DIR/quiet.conf" "$QUIET_CONF" 0644
        run a2enconf -q "$QUIET_CONF_NAME" || apache_refuse error.apache.enable "$QUIET_CONF_NAME"
    elif is_ours "$QUIET_CONF"; then
        run a2disconf -q "$QUIET_CONF_NAME" || true
        remove_file "$QUIET_CONF"
    fi
    return 0
}

# ---------------------------------------------------------------- firewall

step_firewall() {
    local rule parts
    step step.firewall
    if [[ "${P[firewall.manage]:-0}" != "1" ]]; then
        # Not ours to set: nothing is added and nothing an earlier run added is taken away.
        if [[ "${A[access.mode]}" == "local" ]]; then
            ok log.firewall.local
        elif [[ "${E[ufw_active]:-0}" != "1" && -n "${E[foreign_firewall]:-}" ]]; then
            warn log.firewall.foreign "${E[foreign_firewall]}"
        else
            warn log.firewall.unmanaged
        fi
        return 0
    fi
    FIREWALL_CHANGED=1
    remove_firewall_rules
    # Recorded before they are added, and the switch-on the moment it happens: a run that stops
    # later used to lose both, and a resume or an uninstall no longer knew them (audit P2-4).
    record_firewall_rules P
    while IFS= read -r rule; do
        [[ -n "$rule" ]] || continue
        read -r -a parts <<< "$rule"
        run ufw "${parts[@]}" || die_t error.firewall "$rule"
    done < <(list_items P firewall.rules)
    if [[ "${P[firewall.enable]:-0}" == "1" ]]; then
        run ufw --force enable || die_t error.firewall "enable"
        FIREWALL_ENABLED_NOW=1
        state_put firewall.enabled_by_installer 1
    fi
    achieved log.firewall.ready
    return 0
}

record_firewall_rules() {
    # record_firewall_rules ARRAY - the rules held in ARRAY (P: planned, ST: recorded) into the state file now.
    local -n _source="$1"
    local count position pairs
    count="${_source[firewall.rules.count]:-0}"
    pairs=(firewall.managed 1 firewall.rules.count "$count")
    for ((position = 0; position < count; position++)); do
        pairs+=("firewall.rules.$position" "${_source[firewall.rules.$position]:-}")
    done
    state_put "${pairs[@]}"
}

access_rollback() {
    # A change of the access mode that did not stand: the configuration and the firewall
    # go back to what the still-running Apache configuration expects. (Apache's own
    # files were put back by apache_rollback before anything reloaded it.)
    local rule parts
    if [[ "$DRY_RUN" -eq 1 ]]; then return 0; fi
    emit "  [!]  $(t log.access.rollback)"
    if [[ -f "$WORK_DIR/config-before.toml" ]]; then
        cp -p "$WORK_DIR/config-before.toml" "$SYS$CONFIG" || true
        refresh_migrate_config || true
    fi
    if [[ "$FIREWALL_CHANGED" -eq 1 ]]; then
        while IFS= read -r rule; do
            [[ -n "$rule" ]] || continue
            read -r -a parts <<< "$rule"
            run ufw delete "${parts[@]}" || true
        done < <(list_items P firewall.rules)
        while IFS= read -r rule; do
            [[ -n "$rule" ]] || continue
            read -r -a parts <<< "$rule"
            run ufw "${parts[@]}" || true
        done < <(list_items ST firewall.rules)
        # The record follows the firewall back: it was written with the new rules a moment ago.
        record_firewall_rules ST || true
    fi
    return 0
}

remove_firewall_rules() {
    # The rules an earlier run of this installer added, taken from its own record. With
    # "keep-reach", the ones that keep SSH and the home network reachable stay: ufw stays on,
    # and without them nobody gets back in after logging out (audit P0-1).
    local keep="${1:-}" rule parts
    while IFS= read -r rule; do
        [[ -n "$rule" ]] || continue
        if [[ "$keep" == "keep-reach" && " $rule " == *" comment tryhackx-media-reach "* ]]; then
            note log.firewall.kept "$rule"
            continue
        fi
        read -r -a parts <<< "$rule"
        run ufw delete "${parts[@]}" || true
    done < <(list_items ST firewall.rules)
    return 0
}

# ---------------------------------------------------------------- fail2ban

step_fail2ban() {
    step step.fail2ban
    req_new
    req source "$THX_ROOT/deploy/fail2ban/filter.d/tryhackx-media-auth.conf.example"
    req output "$WORK_DIR/fail2ban-filter.conf"
    ask_helper debian-mark
    install_file "$WORK_DIR/fail2ban-filter.conf" "$FAIL2BAN_FILTER" 0644
    req_new
    req source "$THX_ROOT/deploy/fail2ban/jail.d/tryhackx-media.conf.example"
    req output "$WORK_DIR/fail2ban-jail.conf"
    ask_helper debian-mark
    install_file "$WORK_DIR/fail2ban-jail.conf" "$FAIL2BAN_JAIL" 0644
    # The jail reads Apache's error log of our host, which exists once Apache has started with it.
    # A fail2ban that was already running keeps its bans and its other jails: reloaded, not restarted.
    run systemctl enable fail2ban || true
    if run systemctl "$(fail2ban_verb)" fail2ban; then
        if [[ "$DRY_RUN" -eq 0 ]] && ! fail2ban-client status tryhackx-media-auth >/dev/null 2>&1; then
            warn log.fail2ban.inactive
        else
            achieved log.fail2ban.ready
        fi
    else
        warn log.fail2ban.inactive
    fi
    return 0
}

same_text() {
    # same_text A B - the two files say the same, apart from the line with the date they were written.
    cmp -s <(grep -v -e '^# Wygenerowano: ' -e '^# Wygenerowane przez ' -e '^# Generated by ' "$1" 2>/dev/null) \
           <(grep -v -e '^# Wygenerowano: ' -e '^# Wygenerowane przez ' -e '^# Generated by ' "$2" 2>/dev/null)
}

step_system_files_refresh() {
    # An update: the files this installer generated from the project follow the new version - a
    # route closed or a header changed in deploy/apache reached nothing on Debian before (audit P2-6).
    # Only files that carry the installer's marker; one changed by hand is left alone.
    local site replace=() name
    step step.refresh
    make_plan
    render_sites
    for site in "$HTTP_SITE" "$HTTPS_SITE"; do
        [[ -f "$WORK_DIR/sites/$site.conf" ]] && is_ours "$SITES_AVAILABLE/$site.conf" || continue
        same_text "$WORK_DIR/sites/$site.conf" "$SYS$SITES_AVAILABLE/$site.conf" || replace+=("$site")
    done
    if [[ ${#replace[@]} -eq 0 ]]; then
        ok log.refresh.sitesSame
    else
        apache_snapshot
        for site in "${replace[@]}"; do install_file "$WORK_DIR/sites/$site.conf" "$SITES_AVAILABLE/$site.conf" 0644; done
        apache_test || apache_refuse error.apache.syntax
        apache_reload || apache_refuse error.apache.reload
        achieved log.refresh.sites "${replace[*]}"
    fi
    if is_ours "$FAIL2BAN_JAIL"; then
        for name in filter jail; do
            req_new
            if [[ "$name" == "filter" ]]; then
                req source "$THX_ROOT/deploy/fail2ban/filter.d/tryhackx-media-auth.conf.example"
            else
                req source "$THX_ROOT/deploy/fail2ban/jail.d/tryhackx-media.conf.example"
            fi
            req output "$WORK_DIR/fail2ban-$name.conf"
            ask_helper debian-mark
        done
        if ! same_text "$WORK_DIR/fail2ban-filter.conf" "$SYS$FAIL2BAN_FILTER" || ! same_text "$WORK_DIR/fail2ban-jail.conf" "$SYS$FAIL2BAN_JAIL"; then
            install_file "$WORK_DIR/fail2ban-filter.conf" "$FAIL2BAN_FILTER" 0644
            install_file "$WORK_DIR/fail2ban-jail.conf" "$FAIL2BAN_JAIL" 0644
            run systemctl reload fail2ban || warn log.fail2ban.inactive
        fi
    fi
    if is_ours "$RENEW_HOOK"; then
        req_new
        req output "$WORK_DIR/renew-hook.sh"
        ask_helper debian-renew-hook
        same_text "$WORK_DIR/renew-hook.sh" "$SYS$RENEW_HOOK" || install_file "$WORK_DIR/renew-hook.sh" "$RENEW_HOOK" 0755
    fi
    return 0
}

step_bundle_refresh() {
    # Behind a VPS: the bundle is built again from the new version's templates. When what the VPS
    # runs changed, it says so - the VPS has to be given the new script (audit P2-6).
    local before="$WORK_DIR/bundle-before" name changed=0
    if [[ "${A[access.mode]}" != "vps" ]]; then return 0; fi
    step step.bundleRefresh
    if [[ "$DRY_RUN" -eq 1 || ! -s "$SYS$ORIGIN_CERT" ]]; then
        write_bundle "$ORIGIN_CERT"
        return 0
    fi
    mkdir -p "$before"
    for name in "$HTTP_SITE.conf" "$HTTPS_SITE.conf" maintenance.html vps-setup.sh; do
        if [[ -f "$SYS$BUNDLE_DIR/$name" ]]; then cp -p "$SYS$BUNDLE_DIR/$name" "$before/$name"; fi
    done
    write_bundle "$ORIGIN_CERT"
    for name in "$HTTP_SITE.conf" "$HTTPS_SITE.conf" maintenance.html vps-setup.sh; do
        same_text "$before/$name" "$SYS$BUNDLE_DIR/$name" || changed=1
    done
    if [[ "$changed" -eq 1 ]]; then warn log.refresh.bundleChanged "$BUNDLE_DIR"; else ok log.refresh.bundleSame; fi
    return 0
}

remove_fail2ban() {
    local changed=0
    if [[ -e "$SYS$FAIL2BAN_JAIL" ]]; then remove_file "$FAIL2BAN_JAIL"; changed=1; fi
    if [[ -e "$SYS$FAIL2BAN_FILTER" ]]; then remove_file "$FAIL2BAN_FILTER"; changed=1; fi
    if [[ "$changed" -eq 1 ]] && have fail2ban-client; then run systemctl "$(fail2ban_verb)" fail2ban || true; fi
    return 0
}

fail2ban_verb() {
    # reload for a fail2ban that runs (its bans and other jails stay), restart to start one.
    if [[ "${E[fail2ban_active]:-0}" == "1" ]]; then printf 'reload'; else printf 'restart'; fi
}

# ---------------------------------------------------------------- timers

step_timers() {
    step step.timers
    run systemctl enable --now "${TIMERS[@]}" || die_t error.systemd
    if [[ "${A[options.start_scan]:-1}" == "1" ]]; then
        # The first cataloguing of a large library takes long; it runs as the nightly job
        # does, in the background, and the installer does not wait for it.
        run systemctl start --no-block tryhackx-media-maintenance.service || warn log.scan.notStarted
    fi
    return 0
}

start_scan() {
    step step.scan
    run systemctl start --no-block tryhackx-media-maintenance.service || warn log.scan.notStarted
    return 0
}

# ---------------------------------------------------------------- the bundle for the VPS

certificate_end_date() {
    # "2036-11-10" from the certificate's notAfter.
    local printed
    printed="$(probe openssl x509 -in "$SYS$1" -noout -enddate)"
    printed="${printed#notAfter=}"
    printed="${printed%$'\r'}"
    if [[ -n "$printed" ]]; then probe date -u -d "$printed" +%Y-%m-%d; fi
    return 0
}

write_bundle() {
    # write_bundle CERTIFICATE - the folder for the VPS, built around the given certificate.
    local certificate="$1" position count end
    if [[ ! -s "$SYS$certificate" ]]; then
        # A dry run of a fresh installation: there is no certificate to read yet.
        emit "    (dry-run) $(t log.bundle.files "$BUNDLE_DIR" "vps-setup.sh, INSTRUKCJA-VPS.md, VPS-GUIDE.md, $HTTP_SITE.conf, $HTTPS_SITE.conf, origin.crt, maintenance.html")"
        return 0
    fi
    end="$(certificate_end_date "$certificate")"
    req_new
    req template_dir "$THX_INSTALLER/templates/vps"
    req output_dir "$SYS$BUNDLE_DIR"
    req bundle_dir "$BUNDLE_DIR"
    req host_name "${A[access.host_name]}"
    req home_address "${A[access.home_address]}"
    req lan_address "${E[lan_address]:-}"
    req certificate "$SYS$certificate"
    req certificate_not_after "$end"
    req generated "$(date +%Y-%m-%d)"
    req platform debian
    req language "$LANG_CODE"
    req acme_email "${A[access.acme_email]:-}"
    req acme_agree "${A[access.acme_agree_tos]:-0}"
    # Managed and narrow: ours, and no rule of somebody else's letting anybody reach 443 (audit P3-3).
    if [[ "${P[firewall.manage]:-0}" == "1" && "${E[ufw_open_443]:-0}" != "1" ]]; then
        req firewall_managed 1
    else
        req firewall_managed 0
    fi
    req dry_run "$DRY_RUN"
    count="${A[access.vps_addresses.count]:-0}"
    req vps_addresses.count "$count"
    for ((position = 0; position < count; position++)); do
        req "vps_addresses.$position" "${A[access.vps_addresses.$position]}"
    done
    if [[ "$DRY_RUN" -eq 0 ]]; then
        mkdir -p "$SYS$BUNDLE_DIR"
        chmod 0700 "$SYS$BUNDLE_DIR"
    fi
    ask_helper vps-bundle
    CERTIFICATE_FINGERPRINT="${R[fingerprint]:-}"
    if [[ "$DRY_RUN" -eq 1 ]]; then
        emit "    (dry-run) $(t log.bundle.files "$BUNDLE_DIR" "$(list_items R files | tr '\n' ' ')")"
    else
        emit "    $(t log.bundle.files "$BUNDLE_DIR" "$(list_items R files | tr '\n' ' ')")"
        chown -R root:root "$SYS$BUNDLE_DIR"
        BUNDLE_WRITTEN=1
    fi
    return 0
}

step_bundle() {
    step step.bundle
    write_bundle "$ORIGIN_CERT"
}

# ---------------------------------------------------------------- the VPS over SSH

VPS_HOST=""
VPS_TARGET=""
SSH_OPTIONS=()
SCP_OPTIONS=()

vps_prepare() {
    # Who to talk to, and the options every ssh/scp call of this run shares.
    local user="${A[vps.ssh_user]:-root}" port="${A[vps.ssh_port]:-22}" identity="${A[vps.ssh_identity_file]:-}"
    VPS_HOST="${A[vps.ssh_host]:-}"
    if [[ -z "$VPS_HOST" ]]; then VPS_HOST="${A[access.vps_addresses.0]:-}"; fi
    [[ -n "$VPS_HOST" ]] || die_t error.vps.noHost
    VPS_TARGET="$user@$VPS_HOST"
    # Only the key confirmed below is trusted - not whatever a first connection happens to meet.
    # ...and only its ED25519 key: the one the person was shown (audit P2-2).
    SSH_OPTIONS=(-o "UserKnownHostsFile=$SYS$KNOWN_HOSTS" -o GlobalKnownHostsFile=/dev/null -o StrictHostKeyChecking=yes
        -o HostKeyAlgorithms=ssh-ed25519 -o ConnectTimeout=15 -p "$port")
    SCP_OPTIONS=(-o "UserKnownHostsFile=$SYS$KNOWN_HOSTS" -o GlobalKnownHostsFile=/dev/null -o StrictHostKeyChecking=yes
        -o HostKeyAlgorithms=ssh-ed25519 -o ConnectTimeout=15 -P "$port")
    if [[ -n "$identity" ]]; then
        SSH_OPTIONS+=(-i "$SYS$identity" -o BatchMode=yes)
        SCP_OPTIONS+=(-i "$SYS$identity" -o BatchMode=yes)
    fi
    return 0
}

vps_confirm_host_key() {
    # The key of the VPS is shown and has to be confirmed by the person (or match the
    # fingerprint in the answers file) before anything is sent there.
    local port="${A[vps.ssh_port]:-22}" scanned="$WORK_DIR/vps-hostkey" fingerprints wanted="${A[vps.ssh_host_fingerprint]:-}"
    if [[ "$DRY_RUN" -eq 1 ]]; then
        emit "    (dry-run) ssh-keyscan -p $port $VPS_HOST   # $(t log.vps.hostKey)"
        return 0
    fi
    # The entry for this host on this port only: one kept from port 22 says nothing about another port (audit P3-12).
    local entry="$VPS_HOST"
    if [[ "$port" != "22" ]]; then entry="[$VPS_HOST]:$port"; fi
    if [[ -s "$SYS$KNOWN_HOSTS" ]] && ssh-keygen -F "$entry" -f "$SYS$KNOWN_HOSTS" >/dev/null 2>&1; then
        ok log.vps.known "$VPS_HOST"
        return 0
    fi
    # One key type, and only the one the person confirms is trusted: with every type scanned, a
    # confirmed ED25519 key let an ECDSA or RSA key from someone in between in too (audit P2-2).
    ssh-keyscan -T 15 -p "$port" -t ed25519 "$VPS_HOST" > "$scanned" 2>/dev/null || true
    if [[ ! -s "$scanned" ]]; then
        if ssh-keyscan -T 15 -p "$port" "$VPS_HOST" 2>/dev/null | grep -q .; then
            die_t error.vps.noEd25519 "$VPS_HOST"
        fi
        die_t error.vps.unreachable "$VPS_HOST" "$port"
    fi
    # "256 SHA256:... host (ED25519)" -> "SHA256:... (ED25519)"
    fingerprints="$(ssh-keygen -lf "$scanned" 2>/dev/null | awk '{ print $2 " " $NF }' | tr '\n' ' ')"
    [[ -n "$fingerprints" ]] || die_t error.vps.unreachable "$VPS_HOST" "$port"
    if [[ -n "$wanted" ]]; then
        [[ " $fingerprints" == *" $wanted "* ]] || die_t error.vps.fingerprint "$VPS_HOST" "$fingerprints"
    elif [[ "$UNATTENDED" -eq 1 ]]; then
        die_t error.vps.fingerprintNeeded "$VPS_HOST" "$fingerprints"
    elif ! ui_yesno "$(t vps.hostKey.title)" "$(t vps.hostKey.text "$VPS_HOST" "$fingerprints")" no; then
        die_t error.vps.refused
    fi
    make_dir "$CONFIG_DIR" 0750 "root:$SERVICE_GROUP"
    cat "$scanned" >> "$SYS$KNOWN_HOSTS"
    chmod 0600 "$SYS$KNOWN_HOSTS"
    return 0
}

vps_destination() {
    # user@host:path for scp; an IPv6 address needs brackets there.
    if [[ "$VPS_HOST" == *:* ]]; then
        printf '%s@[%s]:%s' "${VPS_TARGET%@*}" "$VPS_HOST" "$1"
    else
        printf '%s:%s' "$VPS_TARGET" "$1"
    fi
}

vps_send() {
    run_tty scp "${SCP_OPTIONS[@]}" "$SYS$BUNDLE_DIR/vps-setup.sh" "$(vps_destination tryhackx-vps-setup.sh)"
}

vps_execute() {
    # vps_execute [OPTION...] - run the script on the VPS; its exit code is ours.
    local prefix="" remote
    if [[ "${VPS_TARGET%@*}" != "root" ]]; then prefix="sudo "; fi
    remote="${prefix}bash tryhackx-vps-setup.sh --lang $LANG_CODE"
    if [[ $# -gt 0 ]]; then remote="$remote $*"; fi
    # A terminal on the far side only when there is one on this side: the script asks
    # its one question (DNS not ready - go on?) only of a person.
    local terminal=()
    if [[ -t 0 ]]; then terminal=(-t); fi
    run_tty ssh "${terminal[@]}" "${SSH_OPTIONS[@]}" "$VPS_TARGET" "$remote"
}

vps_manual() {
    # The two commands to run by hand, with the real values in them.
    local prefix="" user="${A[vps.ssh_user]:-root}" host="${A[vps.ssh_host]:-${A[access.vps_addresses.0]:-VPS}}"
    if [[ "$user" != "root" ]]; then prefix="sudo "; fi
    emit ""
    say vps.manual.intro
    # sudo: the bundle folder is root's own (0700), as the guide inside it says too (audit P3-1).
    emit "    sudo scp $BUNDLE_DIR/vps-setup.sh $user@$host:"
    emit "    ssh -t $user@$host '${prefix}bash vps-setup.sh --lang $LANG_CODE${1:+ $1}'"
    say vps.manual.guide "$BUNDLE_DIR/$(t vps.guide.file)"
    return 0
}

step_vps() {
    local status=0
    step step.vps
    if [[ "${A[vps.run]:-manual}" != "ssh" ]]; then
        vps_manual ""
        return 0
    fi
    if [[ "$DRY_RUN" -eq 0 && ! -s "$SYS$BUNDLE_DIR/vps-setup.sh" ]]; then
        die_t error.vps.noBundle "$BUNDLE_DIR"
    fi
    vps_prepare
    vps_confirm_host_key
    note vps.ssh.password
    vps_send || { warn log.vps.sendFailed "$VPS_HOST"; vps_manual ""; return 0; }
    vps_execute || status=$?
    case "$status" in
        0) ok log.vps.done "$VPS_HOST" ;;
        3) warn log.vps.homeSilent ;;
        255)
            # ssh's own failure (no connection, a changed host key): the script never ran there,
            # so nothing on the VPS was changed or undone (audit P3-12).
            warn log.vps.sshFailed "$VPS_HOST" "$SYS$KNOWN_HOSTS"
            vps_manual "" ;;
        *)
            warn log.vps.failed "$status"
            vps_manual "" ;;
    esac
    return 0
}

# ---------------------------------------------------------------- the record

step_state() {
    local position count index item wanted_off seen
    step step.state
    req_new
    req state_file "$SYS$STATE_FILE"
    req dry_run "$DRY_RUN"
    req update.product_version "${E[version]:-}"
    req update.service_port "$(service_port)"
    if [[ "$FLOW" == "install" ]]; then req update.install_completed 1; fi
    if [[ -n "$ADMIN_CREATED_NOW" ]]; then req update.admin "$ADMIN_CREATED_NOW"; fi
    if [[ "$FLOW" == "install" || "$FLOW" == "access" ]]; then
        req update.access.mode "${A[access.mode]}"
        req update.access.host_name "${A[access.host_name]:-}"
        req update.access.home_address "${A[access.home_address]:-}"
        req update.access.allow_lan "${A[access.allow_lan]:-0}"
        req update.access.certificate "${A[access.certificate]:-none}"
        req update.access.certificate_file "${P[certificate.file]:-}"
        req update.access.key_file "${P[certificate.key]:-}"
        req update.access.acme_email "${A[access.acme_email]:-}"
        req update.access.acme_agree_tos "${A[access.acme_agree_tos]:-0}"
        count="${A[access.vps_addresses.count]:-0}"
        req update.access.vps_addresses.count "$count"
        for ((position = 0; position < count; position++)); do
            req "update.access.vps_addresses.$position" "${A[access.vps_addresses.$position]}"
        done
        count="${P[sites.count]:-0}"
        req update.apache.sites.count "$count"
        for ((position = 0; position < count; position++)); do
            req "update.apache.sites.$position" "${P[sites.$position]}"
        done
        # Sites of the system this installer switched off and this shape still wants off:
        # this run's and an earlier run's. (The rest were switched back on in step_apache.)
        index=0
        wanted_off=" $(list_items P disable_sites | tr '\n' ' ')"
        seen=" "
        for item in "${SITES_DISABLED_NOW[@]:-}" $(list_items ST apache.disabled_sites); do
            if [[ -n "$item" && "$wanted_off" == *" $item "* && "$seen" != *" $item "* ]]; then
                req "update.apache.disabled_sites.$index" "$item"
                index=$((index + 1))
                seen="$seen$item "
            fi
        done
        req update.apache.disabled_sites.count "$index"
        req update.firewall.managed "${P[firewall.manage]:-0}"
        if [[ "$FIREWALL_ENABLED_NOW" -eq 1 || "${ST[firewall.enabled_by_installer]:-0}" == "1" ]]; then
            req update.firewall.enabled_by_installer 1
        else
            req update.firewall.enabled_by_installer 0
        fi
        if [[ "${P[firewall.manage]:-0}" == "1" ]]; then
            # An unmanaged firewall keeps the record of what an earlier run added, so that
            # an uninstall can still take exactly that away.
            count="${P[firewall.rules.count]:-0}"
            req update.firewall.rules.count "$count"
            for ((position = 0; position < count; position++)); do
                req "update.firewall.rules.$position" "${P[firewall.rules.$position]}"
            done
        fi
        req update.fail2ban.installed "${P[fail2ban]:-0}"
        if [[ "${A[access.mode]}" == "vps" ]]; then req update.bundle_dir "$BUNDLE_DIR"; else req update.bundle_dir ""; fi
    fi
    if [[ "$FLOW" == "install" ]]; then
        req update.database.name "${A[database.name]}"
        req update.database.user "${A[database.user]}"
        req update.database.ddl_user "${P[migrate_user]:-}"
        if [[ "$DATABASE_CREATED_NOW" -eq 1 || "${ST[database.created_by_installer]:-0}" == "1" ]]; then
            req update.database.created_by_installer 1
        else
            req update.database.created_by_installer 0
        fi
    fi
    index=0
    for item in "${NEW_FILES[@]:-}"; do
        if [[ -n "$item" ]]; then req "update.files.$index" "$item"; index=$((index + 1)); fi
    done
    req update.files.count "$index"
    index=0
    for item in "${MODULES_ENABLED_NOW[@]:-}"; do
        if [[ -n "$item" ]]; then req "update.modules_enabled.$index" "$item"; index=$((index + 1)); fi
    done
    req update.modules_enabled.count "$index"
    index=0
    for item in "${PACKAGES_INSTALLED_NOW[@]:-}"; do
        if [[ -n "$item" ]]; then req "update.packages_installed.$index" "$item"; index=$((index + 1)); fi
    done
    req update.packages_installed.count "$index"
    ask_helper debian-state
    # The record holds the home address and nothing outside this installer reads it: root's alone (audit P3-16).
    if [[ "$DRY_RUN" -eq 1 ]]; then
        emit "    (dry-run) $(t log.file.write "$STATE_FILE" 0600 "root:root")"
    else
        emit "    \$ $(t log.file.write "$STATE_FILE" 0600 "root:root")"
        chown root:root "$SYS$STATE_FILE"
        chmod 0600 "$SYS$STATE_FILE"
    fi
    return 0
}

# ---------------------------------------------------------------- the last look

http_status() {
    # http_status CURL-ARG... - the status code of one request (000 when nothing answered).
    local code
    code="$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 15 "$@" 2>/dev/null)" || true
    code="${code%$'\r'}"
    printf '%s' "${code:-000}"
}

step_verify() {
    local mode="${A[access.mode]}" host="${A[access.host_name]:-}" base arguments=() code
    step step.verify
    case "$mode" in
        direct)
            base="https://$host"
            arguments=(--resolve "$host:443:127.0.0.1")
            # A certificate signed by this machine cannot be checked against anybody.
            if [[ "${A[access.certificate]:-}" != "letsencrypt" ]]; then arguments+=(--insecure); fi ;;
        vps)
            # The certificate names nobody on purpose, so there is no name to check it against.
            base="https://127.0.0.1"
            arguments=(--insecure --header "Host: $host") ;;
        *)
            base="http://127.0.0.1" ;;
    esac
    if [[ "$DRY_RUN" -eq 1 ]]; then
        emit "    (dry-run) curl http://127.0.0.1:$(service_port)/health/ready ; curl $base/ ; curl $base/media-next-api?action=auth_state ; curl $base/media-transfer/health/ready (403)"
        return 0
    fi
    code="$(http_status "http://127.0.0.1:$(service_port)/health/ready")"
    if [[ "$code" == "200" ]]; then ok log.verify.service; else warn log.verify.service.failed "$code"; fi
    code="$(http_status "${arguments[@]}" "$base/")"
    if [[ "$code" == "200" ]]; then ok log.verify.page "$base/"; else warn log.verify.page.failed "$base/" "$code"; fi
    code="$(http_status "${arguments[@]}" "$base/media-next-api?action=auth_state")"
    if [[ "$code" == "200" ]]; then ok log.verify.bridge; else warn log.verify.bridge.failed "$code"; fi
    code="$(http_status "${arguments[@]}" "$base/media-transfer/health/ready")"
    if [[ "$code" == "403" ]]; then ok log.verify.internal; else warn log.verify.internal.failed "$code"; fi
    return 0
}
