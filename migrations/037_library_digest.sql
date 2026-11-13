-- "Co nowego w bibliotece", once a week, for whoever asked for it.
--
-- The catalogue already knows what arrived and when (`media_items.indexed_at`),
-- and the server can already send mail (activation, address changes). What was
-- missing is the part that belongs to a person rather than to the library: does
-- this account want to hear about it, and what has it already been told.
--
-- Both live here. `frequency` is the answer to the first question and starts at
-- 'off' — a server that begins mailing people because a migration ran is a
-- server nobody trusts twice. The second question is `covered_until`, and it is
-- deliberately not "the time we last sent": a digest reports items indexed up to
-- a point, and if the next run measured from the send time instead, everything
-- indexed *during* that run would be skipped and never mentioned again. The two
-- are one hour apart on a quiet week and hours apart during a big scan.
--
-- `last_sent_at` exists only to be shown ("ostatnio wysłano…") and to stop a
-- second run the same day from repeating itself.
--
-- One row per account, created when somebody first chooses; no row means the
-- default, which is silence.

CREATE TABLE IF NOT EXISTS user_digests (
  user_id BIGINT UNSIGNED NOT NULL,
  frequency VARCHAR(16) NOT NULL DEFAULT 'off',
  last_sent_at TIMESTAMP(6) NULL,
  covered_until TIMESTAMP(6) NULL,
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (user_id),
  KEY ix_user_digests_due (frequency, last_sent_at),
  CONSTRAINT fk_user_digests_user FOREIGN KEY (user_id)
    REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT chk_user_digests_frequency CHECK (frequency IN ('off', 'weekly'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
