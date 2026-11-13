-- Where an external genre came from, and what to do when it is not sure.
--
-- Migration 029 gave films a year and a genre; this is the record of how one
-- was obtained. It exists because the lookup is a guess dressed as a fact: a
-- file called "Batman i Robin 1080p Brrip x264 Lektor.pl" has to be turned into
-- a phrase, the phrase into a search, and the search into one title out of
-- several — and a wrong pick looks exactly like a right one once it is a genre
-- on a card. Nothing would ever prompt anybody to check it.
--
-- So the confidence is written down next to the answer, and anything the
-- matcher could not settle is kept here with its alternatives instead of being
-- guessed at. The owner reviews those in the panel and picks; that decision is
-- what decided_by and decided_at record, and it outranks any later refetch.
--
-- One row per *work*, not per file. An episode is looked up as its series, so
-- 250 episodes of Pokémon share one row and one answer — which is both the
-- honest shape (a genre belongs to the show) and the difference between a few
-- hundred requests to somebody else's server and a few thousand.
-- media_items.title_subject_hash is the link, written by the same catalogue
-- sweep that fills release_year, so membership never has to be re-derived from
-- a path in SQL or in PHP.
--
-- candidates_json carries each alternative's genres as well as its name, which
-- is what lets the panel apply a correction without going back to the network:
-- the answer was already fetched, it just was not the one chosen.

ALTER TABLE media_items
  ADD COLUMN title_subject_hash BINARY(32) NULL DEFAULT NULL AFTER release_year_source
-- migrate:split
ALTER TABLE media_items
  ADD KEY ix_media_items_title_subject (root_id, title_subject_hash)
-- migrate:split
CREATE TABLE IF NOT EXISTS media_title_lookups (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  root_id BIGINT UNSIGNED NOT NULL,
  subject_hash BINARY(32) NOT NULL,
  subject_key VARCHAR(512) NOT NULL,
  is_episode TINYINT(1) NOT NULL DEFAULT 0,
  query_title VARCHAR(512) NOT NULL,
  query_year SMALLINT UNSIGNED NULL DEFAULT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'pending',
  source VARCHAR(16) NOT NULL DEFAULT 'filmweb',
  external_id VARCHAR(32) NULL DEFAULT NULL,
  external_url VARCHAR(255) NULL DEFAULT NULL,
  matched_title VARCHAR(512) NULL DEFAULT NULL,
  matched_year SMALLINT UNSIGNED NULL DEFAULT NULL,
  confidence TINYINT UNSIGNED NOT NULL DEFAULT 0,
  item_count INT UNSIGNED NOT NULL DEFAULT 0,
  reasons_json JSON NULL DEFAULT NULL,
  candidates_json JSON NULL DEFAULT NULL,
  last_error TEXT NULL DEFAULT NULL,
  checked_at TIMESTAMP(6) NULL DEFAULT NULL,
  decided_by BIGINT UNSIGNED NULL DEFAULT NULL,
  decided_at TIMESTAMP(6) NULL DEFAULT NULL,
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_media_title_lookups_subject (root_id, subject_hash),
  KEY ix_media_title_lookups_status (status, confidence, id),
  CONSTRAINT fk_media_title_lookups_root FOREIGN KEY (root_id)
    REFERENCES media_roots (id) ON DELETE CASCADE,
  -- SET NULL rather than RESTRICT: a decision is worth keeping after the
  -- account that made it is gone, and an account that once confirmed a genre
  -- must not become undeletable because of it.
  CONSTRAINT fk_media_title_lookups_user FOREIGN KEY (decided_by)
    REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT chk_media_title_lookups_status
    CHECK (status IN ('pending', 'matched', 'review', 'none', 'failed', 'skipped'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
