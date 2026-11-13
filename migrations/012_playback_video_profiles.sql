INSERT INTO app_settings (setting_key, setting_value)
VALUES
  ('playback_threshold_percent', '15'),
  ('compatibility_video_profile', 'balanced_1080p')
ON DUPLICATE KEY UPDATE setting_value = setting_value;

-- migrate:split

UPDATE app_settings
SET setting_value = CASE
  WHEN setting_value = 'enhanced-snow' THEN ''
  ELSE TRIM(BOTH ',' FROM REPLACE(REPLACE(setting_value, 'enhanced-snow,', ''), ',enhanced-snow', ''))
END
WHERE setting_key IN ('visualizer_order', 'visualizer_enabled');
