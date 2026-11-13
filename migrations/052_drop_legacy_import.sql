-- The legacy import is over: what it left behind goes.
--
-- The first installation was filled from an older application. Three things
-- remained of that and nothing reads any of them:
--
--   * `media_items.legacy_checksum` — SHA-256 of the *path* in the old system
--     (never of the content), with a unique index, used once to carry ratings
--     and play counts over;
--   * `legacy_import_runs` and `legacy_import_orphans` — the import's report
--     and the ratings whose files it could not find (the decision of 09.11.2026
--     to keep those rows was reversed by the owner on 11.11.2026);
--   * catalogue status 'legacy' — "imported, not yet seen by a scan". The first
--     scan turned every such row into 'ready'; a row still carrying it is made
--     'ready' here, which is how every listing treated it anyway.
--
-- The scanner names its columns and never wrote any of these, so a service
-- started before this migration keeps running.

DROP TABLE IF EXISTS legacy_import_orphans
-- migrate:split
DROP TABLE IF EXISTS legacy_import_runs
-- migrate:split
ALTER TABLE media_items
  DROP INDEX uq_media_items_legacy_checksum,
  DROP COLUMN legacy_checksum
-- migrate:split
UPDATE media_items SET catalog_status = 'ready' WHERE catalog_status = 'legacy'
-- migrate:split
ALTER TABLE media_items
  DROP CONSTRAINT chk_media_items_catalog_status
-- migrate:split
ALTER TABLE media_items
  ADD CONSTRAINT chk_media_items_catalog_status CHECK (catalog_status IN ('pending', 'ready', 'missing', 'error'))
