-- Pluggable challenge in front of the account forms.
--
-- The provider is a setting rather than a build-time choice so the operator can
-- switch between reCAPTCHA, hCaptcha and Turnstile, or turn the whole thing off,
-- without a deploy. All three verify a token the same way, so one client covers
-- them.
--
-- captcha_secret_key is write-only from the panel: it is stored here but never
-- returned by the settings reader, which every signed-in client can call.

INSERT INTO app_settings (setting_key, setting_value)
VALUES
  ('captcha_provider', 'none'),
  ('captcha_site_key', ''),
  ('captcha_secret_key', ''),
  ('captcha_protect_login', '0'),
  ('captcha_protect_registration', '1'),
  ('download_rate_limit_per_hour', '0')
ON DUPLICATE KEY UPDATE setting_value = setting_value;
