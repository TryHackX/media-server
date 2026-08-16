CREATE TABLE IF NOT EXISTS user_collections (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  name VARCHAR(191) NOT NULL,
  media_kind VARCHAR(32) NOT NULL,
  rules_json JSON NULL,
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_user_collections_name (user_id, media_kind, name),
  KEY ix_user_collections_user_updated (user_id, updated_at),
  CONSTRAINT fk_user_collections_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT chk_user_collections_kind CHECK (media_kind IN ('music', 'movies'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
-- migrate:split
CREATE TABLE IF NOT EXISTS user_collection_items (
  collection_id BIGINT UNSIGNED NOT NULL,
  media_item_id BIGINT UNSIGNED NOT NULL,
  position BIGINT UNSIGNED NOT NULL DEFAULT 0,
  added_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (collection_id, media_item_id),
  KEY ix_collection_items_order (collection_id, position, media_item_id),
  KEY ix_collection_items_media (media_item_id),
  CONSTRAINT fk_collection_items_collection FOREIGN KEY (collection_id) REFERENCES user_collections (id) ON DELETE CASCADE,
  CONSTRAINT fk_collection_items_media FOREIGN KEY (media_item_id) REFERENCES media_items (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
-- migrate:split
CREATE TABLE IF NOT EXISTS media_artwork_overrides (
  media_item_id BIGINT UNSIGNED NOT NULL,
  mime_type VARCHAR(32) NOT NULL,
  image_data MEDIUMBLOB NOT NULL,
  content_hash BINARY(32) NOT NULL,
  updated_by BIGINT UNSIGNED NOT NULL,
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (media_item_id),
  KEY ix_artwork_overrides_user (updated_by, updated_at),
  CONSTRAINT fk_artwork_overrides_item FOREIGN KEY (media_item_id) REFERENCES media_items (id) ON DELETE CASCADE,
  CONSTRAINT fk_artwork_overrides_user FOREIGN KEY (updated_by) REFERENCES users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
