INSERT INTO app_settings (setting_key, setting_value)
VALUES ('compatibility_video_profile', 'native_copy')
ON DUPLICATE KEY UPDATE setting_value = 'native_copy';
