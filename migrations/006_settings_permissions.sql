CREATE TABLE IF NOT EXISTS role_permissions (
  role_group VARCHAR(16) NOT NULL,
  can_download TINYINT(1) NOT NULL DEFAULT 1,
  can_rate TINYINT(1) NOT NULL DEFAULT 1,
  can_favorite TINYINT(1) NOT NULL DEFAULT 1,
  can_create_collections TINYINT(1) NOT NULL DEFAULT 1,
  can_share TINYINT(1) NOT NULL DEFAULT 1,
  updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (role_group),
  CONSTRAINT chk_role_permissions_group CHECK (role_group IN ('user', 'guest'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
-- migrate:split
INSERT INTO role_permissions
  (role_group, can_download, can_rate, can_favorite, can_create_collections, can_share)
VALUES
  ('user', 1, 1, 1, 1, 1),
  ('guest', 0, 0, 0, 0, 0)
ON DUPLICATE KEY UPDATE role_group = VALUES(role_group)
-- migrate:split
CREATE TABLE IF NOT EXISTS app_settings (
  setting_key VARCHAR(64) NOT NULL,
  setting_value VARCHAR(191) NOT NULL,
  updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (setting_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
-- migrate:split
INSERT INTO app_settings (setting_key, setting_value)
VALUES
  ('music_sort', 'title_asc'),
  ('movies_sort', 'title_asc'),
  ('compatibility_audio_profile', 'stereo_standard'),
  ('account_page_size', '20')
ON DUPLICATE KEY UPDATE setting_key = VALUES(setting_key)
