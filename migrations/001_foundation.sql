CREATE TABLE IF NOT EXISTS users (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  username VARCHAR(191) NOT NULL,
  email VARCHAR(254) NULL,
  password_hash VARCHAR(255) NOT NULL,
  role VARCHAR(32) NOT NULL DEFAULT 'user',
  is_guest TINYINT(1) NOT NULL DEFAULT 0,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_users_username (username),
  UNIQUE KEY uq_users_email (email),
  CONSTRAINT chk_users_role CHECK (role IN ('user', 'admin', 'super_admin'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
-- migrate:split
CREATE TABLE IF NOT EXISTS user_sessions (
  id BINARY(32) NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  csrf_secret BINARY(32) NOT NULL,
  ip_hash BINARY(32) NULL,
  user_agent_hash BINARY(32) NULL,
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  last_seen_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  expires_at TIMESTAMP(6) NOT NULL,
  revoked_at TIMESTAMP(6) NULL,
  PRIMARY KEY (id),
  KEY ix_user_sessions_user_expiry (user_id, expires_at),
  CONSTRAINT fk_user_sessions_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
-- migrate:split
CREATE TABLE IF NOT EXISTS media_roots (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  slug VARCHAR(32) NOT NULL,
  media_kind VARCHAR(32) NOT NULL,
  display_name VARCHAR(191) NOT NULL,
  filesystem_path VARCHAR(1024) NOT NULL,
  is_enabled TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_media_roots_slug (slug),
  CONSTRAINT chk_media_roots_kind CHECK (media_kind IN ('music', 'movies', 'mixed'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
-- migrate:split
CREATE TABLE IF NOT EXISTS catalog_scans (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  root_id BIGINT UNSIGNED NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'running',
  metadata_enabled TINYINT(1) NOT NULL DEFAULT 0,
  discovered_count BIGINT UNSIGNED NOT NULL DEFAULT 0,
  new_count BIGINT UNSIGNED NOT NULL DEFAULT 0,
  updated_count BIGINT UNSIGNED NOT NULL DEFAULT 0,
  unchanged_count BIGINT UNSIGNED NOT NULL DEFAULT 0,
  missing_count BIGINT UNSIGNED NOT NULL DEFAULT 0,
  error_count BIGINT UNSIGNED NOT NULL DEFAULT 0,
  error_text TEXT NULL,
  started_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  finished_at TIMESTAMP(6) NULL,
  PRIMARY KEY (id),
  KEY ix_catalog_scans_root_started (root_id, started_at),
  CONSTRAINT fk_catalog_scans_root FOREIGN KEY (root_id) REFERENCES media_roots (id) ON DELETE RESTRICT,
  CONSTRAINT chk_catalog_scans_status CHECK (status IN ('running', 'completed', 'failed', 'cancelled'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
-- migrate:split
CREATE TABLE IF NOT EXISTS media_items (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  root_id BIGINT UNSIGNED NOT NULL,
  relative_path TEXT NOT NULL,
  path_hash BINARY(32) NOT NULL,
  legacy_checksum CHAR(64) NULL,
  media_kind VARCHAR(32) NOT NULL,
  mime_type VARCHAR(191) NULL,
  title VARCHAR(512) NULL,
  artist VARCHAR(512) NULL,
  album VARCHAR(512) NULL,
  duration_ms BIGINT UNSIGNED NULL,
  size_bytes BIGINT UNSIGNED NULL,
  mtime_ns BIGINT UNSIGNED NULL,
  metadata_json JSON NULL,
  catalog_status VARCHAR(32) NOT NULL DEFAULT 'pending',
  last_seen_scan_id BIGINT UNSIGNED NULL,
  last_error TEXT NULL,
  indexed_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  deleted_at TIMESTAMP(6) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_media_items_root_path (root_id, path_hash),
  UNIQUE KEY uq_media_items_legacy_checksum (legacy_checksum),
  KEY ix_media_items_kind_deleted (media_kind, deleted_at),
  KEY ix_media_items_artist (artist(191)),
  KEY ix_media_items_root_scan (root_id, last_seen_scan_id),
  KEY ix_media_items_album (album(191)),
  CONSTRAINT fk_media_items_root FOREIGN KEY (root_id) REFERENCES media_roots (id) ON DELETE RESTRICT,
  CONSTRAINT chk_media_items_kind CHECK (media_kind IN ('audio', 'video', 'image', 'other')),
  CONSTRAINT fk_media_items_scan FOREIGN KEY (last_seen_scan_id) REFERENCES catalog_scans (id) ON DELETE SET NULL,
  CONSTRAINT chk_media_items_catalog_status CHECK (catalog_status IN ('pending', 'legacy', 'ready', 'missing', 'error'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
-- migrate:split
CREATE TABLE IF NOT EXISTS user_ratings (
  user_id BIGINT UNSIGNED NOT NULL,
  media_item_id BIGINT UNSIGNED NOT NULL,
  rating DECIMAL(2,1) NULL,
  favorite TINYINT(1) NOT NULL DEFAULT 0,
  updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (user_id, media_item_id),
  CONSTRAINT fk_user_ratings_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_user_ratings_item FOREIGN KEY (media_item_id) REFERENCES media_items (id) ON DELETE CASCADE,
  CONSTRAINT chk_user_ratings_value CHECK (rating IS NULL OR rating BETWEEN 0.5 AND 5.0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
-- migrate:split
CREATE TABLE IF NOT EXISTS playback_stats (
  user_id BIGINT UNSIGNED NOT NULL,
  media_item_id BIGINT UNSIGNED NOT NULL,
  play_count BIGINT UNSIGNED NOT NULL DEFAULT 0,
  last_position_ms BIGINT UNSIGNED NOT NULL DEFAULT 0,
  last_played_at TIMESTAMP(6) NULL,
  updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (user_id, media_item_id),
  KEY ix_playback_stats_recent (user_id, last_played_at),
  CONSTRAINT fk_playback_stats_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_playback_stats_item FOREIGN KEY (media_item_id) REFERENCES media_items (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
-- migrate:split
CREATE TABLE IF NOT EXISTS media_play_totals (
  media_item_id BIGINT UNSIGNED NOT NULL,
  play_count BIGINT UNSIGNED NOT NULL DEFAULT 0,
  last_played_at TIMESTAMP(6) NULL,
  updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (media_item_id),
  CONSTRAINT fk_media_play_totals_item FOREIGN KEY (media_item_id) REFERENCES media_items (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
-- migrate:split
CREATE TABLE IF NOT EXISTS background_jobs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  job_type VARCHAR(64) NOT NULL,
  payload_json JSON NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'queued',
  attempts SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  available_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  leased_until TIMESTAMP(6) NULL,
  last_error TEXT NULL,
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  KEY ix_background_jobs_claim (status, available_at, leased_until),
  CONSTRAINT chk_background_jobs_status CHECK (status IN ('queued', 'running', 'done', 'failed'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
-- migrate:split
CREATE TABLE IF NOT EXISTS legacy_import_runs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  source_database VARCHAR(64) NOT NULL,
  report_json JSON NOT NULL,
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
-- migrate:split
CREATE TABLE IF NOT EXISTS legacy_import_orphans (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  import_run_id BIGINT UNSIGNED NOT NULL,
  record_kind VARCHAR(32) NOT NULL,
  legacy_checksum CHAR(64) NOT NULL,
  legacy_user_id BIGINT UNSIGNED NULL,
  payload_json JSON NOT NULL,
  reconciled_media_item_id BIGINT UNSIGNED NULL,
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  reconciled_at TIMESTAMP(6) NULL,
  PRIMARY KEY (id),
  KEY ix_legacy_orphans_pending (record_kind, reconciled_at),
  KEY ix_legacy_orphans_checksum (legacy_checksum),
  CONSTRAINT fk_legacy_orphans_run FOREIGN KEY (import_run_id) REFERENCES legacy_import_runs (id) ON DELETE CASCADE,
  CONSTRAINT fk_legacy_orphans_item FOREIGN KEY (reconciled_media_item_id) REFERENCES media_items (id) ON DELETE SET NULL,
  CONSTRAINT chk_legacy_orphans_kind CHECK (record_kind IN ('rating', 'playback'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
