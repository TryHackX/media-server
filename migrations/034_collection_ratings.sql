-- Stars on the playlist itself, not on what is inside it.
--
-- A collection already carried an average, but it was an average *of its
-- tracks*: add ten five-star songs and the list reads five stars without
-- anybody having said a word about the list. That number answers "how good is
-- this music", which the track ratings already answered. Nobody could say "this
-- is a good selection" — and a selection is the only thing a playlist actually
-- is, since it owns no files.
--
-- So a vote here belongs to the pair (person, list). The row exists only while
-- somebody holds an opinion: clearing a rating deletes the row rather than
-- setting it to NULL, which is why `rating` is NOT NULL — unlike user_ratings,
-- where a row may exist for the favourite alone and carry no rating at all.
--
-- Both foreign keys cascade. Deleting a playlist takes its votes with it, and
-- deleting an account takes the votes it cast; neither should be able to hold
-- the other hostage, and a vote whose author is gone is not evidence of
-- anything. The tracks' own average stays where it was and keeps its own
-- meaning, now named for what it is.

CREATE TABLE IF NOT EXISTS user_collection_ratings (
  user_id BIGINT UNSIGNED NOT NULL,
  collection_id BIGINT UNSIGNED NOT NULL,
  rating DECIMAL(2,1) NOT NULL,
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (user_id, collection_id),
  KEY ix_collection_ratings_collection (collection_id),
  CONSTRAINT fk_collection_ratings_user FOREIGN KEY (user_id)
    REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_collection_ratings_collection FOREIGN KEY (collection_id)
    REFERENCES user_collections (id) ON DELETE CASCADE,
  CONSTRAINT chk_collection_ratings_value CHECK (rating BETWEEN 0.5 AND 5.0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
