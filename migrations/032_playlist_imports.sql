-- A place for an import to wait until somebody has read it.
--
-- Importing a playlist is the same problem as looking up a genre, and it gets
-- the same answer: a file says "01 - Intro.mp3" and the library holds four of
-- those, so the choice is between guessing and asking. Guessing here is worse
-- than usual, because a wrong pick is silent — the playlist simply plays the
-- wrong recording, and nothing on screen ever explains why.
--
-- So an upload lands here first, resolved as far as it can be resolved, and
-- what could not be settled waits with its candidates. Nothing reaches
-- user_collection_items or user_ratings until the person who uploaded it says so.
--
-- Three ways an entry finds its item, in the order they are tried:
--
--   fingerprint  the file itself, recognised anywhere (migration 031). This is
--                the only one that works between installations.
--   item id      our own export, restoring into the server that wrote it.
--   file name    somebody else's playlist. The ambiguous case, and the reason
--                this table exists.
--
-- Ratings ride in the same shape rather than a second pair of tables: an
-- imported rating is an entry that resolves to an item and carries a number,
-- which is a playlist entry with two more columns, not a different problem.

CREATE TABLE IF NOT EXISTS playlist_imports (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  kind VARCHAR(16) NOT NULL,
  source_name VARCHAR(255) NOT NULL,
  media_kind VARCHAR(16) NOT NULL DEFAULT 'music',
  collection_id BIGINT UNSIGNED NULL DEFAULT NULL,
  collection_name VARCHAR(191) NULL DEFAULT NULL,
  total_entries INT UNSIGNED NOT NULL DEFAULT 0,
  matched_entries INT UNSIGNED NOT NULL DEFAULT 0,
  status VARCHAR(16) NOT NULL DEFAULT 'review',
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  KEY ix_playlist_imports_user (user_id, status, id),
  -- An import belongs to the account that uploaded it and to nobody else, so it
  -- goes when the account does.
  CONSTRAINT fk_playlist_imports_user FOREIGN KEY (user_id)
    REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_playlist_imports_collection FOREIGN KEY (collection_id)
    REFERENCES user_collections (id) ON DELETE SET NULL,
  CONSTRAINT chk_playlist_imports_kind CHECK (kind IN ('playlist', 'ratings')),
  CONSTRAINT chk_playlist_imports_status CHECK (status IN ('review', 'applied', 'discarded'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
-- migrate:split
CREATE TABLE IF NOT EXISTS playlist_import_entries (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  import_id BIGINT UNSIGNED NOT NULL,
  position INT UNSIGNED NOT NULL DEFAULT 0,
  -- What the file said, kept verbatim so the review screen can show the line a
  -- decision is actually about.
  raw_label VARCHAR(512) NOT NULL,
  raw_fingerprint CHAR(32) NULL DEFAULT NULL,
  media_item_id BIGINT UNSIGNED NULL DEFAULT NULL,
  matched_by VARCHAR(16) NULL DEFAULT NULL,
  state VARCHAR(16) NOT NULL DEFAULT 'missing',
  candidates_json JSON NULL DEFAULT NULL,
  rating DECIMAL(2,1) NULL DEFAULT NULL,
  favorite TINYINT(1) NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  KEY ix_playlist_import_entries_import (import_id, state, position),
  CONSTRAINT fk_playlist_import_entries_import FOREIGN KEY (import_id)
    REFERENCES playlist_imports (id) ON DELETE CASCADE,
  CONSTRAINT fk_playlist_import_entries_item FOREIGN KEY (media_item_id)
    REFERENCES media_items (id) ON DELETE CASCADE,
  CONSTRAINT chk_playlist_import_entries_state
    CHECK (state IN ('matched', 'ambiguous', 'missing', 'skipped'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
