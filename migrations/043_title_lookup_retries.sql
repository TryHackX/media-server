-- A title lookup that failed is tried again later, and later still if it keeps failing.
--
-- One bad answer from Filmweb used to stop the whole queue. Only FilmwebError was
-- caught, so a record the parser choked on (a year written as "2006-2010", a field
-- that was an object yesterday and a string today) ended the run — and because the
-- answer was cached for 30 days and the row stayed first in line, every run for the
-- next 30 days ended on the same row. A failure now belongs to its row: the run
-- goes on, and the row comes back after a pause that grows with each failure in a
-- row (an hour, six, a day, three days, a week, then a month), instead of either
-- blocking everything or waiting the 90 days a settled answer waits.
--
-- `attempts` counts failures since the last answer that was not a failure;
-- `retry_at` is when the row may be asked again. Both are cleared by any other
-- outcome. Rows that failed before this have neither and keep the old 90-day
-- recheck.

ALTER TABLE media_title_lookups
  ADD COLUMN attempts SMALLINT UNSIGNED NOT NULL DEFAULT 0 AFTER last_error,
  ADD COLUMN retry_at TIMESTAMP(6) NULL DEFAULT NULL AFTER attempts,
  ADD KEY ix_media_title_lookups_retry (status, retry_at)
