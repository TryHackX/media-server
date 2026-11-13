-- "Nie proponuj": what an account asked the start page to stop offering.
--
-- The start page's shelves (recently added, recommended, popular, next
-- episodes, "surprise me") are suggestions, and a suggestion nobody can decline
-- is an advertisement. A dismissal is kept per account and names either one
-- file or one folder (an album, a season); the shelves leave both out from then
-- on. It says nothing about the file itself: play history, ratings and the
-- library are untouched, and `playback_stats.continue_hidden_at` (migration
-- 028) stays what hides a title from "continue".
--
-- No foreign key to the subject: it is one of two tables, and catalogue rows
-- are never deleted, only marked missing. Rows go with their account.

CREATE TABLE IF NOT EXISTS home_dismissals (
  user_id BIGINT UNSIGNED NOT NULL,
  subject_kind VARCHAR(8) NOT NULL,
  subject_id BIGINT UNSIGNED NOT NULL,
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (user_id, subject_kind, subject_id),
  CONSTRAINT fk_home_dismissals_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT chk_home_dismissals_kind CHECK (subject_kind IN ('item', 'folder'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
