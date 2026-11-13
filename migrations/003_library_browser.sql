CREATE TABLE IF NOT EXISTS media_directories (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  root_id BIGINT UNSIGNED NOT NULL,
  relative_path TEXT NOT NULL,
  path_hash BINARY(32) NOT NULL,
  parent_path_hash BINARY(32) NULL,
  name VARCHAR(512) NOT NULL,
  depth SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  direct_file_count BIGINT UNSIGNED NOT NULL DEFAULT 0,
  descendant_file_count BIGINT UNSIGNED NOT NULL DEFAULT 0,
  total_size_bytes BIGINT UNSIGNED NOT NULL DEFAULT 0,
  preview_media_item_id BIGINT UNSIGNED NULL,
  last_seen_scan_id BIGINT UNSIGNED NULL,
  indexed_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  deleted_at TIMESTAMP(6) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_media_directories_root_path (root_id, path_hash),
  KEY ix_media_directories_parent (root_id, parent_path_hash, deleted_at),
  KEY ix_media_directories_scan (root_id, last_seen_scan_id),
  KEY ix_media_directories_preview (preview_media_item_id),
  CONSTRAINT fk_media_directories_root FOREIGN KEY (root_id) REFERENCES media_roots (id) ON DELETE RESTRICT,
  CONSTRAINT fk_media_directories_scan FOREIGN KEY (last_seen_scan_id) REFERENCES catalog_scans (id) ON DELETE SET NULL,
  CONSTRAINT fk_media_directories_preview FOREIGN KEY (preview_media_item_id) REFERENCES media_items (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
-- migrate:split
ALTER TABLE media_items
  ADD COLUMN directory_hash BINARY(32) NULL AFTER path_hash,
  ADD COLUMN file_extension VARCHAR(32) NULL AFTER mime_type,
  ADD KEY ix_media_items_directory (root_id, directory_hash, deleted_at, id)
-- migrate:split
CREATE TABLE IF NOT EXISTS media_metadata_overrides (
  media_item_id BIGINT UNSIGNED NOT NULL,
  title VARCHAR(512) NULL,
  artist VARCHAR(512) NULL,
  album VARCHAR(512) NULL,
  year VARCHAR(16) NULL,
  genre VARCHAR(191) NULL,
  updated_by BIGINT UNSIGNED NOT NULL,
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (media_item_id),
  KEY ix_metadata_overrides_user (updated_by, updated_at),
  CONSTRAINT fk_metadata_overrides_item FOREIGN KEY (media_item_id) REFERENCES media_items (id) ON DELETE CASCADE,
  CONSTRAINT fk_metadata_overrides_user FOREIGN KEY (updated_by) REFERENCES users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
-- migrate:split
CREATE TABLE IF NOT EXISTS audit_log (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  actor_user_id BIGINT UNSIGNED NULL,
  action VARCHAR(64) NOT NULL,
  target_type VARCHAR(64) NOT NULL,
  target_id VARCHAR(191) NULL,
  details_json JSON NULL,
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  KEY ix_audit_log_actor_created (actor_user_id, created_at),
  KEY ix_audit_log_target_created (target_type, target_id, created_at),
  CONSTRAINT fk_audit_log_actor FOREIGN KEY (actor_user_id) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
