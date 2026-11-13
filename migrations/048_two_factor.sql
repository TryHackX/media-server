-- Account security stage 2, part C: TOTP two-factor sign-in (TwoFactor).
--
-- The secret is AES-256-GCM ciphertext under a key derived from the bridge's
-- private transfer key (never stored here), bound to its account; recovery
-- codes are keyed digests. Times are unix seconds of the PHP clock.

CREATE TABLE IF NOT EXISTS user_two_factor (
  user_id BIGINT UNSIGNED NOT NULL,
  secret_ciphertext VARCHAR(255) NOT NULL,
  enabled_at BIGINT UNSIGNED NULL DEFAULT NULL,
  pending_since BIGINT UNSIGNED NOT NULL,
  last_step BIGINT UNSIGNED NULL DEFAULT NULL,
  recovery_codes TEXT NULL,
  PRIMARY KEY (user_id),
  CONSTRAINT user_two_factor_user_fk FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
