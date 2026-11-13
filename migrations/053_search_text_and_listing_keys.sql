-- What a listing reads on every page, made cheap to read.
--
-- 1. `search_text` — the text a search looks through, folded once.
--    A search compared, for every file of a library and five times each (the
--    phrase and four words), a string it first had to build: title, path,
--    artist, album and two values dug out of the JSON column, concatenated,
--    with `_`, `-`, `.` and `/` turned into spaces and everything lowered —
--    then did all of it again for the count. Now that string is a stored
--    generated column: built when the row is written, by the database, so the
--    scanner and the tag reader fill it without knowing it exists. An override
--    (a title somebody corrected) carries its own, and a search reads both, so
--    a file is found by its corrected tags and still by its original ones.
--
-- 2. `user_ratings (media_item_id, rating, favorite)` — every listing joins the
--    average rating of each file, grouped from everybody's ratings; with this
--    key that grouping reads the index alone and never the rows.
--
-- 3. `bridge_cache` — a few answers that cost a pass over a whole library and
--    change only when the catalogue does (which filters a library can offer,
--    how many files it holds). Kept per key with the scan they were computed
--    after and their age; nothing personal is ever stored in it.

ALTER TABLE media_items
  ADD COLUMN search_text TEXT GENERATED ALWAYS AS (
    LOWER(REPLACE(REPLACE(REPLACE(REPLACE(CONCAT_WS(' ',
      COALESCE(title, ''),
      relative_path,
      COALESCE(artist, ''),
      COALESCE(album, ''),
      COALESCE(JSON_UNQUOTE(JSON_EXTRACT(metadata_json, '$.audio.genre')), ''),
      COALESCE(JSON_UNQUOTE(JSON_EXTRACT(metadata_json, '$.audio.year')), '')
    ), '_', ' '), '-', ' '), '.', ' '), '/', ' '))
  ) STORED
-- migrate:split
ALTER TABLE media_metadata_overrides
  ADD COLUMN search_text TEXT GENERATED ALWAYS AS (
    LOWER(REPLACE(REPLACE(REPLACE(REPLACE(CONCAT_WS(' ', title, artist, album, genre, year),
      '_', ' '), '-', ' '), '.', ' '), '/', ' '))
  ) STORED
-- migrate:split
ALTER TABLE user_ratings
  ADD KEY ix_user_ratings_item_values (media_item_id, rating, favorite)
-- migrate:split
CREATE TABLE IF NOT EXISTS bridge_cache (
  cache_key VARCHAR(64) NOT NULL,
  marker VARCHAR(64) NOT NULL,
  payload_json MEDIUMTEXT NOT NULL,
  stored_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (cache_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
