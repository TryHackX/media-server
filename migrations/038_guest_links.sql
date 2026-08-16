-- A link that lets somebody without an account hear one folder or one playlist.
--
-- The need is ordinary: "listen to this album", "here are the holiday films" —
-- sent to a person who will never have a login here. Until now the only answers
-- were to create them an account or to copy the files out, and both are worse
-- than the problem.
--
-- What a link carries is deliberately narrow. It names **one** target, it stops
-- working on a date, and it counts downloads against a budget the person who
-- made it chose. Nothing about it is a second permission system: when the link
-- is used, the transfer is issued **as its author**, through the same gateway,
-- the same library rights and the same extension whitelist that account has
-- always had. A guest can therefore never reach anything its author could not,
-- and the traffic is charged where it belongs.
--
-- The token itself is never stored — only its SHA-256, exactly as `user_sessions`
-- keeps session identifiers. A leaked database cannot be turned back into a
-- working link, and the price is that a lost link cannot be recovered, only
-- reissued. That is the right way round.
--
-- Revocation is a column rather than a delete, so a link that was handed out and
-- then withdrawn still shows in the list with the reason it stopped working.
-- `downloads_used` is kept next to `max_downloads` for the same reason: after
-- the fact, "it ran out" and "I turned it off" are different stories.

CREATE TABLE IF NOT EXISTS guest_links (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  token_hash BINARY(32) NOT NULL,
  created_by BIGINT UNSIGNED NOT NULL,
  target_kind VARCHAR(16) NOT NULL,
  target_id BIGINT UNSIGNED NOT NULL,
  label VARCHAR(191) NOT NULL DEFAULT '',
  max_downloads INT UNSIGNED NOT NULL DEFAULT 0,
  downloads_used INT UNSIGNED NOT NULL DEFAULT 0,
  expires_at TIMESTAMP(6) NOT NULL,
  last_used_at TIMESTAMP(6) NULL,
  revoked_at TIMESTAMP(6) NULL,
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_guest_links_token (token_hash),
  KEY ix_guest_links_author (created_by, created_at),
  CONSTRAINT fk_guest_links_author FOREIGN KEY (created_by)
    REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT chk_guest_links_kind CHECK (target_kind IN ('directory', 'collection'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
