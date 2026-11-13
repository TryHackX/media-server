-- Own the accounts outright.
--
-- Sign-in used to run through the legacy portal, which authenticated against a
-- separate database and only left a session behind for this application to
-- trust. From here the service verifies passwords itself, so everything an
-- account needs lives in this schema.

ALTER TABLE users
  ADD COLUMN email_verified_at TIMESTAMP(6) NULL DEFAULT NULL AFTER email,
  ADD COLUMN last_login_at TIMESTAMP(6) NULL DEFAULT NULL AFTER email_verified_at;

-- migrate:split

-- Two accounts must never share an address, or account recovery becomes
-- ambiguous. NULL stays repeatable, which keeps the imported accounts valid
-- until somebody fills their address in.
CREATE UNIQUE INDEX users_email_unique ON users (email);

-- migrate:split

-- Existing accounts predate the whole idea of verification. Treat them as
-- already confirmed so nobody is locked out by this migration.
UPDATE users SET email_verified_at = created_at WHERE email_verified_at IS NULL;

-- migrate:split

CREATE TABLE IF NOT EXISTS user_activation_tokens (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  purpose VARCHAR(32) NOT NULL DEFAULT 'activation',
  -- Only the digest is kept: a leaked table must not hand out working links.
  token_hash CHAR(64) NOT NULL,
  expires_at TIMESTAMP(6) NOT NULL,
  consumed_at TIMESTAMP(6) NULL DEFAULT NULL,
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY user_activation_tokens_hash (token_hash),
  KEY user_activation_tokens_user (user_id, purpose),
  CONSTRAINT user_activation_tokens_user_fk FOREIGN KEY (user_id)
    REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- migrate:split

-- Throttling for sign-in and sign-up. The client address is stored as a digest
-- so the table is useless for tracking anyone.
CREATE TABLE IF NOT EXISTS auth_attempts (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  kind VARCHAR(16) NOT NULL,
  client_hash CHAR(64) NOT NULL,
  identifier VARCHAR(191) NOT NULL DEFAULT '',
  succeeded TINYINT(1) NOT NULL DEFAULT 0,
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  KEY auth_attempts_window (kind, client_hash, created_at),
  KEY auth_attempts_identifier (kind, identifier, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- migrate:split

INSERT INTO app_settings (setting_key, setting_value)
VALUES
  ('registration_enabled', '0'),
  ('registration_default_role', 'user'),
  ('registration_requires_activation', '1')
ON DUPLICATE KEY UPDATE setting_value = setting_value;
