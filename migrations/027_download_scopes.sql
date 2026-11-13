-- One "may download" flag was too blunt.
--
-- Handing somebody a single track is a different decision from letting them pull
-- the whole library as one archive, but both hid behind can_download. The flag
-- splits into the four kinds of download the interface actually offers, and each
-- group gains a whitelist of file extensions it may take (empty = anything).
--
-- Every existing group keeps exactly what it had: the old value is copied into
-- all four columns before the old one goes, so nobody gains or loses a right in
-- the migration itself.

ALTER TABLE permission_groups
  ADD COLUMN can_download_file TINYINT(1) NOT NULL DEFAULT 0 AFTER can_download,
  ADD COLUMN can_download_selection TINYINT(1) NOT NULL DEFAULT 0 AFTER can_download_file,
  ADD COLUMN can_download_folder TINYINT(1) NOT NULL DEFAULT 0 AFTER can_download_selection,
  ADD COLUMN can_download_library TINYINT(1) NOT NULL DEFAULT 0 AFTER can_download_folder,
  ADD COLUMN download_extensions VARCHAR(255) NOT NULL DEFAULT '' AFTER can_download_library
-- migrate:split
UPDATE permission_groups
   SET can_download_file = can_download,
       can_download_selection = can_download,
       can_download_folder = can_download,
       can_download_library = can_download
-- migrate:split
ALTER TABLE permission_groups
  DROP COLUMN can_download
