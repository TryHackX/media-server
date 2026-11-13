-- Richer permission groups, configurable download windows and schema clean-up.
--
-- Groups gain per-library access (music/movies), the right to use the FFmpeg
-- compatibility mode, the right to edit tags/artwork, a configurable window for
-- the download quota (minutes instead of a fixed hour) and a cap on simultaneous
-- downloads. The group is now the single source of truth for the guest flag:
-- users.is_guest mirrors membership of the system 'guest' group.
--
-- Also retires what nothing reads any more: the legacy role_permissions matrix
-- (superseded by permission_groups in 017), the never-used user_sessions table
-- (sessions are native PHP sessions) and the duplicate unique index on
-- users.email created by 015 next to uq_users_email from 001.

ALTER TABLE permission_groups
  RENAME COLUMN download_limit_per_hour TO download_limit;

-- migrate:split

ALTER TABLE permission_groups
  ADD COLUMN can_access_music TINYINT(1) NOT NULL DEFAULT 1 AFTER can_share,
  ADD COLUMN can_access_movies TINYINT(1) NOT NULL DEFAULT 1 AFTER can_access_music,
  ADD COLUMN can_stream_compat TINYINT(1) NOT NULL DEFAULT 1 AFTER can_access_movies,
  ADD COLUMN can_edit_metadata TINYINT(1) NOT NULL DEFAULT 0 AFTER can_stream_compat,
  ADD COLUMN download_window_minutes INT NOT NULL DEFAULT 60 AFTER download_limit,
  ADD COLUMN max_concurrent_downloads INT NOT NULL DEFAULT 0 AFTER download_window_minutes;

-- migrate:split

-- The global quota keeps its value under a window-neutral key.
INSERT INTO app_settings (setting_key, setting_value)
SELECT 'download_rate_limit', setting_value FROM app_settings WHERE setting_key = 'download_rate_limit_per_hour'
ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value);

-- migrate:split

INSERT IGNORE INTO app_settings (setting_key, setting_value) VALUES ('download_rate_window_minutes', '60');

-- migrate:split

DELETE FROM app_settings WHERE setting_key = 'download_rate_limit_per_hour';

-- migrate:split

-- Privileged accounts never belong to the guest group (the guest flag would
-- silently strip their rights); move any such account to the user group first.
UPDATE users u
INNER JOIN permission_groups g ON g.id = u.permission_group_id AND g.slug = 'guest'
INNER JOIN permission_groups target ON target.slug = 'user'
SET u.permission_group_id = target.id
WHERE u.role IN ('admin', 'super_admin');

-- migrate:split

-- Mirror the guest flag from group membership; accounts without a group keep
-- their flag, which the reader still uses as the fallback.
UPDATE users u
INNER JOIN permission_groups g ON g.id = u.permission_group_id
SET u.is_guest = CASE WHEN g.slug = 'guest' THEN 1 ELSE 0 END;

-- migrate:split

DROP TABLE IF EXISTS role_permissions;

-- migrate:split

DROP TABLE IF EXISTS user_sessions;

-- migrate:split

DROP INDEX users_email_unique ON users;
