ALTER TABLE user_collections
  ADD COLUMN is_shared TINYINT(1) NOT NULL DEFAULT 0 AFTER rules_json,
  ADD INDEX idx_user_collections_shared (is_shared, media_kind, updated_at);

