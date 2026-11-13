-- A playlist cover must not pin its uploader's account in place.
--
-- 024 copied the RESTRICT that media_artwork_overrides puts on updated_by. On a
-- track cover that key guards a row which outlives its uploader; on a playlist
-- cover it does not, because the cover belongs to the playlist and disappears
-- with it. The effect was that removing an account which had ever given a
-- playlist a cover failed on the foreign key before the collection cascade could
-- run. updated_by is attribution only, so it now clears instead of blocking.

ALTER TABLE user_collection_artwork
  DROP FOREIGN KEY fk_collection_artwork_user
-- migrate:split
ALTER TABLE user_collection_artwork
  MODIFY COLUMN updated_by BIGINT UNSIGNED NULL DEFAULT NULL
-- migrate:split
ALTER TABLE user_collection_artwork
  ADD CONSTRAINT fk_collection_artwork_user FOREIGN KEY (updated_by)
    REFERENCES users (id) ON DELETE SET NULL
