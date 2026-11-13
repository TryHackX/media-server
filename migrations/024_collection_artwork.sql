-- Own cover art for a playlist (user collection).
--
-- The image lives in its own table rather than in a user_collections column:
-- every collection listing reads the whole user_collections row, and a
-- MEDIUMBLOB there would be carried through each of those queries. This mirrors
-- media_artwork_overrides, which does the same for a track's cover, so the two
-- preview endpoints stay symmetrical. A playlist without a row here falls back
-- to a cover drawn from the tracks it contains, exactly like a folder card.

CREATE TABLE IF NOT EXISTS user_collection_artwork (
  collection_id BIGINT UNSIGNED NOT NULL,
  mime_type VARCHAR(32) NOT NULL,
  image_data MEDIUMBLOB NOT NULL,
  content_hash BINARY(32) NOT NULL,
  updated_by BIGINT UNSIGNED NOT NULL,
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (collection_id),
  KEY ix_collection_artwork_user (updated_by, updated_at),
  CONSTRAINT fk_collection_artwork_collection FOREIGN KEY (collection_id)
    REFERENCES user_collections (id) ON DELETE CASCADE,
  CONSTRAINT fk_collection_artwork_user FOREIGN KEY (updated_by)
    REFERENCES users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
