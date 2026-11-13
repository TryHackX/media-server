-- The file list of a large archive, kept here instead of inside its token.
--
-- A transfer token carries everything the transfer service needs, sealed, and
-- for an archive that was every path in it. The bridge caps a token at 64 KiB,
-- so an archive of more than roughly 270 files could not be sealed at all: the
-- request ended in a 500, after the download had already been counted against
-- the account's limit. Past what fits comfortably, the list now waits here for
-- a few minutes and the token names it instead — the row's random key, the
-- SHA-256 of the stored list and the number of entries. The transfer service
-- reads the row when the archive is downloaded and checks the digest, so the
-- archive it builds is exactly the list the bridge sealed; the browser never
-- sees or sends a path, as before.
--
-- The list is stored as bytes, not as JSON: the digest covers these exact
-- bytes, and a JSON column would normalise them. A row lives as long as its
-- token plus a minute, and the bridge prunes expired rows as it writes new ones.

CREATE TABLE IF NOT EXISTS archive_manifests (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  manifest_key BINARY(32) NOT NULL,
  user_id BIGINT UNSIGNED NULL DEFAULT NULL,
  item_count INT UNSIGNED NOT NULL,
  items_json MEDIUMBLOB NOT NULL,
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  expires_at TIMESTAMP(6) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_archive_manifests_key (manifest_key),
  KEY ix_archive_manifests_expiry (expires_at),
  CONSTRAINT fk_archive_manifests_user FOREIGN KEY (user_id)
    REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
