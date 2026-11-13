-- Anti-bot stage 2, part A: more captcha providers.
--
-- captcha_spent: proof-of-work challenges (ProofOfWork) already used, kept
-- until they expire so one solution cannot be presented twice. Times are unix
-- seconds of the PHP clock (PHP and MySQL run in different time zones here).
--
-- Each provider gets its own site key and secret, so switching providers keeps
-- the others' keys; the single pair moves onto the provider that was selected,
-- and the old rows go (a secret is not kept in two places). "Protect sign-in"
-- becomes a mode: on stays "always", off becomes "after N failures" — with no
-- provider configured, that asks for proof of work.

CREATE TABLE IF NOT EXISTS captcha_spent (
  challenge CHAR(64) NOT NULL,
  expires_at BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (challenge),
  KEY captcha_spent_expiry (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- migrate:split

INSERT INTO app_settings (setting_key, setting_value)
SELECT CONCAT('captcha_site_key_', p.setting_value), k.setting_value
FROM app_settings p
INNER JOIN app_settings k ON k.setting_key = 'captcha_site_key'
WHERE p.setting_key = 'captcha_provider' AND p.setting_value IN ('recaptcha', 'hcaptcha', 'turnstile')
ON DUPLICATE KEY UPDATE setting_value = app_settings.setting_value;

-- migrate:split

INSERT INTO app_settings (setting_key, setting_value)
SELECT CONCAT('captcha_secret_key_', p.setting_value), k.setting_value
FROM app_settings p
INNER JOIN app_settings k ON k.setting_key = 'captcha_secret_key'
WHERE p.setting_key = 'captcha_provider' AND p.setting_value IN ('recaptcha', 'hcaptcha', 'turnstile')
ON DUPLICATE KEY UPDATE setting_value = app_settings.setting_value;

-- migrate:split

DELETE FROM app_settings WHERE setting_key IN ('captcha_site_key', 'captcha_secret_key');

-- migrate:split

INSERT INTO app_settings (setting_key, setting_value)
SELECT 'captcha_login_mode', IF(s.setting_value = '1', 'always', 'after')
FROM app_settings s WHERE s.setting_key = 'captcha_protect_login'
ON DUPLICATE KEY UPDATE setting_value = app_settings.setting_value;
