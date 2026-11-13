-- Enforcement backbone for the M5 limits plus self-service account changes.
--
-- download_events records every non-inline transfer ticket at mint time, so the
-- per-hour limits from permission_groups/app_settings finally have something to
-- count against. user_activation_tokens gains a payload column so an e-mail
-- change can carry the new address inside the confirmation token instead of a
-- second table. user_collections gains a description shown on collection cards.

CREATE TABLE IF NOT EXISTS download_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  kind ENUM('file', 'archive') NOT NULL,
  item_count INT NOT NULL DEFAULT 1,
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  KEY download_events_user_window (user_id, created_at),
  CONSTRAINT download_events_user_fk FOREIGN KEY (user_id)
    REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- migrate:split

ALTER TABLE user_activation_tokens
  ADD COLUMN payload VARCHAR(254) NULL DEFAULT NULL AFTER token_hash;

-- migrate:split

ALTER TABLE user_collections
  ADD COLUMN description VARCHAR(500) NOT NULL DEFAULT '' AFTER name;
