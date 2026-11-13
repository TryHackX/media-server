-- An account that once changed a track's cover or tags can be deleted.
--
-- 003 and 004 gave both override tables `updated_by ... ON DELETE RESTRICT`, so
-- removing an account that had ever corrected a title or uploaded a cover failed
-- on the foreign key — the trap 025 already took out of playlist covers. Unlike a
-- playlist cover, these rows belong to the catalogue, not to their author: a
-- corrected title or a better cover is still right after the account is gone. So
-- the row stays and only the attribution clears, the same SET NULL as in 025.
-- Nothing reads updated_by for display; it is written on every save and kept for
-- the record, which the audit log holds as well.

ALTER TABLE media_artwork_overrides
  DROP FOREIGN KEY fk_artwork_overrides_user
-- migrate:split
ALTER TABLE media_artwork_overrides
  MODIFY COLUMN updated_by BIGINT UNSIGNED NULL DEFAULT NULL
-- migrate:split
ALTER TABLE media_artwork_overrides
  ADD CONSTRAINT fk_artwork_overrides_user FOREIGN KEY (updated_by)
    REFERENCES users (id) ON DELETE SET NULL
-- migrate:split
ALTER TABLE media_metadata_overrides
  DROP FOREIGN KEY fk_metadata_overrides_user
-- migrate:split
ALTER TABLE media_metadata_overrides
  MODIFY COLUMN updated_by BIGINT UNSIGNED NULL DEFAULT NULL
-- migrate:split
ALTER TABLE media_metadata_overrides
  ADD CONSTRAINT fk_metadata_overrides_user FOREIGN KEY (updated_by)
    REFERENCES users (id) ON DELETE SET NULL
