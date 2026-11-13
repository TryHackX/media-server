-- Per-account interface preferences.
--
-- Settings that belong to a person rather than to the installation (what the
-- playback queue shows, later also language) live with the account, so they
-- follow the listener between devices instead of sitting in one browser's
-- localStorage. Stored as JSON because the set is small, read whole with the
-- session and never queried by key.

ALTER TABLE users
  ADD COLUMN preferences_json JSON NULL DEFAULT NULL AFTER profile_public;
