-- When a file entered the catalogue.
--
-- `indexed_at` could not answer that: every scan rewrites it for every file it
-- sees, new or not, so the whole library always carried the time of the last
-- scan. The weekly digest counted `indexed_at > since` as "new" (20 367 of
-- 20 367 files, the morning this was found) and smart lists ordered "recently
-- added" by it.
--
-- `created_at` is written once, by the column default, when the scanner inserts
-- the row, and no statement updates it afterwards — the scanner's upsert names
-- its columns, so a service that predates this column keeps working and fills
-- it correctly for new files without knowing it exists.
--
-- Rows that are already here get the best date the catalogue can still prove.
-- A scan records how many files it added (`catalog_scans.new_count`) and ids
-- only grow, so the newest `new_count` rows of a root belong to its latest scan
-- that added anything, the ones before them to the scan before, and so on.
-- (Checked on the first installation against the metadata queue, which dates
-- every file's first job: the two agree to the file.) Whatever is older than
-- the first counted scan — rows brought in before scans were counted — is dated
-- by the root's first completed scan: "old", which is all that can be said.

ALTER TABLE media_items
  ADD COLUMN created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) AFTER indexed_at
-- migrate:split
UPDATE media_items mi
LEFT JOIN (
  SELECT root_id, MIN(started_at) AS first_scan
  FROM catalog_scans
  WHERE status = 'completed'
  GROUP BY root_id
) scans ON scans.root_id = mi.root_id
SET mi.created_at = LEAST(mi.indexed_at, COALESCE(scans.first_scan, mi.indexed_at))
-- migrate:split
UPDATE media_items mi
INNER JOIN (
  SELECT ranked.id, scan_window.started_at
  FROM (
    SELECT id, root_id, ROW_NUMBER() OVER (PARTITION BY root_id ORDER BY id DESC) AS newest_rank
    FROM media_items
  ) ranked
  INNER JOIN (
    SELECT root_id, started_at,
           SUM(new_count) OVER (PARTITION BY root_id ORDER BY id DESC) AS newest_through,
           SUM(new_count) OVER (PARTITION BY root_id ORDER BY id DESC) - new_count AS newest_after
    FROM catalog_scans
    WHERE status = 'completed' AND new_count > 0
  ) scan_window
    ON scan_window.root_id = ranked.root_id
   AND ranked.newest_rank > scan_window.newest_after
   AND ranked.newest_rank <= scan_window.newest_through
) dated ON dated.id = mi.id
SET mi.created_at = dated.started_at
-- migrate:split
ALTER TABLE media_items
  ADD KEY ix_media_items_created (media_kind, created_at)
