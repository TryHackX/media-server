-- "Continue watching" needs a way to say "I am done with this one".
--
-- A resumable position is simply last_position_ms sitting between the start and
-- the end of a file, so the list needs no new storage — but a viewer who
-- abandons a film at 40% has no way to remove it without also losing the play
-- count and the date, which belong to the history rather than to the shelf.
--
-- continue_hidden_at is that dismissal: the row keeps its position, its count
-- and its date, and only stops being offered. Playing the file again clears it
-- (CatalogActions::playback on the 'start' event), so hiding is a decision about
-- now, not a permanent ban.
--
-- The index carries the flag between the account and the date so the query can
-- walk the account's recent rows with the dismissed ones already excluded.

ALTER TABLE playback_stats
  ADD COLUMN continue_hidden_at TIMESTAMP(6) NULL DEFAULT NULL AFTER last_played_at
-- migrate:split
ALTER TABLE playback_stats
  ADD KEY ix_playback_stats_continue (user_id, continue_hidden_at, last_played_at)
