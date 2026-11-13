-- Which sessions are open right now, and a way to close one from elsewhere.
--
-- The panel could already say who logged in and when (`auth_attempts`, and
-- `users.last_login_at`), which is history. What it could not say is what is
-- *open*: a browser left signed in at somebody else's flat stays signed in, and
-- the only cure was changing the password. There was nothing to revoke, because
-- a PHP session lives in a file on disk and nothing in the database knew it
-- existed. An earlier `user_sessions` was dropped as dead code; this is the same
-- name for a table that is now actually used.
--
-- The session identifier itself is never stored — only its SHA-256. A row here
-- is therefore useless to anybody who reads the database: it can say "a session
-- exists and here is what it may do", and cannot be turned back into a cookie
-- that would sign somebody in. The same reasoning `auth_attempts` applies to the
-- client address, which is likewise kept as a hash and never shown.
--
-- Revocation is a flag, not a deletion, and it takes effect on the revoked
-- session's next request: the bridge looks the row up on every authenticated
-- call, and a revoked one is refused and destroyed there and then. Deleting
-- another browser's session file directly would mean knowing its identifier —
-- exactly what is deliberately not kept.
--
-- `device_label` is the coarse name the queue's device list already uses
-- ("Windows · Chrome"): enough to tell the phone from the desktop, not a
-- fingerprint. `revoked_by` says who closed it — yourself or an administrator —
-- and is SET NULL rather than RESTRICT, so an account that once closed a session
-- can still be deleted.

CREATE TABLE IF NOT EXISTS user_sessions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  session_hash BINARY(32) NOT NULL,
  device_label VARCHAR(64) NOT NULL DEFAULT '',
  client_hash BINARY(32) NULL,
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  last_seen_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  revoked_at TIMESTAMP(6) NULL,
  revoked_by BIGINT UNSIGNED NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_user_sessions_hash (session_hash),
  KEY ix_user_sessions_user (user_id, last_seen_at),
  CONSTRAINT fk_user_sessions_user FOREIGN KEY (user_id)
    REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_user_sessions_revoker FOREIGN KEY (revoked_by)
    REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
